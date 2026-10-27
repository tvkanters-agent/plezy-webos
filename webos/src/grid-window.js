// SPDX-License-Identifier: GPL-3.0-only
// Viewport-bounded DOM for paginated media grids. The catalog remains cached;
// only card elements outside the viewport and a small focus buffer are removed.
export function gridWindowRange(count, columns, firstRow, visibleRows, previous = null) {
  const width = Math.max(1, columns);
  const rows = Math.ceil(count / width);
  const visibleStart = Math.max(0, Math.min(rows, firstRow));
  const visibleEnd = Math.min(rows, visibleStart + Math.max(1, visibleRows));
  // A one-page library is cheaper and safer to leave completely mounted.
  if (count <= Math.max(80, width * (visibleRows + 8)))
    return {start:0, end:count, topRows:0, bottomRows:0};
  // Two spare rows on each edge permit D-pad movement without a DOM update.
  if (previous && visibleStart >= previous.start / width + 2 &&
      visibleEnd <= Math.ceil(previous.end / width) - 2)
    return {...previous, bottomRows:rows - Math.ceil(previous.end / width)};
  const startRow = Math.max(0, visibleStart - 4);
  const endRow = Math.min(rows, visibleEnd + 4);
  return {start:startRow * width, end:Math.min(count, endRow * width),
    topRows:startRow, bottomRows:rows-endRow};
}

export function measureGrid(grid) {
  const children = grid.children;
  if (!children.length) return {columns:1, stride:330};
  const first = children[0].getBoundingClientRect();
  let columns = 1;
  let stride = first.height + (parseFloat(getComputedStyle(children[0]).marginBottom) || 26);
  for (let i=1; i<children.length; i++) {
    const y = children[i].getBoundingClientRect().top;
    if (Math.abs(y - first.top) < 3) columns++;
    else {stride = y - first.top; break;}
  }
  return {columns, stride:Math.max(1, stride)};
}

export function createGridWindow({main, grid, makeCard, focusWithoutJump, schedulePosters}) {
  const top = document.createElement('div');
  const bottom = document.createElement('div');
  top.className = bottom.className = 'grid-window-spacer';
  main.insertBefore(top, grid);
  main.insertBefore(bottom, grid.nextSibling);
  let items = [], columns = 0, stride = 0, range = null;
  let live = true, listening = false;
  function paint(start, end) {
    const previous = new Map();
    Array.from(grid.children).forEach(node => previous.set(String(node.dataset.focus), node));
    const focused = grid.contains(document.activeElement) ? document.activeElement : null;
    // Do not unmount an active focus node without transferring focus out of it.
    // This can happen after a large Magic Remote wheel scroll.
    if (focused && (focused._gridIndex < start || focused._gridIndex >= end)) {
      main.tabIndex = -1;
      focusWithoutJump(main, false);
    }
    const desired = [];
    for (let index=start; index<end; index++) {
      const item = items[index], signature = JSON.stringify(item);
      let node = previous.get(String(item.id));
      if (!node || node._catalogSignature !== signature) node = makeCard(item);
      node._gridIndex = index;
      desired.push(node);
    }
    const retained = new Set(desired);
    // Remove only cards outside the window or genuinely changed. In
    // particular, never detach a focused card merely to reorder its siblings.
    Array.from(grid.children).forEach(node => {
      if (!retained.has(node)) grid.removeChild(node);
    });
    desired.forEach((node, index) => {
      if (grid.children[index] !== node)
        grid.insertBefore(node, grid.children[index] || null);
    });
    if (focused && !grid.contains(focused)) {
      // Wheel scrolling can move well beyond the old focused card. Keep the
      // focus zone usable instead of leaving focus on the browser body.
      const pane = main.getBoundingClientRect();
      const visible = desired.find(node => {
        const rect = node.getBoundingClientRect();
        return rect.bottom > pane.top && rect.top < pane.bottom;
      });
      if (visible) focusWithoutJump(visible, false);
    }
    schedulePosters();
  }
  function sync(force = false) {
    if (!live || !grid.isConnected || !items.length) return;
    if (!columns) {
      paint(0, Math.min(items.length, 80));
      ({columns, stride} = measureGrid(grid));
    }
    const pane = main.getBoundingClientRect();
    const origin = top.getBoundingClientRect().top;
    const pad = parseFloat(getComputedStyle(grid).paddingTop) || 0;
    const viewTop = Math.max(0, pane.top - origin - pad);
    const firstRow = Math.floor(viewTop / stride);
    const visibleRows = Math.ceil((main.clientHeight + (viewTop % stride)) / stride) + 1;
    const next = gridWindowRange(items.length, columns, firstRow, visibleRows,
      force ? null : range);
    if (force || !range || range.start !== next.start || range.end !== next.end ||
        range.topRows !== next.topRows || range.bottomRows !== next.bottomRows) {
      paint(next.start, next.end);
      top.style.height = next.topRows * stride + 'px';
      bottom.style.height = next.bottomRows * stride + 'px';
    }
    range = next;
  }
  function resize() {
    if (!live || !grid.isConnected || !items.length) return;
    // Preserve the first visible *item* rather than a pixel offset when the
    // number of columns changes. Measure only the first two rows.
    const oldColumns = columns, oldStride = stride;
    const origin = top.getBoundingClientRect().top;
    const viewTop = Math.max(0, main.getBoundingClientRect().top - origin);
    const firstItem = Math.floor(viewTop / oldStride) * oldColumns;
    ({columns, stride} = measureGrid(grid));
    if (columns !== oldColumns) {
      main.scrollTop += Math.floor(firstItem / columns) * stride -
        Math.floor(firstItem / oldColumns) * oldStride;
    }
    sync(true);
  }
  const onScroll = () => sync();
  function resume() {
    if (listening) return;
    listening = true;
    main.addEventListener('scroll', onScroll);
    window.addEventListener('resize', resize);
    sync(true);
  }
  function suspend() {
    if (!listening) return;
    listening = false;
    main.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', resize);
  }
  resume();
  return {
    setItems(nextItems) {
      items = nextItems;
      if (!items.length) {
        grid.textContent = '';
        top.style.height = bottom.style.height = '0px';
        range = null;
        return;
      }
      sync(true);
    },
    suspend, resume,
    destroy() { suspend(); live = false; items = []; }
  };
}
