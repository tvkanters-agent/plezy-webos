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
  let columns = 1, rowHeight = 1, loading = false, destroyed = false;
  let generation = 0, pending = null, scrollTimer = null, pinnedIndex = null;
  let previousScrollTop = main.scrollTop;
  let helper = alphaIndex(characters);
  let activeCheck = isActive;
  const alive = () => !destroyed && activeCheck() && grid.isConnected;
  const loadedEnd = () => rangeStart + items.length;
  const allCards = () => Array.from(grid.querySelectorAll('.card'));
  const paint = (data, mode) => {
    const fragment = document.createDocumentFragment();
    data.forEach(item => fragment.appendChild(card(item)));
    if (mode === 'append') grid.append(fragment);
    else if (mode === 'prepend') grid.insertBefore(fragment, grid.firstChild);
    else { grid.textContent = ''; grid.append(fragment); }
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
    const row = Math.floor(Math.max(0, main.scrollTop + inset - gridTop + 1) / rowHeight);
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
  async function jump(index, forcePage = false) {
    if (!alive()) return;
    const target = Math.max(0, Math.min(total - 1, index));
    if (!forcePage && target >= rangeStart && target < loadedEnd()) { position(target); return; }
    const id = ++generation;
    const start = alphaPageStart(target, columns, total);
    const count = Math.min(total - start, columns * Math.ceil(60 / columns));
    loading = true;
    retry.hidden = true;
    error.textContent = '';
    try {
      const page = await loader(start, count);
      if (!alive() || id !== generation) return;
      await prewarmPage(page.items);
      if (!alive() || id !== generation) return;
      rangeStart = start;
      items = page.items.slice();
      total = page.total;
      paint(items, 'replace');
      spacers();
      position(target);
    } catch (e) {
      if (alive() && id === generation) {
        error.textContent = 'Could not load library titles: ' + e.message;
        retry.hidden = false;
        pending = () => jump(target);
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
      await prewarmPage(page.items);
      if (!alive() || id !== generation) return;
      if (before) {
        items = page.items.concat(items);
        rangeStart = start;
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
    if (content.bottom < pane.bottom + pane.height * .8 && loadedEnd() < total)
      loadAdjacent('append');
    else if (content.top > pane.top - pane.height * .6 && rangeStart > 0)
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
    handleKey: code => rail.handleKey(code), focus: () => rail.focus(),
    updateCharacters(next) {
      if (!alive() || JSON.stringify(next) === JSON.stringify(characters)) return;
      const wasFocused = rail.isFocused();
      const previous = rail;
      helper = alphaIndex(next);
      rail = createAlphaJumpBar(next, railOptions);
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
      const previousCount = Math.min(page.items.length, items.length);
      items = page.items.length === previousCount
        ? page.items.concat(items.slice(previousCount)) : page.items.slice();
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
      rail.element.hidden = true;
    },
    resume(nextIsActive) {
      activeCheck = nextIsActive;
      rail.element.hidden = false;
      rail.draw();
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
