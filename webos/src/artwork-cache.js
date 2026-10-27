// SPDX-License-Identifier: GPL-3.0-only
// Bounded artwork cache for Chromium 53 / webOS 4.x.
// In-memory object URLs keep recently decoded frames available across routes;
// IndexedDB stores compressed image blobs across app launches.
import {diskPressure, evictionsForBudget, preferredDiskBudget, quotaRecoveryTarget} from './cache-budget.js';
export const ARTWORK_DISK_BYTES = 768 * 1024 * 1024;
export const ARTWORK_MEMORY_BYTES = 24 * 1024 * 1024;
const MAX_ENTRY_BYTES = 3 * 1024 * 1024;
const MAX_DECODED_BYTES = 96 * 1024 * 1024; // Approximate bitmap RAM budget.

// Plex photo URLs include X-Plex-Version (our app release number); this is
// unrelated to the server's artwork version and must not bust the disk cache.
export function artworkCacheKey(url, revision) {
  if (!revision) return '';
  try {
    const normalized = new URL(url);
    normalized.searchParams.delete('X-Plex-Version');
    return normalized.href + '|revision=' + encodeURIComponent(revision);
  } catch (_) {
    return url + '|revision=' + encodeURIComponent(revision);
  }
}

export class ArtworkCache {
  constructor(options = {}) {
    this.factory = options.indexedDB === undefined
      ? (typeof indexedDB === 'undefined' ? null : indexedDB) : options.indexedDB;
    this.fetchImage = options.fetch || ((url) => fetch(url));
    this.urls = options.urls || (typeof URL === 'undefined' ? null : URL);
    this.now = options.now || (() => Date.now());
    this.memoryLimit = options.memoryBytes ?? ARTWORK_MEMORY_BYTES;
    this.decodedLimit = options.decodedBytes ?? MAX_DECODED_BYTES;
    this.diskLimit = options.diskBytes ?? ARTWORK_DISK_BYTES;
    this.memory = new Map();
    this.decodedBytes = 0;
    this.protectedKeys = new Set();
    this.memoryBytes = 0;
    this.pending = new Map();
    this.unsupportedOrigins = new Set();
    this.dbPromise = null;
    this.writes = 0;
    this.pruning = null;
    // Direct <img> loads (e.g. unversioned Plex art or servers without CORS)
    // are handled by the browser's image cache. Remember only URLs, not
    // decoded bitmaps; first-frame reuse is confirmed synchronously by <img>.
    this.directLoaded = new Map();
  }
  sawDirectImage(url) {
    if (!this.directLoaded.has(url)) return false;
    this.directLoaded.delete(url);
    this.directLoaded.set(url, true);
    return true;
  }
  markDirectImage(url) {
    if (this.directLoaded.has(url)) this.directLoaded.delete(url);
    this.directLoaded.set(url, true);
    // Bounded metadata only; Chromium remains responsible for decoded bytes.
    if (this.directLoaded.size > 512) this.directLoaded.delete(this.directLoaded.keys().next().value);
  }
  // Prioritize first-viewport artwork across navigations, not every image in
  // an arbitrarily long library. Repeated visits refresh the protection order.
  protect(keys) {
    for (const key of keys) {
      if (!key) continue;
      this.protectedKeys.delete(key);
      this.protectedKeys.add(key);
    }
  }
  memoryVictim() {
    for (const key of this.memory.keys())
      if (!this.protectedKeys.has(key)) return key;
    return this.memory.keys().next().value;
  }
  trimMemory() {
    while (this.memoryBytes > this.memoryLimit ||
           this.decodedBytes > this.decodedLimit) {
      if (!this.memory.size) break;
      this.drop(this.memoryVictim());
    }
  }
  peek(key) {
    const entry = this.memory.get(key);
    if (!entry) return null;
    this.memory.delete(key);
    this.memory.set(key, entry);
    return entry.src;
  }
  peekReady(key) {
    const entry = this.memory.get(key);
    return entry && entry.ready ? this.peek(key) : null;
  }
  markReady(key) {
    const entry = this.memory.get(key);
    if (entry) entry.ready = true;
  }
  drop(key) {
    const entry = this.memory.get(key);
    if (!entry) return;
    this.memory.delete(key);
    this.memoryBytes -= entry.bytes;
    this.decodedBytes -= entry.decodedBytes || 0;
    if (this.urls && this.urls.revokeObjectURL) this.urls.revokeObjectURL(entry.src);
  }
  remember(key, blob) {
    if (!blob || !blob.size || blob.size > MAX_ENTRY_BYTES ||
        !this.urls || !this.urls.createObjectURL) return null;
    const existing = this.peek(key);
    if (existing) return existing;
    let src;
    try { src = this.urls.createObjectURL(blob); }
    catch (_) { return null; }
    const entry = {src, bytes: blob.size, ready: false, decodedBytes: 0};
    // Keep a decoded image reference alive for the immediate next route paint.
    entry.decoded = new Promise(resolve => {
      if (typeof Image === 'undefined') { resolve(false); return; }
      entry.image = new Image();
      entry.image.onload = () => {
        if (this.memory.get(key) !== entry) { resolve(false); return; }
        entry.ready = true;
        // JPEG compression ratios vary hugely. A byte-only limit would let
        // thousands of tiny files retain hundreds of MiB of decoded bitmaps.
        const width = entry.image.naturalWidth || 0;
        const height = entry.image.naturalHeight || 0;
        entry.decodedBytes = width * height * 4;
        this.decodedBytes += entry.decodedBytes;
        this.trimMemory();
        resolve(this.memory.get(key) === entry);
      };
      entry.image.onerror = () => resolve(false);
      try { entry.image.src = src; } catch (_) { resolve(false); }
    });
    this.memory.set(key, entry);
    this.memoryBytes += blob.size;
    // The compressed-blob budget, not the number of titles viewed, bounds
    // storage. Keep first-screen art even after scrolling thousands of titles.
    this.trimMemory();
    return src;
  }
  open() {
    if (!this.factory) return Promise.resolve(null);
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise(resolve => {
      let request;
      try { request = this.factory.open('plezy-artwork-v1', 1); }
      catch (_) { resolve(null); return; }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', {keyPath: 'key'});
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
    return this.dbPromise;
  }
  async read(key) {
    const db = await this.open();
    if (!db) return null;
    return new Promise(resolve => {
      try {
        const tx = db.transaction('images', 'readwrite');
        const store = tx.objectStore('images');
        const request = store.get(key);
        request.onsuccess = () => {
          const entry = request.result;
          if (!entry) { resolve(null); return; }
          if (!entry.blob || !entry.blob.size || entry.blob.size > MAX_ENTRY_BYTES) {
            store.delete(key);
            resolve(null);
            return;
          }
          // Avoid excessive flash writes for repeatedly visited pages.
          if (this.now() - entry.used > 60000) {
            entry.used = this.now();
            store.put(entry);
          }
          resolve(entry);
        };
        request.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  }
  // Rehydrate a page's persisted images before its cards are attached to
  // the DOM. One readonly transaction retrieves every key concurrently; the
  // ordinary two-slot viewport queue is reserved for network misses. There
  // must be NO network fetches in this method.
  async prewarm(keys) {
    const unique = [...new Set(keys.filter(Boolean))];
    const missing = unique.filter(key => !this.peekReady(key) && !this.memory.has(key));
    if (!missing.length) return;
    const db = await this.open();
    if (!db) return;
    const rows = await new Promise(resolve => {
      const found = [];
      try {
        const tx = db.transaction('images', 'readonly');
        const store = tx.objectStore('images');
        for (const key of missing) {
          const request = store.get(key);
          request.onsuccess = () => {
            const entry = request.result;
            if (entry && entry.blob && entry.blob.size &&
                entry.blob.size <= MAX_ENTRY_BYTES) found.push({key, blob: entry.blob, stored: entry});
          };
        }
        tx.oncomplete = () => resolve(found);
        tx.onabort = () => resolve([]);
        tx.onerror = () => resolve([]);
      } catch (_) { resolve([]); }
    });
    // Update disk LRU once per day at most, in one background transaction.
    // Rehydrated artwork is actively used and should not be evicted first just
    // because it bypasses resolve()'s single-item read/touch path.
    const now = this.now();
    const stale = rows.filter(row =>
      now - (Number(row.stored.used) || 0) > 86400000 ||
      this.protectedKeys.has(row.key) && !row.stored.priority);
    if (stale.length) {
      try {
        const tx = db.transaction('images', 'readwrite');
        const store = tx.objectStore('images');
        stale.forEach(row => store.put({...row.stored, used: now,
          priority: !!row.stored.priority || this.protectedKeys.has(row.key)}));
      } catch (_) { /* Persistence is optional. */ }
    }
    // The image decoder can fail or be slow on older webOS versions. Never
    // block the screen indefinitely waiting for a malformed cached image.
    const decoding = rows.map(row => {
      this.remember(row.key, row.blob);
      const entry = this.memory.get(row.key);
      return entry ? entry.decoded : Promise.resolve(false);
    });
    if (!decoding.length) return;
    let timeout;
    try {
      await Promise.race([
        Promise.all(decoding),
        new Promise(resolve => { timeout = setTimeout(resolve, 2000); })
      ]);
    } finally { clearTimeout(timeout); }
  }
  async save(key, blob) {
    const db = await this.open();
    if (!db) return;
    const write = () => new Promise((resolve, reject) => {
      try {
        const tx = db.transaction('images', 'readwrite');
        tx.objectStore('images').put({key, blob, used: this.now(), bytes: blob.size,
          priority: this.protectedKeys.has(key)});
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      } catch (error) { reject(error); }
    });
    try {
      await write();
      if (++this.writes % 96 === 0) {
        diskPressure(1024 * 1024 * 1024).then(pressure => {
          if (pressure) this.prune().catch(() => {});
        }).catch(() => {});
      }
    } catch (_) {
      // Quota can be much smaller on older LG TVs. Evict aggressively once,
      // then let normal image loading continue even if storage still fails.
      await this.prune(undefined, true);
      try { await write(); } catch (_) { /* Storage optional. */ }
    }
  }
  async prune(maxBytes, quotaFailure = false) {
    if (this.pruning) await this.pruning;
    const budget = maxBytes === undefined
      ? await preferredDiskBudget(this.diskLimit, 0.70) : maxBytes;
    this.pruning = this.pruneEntries(budget, quotaFailure).catch(() => {});
    try { await this.pruning; } finally { this.pruning = null; }
  }
  async pruneEntries(maxBytes, quotaFailure = false) {
    const db = await this.open();
    if (!db) return;
    const entries = await new Promise(resolve => {
      const rows = [];
      try {
        const tx = db.transaction('images', 'readonly');
        const cursor = tx.objectStore('images').openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (item) {
            rows.push({key: item.key, bytes: Number(item.value.bytes) || 0,
              used: Number(item.value.used) || 0,
              priority: !!item.value.priority || this.protectedKeys.has(item.key)});
            item.continue();
          } else resolve(rows);
        };
        cursor.onerror = () => resolve(rows);
        tx.onabort = () => resolve([]);
      } catch (_) { resolve([]); }
    });
    const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    const budget = quotaFailure
      ? quotaRecoveryTarget(total, maxBytes, 32 * 1024 * 1024) : maxBytes;
    const remove = evictionsForBudget(entries, budget);
    if (!remove.length) return;
    await new Promise(resolve => {
      try {
        const tx = db.transaction('images', 'readwrite');
        const store = tx.objectStore('images');
        remove.forEach(key => store.delete(key));
        tx.oncomplete = resolve;
        tx.onerror = resolve;
        tx.onabort = resolve;
      } catch (_) { resolve(); }
    });
  }
  async invalidate(key) {
    this.drop(key);
    this.protectedKeys.delete(key);
    const db = await this.open();
    if (!db) return;
    try { db.transaction('images', 'readwrite').objectStore('images').delete(key); }
    catch (_) { /* Best effort. */ }
  }
  // A single fetch per URL serves concurrent instances (e.g. shelf and detail).
  resolve(key, url = key, persistent = true) {
    const hit = this.peek(key);
    if (hit) return Promise.resolve(hit);
    if (this.pending.has(key)) return this.pending.get(key);
    const task = this.resolveUncached(key, url, persistent).then(src => src || url, () => url);
    this.pending.set(key, task);
    task.then(() => this.pending.delete(key));
    return task;
  }
  async resolveUncached(key, url, persistent) {
    // Server images without a trustworthy revision may stay in RAM during this
    // app session, but must never survive a restart as stale IndexedDB rows.
    if (persistent) {
      const stored = await this.read(key);
      if (stored) {
        const src = this.remember(key, stored.blob);
        if (src) return src;
      }
    }
    let origin = '';
    try { origin = new URL(url).origin; } catch (_) { return url; }
    if (this.unsupportedOrigins.has(origin)) return url;
    try {
      // Normal <img> works without CORS; reading bytes for IndexedDB does not.
      // If the TV/server rejects a cross-origin fetch, use <img> directly and
      // stop retrying the unsupported origin for the remainder of this launch.
      const controller = typeof AbortController === 'undefined' ? null : new AbortController();
      const timer = controller ? setTimeout(() => controller.abort(), 7000) : null;
      let response;
      try { response = await this.fetchImage(url, controller ? {signal: controller.signal} : {}); }
      finally { if (timer) clearTimeout(timer); }
      if (!response.ok || (response.type === 'opaque')) return url;
      const type = response.headers && response.headers.get('content-type') || '';
      if (type && !/^image\//i.test(type) && !/^application\/octet-stream/i.test(type))
        return url;
      const blob = await response.blob();
      if (!blob || !blob.size || blob.size > MAX_ENTRY_BYTES) return url;
      const src = this.remember(key, blob);
      if (!src) return url;
      // Persist without delaying first paint.
      if (persistent) this.save(key, blob).catch(() => {});
      return src;
    } catch (_) {
      this.unsupportedOrigins.add(origin);
      return url;
    }
  }
}
