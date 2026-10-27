// SPDX-License-Identifier: GPL-3.0-only
// Bounded equivalent of the native library sliver's viewport + two rows.
// These cell strides match the 170px/20px grid and the TV artwork/card
// heights in app.css; overestimating slightly is harmless, decoding an entire
// saved catalog is not. No DOM measurement or forced reflow is needed.
export function artworkWindowCount(width, height, {landscape = false} = {}) {
  const viewportWidth = Math.max(1, Number(width) || 1);
  const viewportHeight = Math.max(1, Number(height) || 1);
  const rows = Math.ceil(viewportHeight / (landscape ? 120 : 330)) + 2;
  return landscape ? rows : Math.ceil(viewportWidth / 190) * rows;
}

export function shelfWindow(shelves, width, height) {
  // Each shelf is horizontally scrollable independently; only its leftmost
  // visible columns and the next two vertical shelves should decode at entry.
  const rows = Math.ceil(Math.max(1, Number(height) || 1) / 380) + 2;
  const columns = Math.ceil(Math.max(1, Number(width) || 1) / 202) + 1;
  const items = [];
  for (const shelf of shelves.slice(0, rows))
    items.push(...shelf.items.slice(0, columns));
  return items;
}
