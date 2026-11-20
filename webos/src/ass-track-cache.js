// SPDX-License-Identifier: GPL-3.0-only
// Keep completed ASS tracks separately from the font blobs. Reopening the
// same Plex part should not repeat its MKV index and cue-range requests.
const DATABASE = 'plezy-ass-tracks-v1';
const MEMORY_LIMIT = 64 * 1024 * 1024;
// Fansub ASS scripts can be 10–15 MB, especially with vector-drawn signs.
const MAX_TRACK = 32 * 1024 * 1024;

// v1.22.0 could save a complete ASS script without its embedded fonts.
// Those records must be re-extracted instead of permanently reusing fallback glyphs.
export function reusableAssTrack(track) {
  return !!track && track.fontsVerified === true &&
    typeof track.script === 'string' && track.script.length > 0 &&
    track.script.length * 2 <= MAX_TRACK &&
    Array.isArray(track.fonts) && track.fonts.length > 0 &&
    track.fonts.every(font => typeof font.name === 'string' && font.name.length > 0 &&
      Number.isSafeInteger(font.length) && font.length > 0);
}

export class AssTrackCache {
  constructor(factory = typeof indexedDB === 'undefined' ? null : indexedDB) {
    this.factory = factory;
    this.memory = new Map();
    this.bytes = 0;
    this.dbPromise = null;
  }

  remember(key, track) {
    const size = track.script.length * 2;
    if (size > MAX_TRACK) return;
    if (this.memory.has(key)) this.bytes -= this.memory.get(key).script.length * 2;
    this.memory.delete(key);
    this.memory.set(key, track);
    this.bytes += size;
    while (this.bytes > MEMORY_LIMIT && this.memory.size > 1) {
      const oldest = this.memory.keys().next().value;
      this.bytes -= this.memory.get(oldest).script.length * 2;
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
      request.onupgradeneeded = () => request.result.createObjectStore('tracks', {keyPath:'key'});
      request.onsuccess = () => resolve(request.result);
      request.onerror = request.onblocked = () => resolve(null);
    });
    return this.dbPromise;
  }

  async get(key) {
    const memory = this.memory.get(key);
    if (reusableAssTrack(memory)) { this.remember(key, memory); return memory; }
    const db = await this.open();
    if (!db) return null;
    return new Promise(resolve => {
      try {
        const request = db.transaction('tracks', 'readonly').objectStore('tracks').get(key);
        request.onsuccess = () => {
          const found = request.result;
          if (!reusableAssTrack(found)) { resolve(null); return; }
          this.remember(key, found);
          resolve(found);
        };
        request.onerror = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  }

  put(key, script, fonts) {
    if (!key || script.length * 2 > MAX_TRACK) return;
    const track = {key,script,fonts,fontsVerified:true,used:Date.now()};
    // Never cache a fontless track: missing attachments must be retryable.
    if (!reusableAssTrack(track)) return;
    this.remember(key,track);
    this.persist(track).catch(() => {});
  }

  async persist(track) {
    const db = await this.open();
    if (!db) return;
    const write = () => new Promise(resolve => {
      try {
        const tx = db.transaction('tracks','readwrite');
        tx.objectStore('tracks').put(track);
        tx.oncomplete = () => resolve(true);
        tx.onerror = tx.onabort = () => resolve(false);
      } catch (_) { resolve(false); }
    });
    if (await write()) return;
    // Do not evict Plex artwork or attached fonts when disk space is tight.
    await new Promise(resolve => {
      try {
        const tx = db.transaction('tracks','readwrite');
        const store = tx.objectStore('tracks');
        const entries = [];
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (current) { entries.push({key:current.key,used:current.value.used || 0});current.continue(); }
          else {
            entries.sort((a,b)=>a.used-b.used);
            for (const entry of entries.slice(0,Math.max(1,Math.ceil(entries.length/3)))) store.delete(entry.key);
          }
        };
        tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
      } catch (_) { resolve(); }
    });
    await write();
  }
}

export const assTrackCache = new AssTrackCache();
