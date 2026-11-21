// SPDX-License-Identifier: GPL-3.0-only

const BUFFER_ROWS = 2;

// Keep the complete library's scroll extent, but mount only full
// rows near the viewport, as Plezy's SliverGrid does.
export function libraryPageWindow({main, grid, paint, focus}) {
  const before = document.createElement('div');
  const after = document.createElement('div');
  before.className = after.className = 'paged-window-spacer';
  grid.classList.add('paged-window-grid');
  grid.parentNode.insertBefore(before, grid);
  grid.parentNode.insertBefore(after, grid.nextSibling);

  let items = [], first = 0, end = 0, frame = 0;
  let columns = 1, stride = 0, inset = 0, measuredWidth = 0;
  let listening = false, dirty = false;
  const row = index => Math.floor(index / columns);
  const top = () => main.scrollTop + before.getBoundingClientRect().top -
    main.getBoundingClientRect().top - main.clientTop + inset;
  const firstVisible = () => Math.floor((main.scrollTop - top()) / stride);
  const clampRow = value => Math.max(0, Math.min(value, row(items.length - 1)));
  const nodeAt = index => index >= first && index < end ? grid.children[index - first] : null;
  const find = id => items.findIndex(item => item.id === id);
  const indexOf = node => {
    const index = node._libraryWindowIndex;
    return nodeAt(index) === node ? index : -1;
  };

  function measure() {
    const card = grid.querySelector('.card');
    if (!card) return;
    const layout = getComputedStyle(grid);
    const number = key => parseFloat(layout[key]) || 0;
    const rect = card.getBoundingClientRect();
    measuredWidth = grid.clientWidth;
    inset = number('paddingTop');
    if (layout.display === 'grid') {
      columns = layout.gridTemplateColumns.trim().split(/\s+/).length;
      stride = rect.height + (number('rowGap') || number('gridRowGap'));
    } else {
      const style = getComputedStyle(card);
      const width = rect.width + (parseFloat(style.marginRight) || 0);
      const available = measuredWidth - number('paddingLeft') - number('paddingRight');
      columns = Math.max(1, Math.floor((available + .01) / width));
      stride = rect.height + (parseFloat(style.marginBottom) || 0);
    }
  }

  function update(scroll = main.scrollTop) {
    if (!listening || !grid.isConnected) return;
    if (items.length && !stride) {
      paint(items.slice(0, 1));
      measure();
    }
    if (!items.length || !stride) {
      if (dirty) {
        const hadFocus = grid.contains(document.activeElement);
        paint([]);
        if (hadFocus) focus(main, false);
      }
      before.style.height = after.style.height = '0px';
      first = end = 0;
      dirty = false;
      return;
    }
    const gridTop = top();
    const rawRow = Math.floor((scroll - gridTop) / stride);
    const startRow = clampRow(rawRow - BUFFER_ROWS);
    const endRow = clampRow(Math.floor((scroll + main.clientHeight - gridTop) / stride) + BUFFER_ROWS) + 1;
    const nextFirst = startRow * columns, nextEnd = Math.min(items.length, endRow * columns);
    if (!dirty && first === nextFirst && end === nextEnd && scroll === main.scrollTop) return;
    const active = grid.contains(document.activeElement) ? document.activeElement : null;
    const activeId = active?.dataset.focus;
    first = nextFirst;
    end = nextEnd;
    paint(items.slice(first, end));
    for (let i = first; i < end; i++) grid.children[i - first]._libraryWindowIndex = i;
    before.style.height = (startRow * stride) + 'px';
    after.style.height = ((Math.ceil(items.length / columns) - endRow) * stride) + 'px';
    if (main.scrollTop !== scroll) main.scrollTop = scroll;
    if (activeId && document.activeElement !== active) {
      const replacement = Array.from(grid.children).find(node => node.dataset.focus === activeId);
      focus(replacement || main, false);
    }
    dirty = false;
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (stride && grid.clientWidth !== measuredWidth) resize();
      else update();
    });
  }

  function resize() {
    if (!stride || !grid.isConnected || !items.length) return;
    const selectedIndex = indexOf(document.activeElement);
    const offset = main.scrollTop - top();
    const index = clampRow(firstVisible()) * columns;
    const oldStride = stride;
    measure();
    const scroll = offset < 0 ? main.scrollTop :
      Math.max(0, top() + row(index) * stride + Math.min(offset % oldStride, stride - 1));
    dirty = true;
    update(scroll);
    if (selectedIndex >= 0) focus(reveal(selectedIndex));
  }

  function reveal(index) {
    const target = nodeAt(index);
    if (target || index < 0 || index >= items.length || !stride) return target;
    update(Math.max(0, top() + row(index) * stride - 32));
    return nodeAt(index);
  }

  function visibleCard() {
    if (!stride) return null;
    update();
    return nodeAt(clampRow(firstVisible()) * columns);
  }

  return {
    replace(next) {
      const active = grid.contains(document.activeElement) ? document.activeElement : null;
      const activeId = active?.dataset.focus;
      const oldTop = stride ? top() : 0;
      const visibleRow = stride ? clampRow(firstVisible()) : 0;
      const anchorId = items[visibleRow * columns]?.id;
      items = next;
      const anchorIndex = anchorId === undefined ? -1 : find(anchorId);
      const scroll = anchorIndex < 0 || main.scrollTop < oldTop ? main.scrollTop :
        Math.max(0, main.scrollTop + (row(anchorIndex) - visibleRow) * stride);
      dirty = true;
      update(scroll);
      if (activeId && document.activeElement === main) {
        const target = reveal(find(activeId)) || visibleCard();
        if (target) focus(target, false);
      }
    },
    visibleCard,
    focusById(id) { return reveal(find(id)); },
    adjacentIndex(node, direction) {
      const index = indexOf(node);
      if (index < 0) return -1;
      if (direction === 'up') return index - columns;
      if (direction === 'down') return index + columns;
      if (direction === 'right' && row(index + 1) === row(index)) return index + 1;
      return -1;
    },
    has(index) { return index < items.length; },
    isMounted(index) { return !!nodeAt(index); },
    reveal,
    resume() {
      if (listening) return;
      listening = true;
      main.addEventListener('scroll', schedule);
      window.addEventListener('resize', resize);
      schedule();
    },
    suspend() {
      listening = false;
      main.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };
}
