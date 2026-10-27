// SPDX-License-Identifier: GPL-3.0-only
// Port of MediaMarker, PlaybackExtras.withChapterFallback and
// jellyfinPlaybackExtrasFromRaw / jellyfinMediaSegmentsToMarkers.
export const DEFAULT_INTRO_PATTERN = String.raw`(?:^|\b)(?:intro(?:duction)?|opening)(?:\b|$)|^op(?:\s?\d+)?$`;
export const DEFAULT_CREDITS_PATTERN = String.raw`(?:^|\b)(?:outro|credits?|ending)(?:\b|$)|^ed(?:\s?\d+)?$`;

function pattern(source, fallback) {
  try { return new RegExp(source && source.trim() ? source : fallback, 'i'); }
  catch (_) { return new RegExp(fallback, 'i'); }
}
function valid(value) {
  return value !== null && value !== undefined && value !== '' &&
    Number.isFinite(Number(value)) && Number(value) >= 0;
}
function markerType(value, intro, credits) {
  if (intro.test(value)) return 'intro';
  if (credits.test(value)) return 'credits';
  return null;
}
export function withChapterFallback(chapters, markers, settings = {}) {
  const intro = pattern(settings.introPattern, DEFAULT_INTRO_PATTERN);
  const credits = pattern(settings.creditsPattern, DEFAULT_CREDITS_PATTERN);
  // Upstream uses the furthest chapter offset, not a synthetic guess from
  // the movie length, to reject false-positive opening "Credits" chapters.
  const runtime = chapters.reduce((end, c) => Math.max(end, c.end ?? c.start), 0);
  const synthetic = [];
  chapters.forEach((chapter, index) => {
    if (!chapter.title) return;
    const type = markerType(chapter.title, intro, credits);
    const end = chapter.end ?? chapters[index + 1]?.start;
    if (!type || !valid(chapter.start) || !valid(end) || end <= chapter.start) return;
    if (type === 'intro' && end - chapter.start > 180) return;
    if (type === 'credits' && chapter.start < runtime * .75) return;
    synthetic.push({type, start: chapter.start, end});
  });
  const native = markers.filter(m => m && valid(m.start) && valid(m.end) && m.end > m.start)
    .map(m => ({...m, type: m.type === 'intro' || m.type === 'credits' ? m.type
      : markerType(String(m.type || ''), intro, credits) || m.type}));
  if (!native.length) return synthetic;
  if (!synthetic.length) return native;
  const syntheticTypes = new Set(synthetic.map(m => m.type));
  const nativeTypes = new Set(native.map(m => m.type));
  const merged = settings.forceSkipMarkerFallback
    ? native.filter(m => !syntheticTypes.has(m.type)).concat(synthetic)
    : native.concat(synthetic.filter(m => !nativeTypes.has(m.type)));
  return merged.sort((a, b) => a.start - b.start);
}
export function plexPlaybackNavigation(raw, settings = {}) {
  const duration = Number(raw.duration) / 1000;
  const chapters = (Array.isArray(raw.Chapter) ? raw.Chapter : [])
    .filter(c => c && valid(c.startTimeOffset))
    .map((c, i) => ({start: Number(c.startTimeOffset) / 1000,
      end: valid(c.endTimeOffset) ? Number(c.endTimeOffset) / 1000 : null,
      title: c.title || 'Chapter ' + (i + 1)}))
    .filter(c => !duration || c.start < duration).sort((a, b) => a.start - b.start);
  const markers = (Array.isArray(raw.Marker) ? raw.Marker : [])
    .filter(m => m && valid(m.startTimeOffset) && valid(m.endTimeOffset))
    .map(m => ({type: m.type, start: Number(m.startTimeOffset) / 1000,
      end: Math.min(Number(m.endTimeOffset) / 1000, duration || Infinity)}));
  return {chapters: chapters.map(c => ({start: c.start, title: c.title})),
    markers: withChapterFallback(chapters, markers, settings)
      .filter(m => ['intro','credits'].includes(m.type)).sort((a, b) => a.start - b.start)};
}
export function jellyfinPlaybackNavigation(raw, segments = [], settings = {}) {
  raw = raw || {};
  const duration = valid(raw.RunTimeTicks) ? Number(raw.RunTimeTicks) / 10000000 : 0;
  const chapters = (Array.isArray(raw.Chapters) ? raw.Chapters : [])
    .filter(c => c && valid(c.StartPositionTicks))
    .map((c, i) => ({start: Number(c.StartPositionTicks) / 10000000,
      title: c.Name || 'Chapter ' + (i + 1)}));
  chapters.forEach((c, i) => { c.end = chapters[i + 1]?.start ?? (duration > c.start ? duration : null); });
  const items = Array.isArray(segments) ? segments : (Array.isArray(segments?.Items) ? segments.Items : []);
  const markers = items.filter(s => s && valid(s.StartTicks) && valid(s.EndTicks))
    .map(s => ({type: String(s.Type || '').toLowerCase(), start: Number(s.StartTicks) / 10000000,
      end: Number(s.EndTicks) / 10000000}))
    .filter(m => ['intro', 'outro', 'credits'].includes(m.type))
    .map(m => ({...m, type: m.type === 'outro' ? 'credits' : m.type}));
  return {chapters: chapters.map(c => ({start: c.start, title: c.title})),
    markers: withChapterFallback(chapters, markers, settings)};
}
