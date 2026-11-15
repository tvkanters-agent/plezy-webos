// Port of MediaChapter.indexAtPosition and seekTargetIndex in
// lib/media/media_source_info.dart. Positions are seconds on the full title.
export function chapterIndexAtPosition(position, chapters) {
  for (let i = 0; i < chapters.length; i++) {
    const start = chapters[i].start ?? 0;
    const end = chapters[i].end ?? chapters[i + 1]?.start ?? Infinity;
    if (position >= start && position < end) return i;
  }
  return -1;
}

export function chapterSeekTarget(position, chapters, forward) {
  if (!chapters.length) return null;
  if (forward) {
    const next = chapters.find(chapter => chapter.start > position);
    return next ? next.start : null;
  }
  // Plezy restarts the current chapter only after three seconds have passed.
  for (let i = chapters.length - 1; i >= 0; i--) {
    if (position > chapters[i].start + 3) return chapters[i].start;
  }
  // Plezy allows returning to the title's start from the first chapter.
  return position > .5 ? 0 : null;
}
