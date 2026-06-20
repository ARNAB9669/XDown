import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { CONFIG } from './config.js';

const stealth = StealthPlugin();
stealth.enabledEvasions.delete('chrome.app');
puppeteer.use(stealth);

export class PuppeteerManager {
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

export const puppeteerManager = new PuppeteerManager();
