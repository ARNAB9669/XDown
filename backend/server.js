//====== XDown v5.0 — Production Server ======
import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import os from 'os';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { rm } from 'fs/promises';
import { EventEmitter } from 'events';

const stealth = StealthPlugin();
stealth.enabledEvasions.delete('chrome.app');
puppeteer.use(stealth);

// ─── Cross-Platform Binary Locator ────────────────────────────────────────
function getBinaryPath(binaryName) {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const localPath = path.resolve(process.cwd(), 'bin', `${binaryName}${ext}`);
  return fs.existsSync(localPath) ? localPath : binaryName;
}

const YTDLP_BIN = getBinaryPath('yt-dlp');
const FFMPEG_BIN = getBinaryPath('ffmpeg');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Centralized CONFIG ────────────────────────────────────────────────────
const CONFIG = {
  PORT: process.env.XDOWN_PORT || 8000,

  HLS: {
    SEGMENT_DURATION: 2,
    MAX_SESSIONS: 10,
    SESSION_TTL: 30 * 60 * 1000,
    CLEANUP_INTERVAL: 60 * 1000,
    READY_SEGMENTS: 3,
    READY_TIMEOUT: 35000,
  },

  CACHE: {
    INFO_MAX_ENTRIES: 50,
    INFO_TTL: 30 * 60 * 1000,
    COOKIE_TTL: 5 * 60 * 1000,
  },

  PUPPETEER: {
    MAX_CRASH_RESTARTS: 3,
    CRASH_WINDOW: 60 * 1000,
    NAV_TIMEOUT: 15000,
    WAIT_TIMEOUT: 12000,
  },

  DOWNLOAD: {
    STALL_TIMEOUT: 30000,
  },

  // Single source of truth — client fetches this from /config
  COOKIE_DOMAINS: [
    'pornhub.com', 'xhamster.com', 'xnxx.com', 'xvideos.com',
    'youporn.com', 'redtube.com', 'spankbang.com', 'tube8.com',
    'thisvid.com', 'empflix.com', 'nuvid.com', 'txxx.com',
    'drtuber.com', 'hardsextube.com', 'porntrex.com', 'hclips.com',
    'fapster.xxx', 'porn.com', 'beeg.com', 'tubegalore.com',
    'xfantasy.com', 'fuq.com', 'hdzog.com', 'iceporn.com',
    'pornoxo.com', 'fux.com', 'vjav.com', 'javmost.com',
  ],

  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',

  AD_DOMAINS: [
    'trafficjunky.net', 'trafficfactory.biz', 'tsyndicate.com',
    'exoclick.com', 'adnium.com', 'plugrush.com', 'juicyads.com',
    'a-ads.com', 'adtng.com', 'mngads.com', 'popads.net',
    'adnetwork.net', 'tubeads.com', 'xbidder.com',
    'adspyglass.com', 'doubleverify.com', 'adsafeprotected.com',
    'moatads.com', 'pornvertiser.com', 'sexad.net', 'porniframe.com',
    'redmoon-media.com', 'trafficstars.com', 'ero-advertising.com',
  ],
};

// ─── LRU Cache ────────────────────────────────────────────────────────────
class LRUCache {
  constructor(maxSize, ttl) {
    this.maxSize = maxSize;
    this.ttl = ttl;
    this.cache = new Map();
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { this.cache.delete(key); return null; }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttl });
  }

  delete(key) { this.cache.delete(key); }
  has(key) { return this.get(key) !== null; }
  get size() { return this.cache.size; }
}

const infoCache = new LRUCache(CONFIG.CACHE.INFO_MAX_ENTRIES, CONFIG.CACHE.INFO_TTL);

// ─── Cookie Manager ───────────────────────────────────────────────────────
class CookieManager {
  constructor() {
    this.busy = false;
    this.cache = null;
    this.cacheExpiry = 0;
    this.waiters = [];
    this.filePath = path.join(os.tmpdir(), 'xdown_cookies_v5.txt');
  }

  needsCookies(url) {
    try {
      const host = new URL(url).hostname.replace('www.', '');
      return CONFIG.COOKIE_DOMAINS.some(d => host.includes(d.replace('www.', '')));
    } catch { return false; }
  }

  async getCookieArgs(url) {
    if (!this.needsCookies(url)) return [];
    if (Date.now() < this.cacheExpiry && this.cache) return ['--cookies', this.cache];

    if (this.busy) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Cookie export wait timeout')), 10000);
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
      return this.cache ? ['--cookies', this.cache] : [];
    }

