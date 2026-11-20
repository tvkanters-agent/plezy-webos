// SPDX-License-Identifier: GPL-3.0-only
// Raw embedded ASS fonts are identical across many episodes. Keep their bytes
// independently of the transient libass worker and persist them across app
// launches. Matching is scoped to one Plex series unless the container gives
// us a CRC, to avoid trusting a coincidentally equal filename across series.
const MEMORY_BUDGET = 64 * 1024 * 1024;
const DATABASE = 'plezy-ass-fonts-v1';

export function fontCacheKey(scope, name, length, crc) {
  const identity = String(name).toLowerCase() + ':' + length;
  return crc ? 'crc:' + crc + ':' + identity : 'series:' + String(scope || '') + ':' + identity;
}

export class AssFontCache {
  constructor(factory = typeof indexedDB === 'undefined' ? null : indexedDB) {
    this.factory = factory;
    this.memory = new Map();
    this.memoryBytes = 0;
    this.pending = new Map();
    this.dbPromise = null;
  }

  remember(key, bytes) {
    if (this.memory.has(key)) this.memoryBytes -= this.memory.get(key).byteLength;
    this.memory.delete(key);
    this.memory.set(key, bytes);
    this.memoryBytes += bytes.byteLength;
    while (this.memoryBytes > MEMORY_BUDGET && this.memory.size > 1) {
      const oldest = this.memory.keys().next().value;
      this.memoryBytes -= this.memory.get(oldest).byteLength;
      this.memory.delete(oldest);
    }
  }

  open() {
    if (!this.factory) return Promise.resolve(null);
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise(resolve => {
      let request;
      try { request = this.factory.open(DATABASE, 1); }
      catch (_) { resolve(null); return; }
      request.onupgradeneeded = () => request.result.createObjectStore('fonts', {keyPath:'key'});
      request.onsuccess = () => resolve(request.result);
      request.onerror = request.onblocked = () => resolve(null);
    });
    return this.dbPromise;
  }

  async get(scope, name, length, crc) {
    const key = fontCacheKey(scope, name, length, crc);
    const memory = this.memory.get(key);
    if (memory) { this.remember(key, memory); return memory; }
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = (async () => {
      const db = await this.open();
      if (!db) return null;
      return new Promise(resolve => {
        try {
          const request = db.transaction('fonts', 'readonly').objectStore('fonts').get(key);
          request.onsuccess = () => {
            const bytes = request.result?.bytes;
            if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) { resolve(null); return; }
            this.remember(key, bytes);
            resolve(bytes);
          };
          request.onerror = () => resolve(null);
        } catch (_) { resolve(null); }
      });
    })();
    this.pending.set(key, promise);
    try { return await promise; }
    finally { this.pending.delete(key); }
  }

  put(scope, name, bytes, crc) {
    const key = fontCacheKey(scope, name, bytes.byteLength, crc);
    this.remember(key, bytes);
    // Disk writes must never delay a frame or subtitle-preview callback.
    this.persist(key, bytes).catch(() => {});
  }

  async persist(key, bytes) {
    const db = await this.open();
    if (!db) return;
    const write = () => new Promise(resolve => {
      try {
        const transaction = db.transaction('fonts','readwrite');
        transaction.objectStore('fonts').put({key,bytes,used:Date.now()});
        transaction.oncomplete = () => resolve(true);
        transaction.onerror = transaction.onabort = () => resolve(false);
      } catch (_) { resolve(false); }
    });
    if (await write()) return;
    // Storage quotas are shared with the much more valuable Plex artwork
    // cache. On pressure, evict only old subtitle fonts and retry once.
    if (await this.evictOldest(db)) await write();
  }

  async evictOldest(db) {
    return new Promise(resolve => {
      try {
        const transaction = db.transaction('fonts','readwrite');
        const store = transaction.objectStore('fonts');
        const entries = [];
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (item) {
            entries.push({key:item.key,used:item.value.used || 0});
            item.continue();
          } else {
            entries.sort((a,b)=>a.used-b.used);
            for (const entry of entries.slice(0,Math.max(1,Math.ceil(entries.length/3))))
              store.delete(entry.key);
          }
        };
        transaction.oncomplete = () => resolve(entries.length > 0);
        transaction.onerror = transaction.onabort = () => resolve(false);
      } catch (_) { resolve(false); }
    });
  }
}

export const assFontCache = new AssFontCache();
