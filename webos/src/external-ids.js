// SPDX-License-Identifier: GPL-3.0-only
// Catalog IDs from upstream ExternalIds.fromGuids/fromLegacyPlexGuid.
export function plexExternalIds(raw) {
  const ids = {};
  const guids = Array.isArray(raw?.Guid) ? raw.Guid : [];
  for (const entry of guids) {
    const match = /^(imdb|tmdb|tvdb):\/\/([^/?#]+)/i.exec(entry?.id || '');
    if (!match) continue;
    const key = match[1].toLowerCase(), value = match[2];
    if (key === 'imdb' && /^tt\d+$/i.test(value)) ids.imdb = value;
    else if ((key === 'tmdb' || key === 'tvdb') && /^\d+$/.test(value)) ids[key] = Number(value);
  }
  // Exact browser translation of ExternalIds.fromLegacyPlexGuid and
  // ExternalIds.fillFrom in lib/utils/external_ids.dart. A Plex legacy GUID
  // uses a *com.plexapp.agents.* scheme, not the modern imdb:// form.
  const legacy = /^([a-z.]+):\/\/([^/?#]+)(?:\?[^#]*)?$/i.exec(raw?.guid || '');
  if (legacy) {
    const scheme = legacy[1].toLowerCase(), value = legacy[2].toLowerCase();
    let key = '', normalized = '';
    if (scheme === 'com.plexapp.agents.imdb') {
      key = 'imdb'; normalized = /^tt\d+$/.test(value) ? value : '';
    } else if (scheme === 'com.plexapp.agents.themoviedb' && /^\d+$/.test(value)) {
      key = 'tmdb'; normalized = Number(value);
    } else if (scheme === 'com.plexapp.agents.thetvdb' && /^\d+$/.test(value)) {
      key = 'tvdb'; normalized = Number(value);
    } else if (scheme === 'com.plexapp.agents.hama') {
      const pair = /^(imdb|tmdb|tsdb|tvdb[2-9]?)-((?:tt)?\d+)$/.exec(value);
      if (pair) {
        const source = pair[1], id = pair[2];
        if (source === 'imdb' && /^(?:tt)?\d+$/.test(id)) {
          key = 'imdb'; normalized = id.startsWith('tt') ? id : 'tt' + id;
        } else if (source === 'tmdb' || source === 'tsdb') {
          if (/^\d+$/.test(id)) { key = 'tmdb'; normalized = Number(id); }
        } else if (/^tvdb[2-9]?$/.test(source) && /^\d+$/.test(id)) {
          key = 'tvdb'; normalized = Number(id);
        }
      }
    }
    if (key && normalized && !ids[key]) ids[key] = normalized;
  }
  return ids;
}
