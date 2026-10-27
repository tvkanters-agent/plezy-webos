// SPDX-License-Identifier: GPL-3.0-only
// Short-lived, in-memory catalog results for fast TV rail navigation.
// Keep server artwork revisions in the returned metadata; images are still
// handled by ArtworkCache and never cached here.
export class CatalogCache {
  constructor({ttl = 45000, maxEntries = 32, now = () => Date.now()} = {}) {
    this.ttl = ttl;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
    this.pending = new Map();
    this.generation = 0;
  }
  clear() {
    ++this.generation;
    this.entries.clear();
    this.pending.clear();
  }
  get(key, loader) {
    const entry = this.entries.get(key);
    if (entry && entry.until > this.now()) {
      // Recent navigation retains its page without a new network round-trip.
      this.entries.delete(key);
      this.entries.set(key, entry);
      return Promise.resolve(entry.value);
    }
    if (entry) this.entries.delete(key);
    if (this.pending.has(key)) return this.pending.get(key);
    const generation = this.generation;
    const task = Promise.resolve().then(loader).then(value => {
      // A completed request must not repopulate a cache invalidated by
      // playback, a watched-state mutation, an explicit refresh or logout.
      if (generation === this.generation) {
        this.entries.delete(key);
        this.entries.set(key, {value, until: this.now() + this.ttl});
        while (this.entries.size > this.maxEntries)
          this.entries.delete(this.entries.keys().next().value);
      }
      return value;
    });
    this.pending.set(key, task);
    const finished = () => {
      if (this.pending.get(key) === task) this.pending.delete(key);
    };
    task.then(finished, finished);
    return task;
  }
}
