import { spawn } from 'child_process';
import { Readable } from 'stream';
import { CONFIG, FFMPEG_BIN } from './config.js';
import { cookieManager } from './cookieManager.js';
import { ytDlpInfo } from './ytdlp.js';

export function resolveBestQualityUrl(url) {
  if (!url.includes('_TPL_')) return url;
  const pMatches = [...url.matchAll(/:(\d+p):/g)].map(m => m[1]);
  if (pMatches.length) {
    const best = pMatches.sort((a, b) => parseInt(b) - parseInt(a))[0];
    return url.replace('_TPL_', best);
  }
  const multiMatch = url.match(/multi=([^/]+)/);
  if (multiMatch) {
    const qualities = multiMatch[1].split(',').map(s => s.split(':')[0]);
    if (qualities.length) return url.replace('_TPL_', qualities.sort((a, b) => parseInt(b) - parseInt(a))[0]);
  }
  return url.replace('_TPL_', '1080p');
}

export function pipeStream(req, res, videoUrl, streamType, filename, playInline = false, audioUrl = null, httpHeaders = null, originalUrl = null, retryCount = 0) {
  videoUrl = resolveBestQualityUrl(videoUrl);

  const isAdaptive = streamType === 'm3u8' || streamType === 'mpd'
    || videoUrl.includes('.m3u8') || videoUrl.includes('.mpd');

  if (playInline && (streamType === 'm3u8' || videoUrl.includes('.m3u8')) && !audioUrl) {
    console.log('🎞️ Redirecting HLS request to Native M3U8 Proxy...');
    return res.redirect(`/m3u8-proxy?url=${encodeURIComponent(videoUrl)}&originalUrl=${encodeURIComponent(originalUrl || videoUrl)}`);
  }

  if (isAdaptive || audioUrl) {
    console.log('🎞️ FFmpeg direct live browser stream...');

    let origin = '';
    try { origin = new URL(originalUrl || videoUrl).origin + '/'; } catch { }

    let ffHeaders = origin ? `Referer: ${origin}\r\n` : '';
    let userAgent = CONFIG.USER_AGENT;

    if (httpHeaders) {
      for (const [key, value] of Object.entries(httpHeaders)) {
        if (key.toLowerCase() === 'user-agent') userAgent = value;
        else ffHeaders += `${key}: ${value}\r\n`;
      }
    }

    let ffmpegVideoUrl = (streamType === 'm3u8' || videoUrl.includes('.m3u8'))
      ? `http://127.0.0.1:${CONFIG.PORT}/m3u8-proxy.m3u8?url=${encodeURIComponent(videoUrl)}&originalUrl=${encodeURIComponent(originalUrl || videoUrl)}`
      : videoUrl;

    const ffArgs = [
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
      '-rw_timeout', '30000000',
      '-user_agent', userAgent,
      ...(ffHeaders ? ['-headers', ffHeaders] : []),
      '-i', ffmpegVideoUrl,
    ];

    if (audioUrl) {
      let ffmpegAudioUrl = audioUrl.includes('.m3u8')
        ? `http://127.0.0.1:${CONFIG.PORT}/m3u8-proxy.m3u8?url=${encodeURIComponent(audioUrl)}&originalUrl=${encodeURIComponent(originalUrl || audioUrl)}`
        : audioUrl;
      ffArgs.push('-user_agent', userAgent, ...(ffHeaders ? ['-headers', ffHeaders] : []), '-i', ffmpegAudioUrl);
    }

    ffArgs.push(
      '-map', '0:v:0?',
      ...(audioUrl ? ['-map', '1:a:0?'] : ['-map', '0:a:0?']),
      '-c:v', 'copy',
      '-c:a', audioUrl ? 'aac' : 'copy',
      ...(audioUrl ? ['-b:a', '192k'] : []),
      '-bsf:a', 'aac_adtstoasc',
      '-movflags', 'frag_keyframe+empty_moov+faststart',
      '-f', 'mp4', 'pipe:1'
    );

    const ffmpeg = spawn(FFMPEG_BIN, ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log('🧠 FFmpeg PID:', ffmpeg.pid);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('Content-Disposition', playInline ? `inline; filename="${filename}"` : `attachment; filename="${filename}"`);
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let sentBytes = 0, streamStarted = false, streamDestroyed = false;

    ffmpeg.stdout.on('data', chunk => {
      if (!streamStarted) { streamStarted = true; console.log('🚀 Browser download icon should appear NOW'); }
      sentBytes += chunk.length;
      if (sentBytes % (5 * 1024 * 1024) < chunk.length) console.log(`📦 Streamed ${(sentBytes / 1024 / 1024).toFixed(1)} MB to browser`);
      const ok = res.write(chunk);
      if (!ok) ffmpeg.stdout.pause();
    });

    res.on('drain', () => { if (!ffmpeg.killed) ffmpeg.stdout.resume(); });

    ffmpeg.stdout.on('end', () => {
      console.log('🏁 FFmpeg stdout ended');
      if (!streamDestroyed) try { res.end(); } catch { }
    });

    ffmpeg.stdout.on('error', err => {
      if (streamStarted && !streamDestroyed) { streamDestroyed = true; res.destroy(err); }
      else if (!streamStarted && !res.headersSent) res.status(500).json({ error: 'Stream pipe failed' });
    });

    ffmpeg.stderr.on('data', d => { process.stdout.write('[ffmpeg] ' + d); });

    ffmpeg.on('close', code => {
      console.log(`[ffmpeg] exit ${code}`);
      if (code !== 0 && code !== null) {
        if (streamStarted && !streamDestroyed) { streamDestroyed = true; res.destroy(new Error(`FFmpeg failed mid-stream with exit code ${code}`)); }
        else if (!streamStarted && !res.headersSent) res.status(500).json({ error: 'FFmpeg conversion failed' });
        return;
      }
      console.log('✅ Direct browser streaming finished');
      if (!streamDestroyed) try { res.end(); } catch { }
    });

    ffmpeg.on('error', err => {
      if (!res.headersSent) res.status(500).json({ error: 'FFmpeg spawn error' });
    });

    req.on('close', () => {
      console.log('🛑 Browser closed live stream');
      if (!ffmpeg.killed && ffmpeg.exitCode === null) ffmpeg.kill('SIGKILL');
    });

    return;
  }

  // Direct MP4/WebM — native fetch with 403 retry
  console.log('📦 Direct stream using native Fetch...');

  let origin = '';
  try { origin = new URL(originalUrl || videoUrl).origin + '/'; } catch { }

  const headers = {
    'User-Agent': CONFIG.USER_AGENT,
    ...(origin ? { 'Referer': origin, 'Origin': origin } : {}),
    ...(httpHeaders || {}),
  };
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'accept-encoding') delete headers[key];
  }
  if (req.headers.range) { headers['Range'] = req.headers.range; console.log('🔄 Forwarding Range request:', req.headers.range); }

  // Inject cookies for adult sites
  cookieManager.parseCookiesForUrl(videoUrl).then(cookieStr => {
    if (cookieStr) headers['Cookie'] = cookieStr;
  }).catch(() => { }).finally(() => {
    fetch(videoUrl, { headers, redirect: 'follow', signal: req.signal }).then(async remote => {
      // 403/410: signed URL may have expired — retry with fresh extraction
      if ((remote.status === 403 || remote.status === 410) && retryCount < 2 && originalUrl) {
        console.log(`🔄 HTTP ${remote.status} — signed URL expired, re-extracting (attempt ${retryCount + 1})...`);
        try {
          const freshInfo = await ytDlpInfo(originalUrl, { bypassCache: true });
          const allFormats = freshInfo.formats || [];
          const bestCombined = allFormats
            .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && (f.ext === 'mp4' || f.ext === 'webm'))
            .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
          if (bestCombined) {
            return pipeStream(req, res, bestCombined.url, 'mp4', filename, playInline, null, bestCombined.http_headers || freshInfo.http_headers, originalUrl, retryCount + 1);
          }
        } catch (retryErr) {
          console.warn('⚠️ Re-extraction failed:', retryErr.message);
        }
      }

      if (!remote.ok && remote.status !== 206) {
        if (!res.headersSent) res.status(502).json({ error: `CDN returned HTTP ${remote.status}` });
        return;
      }
      let ct = remote.headers.get('content-type') || 'video/mp4';
      if (ct === 'application/octet-stream' || ct === 'binary/octet-stream') ct = 'video/mp4';
      if (ct.startsWith('image/')) { if (!res.headersSent) res.status(502).json({ error: 'CDN returned an image instead of video' }); return; }

      res.status(remote.status);
      res.setHeader('Content-Type', ct);
      res.setHeader('Accept-Ranges', 'bytes');
      const cr = remote.headers.get('content-range');
      if (cr) res.setHeader('Content-Range', cr);
      res.setHeader('Content-Disposition', playInline ? 'inline' : `attachment; filename="${filename}"`);
      const cl = remote.headers.get('content-length');
      if (cl) res.setHeader('Content-Length', cl);

      const stream = Readable.fromWeb(remote.body);
      stream.on('error', err => { if (res.headersSent) res.destroy(err); });
      stream.pipe(res);
    }).catch(err => {
      if (err.name === 'AbortError') { console.log('🛑 Fetch aborted (client disconnected).'); return; }
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });
  });
}
