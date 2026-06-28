import path from 'path';
import os from 'os';
import { CONFIG } from './config.js';
import { cookieManager } from './cookieManager.js';
import { puppeteerManager } from './puppeteerManager.js';
import { infoCache } from './lruCache.js';
import { scoreUrl } from './helpers.js';

export async function extractWithPuppeteer(pageUrl) {
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
      if (t === 'image' || t === 'font') { req.abort(); return; }
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
        // Try to aggressively skip ads while waiting
        page.evaluate(() => {
          document.querySelectorAll('[class*="skip"], [id*="skip"], .skip-ad').forEach(b => { try { b.click(); } catch { } });
        }).catch(() => {});

        const bestSoFar = capturedUrls.sort((a, b) => b.score - a.score)[0];
        if (bestSoFar && bestSoFar.score > 100) { clearInterval(intervalId); resolve(); }
      }, 300);
      // Hard timeout fallback
      setTimeout(() => { clearInterval(intervalId); resolve(); }, CONFIG.PUPPETEER.WAIT_TIMEOUT);
    });

    // Try play button without clicking playlist links
    try {
      await page.mouse.click(683, 384); // Click center of screen (1366x768 viewport)
      await page.evaluate(() => {
        document.querySelectorAll('.mgp_videoWrapper, .mhp1138_playButton, .play-video').forEach(b => { try { b.click(); } catch { } });
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
