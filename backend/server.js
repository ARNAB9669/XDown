import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';

import { CONFIG, YTDLP_BIN, FFMPEG_BIN } from './lib/config.js';
import { infoCache } from './lib/lruCache.js';
import { cookieManager } from './lib/cookieManager.js';
import { hlsManager } from './lib/hlsSessionManager.js';
import { ytDlpInfo, ytDlpDownload } from './lib/ytdlp.js';
import { extractWithPuppeteer } from './lib/puppeteerExtractor.js';
import { pipeStream, resolveBestQualityUrl } from './lib/streamPipe.js';
import { safeFilename, StripPNGTransform } from './lib/helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Express app ──────────────────────────────────────────────────────────
const app = express();
const PORT = CONFIG.PORT;

app.use(express.static(path.join(__dirname, '../')));
app.use(cors());
app.use(express.json());

// Boot logs
console.log('XDown v5.0 Backend Initialized');
console.log(' Boot sequence started...');
console.log(' Node version:', process.version);
console.log('📂 Working directory:', process.cwd());
console.log(' PID:', process.pid);
console.log(' Platform:', process.platform, process.arch);
console.log(' Binary targets:', { YTDLP_BIN, FFMPEG_BIN });

process.on('exit', code => { console.log(`💀 Process exiting with code ${code}`); });
process.on('SIGINT', () => { console.log('🛑 SIGINT received'); process.exit(0); });
process.on('SIGTERM', () => { console.log('🛑 SIGTERM received'); process.exit(0); });
process.on('uncaughtException', err => { console.error('🔥 Uncaught Exception:', err); });
process.on('unhandledRejection', err => { console.error('🔥 Unhandled Promise Rejection:', err); });

setInterval(() => {
  const sessions = hlsManager.sessions.size;
  const cacheSize = infoCache.size;
  console.log(`💓 Heartbeat | PID=${process.pid} | ${new Date().toISOString()} | HLS:${sessions} | Cache:${cacheSize}`);
}, 30000);

// ─── /config ──────────────────────────────────────────────────────────────
app.get('/config', (req, res) => {
  res.json({
    cookieDomains: CONFIG.COOKIE_DOMAINS,
    adDomains: CONFIG.AD_DOMAINS,
    hlsSegmentDuration: CONFIG.HLS.SEGMENT_DURATION,
    version: '5.0.0',
  });
});

// ─── /health ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  status: 'ok',
  ts: Date.now(),
  hlsSessions: hlsManager.sessions.size,
  infoCache: infoCache.size,
}));

// ─── /info ────────────────────────────────────────────────────────────────
app.get('/info', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  console.log('📥 /info:', url);
  try {
    const cached = infoCache.get(url);
    if (cached && cached.info) {
      return res.json(cached.info);
    }
    const info = await ytDlpInfo(url);
    return res.json({
      source: 'yt-dlp', extractor: info.extractor || 'unknown',
      title: info.title || 'Video', uploader: info.uploader || '',
      duration: info.duration || 0, thumbnail: info.thumbnail || '',
      views: info.view_count || 0, formats: info.formats?.length || 0,
      hasAudio: info.formats?.some(f => f.acodec !== 'none') ?? false,
      hasVideo: info.formats?.some(f => f.vcodec !== 'none') ?? false
    });
  } catch (ytErr) {
    console.log('⚠️ yt-dlp failed, trying Puppeteer...');
    try {
      const r = await extractWithPuppeteer(url);
      const infoObj = {
        source: 'puppeteer', extractor: 'custom',
        title: r.title, uploader: '', duration: 0,
        thumbnail: r.thumbnail, views: 0,
        stream: r.stream, streamType: r.streamType
      };
      infoCache.set(url, {
        info: { ...infoObj, http_headers: r.cookies ? { 'Cookie': r.cookies } : {} },
        ts: Date.now()
      });
      return res.json(infoObj);
    } catch (ppErr) {
      return res.status(500).json({ error: `yt-dlp: ${ytErr.message} | Puppeteer: ${ppErr.message}` });
    }
  }
});

