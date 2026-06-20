import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { CONFIG, YTDLP_BIN } from './config.js';

export class CookieManager {
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

export const cookieManager = new CookieManager();
