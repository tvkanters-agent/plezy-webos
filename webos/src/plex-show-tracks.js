// SPDX-License-Identifier: GPL-3.0-only
import {mediaSourceTracks} from './api.js';
import {findTrackForIntent} from './episode-track-preferences.js';

async function updateEpisode(api, show, episodeId, choices, current) {
  // A listing can omit non-default streams. Read every edition's actual
  // catalog before making a write that also affects other Plex clients.
  const response = await api.get('/library/metadata/' + encodeURIComponent(episodeId), {includeStreams:1});
  const raw = response.MediaContainer.Metadata?.[0];
  if (!raw || String(raw.ratingKey) !== episodeId) throw new Error('Missing episode catalog');
  if (raw.type !== 'episode' || (raw.grandparentRatingKey &&
      String(raw.grandparentRatingKey) !== show && String(raw.parentRatingKey) !== show)) return;
  for (const media of raw.Media || []) {
    for (const part of media.Part || []) {
      if (!current()) return;
      if (part.id == null || !Array.isArray(part.Stream)) throw new Error('Incomplete Plex part catalog');
      const catalog = mediaSourceTracks({raw:{Media:[{Part:[part]}]}});
      const selection = {};
      for (const kind of Object.keys(choices.pending)) {
        const origin = choices.pending[kind];
        const tracks = kind === 'audio' ? catalog.audio : catalog.subtitles;
        const exact = origin.itemId === episodeId && origin.partId === String(part.id)
          ? tracks.find(track => Number(track.id) === origin.id) : null;
        const match = exact || findTrackForIntent(tracks, choices[kind], kind);
        // Even a checked default may only be Plex's automatic choice. Commit
        // the explicit selection so other clients of this account see it.
        if (match && tracks.length) selection[kind + 'StreamID'] =
          kind === 'subtitle' && Number(match.id) === -1 ? 0 : match.id;
      }
      if (Object.keys(selection).length)
        await api.get('/library/parts/' + encodeURIComponent(part.id), {...selection, allParts:0},
          {method:'PUT', responseType:'none'});
    }
  }
}

// Native PlexClient._getGrandchildrenPage enumerates playable descendants.
// The requested show-wide write uses Plex's per-user, per-part selection API.
// Each part gets its own matched IDs, including across editions and seasons.
export async function savePlexShowTracks(api, show, choices, current) {
  let failures = 0;
  const seen = new Set();
  async function update(ids) {
    for (let i = 0; i < ids.length && current(); i += 3) {
      await Promise.all(ids.slice(i,i+3).map(async id => {
        try { await updateEpisode(api, show, id, choices, current); }
        catch (_) { ++failures; }
      }));
    }
  }
  // Prioritize the episodes on which the user actually made the choices.
  const origins = Object.values(choices.pending).map(origin => origin.itemId);
  origins.forEach(id => seen.add(id));
  await update(Array.from(seen));
  const pageStarts = new Set();
  for (let start = 0; current();) {
    const page = (await api.get('/library/metadata/' + encodeURIComponent(show) + '/grandchildren', {
      'X-Plex-Container-Start':start, 'X-Plex-Container-Size':60, excludeElements:'Media'
    })).MediaContainer;
    const rows = page.Metadata || [];
    if (start === 0 && !rows.length) throw new Error('Plex did not list the selected episode’s show');
    if (page.offset != null && Number(page.offset) !== start)
      throw new Error('Unexpected Plex episode page');
    if (rows.length && pageStarts.has(String(rows[0].ratingKey))) throw new Error('Repeated Plex episode page');
    if (rows.length) pageStarts.add(String(rows[0].ratingKey));
    const ids = [];
    for (const row of rows) {
      if (row.type !== 'episode' || row.ratingKey == null) continue;
      const id = String(row.ratingKey);
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
    await update(ids);
    start += rows.length;
    if (page.totalSize != null && start >= Number(page.totalSize)) break;
    if (!rows.length) {
      if (page.totalSize != null && start < Number(page.totalSize)) throw new Error('Incomplete Plex episode list');
      break;
    }
  }
  if (failures) throw new Error('Could not save all episode track selections');
}
