import { spawn } from 'child_process';
import { CONFIG, YTDLP_BIN, FFMPEG_BIN } from './config.js';
import { infoCache } from './lruCache.js';
import { cookieManager } from './cookieManager.js';
import { safeFilename } from './helpers.js';

export async function ytDlpInfo(url, opts = {}) {
  if (!opts.bypassCache) {
    const cached = infoCache.get(url);
    if (cached && !cached.info) { console.log('📋 Cache hit for:', url); return cached; }
  }

  const cookieArgs = await cookieManager.getCookieArgs(url);
  const args = [
    '-J', '--no-warnings', '--no-playlist',
    '--socket-timeout', '10',
    '--user-agent', CONFIG.USER_AGENT,
    ...cookieArgs,
    url
  ];

  return new Promise((resolve, reject) => {
    console.log('🔍 yt-dlp info:', url);
    const proc = spawn(YTDLP_BIN, args);
    console.log('🔍 yt-dlp info args:', args.join(' '));
    console.log('🧠 yt-dlp info PID:', proc.pid);
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(err || 'yt-dlp info failed'));
      try {
        const info = JSON.parse(out);
        infoCache.set(url, info);
        resolve(info);
      } catch { reject(new Error('yt-dlp JSON parse error')); }
    });
    proc.on('error', reject);
  });
}

export function ytDlpDownload(url, req, res, playInline = false, title = 'video', originalUrl = null) {
  return new Promise((resolve, reject) => {
    const filename = safeFilename(title) + '.mp4';
    const targetUrl = originalUrl || url;

    const ytArgs = [
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--no-playlist', '--geo-bypass', '--newline',
      '--no-part', '--no-warnings',
      '--retries', '10', '--fragment-retries', '10',
      '--user-agent', CONFIG.USER_AGENT,
      '-o', '-',
    ];

    cookieManager.getCookieArgs(targetUrl).then(cookieArgs => {
      ytArgs.push(...cookieArgs);
      try { ytArgs.push('--add-header', `Referer:${new URL(targetUrl).origin}/`); } catch { }
      ytArgs.push(url);
      startDownloadProcess(ytArgs);
    }).catch(err => reject(err));

    function startDownloadProcess(finalArgs) {
      const yt = spawn(YTDLP_BIN, finalArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      console.log('⬇️ LIVE yt-dlp args:', finalArgs.join(' '));
      console.log('🧠 yt-dlp PID:', yt.pid);

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', playInline ? 'inline' : `attachment; filename="${filename}"`);
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      let streamStarted = false, streamDestroyed = false, ffmpeg = null;

      yt.stdout.once('data', chunk => {
        streamStarted = true;
        console.log('🚀 First live video bytes reached backend');

        if (chunk[0] === 0x47) {
          console.log('📼 Detected raw MPEG-TS stream. Spawning FFmpeg remuxer...');
          ffmpeg = spawn(FFMPEG_BIN, [
            '-i', 'pipe:0', '-map', '0:v?', '-map', '0:a?',
            '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov+faststart',
            '-f', 'mp4', 'pipe:1'
          ], { stdio: ['pipe', 'pipe', 'pipe'] });

          ffmpeg.stdout.pipe(res);
          ffmpeg.stdout.on('end', () => { if (!streamDestroyed) resolve(); });
          ffmpeg.stderr.on('data', d => {
            const t = d.toString().replace(/[\r\n]+/g, ' ').trim();
            if (t && !t.includes('frame=')) console.log('[ffmpeg-remux]', t);
          });
          ffmpeg.on('close', code => { console.log(`📴 FFmpeg remuxer exited with ${code}`); });
          ffmpeg.stdin.write(chunk);
          yt.stdout.pipe(ffmpeg.stdin);
        } else {
          console.log('📼 Detected clean MP4 stream. Sending directly...');
          res.write(chunk);
          yt.stdout.pipe(res);
        }
      });

      yt.stdout.on('end', () => {
        console.log('🏁 yt-dlp stdout finished');
        if (!ffmpeg && !streamDestroyed) resolve();
      });

      yt.stderr.on('data', d => {
        const t = d.toString().replace(/[\r\n]+/g, ' ').trim();
        if (t) console.log('[yt-dlp]', t);
      });

      yt.on('close', code => {
        console.log(`📴 yt-dlp exited with ${code}`);
        if (code !== 0 && code !== null) {
          if (streamStarted && !streamDestroyed) { streamDestroyed = true; res.destroy(new Error(`yt-dlp failed mid-stream exit ${code}`)); }
          else if (!streamStarted && !res.headersSent) reject(new Error(`yt-dlp failed exit ${code}`));
        }
      });

      yt.on('error', err => {
        if (streamStarted && !streamDestroyed) { streamDestroyed = true; res.destroy(err); }
        else if (!streamStarted && !res.headersSent) reject(err);
      });

      req.on('close', () => {
        console.log('🛑 Browser closed live stream');
        if (!yt.killed && yt.exitCode === null) yt.kill('SIGKILL');
        if (ffmpeg && !ffmpeg.killed && ffmpeg.exitCode === null) ffmpeg.kill('SIGKILL');
      });
    }
  });
}
