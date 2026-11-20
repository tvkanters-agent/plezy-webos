// SPDX-License-Identifier: GPL-3.0-only
// A completed, cached MKV ASS script can be several megabytes of vector signs.
// Parse only the events relevant to the opening playback position before
// appending the remaining events to the same libass track.
function timestamp(value) {
  const m = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(value);
  return m ? ((+m[1] * 60 + +m[2]) * 60 + +m[3]) + +m[4] / 100 : NaN;
}

export function assStartupPreview(script, position, lookahead = 8) {
  if (typeof script !== 'string' || script.length < 1) return null;
  // Only the canonical, packet-normalized [Events] format emitted by our
  // Matroska extractor is eligible. External ASS may reorder event fields.
  const section = /(?:^|\n)\[Events\]\r?\nFormat: (?:Layer|Marked), Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r?\n/i.exec(script);
  if (!section) return null;
  const from = section.index + section[0].length;
  const head = script.slice(0, from);
  const lines = script.slice(from).split(/\r?\n/);
  const near = [];
  const fallback = [];
  let nearest = Infinity;
  let total = 0;
  for (const line of lines) {
    if (!line) continue;
    if (!line.startsWith('Dialogue: ')) return null;
    const match = /^Dialogue: [^,]*,(\d+:\d{2}:\d{2}\.\d{2}),(\d+:\d{2}:\d{2}\.\d{2}),/.exec(line);
    if (!match) return null;
    const start = timestamp(match[1]);
    const end = timestamp(match[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    total++;
    if (start <= position + lookahead && end >= position - 0.1) near.push(line);
    const distance = position < start ? start - position : position > end ? position - end : 0;
    if (distance < nearest) { nearest = distance; fallback.length = 0; fallback.push(line); }
    else if (distance === nearest) fallback.push(line);
  }
  if (total < 2) return null;
  const selected = near.length ? near : fallback;
  if (!selected.length || selected.length === total) return null;
  // Preserve original line/ReadOrder for layered signs. Sorting by cue time
  // would change ASS layering and sign animation.
  return head + selected.join('\n') + '\n';
}
