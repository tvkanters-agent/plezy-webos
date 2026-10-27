// SPDX-License-Identifier: GPL-3.0-only
// Offline-tolerant library snapshots. Return saved pages before the network
// finishes, then reconcile changed server data without blocking first paint.
// Home is deliberately excluded: its volatile CatalogCache starts empty.
import {evictionsForBudget, preferredDiskBudget, quotaRecoveryTarget} from './cache-budget.js';
const STORE = 'pages';
export const CATALOG_DISK_BYTES = 256 * 1024 * 1024;
export const CATALOG_MEMORY_BYTES = 16 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const TOUCH_INTERVAL_MS = 60000;

function fingerprint(value) {
  // Do not store the Plex/Jellyfin access token in IndexedDB keys.
  let a = 2166136261, b = 5381;
  for (let i = 0; i < value.length; i++) {
    a = Math.imul(a ^ value.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ value.charCodeAt(i);
  }
  return (a >>> 0).toString(16) + '-' + (b >>> 0).toString(16);
}
export function catalogScope(server) {
  if (!server) return '';
  return JSON.stringify([server.kind, server.id, server.url, server.userId || '',
    fingerprint(String(server.token || ''))]);
}

export class PersistentCatalogCache {
  constructor({indexedDB: factory, now = () => Date.now(),
    memoryBytes = CATALOG_MEMORY_BYTES, diskBytes = CATALOG_DISK_BYTES} = {}) {
    this.factory = factory === undefined
      ? (typeof indexedDB === 'undefined' ? null : indexedDB) : factory;
    this.now = now;
    this.memoryLimit = memoryBytes;
    this.diskLimit = diskBytes;
    this.dbPromise = null;
    this.memory = new Map();
    this.memoryBytes = 0;
    this.generations = new Map();
    this.writes = 0;
    this.pruning = null;
  }
  id(scope, key) { return scope + ':' + key; }
  async open() {
    if (!this.factory) return null;
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise(resolve => {
      let request;
      try { request = this.factory.open('plezy-catalog-v1', 1); }
      catch (_) { resolve(null); return; }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE))
          db.createObjectStore(STORE, {keyPath: 'key'});
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
    return this.dbPromise;
  }
  forget(key) {
    const entry = this.memory.get(key);
    if (entry) this.memoryBytes -= entry.bytes;
    this.memory.delete(key);
  }
  remember(key, data, bytes, priority = false, diskUsed = null) {
    if (!bytes) {
      try { bytes = JSON.stringify(data).length * 2; }
      catch (_) { return; }
    }
    const previous = this.memory.get(key);
    const protectedPage = priority || !!(previous && previous.priority);
    const lastDiskTouch = diskUsed === null
      ? previous ? previous.used : this.now() : diskUsed;
    this.forget(key);
    if (bytes > this.memoryLimit) return;
    this.memory.set(key, {data, bytes, priority: protectedPage, used:lastDiskTouch});
    this.memoryBytes += bytes;
    // Landing pages are compact but essential to instant reopening. Evict
    // scrolled-through pages first, regardless of how many pages exist.
    while (this.memoryBytes > this.memoryLimit) {
      const disposable = Array.from(this.memory).find(([, row]) => !row.priority);
      this.forget(disposable ? disposable[0] : this.memory.keys().next().value);
    }
  }
  async touch(key, priority) {
    const db = await this.open();
    if (!db) return;
    return new Promise(resolve => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const request = store.get(key);
        request.onsuccess = () => {
          const entry = request.result;
          if (!entry) return;
          if ((priority && !entry.priority) ||
              this.now() - entry.used >= TOUCH_INTERVAL_MS) {
            entry.used = this.now();
            entry.priority = priority || !!entry.priority;
            store.put(entry);
          }
        };
        tx.oncomplete = resolve; tx.onerror = resolve; tx.onabort = resolve;
      } catch (_) { resolve(); }
    });
  }
  async read(key, priority = false) {
    if (this.memory.has(key)) {
      const entry = this.memory.get(key);
      const shouldTouch = (priority && !entry.priority) ||
        this.now() - entry.used >= TOUCH_INTERVAL_MS;
      this.remember(key, entry.data, entry.bytes, priority);
      // Disk LRU must reflect navigation even when metadata hits RAM; a
      // stale disk timestamp otherwise evicts an actively used first page.
      if (shouldTouch) {
        const refreshed = this.memory.get(key);
        if (refreshed) refreshed.used = this.now();
        this.touch(key, priority).catch(() => {});
      }
      return entry.data;
    }
    const db = await this.open();
    if (!db) return null;
    return new Promise(resolve => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const request = store.get(key);
        request.onsuccess = () => {
          const entry = request.result;
          if (entry && entry.data !== undefined && entry.bytes <= MAX_ENTRY_BYTES) {
            const touch = (priority && !entry.priority) ||
              this.now() - entry.used >= TOUCH_INTERVAL_MS;
            if (touch) {
              entry.used = this.now();
              entry.priority = priority || !!entry.priority;
              store.put(entry);
            }
            this.remember(key, entry.data, entry.bytes,
              priority || !!entry.priority, entry.used);
            resolve(entry.data);
          } else resolve(null);
        };
        request.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  }
  async write(key, data, priority = false) {
    let bytes;
    try { bytes = JSON.stringify(data).length * 2; }
    catch (_) { return; }
    if (!bytes || bytes > MAX_ENTRY_BYTES) return;
    const db = await this.open();
    if (!db) return;
    const put = () => new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({key, data, bytes, used: this.now(), priority});
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      } catch (error) { reject(error); }
    });
    try {
      await put();
      if (++this.writes % 96 === 0) this.prune().catch(() => {});
    } catch (_) {
      // Some TVs have very small IDB quotas; cache failure must never
      // prevent the real network response or make the UI unusable.
      await this.prune(undefined, true);
      try { await put(); } catch (_) { /* Storage is optional. */ }
    }
  }
  async prune(maxBytes, quotaFailure = false) {
    if (this.pruning) await this.pruning;
    const budget = maxBytes === undefined
      ? await preferredDiskBudget(this.diskLimit, 0.15) : maxBytes;
    this.pruning = this.pruneRows(budget, quotaFailure).catch(() => {});
    try { await this.pruning; } finally { this.pruning = null; }
  }
  async pruneRows(maxBytes, quotaFailure = false) {
    const db = await this.open();
    if (!db) return;
    const entries = await new Promise(resolve => {
      const rows = [];
      try {
        const tx = db.transaction(STORE, 'readonly');
        const request = tx.objectStore(STORE).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) { resolve(rows); return; }
          rows.push({key: cursor.key, bytes: cursor.value.bytes || 0,
            used: cursor.value.used || 0, priority: !!cursor.value.priority});
          cursor.continue();
        };
        request.onerror = () => resolve([]);
        tx.onabort = () => resolve([]);
      } catch (_) { resolve([]); }
    });
    const total = entries.reduce((sum, e) => sum + e.bytes, 0);
    const budget = quotaFailure
      ? quotaRecoveryTarget(total, maxBytes, 2 * 1024 * 1024) : maxBytes;
    const remove = evictionsForBudget(entries, budget);
    if (!remove.length) return;
    await new Promise(resolve => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        remove.forEach(key => tx.objectStore(STORE).delete(key));
        tx.oncomplete = resolve; tx.onabort = resolve; tx.onerror = resolve;
      } catch (_) { resolve(); }
    });
    remove.forEach(key => this.forget(key));
  }
  // Start revalidation at the same time as disk lookup. Fresh responses only
  // replace a page when different; a failed request leaves the saved page.
  // Every open has a fresh task, even if the data is in memory.
  async page(scope, key, loader, {force = false, priority = false} = {}) {
    const id = this.id(scope, key);
    const serial = (this.generations.get(id) || 0) + 1;
    this.generations.set(id, serial);
    const requested = Promise.resolve().then(loader);
    // Observe a rejected request immediately, including while IndexedDB is
    // opening, so browsers do not report an unhandled rejection.
    const live = requested.then(value => ({value}), error => ({error}));
    const cached = force ? null : await this.read(id, priority);
    if (cached !== null && cached !== undefined) {
      const fresh = live.then(result => {
        if (result.error) return {error:result.error,changed:false};
        if (this.generations.get(id) !== serial)
          return {value:result.value,changed:false};
        const changed = JSON.stringify(cached) !== JSON.stringify(result.value);
        this.remember(id, result.value, undefined, priority);
        if (changed) this.write(id, result.value, priority).catch(() => {});
        return {value:result.value,changed};
      });
      return {value:cached, fresh, cached:true};
    }
    const result = await live;
    if (result.error) throw result.error;
    if (this.generations.get(id) === serial) {
      this.remember(id, result.value, undefined, priority);
      this.write(id, result.value, priority).catch(() => {});
    }
    return {value:result.value, fresh:null, cached:false};
  }
  // Account removal must not expose that user's saved titles to future logins.
  async removeScope(scope) {
    const prefix = scope + ':';
    for (const key of this.memory.keys())
      if (key.startsWith(prefix)) this.forget(key);
    for (const key of this.generations.keys())
      if (key.startsWith(prefix)) this.generations.set(key, this.generations.get(key) + 1);
    const db = await this.open();
    if (!db) return;
    await new Promise(resolve => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        const request = tx.objectStore(STORE).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          if (String(cursor.key).startsWith(prefix)) cursor.delete();
          cursor.continue();
        };
        tx.oncomplete = resolve; tx.onabort = resolve; tx.onerror = resolve;
      } catch (_) { resolve(); }
    });
  }
}
