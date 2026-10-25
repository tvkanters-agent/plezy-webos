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
    node.focus();
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
function setClient() { const server = activeServer(); api = server ? client(server, state.deviceId) : null; }
function addServer(server) {
  state.servers = state.servers.filter(s => s.id !== server.id).concat(server);
  state.active = server.id; persist(); setClient(); history = []; go({type: 'home'}, false);
}
function focusFirst(root = main) {
  const expectedRevision = revision;
  requestAnimationFrame(() => {
    if (expectedRevision !== revision || !root.isConnected) return;
    const first = root.querySelector('button:not(:disabled),input,select');
    if (first) first.focus(); else root.focus();
  });
}
function title(text, subtitle) { main.append(el('p', 'PLEZY / WEBOS', 'eyebrow'), el('h1', text)); if (subtitle) main.append(el('p', subtitle, 'intro')); }
function navigation() {
  nav.textContent = '';
  if (api) {
    nav.append(button('Home', () => go({type: 'home'}), route.type === 'home' ? 'active' : ''),
      button('Libraries', () => go({type: 'libraries'}), route.type === 'libraries' || route.type === 'library' ? 'active' : ''),
      button('Search', () => go({type: 'search'}), route.type === 'search' ? 'active' : ''));
  }
  nav.append(button('Servers & settings', () => go({type: 'settings'}), route.type === 'settings' ? 'active' : ''));
}
function go(next, remember = true) {
  if (remember) history.push({...route, scroll: main.scrollTop, focus: main.contains(document.activeElement) ? document.activeElement.dataset.focus : null});
  route = next; render();
}
function cancelAuth() { if (authAbort) { authAbort.abort(); authAbort = null; } }
function back() {
  if (!dialog.hidden) { dialog.hidden = true; focusFirst(); return; }
  if (player.active) { player.close(); return; }
  if (history.length) { route = history.pop(); render(); return; }
  dialog.textContent = ''; dialog.append(el('h2', 'Close Plezy?'));
  const actions = el('div', undefined, 'actions');
  actions.append(button('Keep watching', () => { dialog.hidden = true; focusFirst(); }), button('Exit', () => window.close()));
  dialog.append(actions); dialog.hidden = false; focusFirst(dialog);
}
function card(item) {
  const node = button('', () => go({type: 'detail', id: item.id})); node.className = 'card'; node.dataset.focus = item.id;
  node.setAttribute('aria-label', item.title + (item.subtitle ? ', ' + item.subtitle : ''));
  node.append(poster(item), el('strong', item.title), el('small', item.subtitle));
  if (item.watched) node.append(el('span', '✓', 'badge'));
  if (item.resume > 0 && item.duration > 0) { const p = el('progress'); p.max = item.duration; p.value = item.resume; node.append(p); }
  return node;
}
function poster(item) {
  const node = el('div', undefined, 'poster'); const image = api.image(item);
  if (image) {
    const img = el('img'); img.alt = ''; img.loading = 'lazy'; img.src = image;
    img.onerror = () => { node.textContent = '▷'; }; node.append(img);
  } else node.textContent = '▷';
  return node;
}
function cards(items, grid = false) {
  const node = el('div', undefined, grid ? 'grid' : 'cards'); items.forEach(item => node.append(card(item))); return node;
}
async function paginated(loader, currentRevision) {
  let start = 0;
  const grid = cards([], true), more = button('Load more', load), errorMessage = el('p', '', 'error');
  errorMessage.setAttribute('role', 'alert');
  main.append(grid, more, errorMessage);
  async function load() {
    const hadFocus = document.activeElement === more;
    const previousCount = grid.children.length;
    more.disabled = true;
    errorMessage.textContent = '';
    try {
      const page = await loader(start);
      if (currentRevision !== revision) return;
      page.items.forEach(item => grid.append(card(item))); start += page.items.length;
      more.hidden = !page.items.length || start >= page.total;
      more.textContent = 'Load more';
      if (!start && !grid.children.length) grid.append(el('p', 'No titles found.', 'muted'));
      // The Load more button disappears on the final page. Move remote focus
      // to newly loaded content instead of leaving it on a hidden control.
      if (hadFocus && document.activeElement === more) {
        const target = grid.children[previousCount] || grid.lastElementChild;
        if (target && typeof target.focus === 'function') target.focus();
        else main.focus();
      }
    } catch (error) {
      if (currentRevision === revision) {
        errorMessage.textContent = 'Could not load library titles: ' + error.message;
        more.textContent = 'Retry loading';
        more.hidden = false;
      }
    } finally { more.disabled = false; }
  }
  await load();
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
      const libraries = await api.libraries(); if (!valid()) return;
      const list = el('div', undefined, 'actions'); libraries.forEach(library => list.append(button(library.title, () => go({type: 'library', library}))));
      main.append(list); if (!libraries.length) main.append(el('p', 'No video libraries are available for this account.'));
    } else if (route.type === 'library') {
      title(route.library.title); const currentApi = api;
      const choices = [{id: 'title', label: 'Title A–Z'}, {id: 'recent', label: 'Recently added'},
        {id: 'release', label: 'Release date'}];
      const selected = route.sort || 'title', selectedFilter = route.filter || 'all';
      const filters = el('div', undefined, 'sort-actions');
      filters.setAttribute('role', 'group');
      filters.setAttribute('aria-label', 'Sort library');
      choices.forEach(choice => {
        const control = button(choice.label, () =>
          go({type: 'library', library: route.library, sort: choice.id,
            filter: selectedFilter, focus: 'sort:' + choice.id}, false),
          choice.id === selected ? 'active' : '');
        control.dataset.focus = 'sort:' + choice.id;
        control.setAttribute('aria-pressed', String(choice.id === selected));
        filters.append(control);
      });
      main.append(filters);
      const watchFilters = el('div', undefined, 'sort-actions');
      watchFilters.setAttribute('role', 'group');
      watchFilters.setAttribute('aria-label', 'Filter watched status');
      [{id: 'all', label: 'All titles'}, {id: 'unwatched', label: 'Unwatched'}].forEach(choice => {
        const control = button(choice.label, () =>
          go({type: 'library', library: route.library, sort: selected,
            filter: choice.id, focus: 'filter:' + choice.id}, false),
          choice.id === selectedFilter ? 'active' : '');
        control.dataset.focus = 'filter:' + choice.id;
        control.setAttribute('aria-pressed', String(choice.id === selectedFilter));
        watchFilters.append(control);
      });
      main.append(watchFilters);
      await paginated(start => currentApi.list(route.library.id, start, selected, selectedFilter), currentRevision);
    } else if (route.type === 'search') searchForm();
    else if (route.type === 'detail') {
      const item = await api.detail(route.id); if (!valid()) return;
      const content = el('div', undefined, 'detail'), info = el('div', undefined, 'detail-info');
      info.append(el('p', item.subtitle, 'eyebrow'), el('h1', item.title), el('p', item.summary));
      if (item.duration) info.append(el('p', time(item.duration), 'muted'));
      const actions = el('div', undefined, 'actions');
      if (!item.folder) {
        const versions = api instanceof Plex ? item.raw.Media || [] : [];
        if (versions.length > 1) {
          const label = el('label', 'Version '), select = el('select');
          select.setAttribute('aria-label', 'Media version'); select.dataset.focus = 'media-version';
          versions.forEach((media, index) => {
            const detail = [media.videoResolution, media.videoCodec, media.audioCodec, media.container].filter(Boolean).join(' · ');
            const option = el('option', 'Version ' + (index + 1) + (detail ? ' · ' + detail : ''));
            option.value = index; select.append(option);
          });
          select.value = String(route.mediaIndex || 0);
          select.onchange = () => { route.mediaIndex = Number(select.value); };
          label.append(select); info.append(label);
        }
        if (item.resume > 0) actions.append(button('Resume · ' + time(item.resume), () => play(item, item.resume), 'primary'));
        actions.append(button(item.resume > 0 ? 'Play from beginning' : 'Play', () => play(item, 0), item.resume > 0 ? '' : 'primary'));
        actions.append(button('Compatible playback', () => play(item, item.resume, true)));
        actions.append(button(item.watched ? 'Mark unwatched' : 'Mark watched', async () => {
          const currentApi = api, watched = !item.watched;
          await currentApi.watched(item, watched);
          if (currentApi instanceof Plex) simklTracker.markWatched(currentApi, item, watched);
          render();
        }));
        if (api instanceof Plex && item.type === 'episode' && item.raw.parentRatingKey) {
          actions.append(button('Next episode', async () => {
            const expectedRevision = revision, currentApi = api;
            const next = await currentApi.nextEpisode(item);
            // A network request must not take us away from a screen that the
            // viewer has already left with Back or a different menu action.
            if (expectedRevision !== revision || currentApi !== api) return;
            if (next) go({type: 'detail', id: next.id});
            else notify('No further episodes are available for this show.');
          }));
        }
      }
      actions.append(button('Back', back)); info.append(actions); content.append(poster(item), info); main.append(content);
      if (item.folder) { main.append(el('h2', item.type === 'show' || item.type === 'Series' ? 'Seasons' : 'Titles')); const currentApi = api;
        await paginated(start => currentApi.children(item.id, start), currentRevision); }
    }
  } catch (error) {
    if (!valid()) return;
    main.append(el('p', error.message, 'error'), button('Retry', render), button('Servers & settings', () => go({type: 'settings'})));
  }
  if (valid()) {
    if (route.focus) {
      const found = Array.from(main.querySelectorAll('[data-focus]')).find(n => n.dataset.focus === route.focus);
      if (found) found.focus(); else focusFirst();
      main.scrollTop = route.scroll || 0;
    } else focusFirst();
  }
}
function play(item, start, transcode = false) { return player.open(api, item, {start, mediaIndex: route.mediaIndex || 0, transcode: transcode || state.quality === 'transcode'}); }
function settings() {
  title(api ? 'Servers & settings' : 'Welcome to Plezy', 'Connect your media server and settle in. Use the remote arrows and OK, or the Magic Remote pointer.');
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
  main.append(simklPanel, el('p', 'Community port · ' + VERSION + ' alpha · webOS 4.x+ target. Account tokens are saved on this TV; passwords are not. Removing a server clears its saved token.', 'muted'));
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
  const candidates = Array.from(root.querySelectorAll('button:not(:disabled),input,select')).filter(node => node !== current && node.getClientRects().length);
  const next = nextFocus(current.getBoundingClientRect(), candidates.map(value => ({value, rect: value.getBoundingClientRect()})), direction);
  if (next) { next.focus(); next.scrollIntoView({block: 'nearest', inline: 'nearest'}); }
}, true);
window.addEventListener('pagehide', () => { cancelAuth(); player.release(); });
setClient(); persist(); render();
