// SPDX-License-Identifier: GPL-3.0-only
// A shared, account-scoped index of Plex collection listings. Merged collection
// details look up names locally instead of walking every library on each open.
// Persist only collection IDs/titles/library names, not full media metadata.
const PAGE_SIZE = 60;
const REFRESH_AFTER_MS = 5 * 60 * 1000;
const RETRY_AFTER_MS = 30 * 1000;

export class CollectionIndex {
  constructor({catalog = null, now = () => Date.now(), ttl = REFRESH_AFTER_MS} = {}) {
    this.catalog = catalog;
    this.now = now;
    this.ttl = ttl;
    this.byClient = new WeakMap();
  }
  clear() { this.byClient = new WeakMap(); }
  state(api, scope) {
    let state = this.byClient.get(api);
    if (!state || state.scope !== scope) {
      state = {scope, data:null, initializing:null, refreshing:null, retryAt:0};
      this.byClient.set(api, state);
    }
    return state;
  }
  async entries(api, scope = '') {
    const state = this.state(api, scope);
    if (state.data) {
      if (this.now() - state.data.checkedAt >= this.ttl &&
          this.now() >= state.retryAt) this.refresh(api, state).catch(() => {});
      return state.data;
    }
    if (!state.initializing) {
      const task = (async () => {
        const key = this.catalog && scope
          ? this.catalog.id(scope, 'collection-discovery-index') : null;
        const saved = key ? await this.catalog.read(key, true) : null;
        if (saved && Array.isArray(saved.libraries) && Array.isArray(saved.rows)) {
          state.data = saved;
          if (this.now() - (saved.checkedAt || 0) >= this.ttl)
            this.refresh(api, state).catch(() => {});
          return saved;
        }
        return this.refresh(api, state);
      })();
      state.initializing = task;
      const finish = () => { if (state.initializing === task) state.initializing = null; };
      task.then(finish, finish);
    }
    return state.initializing;
  }
  refresh(api, state) {
    if (state.refreshing) return state.refreshing;
    const task = (async () => {
      const libraries = await api.libraries();
      const rows = [];
      let next = 0, failed = false;
      // Match the bounded four-library discovery fan-out used previously.
      await Promise.all(Array.from({length:Math.min(4,libraries.length)}, async () => {
        while (next < libraries.length) {
          const library = libraries[next++];
          try {
            let start = 0;
            for (;;) {
              const page = await api.collections(library.id, start);
              for (const item of page.items) rows.push({
                id:item.id, title:item.title, libraryId:String(library.id),
                libraryTitle:library.title || 'Titles'
              });
              start += page.items.length;
              if (!page.items.length || start >= page.total) break;
            }
          } catch (error) {
            failed = true;
            console.warn('Could not list collections in ' + library.title, error);
          }
        }
      }));
      if (failed && state.data) {
        state.retryAt = this.now() + RETRY_AFTER_MS;
        return state.data; // Never erase known matches on a partial failure.
      }
      const result = {libraries:libraries.map(library => ({
        id:library.id, title:library.title || 'Titles'
      })), rows, checkedAt:this.now()};
      if (this.byClient.get(api) === state) {
        state.data = result;
        state.retryAt = failed ? this.now() + RETRY_AFTER_MS : 0;
        if (!failed && this.catalog && state.scope) {
          const key = this.catalog.id(state.scope, 'collection-discovery-index');
          this.catalog.write(key, result, true).catch(() => {});
        }
      }
      return result;
    })();
    state.refreshing = task;
    const finish = () => {
      if (state.refreshing === task) state.refreshing = null;
    };
    task.then(finish, () => {
      state.retryAt = this.now() + RETRY_AFTER_MS;
      finish();
    });
    return task;
  }
}