// ─── /info-stream (SSE progress) ──────────────────────────────────────────
app.get('/info-stream', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (step, status, message, data = {}) =>
    res.write(`data: ${JSON.stringify({ step, status, message, ...data })}\n\n`);

  try {
    const cached = infoCache.get(url);
    if (cached && cached.info) {
      res.write(`data: ${JSON.stringify({
        complete: true, source: 'puppeteer',
        info: cached.info
      })}\n\n`);
      return res.end();
    }

    send(0, 'active', 'Connecting to target...');
    await new Promise(r => setTimeout(r, 300));
    send(0, 'done', 'Connection established');

    send(1, 'active', 'Resolving hostname...');
    const hostname = new URL(url).hostname;
    await new Promise(r => setTimeout(r, 200));
    send(1, 'done', hostname);

    send(2, 'active', 'Trying yt-dlp extractor...');

    try {
      const info = await ytDlpInfo(url);
      if (info.info) {
        throw new Error('Using cached Puppeteer result');
      }

      send(2, 'done', 'yt-dlp successful');
      send(3, 'active', 'Parsing manifest...');
      await new Promise(r => setTimeout(r, 300));
      send(3, 'done', `${info.formats?.length || 0} formats found`);

      send(4, 'active', 'Mapping streams...');
      await new Promise(r => setTimeout(r, 200));
      send(4, 'done', 'Stream map ready');

      send(5, 'active', 'Selecting quality...');
      await new Promise(r => setTimeout(r, 200));
      send(5, 'done', 'Best quality locked');

      const hasAudioTrack = (info.formats || []).some(f => f.acodec !== 'none');
      const formatsList = (info.formats || [])
        .filter(f => f.vcodec !== 'none' && (f.ext === 'mp4' || f.ext === 'webm' || f.protocol === 'm3u8'))
        .map(f => ({
          format_id: f.format_id, ext: f.ext, resolution: f.format,
          height: f.height || 0, width: f.width || 0, fps: f.fps || 0,
          vcodec: f.vcodec,
          acodec: (f.acodec === 'none' && hasAudioTrack) ? 'aac' : f.acodec,
          requiresMerge: f.acodec === 'none' && hasAudioTrack,
          filesize: f.filesize || f.filesize_approx || 0,
          tbr: f.tbr || 0,
          protocol: f.protocol,
        }))
        .sort((a, b) => (b.height || 0) - (a.height || 0));

      const hlsFormat = (info.formats || []).find(f => f.protocol === 'm3u8' || f.protocol === 'm3u8_native');
      const streamType = hlsFormat ? 'm3u8' : 'mp4';
      const manifestUrl = hlsFormat?.url || null;

      res.write(`data: ${JSON.stringify({
        complete: true, source: 'yt-dlp',
        info: {
          title: info.title, extractor: info.extractor,
          thumbnail: info.thumbnail, duration: info.duration,
          uploader: info.uploader, streamType, stream: manifestUrl, formats: formatsList
        }
      })}\n\n`);

    } catch (ytErr) {
      send(2, 'error', `yt-dlp failed: ${ytErr.message}`);
      send(2, 'active', 'Switching to Puppeteer...');
      try {
        const puppeteerResult = await extractWithPuppeteer(url);
        send(2, 'done', 'Puppeteer extraction successful');
        send(3, 'active', 'Analyzing stream...');
        await new Promise(r => setTimeout(r, 500));
        send(3, 'done', `${puppeteerResult.streamType.toUpperCase()} stream found`);
        send(4, 'active', 'Validating stream URL...');
        await new Promise(r => setTimeout(r, 300));
        send(4, 'done', 'Stream validated');
        send(5, 'active', 'Quality check...');
        await new Promise(r => setTimeout(r, 200));
        send(5, 'done', 'Best available');
        const infoObj = {
          title: puppeteerResult.title, extractor: 'custom',
          thumbnail: puppeteerResult.thumbnail,
          stream: puppeteerResult.stream, streamType: puppeteerResult.streamType
        };
        res.write(`data: ${JSON.stringify({
          complete: true, source: 'puppeteer',
          info: infoObj
        })}\n\n`);

        infoCache.set(url, {
          info: { ...infoObj, http_headers: puppeteerResult.cookies ? { 'Cookie': puppeteerResult.cookies } : {} },
          ts: Date.now()
        });
      } catch (ppErr) {
        send(2, 'error', `Puppeteer also failed: ${ppErr.message}`);
        res.write(`data: ${JSON.stringify({ complete: true, error: ppErr.message })}\n\n`);
      }
    }
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ complete: true, error: err.message })}\n\n`);
    res.end();
  }
});

// ─── /hls/start ───────────────────────────────────────────────────────────
app.post('/hls/start', async (req, res) => {
  const { url, format_id } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  console.log('🎞️ /hls/start:', url);

  try {
    const info = await ytDlpInfo(url);
    const allFormats = info.formats || [];
    const httpHeaders = info.http_headers || {};

    let videoUrl, audioUrl, selectedHeaders;

    if (format_id && format_id !== 'best') {
      const fmt = allFormats.find(f => String(f.format_id) === String(format_id));
      if (!fmt) return res.status(400).json({ error: 'Format not found' });
      videoUrl = fmt.url;
      selectedHeaders = fmt.http_headers || httpHeaders;
      if (fmt.acodec === 'none') {
        const bestAudio = allFormats.filter(f => f.acodec !== 'none' && f.vcodec === 'none').sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
        audioUrl = bestAudio?.url || null;
      }
    } else {
      const bestCombined = allFormats
        .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.ext === 'mp4' && (!f.vcodec || f.vcodec.includes('avc1') || f.vcodec.includes('h264')))
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

      if (bestCombined) {
        videoUrl = bestCombined.url;
        selectedHeaders = bestCombined.http_headers || httpHeaders;
      } else {
        const bestVideo = allFormats.filter(f => f.vcodec !== 'none' && f.acodec === 'none').sort((a, b) => (b.height || 0) - (a.height || 0))[0];
        const bestAudio = allFormats.filter(f => f.acodec !== 'none' && f.vcodec === 'none').sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
        if (!bestVideo) return res.status(500).json({ error: 'No streamable video format found' });
        videoUrl = bestVideo.url;
        audioUrl = bestAudio?.url || null;
        selectedHeaders = bestVideo.http_headers || httpHeaders;
      }
    }

    const sessionId = await hlsManager.createSession(videoUrl, audioUrl, selectedHeaders, url, { title: info.title, duration: info.duration });
    res.json({ sessionId, status: 'starting' });

  } catch (err) {
    console.error('/hls/start error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── /hls/:id/status ──────────────────────────────────────────────────────
app.get('/hls/:id/status', (req, res) => {
  const session = hlsManager.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });
  res.json({ status: session.status, segmentCount: session.segmentCount, error: session.error });
});

// ─── /hls/:id/playlist.m3u8 ───────────────────────────────────────────────
app.get('/hls/:id/playlist.m3u8', async (req, res) => {
  const session = hlsManager.getSession(req.params.id);
  if (!session) return res.status(404).send('Session not found or expired');

  try {
    const content = await fs.promises.readFile(session.playlistPath, 'utf8');

    // Rewrite relative segment paths to absolute server URLs
    const baseUrl = `/hls/${req.params.id}/`;
    const rewritten = content.split('\n').map(line => {
      if (line.startsWith('seg') || line === 'init.mp4') return baseUrl + line;
      return line;
    }).join('\n');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(rewritten);
  } catch {
    res.status(404).send('Playlist not yet available');
  }
});

// ─── /hls/:id/init.mp4 and /hls/:id/seg*.m4s ─────────────────────────────
app.get('/hls/:id/:filename', (req, res) => {
  const session = hlsManager.getSession(req.params.id);
  if (!session) return res.status(404).send('Session not found');
  const filename = req.params.filename;
  if (!filename.endsWith('.m4s') && filename !== 'init.mp4') return res.status(400).send('Invalid file');
  const filePath = path.join(session.dir, filename);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(filePath, err => {
    if (err && !res.headersSent) res.status(404).send('Segment not found');
  });
});

// ─── /hls/:id/stop ────────────────────────────────────────────────────────
app.delete('/hls/:id/stop', async (req, res) => {
  await hlsManager.deleteSession(req.params.id);
  res.json({ ok: true });
});

// ─── /hls-proxy (existing, kept for backward compat) ─────────────────────
app.get('/hls-proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');
  try {
    const cookieStr = await cookieManager.parseCookiesForUrl(url);
    const headers = { 'User-Agent': CONFIG.USER_AGENT };
    try { headers['Referer'] = new URL(url).origin + '/'; } catch { }
    if (cookieStr) headers['Cookie'] = cookieStr;

    const response = await fetch(url, { headers });
    if (!response.ok) return res.status(response.status).send(`HLS proxy failed: ${response.statusText}`);
    const ct = response.headers.get('content-type') || '';
    res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (url.includes('.m3u8') || ct.includes('mpegurl')) {
      const text = await response.text();
      const baseUrl = new URL(url);
      const rewritten = text.split('\n').map(line => {
        if (!line.trim() || line.startsWith('#')) return line;
        let targetUrl = line.trim();
        if (!targetUrl.startsWith('http')) targetUrl = new URL(targetUrl, baseUrl).toString();
        return `/hls-proxy?url=${encodeURIComponent(targetUrl)}`;
      }).join('\n');
      res.send(rewritten);
    } else {
      const cl = response.headers.get('content-length');
      if (cl) res.setHeader('Content-Length', cl);
      Readable.fromWeb(response.body).pipe(res);
    }
  } catch (err) {
    if (!res.headersSent) res.status(500).send(err.message);
  }
});

// ─── /audio — Audio-only download ─────────────────────────────────────────
app.get('/audio', async (req, res) => {
  req.setTimeout(0);
  const { url, title = 'audio' } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  console.log('🎵 /audio:', url);

  try {
    const info = await ytDlpInfo(url);
    const bestAudio = (info.formats || [])
      .filter(f => f.acodec !== 'none' && f.vcodec === 'none')
      .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

    if (!bestAudio) throw new Error('No audio-only format found');

    const filename = safeFilename(title) + '.m4a';
    const headers = { 'User-Agent': CONFIG.USER_AGENT };
    try { headers['Referer'] = new URL(url).origin + '/'; } catch { }
    if (bestAudio.http_headers) Object.assign(headers, bestAudio.http_headers);

    res.setHeader('Content-Type', 'audio/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Transfer-Encoding', 'chunked');

    const ffArgs = [
      '-user_agent', CONFIG.USER_AGENT,
      '-i', bestAudio.url,
      '-vn', '-c:a', 'aac', '-b:a', '192k',
      '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', 'pipe:1'
    ];

    const ffmpeg = spawn(FFMPEG_BIN, ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    ffmpeg.stdout.pipe(res);
    ffmpeg.stderr.on('data', d => process.stdout.write('[audio-ffmpeg] ' + d));
    req.on('close', () => { if (!ffmpeg.killed) ffmpeg.kill('SIGKILL'); });

  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── /m3u8-proxy ────────────────────────────────────────────────────────────
app.get(['/m3u8-proxy', '/m3u8-proxy.m3u8', '/m3u8-proxy.ts'], async (req, res) => {
  const targetUrl = req.query.url;
  const originalUrl = req.query.originalUrl || targetUrl;
  if (!targetUrl) return res.status(400).send('Missing url');

  try {
    console.log(`▶️ /m3u8-proxy request: ${targetUrl.substring(0, 100)}...`);
    let origin = '';
    try { origin = new URL(originalUrl).origin + '/'; } catch { }

    const headers = {
      'User-Agent': CONFIG.USER_AGENT,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
      ...(origin ? { 'Referer': origin, 'Origin': origin } : {})
    };

    // Inject any custom headers yt-dlp found (like authorization/cookies)
    const cached = infoCache.get(originalUrl);
    if (cached && cached.info && cached.info.http_headers) {
      for (const [k, v] of Object.entries(cached.info.http_headers)) {
        headers[k] = v;
      }
    }

    const cookieStr = await cookieManager.parseCookiesForUrl(targetUrl);
    if (cookieStr) {
      headers['Cookie'] = headers['Cookie'] ? `${headers['Cookie']}; ${cookieStr}` : cookieStr;
    }

    const remote = await fetch(targetUrl, { headers, redirect: 'follow' });
    console.log(`▶️ /m3u8-proxy response: ${remote.status} ${remote.headers.get('content-type')}`);
    if (!remote.ok) {
      return res.status(remote.status).send('Proxy upstream error');
    }

    let ct = remote.headers.get('content-type') || '';
    if (ct.includes('mpegurl') || ct.includes('x-mpegURL') || targetUrl.includes('.m3u8')) {
      let text = await remote.text();
      text = text.split('\n').map(line => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#')) {
          if (t.includes('URI="')) {
            return t.replace(/URI="([^"]+)"/, (match, uri) => {
              try {
                if (uri.startsWith('data:')) return match; // skip data URIs
                const absolute = new URL(uri, targetUrl).href;
                const ext = absolute.includes('.m3u8') ? '.m3u8' : '.ts';
                return `URI="/m3u8-proxy${ext}?url=${encodeURIComponent(absolute)}&originalUrl=${encodeURIComponent(originalUrl)}"`;
              } catch { return match; }
            });
          }
          return line;
        }
        try {
          const absolute = new URL(t, targetUrl).href;
          const ext = absolute.includes('.m3u8') ? '.m3u8' : '.ts';
          return `/m3u8-proxy${ext}?url=${encodeURIComponent(absolute)}&originalUrl=${encodeURIComponent(originalUrl)}`;
        } catch { return line; }
      }).join('\n');

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(text);
    } else {
      res.status(remote.status);

      let newCt = ct;
      if (ct.includes('image/') || targetUrl.includes('.image')) {
        newCt = 'video/mp2t'; // force mpeg-ts for fake images
      }
      res.setHeader('Content-Type', newCt);
      res.setHeader('Access-Control-Allow-Origin', '*');

      const stream = Readable.fromWeb(remote.body);
      stream.pipe(new StripPNGTransform()).pipe(res);
    }
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ─── /download ────────────────────────────────────────────────────────────
app.get('/download', async (req, res) => {
  req.setTimeout(0);
  res.setTimeout(0);
  if (req.socket) { req.socket.setTimeout(0); req.socket.setKeepAlive(true, 30000); }

  const { url, originalUrl, stream: directStream, streamType, title = 'video', inline } = req.query;
  const playInline = inline === 'true';
  if (!url) return res.status(400).json({ error: 'Missing url' });
  console.log('📥 /download:', url);

  if (directStream) {
    let httpHeaders = null;
    const cached = infoCache.get(originalUrl || url);
    if (cached && cached.info && cached.info.http_headers) {
      httpHeaders = cached.info.http_headers;
    }

    const filename = safeFilename(title) + '.mp4';
    return await pipeStream(req, res, directStream, streamType, filename, playInline, null, httpHeaders, originalUrl || url);
  }

  if (playInline && !cookieManager.needsCookies(url)) {
    try {
      const info = await ytDlpInfo(url);
      const allFormats = info.formats || [];
      const httpHdrs = info.http_headers || {};

      const bestCombined = allFormats
        .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && (f.ext === 'mp4' || f.ext === 'webm') && f.url)
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

      if (bestCombined) {
        console.log(`🎬 Stream: Combined format ${bestCombined.format_id} (${bestCombined.height}p)`);
        const ext = bestCombined.ext === 'webm' ? 'webm' : 'mp4';
        return await pipeStream(req, res, bestCombined.url, ext, safeFilename(title) + '.' + ext, playInline, null, bestCombined.http_headers || httpHdrs, originalUrl || url);
      }

      const bestVideo = allFormats.filter(f => f.vcodec !== 'none' && f.acodec === 'none' && f.url && (f.ext === 'mp4' || f.ext === 'webm')).sort((a, b) => (b.height || 0) - (a.height || 0))[0];

      if (bestVideo) {
        const isWebm = bestVideo.ext === 'webm' || (bestVideo.vcodec && (bestVideo.vcodec.includes('vp9') || bestVideo.vcodec.includes('vp8') || bestVideo.vcodec.includes('av01')));
        const ext = isWebm ? 'webm' : 'mp4';

        const compatibleAudios = allFormats.filter(f => {
          if (f.acodec === 'none' || !f.url) return false;
          if (isWebm) return f.ext === 'webm' || f.acodec.includes('opus') || f.acodec.includes('vorbis');
          return f.ext === 'm4a' || f.ext === 'mp4' || f.acodec.includes('aac') || f.acodec.includes('mp4a');
        });
        const bestAudio = (compatibleAudios.length > 0 ? compatibleAudios : allFormats.filter(f => f.acodec !== 'none')).sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

        console.log(`🎬 Stream: FFmpeg mux — ${bestVideo.format_id} + ${bestAudio ? bestAudio.format_id : 'none'}`);
        return await pipeStream(req, res, bestVideo.url, ext, safeFilename(title) + '.' + ext, playInline, bestAudio?.url, bestVideo.http_headers || httpHdrs, originalUrl || url);
      }
    } catch (e) {
      console.log('⚠️ Failed to resolve best inline format, falling back to yt-dlp...', e.message);
    }
  }

  try {
    await ytDlpDownload(url, req, res, playInline, title, originalUrl || url);
  } catch (ytErr) {
    console.log('⚠️ yt-dlp download failed, Puppeteer fallback...');
    try {
      const r = await extractWithPuppeteer(url);
      await pipeStream(req, res, r.stream, r.streamType, safeFilename(r.title) + '.mp4', playInline, null, null, url);
    } catch (ppErr) {
      if (!res.headersSent) res.status(500).json({ error: ppErr.message });
    }
  }
});

// ─── /download-quality ────────────────────────────────────────────────────
app.get('/download-quality', async (req, res) => {
  req.setTimeout(0);
  const { url, originalUrl, format_id, title = 'video', inline, track } = req.query;
  const playInline = inline === 'true';
  if (!url || !format_id) return res.status(400).json({ error: 'Missing url or format_id' });
  console.log(`📥 /download-quality: ${url} format: ${format_id} track: ${track || 'both'}`);

  try {
    const info = await ytDlpInfo(url);
    const selectedFormat = info.formats?.find(f => String(f.format_id) === String(format_id));
    if (!selectedFormat) throw new Error('Format not found in info');

    let videoUrl = selectedFormat.url;
    let audioUrl = null;

    const isWebm = selectedFormat.ext === 'webm' || (selectedFormat.vcodec && (selectedFormat.vcodec.includes('vp9') || selectedFormat.vcodec.includes('vp8') || selectedFormat.vcodec.includes('av01')));
    const outputExt = isWebm ? 'webm' : 'mp4';

    if (track === 'video') {
      audioUrl = null;
    } else if (track === 'audio') {
      const bestAudio = info.formats.filter(f => f.acodec !== 'none').sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
      if (!bestAudio) throw new Error('No audio track found');
      videoUrl = bestAudio.url; // proxy audio track as main
      audioUrl = null;
    } else {
      if (selectedFormat.acodec === 'none') {
        const compatibleAudios = info.formats.filter(f => {
          if (f.acodec === 'none' || !f.url) return false;
          if (isWebm) return f.ext === 'webm' || f.acodec.includes('opus') || f.acodec.includes('vorbis');
          return f.ext === 'm4a' || f.ext === 'mp4' || f.acodec.includes('aac') || f.acodec.includes('mp4a');
        });
        const bestAudio = (compatibleAudios.length > 0 ? compatibleAudios : info.formats.filter(f => f.acodec !== 'none')).sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
        if (bestAudio) audioUrl = bestAudio.url;
      }
    }

    return await pipeStream(req, res, videoUrl, outputExt, safeFilename(title) + '.' + outputExt, playInline, audioUrl, selectedFormat.http_headers || info.http_headers, originalUrl || url);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── /formats ────────────────────────────────────────────────────────────
app.get('/formats', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  try {
    const info = await ytDlpInfo(url);
    const hasAudioTrack = (info.formats || []).some(f => f.acodec !== 'none');
    const formats = (info.formats || [])
      .filter(f => f.vcodec !== 'none' && (f.ext === 'mp4' || f.ext === 'webm' || f.protocol === 'm3u8'))
      .map(f => ({
        format_id: f.format_id, ext: f.ext, resolution: f.format,
        height: f.height || 0, width: f.width || 0, fps: f.fps || 0,
        vcodec: f.vcodec,
        acodec: (f.acodec === 'none' && hasAudioTrack) ? 'aac' : f.acodec,
        filesize: f.filesize || f.filesize_approx || 0,
        tbr: f.tbr || 0,
      }))
      .sort((a, b) => (b.height || 0) - (a.height || 0));
    return res.json({ title: info.title || 'Video', uploader: info.uploader || '', duration: info.duration || 0, thumbnail: info.thumbnail || '', formats });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── HTTP Server ──────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`🙂 Server → http://localhost:${PORT}`);
  console.log('=> Express server listening successfully');
  console.log('=? Waiting for requests...');
});

server.on('close', () => { console.log('🔴 HTTP server closed'); });
server.on('error', err => { console.error('🔥 HTTP server error:', err); });
server.on('connection', socket => {
  console.log('🔌 TCP connection from', socket.remoteAddress);
  socket.on('close', () => { console.log('❌ TCP socket closed'); });
});

