import { CONFIG } from './config.js';

export function safeFilename(name = 'video') {
  return name.replace(/[^\w\s\-().]/g, '').replace(/\s+/g, '_').slice(0, 100);
}

export function scoreUrl(url, pageOrigin) {
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