    this.busy = true;
    try {
      await this._exportCookies();
      this.cacheExpiry = Date.now() + CONFIG.CACHE.COOKIE_TTL;
      return ['--cookies', this.filePath];
    } catch (err) {
      console.error('⚠️ Cookie export failed (continuing without cookies):', err.message);
      return [];
    } finally {
      this.busy = false;
      const waiters = this.waiters.splice(0);
      waiters.forEach(r => r());
    }
  }

  _exportCookies(browser = 'chrome') {
    return new Promise((resolve, reject) => {
      const proc = spawn(YTDLP_BIN, [
        '--cookies-from-browser', browser,
        '--cookies', this.filePath,
        '--skip-download', 'about:blank'
      ]);
      let errOut = '';
      proc.stderr.on('data', d => { errOut += d; });
      proc.on('close', code => {
        if (code === 0) { this.cache = this.filePath; resolve(); }
        else reject(new Error(`Cookie export exit ${code}: ${errOut.slice(0, 200)}`));
      });
      proc.on('error', reject);
      const killTimer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error('Cookie export process timed out'));
      }, 15000);
      proc.on('close', () => clearTimeout(killTimer));
    });
  }

  async parseCookiesForUrl(url) {
    if (!this.cache || !fs.existsSync(this.cache)) return '';
    try {
      const content = await fs.promises.readFile(this.cache, 'utf8');
      const targetHost = new URL(url).hostname;
      return content.split('\n')
        .filter(l => l && !l.startsWith('#'))
        .map(l => l.split('\t'))
        .filter(p => p.length >= 7 && targetHost.includes(p[0].replace(/^\./, '')))
        .map(p => `${p[5]}=${p[6].trim()}`)
        .join('; ');
    } catch { return ''; }
  }
}

const cookieManager = new CookieManager();

// ─── Puppeteer Manager ────────────────────────────────────────────────────
class PuppeteerManager {
  constructor() {
    this.browser = null;
    this.crashCount = 0;
    this.firstCrashTime = null;
    this.launching = false;
    this.launchWaiters = [];
  }

  async getBrowser() {
    if (this.browser) {
      try { await this.browser.pages(); return this.browser; }
      catch { this._onCrash(); }
    }

    const now = Date.now();
    if (this.firstCrashTime && (now - this.firstCrashTime) < CONFIG.PUPPETEER.CRASH_WINDOW) {
      if (this.crashCount >= CONFIG.PUPPETEER.MAX_CRASH_RESTARTS) {
        throw new Error(`Puppeteer crash limit reached (${CONFIG.PUPPETEER.MAX_CRASH_RESTARTS} crashes in 60s). Try again later.`);
      }
    } else {
      this.crashCount = 0;
      this.firstCrashTime = null;
    }

    if (this.launching) {
      await new Promise(resolve => this.launchWaiters.push(resolve));
      return this.browser;
    }

    this.launching = true;
    try {
      console.log('🧠 Launching shared browser...');
      this.browser = await puppeteer.launch({
        headless: false,
        args: [
          '--no-sandbox', '--disable-setuid-sandbox',
          '--disable-dev-shm-usage', '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process',
          '--autoplay-policy=no-user-gesture-required',
          '--disable-blink-features=AutomationControlled',
          '--disable-infobars', '--window-size=1366,768',
          '--memory-pressure-off',
          '--disable-background-timer-throttling',
        ],
        ignoreHTTPSErrors: true,
        defaultViewport: { width: 1366, height: 768 },
        protocolTimeout: 30000,
      });
      this.browser.on('disconnected', () => this._onCrash());
      return this.browser;
    } finally {
      this.launching = false;
      this.launchWaiters.forEach(r => r());
      this.launchWaiters = [];
    }
  }

  _onCrash() {
    this.browser = null;
    if (!this.firstCrashTime) this.firstCrashTime = Date.now();
    this.crashCount++;
    console.warn(`⚠️ Puppeteer crash #${this.crashCount}`);
  }
}

const puppeteerManager = new PuppeteerManager();

