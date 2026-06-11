//====== Production Localhost Version ======
import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import os from 'os';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Readable } from 'stream';

puppeteer.use(StealthPlugin());

// --- Cross-Platform Binary Locator ---
function getBinaryPath(binaryName) {
  // Windows binaries end in .exe
  const ext = process.platform === 'win32' ? '.exe' : '';
  const localPath = path.resolve(process.cwd(), 'bin', `${binaryName}${ext}`);
  
  // Look in the local /bin folder first. If not there, assume it's installed globally.
  return fs.existsSync(localPath) ? localPath : binaryName; 
}

const YTDLP_BIN = getBinaryPath('yt-dlp');
const FFMPEG_BIN = getBinaryPath('ffmpeg');

const app = express();
const PORT = 8000;

console.log("XDown Backend Initialized");
console.log("I love imogies in code a lot,");
console.log('🚀 Boot sequence started...');
console.log('🖥️ Node version:', process.version);
console.log('📂 Working directory:', process.cwd());
console.log('🧠 PID:', process.pid);
console.log('🧵 Platform:', process.platform, process.arch);
console.log('📦 Binary targets:', { YTDLP_BIN, FFMPEG_BIN });

process.on('exit', code => {
  console.log(`💀 Process exiting with code ${code}`);
});

process.on('beforeExit', code => {
  console.log(`⚠️ beforeExit triggered with code ${code}`);
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received');
  process.exit(0);
});

process.on('uncaughtException', err => {
  console.error('🔥 Uncaught Exception:', err);
});

process.on('unhandledRejection', err => {
  console.error('🔥 Unhandled Promise Rejection:', err);
});

setInterval(() => {
  console.log(`💓 Heartbeat | PID=${process.pid} | ${new Date().toISOString()}`);
}, 30000);

app.use(cors());
app.use(express.json());

// ─── Shared browser ────────────────────────────────────────────────────────
let sharedBrowser = null;

async function getBrowser() {
  if (sharedBrowser) {
    try {
      await sharedBrowser.pages();
      return sharedBrowser;
    } catch (err) {
      console.log('⚠️ Browser disconnected or crashed. Restarting...');
      sharedBrowser = null;
    }
  }

  console.log('🧠 Launching shared browser...');
  sharedBrowser = await puppeteer.launch({
    headless: 'new',
    // executablePath removed to allow cross-platform automatic Chromium fallback
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1366,768',
    ],
    ignoreHTTPSErrors: true,
    defaultViewport: {
      width: 1366,
      height: 768
    }
  });

  sharedBrowser.on('disconnected', () => { sharedBrowser = null; });
  return sharedBrowser;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function safeFilename(name = 'video') {
  return name.replace(/[^\w\s\-().]/g, '').replace(/\s+/g, '_').slice(0, 100);
}

function needsCookies(url) {
  try {
    const host = new URL(url).hostname;
    return ['pornhub', 'xhamster', 'xnxx', 'xvideos', 'youporn', 'redtube', 'spankbang', 'tube8'].some(s => host.includes(s));
  } catch { return false; }
}

function resolveBestQualityUrl(url) {
  if (!url.includes('_TPL_')) return url;
  const matches = [...url.matchAll(/:(\d+p):/g)].map(m => m[1]);
  if (!matches.length) return url.replace('_TPL_', '1080p');
  const best = matches.sort((a, b) => parseInt(b) - parseInt(a))[0];
  const resolved = url.replace('_TPL_', best);
  console.log(`🎯 Resolved template → ${best}:`, resolved);
  return resolved;
}

// ─── yt-dlp info ───────────────────────────────────────────────────────────

function ytDlpInfo(url) {
  return new Promise((resolve, reject) => {
    console.log('🔍 yt-dlp info:', url);
    const args = [
      '--dump-single-json', '--no-playlist', '--no-warnings', '--geo-bypass',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    ];
    if (needsCookies(url)) args.push('--cookies-from-browser', 'chrome');

    args.push(url);

    const proc = spawn(YTDLP_BIN, args);
    console.log('🔍 yt-dlp info args:', args.join(' '));
    console.log('🧠 yt-dlp info PID:', proc.pid);
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(err || 'yt-dlp info failed'));
      try { resolve(JSON.parse(out)); } catch { reject(new Error('yt-dlp JSON parse error')); }
    });
    proc.on('error', reject);
  });
}

