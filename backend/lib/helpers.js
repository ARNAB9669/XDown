import { CONFIG } from './config.js';
import { Transform } from 'stream';

export function safeFilename(name = 'video') {
  return name.replace(/[^\w\s\-().]/g, '').replace(/\s+/g, '_').slice(0, 100);
}

export function scoreUrl(url, pageOrigin) {
  try {
    const u = new URL(url);
    let score = 0;

    if (CONFIG.AD_DOMAINS.some(d => u.hostname.includes(d))) return -Infinity;
    if (/\/(ads?|preroll|vast|midroll|banner|tracking|events?|metrics|analytics|log)\//i.test(u.pathname)) return -Infinity;
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

export class StripPNGTransform extends Transform {
  constructor() {
    super();
    this.checked = false;
    this.pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  }

  _transform(chunk, encoding, callback) {
    if (!this.checked) {
      this.checked = true;
      if (chunk.length > 8 && chunk.subarray(0, 8).equals(this.pngSignature)) {
        const iend = Buffer.from('IEND');
        const idx = chunk.indexOf(iend);
        if (idx !== -1) {
          chunk = chunk.subarray(idx + 4 + 4);
        } else {
          const syncIdx = chunk.indexOf(Buffer.from([0x47, 0x40]));
          if (syncIdx !== -1) chunk = chunk.subarray(syncIdx);
        }
      }
    }
    this.push(chunk);
    callback();
  }
}
