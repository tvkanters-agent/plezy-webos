// SPDX-License-Identifier: GPL-3.0-only
import {trackLanguageName} from './languages.js';

// Source-catalog translation of TrackSelectionService's item-agnostic audio
// carry and SubtitlePreference.intent/off. IDs belong to one media part and
// must never be compared across episodes.
function episodeKey(item, mediaIndex) { return String(item.id) + ':' + mediaIndex; }
function seriesKey(item) {
  if (String(item?.type).toLowerCase() !== 'episode') return null;
  const raw = item.raw || {};
  const id = raw.grandparentRatingKey || raw.SeriesId || raw.parentRatingKey || raw.SeasonId;
  return id === undefined || id === null || id === '' ? null : String(id);
}
function seriesStorageKey(scope) { return 'plezy.webos.episodeTracks.' + scope; }
function clean(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function languageMatches(a, b) {
  if (!a || !b) return false;
  const left = a.toLowerCase().split(/[-_]/)[0];
  const right = b.toLowerCase().split(/[-_]/)[0];
  return left === right || trackLanguageName(left).toLowerCase() === trackLanguageName(right).toLowerCase();
}
function forced(track) {
  return !!track.forced || [track.title, track.displayTitle, track.extendedDisplayTitle]
    .some(value => /\bforced\b/i.test(value || ''));
}
function signsOnly(track) {
  const label = [track.title, track.displayTitle, track.extendedDisplayTitle].filter(Boolean).join(' ');
  return /\bsigns?\b/i.test(label) && !/\b(full|dialog(?:ue)?|complete)\b/i.test(label);
}
const codecs = {
  aac:['mp4a'], ac3:['a52','eac3','dolby digital'], eac3:['e-ac-3','ac3','dolby digital plus'],
  dts:['dca'], truehd:['mlp'], mp3:['mp3float'], vorbis:['ogg'],
  srt:['subrip'], subrip:['srt'], ass:['ssa'], ssa:['ass'], pgs:['hdmv_pgs_subtitle'],
  vobsub:['dvd_subtitle'], webvtt:['vtt'], vtt:['webvtt']
};
function codecMatches(a, b) {
  if (!a || !b) return false;
  const left = a.toLowerCase(), right = b.toLowerCase();
  return left === right || (codecs[left] || []).includes(right) || (codecs[right] || []).includes(left);
}
function titleScore(intent, candidate) {
  if (!intent) return 1;
  const title = intent.toLowerCase();
  return [candidate.title, candidate.displayTitle, candidate.extendedDisplayTitle].some(value =>
    value && value.toLowerCase().includes(title)) ? 3 : 0;
}
function intentFor(track, kind) {
  if (kind === 'subtitle' && Number(track.id) === -1) return {off:true};
  const intent = {language:clean(track.language), title:clean(track.title),
    displayTitle:clean(track.extendedDisplayTitle) || clean(track.displayTitle),
    codec:clean(track.codec), channels:track.channels ?? null};
  if (kind === 'subtitle') {
    intent.forced = forced(track);
    intent.signsOnly = track.signsOnly === true || signsOnly(track);
    intent.external = !!track.external;
  }
  // Plezy doesn't carry a metadata-free track across item boundaries.
  return intent.language || intent.title || intent.codec ? intent : null;
}
export function findTrackForIntent(tracks, intent, kind) {
  if (!intent) return null;
  if (kind === 'subtitle' && intent.off) return {id:-1};
  const display = clean(intent.displayTitle)?.toLowerCase();
  let best = null, bestKey = null, ambiguous = false;
  tracks.forEach(track => {
    if (kind === 'subtitle' && (forced(track) !== intent.forced ||
        !intent.forced && signsOnly(track) !== !!intent.signsOnly)) return;
    const language = !!(intent.language && track.language);
    const title = titleScore(intent.title, track);
    // The webOS picker shows the server's extended label even when no authored
    // title is present. Two English SRT rows can differ only in that label.
    const sameDisplay = !!display && [track.extendedDisplayTitle, track.displayTitle, track.title]
      .some(value => clean(value)?.toLowerCase() === display);
    if (language ? !languageMatches(intent.language, track.language) : title < 3) return;
    const key = [language ? 1 : 0, title, Number(sameDisplay), codecMatches(intent.codec, track.codec) ? 1 : 0,
      kind === 'audio' ? Number(intent.channels != null && intent.channels === track.channels) :
        Number(intent.external === !!track.external)];
    const comparison = !bestKey ? 1 : key.reduce((result, value, index) =>
      result || Math.sign(value - bestKey[index]), 0);
    if (comparison > 0) { best = track; bestKey = key; ambiguous = false; }
    else if (comparison === 0) ambiguous = true;
  });
  return ambiguous ? null : best;
}

export class EpisodeTrackPreferences {
  constructor(storage = null, scope = '') {
    this.exact = new Map();
    this.series = new Map();
    this.storage = scope ? storage : null;
    this.storageKey = seriesStorageKey(scope);
    try {
      const saved = JSON.parse(this.storage?.getItem(this.storageKey) || '[]');
      for (const [show, kinds] of saved) {
        if (typeof show !== 'string' || !kinds) continue;
        const carried = {};
        for (const kind of ['audio','subtitle']) {
          const intent = kinds[kind];
          if (intent && typeof intent === 'object')
            carried[kind] = kind === 'subtitle' && intent.off === true ? {off:true} :
              intentFor(intent, kind);
          const origin = kinds.pending?.[kind];
          if (origin && typeof origin.itemId === 'string' && typeof origin.partId === 'string' &&
              Number.isInteger(origin.id)) {
            if (!carried.pending) carried.pending = {};
            carried.pending[kind] = origin;
          }
        }
        this.series.set(show, carried);
      }
    } catch (_) { /* Malformed or unavailable storage cannot block playback. */ }
  }
  static removeScope(storage, scope) {
    try { storage?.removeItem(seriesStorageKey(scope)); } catch (_) {}
  }
  clear() {
    this.exact.clear();
    this.series.clear();
    try { this.storage?.removeItem(this.storageKey); } catch (_) {}
  }
  persist() {
    try { this.storage?.setItem(this.storageKey, JSON.stringify(Array.from(this.series))); }
    catch (_) { /* Keep this session's choices when TV storage is unavailable. */ }
  }
  record(item, mediaIndex, kind, track, saveOnPlex = false) {
    const key = episodeKey(item, mediaIndex), show = seriesKey(item);
    const previous = this.exact.get(key) || {show};
    // A newer show-level choice supersedes earlier sibling episode choices.
    if (show) this.exact.forEach((choice, otherKey) => {
      if (otherKey !== key && choice.show === show) delete choice[kind];
    });
    previous[kind] = Number(track.id);
    this.exact.set(key, previous);
    if (show) {
      const carried = {...this.series.get(show)};
      carried[kind] = intentFor(track, kind);
      const partId = item.raw.Media?.[mediaIndex]?.Part?.[0]?.id;
      if (saveOnPlex && partId != null)
        carried.pending = {...carried.pending, [kind]:{itemId:String(item.id), partId:String(partId), id:Number(track.id)}};
      this.series.set(show, carried);
      this.persist();
    }
  }
  // Serialize passes. A new choice replaces its snapshot; any in-flight PUTs
  // finish before the latest pass rechecks those episodes. Failed work stays
  // on disk for the next launch or explicit choice.
  async flush(saveShow, active, onFailure) {
    if (this.syncing) return;
    this.syncing = true;
    const failed = new Set();
    try {
      while (active()) {
        const entry = Array.from(this.series).find(([, choice]) => choice.pending && !failed.has(choice));
        if (!entry) break;
        const [show, choice] = entry;
        const current = () => active() && this.series.get(show) === choice;
        try { await saveShow(show, choice, current); }
        catch (_) {
          failed.add(choice);
          if (current()) onFailure();
          continue;
        }
        if (current()) { delete choice.pending; this.persist(); }
      }
    } finally { this.syncing = false; }
  }
  resolve(item, mediaIndex, tracks) {
    const exact = this.exact.get(episodeKey(item, mediaIndex)) || {};
    const carried = this.series.get(seriesKey(item)) || {};
    const result = {};
    for (const kind of ['audio', 'subtitle']) {
      const available = kind === 'audio' ? tracks.audio : tracks.subtitles;
      if (exact[kind] !== undefined &&
          (kind === 'subtitle' && exact[kind] === -1 ||
            available.some(track => Number(track.id) === exact[kind]))) {
        result[kind] = exact[kind];
      } else {
        const matched = findTrackForIntent(available, carried[kind], kind);
        if (matched) result[kind] = Number(matched.id);
      }
    }
    return result;
  }
}
