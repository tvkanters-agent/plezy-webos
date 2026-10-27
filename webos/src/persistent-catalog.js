// SPDX-License-Identifier: GPL-3.0-only
// Offline-tolerant library snapshots. Return saved pages before the network
// finishes, then reconcile changed server data without blocking first paint.
// Home is deliberately excluded: its volatile CatalogCache starts empty.
const STORE = 'pages';
const MAX_DISK_BYTES = 20 * 1024 * 1024;
const MAX_DISK_ENTRIES = 120;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_MEMORY_ENTRIES = 40;
const MAX_MEMORY_BYTES = 10 * 1024 * 1024;

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
  constructor({indexedDB: factory, now = () => Date.now()} = {}) {
    this.factory = factory === undefined
      ? (typeof indexedDB === 'undefined' ? null : indexedDB) : factory;
    this.now = now;
    this.dbPromise = null;
    this.memory = new Map();
    this.memoryBytes = 0;
    this.inFlight = new Map();
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
  remember(key, data, bytes) {
    if (!bytes) {
      try { bytes = JSON.stringify(data).length * 2; }
      catch (_) { return; }
    }
    this.forget(key);
    if (bytes > MAX_MEMORY_BYTES) return;
    this.memory.set(key, {data, bytes});
    this.memoryBytes += bytes;
    while (this.memory.size > MAX_MEMORY_ENTRIES || this.memoryBytes > MAX_MEMORY_BYTES)
      this.forget(this.memory.keys().next().value);
  }
  async read(key) {
    if (this.memory.has(key)) {
      const entry = this.memory.get(key);
      this.remember(key, entry.data, entry.bytes);
      return entry.data;
    }
    const db = await this.open();
    if (!db) return null;
    return new Promise(resolve => {
      try {
        const tx = db.transaction(STORE, 'readonly');
        const request = tx.objectStore(STORE).get(key);
        request.onsuccess = () => {
          const entry = request.result;
          if (entry && entry.data !== undefined && entry.bytes <= MAX_ENTRY_BYTES) {
            this.remember(key, entry.data, entry.bytes);
            resolve(entry.data);
          } else resolve(null);
        };
        request.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  }
  async write(key, data) {
    let bytes;
    try { bytes = JSON.stringify(data).length * 2; }
    catch (_) { return; }
    if (!bytes || bytes > MAX_ENTRY_BYTES) return;
    const db = await this.open();
    if (!db) return;
    const put = () => new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({key, data, bytes, used: this.now()});
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      } catch (error) { reject(error); }
    });
    try {
      await put();
      if (++this.writes % 10 === 0) this.prune().catch(() => {});
    } catch (_) {
      // Some TVs have very small IDB quotas; cache failure must never
      // prevent the real network response or make the UI unusable.
      await this.prune(MAX_DISK_BYTES / 2, MAX_DISK_ENTRIES / 2);
      try { await put(); } catch (_) { /* Storage is optional. */ }
    }
  }
  async prune(maxBytes = MAX_DISK_BYTES, maxEntries = MAX_DISK_ENTRIES) {
    if (this.pruning) return this.pruning;
    this.pruning = this.pruneRows(maxBytes, maxEntries).catch(() => {});
    try { await this.pruning; } finally { this.pruning = null; }
  }
  async pruneRows(maxBytes, maxEntries) {
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
            used: cursor.value.used || 0});
          cursor.continue();
        };
        request.onerror = () => resolve([]);
        tx.onabort = () => resolve([]);
      } catch (_) { resolve([]); }
    });
    let total = entries.reduce((sum, e) => sum + e.bytes, 0);
    let count = entries.length;
    const remove = [];
    for (const row of entries.sort((a, b) => a.used - b.used)) {
      if (total <= maxBytes && count <= maxEntries) break;
      remove.push(row.key); total -= row.bytes; count--;
    }
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
  async page(scope, key, loader, {force = false} = {}) {
    const id = this.id(scope, key);
    const serial = (this.generations.get(id) || 0) + 1;
    this.generations.set(id, serial);
    const requested = Promise.resolve().then(loader);
    // Observe a rejected request immediately, including while IndexedDB is
    // opening, so browsers do not report an unhandled rejection.
    const live = requested.then(value => ({value}), error => ({error}));
    const cached = force ? null : await this.read(id);
    if (cached !== null && cached !== undefined) {
      const fresh = live.then(result => {
        if (result.error) return {error:result.error,changed:false};
        if (this.generations.get(id) !== serial)
          return {value:result.value,changed:false};
        const changed = JSON.stringify(cached) !== JSON.stringify(result.value);
        this.remember(id, result.value);
        if (changed) this.write(id, result.value).catch(() => {});
        return {value:result.value,changed};
      });
      return {value:cached, fresh, cached:true};
    }
    const result = await live;
    if (result.error) throw result.error;
    if (this.generations.get(id) === serial) {
      this.remember(id, result.value);
      this.write(id, result.value).catch(() => {});
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