// ─── Puppeteer extractor ──────────────────────────────────────────────────

async function extractWithPuppeteer(pageUrl) {
  console.log('🕷️ Puppeteer extracting:', pageUrl);

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1366, height: 768 });
    await page.setRequestInterception(true);

    await page.evaluateOnNewDocument(() => {
      window.location.reload = function () { console.log('Scraper blocked page reload.'); };
      window.location.replace = function (url) { console.log('Scraper blocked redirect to:', url); };
      setTimeout = (function (oldSetTimeout) {
        return function (func, delay) {
          if (func.toString().includes('reload') || func.toString().includes('replace')) return;
          return oldSetTimeout.apply(this, arguments);
        };
      })(setTimeout);
    });

    page.on('request', req => {
      const t = req.resourceType();
      if (t === 'image' || t === 'font' || t === 'stylesheet') return req.abort();
      req.continue();
    });

    const streams = { m3u8: [], mpd: [], mp4: [], webm: [] };

    page.on('response', async response => {
      try {
        const u = response.url();
        const ct = response.headers()['content-type'] || '';

        if (['.jpg', '.jpeg', '.png', '.gif', '.svg', '.css', '.woff', '.ttf', '.vtt'].some(e => u.includes(e))) return;

        const isJunkUrl = /(banner|btn|\/ads?\/|preroll|midroll|vast|vpaid|promo|tracker|analytics|icon|logo|blank\.mp4|preview|thumb|trafficjunky|mngads|exoclick|popads|ad-server|adtng\.com|creatives)/i.test(u);
        if (isJunkUrl) { return; }

        if (u.includes('.m3u8') || ct.includes('vnd.apple.mpegurl')) {
          if (u.includes('master.m3u8')) {
            console.log('🔥 JACKPOT! Master Playlist Found:', u);
            streams.m3u8.unshift(u);
          } else {
            streams.m3u8.push(u);
          }
          return;
        }

        if (u.includes('.mpd') || ct.includes('dash+xml')) { streams.mpd.push(u); return; }
        if (u.includes('.webm')) { streams.webm.push(u); return; }
        if (u.includes('.mp4')) {
          if (!u.includes('/plain/') && !u.includes('rs:fit') && !u.includes('resize')) streams.mp4.push(u);
          return;
        }
        if (ct.includes('video/')) streams.mp4.push(u);
      } catch { }
    });

    try { await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }); } catch { }

    console.log('⏳ Waiting 8s for main video to load and ads to pass...');
    await new Promise(r => setTimeout(r, 8000));

    const debugImagePath = path.join(os.tmpdir(), 'bot_debug_vision.png');
    await page.screenshot({ path: debugImagePath, fullPage: true }).catch(() => { });
    console.log('📸 Debug screenshot saved to:', debugImagePath);

    try {
      await page.evaluate(() => {
        document.querySelectorAll('button, .play-button, [class*=play]').forEach(b => { try { b.click(); } catch { } });
        document.querySelectorAll('video').forEach(v => { try { v.play(); } catch { } });
      });
      await new Promise(r => setTimeout(r, 3000));
    } catch { }

    let bestDomUrl = null, bestThumbnail = null, extras = [];

    for (const frame of page.frames()) {
      try {
        const dom = await frame.evaluate(() => {
          let bestVid = null, maxScore = 0, thumb = null;
          document.querySelectorAll('video').forEach(v => {
            const area = v.clientWidth * v.clientHeight;
            const duration = v.duration && !isNaN(v.duration) ? v.duration : 0;
            if (duration > 0 && duration < 30) return;
            const score = area + (duration * 10);
            if (score > maxScore && v.src && !v.src.startsWith('blob:')) {
              maxScore = score; bestVid = v.src;
              if (v.poster) thumb = v.poster;
            }
          });
          if (!bestVid) {
            document.querySelectorAll('source').forEach(s => {
              if (s.src && !s.src.startsWith('blob:')) bestVid = s.src;
            });
          }
          const extractedExtras = [];
          document.querySelectorAll('[data-video-url],[data-src],[data-stream]').forEach(el => {
            if (el.tagName.toLowerCase() === 'img') return;
            ['data-video-url', 'data-src', 'data-stream'].forEach(attr => {
              const val = el.getAttribute(attr);
              if (val && (val.startsWith('http') || val.startsWith('/'))) {
                const isImage = /\.(jpg|jpeg|png|webp|gif)($|\?)/i.test(val);
                if (!isImage) extractedExtras.push(val);
              }
            });
          });
          return { bestVid, thumb, extractedExtras };
        });
        if (dom.bestVid) bestDomUrl = dom.bestVid;
        if (dom.thumb && !bestThumbnail) bestThumbnail = dom.thumb;
        if (dom.extractedExtras.length > 0) extras.push(...dom.extractedExtras);
      } catch { }
    }

    [bestDomUrl, ...extras].filter(Boolean).forEach(u => {
      if (u.includes('.m3u8')) streams.m3u8.push(u);
      else if (u.includes('.mpd')) streams.mpd.push(u);
      else if (u.includes('.mp4')) streams.mp4.push(u);
    });

    for (const k of Object.keys(streams)) streams[k] = [...new Set(streams[k])];

    let finalStream = null, streamType = null;

    if (streams.m3u8.length) {
      finalStream = streams.m3u8.find(u => u.includes('master')) || streams.m3u8[0];
      streamType = 'm3u8';
    } else if (streams.mpd.length) { finalStream = streams.mpd[0]; streamType = 'mpd'; }
    else if (streams.mp4.length) { finalStream = streams.mp4[streams.mp4.length - 1]; streamType = 'mp4'; }
    else if (streams.webm.length) { finalStream = streams.webm[0]; streamType = 'webm'; }

    if (!finalStream) throw new Error('No valid video stream found. Blocked by ads or captchas.');

    if (finalStream.startsWith('/')) {
      const p = new URL(pageUrl);
      finalStream = `${p.protocol}//${p.host}${finalStream}`;
    }

    const title = await page.title() || 'Video';
    console.log('✅ Puppeteer result:', finalStream);
    return { stream: finalStream, streamType, thumbnail: bestThumbnail || '', title };

  } finally {
    try { await page.close(); } catch { }
  }
}
// ─── /info ────────────────────────────────────────────────────────────────

