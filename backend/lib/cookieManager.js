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
      const host = new URL(url).hostname;
      const baseName = host.split('.').length > 1 ? host.split('.')[host.split('.').length - 2] : host;
      return CONFIG.COOKIE_DOMAINS.some(d => d.includes(baseName));
    } catch { return false; }
  }

  async getCookieArgs(url) {
    if (!this.needsCookies(url)) return [];

    const customCookieFile = path.join(process.cwd(), 'pornhub_cookies.txt');
    if (fs.existsSync(customCookieFile)) {
      try {
        const content = fs.readFileSync(customCookieFile, 'utf8');
        if (content.trim().startsWith('[')) {
          const cookies = JSON.parse(content);
          let netscape = '# Netscape HTTP Cookie File\\n# http://curl.haxx.se/rfc/cookie_spec.html\\n\\n';
          for (const c of cookies) {
            const domain = c.domain || '';
            const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
            const pathVal = c.path || '/';
            const secure = c.secure ? 'TRUE' : 'FALSE';
            const expires = c.expirationDate ? Math.floor(c.expirationDate) : 0;
            netscape += `${domain}\t${includeSub}\t${pathVal}\t${secure}\t${expires}\t${c.name}\t${c.value}\n`;
          }
          fs.writeFileSync(this.filePath, netscape);
          this.cache = this.filePath;
          console.log('🍪 Converted JSON cookies to Netscape format!');
          return ['--cookies', this.filePath];
        } else if (content.trim().length > 0) {
          console.log('🍪 Using manual cookies from pornhub_cookies.txt');
          this.cache = customCookieFile;
          return ['--cookies', customCookieFile];
        }
      } catch (e) {
        console.error('⚠️ Failed to parse pornhub_cookies.txt:', e.message);
      }
    }

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
        '--skip-download', 'https://www.google.com/robots.txt'
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
      const baseName = targetHost.split('.').length > 1 ? targetHost.split('.')[targetHost.split('.').length - 2] : targetHost;

      return content.split('\n')
        .filter(l => l && !l.startsWith('#'))
        .map(l => l.split('\t'))
        .filter(p => p.length >= 7 && p[0].includes(baseName))
        .map(p => `${p[5]}=${p[6].trim()}`)
        .join('; ');
    } catch { return ''; }
  }
}

export const cookieManager = new CookieManager();
