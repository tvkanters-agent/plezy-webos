import './compat.js';
// SPDX-License-Identifier: GPL-3.0-only
import {VERSION, baseUrl, id, readState, saveState, nextFocus, time} from './core.js';
import {client, Jellyfin, Plex, plexPin, pollPlexPin, plexServers} from './api.js';
import {Player} from './player.js';
import {showPlexAlphaBar} from './alpha-bar.js';
import {mountAlphabetLibrary} from './library-alpha.js';
import {mountMediaBrowserAlphabet} from './library-prefix-alpha.js';
import {SimklTracker, validSession, beginSimklLink, pollSimklLink} from './simkl.js';
import {plexRatings, fetchMdblistRatings, mergeProviderRatings,
  mergeRatings, ratingBadgeInfo} from './ratings.js';
const main = document.querySelector('#main'), nav = document.querySelector('#nav'), dialog = document.querySelector('#dialog');
// Accessing localStorage itself may throw in a restricted webOS app context.
function tvStorage() {
  try { return window.localStorage; } catch (_) { return null; }
}
let state = readState(tvStorage()), api, route = {type: 'home'}, history = [], revision = 0, authAbort, toastTimer;
let detailMenu = null, ratingDialogReturnFocus = null;
let activeAlphabet = null;
const simklTracker = new SimklTracker(() => state.simkl, session => {
  state.simkl = session; persist();
}, message => notify(message));
let playbackReturn = null;
const player = new Player(document.querySelector('#player'), notify, playbackClosed, simklTracker);
// Plezy keeps the detail route beneath playback. Never clear/refetch that
// page after hiding the player: it flashes blank and discards remote focus.
function playbackClosed() {
  const previous = playbackReturn;
  playbackReturn = null;
  if (!previous || route !== previous.route || api !== previous.api) return;
  if (previous.focus && previous.focus.isConnected)
    focusWithoutJump(previous.focus, false);
  else focusFirst();
  if (route.type !== 'detail' || route.id !== previous.item.id) return;
  const expectedRevision = revision;
  previous.api.detail(route.id, route.kind).then(updated => {
    if (revision !== expectedRevision || route !== previous.route ||
        api !== previous.api || player.active) return;
    // Detail actions close over this item. Refresh it and the affected
    // controls in place rather than replacing the mounted screen.
    Object.assign(previous.item, updated);
    refreshDetailAction(main.querySelector('.detail-actions .detail-play'),
      updated.resume > 0 ? 'Resume · ' + time(updated.resume) : 'Play', 'play');
    const restart = main.querySelector('.detail-actions .detail-restart');
    if (restart) {
      restart.hidden = !(updated.resume > 0);
      if (restart.hidden && document.activeElement === restart)
        focusWithoutJump(main.querySelector('.detail-actions .detail-play'), false);
    }
    refreshDetailAction(main.querySelector('.detail-actions .detail-watched'),
      updated.watched ? 'Mark unwatched' : 'Mark watched',
      updated.watched ? 'unwatched' : 'watched');
  }).catch(() => { /* Keep the mounted page usable if metadata is offline. */ });
}
let rememberedPaneFocus = null;
let enterPaneAfterNavigation = false;
let pendingRailEntryRevision = null;
let lastRailRightRevision = null;
function preferredPaneControl() {
  // Enter media before the toolbar when coming from the remote's side rail.
  return main.querySelector('.grid .card, .shelf .card, .episode-list .episode-row, .cards .card') ||
    main.querySelector('button:not(:disabled),input,select');
}
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
function focusFirst(root = main, preferred = null, fromRail = false) {
  const expectedRevision = revision;
  requestAnimationFrame(() => {
    if (expectedRevision !== revision || !root.isConnected) return;
    // Plex/Jellyfin home content may finish asynchronously after the user
    // already moved from the page into the navigation rail. Do not steal
    // their active remote focus when an earlier render finally completes.
    const active = document.activeElement;
    // Initial focus is deferred to the next frame; an explicit D-pad or
    // programmatic focus into main before then must win over that default.
    if(root===main && active && active!==document.body && active!==main &&
       main.contains(active))return;
    // A render may finish after the user already returned to the rail;
    // never let a queued initial-focus animation override that decision.
    if (root === main && rememberedPaneFocus?.isConnected && nav.contains(active)) return;
    if (root === main && !fromRail && active && active !== document.body &&
        active !== main && !main.contains(active)) return;
    const railArt = root===main && lastRailRightRevision===expectedRevision
      ? preferredPaneControl() : null;
    focusWithoutJump(railArt || (preferred && root.contains(preferred) ? preferred :
      (root.querySelector('button:not(:disabled),input,select,.cast-strip[tabindex]') || root)));
  });
}
// Translation of media_detail/action_buttons.dart FilledButton and
// IconButton.filledTonal; use SVG so icons work without webOS font installs.
// TV SVG symbols use a single 24x24 coordinate system. A compound symbol
// must declare each stroke/fill separately: filling a collection of open
// paths produces distorted triangles (notably shuffle, restart and check).
const iconShapes = {
  play: [
    ['path', {d:'M8 5v14l11-7z',fill:'currentColor'}]
  ],
  restart: [
    ['path', {d:'M3 3v6h6',fill:'none',stroke:'currentColor',
      'stroke-width':'2','stroke-linecap':'round','stroke-linejoin':'round'}],
    ['path', {d:'M3.7 13a8.5 8.5 0 1 0 2.1-6.4',fill:'none',
      stroke:'currentColor','stroke-width':'2','stroke-linecap':'round'}]
  ],
  watched: [
    ['path',{d:'M4 12l5 5L20 6',fill:'none',stroke:'currentColor',
      'stroke-width':'2.8','stroke-linecap':'round','stroke-linejoin':'round'}]
  ],
  unwatched: [
    ['path',{d:'M3 12l4 4 6-6 M11 17l2 2 8-8 M4 4l16 16',fill:'none',
      stroke:'currentColor','stroke-width':'2.4','stroke-linecap':'round',
      'stroke-linejoin':'round'}]
  ],
  rating: [
    ['path',{d:'M12 2l3.1 6.4 7.1 1-5.1 5 .9 7-6-3.3-6 3.3.9-7-5.1-5 7.1-1z',
      fill:'none',stroke:'currentColor','stroke-width':'2','stroke-linejoin':'round'}]
  ],
  more: [
    ['circle', {cx:'5',cy:'12',r:'2',fill:'currentColor'}],
    ['circle', {cx:'12',cy:'12',r:'2',fill:'currentColor'}],
    ['circle', {cx:'19',cy:'12',r:'2',fill:'currentColor'}]
  ],
  sort: [
    ['path', {d:'M3 5h18v2H3z M3 11h12v2H3z M3 17h6v2H3z',fill:'currentColor'}]
  ],
  filter: [
    ['path', {d:'M3 4h18l-7 8v6l-4 2v-8L3 4z',fill:'currentColor'}]
  ],
  version: [
    ['path', {d:'M5 9l7 7 7-7',fill:'none',stroke:'currentColor',
      'stroke-width':'2','stroke-linecap':'round','stroke-linejoin':'round'}]
  ],
  next: [
    ['path', {d:'M5 4v16l12-8zm13 0h2v16h-2z',fill:'currentColor'}]
  ],
  shuffle: [
    ['path',{d:'M18 2l4 4-4 4 M18 14l4 4-4 4 M2 18h2.5c6 0 6-12 12-12H22 M2 6h2.5c2.8 0 4.3 2.6 5.8 5.4 M14.3 14.2c1.3 2.4 2.7 3.8 6.2 3.8H22',
      fill:'none',stroke:'currentColor','stroke-width':'2',
      'stroke-linecap':'round','stroke-linejoin':'round'}]
  ]
};
function detailButton(label, action, symbol, className = '') {
  const control = button(label, action, className);
  control.setAttribute('aria-label', label);
  control.setAttribute('title', label);
  if (symbol && iconShapes[symbol]) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox','0 0 24 24');
    svg.setAttribute('aria-hidden','true');
    iconShapes[symbol].forEach(([tag, attributes]) => {
      const shape = document.createElementNS('http://www.w3.org/2000/svg',tag);
      Object.keys(attributes).forEach(name => shape.setAttribute(name,attributes[name]));
      svg.appendChild(shape);
    });
    control.insertBefore(svg,control.firstChild);
  }
  return control;
}
function refreshDetailAction(control, label, symbol) {
  if (!control) return;
  const rendered = detailButton(label, () => {}, symbol);
  control.textContent = '';
  while (rendered.firstChild) control.appendChild(rendered.firstChild);
  control.setAttribute('aria-label', label);
  control.setAttribute('title', label);
}
function closeDetailMenu() {
  if (!detailMenu) return;
  const {menu, trigger} = detailMenu;
  menu.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
  detailMenu = null;
  if (trigger.isConnected) focusWithoutJump(trigger, false);
}
// Port of Plezy RatingBottomSheet / _RatingRow / _StarRatingControl.
// One focusable row per service; LEFT/RIGHT changes half-stars; OK saves.
// Pointer interaction chooses a 0-10 unit value across five star glyphs.
function closeRatingSheet() {
  dialog.hidden=true;
  const target=ratingDialogReturnFocus;
  ratingDialogReturnFocus=null;
  if(target?.isConnected) focusWithoutJump(target,false);
  else focusFirst();
}
function showRatingSheet(item, client, onSaved=()=>{}) {
  ratingDialogReturnFocus=document.activeElement;
  dialog.textContent='';
  dialog.append(el('h2','Rate '+item.title));
  const shell=el('div',undefined,'rating-sheet-rows');
  dialog.append(shell);
  let firstRow=null;
  function row(service, initial, tracker) {
    const control=button('',()=>{},'rating-row');
    // Set the callback explicitly: button() expects an action function.
    control.onclick=()=>save();
    control.dataset.service=service;
    const leading=el('div',undefined,'rating-service-logo');
    if(tracker) {
      const logo=el('img');logo.src='assets/simkl_mark.svg';logo.alt='';
      leading.append(logo);
    } else {
      const logo=el('img');logo.src='assets/plex_chevron.svg';logo.alt='';
      leading.append(logo);
    }
    const heading=el('div',undefined,'rating-service-heading');
    heading.append(el('strong',service),el('small',tracker?'Your Simkl rating':'Your Plex rating'));
    const stars=el('div',undefined,'rating-stars');
    const status=el('span','','rating-service-status');
    let chosen=Math.max(0,Math.min(10,Math.round(Number(initial)||0))),pending=false,dirty=false;
    const path='M12 2.5l2.94 5.95 6.56.95-4.75 4.64 1.12 6.54L12 17.49l-5.87 3.09 1.12-6.54L2.5 9.4l6.56-.95z';
    function renderStars() {
      stars.textContent='';
      for(let i=0;i<5;i++){
        const holder=el('span',undefined,'rating-star');
        const ns='http://www.w3.org/2000/svg';
        const svg=document.createElementNS(ns,'svg');
        svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
        const outline=document.createElementNS(ns,'path');
        outline.setAttribute('d',path);outline.setAttribute('fill','none');
        outline.setAttribute('stroke','currentColor');outline.setAttribute('stroke-width','1.8');
        svg.append(outline);
        const filledUnits=Math.max(0,Math.min(2,chosen-i*2));
        if(filledUnits){
          const fill=document.createElementNS(ns,'path');fill.setAttribute('d',path);
          fill.setAttribute('fill','#ffc857');
          if(filledUnits===1){
            const clip=document.createElementNS(ns,'clipPath');
            const id='rating-half-'+service.toLowerCase()+'-'+i;
            clip.setAttribute('id',id);
            const rect=document.createElementNS(ns,'rect');
            rect.setAttribute('x','0');rect.setAttribute('y','0');
            rect.setAttribute('width','12');rect.setAttribute('height','24');
            clip.append(rect);svg.append(clip);
            fill.setAttribute('clip-path','url(#'+id+')');
          }
          svg.append(fill);
        }
        holder.append(svg);
        holder.onclick=event=>{
          event.preventDefault();event.stopPropagation();
          const x=event.offsetX;
          chosen=i*2+(x<holder.clientWidth/2?1:2);
          dirty=true;
          renderStars();save();
        };
        stars.append(holder);
      }
      control.setAttribute('aria-label',service+' rating '+chosen+' out of 10');
    }
    control.ratingChange=delta=>{
      dirty=true;
      chosen=Math.max(0,Math.min(10,chosen+delta));renderStars();
      status.textContent=chosen?'Selected '+(chosen/2).toFixed(1)+' stars':'Not rated';
    };
    async function save(value=chosen) {
      if(pending)return;
      pending=true;status.textContent='Saving…';
      try{
        if(tracker)await simklTracker.rateTitle(client,item,value||null);
        else await client.rate(item,value||-1);
        if(!tracker)item.raw.userRating=value;
        status.textContent='Saved';
        onSaved({tracker,value});
        closeRatingSheet();
      }catch(error){status.textContent='Could not save: '+error.message;}
      finally{pending=false;}
    }
    control.append(leading,heading,stars,status);
    renderStars();
    if(!firstRow)firstRow=control;
    shell.append(control);
    return {control,status,setScore:value=>{
      // An in-flight Simkl read must not replace a user's selection or save
      // result after they have begun editing this service.
      if(dirty||pending)return;
      chosen=Number(value)||0;renderStars();status.textContent=chosen?'Your rating '+(chosen/2).toFixed(1)+' stars':'Not rated';
    }};
  }
  row('Plex',item.raw?.userRating||0,false);
  if(validSession(state.simkl)&&['movie','show'].includes(item.type)){
    const simkl=row('Simkl',0,true);
    simkl.status.textContent='Loading…';
    simklTracker.getTitleRating(client,item).then(value=>{
      if(simkl.control.isConnected)simkl.setScore(value);
    }).catch(error=>{
      if(simkl.control.isConnected)simkl.status.textContent='Unavailable: '+error.message;
    });
  }
  dialog.append(button('Close',closeRatingSheet));
  dialog.hidden=false;
  // Dialog focus must be synchronous: a queued rAF to Plex's first row
  // otherwise steals focus after the user selects the Simkl row.
  focusWithoutJump(firstRow,false);
}
function detailMoreOptions(options) {
  const group = el('div', undefined, 'detail-more');
  const menu = el('div', undefined, 'detail-more-menu');
  menu.hidden = true;
  const trigger = detailButton('More options', () => {
    if (!menu.hidden) { closeDetailMenu(); return; }
    closeDetailMenu();
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    detailMenu = {menu, trigger};
    focusWithoutJump(menu.querySelector('button'), false);
  }, 'more', 'detail-icon');
  trigger.setAttribute('aria-haspopup', 'true');
  trigger.setAttribute('aria-expanded', 'false');
  options.forEach(option => menu.append(button(option.label, () => {
    closeDetailMenu();
    option.action();
  }, 'detail-more-option')));
  group.append(trigger, menu);
  return group;
}
function resolutionLabel(value) {
  if (value == null || value === '') return '';
  const label=String(value);
  return /^[0-9]+$/.test(label) ? label + 'p' : label.toUpperCase();
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
  if (iconName === 'settings') shape.setAttribute('fill-rule','evenodd');
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
  const fromRail = nav.contains(document.activeElement);
  enterPaneAfterNavigation = fromRail;
  rememberedPaneFocus = null;
  if (remember) {
    // Flutter retains the covered route's subtree. Preserve this rendered
    // page and its scroll/focus state instead of refetching and repainting it
    // when a movie/episode detail is dismissed.
    const snapshot = document.createDocumentFragment();
    const scroll = main.scrollTop;
    const focused = main.contains(document.activeElement) ?
      document.activeElement.dataset.focus : null;
    const alphabet = activeAlphabet;
    if (alphabet) { alphabet.suspend(); activeAlphabet = null; }
    while (main.firstChild) snapshot.appendChild(main.firstChild);
    history.push({route:{...route,scroll,focus:focused},snapshot,sourceApi:api,alphabet});
    if (history.length > 8) {
      const discarded = history.shift();
      if (discarded.alphabet) discarded.alphabet.destroy();
    }
  }
  route = next; render();
}
function cancelAuth() { if (authAbort) { authAbort.abort(); authAbort = null; } }
function back() {
  if (detailMenu) { closeDetailMenu(); return; }
  if (!dialog.hidden) {
    if(ratingDialogReturnFocus){closeRatingSheet();return;}
    dialog.hidden = true; focusFirst(); return;
  }
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
      main.classList.toggle('has-alpha-bar', !!previous.alphabet);
      if (previous.alphabet) {
        const restoredRevision = revision;
        activeAlphabet = previous.alphabet;
        activeAlphabet.resume(() => revision === restoredRevision);
      }
      const focused = Array.from(main.querySelectorAll('[data-focus]')).find(
        node => node.dataset.focus === route.focus);
      if (focused) focusWithoutJump(focused, false);
      else focusFirst();
      schedulePosters();
    } else {
      if (previous.alphabet) previous.alphabet.destroy();
      render();
    }
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
    // Flutter's OptimizedMediaImage shows synchronously cached frames without
    // fading; only artwork arriving asynchronously transitions over 300ms.
    if (img.complete && img.naturalWidth > 0) img.classList.add('artwork-ready');
  }
}
function schedulePosters() {
  if (!posterFrame) posterFrame = requestAnimationFrame(loadVisiblePosters);
}
main.addEventListener('scroll', schedulePosters, true);
// OptimizedMediaImage uses Symbols.person_rounded in Plezy's cast strip and actor screen.
// Use the same filled person fallback for absent, pending and failed images on Chromium 53.
function personPortrait(imageUrl, className) {
  const node=el('div',undefined,className);
  const fallback=el('span',undefined,'person-placeholder');
  fallback.setAttribute('aria-hidden','true');
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 24 24');
  const path=document.createElementNS('http://www.w3.org/2000/svg','path');
  path.setAttribute('d','M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v1c0 .55.45 1 1 1h14c.55 0 1-.45 1-1v-1c0-2.66-5.33-4-8-4z');
  path.setAttribute('fill','currentColor');
  svg.appendChild(path);fallback.appendChild(svg);node.appendChild(fallback);
  if (imageUrl) {
    const img=el('img');img.alt='';img.style.visibility='hidden';
    img.onload=()=>{img.style.visibility='visible';};
    img.onerror=()=>{img.remove();};
    img.setAttribute('data-poster-src',imageUrl);
    node.appendChild(img);
  }
  return node;
}
// Plezy's OptimizedMediaImage uses an opaque surface while waiting and a
// subdued image-not-supported icon only when no artwork can be displayed.
function unavailablePoster(node) {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('class', 'poster-fallback');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', 'M21 5v12.17l-2-2V5H6.83l-2-2H19c1.1 0 2 .9 2 2zM2.1 2.1.69 3.51 2 4.83V19c0 1.1.9 2 2 2h14.17l1.32 1.32 1.41-1.41L2.1 2.1zM4 19V6.83l5.59 5.59L6 17h11.17l2 2H4z');
  icon.append(path);
  node.textContent = '';
  node.append(icon);
}
function poster(item, options = {}) {
  const node = el('div', undefined, 'poster'); const image = api.image(item, options);
  if (image) {
    const img = el('img'); img.alt = ''; img.setAttribute('data-poster-src', image);
    // A src-less <img> draws Chromium's white broken-image box even while
    // queued for lazy loading. Reveal only a successfully decoded image.
    img.onload = () => {
      if (!img.classList.contains('artwork-ready')) img.classList.add('artwork-loaded');
    };
    img.onerror = () => { img.remove(); unavailablePoster(node); };
    node.append(img);
  } else unavailablePoster(node);
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
    resolutionLabel(item.raw?.Media?.[0]?.videoResolution)].filter(Boolean);
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
      const page = options.initialPage && start === 0 ? options.initialPage : await loader(start);
      options.initialPage = null;
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
  pendingRailEntryRevision=null;lastRailRightRevision=null;
  const focusFromRail = enterPaneAfterNavigation;
  enterPaneAfterNavigation = false;
  let preferredFocus = null;
  cancelAuth(); detailMenu = null;
  if (activeAlphabet) { activeAlphabet.destroy(); activeAlphabet = null; }
  main.classList.remove('has-alpha-bar');
  main.textContent = ''; main.scrollTop = 0; navigation();
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
        if (valid()) focusFirst(main, focusFromRail ? preferredPaneControl() : null, focusFromRail);
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
        schedulePosters();
        if (valid()) focusFirst(main, focusFromRail ? preferredPaneControl() : null, focusFromRail);
        return;
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
      const libraryLoader = (start, count) =>
        currentApi.list(route.library.id, start, selected, selectedFilter, count,
          currentApi instanceof Jellyfin ? route.alpha : undefined);
      if (currentApi instanceof Plex && selected === 'title') {
        // Flutter LibraryBrowseTab starts the first page and firstCharacter
        // fetch together; hide the rail on an unsupported server/failed index.
        const [pageResult, characters] = await Promise.all([
          libraryLoader(0).catch(error => ({error})),
          currentApi.firstCharacters(route.library.id, selectedFilter).catch(() => [])
        ]);
        if (!valid()) return;
        if (pageResult.error) {
          await paginated(start => libraryLoader(start), currentRevision);
        } else if (showPlexAlphaBar(pageResult.total, characters, selected)) {
          main.classList.add('has-alpha-bar');
          activeAlphabet = mountAlphabetLibrary({
            main, firstPage: pageResult, characters,
            loader: (start, count) => libraryLoader(start, count),
            card, schedulePosters, focusWithoutJump, isActive: valid
          });
        } else {
          await paginated(start => libraryLoader(start), currentRevision, {initialPage: pageResult});
        }
      } else if (currentApi instanceof Jellyfin) {
        // Native MediaBrowserAlphaBarStrategy uses a synthetic 27-letter
        // NameStartsWith filter rather than the Plex offset/scroll strategy.
        const firstPage = await libraryLoader(0).catch(error => ({error}));
        if (!valid()) return;
        if (firstPage.error) {
          await paginated(start => libraryLoader(start), currentRevision);
        } else if (firstPage.total >= 80 || route.alpha) {
          main.classList.add('has-alpha-bar');
          await paginated(start => libraryLoader(start), currentRevision, {initialPage:firstPage});
          if (!valid()) return;
          activeAlphabet = mountMediaBrowserAlphabet({
            main, selected:route.alpha, focusWithoutJump,
            onPrefixChange: next => go({...route, alpha:next, alphaFocus:true}, false)
          });
        } else {
          await paginated(start => libraryLoader(start), currentRevision, {initialPage:firstPage});
        }
      } else {
        await paginated(start => libraryLoader(start), currentRevision);
      }
      if (valid() && route.alphaFocus && activeAlphabet) activeAlphabet.focus();
      if (valid() && pendingRailEntryRevision===currentRevision) {
        pendingRailEntryRevision=null;
        focusFirst(main, preferredPaneControl(), true);
      }
    } else if (route.type === 'person' && api instanceof Plex) {
      // Plezy ActorMediaScreen._buildActorHeader, not a movie-detail poster.
      const currentApi=api;
      const header=el('section',undefined,'actor-hero');
      const identity=el('div',undefined,'actor-identity');
      const portrait=personPortrait(route.thumb?
        currentApi.image({poster:route.thumb}):'', 'actor-avatar');
      const labels=el('div',undefined,'actor-heading');
      labels.append(el('h1',route.actor||'Cast member'));
      if(route.role)labels.append(el('p',route.role,'actor-role'));
      const count=el('p','','actor-count');
      labels.append(count);identity.append(portrait,labels);header.append(identity);
      const facts=el('div',undefined,'actor-facts');
      const bio=el('div',undefined,'actor-biography');
      header.append(facts,bio);main.append(header);
      // The catalog lookup must survive unavailable Plex Discover details.
      currentApi.personDetails(route.id).then(details=>{
        if(!valid()||!header.isConnected||!details)return;
        const formatDate=value=>{
          if(!value)return '';
          const date=new Date(value);
          return Number.isNaN(date.valueOf())?String(value):date.toLocaleDateString(undefined,
            {year:'numeric',month:'long',day:'numeric'});
        };
        for(const [label,value] of [['Born',details.bornAt],['Died',details.diedAt],
          ['Birthplace',details.birthPlace]]){
          if(!value)continue;
          const line=el('p',undefined,'actor-fact');
          line.append(el('span',label+'  '),document.createTextNode(
            label==='Birthplace'?value:formatDate(value)));
          facts.append(line);
        }
        if(details.biography){
          const text=el('p',details.biography,'actor-biography-text');
          const long=details.biography.length>320;
          if(long)text.classList.add('collapsed');
          bio.append(text);
          if(long){
            const expand=button('Show more',()=>{
              const open=text.classList.toggle('collapsed');
              expand.textContent=open?'Show more':'Show less';
            },'actor-biography-toggle');
            expand.dataset.focus='actor-biography';
            bio.append(expand);
          }
        }
      }).catch(()=>{});
      await paginated(async start=>{
        const page=await currentApi.personMedia(route.id,start,route.actor);
        if(!start&&valid()&&header.isConnected) count.textContent=
          page.total+' '+(page.total===1?'title':'titles');
        return page;
      },currentRevision);
    } else if (route.type === 'search') searchForm();
    else if (route.type === 'detail') {
      const item = await api.detail(route.id, route.kind); if (!valid()) return;
      const isPlexShow = api instanceof Plex && item.type === 'show';
      const isSeason = item.type === 'season' || item.type === 'Season';
      const isEpisode = item.type === 'episode' || item.type === 'Episode';
      const raw = item.raw || {};
      // Season and episode metadata is often sparse in Plex; upstream Plezy's
      // detail header also knows the containing show.
      const parentShowId = api instanceof Plex
        ? (isSeason ? raw.parentRatingKey : isEpisode ? raw.grandparentRatingKey : null)
        : null;
      let parentShow = null;
      if (parentShowId) {
        try { parentShow = await api.detail(parentShowId, 'show'); }
        catch (_) { /* Standalone season/episode detail remains usable. */ }
        if (!valid()) return;
      }
      const showRaw = parentShow?.raw || {};
      const content = el('div', undefined, 'detail'), info = el('div', undefined, 'detail-info');
      if (isSeason) content.classList.add('detail-season');
      content.classList.add(item.type === 'episode' || item.type === 'Episode' ? 'detail-episode' : 'detail-media');
      const heroMedia = item.background ? item : (parentShow?.background ? parentShow : null);
      if (api instanceof Plex && heroMedia) {
        const hero = el('div', undefined, 'detail-backdrop');
        // Server-transcoded low-resolution artwork, not a source-sized image.
        hero.style.backgroundImage = 'linear-gradient(to right, #0e0f12 2%, rgba(14,15,18,.86) 48%, rgba(14,15,18,.2)), linear-gradient(to top, #0e0f12, transparent 65%), url("' +
          api.backdrop(heroMedia).replace(/"/g, '%22') + '")';
        main.append(hero);
      }
      if (parentShow) {
        const parentLink = button(parentShow.title, () => go({type:'detail',id:parentShow.id,kind:'show'}), 'detail-series-link');
        parentLink.dataset.focus = 'detail-series';
        info.append(parentLink);
        if (isEpisode && raw.parentIndex != null && raw.index != null)
          info.append(el('p', 'Season ' + raw.parentIndex + ' · Episode ' + raw.index, 'detail-context'));
      }
      if (raw.tagline || showRaw.tagline)
        info.append(el('p', raw.tagline || showRaw.tagline, 'detail-tagline'));
      info.append(el('h1', item.title));
      // Source: MediaDetailScreen._buildMetadataChip and hero chip rows.
      // Keep each field as a distinct Material tonal pill, not a sentence.
      const chips = el('div', undefined, 'detail-chips');
      const media = raw.Media && raw.Media[0] || {};
      const facts = [raw.year || showRaw.year, raw.editionTitle, raw.contentRating || showRaw.contentRating,
        item.duration ? time(item.duration) : '',
        resolutionLabel(media.videoResolution)].filter(Boolean);
      facts.forEach(value => chips.append(el('span', String(value), 'detail-chip')));
      // Community scores load asynchronously. The chip row MUST exist even
      // for a show lacking year, duration and quality metadata; otherwise
      // external provider badges are appended to a detached element.
      info.append(chips);
      // Plezy _buildFittedHeroChips: branded scores are ONE tonal chip
      // in the SAME metadata run as year/runtime/certification, not a new row.
      const ratingLine=el('span',undefined,'ratings-chip');
      const ratingItem=isSeason||isEpisode?parentShow:item;
      const simklReady=validSession(state.simkl),mdblistReady=!!state.mdblistApiKey;
      // Don't block Plex-only scores when no external rating source is active.
      let ratingsLoading=!!(api instanceof Plex&&ratingItem&&
        ['movie','show'].includes(ratingItem.type)&&(simklReady||mdblistReady));
      let ownRating=null,ownRatingChanged=false,community=[],ownRatings=plexRatings(api instanceof Plex ?
        (isSeason||isEpisode?showRaw:raw) : raw);
      function showRatings() {
        ratingLine.textContent='';
        ratingLine.classList.toggle('rating-loading',ratingsLoading);
        ratingLine.setAttribute('aria-busy',String(ratingsLoading));
        ratingLine.setAttribute('aria-label',ratingsLoading?'Loading community ratings':'Community ratings');
        if(ratingsLoading){
          const spinner=el('span',undefined,'rating-spinner');
          spinner.setAttribute('aria-hidden','true');
          ratingLine.append(spinner);
          if(!ratingLine.isConnected)chips.append(ratingLine);
          return;
        }
        const all=mergeRatings(ownRatings,community);
        all.forEach(score=>{
          const details=ratingBadgeInfo(score.source,score.value);
          const entry=el('span',undefined,'rating-badge');
          entry.setAttribute('aria-label',details.label+' '+details.value);
          if(details.src){
            const image=el('img');image.src=details.src;image.alt='';
            image.style.width=(16*details.aspect)+'px';image.style.height='16px';
            if(score.source==='simkl'||score.source==='mal')image.className='rating-monochrome';
            entry.append(image);
          }else entry.append(el('span',score.source==='audience'?'●':'★','rating-fallback'));
          entry.append(el('span',details.value));
          ratingLine.append(entry);
        });
        if(ownRating!=null&&ownRating>0){
          const entry=el('span',undefined,'rating-badge rating-personal');
          entry.setAttribute('aria-label','Your Simkl rating '+ownRating+'/10');
          const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');
          icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('aria-hidden','true');
          const head=document.createElementNS('http://www.w3.org/2000/svg','circle');
          head.setAttribute('cx','12');head.setAttribute('cy','7.5');head.setAttribute('r','3.5');
          head.setAttribute('fill','currentColor');
          const bust=document.createElementNS('http://www.w3.org/2000/svg','path');
          bust.setAttribute('d','M4 21v-2.5C4 14 7.5 12 12 12s8 2 8 6.5V21z');
          bust.setAttribute('fill','currentColor');
          icon.append(head,bust);
          entry.append(icon,el('span',String(ownRating)));
          ratingLine.append(entry);
        }
        if(ratingLine.children.length&&!ratingLine.isConnected)chips.append(ratingLine);
        if(!ratingLine.children.length&&ratingLine.isConnected)ratingLine.remove();
      }
      showRatings();
      if(ratingsLoading) {
        const expected=currentRevision;
        const stillCurrent=()=>revision===expected&&info.isConnected;
        // All active sources start independently. Keep the loader inside
        // the pill, then publish their combined result in a single render.
        const personalTask=simklReady?simklTracker.getTitleRating(api,ratingItem)
          .then(score=>{if(stillCurrent()&&!ownRatingChanged)ownRating=score;})
          .catch(error=>console.warn('Personal Simkl rating unavailable',error)):Promise.resolve();
        const communityTask=(async()=>{
          const resolved=Object.assign({},ratingItem.raw||{});
          // Plex listing rows can omit GUIDs required by Simkl / MDBList.
          try {
            const ids=await api.fetchExternalIds(ratingItem.id);
            const old=Array.isArray(resolved.Guid)?resolved.Guid:[];
            resolved.Guid=[...old];
            for(const [key,value] of Object.entries(ids)) {
              if(!resolved.Guid.some(entry=>entry?.id===key+'://'+value))
                resolved.Guid.push({id:key+'://'+value});
            }
          }catch(error){console.warn('Could not enrich Plex rating IDs',error);}
          if(!stillCurrent())return;
          const requests=[];
          if(simklReady)requests.push({origin:'simkl',
            promise:simklTracker.getCommunityRatings(resolved,ratingItem.type)});
          if(mdblistReady)requests.push({origin:'mdblist',
            promise:fetchMdblistRatings(resolved,ratingItem.type,state.mdblistApiKey)});
          // Promise.allSettled is unavailable in older webOS Chromium. Handle
          // each provider independently so one failure never hides the rest.
          const answers=await Promise.all(requests.map(async request=>{
            try{return {origin:request.origin,ratings:await request.promise};}
            catch(error){
              console.warn(request.origin+' ratings unavailable',error);
              return {origin:request.origin,ratings:[]};
            }
          }));
          if(stillCurrent())community=mergeProviderRatings(answers);
        })();
        Promise.all([communityTask,personalTask]).then(()=>{
          if(!stillCurrent())return;
          ratingsLoading=false;
          showRatings();
        }).catch(error=>{
          console.warn('Rating loading failed',error);
          if(!stillCurrent())return;
          ratingsLoading=false;
          showRatings();
        });
      }
      const genreChips = el('div', undefined, 'detail-chips detail-genres');
      (Array.isArray(raw.Genre) && raw.Genre.length ? raw.Genre : showRaw.Genre || []).forEach(genre => {
        if (genre.tag) genreChips.append(el('span', genre.tag, 'detail-chip'));
      });
      if (genreChips.children.length) info.append(genreChips);
      if (item.summary || (isSeason && parentShow?.summary))
        info.append(el('p', item.summary || parentShow.summary, 'detail-summary'));
      if (isSeason && parentShow?.summary && item.summary && item.summary !== parentShow.summary) {
        const showSynopsis = el('div', undefined, 'detail-parent-overview');
        showSynopsis.append(el('strong', 'About ' + parentShow.title),
          el('p', parentShow.summary));
        info.append(showSynopsis);
      }
      if (api instanceof Plex) {
        const tags = values => (Array.isArray(values) ? values : []).map(x => x.tag || x.title).filter(Boolean);
        const metaRows = [
          // Genres are already displayed as Flutter-style hero chips.
          ['Directors', tags(raw.Director)],
          ['Writers', tags(raw.Writer)]
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
            if (next) {
              try { return await api.detail(next.id,'episode'); }
              catch (_) { return next; }
            }
          } catch (_) { /* On Deck is optional */ }
        }
        const first = await api.children(item.id);
        if (item.type === 'season' || item.type === 'Season')
          return first.items.find(e => e.type === 'episode' || e.type === 'Episode') || null;
        let firstEpisode=null;
        for (const season of first.items) {
          const episodes = await api.children(season.id);
          const candidates=episodes.items.filter(e => e.type === 'episode' || e.type === 'Episode');
          const resumed=candidates.find(e=>e.resume>0);
          if(resumed) {
            try { return await api.detail(resumed.id,'episode'); }
            catch (_) { return resumed; }
          }
          if(!firstEpisode)firstEpisode=candidates.find(e=>!e.watched)||candidates[0];
        }
        if(firstEpisode)return firstEpisode;
        return null;
      };
      if (item.folder && (isPlexShow || isSeason)) {
        const expectedRevision = revision, currentApi = api;
        actions.append(detailButton('Play', async () => {
          const episode = await chooseEpisode();
          if (revision !== expectedRevision || api !== currentApi) return;
          if (episode) play(episode, episode.resume || 0);
          else notify('No playable episodes were found.');
        }, 'play', 'detail-play'));
        // Show/season actions from MediaDetailScreen.action_buttons.dart.
        actions.append(detailButton('Shuffle', async () => {
          const currentApi = api, expected = revision;
          let start = 0, all = [];
          while (start < 10000) {
            const page = await currentApi.children(item.id, start, item.type);
            all = all.concat(page.items.filter(x => x.type === 'episode' || x.type === 'Episode'));
            start += page.items.length;
            if (!page.items.length || start >= page.total) break;
          }
          if (expected !== revision || currentApi !== api) return;
          if (all.length) {
            const random = all[Math.floor(Math.random() * all.length)];
            play(random, 0);
          } else notify('No playable episodes were found.');
        }, 'shuffle', 'detail-icon'));
        actions.append(detailButton(item.watched ? 'Mark unwatched' : 'Mark watched', async () => {
          const currentApi = api, watched = !item.watched;
          await currentApi.watched(item, watched);
          render();
        }, item.watched ? 'unwatched' : 'watched', 'detail-icon detail-watched'));
        if (api instanceof Plex) actions.append(detailButton('Rate',()=>showRatingSheet(item,api,
          ({tracker,value})=>{
            if(tracker && ratingItem?.id===item.id){ownRatingChanged=true;ownRating=value;showRatings();}
          }),'rating','detail-icon'));
        const extra = [];
        if (parentShow) extra.push({label:'View series', action:() =>
          go({type:'detail',id:parentShow.id,kind:'show'})});
        if (extra.length) actions.append(detailMoreOptions(extra));
      } else if (!item.folder) {
        const versions = api instanceof Plex ? item.raw.Media || [] : [];
        if (item.resume > 0) actions.append(detailButton('Resume · ' + time(item.resume),
          () => play(item, item.resume), 'play', 'detail-play'));
        else actions.append(detailButton('Play', () => play(item, item.resume || 0), 'play', 'detail-play'));
        if (versions.length > 1) {
          const version = el('label', undefined, 'detail-version');
          const select = el('select'); select.setAttribute('aria-label', 'Media version');
          select.dataset.focus = 'media-version';
          versions.forEach((media, index) => {
            const label = [resolutionLabel(media.videoResolution), media.videoCodec, media.audioCodec]
              .filter(Boolean).join(' · ');
            const option = el('option', 'Version ' + (index + 1) + (label ? ' · ' + label : ''));
            option.value = String(index); select.append(option);
          });
          select.value = String(route.mediaIndex || 0);
          select.onchange = () => { route.mediaIndex = Number(select.value); };
          version.append(select); actions.append(version);
        }
        const restart = detailButton('Play from beginning',
          () => play(item, 0), 'restart', 'detail-icon detail-restart');
        restart.hidden = !(item.resume > 0);
        actions.append(restart);
        actions.append(detailButton(item.watched ? 'Mark unwatched' : 'Mark watched', async () => {
          const currentApi = api, watched = !item.watched;
          await currentApi.watched(item, watched);
          if (currentApi instanceof Plex) simklTracker.markWatched(currentApi, item, watched);
          render();
        }, item.watched ? 'unwatched' : 'watched', 'detail-icon detail-watched'));
        if (api instanceof Plex) actions.append(detailButton('Rate',()=>showRatingSheet(item,api,
          ({tracker,value})=>{
            if(tracker && ratingItem?.id===item.id){ownRatingChanged=true;ownRating=value;showRatings();}
          }),'rating','detail-icon'));
        if (api instanceof Plex && item.type === 'episode' && raw.parentRatingKey) {
          actions.append(detailButton('Next episode', async () => {
            const expected = revision, currentApi = api;
            const next = await currentApi.nextEpisode(item);
            if (expected !== revision || currentApi !== api) return;
            if (next) go({type:'detail',id:next.id,kind:next.type});
            else notify('No further episodes are available for this show.');
          }, 'next', 'detail-icon'));
        }
        const extra = [
          {label:'Compatible playback', action:() => play(item, item.resume, true)}
        ];
        if (parentShow) extra.push({label:'View series', action:() =>
          go({type:'detail',id:parentShow.id,kind:'show'})});
        if (isEpisode && raw.parentRatingKey) extra.push({label:'View season', action:() =>
          go({type:'detail',id:raw.parentRatingKey,kind:'season'})});
        actions.append(detailMoreOptions(extra));
      }
      info.append(actions);
      // A show link appears first in episode details, but playback is the
      // primary remote action. Start focus on Resume (or Play if unwatched).
      if (isEpisode) preferredFocus = actions.querySelector('.detail-play');
      if (!item.background && !isEpisode) content.append(poster(item.poster ? item : (parentShow || item), {detail:true}));
      content.append(info);
      if (isEpisode)
        content.append(poster(item, {detail:true,landscape:true}));
      else if (isSeason && item.background)
        content.append(poster(item.poster ? item : (parentShow || item), {detail:true}));
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
      // Port CastMemberStrip: one locked-focus D-pad row, internal horizontal
      // scroll with no browser scrollbar, placed AFTER seasons/episodes.
      const cast=Array.isArray(raw.Role) && raw.Role.length ? raw.Role :
        (Array.isArray(showRaw.Role) ? showRaw.Role : []);
      if (cast.length && api instanceof Plex) {
        const section=el('section',undefined,'cast-section');
        section.append(el('h2','Cast'));
        const strip=el('div',undefined,'cast-strip');
        strip.tabIndex=0; strip.dataset.focus='detail-cast';
        strip.setAttribute('role','group');strip.setAttribute('aria-label','Cast');
        const tiles=[];
        const actors=cast.slice(0,20);
        const openActor = actor => {
          if (!actor.id) {notify('This Plex server has no person ID for '+(actor.tag||'the actor'));return;}
          go({type:'person',id:String(actor.id),actor:actor.tag||'Actor',thumb:actor.thumb,role:actor.role});
        };
        actors.forEach((actor,index)=>{
          const tile=el('div',undefined,'cast-member');
          const picture=personPortrait(actor.thumb?
            api.image({poster:actor.thumb}):'', 'cast-picture');
          tile.append(picture,el('strong',actor.tag||actor.title||'Unknown'));
          if (actor.role) tile.append(el('small',actor.role));
          tile.onclick=()=>{select(index);openActor(actor);};
          tiles.push(tile);strip.append(tile);
        });
        let selectedIndex=0;
        function select(index) {
          selectedIndex=Math.max(0,Math.min(tiles.length-1,index));
          tiles.forEach((tile,i)=>tile.classList.toggle('cast-selected',i===selectedIndex));
          const tile=tiles[selectedIndex];
          // Match Plezy's scrollListToIndex: keep the selected card visible,
          // but don't jump it to the left while it already fits on screen.
          if(strip.clientWidth) {
            const start=tile.offsetLeft-tiles[0].offsetLeft;
            const end=start+tile.offsetWidth, edge=10;
            if(start<strip.scrollLeft+edge)
              strip.scrollLeft=Math.max(0,start-edge);
            else if(end>strip.scrollLeft+strip.clientWidth-edge)
              strip.scrollLeft=end-strip.clientWidth+edge;
          }
          strip.setAttribute('aria-label','Cast: '+(actors[selectedIndex].tag||'Actor')+
            (actors[selectedIndex].role?' as '+actors[selectedIndex].role:''));
        }
        strip.addEventListener('focus',()=>select(selectedIndex));
        strip.castKey = code => {
          if(code===37)select(selectedIndex-1);
          if(code===39)select(selectedIndex+1);
          if(code===13)openActor(actors[selectedIndex]);
        };
        select(0);
        section.append(strip); main.append(section);
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
      if (found) focusWithoutJump(found, false);
      else focusFirst(main, focusFromRail ? preferredPaneControl() : preferredFocus, focusFromRail);
    } else if (!(route.alphaFocus && activeAlphabet))
      focusFirst(main, focusFromRail ? preferredPaneControl() : preferredFocus, focusFromRail);
  }
}
function play(item, start, transcode = false) {
  playbackReturn = {
    route, api, item,
    focus: main.contains(document.activeElement) ? document.activeElement : null
  };
  return player.open(api, item, {start, mediaIndex: route.mediaIndex || 0,
    transcode: transcode || state.quality === 'transcode'});
}
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
  // Upstream Plezy's MDBList catalog source contributes IMDB, RT critic/
  // audience, TMDB, Metacritic, Letterboxd, Trakt, and MAL ratings. The
  // remote is used only after the account owner opts in with an API key.
  const ratingsPanel=el('section',undefined,'panel');
  ratingsPanel.append(el('h2','MDBList community ratings'));
  ratingsPanel.append(el('p','Optional: provide an MDBList API key to show additional source ratings in the same Plezy score pill. Ratings require a connected account; Plex and Simkl ratings work independently.','muted'));
  if(state.mdblistApiKey){
    ratingsPanel.append(el('p','MDBList connected. Scores are fetched with your own account quota.','muted'));
    ratingsPanel.append(button('Disconnect MDBList',()=>{
      state.mdblistApiKey='';persist();render();
    }));
  }else{
    const form=el('form');
    const keyInput=el('input');
    keyInput.type='password';keyInput.required=true;
    keyInput.placeholder='MDBList API key';
    keyInput.setAttribute('aria-label','MDBList API key');
    keyInput.autocomplete='off';
    const submit=el('button','Connect MDBList');submit.type='submit';
    const message=el('p','','muted');message.setAttribute('role','status');
    form.append(keyInput,submit,message);
    form.onsubmit=async event=>{
      event.preventDefault();
      const key=keyInput.value.trim(),expected=revision;
      if(!key)return;
      submit.disabled=true;message.textContent='Checking MDBList key…';
      try{
        const url=new URL('https://api.mdblist.com/user');
        url.searchParams.set('apikey',key);
        const response=await fetch(url.href,{headers:{Accept:'application/json'}});
        if(!response.ok)throw new Error('MDBList verification failed (HTTP '+response.status+').');
        if(expected!==revision)return;
        state.mdblistApiKey=key;persist();keyInput.value='';render();
      }catch(error){
        if(expected===revision)message.textContent=error.message;
      }finally{submit.disabled=false;}
    };
    ratingsPanel.append(form);
  }
  main.append(ratingsPanel);
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
  // AlphaJumpBar's FocusNode consumes remote arrows/OK/Back before the
  // application-wide back handler. Left and Back return to the visible grid.
  if (activeAlphabet && activeAlphabet.handleKey(event.keyCode)) {
    event.preventDefault(); return;
  }
  if ([461, 27].includes(event.keyCode)) { event.preventDefault(); back(); return; }
  const direction = {37: 'left', 38: 'up', 39: 'right', 40: 'down'}[event.keyCode];
  const ratingControl=document.activeElement;
  if(!dialog.hidden && ratingControl?.classList.contains('rating-row') &&
     [37,39].includes(event.keyCode)) {
    event.preventDefault();
    ratingControl.ratingChange?.(event.keyCode===39?1:-1);
    return;
  }
  // CastMemberStrip captures OK as a locked-focus row (there is no focused
  // child button for the browser to synthesize a click on).
  if (event.keyCode===13 && document.activeElement?.classList.contains('cast-strip')) {
    event.preventDefault();document.activeElement.castKey?.(13);return;
  }
  if (!direction) return;
  const current = document.activeElement;
  if (current.classList?.contains('cast-strip') && [37,39,13].includes(event.keyCode)) {
    event.preventDefault();
    current.castKey?.(event.keyCode);
    return;
  }
  if (current.tagName === 'SELECT' && ['left', 'right'].includes(direction)) {
    event.preventDefault(); current.selectedIndex = Math.max(0, Math.min(current.options.length - 1, current.selectedIndex + (direction === 'left' ? -1 : 1)));
    current.dispatchEvent(new Event('change')); return;
  }
  if (current.tagName === 'INPUT' && ['left', 'right'].includes(direction)) return;
  event.preventDefault();
  const root = !dialog.hidden ? dialog : player.active ? player.root : document.querySelector('#shell');
  const inRail = nav.contains(current);
  const inMain = main.contains(current);
  if (activeAlphabet && route.type === 'library' && (route.view||'browse') === 'browse' &&
      inMain && direction === 'right' && current.matches('.grid .card')) {
    const rect = current.getBoundingClientRect();
    const later = Array.from(main.querySelectorAll('.grid .card')).some(node => {
      const other = node.getBoundingClientRect();
      return other.left > rect.left + 5 && Math.abs(other.top - rect.top) < 4;
    });
    if (!later) { activeAlphabet.focus(); return; }
  }
  // D-pad navigation follows the original Flutter navigation zones:
  // Up/Down stay in the current rail or page. A left press in the sidebar
  // never jumps diagonally to a different item in the sidebar.
  if (dialog.hidden && !player.active && inRail && direction === 'left') return;
  // The rail is one focus zone. RIGHT must leave it even if another rail
  // item happens to be geometrically to the right (indented libraries).
  if (dialog.hidden && !player.active && inRail && direction === 'right') {
    lastRailRightRevision=revision;
    if (route.type==='library' && !main.querySelector('.grid .card,.shelf .card')) {
      // RIGHT is an explicit intent to enter the media grid, even when
      // the first paged fetch is still populating. Delay the focus target,
      // not the user's keypress, and cancel on navigation.
      const requested=revision;
      let frames=0;
      const enterWhenReady=()=>{
        if(revision!==requested || !main.isConnected) return;
        const artwork=main.querySelector('.grid .card,.shelf .card,.episode-list .episode-row');
        if(artwork) { focusWithoutJump(artwork); return; }
        if(frames++<120 && (document.activeElement===main || nav.contains(document.activeElement)))
          requestAnimationFrame(enterWhenReady);
      };
      requestAnimationFrame(enterWhenReady);
      pendingRailEntryRevision=revision;
    }
    const restored = rememberedPaneFocus && rememberedPaneFocus.isConnected &&
      main.contains(rememberedPaneFocus) ? rememberedPaneFocus : null;
    const target = restored || preferredPaneControl();
    if (target) focusWithoutJump(target);
    else { main.tabIndex = -1; focusWithoutJump(main); }
    return;
  }
  const validControls = scope => Array.from(scope.querySelectorAll(
    'button:not(:disabled),input,select,.cast-strip[tabindex]')).filter(node =>
      node !== current && node.getClientRects().length && !node.hidden);
  const choose = (candidates, axis) => nextFocus(current.getBoundingClientRect(),
    candidates.map(value => ({value, rect: value.getBoundingClientRect()})), axis);
  if (dialog.hidden && !player.active && (inRail || inMain)) {
    // Match upstream CastMemberStrip's onNavigateDown/onNavigateUp: the
    // last season/episode row leads into Cast, not off to a distant action.
    if (inMain && direction==='down' && current.matches('.grid .card,.episode-list .episode-row')) {
      const cast=main.querySelector('.cast-strip[tabindex]');
      if(cast){
        const currentRect=current.getBoundingClientRect();
        const later=Array.from(main.querySelectorAll('.grid .card,.episode-list .episode-row'))
          .some(node=>node!==current && node.getBoundingClientRect().top>currentRect.top+8);
        if(!later){focusWithoutJump(cast);return;}
      }
    }
    if (inMain && direction==='up' && current.classList.contains('cast-strip')) {
      const previous=Array.from(main.querySelectorAll('.grid .card,.episode-list .episode-row')).pop() ||
        main.querySelector('.detail-play');
      if(previous){focusWithoutJump(previous);return;}
    }
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
      // The first poster in a media row has no left-hand peer. Never
      // diagonally select a toolbar/tab from the row above it.
      const card = current.closest('.grid .card, .cards .card');
      const firstPoster = card && card.parentNode && card ===
        card.parentNode.querySelector('.card');
      if (firstPoster) {
        const selected=nav.querySelector('button.active') || nav.querySelector('button:not(:disabled)');
        if (selected) {
          rememberedPaneFocus=current;
          focusWithoutJump(selected);
        }
        return;
      }
      const adjacent = choose(rowCandidates, 'left');
      if (adjacent) { focusWithoutJump(adjacent); return; }
      const selected = nav.querySelector('button.active') ||
        nav.querySelector('button:not(:disabled)');
      if (selected) {
        rememberedPaneFocus = current;
        focusWithoutJump(selected);
      }
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