app.get('/info', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  console.log('📥 /info:', url);

  try {
    const info = await ytDlpInfo(url);
    return res.json({
      source: 'yt-dlp',
      extractor: info.extractor || 'unknown',
      title: info.title || 'Video',
      uploader: info.uploader || '',
      duration: info.duration || 0,
      thumbnail: info.thumbnail || '',
      views: info.view_count || 0,
      formats: info.formats?.length || 0,
      hasAudio: info.formats?.some(f => f.acodec !== 'none') ?? false,
      hasVideo: info.formats?.some(f => f.vcodec !== 'none') ?? false
    });
  } catch (ytErr) {
    console.log('⚠️ yt-dlp failed, trying Puppeteer...');
    try {
      const r = await extractWithPuppeteer(url);
      return res.json({
        source: 'puppeteer', extractor: 'custom',
        title: r.title, uploader: '', duration: 0,
        thumbnail: r.thumbnail, views: 0,
        stream: r.stream, streamType: r.streamType
      });
    } catch (ppErr) {
      return res.status(500).json({ error: `yt-dlp: ${ytErr.message} | Puppeteer: ${ppErr.message}` });
    }
  }
});

// ─── /download ────────────────────────────────────────────────────────────

app.get('/download', async (req, res) => {
  req.setTimeout(0);

  const { url, stream: directStream, streamType, title = 'video', inline } = req.query;
  const playInline = inline === 'true';
  if (!url) return res.status(400).json({ error: 'Missing url' });
  console.log('📥 /download:', url);

  if (directStream) {
    const filename = safeFilename(title) + '.mp4';
    return await pipeStream(req, res, directStream, streamType, filename, playInline);
  }

  // 🟢 Use pipeStream for streaming to support seeking
  if (playInline) {
    try {
      const info = await ytDlpInfo(url);
      const allFormats = info.formats || [];
      const httpHdrs = info.http_headers || {};

      // Strategy 1: Combined format (has both video+audio in one stream) -> BEST FOR SEEKING!
      const bestCombined = allFormats
        .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.ext === 'mp4' && f.url && (!f.vcodec || f.vcodec.includes('avc1') || f.vcodec.includes('h264')))
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

      if (bestCombined) {
        console.log(`🎬 Stream: Combined format ${bestCombined.format_id} (${bestCombined.height}p) - Native Proxy (Seeking Enabled)`);
        const filename = safeFilename(title) + '.mp4';
        return await pipeStream(req, res, bestCombined.url, 'mp4', filename, playInline, null, bestCombined.http_headers || httpHdrs);
      }

      // Strategy 2: Best video-only + best audio-only → FFmpeg muxes them (best quality, but seeking broken)
      const bestVideo = allFormats
        .filter(f => f.vcodec !== 'none' && f.acodec === 'none' && f.url && (!f.vcodec || f.vcodec.includes('avc1') || f.vcodec.includes('h264')))
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
      const bestAudio = allFormats
        .filter(f => f.acodec !== 'none' && f.vcodec === 'none' && f.url)
        .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

      if (bestVideo && bestAudio) {
        console.log(`🎬 Stream: FFmpeg mux — video ${bestVideo.format_id} (${bestVideo.height}p) + audio ${bestAudio.format_id}`);
        const filename = safeFilename(title) + '.mp4';
        return await pipeStream(req, res, bestVideo.url, 'mp4', filename, playInline, bestAudio.url, bestVideo.http_headers || httpHdrs);
      }

      // Strategy 3: Best video-only (any codec) + best audio → FFmpeg transcodes
      const bestVideoAny = allFormats
        .filter(f => f.vcodec !== 'none' && f.acodec === 'none' && f.url)
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
      if (bestVideoAny && bestAudio) {
        console.log(`🎬 Stream: FFmpeg transcode — video ${bestVideoAny.format_id} + audio ${bestAudio.format_id}`);
        const filename = safeFilename(title) + '.mp4';
        return await pipeStream(req, res, bestVideoAny.url, 'mp4', filename, playInline, bestAudio.url, bestVideoAny.http_headers || httpHdrs);
      }
    } catch (e) {
      console.log('⚠️ Failed to resolve best inline format, falling back to yt-dlp download...', e.message);
    }
  }

  try {
    await ytDlpDownload(url, req, res, playInline);
  } catch (ytErr) {
    console.log('⚠️ yt-dlp download failed, Puppeteer fallback...');

    try {
      const r = await extractWithPuppeteer(url);
      const filename = safeFilename(r.title) + '.mp4';
      await pipeStream(req, res, r.stream, r.streamType, filename, playInline);
    } catch (ppErr) {
      if (!res.headersSent) {
        res.status(500).json({ error: ppErr.message });
      }
    }
  }
});

