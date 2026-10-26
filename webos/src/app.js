import './compat.js';
// SPDX-License-Identifier: GPL-3.0-only
import {VERSION, baseUrl, id, readState, saveState, nextFocus, time} from './core.js';
import {client, Jellyfin, Plex, plexPin, pollPlexPin, plexServers} from './api.js';
import {Player} from './player.js';
import {SimklTracker, validSession, beginSimklLink, pollSimklLink} from './simkl.js';
const main = document.querySelector('#main'), nav = document.querySelector('#nav'), dialog = document.querySelector('#dialog');
// Accessing localStorage itself may throw in a restricted webOS app context.
function tvStorage() {
  try { return window.localStorage; } catch (_) { return null; }
}
let state = readState(tvStorage()), api, route = {type: 'home'}, history = [], revision = 0, authAbort, toastTimer;
const simklTracker = new SimklTracker(() => state.simkl, session => {
  state.simkl = session; persist();
}, message => notify(message));
const player = new Player(document.querySelector('#player'), notify, () => render(), simklTracker);
function el(tag, text, className) {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text;
  if (className) node.className = className; return node;
}
function button(text, action, className = '') {
  const node = el('button', text, className); node.type = 'button';
  node.addEventListener('click', () => {
    // Remember the activated control even when Magic Remote/pointer clicks do
    // not leave it as document.activeElement by the time navigation executes.
    focusWithoutJump(node, false);
    Promise.resolve().then(action).catch(error => notify(error.message));
  }); return node;
}
function notify(message) {
  const toast = document.querySelector('#toast'); toast.textContent = message; toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
}
function persist() {
  try {
    const storage = tvStorage();
    if (!storage) throw new Error('Storage unavailable');
    saveState(storage, state);
  } catch (_) { notify('TV storage is unavailable. Settings will last only until the app closes.'); }
}
function activeServer() { return state.servers.find(s => s.id === state.active) || state.servers[0]; }
let libraryCache = null, libraryCacheFor = null, libraryLoading = false;
function setClient() {
  const server = activeServer();
  api = server ? client(server, state.deviceId) : null;
  libraryCache = null; libraryCacheFor = null; libraryLoading = false;
}
function addServer(server) {
  state.servers = state.servers.filter(s => s.id !== server.id).concat(server);
  state.active = server.id; persist(); setClient(); history = []; go({type: 'home'}, false);
}
// The upstream Flutter D-pad navigator keeps the current scroll offset until
// an item actually leaves the visible content viewport. Chromium's native
// focus/scrollIntoView otherwise pins every grid row near the top.
function focusWithoutJump(target, reveal = true) {
  if (!target) return;
  const row = target.closest && target.closest('.cards');
  const vertical = main.contains(target) ? main : null;
  const previousTop = vertical ? vertical.scrollTop : 0;
  const previousLeft = row ? row.scrollLeft : 0;
  let dy = 0, dx = 0;
  if (reveal) {
    const item = target.getBoundingClientRect();
    if (vertical) {
      const view = vertical.getBoundingClientRect(), pad = 32;
      if (item.top < view.top + pad) dy = item.top - view.top - pad;
      else if (item.bottom > view.bottom - pad) dy = item.bottom - view.bottom + pad;
    }
    if (row) {
      const view = row.getBoundingClientRect(), pad = 12;
      if (item.left < view.left + pad) dx = item.left - view.left - pad;
      else if (item.right > view.right - pad) dx = item.right - view.right + pad;
    }
  }
  target.focus();
  if (vertical) vertical.scrollTop = Math.max(0, previousTop + dy);
  if (row) row.scrollLeft = Math.max(0, previousLeft + dx);
  schedulePosters();
}
function focusFirst(root = main) {
  const expectedRevision = revision;
  requestAnimationFrame(() => {
    if (expectedRevision !== revision || !root.isConnected) return;
    // Plex/Jellyfin home content may finish asynchronously after the user
    // already moved from the page into the navigation rail. Do not steal
    // their active remote focus when an earlier render finally completes.
    const active = document.activeElement;
    if (root === main && active && active !== document.body &&
        active !== main && !main.contains(active)) return;
    focusWithoutJump(root.querySelector('button:not(:disabled),input,select') || root);
  });
}
// Translation of media_detail/action_buttons.dart FilledButton and
// IconButton.filledTonal; use SVG so icons work without webOS font installs.
function detailButton(label, action, symbol, className = '') {
  const control = button(label, action, className);
  control.setAttribute('aria-label', label);
  control.setAttribute('title', label);
  const paths = {
    play:'M8 5v14l11-7z',
    restart:'M12 5a7 7 0 1 1-7 7H2l4 4 4-4H7a5 5 0 1 0 5-5z',
    watched:'M9 12l2 2 4-4M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20z',
    more:'M5 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z M19 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z',
    sort:'M3 5h18v2H3z M3 11h12v2H3z M3 17h6v2H3z',
    filter:'M3 4h18l-7 8v6l-4 2v-8L3 4z',
    version:'M5 9l7 7 7-7',
    next:'M5 4v16l12-8zm13 0h2v16h-2z',
    shuffle:'M3 7h3l12 10h3M17 14l4 3-4 3M3 17h3l4-4m4-4 4-4h3m-4-3 4 3-4 3'
  };
  if (symbol && paths[symbol]) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('aria-hidden','true');
    const path = document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('d',paths[symbol]); path.setAttribute('fill','currentColor');
    svg.appendChild(path); control.insertBefore(svg,control.firstChild);
  }
  return control;
}
function title(text, subtitle) {
  main.append(el('h1', text));
  if (subtitle) main.append(el('p', subtitle, 'intro'));
}
// The upstream Plezy navigation rail uses Material Symbols with leading
// icons and a soft pill indicator. Bundle equivalent basic vector icons so
// the Chromium 53 TV does not depend on external icon fonts or CDNs.
function railButton(label, action, className, iconName) {
  const symbols = {
    home: 'M12 2 2 11h3v10h6v-6h2v6h6V11h3L12 2z',
    libraries: 'M4 5h16v3H4zm0 6h16v3H4zm0 6h16v3H4z',
    search: 'M10.5 3a7.5 7.5 0 0 0 0 15c1.7 0 3.2-.6 4.4-1.5l4.6 4.5 1.5-1.5-4.5-4.6A7.5 7.5 0 0 0 10.5 3zm0 3a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z',
    settings: 'M19.14 12.94a7.8 7.8 0 0 0 0-1.88l2.02-1.58-2-3.46-2.43.97a7.6 7.6 0 0 0-1.63-.94L14.72 3h-4l-.38 3.05a7.6 7.6 0 0 0-1.63.94l-2.43-.97-2 3.46 2.02 1.58a7.8 7.8 0 0 0 0 1.88l-2.02 1.58 2 3.46 2.43-.97c.5.39 1.05.7 1.63.94l.38 3.05h4l.38-3.05c.58-.24 1.13-.55 1.63-.94l2.43.97 2-3.46-2.02-1.58z M12.72 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z'
  };
  const control = button(label, action, className);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', symbols[iconName]);
  shape.setAttribute('fill', 'currentColor');
  svg.appendChild(shape);
  control.insertBefore(svg, control.firstChild);
  return control;
}
function navigation() {
  document.querySelector('aside').classList.toggle('collapsed', state.sidebarCollapsed);
  // Plezy's Flutter side rail lists the connected server's libraries inline.
  // Fetch once per server, then keep this list as navigation moves between pages.
  const focused = document.activeElement?.dataset?.navId;
  nav.textContent = '';
  if (api) {
    const home = railButton('Home', () => go({type: 'home'}), route.type === 'home' ? 'active' : '', 'home');
    home.dataset.navId = 'home'; nav.append(home);
    const libraryHeader = el('div', 'Libraries', 'rail-library-header');
    // Heading only: the individual libraries are the actual destinations.
    // Library visibility is controlled from Settings.
    nav.append(libraryHeader);
    if (!state.librariesHidden) {
      const section = el('div', undefined, 'rail-library-items');
      const libraries = libraryCacheFor === api ? libraryCache : null;
      if (libraries) libraries.filter(library => !state.hiddenLibraryIds.includes(
        activeServer().id + ':' + library.id)).forEach(library => {
        const active = route.type === 'library' && String(route.library.id) === String(library.id);
        const control = button(library.title, () => go({type:'library', library}),
          active ? 'active' : '');
        control.dataset.navId = 'library:' + library.id;
        section.append(control);
      });
      else section.append(el('p', 'Loading libraries…', 'muted'));
      nav.append(section);
    }
    if (libraryCacheFor !== api && !libraryLoading) {
      const currentApi = api;
      libraryLoading = true;
      currentApi.libraries().then(libraries => {
        if (currentApi !== api) return;
        libraryCacheFor = currentApi; libraryCache = libraries; libraryLoading = false;
        navigation();
        if (route.type === 'settings') render();
      }).catch(() => { if (currentApi === api) libraryLoading = false; });
    }
    const searchLink = railButton('Search', () => go({type:'search'}), route.type === 'search' ? 'active' : '', 'search');
    searchLink.dataset.navId = 'search';
    nav.append(searchLink);
  }
  const settingsLink = railButton('Settings', () => go({type:'settings'}), route.type === 'settings' ? 'active' : '', 'settings');
  settingsLink.dataset.navId = 'settings';
  nav.append(settingsLink);
  if (focused) {
    const restore = Array.from(nav.querySelectorAll('[data-nav-id]')).find(x => x.dataset.navId === focused);
    if (restore) focusWithoutJump(restore, false);
  }
}
function go(next, remember = true) {
  if (remember) {
    // Flutter retains the covered route's subtree. Preserve this rendered
    // page and its scroll/focus state instead of refetching and repainting it
    // when a movie/episode detail is dismissed.
    const snapshot = document.createDocumentFragment();
    const scroll = main.scrollTop;
    const focused = main.contains(document.activeElement) ?
      document.activeElement.dataset.focus : null;
    while (main.firstChild) snapshot.appendChild(main.firstChild);
    history.push({route:{...route,scroll,focus:focused},snapshot,sourceApi:api});
    if (history.length > 8) history.shift();
  }
  route = next; render();
}
function cancelAuth() { if (authAbort) { authAbort.abort(); authAbort = null; } }
function back() {
  if (!dialog.hidden) { dialog.hidden = true; focusFirst(); return; }
  if (player.active) { player.close(); return; }
  if (history.length) {
    const previous = history.pop();
    route = previous.route || previous;
    if (previous.snapshot && previous.sourceApi === api && previous.snapshot.childNodes.length) {
      ++revision;
      cancelAuth();
      main.textContent = '';
      main.appendChild(previous.snapshot);
      navigation();
      main.scrollTop = route.scroll || 0;
      const focused = Array.from(main.querySelectorAll('[data-focus]')).find(
        node => node.dataset.focus === route.focus);
      if (focused) focusWithoutJump(focused, false);
      else focusFirst();
      schedulePosters();
    } else render();
    return;
  }
  dialog.textContent = ''; dialog.append(el('h2', 'Close Plezy?'));
  const actions = el('div', undefined, 'actions');
  actions.append(button('Keep watching', () => { dialog.hidden = true; focusFirst(); }), button('Exit', () => window.close()));
  dialog.append(actions); dialog.hidden = false; focusFirst(dialog);
}
function card(item) {
  const node = button('', () => go({type: 'detail', id: item.id, kind: item.type})); node.className = 'card'; node.dataset.focus = item.id;
  node.setAttribute('aria-label', item.title + (item.subtitle ? ', ' + item.subtitle : ''));
  node.append(poster(item), el('strong', item.title), el('small', item.subtitle));
  if (item.unwatchedCount > 0 && ['show','season','Series','Season'].includes(item.type))
    node.append(el('span', String(item.unwatchedCount), 'badge'));
  else if (item.watched && !(item.resume > 0 && item.duration > 0))
    node.append(el('span', '✓', 'badge'));
  if (item.resume > 0 && item.duration > 0) { const p = el('progress'); p.max = item.duration; p.value = item.resume; node.append(p); }
  return node;
}
// Flutter's sliver-based library lists inflate artwork near the viewport.
 // Chromium 53 ignores <img loading="lazy">, so queue only visible posters
 // (with one screen of prefetch) instead of decoding all 60 per library page.
