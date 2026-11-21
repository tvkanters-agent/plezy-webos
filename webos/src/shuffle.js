// SPDX-License-Identifier: GPL-3.0-only
// Shuffle from the detail page: Plex shows contain seasons, while seasons
// contain episodes. Jellyfin can also expose episodes directly under a show.
// Reservoir sampling keeps every playable episode equally likely without
// retaining the entire library in memory.
export async function shuffledEpisode(api, item, isCurrent = () => true, random = Math.random) {
  const parents = [{id:item.id, kind:item.type}];
  let chosen = null, episodeCount = 0;
  for (let index = 0; index < parents.length && isCurrent(); index++) {
    const parent = parents[index];
    for (let start = 0; isCurrent();) {
      const page = await api.children(parent.id, start, parent.kind);
      if (!isCurrent()) return null;
      for (const child of page.items) {
        const type = String(child.type).toLowerCase();
        if (type === 'season') parents.push({id:child.id, kind:child.type});
        else if (type === 'episode') {
          episodeCount++;
          if (random() * episodeCount < 1) chosen = child;
        }
      }
      if (!page.items.length) break;
      start += page.items.length;
      if (start >= page.total) break;
    }
  }
  return isCurrent() ? chosen : null;
}
