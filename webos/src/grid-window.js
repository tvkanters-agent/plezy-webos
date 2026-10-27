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

// Across all live grids, keep only a small shared pool of detached image nodes.
// Inactive snapshots additionally discard their pool entries and excess rows.
// This avoids multiplying a 160-poster cache by every cached library tab.
const RECYCLED_CARD_BUDGET = 48;
const sharedCards = new Map(); // DOM card -> owning grid's cache Map

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
  let items = [], itemKeys = [], columns = 0, stride = 0, range = null;
  let live = true, listening = false, paginationCleanup = null;
  let gridOffset = 0, gridPadding = 0;
  let scrollAnchor = {firstItem:0, within:0, stride:1};
  const cached = new Map();
  const rect = node => node.getBoundingClientRect();
  function clearCached() {
    cached.forEach(node => sharedCards.delete(node));
    cached.clear();
  }
  function save(node) {
    const id = node._gridKey;
    if (id == null) return;
    const previous = cached.get(id);
    if (previous) sharedCards.delete(previous);
    cached.delete(id);
    cached.set(id,node);
    sharedCards.delete(node);
    sharedCards.set(node,cached);
    while (sharedCards.size > RECYCLED_CARD_BUDGET) {
      const oldest = sharedCards.keys().next().value;
      const owner = sharedCards.get(oldest);
      sharedCards.delete(oldest);
      if (owner.get(oldest._gridKey) === oldest) owner.delete(oldest._gridKey);
    }
  }
  function reactivateCard(node) {
    // onload's delayed opacity callback intentionally skips detached images.
    // When the exact card is recycled back, an already-decoded image must be
    // visible on that very frame (without a new load or another fade).
    const images = node.querySelectorAll('img.artwork-image');
    for (let i=0; i<images.length; i++) {
      const img = images[i];
      if (img.getAttribute('src') && img.complete && img.naturalWidth > 0)
        img.classList.add('artwork-loaded');
      else if (!img.getAttribute('src') && !img.hasAttribute('data-poster-src')) {
        const url = img.getAttribute('data-artwork-url');
        if (url) img.setAttribute('data-poster-src', url);
      }
    }
  }
  function paint(start, end) {
    const previous = new Map();
    Array.from(grid.children).forEach(node => {
      if (node._gridKey !== undefined) previous.set(node._gridKey, node);
    });
    const focused = grid.contains(document.activeElement) ? document.activeElement : null;
    const focusedColumn = focused ? focused._gridIndex % columns : 0;
    const desired = [];
    for (let index=start; index<end; index++) {
      // Offset pages can overlap when the server inserts a title while
      // pagination is running. Distinct positions must never share a DOM node.
      const item = items[index], key = itemKeys[index], signature = JSON.stringify(item);
      let node = previous.get(key);
      if (!node) node = cached.get(key);
      if (!node || node._catalogSignature !== signature) node = makeCard(item);
      const old = cached.get(key);
      if (old) sharedCards.delete(old);
      cached.delete(key);
      node._gridKey = key;
      node._gridIndex = index;
      reactivateCard(node);
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
  function resize(measured = null) {
    if (!live || !grid.isConnected || !items.length || !columns) return;
    // Use the last measured pre-resize anchor, not the browser's current
    // scrollTop: Chromium can apply scroll anchoring as CSS changes before
    // the resize event fires, producing an entire row of drift.
    const {firstItem,within,stride:previousStride} = scrollAnchor;
    // Measure with a temporarily complete first-row sample when our window
    // is near the end and responsive CSS changes the number of columns.
    ({columns,stride} = measured || measureGrid(grid));
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
  // Snapshot capture may follow a programmatic scroll in the same event turn,
  // before the scroll event has updated the last calculated row anchor.
  function captureAnchor() {
    if (!columns || !stride || !grid.isConnected) return;
    gridOffset = measureOffset();
    gridPadding = parseFloat(getComputedStyle(grid).paddingTop) || 0;
    const local = Math.max(0,main.scrollTop-gridOffset-gridPadding);
    const row = Math.floor(local/stride);
    scrollAnchor = {firstItem:row*columns, within:local-row*stride,stride};
  }
  // Suspended routes retain visible rows and one adjacent row on each side,
  // rather than dozens of overscan/decoded bitmap nodes per cached route.
  function compactMounted() {
    if (!items.length || !columns || !grid.isConnected) return;
    const row = Math.floor(scrollAnchor.firstItem/columns);
    const rows = Math.ceil(items.length/columns);
    const visible = Math.ceil(main.clientHeight/stride)+1;
    const focus = grid.contains(document.activeElement) ? document.activeElement : null;
    const focusedRow = focus ? Math.floor(focus._gridIndex/columns) : row;
    // Do not unmount an offscreen remembered focus and change scroll merely
    // to compact; this route will be restored to that focused item.
    if (focus && (focusedRow<row-1 || focusedRow>row+visible+1)) return;
    const startRow = Math.max(0,row-1);
    const endRow = Math.min(rows,row+visible+1);
    applyRange({start:startRow*columns,end:Math.min(items.length,endRow*columns),
      topRows:startRow,bottomRows:rows-endRow},true);
  }
  const onScroll = () => sync();
  // DOM events pass their Event as argument; never interpret it as a measured
  // {columns,stride} object on the resize path.
  const onResize = () => resize();
  function resume() {
    if (!live || listening) return;
    listening = true;
    main.addEventListener('scroll',onScroll);
    window.addEventListener('resize',onResize);
    if (grid.isConnected && items.length && columns) {
      const measured=measureGrid(grid);
      if (measured.columns !== columns || Math.abs(measured.stride-stride) > .5)
        resize(measured);
      else sync(true); // Preserve the exact restored scrollTop without resize.
    } else sync(true);
  }
  function suspend() {
    if (listening) {
      captureAnchor();
      listening = false;
      main.removeEventListener('scroll',onScroll);
      window.removeEventListener('resize',onResize);
      clearCached();
      compactMounted();
      // Compaction's removed buffered cards must not remain in the shared LRU
      // while this route is inactive. Its mounted nearby rows remain warm.
      clearCached();
    }
    if (paginationCleanup) paginationCleanup();
  }
  function focusNeighbor(current,direction) {
    if (!live || !grid.contains(current) || !Number.isInteger(current._gridIndex) ||
        (direction !== 'up' && direction !== 'down')) return false;
    // A Down from the actual last row belongs to the surrounding page
    // navigation/paginator, never to another card in this same row.
    if (direction === 'down' &&
        Math.floor(current._gridIndex / columns) >= Math.ceil(items.length / columns) - 1)
      return false;
    const targetIndex = current._gridIndex + (direction === 'down' ? columns : -columns);
    if (targetIndex < 0) return false;
    // A partial last row still follows the current row logically.
    const nextIndex=direction==='down' ? Math.min(targetIndex,items.length-1) : targetIndex;
    if (nextIndex >= items.length) return false;
    if (!range || nextIndex < range.start || nextIndex >= range.end) {
      const row = Math.floor(nextIndex/columns);
      applyRange(gridWindowRange(items.length,columns,Math.max(0,row-1),3),true);
    }
    const next = Array.from(grid.children).find(node=>node._gridIndex===nextIndex);
    if (!next) return false;
    focusWithoutJump(next);
    return true;
  }
  function captureLayoutAnchor() {
    if (!live || !listening || !grid.isConnected || !items.length || !columns)
      return null;
    const beforeOffset = measureOffset();
    const pane = rect(main), region = rect(top);
    // Preserve the filmography's place only when it occupies the viewport
    // or focus is inside it; when editing the header alone, let that control
    // remain visible rather than jumping down to the grid.
    const visible = region.top < pane.bottom &&
      rect(bottom).bottom > pane.top;
    if (!visible && !grid.contains(document.activeElement)) return null;
    return {beforeOffset, scrollTop:main.scrollTop};
  }
  function refreshLayout(anchor = null) {
    if (!live || !listening || !grid.isConnected) return;
    if (anchor) {
      const afterOffset = measureOffset();
      const newScroll = anchor.scrollTop + afterOffset - anchor.beforeOffset;
      if (Math.abs(main.scrollTop-anchor.scrollTop) < 2 ||
          Math.abs(main.scrollTop-newScroll) < 2)
        main.scrollTop = Math.max(0,newScroll);
    }
    sync(true);
  }
  resume();
  return {
    get columns() { return columns; },
    retainedCardStats() {
      return {mounted:grid.children.length,localCached:cached.size,
        globalCached:sharedCards.size,columns,
        visibleRows:Math.ceil(main.clientHeight/Math.max(1,stride))+1};
    },
    hasLaterRow(current) {
      return live && grid.contains(current) && Number.isInteger(current._gridIndex) &&
        current._gridIndex < (Math.ceil(items.length/Math.max(1,columns))-1)*columns;
    },
    captureLayoutAnchor,
    refreshLayout,
    get grid() { return grid; },
    focusNeighbor,
    setPaginationCleanup(fn) { paginationCleanup=fn; },
    setItems(nextItems) {
      // Preserve the title's identity across a fresh metadata page reorder.
      // The focused ID can move outside the mounted slice even when every
      // page still contains the same number of records.
      const focused = grid.contains(document.activeElement) ? document.activeElement : null;
      const oldIndex = focused && Number.isInteger(focused._gridIndex) ?
        focused._gridIndex : -1;
      const focusedId = oldIndex >= 0 ? focused.dataset.focus : null;
      const focusedKey = oldIndex >= 0 ? focused._gridKey : null;
      const counts = new Map();
      const nextKeys = nextItems.map(item => {
        const id=String(item.id), occurrence=counts.get(id) || 0;
        counts.set(id,occurrence+1);
        return JSON.stringify([id,occurrence]);
      });
      // Preserve which occurrence was focused if overlapping pages contain
      // the same server ID. Other cases still fall back to the stable ID.
      const newIndex = focusedKey == null ?
        (focusedId == null ? -1 :
          nextItems.findIndex(item => String(item.id) === focusedId)) :
        nextKeys.indexOf(focusedKey);
      const nextScroll = oldIndex >= 0 && newIndex >= 0 && columns ?
        Math.max(0,main.scrollTop +
          (Math.floor(newIndex/columns)-Math.floor(oldIndex/columns))*stride) : null;
      items=nextItems;
      itemKeys=nextKeys;
      if (!items.length) {
        grid.textContent='';
        top.style.height=bottom.style.height='0px';
        range=null;clearCached();
        return;
      }
      if (nextScroll != null) main.scrollTop=nextScroll;
      sync(true);
      if (newIndex >= 0) {
        // Scroll anchoring or a focused node replaced due to metadata changes
        // must not redirect the remote to another title.
        let target = Array.from(grid.children).find(node => node._gridIndex === newIndex);
        if (!target && columns) {
          const row = Math.floor(newIndex/columns);
          applyRange(gridWindowRange(items.length,columns,Math.max(0,row-1),3),true);
          target = Array.from(grid.children).find(node => node._gridIndex === newIndex);
        }
        if (target) {
          focusWithoutJump(target,false);
          if (nextScroll != null) main.scrollTop=nextScroll;
        }
      }
    },
    suspend,resume,
    destroy() { suspend(); live=false; items=[]; clearCached(); }
  };
}
