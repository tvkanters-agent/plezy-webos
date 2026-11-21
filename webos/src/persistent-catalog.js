// SPDX-License-Identifier: GPL-3.0-only
// Offline-tolerant library snapshots. Return saved pages before the network
// finishes, then reconcile changed server data without blocking first paint.
// Home is deliberately excluded: its volatile CatalogCache starts empty.
import {diskPressure, evictionsForBudget, preferredDiskBudget, quotaRecoveryTarget} from './cache-budget.js';
const STORE = 'pages';
export const CATALOG_DISK_BYTES = 256 * 1024 * 1024;
export const CATALOG_MEMORY_BYTES = 16 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const TOUCH_INTERVAL_MS = 60000;

// A successor cache is valid only for the precise ordered IDs of its predecessor.
// Metadata-only changes do not invalidate it. Exact IDs avoid hash collisions.
function pageLineage(page) {
  // Reject successors from versions that did not verify the live boundary.
  return Array.isArray(page?.items) ? JSON.stringify([3, page.items.map(item => item.id)]) : null;
}

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
    // Same-page readers share the server request, even while IndexedDB opens.
    this.inflight = new Map();
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
  remember(key, data, bytes, priority = false, diskUsed = null, lineage = undefined) {
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
    this.memory.set(key, {data, bytes, priority: protectedPage, used:lastDiskTouch,
      lineage: lineage === undefined ? previous?.lineage : lineage});
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
              priority || !!entry.priority, entry.used, entry.lineage);
            resolve(entry.data);
          } else resolve(null);
        };
        request.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  }
  async write(key, data, priority = false, lineage = undefined) {
    let bytes;
    try { bytes = JSON.stringify(data).length * 2; }
    catch (_) { return; }
    if (!bytes || bytes > MAX_ENTRY_BYTES) return;
    const savedLineage = lineage === undefined ? this.memory.get(key)?.lineage : lineage;
    const db = await this.open();
    if (!db) return;
    const put = () => new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({key, data, bytes, used: this.now(), priority,
          lineage: savedLineage});
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      } catch (error) { reject(error); }
    });
    try {
      await put();
      if (++this.writes % 96 === 0) {
        diskPressure(1024 * 1024 * 1024).then(pressure => {
          if (pressure) this.prune().catch(() => {});
        }).catch(() => {});
      }
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
  async page(scope, key, loader, {force = false, priority = false,
    predecessor = null} = {}) {
    const id = this.id(scope, key);
    const predecessorId = predecessor && this.id(scope, predecessor.key);
    const lineage = predecessor ? pageLineage(predecessor.page) : undefined;
    // Coalesce only when callers are extending the same mounted ordering.
    // A forced refresh also supersedes an ordinary in-flight revalidation.
    let flight = this.inflight.get(id);
    if (!flight || flight.predecessorId !== predecessorId || flight.lineage !== lineage ||
        (force && !flight.force)) {
      const serial = (this.generations.get(id) || 0) + 1;
      this.generations.set(id, serial);
      const requested = Promise.resolve().then(loader);
      // Handle rejections immediately, including during a slow IDB open.
      const live = requested.then(value => ({value}), error => ({error}));
      flight = {serial, live, force, predecessorId, lineage};
      this.inflight.set(id, flight);
      const active = flight;
      live.then(() => {
        if (this.inflight.get(id) === active) this.inflight.delete(id);
      });
    }
    const {serial, live} = flight;
    const canSave = async () => {
      if (predecessorId && (lineage === null ||
          pageLineage(await this.read(predecessorId)) !== lineage)) return false;
      return this.generations.get(id) === serial;
    };
    const cached = force ? null : await this.read(id, priority);
    // Legacy successors without lineage cannot safely follow a refreshed
    // first page. A live error must leave that page unavailable, not mixed.
    if (cached !== null && cached !== undefined &&
        (!predecessorId || (lineage !== null && this.memory.get(id)?.lineage === lineage))) {
      const fresh = live.then(async result => {
        if (result.error) return {error:result.error,changed:false};
        if (!await canSave())
          return {value:result.value,changed:false};
        const changed = JSON.stringify(cached) !== JSON.stringify(result.value);
        this.remember(id, result.value, undefined, priority, null, lineage);
        if (changed) this.write(id, result.value, priority, lineage).catch(() => {});
        return {value:result.value,changed};
      });
      return {value:cached, fresh, cached:true};
    }
    const result = await live;
    if (result.error) throw result.error;
    if (await canSave()) {
      this.remember(id, result.value, undefined, priority, null, lineage);
      this.write(id, result.value, priority, lineage).catch(() => {});
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
    for (const key of this.inflight.keys())
      if (key.startsWith(prefix)) this.inflight.delete(key);
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