const MAX_ARTWORK_IN_FLIGHT = 2;
let posterFrame = 0, artworkInFlight = 0;
function loadVisiblePosters() {
  posterFrame = 0;
  if (artworkInFlight >= MAX_ARTWORK_IN_FLIGHT) return;
  const view = main.getBoundingClientRect();
  const images = main.querySelectorAll('img[data-poster-src]');
  for (let i = 0; i < images.length && artworkInFlight < MAX_ARTWORK_IN_FLIGHT; i++) {
    const img = images[i], rect = img.getBoundingClientRect();
    // One row of prefetch, not a full extra TV screen of full-size posters.
    if (rect.bottom < view.top - 200 || rect.top > view.bottom + 200 ||
        rect.right < view.left - 180 || rect.left > view.right + 180) continue;
    const url = img.getAttribute('data-poster-src');
    img.removeAttribute('data-poster-src');
    ++artworkInFlight;
    const finish = () => {
      img.removeEventListener('load', finish);
      img.removeEventListener('error', finish);
      artworkInFlight = Math.max(0, artworkInFlight - 1);
      schedulePosters();
    };
    img.addEventListener('load', finish);
    img.addEventListener('error', finish);
    img.src = url;
  }
}
function schedulePosters() {
  if (!posterFrame) posterFrame = requestAnimationFrame(loadVisiblePosters);
}
main.addEventListener('scroll', schedulePosters, true);
function poster(item, options = {}) {
  const node = el('div', undefined, 'poster'); const image = api.image(item, options);
  if (image) {
    const img = el('img'); img.alt = ''; img.setAttribute('data-poster-src', image);
    img.onerror = () => { node.textContent = '▷'; };
    node.append(img);
  } else node.textContent = '▷';
  return node;
}
function cards(items, grid = false) {
  const node = el('div', undefined, grid ? 'grid' : 'cards'); items.forEach(item => node.append(card(item))); return node;
}
// Source: lib/widgets/episode_card.dart — 16:9 thumb, play overlay,
// index/title, 3-line synopsis and duration/air-date/quality metadata.
function episodeCard(item) {
  const label = (item.raw?.index != null ? item.raw.index + '. ' : '') + item.title;
  const node = button('', () => play(item, item.resume), 'episode-row');
  node.dataset.focus = item.id;
  node.setAttribute('aria-label', label);
  const image = el('div', undefined, 'episode-thumb');
  image.append(poster(item, {landscape:true}));
  image.append(el('span', '▶', 'episode-play-icon'));
  if (item.watched && !(item.resume > 0)) image.append(el('span', '✓', 'badge'));
  if (item.resume > 0 && item.duration > 0) {
    const progress = el('progress', undefined, 'episode-progress');
    progress.max = item.duration; progress.value = item.resume;
    image.append(progress);
  }
  const details = el('div', undefined, 'episode-row-info');
  details.append(el('strong', label));
  if (item.summary) details.append(el('p', item.summary, 'episode-summary'));
  const metadata = [item.duration ? time(item.duration) : '',
    item.raw?.originallyAvailableAt || item.raw?.originallyAvailableAt,
    item.raw?.Media?.[0]?.videoResolution || ''].filter(Boolean);
  if (metadata.length) details.append(el('small', metadata.join('  •  '), 'episode-row-meta'));
  node.append(image, details);
  return node;
}
async function paginated(loader, currentRevision, options = {}) {
  // Plezy loads sparse pages automatically as the grid approaches the viewport.
  // There is no manually activated "Load more" button.
  let start = 0, loading = false, completed = false;
  const grid = options.episodes ? el('div', undefined, 'episode-list') : cards([], true);
  const sentinel = el('div', undefined, 'page-sentinel');
  const errorMessage = el('p', '', 'error');
  errorMessage.setAttribute('role', 'alert');
  // Keep an explicit recovery action only for failed requests. Normal
  // pagination remains automatic, like upstream Plezy.
  const retry = button('Retry loading', () => load(), 'library-retry');
  retry.hidden = true;
  main.append(grid, sentinel, errorMessage, retry);
  async function load() {
    if (loading || completed || currentRevision !== revision || !grid.isConnected) return;
    loading = true;
    retry.hidden = true;
    errorMessage.textContent = '';
    try {
      const page = await loader(start);
      if (currentRevision !== revision || !grid.isConnected) return;
      for (let i = 0; i < page.items.length; i += 8) {
        if (currentRevision !== revision || !grid.isConnected) return;
        const fragment = document.createDocumentFragment();
        page.items.slice(i, i + 8).forEach(item =>
          fragment.appendChild(options.episodes ? episodeCard(item) : card(item)));
        grid.appendChild(fragment);
        schedulePosters();
        if (i + 8 < page.items.length) await new Promise(resolve => setTimeout(resolve, 0));
      }
      start += page.items.length;
      completed = !page.items.length || start >= page.total;
      if (completed) cleanup();
      if (!start && !grid.children.length) grid.append(el('p', 'No titles found.', 'muted'));
      schedulePosters();
    } catch (error) {
      if (currentRevision === revision && grid.isConnected) {
        errorMessage.textContent = 'Could not load library titles: ' + error.message;
        retry.hidden = false;
      }
    } finally {
      loading = false;
      if (currentRevision === revision && grid.isConnected && !completed && !errorMessage.textContent) {
        // Let the DOM paint before measuring, and keep filling short libraries.
        requestAnimationFrame(check);
      }
    }
  }
  function check() {
    if (currentRevision !== revision || !grid.isConnected || completed) { cleanup(); return; }
    if (loading) return;
    const rect = sentinel.getBoundingClientRect();
    const pane = main.getBoundingClientRect();
    if (rect.top <= pane.bottom + pane.height * 0.8) load();
  }
  const onScroll = () => check();
  main.addEventListener('scroll', onScroll);
  const observer = typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver(check, {root: main, rootMargin: '700px'}) : null;
  if (observer) observer.observe(sentinel);
  const cleanup = () => {
    main.removeEventListener('scroll', onScroll);
    if (observer) observer.disconnect();
  };
  // Destroy the observer once a different page replaces the grid.
  await load();
  if (completed) cleanup();
  else requestAnimationFrame(check);
}
async function render() {
  const currentRevision = ++revision;
  cancelAuth(); main.textContent = ''; main.scrollTop = 0; navigation();
  const valid = () => currentRevision === revision;
  try {
    if (!api && !['settings', 'add', 'plex', 'simkl'].includes(route.type)) route = {type: 'settings'};
    if (route.type === 'settings') settings();
    else if (route.type === 'add') addForm(route.kind);
    else if (route.type === 'plex') { await plexSignIn(); return; }
    else if (route.type === 'simkl') { await simklSignIn(); return; }
    else if (route.type === 'home') {
      title('Your next watch', activeServer().name);
      const loading = el('p', 'Loading your library…', 'muted'); main.append(loading);
      const rows = await api.home(); if (!valid()) return; loading.remove();
      if (!rows.length) {
        main.append(el('p', 'No recommendations yet. Browse a library to find something to watch.'));
        main.append(button('Browse libraries', () => go({type: 'libraries'}), 'primary'));
      }
      rows.forEach(row => { const section = el('section', undefined, 'shelf'); section.append(el('h2', row.title), cards(row.items)); main.append(section); });
    } else if (route.type === 'libraries') {
      title('Libraries', activeServer().name);
      const libraries = libraryCacheFor === api ? libraryCache : await api.libraries(); if (!valid()) return;
      if (libraryCacheFor !== api) { libraryCacheFor = api; libraryCache = libraries; navigation(); }
      if (!libraries.length) main.append(el('p', 'No video libraries are available for this account.'));
      else main.append(el('p', 'Select a library from the navigation rail to browse its recommended titles, collections and playlists.', 'muted'));
    } else if (route.type === 'library') {
      title(route.library.title); const currentApi = api;
      const view = route.view || 'browse';
      const tabs = el('div', undefined, 'library-tabs');
      [{id:'recommended', name:'Recommended'}, {id:'browse',name:'Browse'},
        {id:'collections',name:'Collections'}, {id:'playlists',name:'Playlists'}].forEach(tab => {
        const control = button(tab.name, () => go({...route, view: tab.id}, false),
          view === tab.id ? 'active' : '');
        control.setAttribute('aria-pressed', String(view === tab.id));
        tabs.append(control);
      });
      main.append(tabs);
      if (currentApi instanceof Plex && view === 'collections') {
        await paginated(start => currentApi.collections(route.library.id, start), currentRevision);
        if (valid()) focusFirst();
        return;
      }
      if (currentApi instanceof Plex && view === 'playlists') {
        await paginated(start => currentApi.playlists(start), currentRevision);
        if (valid()) focusFirst();
        return;
      }
      if (currentApi instanceof Plex && view === 'recommended') {
        const shelves = await currentApi.recommended(route.library.id);
        if (!valid()) return;
        if (!shelves.length) main.append(el('p','No recommendations for this library.', 'muted'));
        shelves.forEach(shelf => { const section = el('section', undefined, 'shelf');
          section.append(el('h2', shelf.title), cards(shelf.items)); main.append(section); });
        schedulePosters(); if (valid()) focusFirst(); return;
      }
      if (view !== 'browse') {
        main.append(el('p','This library view is currently available for Plex libraries.', 'muted'));
        return;
      }
      const choices = [{id: 'title', label: 'Title A–Z'}, {id: 'recent', label: 'Recently added'},
        {id: 'release', label: 'Release date'}];
      const selected = route.sort || 'title', selectedFilter = route.filter || 'all';
      const filters = el('div', undefined, 'sort-actions');
      filters.setAttribute('role', 'group');
      filters.setAttribute('aria-label', 'Sort library');
      choices.forEach(choice => {
        const control = button(choice.label, () =>
          go({type: 'library', library: route.library, view: 'browse', sort: choice.id,
            filter: selectedFilter, focus: 'toolbar:sort'}, false),
          choice.id === selected ? 'active' : '');
        control.dataset.focus = 'sort:' + choice.id;
        control.setAttribute('aria-pressed', String(choice.id === selected));
        filters.append(control);
      });
      const watchFilters = el('div', undefined, 'sort-actions');
      watchFilters.setAttribute('role', 'group');
      watchFilters.setAttribute('aria-label', 'Filter watched status');
      [{id: 'all', label: 'All titles'}, {id: 'unwatched', label: 'Unwatched'}].forEach(choice => {
        const control = button(choice.label, () =>
          go({type: 'library', library: route.library, view: 'browse', sort: selected,
            filter: choice.id, focus: 'toolbar:filter'}, false),
          choice.id === selectedFilter ? 'active' : '');
        control.dataset.focus = 'filter:' + choice.id;
        control.setAttribute('aria-pressed', String(choice.id === selectedFilter));
        watchFilters.append(control);
      });
      const toolbar = el('div', undefined, 'library-toolbar');
      const sortAction = detailButton('Sort', () => {
        const open = filters.hidden;
        filters.hidden = !open;
        watchFilters.hidden = true;
        if (open) focusWithoutJump(filters.querySelector('button'));
      }, 'sort', 'library-toolbar-button');
      sortAction.dataset.focus = 'toolbar:sort';
      const filterAction = detailButton('Filters', () => {
        const open = watchFilters.hidden;
        watchFilters.hidden = !open;
        filters.hidden = true;
        if (open) focusWithoutJump(watchFilters.querySelector('button'));
      }, 'filter', 'library-toolbar-button');
      filterAction.dataset.focus = 'toolbar:filter';
      const refreshAction = detailButton('Refresh', () => go({...route}, false), 'restart', 'library-toolbar-button');
      toolbar.append(sortAction, filterAction, refreshAction);
      filters.hidden = true; watchFilters.hidden = true;
      main.append(toolbar, filters, watchFilters);
      await paginated(start => currentApi.list(route.library.id, start, selected, selectedFilter), currentRevision);
    } else if (route.type === 'search') searchForm();
    else if (route.type === 'detail') {
      const item = await api.detail(route.id, route.kind); if (!valid()) return;
      const isPlexShow = api instanceof Plex && item.type === 'show';
      const raw = item.raw || {};
      const content = el('div', undefined, 'detail'), info = el('div', undefined, 'detail-info');
      content.classList.add(item.type === 'episode' || item.type === 'Episode' ? 'detail-episode' : 'detail-media');
      if (api instanceof Plex && item.background) {
        const hero = el('div', undefined, 'detail-backdrop');
        // Server-transcoded low-resolution artwork, not a source-sized image.
        hero.style.backgroundImage = 'linear-gradient(to right, #0e0f12 2%, rgba(14,15,18,.86) 48%, rgba(14,15,18,.2)), linear-gradient(to top, #0e0f12, transparent 65%), url("' +
          api.backdrop(item).replace(/"/g, '%22') + '")';
        main.append(hero);
      }
      if (raw.tagline) info.append(el('p', raw.tagline, 'detail-tagline'));
      info.append(el('h1', item.title));
      // Source: MediaDetailScreen._buildMetadataChip and hero chip rows.
      // Keep each field as a distinct Material tonal pill, not a sentence.
      const chips = el('div', undefined, 'detail-chips');
      const media = raw.Media && raw.Media[0] || {};
      const facts = [raw.year, raw.editionTitle, raw.contentRating,
        item.duration ? time(item.duration) : '',
        media.videoResolution ? String(media.videoResolution).toUpperCase() : '',
        raw.rating != null ? '★ ' + Number(raw.rating).toFixed(1) : ''].filter(Boolean);
      facts.forEach(value => chips.append(el('span', String(value), 'detail-chip')));
      if (chips.children.length) info.append(chips);
      const genreChips = el('div', undefined, 'detail-chips detail-genres');
      (Array.isArray(raw.Genre) ? raw.Genre : []).forEach(genre => {
        if (genre.tag) genreChips.append(el('span', genre.tag, 'detail-chip'));
      });
      if (genreChips.children.length) info.append(genreChips);
      if (item.summary) info.append(el('p', item.summary, 'detail-summary'));
      if (api instanceof Plex) {
        const tags = values => (Array.isArray(values) ? values : []).map(x => x.tag || x.title).filter(Boolean);
        const metaRows = [
          // Genres are already displayed as Flutter-style hero chips.
          ['Directors', tags(raw.Director)],
          ['Writers', tags(raw.Writer)],
          ['Cast', tags(raw.Role).slice(0, 12)]
        ];
        metaRows.forEach(row => {
          if (!row[1].length) return;
          const line = el('p', undefined, 'detail-meta');
          line.append(el('strong', row[0] + ': '), document.createTextNode(row[1].join(', ')));
          info.append(line);
        });
      }
      const actions = el('div', undefined, 'detail-actions');
      const chooseEpisode = async () => {
        if (item.type === 'show' || item.type === 'Series') {
          try {
            const next = await api.onDeck(item.id);
            if (next) return next;
          } catch (_) { /* On Deck is optional */ }
        }
        const first = await api.children(item.id);
        if (item.type === 'season' || item.type === 'Season')
          return first.items.find(e => e.type === 'episode' || e.type === 'Episode') || null;
        for (const season of first.items) {
          const episodes = await api.children(season.id);
          const episode = episodes.items.find(e => e.type === 'episode' || e.type === 'Episode');
          if (episode) return episode;
        }
        return null;
      };
      if (item.folder && (isPlexShow || item.type === 'season' || item.type === 'Season')) {
        const expectedRevision = revision, currentApi = api;
        actions.append(detailButton('Play', async () => {
          const episode = await chooseEpisode();
          if (revision !== expectedRevision || api !== currentApi) return;
          if (episode) play(episode, episode.resume || 0);
          else notify('No playable episodes were found.');
        }, 'play', 'detail-play'));
      } else if (!item.folder) {
        const versions = api instanceof Plex ? item.raw.Media || [] : [];
        if (item.resume > 0) actions.append(detailButton('Resume · ' + time(item.resume),
          () => play(item, item.resume), 'play', 'detail-play'));
        else actions.append(detailButton('Play', () => play(item, 0), 'play', 'detail-play'));
        if (versions.length > 1) {
          const version = el('label', undefined, 'detail-version');
          const select = el('select'); select.setAttribute('aria-label', 'Media version');
          select.dataset.focus = 'media-version';
          versions.forEach((media, index) => {
            const label = [media.videoResolution, media.videoCodec, media.audioCodec]
              .filter(Boolean).join(' · ');
            const option = el('option', 'Version ' + (index + 1) + (label ? ' · ' + label : ''));
            option.value = String(index); select.append(option);
          });
          select.value = String(route.mediaIndex || 0);
          select.onchange = () => { route.mediaIndex = Number(select.value); };
          version.append(select); actions.append(version);
        }
        if (item.resume > 0) actions.append(detailButton('Play from beginning',
          () => play(item, 0), 'restart', 'detail-icon'));
        actions.append(detailButton(item.watched ? 'Mark unwatched' : 'Mark watched', async () => {
          const currentApi = api, watched = !item.watched;
          await currentApi.watched(item, watched);
          if (currentApi instanceof Plex) simklTracker.markWatched(currentApi, item, watched);
          render();
        }, 'watched', 'detail-icon'));
        if (api instanceof Plex && item.type === 'episode' && raw.parentRatingKey) {
          actions.append(detailButton('Next episode', async () => {
            const expected = revision, currentApi = api;
            const next = await currentApi.nextEpisode(item);
            if (expected !== revision || currentApi !== api) return;
            if (next) go({type:'detail',id:next.id,kind:next.type});
            else notify('No further episodes are available for this show.');
          }, 'next', 'detail-icon'));
        }
        actions.append(detailButton('Compatible playback',
          () => play(item, item.resume, true), 'more', 'detail-icon'));
      }
      info.append(actions);
      if (!item.background && item.type !== 'episode') content.append(poster(item, {detail:true}));
      content.append(info);
      if (item.type === 'episode' || item.type === 'Episode')
        content.append(poster(item, {detail:true,landscape:true}));
      main.append(content);
      if (item.folder) {
        const heading = el('h2', item.type === 'show' || item.type === 'Series' ? 'Seasons' :
          item.type === 'season' ? 'Episodes' : 'Titles');
        heading.className = 'detail-children-title';
        main.append(heading);
        const currentApi = api;
        await paginated(start => currentApi.children(item.id, start, item.type),
          currentRevision, {episodes: item.type === 'season' || item.type === 'Season'});
      }
    }
  } catch (error) {
    if (!valid()) return;
    main.append(el('p', error.message, 'error'), button('Retry', render), button('Settings', () => go({type: 'settings'})));
  }
  if (valid()) {
    schedulePosters();
    if (route.focus) {
      const found = Array.from(main.querySelectorAll('[data-focus]')).find(n => n.dataset.focus === route.focus);
      // Restore the previous reading/scroll position BEFORE focusing its card.
      // Native focus scrolling must not pull a restored library back to row 1.
      main.scrollTop = route.scroll || 0;
      if (found) focusWithoutJump(found, false); else focusFirst();
    } else focusFirst();
  }
}
function play(item, start, transcode = false) { return player.open(api, item, {start, mediaIndex: route.mediaIndex || 0, transcode: transcode || state.quality === 'transcode'}); }
function settings() {
  title(api ? 'Settings' : 'Welcome to Plezy', 'Configure the media server, playback and library navigation.');
  state.servers.forEach(server => {
    const panel = el('section', undefined, 'panel'); panel.append(el('h2', server.name), el('p', server.kind.toUpperCase() + ' · ' + server.url, 'muted'));
    const actions = el('div', undefined, 'actions');
    actions.append(button(server.id === (activeServer() || {}).id ? 'Open server' : 'Switch to server', () => {
      state.active = server.id; persist(); setClient(); history = []; go({type: 'home'}, false);
    }), button('Remove from this TV', () => {
      state.servers = state.servers.filter(s => s.id !== server.id); persist(); setClient(); render();
    })); panel.append(actions); main.append(panel);
  });
  const actions = el('div', undefined, 'actions');
  actions.append(button('Sign in with Plex', () => go({type: 'plex'}), 'primary'),
    button('Add Jellyfin', () => go({type: 'add', kind: 'jellyfin'})),
    button('Add Emby', () => go({type: 'add', kind: 'emby'})),
    button('Manual Plex server', () => go({type: 'add', kind: 'plex'})));
  main.append(actions);
  const panel = el('section', undefined, 'panel'); panel.append(el('h2', 'Playback'));
  panel.append(button('Quality: ' + (state.quality === 'auto' ? 'Automatic' : 'Compatible H.264 / AAC'), () => {
    state.quality = state.quality === 'auto' ? 'transcode' : 'auto'; persist(); render();
  }));
  panel.append(el('p', 'Automatic plays compatible MP4 files directly. Other formats use server transcoding. Compatible playback requires permission to transcode on your server.', 'muted'));
  main.append(panel);
  const simklPanel = el('section', undefined, 'panel');
  simklPanel.append(el('h2', 'Simkl tracking'));
  if (validSession(state.simkl)) {
    simklPanel.append(el('p', 'Connected. Plex movies and episodes are tracked on Simkl automatically when playback starts, pauses, or stops. Manual watched changes also sync. Plex resume tracking remains independent.', 'muted'));
    const pendingStops = simklTracker.pendingStops().length;
    if (pendingStops) simklPanel.append(button('Retry saved Simkl stops (' + pendingStops + ')', async () => {
      await simklTracker.retryPending();
      if (route.type === 'settings') render();
    }));
    simklPanel.append(button('Disconnect Simkl', () => {
      simklTracker.reset();
      state.simkl = null; persist(); render();
    }));
  } else {
    simklPanel.append(el('p', 'Optional: automatically sync Plex movie and episode playback to your Simkl account. Link with a code on your phone.', 'muted'));
    simklPanel.append(button('Connect Simkl', () => go({type: 'simkl'}), 'primary'));
  }
  main.append(simklPanel);
  if (api && libraryCacheFor === api && libraryCache) {
    const manager = el('section', undefined, 'panel');
    manager.append(el('h2', 'Library visibility'),
      el('p', 'Choose which libraries appear in Plezy’s navigation rail.', 'muted'));
    libraryCache.forEach(library => {
      const key = activeServer().id + ':' + library.id;
      const hidden = state.hiddenLibraryIds.includes(key);
      manager.append(button((hidden ? 'Show ' : 'Hide ') + library.title + ' in sidebar', () => {
        state.hiddenLibraryIds = hidden
          ? state.hiddenLibraryIds.filter(x => x !== key) : state.hiddenLibraryIds.concat(key);
        persist(); navigation(); render();
      }));
    });
    main.append(manager);
  }
  main.append(el('p', 'Community port · ' + VERSION + ' alpha · webOS 4.x+ target. Account tokens are saved on this TV; passwords are not. Removing a server clears its saved token.', 'muted'));
}
function field(form, text, type = 'text', value = '') {
  const label = el('label', text), input = el('input'); input.type = type; input.value = value; input.autocomplete = type === 'password' ? 'current-password' : 'off';
  input.spellcheck = false; label.append(input); form.append(label); return input;
}
function addForm(kind) {
  title('Connect ' + (kind === 'plex' ? 'Plex' : kind === 'emby' ? 'Emby' : 'Jellyfin'));
  const form = el('form', undefined, 'panel');
  const url = field(form, 'Server URL', 'url'); url.placeholder = kind === 'plex' ? 'http://192.168.1.10:32400' : 'http://192.168.1.10:8096'; url.required = true;
  const username = kind === 'plex' ? null : field(form, 'Username'); if (username) username.required = true;
  const password = field(form, kind === 'plex' ? 'Plex token' : 'Password', 'password'); if (kind === 'plex') password.required = true;
  const submit = el('button', 'Connect', 'primary'); submit.type = 'submit';
  const error = el('p', '', 'error'); error.setAttribute('role', 'alert');
  form.append(submit, button('Back', back), error); main.append(form);
  form.onsubmit = async event => {
    event.preventDefault(); submit.disabled = true; error.textContent = ''; const expected = revision;
    try {
      const server = {kind, url: baseUrl(url.value)};
      let authenticated;
      if (kind === 'plex') {
        server.token = password.value.trim();
        const data = await new Plex(server, state.deviceId).probe();
        authenticated = {...server, id: data.MediaContainer.machineIdentifier || id(), name: data.MediaContainer.friendlyName || 'Plex server'};
      } else authenticated = await new Jellyfin(server, state.deviceId).login(username.value.trim(), password.value);
      password.value = '';
      if (expected === revision) addServer(authenticated);
    } catch (err) { if (expected === revision) error.textContent = err.message; }
    finally { submit.disabled = false; }
  };
}
function searchForm() {
  title('Find something to watch', activeServer().name);
  const form = el('form'), query = field(form, 'Title', 'search', route.query || ''); query.required = true;
  const submit = el('button', 'Search', 'primary'); submit.type = 'submit'; form.append(submit); main.append(form);
  const results = el('section'); main.append(results); let searchRevision = 0;
  form.onsubmit = async event => {
    event.preventDefault(); const current = ++searchRevision, expected = revision, currentApi = api;
    route.query = query.value.trim(); if (!route.query) return;
    results.textContent = 'Searching…';
    try {
      const items = await currentApi.search(route.query); if (current !== searchRevision || revision !== expected) return;
      results.textContent = ''; results.append(el('h2', items.length + ' results'), cards(items, true)); focusFirst(results);
    } catch (error) { if (revision === expected && current === searchRevision) results.textContent = error.message; }
  };
  if (route.query) form.dispatchEvent(new Event('submit', {cancelable: true}));
}
function sleep(ms, signal) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms); signal.addEventListener('abort', done, {once: true});
    if (signal.aborted) done();
  });
}
async function plexSignIn() {
  title('Link your Plex account', 'On your phone or computer, open plex.tv/link and enter the code below.');
  const code = el('div', '…', 'pin'), status = el('p', 'Requesting a code…', 'muted');
  main.append(code, status, button('Cancel', back)); focusFirst();
  const controller = new AbortController(); authAbort = controller;
  try {
    const pin = await plexPin(state.deviceId, controller.signal); if (controller.signal.aborted) return;
    code.textContent = pin.code;
    const expiry = Date.now() + Math.min(Number(pin.expiresIn) || 300, 900) * 1000;
    while (!controller.signal.aborted && Date.now() < expiry) {
      status.textContent = 'Waiting for approval…'; await sleep(2500, controller.signal); if (controller.signal.aborted) return;
      const result = await pollPlexPin(state.deviceId, pin, controller.signal); if (controller.signal.aborted) return;
      if (result.authToken) {
        status.textContent = 'Finding reachable Plex servers…';
        const servers = await plexServers(state.deviceId, result.authToken, controller.signal); if (controller.signal.aborted) return;
        if (!servers.length) throw new Error('Signed in, but no server is reachable from this TV. Check server remote access, or use Manual Plex server.');
        servers.forEach(server => { state.servers = state.servers.filter(s => s.id !== server.id).concat(server); });
        persist();
        if (servers.length === 1) {
          state.active = servers[0].id; persist(); setClient(); history = []; go({type: 'home'}, false); return;
        }
        // An account can have multiple owned/shared Plex servers. Let viewers
        // choose instead of silently opening whichever resource was listed first.
        code.remove();
        status.textContent = 'Choose a Plex server to browse:';
        const choices = el('div', undefined, 'actions');
        servers.forEach(server => choices.append(button(server.name, () => {
          state.active = server.id; persist(); setClient(); history = []; go({type: 'home'}, false);
        })));
        main.append(choices); focusFirst(choices); return;
      }
    }
    if (!controller.signal.aborted) throw new Error('The code expired. Please request a new one.');
  } catch (error) {
    if (!controller.signal.aborted) { status.textContent = error.message; status.className = 'error'; main.append(button('Get a new code', render)); }
  }
}
async function simklSignIn() {
  title('Link your Simkl account', 'Authorize Plezy to track watched movies and episodes. This connection is optional.');
  const code = el('div', '…', 'pin');
  const url = el('p', 'Requesting a Simkl device code…', 'muted');
  const status = el('p', '', 'muted');
  main.append(code, url, status, button('Cancel', back));
  focusFirst();
  const controller = new AbortController();
  authAbort = controller;
  try {
    const grant = await beginSimklLink(controller.signal);
    if (controller.signal.aborted) return;
    code.textContent = grant.user_code;
    const verify = new URL(grant.verification_uri);
    if (verify.protocol !== 'https:' || (verify.hostname !== 'simkl.com' && !verify.hostname.endsWith('.simkl.com'))) {
      throw new Error('Simkl returned an untrusted verification address.');
    }
    url.textContent = 'On your phone, visit ' + verify.href + ' and enter this code.';
    status.textContent = 'Waiting for approval…';
    const expires = Date.now() + Math.min(Math.max(60, Number(grant.expires_in) || 900), 900) * 1000;
    let interval = Math.max(5, Number(grant.interval) || 5) * 1000;
    while (!controller.signal.aborted && Date.now() < expires) {
      await sleep(interval, controller.signal);
      if (controller.signal.aborted) return;
      let result;
      try { result = await pollSimklLink(grant, controller.signal); }
      catch (error) {
        if (/unreachable|timed out/i.test(error.message)) {
          status.textContent = 'Simkl connection interrupted. Retrying…';
          continue;
        }
        throw error;
      }
      if (controller.signal.aborted) return;
      if (result.session) {
        simklTracker.reset();
        state.simkl = result.session; persist(); history = [];
        go({type: 'settings'}, false);
        notify('Simkl connected. Plex playback will now be tracked automatically.');
        return;
      }
      if (result.slowDown) interval += 5000;
      status.textContent = 'Waiting for Simkl approval…';
    }
    if (!controller.signal.aborted) throw new Error('Simkl authorization code expired.');
  } catch (error) {
    if (!controller.signal.aborted) {
      status.className = 'error'; status.textContent = error.message;
      main.append(button('Try Simkl again', render));
    }
  }
}
window.addEventListener('keydown', event => {
  if (player.active && player.key(event)) return;
  if ([461, 27].includes(event.keyCode)) { event.preventDefault(); back(); return; }
  const direction = {37: 'left', 38: 'up', 39: 'right', 40: 'down'}[event.keyCode];
  if (!direction) return;
  const current = document.activeElement;
  if (current.tagName === 'SELECT' && ['left', 'right'].includes(direction)) {
    event.preventDefault(); current.selectedIndex = Math.max(0, Math.min(current.options.length - 1, current.selectedIndex + (direction === 'left' ? -1 : 1)));
    current.dispatchEvent(new Event('change')); return;
  }
  if (current.tagName === 'INPUT' && ['left', 'right'].includes(direction)) return;
  event.preventDefault();
  const root = !dialog.hidden ? dialog : player.active ? player.root : document.querySelector('#shell');
  const inRail = nav.contains(current);
  const inMain = main.contains(current);
  // D-pad navigation follows the original Flutter navigation zones:
  // Up/Down stay in the current rail or page. A left press in the sidebar
  // never jumps diagonally to a different item in the sidebar.
  if (dialog.hidden && !player.active && inRail && direction === 'left') return;
  // The rail is one focus zone. RIGHT must leave it even if another rail
  // item happens to be geometrically to the right (indented libraries).
  if (dialog.hidden && !player.active && inRail && direction === 'right') {
    const first = main.querySelector('button:not(:disabled),input,select');
    if (first) focusWithoutJump(first);
    else { main.tabIndex = -1; focusWithoutJump(main); }
    return;
  }
  const validControls = scope => Array.from(scope.querySelectorAll(
    'button:not(:disabled),input,select')).filter(node =>
      node !== current && node.getClientRects().length && !node.hidden);
  const choose = (candidates, axis) => nextFocus(current.getBoundingClientRect(),
    candidates.map(value => ({value, rect: value.getBoundingClientRect()})), axis);
  if (dialog.hidden && !player.active && (inRail || inMain)) {
    const source = inRail ? nav : main;
    // Spatial search must not send Left from the first artwork column to
    // a filter button somewhere up the screen. Flutter's D-pad focus boundary
    // transfers to the active rail destination when the current row ends.
    if (inMain && direction === 'left') {
      const rect = current.getBoundingClientRect();
      const rowCandidates = validControls(main).filter(node => {
        const box = node.getBoundingClientRect();
        return box.right <= rect.left + 8 &&
          box.top < rect.bottom - 4 && box.bottom > rect.top + 4;
      });
      const adjacent = choose(rowCandidates, 'left');
      if (adjacent) { focusWithoutJump(adjacent); return; }
      const selected = nav.querySelector('button.active') ||
        nav.querySelector('button:not(:disabled)');
      if (selected) focusWithoutJump(selected);
      return;
    }
    const local = choose(validControls(source), direction);
    if (local) { focusWithoutJump(local); return; }
    if (inMain && (direction === 'up' || direction === 'down')) {
      const delta = direction === 'up' ? -Math.max(120, main.clientHeight * .65)
        : Math.max(120, main.clientHeight * .65);
      main.scrollTop = Math.max(0, main.scrollTop + delta);
      schedulePosters();
      return;
    }
    return;
  }
  const next = choose(validControls(root), direction);
  if (next) focusWithoutJump(next);
}, true);
window.addEventListener('pagehide', () => { cancelAuth(); player.release(); });
setClient(); persist(); render();
