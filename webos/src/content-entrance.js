// SPDX-License-Identifier: GPL-3.0-only
// Only fade content when a frame actually passed without it. The previous
// fixed delay missed short-but-visible loading gaps on fast LG browsers.
// Artwork still has its own independent fade / decoded-cache lifecycle.
export const CONTENT_FADE_DELAY_MS = 120;

// Tracking the first paint avoids an arbitrary millisecond threshold: data
// available in the same rendering turn paints immediately, while data that
// arrives after an empty frame is softly introduced.
export function beginContentEntrance(schedule = callback => requestAnimationFrame(callback)) {
  const state = {blankFrame: false};
  schedule(() => { state.blankFrame = true; });
  return state;
}

export function fadeDelayedContent(node, startedAt, now = Date.now()) {
  const delayed = startedAt && typeof startedAt === 'object'
    ? startedAt.blankFrame
    : now - startedAt >= CONTENT_FADE_DELAY_MS;
  if (delayed) node.classList.add('content-enter');
  return node;
}
