// SPDX-License-Identifier: GPL-3.0-only
// DOM windowing for ordinary, uniform-height paginated card grids. The full
// catalog remains in memory/disk; recycled cards are retained in a bounded
// LRU so a nearby return keeps decoded artwork, handlers and transition state.
export function gridWindowRange(count, columns, firstRow, visibleRows, previous = null) {
  const width = Math.max(1, columns);
  const rows = Math.ceil(count / width);
  const visibleStart = Math.max(0, Math.min(rows, firstRow));
  const visibleEnd = Math.min(rows, visibleStart + Math.max(1, visibleRows));
  if (count <= Math.max(80, width * (visibleRows + 8)))
    return {start:0, end:count, topRows:0, bottomRows:0};
  if (previous && !(previous.end < count && previous.end % width !== 0) &&
      visibleStart >= previous.start / width + 2 &&
      visibleEnd <= Math.ceil(previous.end / width) - 2)
    return {...previous, bottomRows:rows - Math.ceil(previous.end / width)};
  const startRow = Math.max(0, visibleStart - 4);
  const endRow = Math.min(rows, visibleEnd + 4);
  return {start:startRow * width, end:Math.min(count, endRow * width),
    topRows:startRow, bottomRows:rows-endRow};
}

// One synchronous measurement (about two rows), compatible with CSS Grid and
// the Chromium 53 flexbox fallback. Card subtitles have a reserved line in CSS.
export function measureGrid(grid) {
  const children = grid.children;
  if (!children.length) return {columns:1, stride:330};
  const first = children[0].getBoundingClientRect();
  let columns = 1;
  const style = getComputedStyle(children[0]);
  const gridStyle = getComputedStyle(grid);
  let stride = first.height + (parseFloat(style.marginBottom) ||
    parseFloat(gridStyle.rowGap) || 26);
  for (let i=1; i<children.length; i++) {
    const y = children[i].getBoundingClientRect().top;
    if (Math.abs(y-first.top) < 3) columns++;
    else { stride = y-first.top; break; }
  }
  return {columns, stride:Math.max(1,stride)};
}