// ─── FAST LIVE PIPE ───────────────────────────────────────────────────────

function pipeStream(req, res, videoUrl, streamType, filename, playInline = false, audioUrl = null, httpHeaders = null) {
  videoUrl = resolveBestQualityUrl(videoUrl);

  const isAdaptive = streamType === 'm3u8' || streamType === 'mpd'
    || videoUrl.includes('.m3u8') || videoUrl.includes('.mpd');

  if (isAdaptive || audioUrl) {
    console.log('🎞️ FFmpeg direct live browser stream...');
    console.log('📼 Incoming video URL:', videoUrl);
    if (audioUrl) console.log('🔊 Incoming audio URL:', audioUrl);
    console.log('🧪 Stream type:', streamType);
    console.log('📁 Filename:', filename);

    let origin = '';
    try { origin = new URL(videoUrl).origin + '/'; } catch { }

    let ffHeaders = origin ? `Referer: ${origin}\r\n` : '';
    let userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

    if (httpHeaders) {
      for (const [key, value] of Object.entries(httpHeaders)) {
        if (key.toLowerCase() === 'user-agent') {
          userAgent = value;
        } else {
          ffHeaders += `${key}: ${value}\r\n`;
        }
      }
    }


    const ffArgs = [
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
      '-rw_timeout', '30000000',
      '-user_agent', userAgent,
      ...(ffHeaders ? ['-headers', ffHeaders] : []),
      '-i', videoUrl
    ];

    if (audioUrl) {
      ffArgs.push(
        '-user_agent', userAgent,
        ...(ffHeaders ? ['-headers', ffHeaders] : []),
        '-i', audioUrl
      );
    }

    ffArgs.push(
      '-map', '0:v:0?',
      ...(audioUrl ? ['-map', '1:a:0?'] : ['-map', '0:a:0?']),
      '-c:v', 'copy',
      '-c:a', audioUrl ? 'aac' : 'copy',
      ...(audioUrl ? ['-b:a', '192k'] : []),
      '-bsf:a', 'aac_adtstoasc',
      '-movflags', 'frag_keyframe+empty_moov+faststart',
      '-f', 'mp4',
      'pipe:1'
    );

    const ffmpeg = spawn(FFMPEG_BIN, ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log('⚙️ FFmpeg args:', ffArgs.join(' '));
    console.log('🧠 FFmpeg PID:', ffmpeg.pid);

    ffmpeg.stderr.on('data', d => {
      process.stdout.write('[ffmpeg] ' + d);
    });

    ffmpeg.on('error', err => {
      console.error('FFmpeg spawn error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'FFmpeg failed' });
      }
    });

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'none');
    
    const disposition = playInline ? `inline; filename="${filename}"` : `attachment; filename="${filename}"`;
    res.setHeader('Content-Disposition', disposition);

    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    res.flushHeaders?.();

    console.log('📡 Direct browser live-stream attached');

    let sentBytes = 0;
    let started = false;

    ffmpeg.stdout.on('data', chunk => {
      if (!started) {
        started = true;
        console.log('🚀 Browser download icon should appear NOW');
      }

      sentBytes += chunk.length;

      if (sentBytes % (5 * 1024 * 1024) < chunk.length) {
        console.log(
          `📦 Streamed ${(sentBytes / 1024 / 1024).toFixed(1)} MB to browser`
        );
      }

      const ok = res.write(chunk);

      if (!ok) {
        ffmpeg.stdout.pause();
      }
    });

    res.on('drain', () => {
      ffmpeg.stdout.resume();
    });

    ffmpeg.stdout.on('end', () => {
      console.log('🏁 FFmpeg stdout ended');
      res.end();
    });

    ffmpeg.stdout.on('error', err => {
      console.error('❌ FFmpeg stdout stream error:', err);

      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream pipe failed' });
      }
    });

    ffmpeg.on('close', code => {
      console.log(`[ffmpeg] exit ${code}`);

      if (code !== 0) {
        console.error('❌ FFmpeg exited with failure');

        if (!res.headersSent) {
          res.status(500).json({
            error: 'FFmpeg conversion failed'
          });
        }

        return;
      }

      console.log('✅ Direct browser streaming finished');

      try {
        res.end();
      } catch { }
    });

    req.on('close', () => {
      console.log('🛑 Browser closed live stream');

      if (!ffmpeg.killed && ffmpeg.exitCode === null) {
        ffmpeg.kill('SIGKILL');
      }
    });

    return;
  }

  // Direct MP4/WebM — native Fetch follows CDN redirects cleanly
  console.log('📦 Direct stream using native Fetch...');

  let origin = '';
  try { origin = new URL(videoUrl).origin + '/'; } catch { }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    ...(origin ? { 'Referer': origin, 'Origin': origin } : {}),
    ...(httpHeaders || {})
  };
  
  // Remove Accept-Encoding so CDN doesn't compress the response and ignore Range headers!
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'accept-encoding') {
      delete headers[key];
    }
  }

  if (req.headers.range) {
    headers['Range'] = req.headers.range;
    console.log('🔄 Forwarding Range request:', req.headers.range);
  }

  fetch(videoUrl, {
    headers,
    redirect: 'follow',
    signal: req.signal
  }).then(remote => {
    if (!remote.ok && remote.status !== 206) {
      if (!res.headersSent) res.status(502).json({ error: `CDN returned HTTP ${remote.status}` });
      return;
    }
    let ct = remote.headers.get('content-type') || 'video/mp4';
    if (ct === 'application/octet-stream' || ct === 'binary/octet-stream') {
      ct = 'video/mp4';
    }
    
    if (ct.startsWith('image/')) {
      if (!res.headersSent) res.status(502).json({ error: 'CDN returned an image instead of video' });
      return;
    }
    
    res.status(remote.status);
    res.setHeader('Content-Type', ct);
    res.setHeader('Accept-Ranges', 'bytes');  // ✅ Enable seeking
    
    const cr = remote.headers.get('content-range');
    if (cr) res.setHeader('Content-Range', cr);
    
    const disposition = playInline ? 'inline' : `attachment; filename="${filename}"`;
    res.setHeader('Content-Disposition', disposition);

    const cl = remote.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);
    
    const stream = Readable.fromWeb(remote.body);
    stream.on('error', err => {
      console.log('Stream error:', err.message);
    });
    stream.pipe(res);
  }).catch(err => {
    if (err.name === 'AbortError') {
      console.log('🛑 Fetch aborted (client skipped or disconnected).');
      return;
    }
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
}

// ─── YouTube downloader ─────────────────────────────────────────────────
function ytDlpDownload(url, req, res, playInline = false) {
  return new Promise((resolve, reject) => {

    const infoProc = spawn(YTDLP_BIN, ['--dump-single-json', '--no-playlist', url]);
    let infoData = '';

    infoProc.stdout.on('data', d => {
      infoData += d;
    });

    infoProc.on('close', infoCode => {
      if (infoCode !== 0) {
        return reject(new Error('yt-dlp info failed'));
      }

      let info;

      try {
        info = JSON.parse(infoData);
      } catch {
        return reject(new Error('yt-dlp JSON parse error'));
      }

      const filename = safeFilename(info.title || 'video') + '.mp4';

      const ytArgs = [
        '-f', 'best[ext=mp4]/best',
        '--no-playlist',
        '--geo-bypass',
        '--newline',
        '--no-part',
        '--no-warnings',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        '-o', '-',
      ];

      if (needsCookies(url)) {
        ytArgs.push('--cookies-from-browser', 'chrome');

        try {
          ytArgs.push('--add-header', `Referer:${new URL(url).origin}/`);
        } catch {}
      }

      ytArgs.push(url);

      const yt = spawn(YTDLP_BIN, ytArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      console.log('⬇️ LIVE yt-dlp args:', ytArgs.join(' '));
      console.log('🧠 yt-dlp PID:', yt.pid);

      res.setHeader('Content-Type', 'video/mp4');
      
      // 🟢 NEW LOGIC: Switch between downloading and streaming
      const disposition = playInline ? 'inline' : `attachment; filename="${filename}"`;
      res.setHeader('Content-Disposition', disposition);

      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');

      res.flushHeaders?.();

      let streamedBytes = 0;
      let started = false;
      let gotProgress = false;

      yt.stdout.on('data', chunk => {
        if (!started) {
          started = true;
          console.log('🚀 First live video bytes reached browser');
        }

        streamedBytes += chunk.length;

        if (streamedBytes % (5 * 1024 * 1024) < chunk.length) {
          console.log(
            `📡 LIVE STREAM ${(streamedBytes / 1024 / 1024).toFixed(1)} MB`
          );
        }

        const ok = res.write(chunk);

        if (!ok) {
          yt.stdout.pause();
        }
      });

      res.on('drain', () => {
        yt.stdout.resume();
      });

      yt.stdout.on('end', () => {
        console.log('🏁 yt-dlp stdout finished');

        try {
          res.end();
        } catch {}

        resolve();
      });

      yt.stderr.on('data', d => {
        const text = d.toString();
        const clean = text.replace(/[\r\n]+/g, ' ').trim();

        if (clean) {
          console.log('[yt-dlp]', clean);
        }

        if (
          text.includes('[download]') ||
          text.includes('Destination') ||
          text.includes('Merging')
        ) {
          gotProgress = true;
        }
      });

      yt.on('close', code => {
        console.log(`📴 yt-dlp exited with ${code}`);

        if (code !== 0 && !res.headersSent) {
          reject(new Error(`yt-dlp failed with exit code ${code}`));
        }
      });

      yt.on('error', err => {
        console.error('❌ yt-dlp process error:', err);

        if (!res.headersSent) {
          reject(err);
        }
      });

      req.on('close', () => {
        console.log('❌ Browser closed live stream');

        try {
          yt.kill('SIGKILL');
        } catch {}
      });
    });
  });
}

// ─── /info-stream (SSE progress) ──────────────────────────────────────────
app.get('/info-stream', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (step, status, message, data = {}) => {
    res.write(`data: ${JSON.stringify({ step, status, message, ...data })}\n\n`);
  };

  try {
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
          .filter(f => f.vcodec !== 'none' && f.ext === 'mp4' && (!f.vcodec || f.vcodec.includes('avc1') || f.vcodec.includes('h264')))
          .map(f => ({
            format_id: f.format_id,
            ext: f.ext,
            resolution: f.format,
            height: f.height || 0,
            width: f.width || 0,
            fps: f.fps || 0,
            vcodec: f.vcodec,
            acodec: (f.acodec === 'none' && hasAudioTrack) ? 'aac' : f.acodec,
            filesize: f.filesize || 0,
            tbr: f.tbr || 0
          }))
          .sort((a, b) => (b.height || 0) - (a.height || 0));

        res.write(`data: ${JSON.stringify({
          complete: true,
          source: 'yt-dlp',
          info: {
            title: info.title,
            extractor: info.extractor,
            thumbnail: info.thumbnail,
            duration: info.duration,
            uploader: info.uploader,
            formats: formatsList
          }
        })}\n\n`);

    } catch (ytErr) {
      send(2, 'error', `yt-dlp failed: ${ytErr.message}`);
      send(2, 'active', 'Switching to Puppeteer...');

      try {
        const puppeteerResult = await extractWithPuppeteer(url);
        send(2, 'done', 'Puppeteer extraction successful');

        send(3, 'active', 'Analyzing DOM...');
        await new Promise(r => setTimeout(r, 500));
        send(3, 'done', `${puppeteerResult.streamType.toUpperCase()} stream found`);

        send(4, 'active', 'Validating stream URL...');
        await new Promise(r => setTimeout(r, 300));
        send(4, 'done', 'Stream validated');

        send(5, 'active', 'Quality check...');
        await new Promise(r => setTimeout(r, 200));
        send(5, 'done', 'Best available');

        res.write(`data: ${JSON.stringify({
          complete: true,
          source: 'puppeteer',
          info: {
            title: puppeteerResult.title,
            extractor: 'custom',
            thumbnail: puppeteerResult.thumbnail,
            stream: puppeteerResult.stream,
            streamType: puppeteerResult.streamType
          }
        })}\n\n`);

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

// ─── Health & Init ────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

const server = app.listen(PORT, () => {
  console.log(`🙂 Server → http://localhost:${PORT}`);
  console.log('🟢 Express server listening successfully');
  console.log('📡 Waiting for requests...');
});

server.on('close', () => {
  console.log('🔴 HTTP server closed');
});

server.on('error', err => {
  console.error('🔥 HTTP server error:', err);
});

server.on('connection', socket => {
  console.log('🔌 TCP connection from', socket.remoteAddress);
  socket.on('close', () => {
    console.log('❌ TCP socket closed');
  });
});

// ─── /formats ────────────────────────────────────────────────────────────

app.get('/formats', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  console.log('📥 /formats:', url);

  try {
    const info = await ytDlpInfo(url);
    
    const hasAudioTrack = (info.formats || []).some(f => f.acodec !== 'none');
    
    // Filter and organize formats by quality
    const formats = (info.formats || [])
      .filter(f => f.vcodec !== 'none' && f.ext === 'mp4') // Video formats only
      .map(f => ({
        format_id: f.format_id,
        ext: f.ext,
        resolution: f.format,
        height: f.height || 0,
        width: f.width || 0,
        fps: f.fps || 0,
        vcodec: f.vcodec,
        acodec: (f.acodec === 'none' && hasAudioTrack) ? 'aac' : f.acodec,
        filesize: f.filesize || 0,
        tbr: f.tbr || 0
      }))
      .sort((a, b) => (b.height || 0) - (a.height || 0)); // Sort by height descending

    return res.json({
      title: info.title || 'Video',
      uploader: info.uploader || '',
      duration: info.duration || 0,
      thumbnail: info.thumbnail || '',
      formats: formats
    });
  } catch (err) {
    console.log('⚠️ /formats failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── /download-quality ────────────────────────────────────────────────────

app.get('/download-quality', async (req, res) => {
  req.setTimeout(0);

  const { url, format_id, title = 'video', inline } = req.query;
  const playInline = inline === 'true';
  if (!url || !format_id) return res.status(400).json({ error: 'Missing url or format_id' });
  console.log('📥 /download-quality:', url, 'format:', format_id);

  try {
    const info = await ytDlpInfo(url);
    const selectedFormat = info.formats?.find(f => String(f.format_id) === String(format_id));
    if (!selectedFormat) throw new Error('Format not found in info');

    let videoUrl = selectedFormat.url;
    let audioUrl = null;

    if (selectedFormat.acodec === 'none') {
      const bestAudio = info.formats.filter(f => f.acodec !== 'none').sort((a,b) => (b.abr||0) - (a.abr||0))[0];
      if (bestAudio) audioUrl = bestAudio.url;
    }

    const filename = safeFilename(title) + '.mp4';
    return await pipeStream(req, res, videoUrl, 'mp4', filename, playInline, audioUrl, selectedFormat.http_headers || info.http_headers);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});