import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { rm } from 'fs/promises';
import { EventEmitter } from 'events';
import { CONFIG, FFMPEG_BIN } from './config.js';

export class HLSSessionManager {
  constructor() {
    this.sessions = new Map();
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(200);
    setInterval(() => this._cleanup(), CONFIG.HLS.CLEANUP_INTERVAL);
  }

  async createSession(videoUrl, audioUrl, httpHeaders, originalUrl, videoInfo) {
    if (this.sessions.size >= CONFIG.HLS.MAX_SESSIONS) this._evictOldest();

    const sessionId = randomUUID();
    const dir = path.join(os.tmpdir(), `xdown_hls_${sessionId}`);
    await fs.promises.mkdir(dir, { recursive: true });

    const session = {
      id: sessionId,
      dir,
      ffmpegProcess: null,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      status: 'starting',
      segmentCount: 0,
      error: null,
      videoInfo: { title: videoInfo?.title || 'Video', duration: videoInfo?.duration || 0 },
      playlistPath: path.join(dir, 'playlist.m3u8'),
    };

    this.sessions.set(sessionId, session);
    this._startFFmpeg(sessionId, videoUrl, audioUrl, httpHeaders, originalUrl);
    return sessionId;
  }

  _startFFmpeg(sessionId, videoUrl, audioUrl, httpHeaders, originalUrl) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    let origin = '';
    try { origin = new URL(originalUrl || videoUrl).origin + '/'; } catch { }

    let ffHeaders = origin ? `Referer: ${origin}\r\n` : '';
    let userAgent = CONFIG.USER_AGENT;

    if (httpHeaders) {
      for (const [k, v] of Object.entries(httpHeaders)) {
        if (k.toLowerCase() === 'user-agent') userAgent = v;
        else ffHeaders += `${k}: ${v}\r\n`;
      }
    }

    const segmentPattern = path.join(session.dir, 'seg%05d.m4s');
    const playlistPath = session.playlistPath;

    const ffArgs = [
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
      '-rw_timeout', '30000000',
      '-user_agent', userAgent,
      ...(ffHeaders ? ['-headers', ffHeaders] : []),
      '-i', videoUrl,
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
      // Re-encode video for accurate keyframes (required for seeking)
      '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast',
      '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
      '-bsf:a', 'aac_adtstoasc',
      // Force keyframe every segment for frame-accurate seeking
      '-force_key_frames', `expr:gte(t,n_forced*${CONFIG.HLS.SEGMENT_DURATION})`,
      '-f', 'hls',
      '-hls_time', String(CONFIG.HLS.SEGMENT_DURATION),
      '-hls_segment_type', 'fmp4',
      '-hls_segment_filename', segmentPattern,
      '-hls_playlist_type', 'event',
      '-hls_list_size', '0',
      '-hls_flags', 'independent_segments+append_list',
      '-hls_fmp4_init_filename', 'init.mp4',
      playlistPath,
    );

    console.log(`🎞️ HLS Session ${sessionId.slice(0, 8)} — Starting FFmpeg`);