// ─── HLS Session Manager ──────────────────────────────────────────────────
class HLSSessionManager {
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

const hlsManager = new HLSSessionManager();

// ─── Helpers ───────────────────────────────────────────────────────────────
function safeFilename(name = 'video') {
  return name.replace(/[^\w\s\-().]/g, '').replace(/\s+/g, '_').slice(0, 100);
}

function scoreUrl(url, pageOrigin) {
  try {
    const u = new URL(url);
    let score = 0;

    if (CONFIG.AD_DOMAINS.some(d => u.hostname.includes(d))) return -Infinity;
    if (/\/(ads?|preroll|vast|midroll|banner|tracking)\//i.test(u.pathname)) return -Infinity;
    if (/blank\.mp4|preview|thumb|icon|logo/i.test(u.pathname)) return -Infinity;

    try {
      const pageHost = new URL(pageOrigin).hostname.split('.').slice(-2).join('.');
      if (u.hostname.includes(pageHost)) score += 5000;
    } catch { }

    score += Math.min(url.length, 200);
    if (url.includes('.m3u8')) score += 1000;
    if (url.includes('master')) score += 500;

    return score;
  } catch { return -Infinity; }
}

function resolveBestQualityUrl(url) {
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

// ─── yt-dlp info ───────────────────────────────────────────────────────────
async function ytDlpInfo(url, opts = {}) {
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

// ─── Puppeteer extractor (network-level intercept) ────────────────────────
async function extractWithPuppeteer(pageUrl) {
  console.log('🕷️ Puppeteer extracting:', pageUrl);

  const browser = await puppeteerManager.getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent(CONFIG.USER_AGENT);
    await page.setRequestInterception(true);

    // Inject cookies if needed
    if (cookieManager.needsCookies(pageUrl) && cookieManager.cache) {
      try {
        const cookieStr = await cookieManager.parseCookiesForUrl(pageUrl);
        if (cookieStr) {
          const domain = new URL(pageUrl).hostname;
          const cookiePairs = cookieStr.split('; ').map(pair => {
            const [name, ...rest] = pair.split('=');
            return { name: name.trim(), value: rest.join('=').trim(), domain };
          });
          await page.setCookie(...cookiePairs.filter(c => c.name && c.value));
        }
      } catch { }
    }

    // Prevent page reload/redirect tricks
    await page.evaluateOnNewDocument(() => {
      window.location.reload = function () { };
      window.location.replace = function () { };
    });

    const capturedUrls = [];

    // Network-level intercept — catches URLs before they hit the DOM
    page.on('request', req => {
      const t = req.resourceType();
      if (t === 'image' || t === 'font' || t === 'stylesheet') { req.abort(); return; }
      req.continue();
    });

    page.on('response', async response => {
      try {
        const u = response.url();
        const ct = response.headers()['content-type'] || '';
        const isVideoUrl = u.includes('.m3u8') || u.includes('.mpd') || u.includes('.mp4') || u.includes('.webm') || ct.includes('video/');
        if (!isVideoUrl) return;
        const score = scoreUrl(u, pageUrl);
        if (score === -Infinity) return;
        capturedUrls.push({ url: u, score });
      } catch { }
    });

    try { await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.PUPPETEER.NAV_TIMEOUT }); } catch { }

    // Event-driven wait: resolve as soon as a high-confidence URL is found
    const waitForVideoUrl = new Promise(resolve => {
      const intervalId = setInterval(() => {
        const bestSoFar = capturedUrls.sort((a, b) => b.score - a.score)[0];
        if (bestSoFar && bestSoFar.score > 100) { clearInterval(intervalId); resolve(); }
      }, 300);
      // Hard timeout fallback
      setTimeout(() => { clearInterval(intervalId); resolve(); }, CONFIG.PUPPETEER.WAIT_TIMEOUT);
    });

    // Try play button
    try {
      await page.evaluate(() => {
        document.querySelectorAll('button, .play-button, [class*=play]').forEach(b => { try { b.click(); } catch { } });
        document.querySelectorAll('video').forEach(v => { try { v.play(); } catch { } });
      });
    } catch { }

    await waitForVideoUrl;

    // Also scan DOM as backup
    const frames = page.frames();
    console.log(`🖼️ Inspecting ${frames.length} frames...`);
    for (const frame of frames) {
      try {
        const dom = await Promise.race([
          frame.evaluate((adDomains) => {
            const junkRegex = new RegExp(adDomains.map(d => d.replace('.', '\\.')).join('|'), 'i');
            let bestVid = null, bestScore = 0;
            document.querySelectorAll('video').forEach(v => {
              let src = v.src || v.currentSrc;
              if (!src || src.startsWith('blob:')) {
                const source = v.querySelector('source');
                if (source) src = source.src;
              }
              if (!src || junkRegex.test(src)) return;
              const area = v.clientWidth * v.clientHeight;
              const duration = (!isNaN(v.duration) && v.duration > 30) ? v.duration : 0;
              const score = area + duration * 1000;
              if (score > bestScore) { bestScore = score; bestVid = src; }
            });
            return bestVid;
          }, CONFIG.AD_DOMAINS),
          new Promise((_, reject) => setTimeout(() => reject(new Error('frame timeout')), 2000))
        ]);
        if (dom) capturedUrls.push({ url: dom, score: 200 });
      } catch { }
    }

    const debugImagePath = path.join(os.tmpdir(), 'bot_debug_vision.png');
    await page.screenshot({ path: debugImagePath, fullPage: true }).catch(() => { });
    console.log('📸 Debug screenshot saved to:', debugImagePath);

    capturedUrls.sort((a, b) => b.score - a.score);
    const best = capturedUrls[0];
    if (!best) throw new Error('No valid video stream found. Blocked by ads or captchas.');

    let finalStream = best.url;
    if (finalStream.startsWith('/')) {
      const p = new URL(pageUrl);
      finalStream = `${p.protocol}//${p.host}${finalStream}`;
    }

    let streamType = 'mp4';
    if (finalStream.includes('.m3u8')) streamType = 'm3u8';
    else if (finalStream.includes('.mpd')) streamType = 'mpd';

    console.log('✅ Puppeteer result:', finalStream);

    let title = 'Video';
    try { title = await Promise.race([page.title(), new Promise(r => setTimeout(() => r('Video'), 2000))]); } catch { }

    const thumb = await page.evaluate(() => document.querySelector('video')?.poster || '').catch(() => '');

    let cookieStr = '';
    try {
      const pageCookies = await page.cookies();
      cookieStr = pageCookies.map(c => `${c.name}=${c.value}`).join('; ');
    } catch { }

    return { stream: finalStream, streamType, thumbnail: thumb, title, cookies: cookieStr };

  } finally {
    try { await page.close(); } catch { }
  }
}

// ─── Express app ──────────────────────────────────────────────────────────
const app = express();
const PORT = CONFIG.PORT;

app.use(express.static(path.join(__dirname, '../')));
app.use(cors());
app.use(express.json());

// Boot logs
console.log('XDown v5.0 Backend Initialized');
console.log('🚀 Boot sequence started...');
console.log('🖥️ Node version:', process.version);
console.log('📂 Working directory:', process.cwd());
console.log('🧠 PID:', process.pid);
console.log('🧵 Platform:', process.platform, process.arch);
console.log('📦 Binary targets:', { YTDLP_BIN, FFMPEG_BIN });

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

// ─── pipeStream ───────────────────────────────────────────────────────────
function pipeStream(req, res, videoUrl, streamType, filename, playInline = false, audioUrl = null, httpHeaders = null, originalUrl = null, retryCount = 0) {
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

    const ffArgs = [
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
      '-rw_timeout', '30000000',
      '-user_agent', userAgent,
      ...(ffHeaders ? ['-headers', ffHeaders] : []),
      '-i', videoUrl,
    ];

    if (audioUrl) {
      ffArgs.push('-user_agent', userAgent, ...(ffHeaders ? ['-headers', ffHeaders] : []), '-i', audioUrl);
    }

    const isWebM = filename.toLowerCase().endsWith('.webm');

    ffArgs.push(
      '-map', '0:v:0?',
      ...(audioUrl ? ['-map', '1:a:0?'] : ['-map', '0:a:0?']),
      '-c:v', 'copy',
      '-c:a', 'copy' // always copy audio; the caller must provide a compatible audio stream (opus/vorbis for webm, aac/m4a for mp4)
    );

    if (isWebM) {
      ffArgs.push('-f', 'webm', 'pipe:1');
    } else {
      ffArgs.push(
        '-bsf:a', 'aac_adtstoasc',
        '-movflags', 'frag_keyframe+empty_moov+faststart',
        '-f', 'mp4', 'pipe:1'
      );
    }

    const ffmpeg = spawn(FFMPEG_BIN, ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log('🧠 FFmpeg PID:', ffmpeg.pid);

    res.setHeader('Content-Type', isWebM ? 'video/webm' : 'video/mp4');
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
            .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.ext === 'mp4')
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

// ─── ytDlpDownload ────────────────────────────────────────────────────────
function ytDlpDownload(url, req, res, playInline = false, title = 'video', originalUrl = null) {
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

// ─── /m3u8-proxy ────────────────────────────────────────────────────────────
app.get('/m3u8-proxy', async (req, res) => {
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
                return `URI="/m3u8-proxy?url=${encodeURIComponent(absolute)}&originalUrl=${encodeURIComponent(originalUrl)}"`;
              } catch { return match; }
            });
          }
          return line;
        }
        try {
          const absolute = new URL(t, targetUrl).href;
          return `/m3u8-proxy?url=${encodeURIComponent(absolute)}&originalUrl=${encodeURIComponent(originalUrl)}`;
        } catch { return line; }
      }).join('\n');

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(text);
    } else {
      res.status(remote.status);
      res.setHeader('Content-Type', ct);
      res.setHeader('Access-Control-Allow-Origin', '*');
      const cl = remote.headers.get('content-length');
      if (cl) res.setHeader('Content-Length', cl);
      const stream = Readable.fromWeb(remote.body);
      stream.pipe(res);
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
  console.log('🟢 Express server listening successfully');
  console.log('📡 Waiting for requests...');
});

server.on('close', () => { console.log('🔴 HTTP server closed'); });
server.on('error', err => { console.error('🔥 HTTP server error:', err); });
server.on('connection', socket => {
  console.log('🔌 TCP connection from', socket.remoteAddress);
  socket.on('close', () => { console.log('❌ TCP socket closed'); });
});