export function createGridWindow({main, grid, makeCard, focusWithoutJump, schedulePosters}) {
  const top = document.createElement('div'), bottom = document.createElement('div');
  top.className = bottom.className = 'grid-window-spacer';
  main.insertBefore(top, grid);
  main.insertBefore(bottom, grid.nextSibling);
  let items = [], columns = 0, stride = 0, range = null;
  let live = true, listening = false, paginationCleanup = null;
  let gridOffset = 0, gridPadding = 0;
  let scrollAnchor = {firstItem:0, within:0, stride:1};
  const cached = new Map(), CACHE_LIMIT = 160;
  const rect = node => node.getBoundingClientRect();

  function save(node) {
    const id = node.dataset.focus;
    if (!id) return;
    cached.delete(id);
    cached.set(id, node);
    while (cached.size > CACHE_LIMIT) cached.delete(cached.keys().next().value);
  }
  function paint(start, end) {
    const previous = new Map();
    Array.from(grid.children).forEach(node => {
      if (node.dataset.focus !== undefined) previous.set(node.dataset.focus, node);
    });
    const focused = grid.contains(document.activeElement) ? document.activeElement : null;
    const focusedColumn = focused ? focused._gridIndex % columns : 0;
    const desired = [];
    for (let index=start; index<end; index++) {
      const item = items[index], id = String(item.id), signature = JSON.stringify(item);
      let node = previous.get(id);
      if (!node) node = cached.get(id);
      if (!node || node._catalogSignature !== signature) node = makeCard(item);
      cached.delete(id);
      node._gridIndex = index;
      desired.push(node);
    }
    const retained = new Set(desired);
    // Moving focus off a card that is about to be detached avoids the browser
    // sending focus to the document body (or scrolling while reparenting).
    if (focused && !retained.has(focused)) {
      main.tabIndex = -1;
      focusWithoutJump(main, false);
    }
    Array.from(grid.children).forEach(node => {
      if (!retained.has(node)) { grid.removeChild(node); save(node); }
    });
    desired.forEach((node,index) => {
      if (grid.children[index] !== node)
        grid.insertBefore(node, grid.children[index] || null);
    });
    if (focused && !retained.has(focused)) {
      // Spacer geometry is already updated; choose the closest visible card
      // in the same column, not a buffered row above the viewport.
      const pane = rect(main);
      const visible = desired.filter(node => {
        const box = rect(node);
        return box.bottom > pane.top + 2 && box.top < pane.bottom - 2;
      });
      const replacement = visible.find(node => node._gridIndex % columns === focusedColumn) ||
        visible[0] || desired[Math.min(desired.length-1, Math.max(0,focusedColumn))];
      if (replacement) {
        // Even when the wheel stops past the final row/sentinel, never leave
        // focus on an invisible card or a focusless <main>.
        focusWithoutJump(replacement, !visible.length);
      }
    }
    schedulePosters();
  }
  function measureOffset() {
    return main.scrollTop + rect(top).top - rect(main).top;
  }
  function applyRange(next, force = false) {
    if (force || !range || range.start !== next.start || range.end !== next.end ||
        range.topRows !== next.topRows || range.bottomRows !== next.bottomRows) {
      // Set top BEFORE mounting/focus recovery; reading geometry with stale
      // spacers can otherwise strand focus on <main> after a wheel jump.
      top.style.height = next.topRows * stride + 'px';
      bottom.style.height = next.bottomRows * stride + 'px';
      paint(next.start,next.end);
    }
    range = next;
  }
  function show(firstRow, force = false) {
    const visibleRows = Math.ceil((main.clientHeight + Math.max(0,
      main.scrollTop - gridOffset - gridPadding - firstRow*stride) % stride) / stride) + 1;
    applyRange(gridWindowRange(items.length,columns,firstRow,visibleRows,
      force ? null : range),force);
  }
  function sync(force = false) {
    if (!live || !grid.isConnected || !items.length) return;
    if (!columns) {
      paint(0, Math.min(items.length,80));
      ({columns,stride} = measureGrid(grid));
    }
    gridOffset = measureOffset();
    gridPadding = parseFloat(getComputedStyle(grid).paddingTop) || 0;
    const local = Math.max(0,main.scrollTop-gridOffset-gridPadding);
    const row = Math.floor(local/stride);
    scrollAnchor = {firstItem:row*columns, within:local-row*stride, stride};
    show(row,force);
  }
  function resize() {
    if (!live || !grid.isConnected || !items.length || !columns) return;
    // Use the last measured pre-resize anchor, not the browser's current
    // scrollTop: Chromium can apply scroll anchoring as CSS changes before
    // the resize event fires, producing an entire row of drift.
    const {firstItem,within,stride:previousStride} = scrollAnchor;
    // Measure with a temporarily complete first-row sample when our window
    // is near the end and responsive CSS changes the number of columns.
    ({columns,stride} = measureGrid(grid));
    gridPadding = parseFloat(getComputedStyle(grid).paddingTop) || 0;
    gridOffset = measureOffset();
    const newRow = Math.floor(firstItem/columns);
    const target = gridOffset + gridPadding + newRow*stride +
      Math.min(within / previousStride * stride,stride-1);
    // Apply correct new spacer sizes before scrolling to the anchor row.
    show(newRow,true);
    main.scrollTop = Math.max(0,target);
    sync();
  }
  const onScroll = () => sync();
  function resume() {
    if (!live || listening) return;
    listening = true;
    main.addEventListener('scroll',onScroll);
    window.addEventListener('resize',resize);
    sync(true);
  }
  function suspend() {
    if (listening) {
      listening = false;
      main.removeEventListener('scroll',onScroll);
      window.removeEventListener('resize',resize);
    }
    if (paginationCleanup) paginationCleanup();
  }
  function focusNeighbor(current,direction) {
    if (!live || !grid.contains(current) || !Number.isInteger(current._gridIndex) ||
        (direction !== 'up' && direction !== 'down')) return false;
    const targetIndex = current._gridIndex + (direction === 'down' ? columns : -columns);
    if (targetIndex < 0 || targetIndex >= items.length) return false;
    if (!range || targetIndex < range.start || targetIndex >= range.end) {
      const row = Math.floor(targetIndex/columns);
      applyRange(gridWindowRange(items.length,columns,Math.max(0,row-1),3),true);
    }
    const next = Array.from(grid.children).find(node=>node._gridIndex===targetIndex);
    if (!next) return false;
    focusWithoutJump(next);
    return true;
  }
  resume();
  return {
    get columns() { return columns; },
    get grid() { return grid; },
    focusNeighbor,
    setPaginationCleanup(fn) { paginationCleanup=fn; },
    setItems(nextItems) {
      items=nextItems;
      if (!items.length) {
        grid.textContent='';
        top.style.height=bottom.style.height='0px';
        range=null;cached.clear();
        return;
      }
      sync(true);
    },
    suspend,resume,
    destroy() { suspend(); live=false; items=[]; cached.clear(); }
  };
}
