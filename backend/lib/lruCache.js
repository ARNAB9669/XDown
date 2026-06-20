import { CONFIG } from './config.js';

export class LRUCache {
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

export const infoCache = new LRUCache(CONFIG.CACHE.INFO_MAX_ENTRIES, CONFIG.CACHE.INFO_TTL);