    const ffmpeg = spawn(FFMPEG_BIN, ffArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    session.ffmpegProcess = ffmpeg;
    session.status = 'processing';
    console.log(`   FFmpeg PID: ${ffmpeg.pid}`);

    let lastSegCount = 0;
    let lastSegTime = Date.now();
    let ffmpegErrLog = '';

    // Stall watchdog
    const stallWatcher = setInterval(async () => {
      if (!this.sessions.has(sessionId)) { clearInterval(stallWatcher); return; }
      const s = this.sessions.get(sessionId);
      if (s.status === 'complete' || s.status === 'error') { clearInterval(stallWatcher); return; }
      try {
        const files = await fs.promises.readdir(session.dir);
        const segCount = files.filter(f => f.endsWith('.m4s')).length;
        if (segCount > lastSegCount) { lastSegCount = segCount; lastSegTime = Date.now(); }
        else if (Date.now() - lastSegTime > CONFIG.DOWNLOAD.STALL_TIMEOUT && s.status === 'processing') {
          console.warn(`⚠️ HLS Session ${sessionId.slice(0, 8)} stalled — killing`);
          s.status = 'error'; s.error = 'Stream stalled (no new segments for 30s)';
          ffmpeg.kill('SIGKILL');
          clearInterval(stallWatcher);
          this.emitter.emit(`error:${sessionId}`, s.error);
        }
      } catch { }
    }, 5000);

    ffmpeg.stderr.on('data', d => { ffmpegErrLog += d.toString(); });

    this._watchForReady(sessionId);

    ffmpeg.on('close', async code => {
      clearInterval(stallWatcher);
      const s = this.sessions.get(sessionId);
      if (!s) return;
      if (code === 0 || code === null) {
        s.status = 'complete';
        console.log(`✅ HLS Session ${sessionId.slice(0, 8)} — FFmpeg complete`);
        this.emitter.emit(`complete:${sessionId}`);
      } else if (s.status !== 'error') {
        s.status = 'error';
        s.error = `FFmpeg exited with code ${code}`;
        console.error(`❌ HLS ${sessionId.slice(0, 8)} — ${s.error}`);
        this.emitter.emit(`error:${sessionId}`, s.error);
      }
    });

    ffmpeg.on('error', err => {
      clearInterval(stallWatcher);
      const s = this.sessions.get(sessionId);
      if (s) { s.status = 'error'; s.error = err.message; }
      this.emitter.emit(`error:${sessionId}`, err.message);
    });
  }

  async _watchForReady(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    let attempts = 0;
    const maxAttempts = 80;

    const check = async () => {
      if (!this.sessions.has(sessionId)) return;
      const s = this.sessions.get(sessionId);
      if (s.status === 'error') return;

      try {
        if (fs.existsSync(s.playlistPath)) {
          const content = await fs.promises.readFile(s.playlistPath, 'utf8');
          const segLines = content.split('\n').filter(l => l.endsWith('.m4s'));
          if (segLines.length >= CONFIG.HLS.READY_SEGMENTS) {
            s.status = 'ready';
            s.segmentCount = segLines.length;
            console.log(`✅ HLS Session ${sessionId.slice(0, 8)} — Ready (${segLines.length} segments)`);
            this.emitter.emit(`ready:${sessionId}`);
            return;
          }
        }
      } catch { }

      attempts++;
      if (attempts < maxAttempts) setTimeout(check, 500);
    };

    setTimeout(check, 500);
  }

  waitForReady(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.reject(new Error('Session not found'));
    if (session.status === 'ready' || session.status === 'complete') return Promise.resolve(true);
    if (session.status === 'error') return Promise.reject(new Error(session.error));

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('HLS session timed out waiting for first segments')), CONFIG.HLS.READY_TIMEOUT);
      const cleanup = () => clearTimeout(timeout);
      this.emitter.once(`ready:${sessionId}`, () => { cleanup(); resolve(true); });
      this.emitter.once(`complete:${sessionId}`, () => { cleanup(); resolve(true); });
      this.emitter.once(`error:${sessionId}`, err => { cleanup(); reject(new Error(err)); });
    });
  }

  getSession(sessionId) {
    const s = this.sessions.get(sessionId);
    if (s) s.lastAccessed = Date.now();
    return s;
  }

  async deleteSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    try { if (session.ffmpegProcess) session.ffmpegProcess.kill('SIGKILL'); } catch { }
    try { await rm(session.dir, { recursive: true, force: true }); console.log(`🗑️ HLS Session ${sessionId.slice(0, 8)} — Cleaned up`); } catch { }
    this.sessions.delete(sessionId);
    this.emitter.removeAllListeners(`ready:${sessionId}`);
    this.emitter.removeAllListeners(`error:${sessionId}`);
    this.emitter.removeAllListeners(`complete:${sessionId}`);
  }

  _evictOldest() {
    let oldest = null, oldestTime = Infinity;
    for (const [id, s] of this.sessions) {
      if (s.lastAccessed < oldestTime) { oldestTime = s.lastAccessed; oldest = id; }
    }
    if (oldest) { console.log(`♻️ Evicting oldest HLS session: ${oldest.slice(0, 8)}`); this.deleteSession(oldest); }
  }

  async _cleanup() {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastAccessed > CONFIG.HLS.SESSION_TTL) {
        console.log(`♻️ Expiring inactive HLS session: ${id.slice(0, 8)}`);
        await this.deleteSession(id);
      }
    }
  }
}

export const hlsManager = new HLSSessionManager();
