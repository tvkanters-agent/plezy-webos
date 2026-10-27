// SPDX-License-Identifier: GPL-3.0-only
// The webOS equivalent of LibraryBrowseTab's sparse paginated SliverGrid.
// Keep only a bounded window of cards: an alpha jump requests the real Plex
// cumulative offset without loading all titles before it.
import {alphaIndex, alphaPageStart, createAlphaJumpBar} from './alpha-bar.js';
import {fadeDelayedContent} from './content-entrance.js';

// Use the grid's decoration clearance, not the outer page/header padding.
// Shared by jump placement and D-pad reveal so focusing cannot move the row.
export function alphabetTopInset(grid) {
  return parseFloat(window.getComputedStyle(grid).paddingTop) || 0;
}

export function mountAlphabetLibrary({main, loader, firstPage, characters,
  card, schedulePosters, focusWithoutJump, isActive, startedAt = Date.now(),
  showRail = true,
  prewarmPage = async () => {}}) {
  const shell = document.querySelector('#shell');
  const topSpace = document.createElement('div');
  const bottomSpace = document.createElement('div');
  const grid = document.createElement('div');
  grid.className = 'grid alpha-window-grid';
  topSpace.className = bottomSpace.className = 'alpha-window-spacer';
  const error = document.createElement('p');
  error.className = 'error';
  error.setAttribute('role', 'alert');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'library-retry';
  retry.textContent = 'Retry loading';
  retry.hidden = true;
  fadeDelayedContent(grid, startedAt);
  main.append(topSpace, grid, bottomSpace, error, retry);
  let rangeStart = 0, items = firstPage.items.slice(), total = firstPage.total;
  let leadingPageLength = firstPage.items.length;
  let columns = 1, rowHeight = 1, loading = false, destroyed = false;
  let generation = 0, pending = null, scrollTimer = null, pinnedIndex = null;
  let previousScrollTop = main.scrollTop;
  let helper = alphaIndex(characters);
  let activeCheck = isActive;
  const alive = () => !destroyed && activeCheck() && grid.isConnected;
  const loadedEnd = () => rangeStart + items.length;
  const allCards = () => Array.from(grid.querySelectorAll('.card'));
  const makeCard = item => {
    const node = card(item);
    node._catalogSignature = JSON.stringify(item);
    return node;
  };
  const paint = (data, mode) => {
    if (mode === 'replace') {
      // Like the ordinary library paginator, reconcile server metadata without
      // re-creating unchanged images or dropping a focused title's DOM.
      const existing = new Map();
      Array.from(grid.children).forEach(node => {
        if (node.dataset.focus) existing.set(String(node.dataset.focus), node);
      });
      data.forEach((item, index) => {
        let node = existing.get(String(item.id));
        if (!node || node._catalogSignature !== JSON.stringify(item)) node = makeCard(item);
        if (grid.children[index] !== node)
          grid.insertBefore(node, grid.children[index] || null);
      });
      while (grid.children.length > data.length) grid.removeChild(grid.lastChild);
    } else {
      const fragment = document.createDocumentFragment();
      data.forEach(item => fragment.appendChild(makeCard(item)));
      if (mode === 'append') grid.append(fragment);
      else grid.insertBefore(fragment, grid.firstChild);
    }
    schedulePosters();
  };
  const measure = () => {
    const elements = allCards();
    if (!elements.length) return;
    const first = elements[0].getBoundingClientRect();
    // Like upstream's grid geometry, only the first row and the next row's
    // start determine columns/stride. Later rows cannot change either value.
    columns = 1;
    rowHeight = first.height + 26;
    for (let i = 1; i < elements.length; i++) {
      const top = elements[i].getBoundingClientRect().top;
      if (Math.abs(top - first.top) < 3) columns++;
      else if (top > first.top + 3) {
        rowHeight = top - first.top;
        break;
      }
    }
    rowHeight = Math.max(1, rowHeight);
  };
  const spacers = () => {
    const topRows = Math.floor(rangeStart / columns);
    const endRows = Math.ceil(loadedEnd() / columns);
    const totalRows = Math.ceil(total / columns);
    topSpace.style.height = (topRows * rowHeight) + 'px';
    bottomSpace.style.height = (Math.max(0, totalRows - endRows) * rowHeight) + 'px';
  };
  const firstVisibleIndex = () => {
    const inset = alphabetTopInset(grid);
    const gridTop = grid.offsetTop + inset;
    // A small epsilon avoids rounding a correctly aligned first row into the
    // preceding row if the browser's pixel snapping loses a fraction of a px.
    // Allow negative rows: the viewport can be in the leading spacer after
    // a fast reverse scroll. Clamp the absolute index, not the local row.
    const row = Math.floor((main.scrollTop + inset - gridTop + 1) / rowHeight);
    return Math.max(0, Math.min(total - 1, rangeStart + row * columns));
  };
  const focusGrid = () => {
    // Port of LibraryBrowseTab._navigateToGridNearScroll: select the LAST
    // item of the targeted first-visible row, not the first DOM node whose
    // bottom overlaps the viewport. A partially visible preceding row must
    // never hijack Left/Back from the alphabet rail.
    const index = pinnedIndex === null ? firstVisibleIndex() : pinnedIndex;
    const end = Math.min(total - 1, (Math.floor(index / columns) + 1) * columns - 1);
    const loaded = allCards();
    let target = loaded[end - rangeStart];
    if (!target) {
      const pane = main.getBoundingClientRect();
      const visible = loaded.filter(node => {
        const r = node.getBoundingClientRect();
        return r.top >= pane.top - 1 && r.top < pane.bottom;
      });
      const rowY = visible.length ? visible[0].getBoundingClientRect().top : null;
      const firstRow = visible.filter(node =>
        Math.abs(node.getBoundingClientRect().top - rowY) < 3);
      target = firstRow[firstRow.length - 1] || visible[0] || loaded[0];
    }
    if (target) focusWithoutJump(target, false);
  };
  const railOptions = {
    onJump(index) { jump(index); },
    onExit: focusGrid
  };
  let rail = createAlphaJumpBar(characters, railOptions);
  let railVisible = showRail;
  rail.element.hidden = !railVisible;
  shell.append(rail.element);
  paint(items, 'replace');
  measure();
  spacers();
  rail.draw();
  rail.update(helper.currentLetter(0));
  const position = index => {
    const row = Math.floor((index - rangeStart) / columns);
    // Keep only the grid's focus-decoration clearance above the target row.
    // Page padding includes header spacing and would expose the previous row.
    main.scrollTop = Math.max(0, grid.offsetTop + row * rowHeight);
    previousScrollTop = main.scrollTop;
    pinnedIndex = index; // Plezy pins a jump until the next user scroll.
    rail.update(helper.currentLetter(index));
    schedulePosters();
  };
  async function jump(index, forcePage = false, keepScroll = false) {
    if (!alive()) return;
    const target = Math.max(0, Math.min(total - 1, index));
    if (!forcePage && target >= rangeStart && target < loadedEnd()) { position(target); return; }
    const id = ++generation;
    const start = keepScroll ? Math.max(0, (Math.floor(target / columns) - 3) * columns) :
      alphaPageStart(target, columns, total);
    const count = Math.min(total - start, columns * Math.max(Math.ceil(60 / columns),
      Math.ceil(main.clientHeight / rowHeight) + 7));
    loading = true;
    retry.hidden = true;
    error.textContent = '';
    try {
      const page = await loader(start, count);
      if (!alive() || id !== generation) return;
      // Ordinary scrolling must display titles as soon as metadata arrives.
      // The visible-artwork queue hydrates their placeholders independently.
      if (!keepScroll) await prewarmPage(page.items, target - start, columns);
      if (!alive() || id !== generation) return;
      const scroll = main.scrollTop;
      rangeStart = start;
      items = page.items.slice();
      leadingPageLength = page.items.length;
      total = page.total;
      paint(items, 'replace');
      spacers();
      if (keepScroll) {
        main.scrollTop = scroll;
        updateLetter();
      } else position(target);
    } catch (e) {
      if (alive() && id === generation) {
        error.textContent = 'Could not load library titles: ' + e.message;
        retry.hidden = false;
        pending = () => jump(target, forcePage, keepScroll);
      }
    } finally {
      if (id === generation) {
        loading = false;
        requestAnimationFrame(check);
      }
    }
  }
  const truncate = direction => {
    if (items.length <= 360) return;
    const trim = Math.floor((items.length - 240) / columns) * columns;
    if (trim <= 0) return;
    if (direction === 'append') {
      // Never evict a focused card; scrolling will revisit it shortly.
      const selected = document.activeElement;
      const removed = allCards().slice(0, trim);
      if (removed.some(n => n === selected)) return;
      removed.forEach(n => n.remove());
      items.splice(0, trim);
      rangeStart += trim;
      leadingPageLength = Math.min(leadingPageLength, items.length);
    } else {
      const removed = allCards().slice(items.length - trim);
      if (removed.some(n => n === document.activeElement)) return;
      removed.forEach(n => n.remove());
      items.splice(items.length - trim, trim);
    }
  };
  async function loadAdjacent(direction) {
    if (!alive() || loading) return;
    const before = direction === 'prepend';
    if (before && rangeStart === 0 || !before && loadedEnd() >= total) return;
    const id = generation;
    const start = before ? Math.max(0, rangeStart - columns * Math.ceil(60 / columns)) : loadedEnd();
    const count = before ? rangeStart - start :
      Math.min(total - start, Math.ceil((start + 60) / columns) * columns - start);
    if (!count) return;
    loading = true;
    retry.hidden = true;
    error.textContent = '';
    try {
      const page = await loader(start, count);
      if (!alive() || id !== generation) return;
      if (before) {
        items = page.items.concat(items);
        rangeStart = start;
        leadingPageLength = page.items.length;
        paint(page.items, 'prepend');
      } else {
        items = items.concat(page.items);
        paint(page.items, 'append');
      }
      total = page.total;
      truncate(direction);
      spacers();
      schedulePosters();
    } catch (e) {
      if (alive() && id === generation) {
        error.textContent = 'Could not load library titles: ' + e.message;
        retry.hidden = false;
        pending = () => loadAdjacent(direction);
      }
    } finally {
      if (id === generation) {
        loading = false;
        requestAnimationFrame(check);
      }
    }
  }
  retry.addEventListener('click', () => {
    error.textContent = '';
    if (pending) pending();
  });
  const updateLetter = () => {
    if (!alive()) return;
    // Ignore our programmatic jump scroll, as in _hasJumpPin.
    if (pinnedIndex !== null) {
      if (Math.abs(main.scrollTop - previousScrollTop) < 3) return;
      pinnedIndex = null;
    }
    previousScrollTop = main.scrollTop;
    rail.update(helper.currentLetter(firstVisibleIndex()));
  };
  const check = () => {
    if (!alive() || loading || error.textContent) return;
    const pane = main.getBoundingClientRect(), content = grid.getBoundingClientRect();
    // Like ensureRangeLoaded upstream, request where the viewport actually is.
    // Walking adjacent pages through a spacer leaves a black screen for many
    // serial requests. Keep one request in flight and recheck its latest target.
    if (content.bottom < pane.top || content.top > pane.bottom) {
      const index = firstVisibleIndex();
      if (index < rangeStart || index >= loadedEnd()) {
        jump(index, true, true);
        return;
      }
    }
    const buffer = Math.max(pane.height, rowHeight * 3);
    if (content.bottom < pane.bottom + buffer && loadedEnd() < total)
      loadAdjacent('append');
    else if (content.top > pane.top - buffer && rangeStart > 0)
      loadAdjacent('prepend');
  };
  let lastAlphaUpdate = 0;
  const onScroll = () => {
    const now = Date.now();
    if (now - lastAlphaUpdate >= 20) { lastAlphaUpdate = now; updateLetter(); }
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => { updateLetter(); check(); }, 20);
    check();
  };
  main.addEventListener('scroll', onScroll);
  let listening = true;
  const resize = () => {
    if (!alive()) return;
    const index = firstVisibleIndex();
    const oldColumns = columns;
    measure();
    if (columns !== oldColumns) jump(index, true);
    else { spacers(); rail.draw(); }
  };
  window.addEventListener('resize', resize);
  requestAnimationFrame(check);
  return {
    get element() { return rail.element; },
    handleKey: code => railVisible && rail.handleKey(code),
    focus: () => { if (railVisible) rail.focus(); },
    setRailVisible(visible) {
      if (railVisible === !!visible) return;
      railVisible = !!visible;
      rail.element.hidden = !railVisible;
      // App navigation adjusts the content-pane padding in the same task.
      // Recompute columns after that style change; otherwise letter jumps
      // may use the old row stride when the async index finally arrives.
      requestAnimationFrame(() => {
        if (!alive()) return;
        resize();
        if (railVisible) {
          rail.draw();
          rail.update(helper.currentLetter(firstVisibleIndex()));
        }
      });
    },
    updateCharacters(next) {
      if (!alive() || JSON.stringify(next) === JSON.stringify(helper.letters.map(letter => ({title:letter,size:helper.sizes[letter]})))) {
        // Compare canonical bucket data rather than the initial parameter:
        // Plex may refresh this index more than once during a session.
        return;
      }
      const wasFocused = rail.isFocused();
      const previous = rail;
      helper = alphaIndex(next);
      rail = createAlphaJumpBar(next, railOptions);
      rail.element.hidden = !railVisible;
      shell.append(rail.element);
      previous.destroy();
      rail.draw();
      rail.update(helper.currentLetter(firstVisibleIndex()));
      if (wasFocused) rail.focus();
    },
    updateRange(offset, page) {
      if (!alive() || offset !== rangeStart) return;
      const oldFocus = grid.contains(document.activeElement) ?
        document.activeElement.dataset.focus : null;
      const scroll = main.scrollTop;
      // Only retain adjacent rows when the refreshed offset boundaries agree.
      const sameBoundary = leadingPageLength === page.items.length;
      items = sameBoundary ? page.items.concat(items.slice(leadingPageLength)) : page.items.slice();
      leadingPageLength = page.items.length;
      total = page.total;
      paint(items, 'replace');
      measure();
      spacers();
      main.scrollTop = scroll;
      rail.update(helper.currentLetter(firstVisibleIndex()));
      if (oldFocus) {
        const selected = allCards().find(node => node.dataset.focus === oldFocus);
        if (selected) focusWithoutJump(selected, false);
      }
      requestAnimationFrame(check);
    },
    suspend() {
      clearTimeout(scrollTimer);
      if (listening) {
        main.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', resize);
        listening = false;
      }
      rail.element.hidden = true;
    },
    resume(nextIsActive) {
      activeCheck = nextIsActive;
      if (!listening) {
        main.addEventListener('scroll', onScroll);
        window.addEventListener('resize', resize);
        listening = true;
      }
      rail.element.hidden = !railVisible;
      if (railVisible) rail.draw();
      updateLetter();
      requestAnimationFrame(check);
    },
    destroy() {
      destroyed = true;
      ++generation;
      clearTimeout(scrollTimer);
      main.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', resize);
      rail.destroy();
    }
  };
}
