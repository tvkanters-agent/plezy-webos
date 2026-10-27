// SPDX-License-Identifier: GPL-3.0-only
// Plex stores collections per library. A movie and a TV collection with the
// same name are separate Plex IDs, but represent one collection to the viewer.
const nameKey = value => String(value || '').trim().toLocaleLowerCase();
const PAGE_SIZE = 60;

export async function matchingCollections(api, collection) {
  const name = nameKey(collection.title);
  if (!name) return [];
  let libraries;
  try { libraries = await api.libraries(); }
  catch (error) {
    console.warn('Could not look up collections in other libraries', error);
    return [];
  }
  const matches = libraries.map(() => []);
  // Limit parallel metadata requests on servers with many libraries. Keep
  // results in library order rather than the order requests happen to finish.
  let next = 0;
  await Promise.all(Array.from({length: Math.min(4, libraries.length)}, async () => {
    while (next < libraries.length) {
      const index = next++;
      const library = libraries[index];
      let start = 0;
      try {
        for (;;) {
          const page = await api.collections(library.id, start);
          for (const item of page.items) {
            if (nameKey(item.title) === name)
              matches[index].push({libraryId: String(library.id), item});
          }
          start += page.items.length;
          if (!page.items.length || start >= page.total) break;
        }
      } catch (error) {
        // A broken or inaccessible library must not hide the chosen collection.
        console.warn('Could not list collections in ' + library.title, error);
      }
    }
  }));
  const found = matches.reduce((all, items) => all.concat(items), []);
  const owner = String(collection.raw?.librarySectionID ||
    found.find(entry => entry.item.id === collection.id)?.libraryId || '');
  const ids = new Set([String(collection.id)]);
  return found.filter(({libraryId, item}) => {
    if ((owner && libraryId === owner) || ids.has(String(item.id))) return false;
    ids.add(String(item.id));
    return true;
  }).map(entry => entry.item);
}

// PaginatedItemLoader-style merge. Read one source at a time to retain each
// collection's own ordering; never eagerly fetch every child in large lists.
// The page buffer survives a failed request, so pressing Retry cannot omit
// titles already fetched but not yet rendered.
export function mergedCollectionLoader(api, collection) {
  let initialization, sources, sourceIndex = 0, emitted = 0;
  const pending = [], seen = new Set();
  async function initialize() {
    const matching = await matchingCollections(api, collection);
    sources = [collection, ...matching].map(item => ({id: item.id, start: 0}));
  }
  return async function load() {
    if (!initialization) initialization = initialize();
    await initialization;
    while (pending.length < PAGE_SIZE && sourceIndex < sources.length) {
      const source = sources[sourceIndex];
      let page;
      try { page = await api.children(source.id, source.start, 'collection'); }
      catch (error) {
        // Other-library collections may be deleted or lose access mid-browse.
        if (sourceIndex === 0) throw error;
        console.warn('Could not load matching collection ' + source.id, error);
        sourceIndex++;
        continue;
      }
      for (const item of page.items) {
        if (seen.has(String(item.id))) continue;
        seen.add(String(item.id));
        pending.push(item);
      }
      source.start += page.items.length;
      if (!page.items.length || source.start >= page.total) sourceIndex++;
    }
    const items = pending.splice(0, PAGE_SIZE);
    emitted += items.length;
    return {items, total: sourceIndex === sources.length && !pending.length
      ? emitted : Number.MAX_SAFE_INTEGER};
  };
}
