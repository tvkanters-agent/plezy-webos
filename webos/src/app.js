import './compat.js';
// SPDX-License-Identifier: GPL-3.0-only
import {VERSION, baseUrl, id, readState, saveState, nextFocus, time} from './core.js';
import {client, Jellyfin, Plex, PlexLibraryBoundaryChanged, mediaSourceTracks,
  plexPin, pollPlexPin, plexServers} from './api.js';
import {Player} from './player.js';
import {EpisodeTrackPreferences} from './episode-track-preferences.js';
import {previewDetailTracks} from './detail-track-status.js';
import {DEFAULT_INTRO_PATTERN, DEFAULT_CREDITS_PATTERN} from './skip-markers.js';
import {ArtworkCache, artworkCacheKey} from './artwork-cache.js';
import {artworkPrefetchMargin, artworkWindowCount, artworkWindowStart, shelfWindow} from './artwork-window.js';
import {CatalogCache} from './catalog-cache.js';
import {cardLabels} from './card-labels.js';
import {reconcileRecommendedShelves} from './recommended-shelves.js';
import {PersistentCatalogCache, catalogScope} from './persistent-catalog.js';
import {beginContentEntrance, fadeDelayedContent} from './content-entrance.js';
import {mergedCollectionLoader} from './collection-merge.js';
import {CollectionIndex} from './collection-index.js';
import {showPlexAlphaBar} from './alpha-bar.js';
import {shuffledEpisode} from './shuffle.js';
import {alphabetTopInset, mountAlphabetLibrary} from './library-alpha.js';
import {libraryPageWindow} from './library-page-window.js';
import {mountMediaBrowserAlphabet} from './library-prefix-alpha.js';
import {SimklTracker, validSession, beginSimklLink, pollSimklLink} from './simkl.js';
import {SUBTITLE_STYLE_BOUNDS} from './subtitle-style.js';
import {plexRatings, fetchMdblistRatings, verifyMdblistKey, mergeProviderRatings,
  mergeRatings, ratingBadgeInfo} from './ratings.js';
const main = document.querySelector('#main'), nav = document.querySelector('#nav'), dialog = document.querySelector('#dialog');
const artworkCache = new ArtworkCache();
const catalogCache = new CatalogCache({ttl: Infinity});
const savedCatalog = new PersistentCatalogCache();
const collectionIndex = new CollectionIndex({catalog:savedCatalog});
function savedPage(key, loader, options) {
  return savedCatalog.page(catalogScope(activeServer()), key, loader, options);
}
// Accessing localStorage itself may throw in a restricted webOS app context.
function tvStorage() {
  try { return window.localStorage; } catch (_) { return null; }
}
let state = readState(tvStorage()), api, route = {type: 'home'}, history = [], revision = 0, authAbort, toastTimer;
let detailWatchEpoch = 0;
let playbackLaunch = 0;
// Sidebar destinations are persistent tabs, not pushed navigator routes.
// Bounded detached DOM snapshots keep returning to a library instantaneous.
const rootSnapshots = new Map();
// A Home heading is not a reusable tab until the asynchronous shelves paint.
let homeRenderedRevision = null;
let detailMenu = null, ratingDialogReturnFocus = null, exitDialogReturnFocus = null;
let settingsDialogReturnFocus = null;
let episodeTrackReturnFocus = null;
let episodeTrackGeneration = 0;
const episodeTrackChoices = new EpisodeTrackPreferences();
let updateDetailTrackStatus = null;
window.addEventListener('resize', () => updateDetailTrackStatus?.());
let activeAlphabet = null;
const simklTracker = new SimklTracker(() => state.simkl, session => {
  state.simkl = session; persist();
}, message => notify(message));
let playbackReturn = null;
const player = new Player(document.querySelector('#player'), notify, playbackClosed, simklTracker, () => state,
  (item, mediaIndex, kind, track) => episodeTrackChoices.record(item, mediaIndex, kind, track));
// Plezy keeps the detail route beneath playback. Never clear/refetch that
// page after hiding the player: it flashes blank and discards remote focus.
function playbackClosed(reportDone) {
  // Playback may have changed continue-watching, progress and watched state.
  catalogCache.clear();
  const previous = playbackReturn;
  playbackReturn = null;
  if (!previous || route !== previous.route || api !== previous.api) return;
  if (previous.focus && previous.focus.isConnected)
    focusWithoutJump(previous.focus, false);
  else focusFirst();
  if (route.type !== 'detail' || route.id !== previous.item.id) return;
  const expectedRevision = revision, expectedPlayback = playbackLaunch;
  const stillCurrent = () => revision === expectedRevision &&
    playbackLaunch === expectedPlayback && route === previous.route &&
    api === previous.api && !player.active;
  // The final Plex timeline is asynchronous. Reading detail before it saves
  // would persist the old viewOffset and leave the mounted Play action stale.
  // Never hold the player open while waiting for the report to settle.
  Promise.resolve(reportDone).then(() => {
    if (!stillCurrent()) return null;
    return previous.api.detail(previous.route.id, previous.route.kind);
  }).then(updated => {
    if (!updated || !stillCurrent()) return;
    // Detail actions close over this item. Refresh it and the affected
    // controls in place rather than replacing the mounted screen.
    Object.assign(previous.item, updated);
    const cacheId = savedCatalog.id(catalogScope(activeServer()),
      'detail:' + JSON.stringify([route.id,route.kind]));
    savedCatalog.read(cacheId).then(bundle => {
      if (!bundle || !stillCurrent()) return;
      // Persist the playback result even when the in-memory item was mutated
      // in place, so equality checks on the next visit cannot skip the write.
      bundle.item = updated;
      savedCatalog.generations.set(cacheId, (savedCatalog.generations.get(cacheId) || 0) + 1);
      savedCatalog.remember(cacheId, bundle);
      savedCatalog.write(cacheId, bundle).catch(() => {});
    }).catch(() => {});
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
    updateDetailTrackStatus?.(updated);
  }).catch(() => { /* Keep the mounted page usable if metadata is offline. */ });
}
let rememberedPaneFocus = null;
let rememberedRailFocusId = null;
// Track real rail focus (D-pad and pointer), not the current route. Navigation
// rebuilds the buttons, so remember the stable destination ID, not its node.
nav.addEventListener('focusin', event => {
  const item = event.target.closest('[data-nav-id]');
  if (item && nav.contains(item)) rememberedRailFocusId = item.dataset.navId;
});
let enterPaneAfterNavigation = false;
let navigationIntent = 0;
let pendingRailEntryRevision = null, libraryRenderRevision = null;
let lastRailRightRevision = null;
function preferredPaneControl() {
  // Enter media before the toolbar when coming from the remote's side rail.
  return main.querySelector('.paged-window-grid')?._libraryWindow.visibleCard() ||
    main.querySelector('.grid .card, .shelf .card, .episode-list .episode-row, .cards .card') ||
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
  if (player.pendingOpen) { ++playbackLaunch; player.close(); }
  // Never reuse catalog metadata across accounts or server connections.
  catalogCache.clear();
  episodeTrackChoices.clear();
  collectionIndex.clear();
  clearNavigationHistory();
  const server = activeServer();
  api = server ? client(server, state.deviceId) : null;
  // The mounted DOM still belongs to the previous account at this point.
  // Reset its route before the next go() can mistakenly cache it as a tab
  // belonging to the newly selected server.
  route = {type:'home'};
  libraryCache = null; libraryCacheFor = null; libraryLoading = false;
}
function addServer(server) {
  // A refreshed connection can replace an existing token under the same ID.
  // Discard the old account scope now, so later removal cannot leave it behind.
  const previous = state.servers.find(s => s.id === server.id);
  if (previous && catalogScope(previous) !== catalogScope(server)) {
    const previousScope = catalogScope(previous);
    savedCatalog.removeScope(previousScope).catch(() => {});
    artworkCache.removeScope(previousScope).catch(() => {});
  }
  artworkCache.allowScope(catalogScope(server));
  state.servers = state.servers.filter(s => s.id !== server.id).concat(server);
  state.active = server.id; persist(); setClient(); go({type: 'home'}, false);
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
      const view = vertical.getBoundingClientRect();
      const alphaGrid = target.closest && target.closest('.alpha-window-grid');
      const topPad = alphaGrid ? alphabetTopInset(alphaGrid) : 32;
      const bottomPad = 32;
      if (item.top < view.top + topPad) dy = item.top - view.top - topPad;
      else if (item.bottom > view.bottom - bottomPad) dy = item.bottom - view.bottom + bottomPad;
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
  ],
  volume: [
    ['path',{d:'M3 9v6h4l5 5V4L7 9H3z',fill:'currentColor'}],
    ['path',{d:'M15 8a5 5 0 0 1 0 8 M17.5 5.5a8.5 8.5 0 0 1 0 13',
      fill:'none',stroke:'currentColor','stroke-width':'2','stroke-linecap':'round'}]
  ],
  subtitles: [
    ['rect',{x:'2',y:'4',width:'20',height:'16',rx:'2',fill:'currentColor'}],
    ['path',{d:'M5 13h6 M5 16h8 M14 13h5 M16 16h3',
      stroke:'#15171b','stroke-width':'1.6','stroke-linecap':'round'}]
  ]
};
function detailSvg(symbol) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox','0 0 24 24');
  svg.setAttribute('aria-hidden','true');
  iconShapes[symbol].forEach(([tag, attributes]) => {
    const shape = document.createElementNS('http://www.w3.org/2000/svg',tag);
    Object.keys(attributes).forEach(name => shape.setAttribute(name,attributes[name]));
    svg.appendChild(shape);
  });
  return svg;
}
function detailButton(label, action, symbol, className = '') {
  const control = button(label, action, className);
  control.setAttribute('aria-label', label);
  control.setAttribute('title', label);
  if (symbol && iconShapes[symbol]) {
    control.insertBefore(detailSvg(symbol),control.firstChild);
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
function updateLocalWatchState(item, watched) {
  item.watched = watched;
  if (item.unwatchedCount != null) {
    const leaves = Number(item.raw?.leafCount ?? item.raw?.RecursiveItemCount);
    item.unwatchedCount = watched ? 0 : (Number.isFinite(leaves) ? leaves : item.unwatchedCount);
    if (item.raw) item.raw.viewedLeafCount = watched ? leaves || 0 : 0;
  }
  item.resume = 0;
  if (item.raw) {
    if (item.raw.UserData) {
      item.raw.UserData.Played = watched;
      item.raw.UserData.PlaybackPositionTicks = 0;
      if (item.unwatchedCount != null) item.raw.UserData.UnplayedItemCount = item.unwatchedCount;
    }
    item.raw.viewCount = watched ? 1 : 0;
    item.raw.viewOffset = 0;
  }
}
// A cached detail item can be updated by another instance while its old DOM
// still shows the previous label. Always execute the action the button names.
function detailWatchButton(item, markWatched) {
  const control = detailButton(item.watched ? 'Mark unwatched' : 'Mark watched',
    () => markWatched(control.getAttribute('aria-label') === 'Mark watched'),
    item.watched ? 'unwatched' : 'watched', 'detail-icon detail-watched');
  return control;
}
function refreshDetailWatchActions(actions, item) {
  refreshDetailAction(actions.querySelector('.detail-watched'),
    item.watched ? 'Mark unwatched' : 'Mark watched', item.watched ? 'unwatched' : 'watched');
  refreshDetailAction(actions.querySelector('.detail-play'),
    item.resume > 0 ? 'Resume · ' + time(item.resume) : 'Play', 'play');
  const restart = actions.querySelector('.detail-restart');
  if (restart) {
    restart.hidden = !(item.resume > 0);
    if (restart.hidden && document.activeElement === restart)
      focusWithoutJump(actions.querySelector('.detail-play'), false);
  }
}
// WatchActions in native Plezy patches mounted metadata without replacing the
// detail route. Keep its saved first-frame snapshot coherent as well.
function persistDetailWatchState(item, detailRoute, serverScope) {
  const key = savedCatalog.id(serverScope,
    'detail:' + JSON.stringify([detailRoute.id, detailRoute.kind]));
  const generation = (savedCatalog.generations.get(key) || 0) + 1;
  savedCatalog.generations.set(key, generation);
  savedCatalog.read(key).then(bundle => {
    if (!bundle || bundle.item?.id !== item.id ||
        savedCatalog.generations.get(key) !== generation) return;
    updateLocalWatchState(bundle.item, item.watched);
    savedCatalog.remember(key, bundle);
    savedCatalog.write(key, bundle).catch(() => {});
  }).catch(() => {});
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
function detailMoreOptions(options, iconOnly = false) {
  const group = el('div', undefined, 'detail-more');
  const menu = el('div', undefined, 'detail-more-menu');
  menu.hidden = true;
  const trigger = detailButton(iconOnly ? '' : 'More options', () => {
    if (!menu.hidden) { closeDetailMenu(); return; }
    closeDetailMenu();
    menu.textContent = '';
    const entries = typeof options === 'function' ? options() : options;
    entries.forEach(option => menu.append(button(option.label, () => {
      closeDetailMenu();
      return option.action();
    }, 'detail-more-option')));
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    detailMenu = {menu, trigger};
    focusWithoutJump(menu.querySelector('button'), false);
  }, 'more', 'detail-icon');
  if (iconOnly) {
    trigger.setAttribute('aria-label', 'More options');
    trigger.setAttribute('title', 'More options');
  }
  trigger.setAttribute('aria-haspopup', 'true');
  trigger.setAttribute('aria-expanded', 'false');
  group.append(trigger, menu);
  return group;
}
// EpisodeCard's context menu offers the watched actions for the fresh item
// state, including BOTH actions for partially watched episodes (upstream
// MediaContextMenu._buildItemMenuActions). Pre-play source choices reuse the
// original TrackSheet controls for movies and playable episodes.
function episodeMenuActions(item, onChanged = () => {}, onMarkStarted = () => {}) {
  const progress = item.resume > 0;
  const entries = [];
  async function mark(watched) {
    const sourceApi = api;
    onMarkStarted();
    await sourceApi.watched(item, watched);
    if (sourceApi !== api) return;
    updateLocalWatchState(item, watched);
    catalogCache.clear();
    if (sourceApi instanceof Plex) simklTracker.markWatched(sourceApi, item, watched);
    onChanged();
    notify(watched ? 'Marked as watched' : 'Marked as unwatched');
  }
  if (!item.watched || progress) entries.push({label:'Mark as Watched',action:() => mark(true)});
  if (item.watched || progress) entries.push({label:'Mark as Unwatched',action:() => mark(false)});
  entries.push({label:'Audio & Subtitles', action:() => showMediaTrackSheet(item)});
  return entries;
}
function closeEpisodeTrackSheet() {
  ++episodeTrackGeneration;
  dialog.hidden = true;
  dialog.classList.remove('episode-track-dialog');
  const target = episodeTrackReturnFocus;
  episodeTrackReturnFocus = null;
  if (target?.isConnected) focusWithoutJump(target, false);
  else focusFirst();
}
// Pre-play track selection is a narrow webOS adaptation. The desktop
// TrackSheet changes an already running MPV stream; the TV stores the same
// source IDs for the selected playable item and applies them on launch.
// Show/season menus resolve the very episode their Play action would launch.
async function showMediaTrackSheet(item, resolveEpisode = null) {
  const sourceApi = api, openedAt = revision, generation = ++episodeTrackGeneration;
  const mediaIndex = !resolveEpisode && route.type === 'detail' && String(route.id) === String(item.id)
    ? route.mediaIndex || 0 : 0;
  episodeTrackReturnFocus = document.activeElement;
  dialog.textContent = '';
  dialog.classList.add('episode-track-dialog');
  const heading = el('h2', 'Audio & Subtitles · ' + item.title);
  const close = button('Close', closeEpisodeTrackSheet, 'episode-track-close');
  const status = el('p', 'Loading tracks…', 'muted');
  const columns = el('div', undefined, 'episode-track-columns');
  dialog.append(heading, columns, status, close);
  dialog.hidden = false;
  focusWithoutJump(close, false);
  try {
    const target = resolveEpisode ? await resolveEpisode() : item;
    if (!target) throw new Error('No playable episodes were found.');
    if (api !== sourceApi || revision !== openedAt || generation !== episodeTrackGeneration || dialog.hidden) return;
    if (target !== item) heading.textContent = 'Audio & Subtitles · ' + target.title;
    // Plex library cards and season rows commonly omit Part.Stream. Never
    // infer "no tracks" from lightweight metadata, for movies or episodes.
    const detailed = sourceStreamsComplete(target, mediaIndex) ? target :
      await sourceApi.detail(target.id, target.type);
    if (api !== sourceApi || revision !== openedAt || generation !== episodeTrackGeneration || dialog.hidden ||
        !episodeTrackReturnFocus) return;
    if (detailed !== target) Object.assign(target, detailed);
    const tracks = mediaSourceTracks(detailed, mediaIndex);
    const prior = episodeTrackChoices.resolve(detailed, mediaIndex, tracks);
    columns.textContent = '';
    const selected = {
      audio: prior.audio !== undefined ? prior.audio :
        (tracks.audio.find(track => track.selected) || tracks.audio[0])?.id,
      subtitle: prior.subtitle !== undefined ? prior.subtitle :
        (tracks.subtitles.find(track => track.selected) || {id:-1}).id
    };
    const makeColumn = (kind, name, tracksForKind) => {
      const column = el('div', undefined, 'episode-track-column');
      column.append(el('h3', name));
      tracksForKind.forEach(track => {
        const label = track.primary || track.label;
        const choice = button('', () => {
          episodeTrackChoices.record(detailed, mediaIndex, kind, track);
          updateDetailTrackStatus?.(detailed);
          // Keep both columns open so audio and subtitle can be chosen in one
          // visit. Update only this column's tick and pressed state.
          Array.from(column.querySelectorAll('button')).forEach(option => {
            const active = option === choice;
            option.setAttribute('aria-pressed', String(active));
            const tick = option.querySelector('.track-check');
            if (tick) tick.remove();
            if (active) option.append(el('span', '✓', 'track-check'));
          });
        }, 'episode-track-option');
        choice.setAttribute('aria-label', label);
        choice.setAttribute('aria-pressed', String(String(selected[kind]) === String(track.id)));
        choice.append(el('strong',label));
        if(track.secondary)choice.append(el('small',track.secondary));
        if(String(selected[kind])===String(track.id))choice.append(el('span','✓','track-check'));
        column.append(choice);
      });
      columns.append(column);
    };
    if(tracks.audio.length)makeColumn('audio','Audio',tracks.audio);
    makeColumn('subtitle','Subtitles', [{id:-1,primary:'Off'}].concat(tracks.subtitles));
    status.remove();
    const focus = columns.querySelector('button[aria-pressed="true"]') || columns.querySelector('button');
    if (focus) focusWithoutJump(focus, false);
  } catch(error) {
    if (!dialog.hidden && generation === episodeTrackGeneration && episodeTrackReturnFocus && api === sourceApi)
      status.textContent = 'Could not load tracks: ' + error.message;
  }
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
      // Keep the rail visually stable while library names are fetched;
      // a transient "Loading…" label flashed on Home during startup.
      nav.append(section);
    }
    if (libraryCacheFor !== api && !libraryLoading) {
      const currentApi = api;
      libraryLoading = true;
      savedPage('libraries', () => currentApi.libraries(), {priority:true}).then(result => {
        if (currentApi !== api) return;
        const install = libraries => {
          if (currentApi !== api) return;
          libraryCacheFor = currentApi; libraryCache = libraries;
          libraryLoading = false;
          navigation();
          if (route.type === 'settings') render();
        };
        install(result.value);
        if (result.fresh) result.fresh.then(update => {
          if (update.changed) install(update.value);
        }).catch(() => {});
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
// Flutter MainScreen selects tabs in an IndexedStack. Only pushed detail or
// sign-in routes belong to Back history; sidebar changes replace the active tab.
function rootKey(value) {
  if (value.type === 'library') return 'library:' + value.library.id;
  return ['home', 'search', 'settings'].includes(value.type) ? value.type : null;
}
function forEachPagedGrid(container, callback) {
  Array.from(container.querySelectorAll('.grid,.collection-sections,.episode-list'))
    .forEach(node => { if (node._resumeCatalog) callback(node); });
}
function releaseSnapshot(entry) {
  if (!entry) return;
  if (entry.alphabet) entry.alphabet.destroy();
  if (entry.snapshot) {
    entry.snapshot.querySelectorAll('.detail').forEach(node => node._disposeDetail?.());
    forEachPagedGrid(entry.snapshot, node => node._destroyCatalog());
  }
}
function clearDrilldownHistory() {
  history.forEach(releaseSnapshot);
  history = [];
}
function clearNavigationHistory() {
  clearDrilldownHistory();
  rootSnapshots.forEach(releaseSnapshot);
  rootSnapshots.clear();
}
// A detached DOM shelf can lose scrollLeft when reattached (notably on LG's
// Chromium 53). Native HubSection retains a ScrollController per shelf, so
// persist the offsets alongside the route's vertical scroll and focus.
function captureShelfScrolls() {
  return Array.from(main.querySelectorAll('.shelf')).map(section => ({
    title: (section.querySelector('h2') || {}).textContent || '',
    left: (section.querySelector('.cards') || {}).scrollLeft || 0
  }));
}
function restoreShelfScrolls(saved) {
  if (!saved || !saved.length) return;
  // Match by heading instead of row index when Home refreshes and reorders
  // hubs. Consume duplicate headings in order so each row stays independent.
  const pending = saved.slice();
  Array.from(main.querySelectorAll('.shelf')).forEach(section => {
    const row = section.querySelector('.cards');
    if (!row) return;
    const heading = (section.querySelector('h2') || {}).textContent || '';
    const index = pending.findIndex(position => position.title === heading);
    if (index < 0) return;
    row.scrollLeft = pending.splice(index, 1)[0].left;
  });
}
function capturePage(previousPaneFocus = null) {
  const snapshot = document.createDocumentFragment();
  const scroll = main.scrollTop;
  const shelfScrolls = captureShelfScrolls();
  const remembered = previousPaneFocus && previousPaneFocus.isConnected &&
    main.contains(previousPaneFocus) ? previousPaneFocus : null;
  const focused = main.contains(document.activeElement) ?
    document.activeElement.dataset.focus : remembered ? remembered.dataset.focus : route.focus || null;
  const alphabet = activeAlphabet;
  if (alphabet) { alphabet.suspend(); activeAlphabet = null; }
  forEachPagedGrid(main, node => node._suspendCatalog());
  main.querySelectorAll('.content-enter').forEach(node => node.classList.remove('content-enter'));
  while (main.firstChild) snapshot.appendChild(main.firstChild);
  return {route:{...route,scroll,focus:focused,shelfScrolls},snapshot,sourceApi:api,alphabet,
    homeComplete:route.type === 'home' && homeRenderedRevision === revision,
    catalogGeneration:catalogCache.generation};
}
function cacheRootPage(entry) {
  if (!entry || !entry.snapshot || !entry.snapshot.childNodes.length ||
      entry.sourceApi !== api || (entry.route.type === 'home' && !entry.homeComplete)) {
    releaseSnapshot(entry); return;
  }
  const key = rootKey(entry.route);
  if (!key) { releaseSnapshot(entry); return; }
  releaseSnapshot(rootSnapshots.get(key));
  rootSnapshots.delete(key);
  rootSnapshots.set(key, entry);
  // A handful of tabs can stay warm, not arbitrarily many full DOM grids.
  if (rootSnapshots.size > 8) {
    const oldest = rootSnapshots.keys().next().value;
    releaseSnapshot(rootSnapshots.get(oldest));
    rootSnapshots.delete(oldest);
  }
}
function takeRootPage(key) {
  const entry = rootSnapshots.get(key);
  rootSnapshots.delete(key);
  if (!entry) return null;
  // Playback and watch-state updates invalidate Home's session-only shelves.
  if (entry.sourceApi !== api || !entry.snapshot.childNodes.length ||
      (key === 'home' && (!entry.homeComplete ||
        entry.catalogGeneration !== catalogCache.generation))) {
    releaseSnapshot(entry);
    return null;
  }
  return entry;
}
// Cached tabs paint immediately, but their first metadata page still gets a
// background freshness check just as it would on a normal library visit.
function revalidateRestoredLibrary(expectedRoute, mountedRevision) {
  if (expectedRoute.type !== 'library') return;
  const selected = expectedRoute.sort || 'title', filter = expectedRoute.filter || 'all';
  const view = expectedRoute.view || 'browse', libraryId = expectedRoute.library.id;
  const currentApi = api;
  let key, loader;
  if (view === 'browse') {
    if (main.querySelector('.paged-window-grid')) return; // Revalidated on grid resume.
    key = 'browse:' + JSON.stringify([libraryId,selected,filter,expectedRoute.alpha || '',0,null]);
    loader = () => currentApi.list(libraryId,0,selected,filter,undefined,
      currentApi instanceof Jellyfin ? expectedRoute.alpha : undefined);
  } else if (currentApi instanceof Plex && view === 'recommended') {
    key = 'recommended:' + libraryId;
    loader = () => currentApi.recommended(libraryId);
  } else if (currentApi instanceof Plex && view === 'collections') {
    key = 'collections:' + libraryId + ':0';
    loader = () => currentApi.collections(libraryId,0);
  } else if (currentApi instanceof Plex && view === 'playlists') {
    key = 'playlists:0';
    loader = () => currentApi.playlists(0);
  }
  if (!loader) return;
  savedPage(key, loader, {priority:true}).then(result => {
    if (!result.fresh) return;
    return result.fresh.then(update => {
      if (!update.changed || revision !== mountedRevision || route !== expectedRoute || api !== currentApi) return;
      if (view === 'browse' && activeAlphabet && currentApi instanceof Plex) {
        prewarmPosters(update.value.items, currentApi, {protectFirst:24}).then(() => {
          if (revision === mountedRevision && route === expectedRoute && activeAlphabet)
            activeAlphabet.updateRange(0, update.value);
        }).catch(() => {});
        return;
      }
      const paged = Array.from(main.querySelectorAll('.grid,.collection-sections'))
        .find(node => node._applyCatalogUpdate);
      if (paged && view !== 'recommended') {
        paged._applyCatalogUpdate(0, update);
        return;
      }
      // A restored Recommended tab owns its still-mounted shelves. Update
      // those nodes in place rather than re-rendering the entire library.
      const tabs = main.querySelector('.library-tabs');
      if (view === 'recommended' && tabs?._applyRecommendedUpdate) {
        tabs._applyRecommendedUpdate(update.value).catch(() => {});
        return;
      }
      const focused = main.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
      route = {...route, scroll:main.scrollTop, focus:focused || route.focus};
      render();
    });
  }).catch(() => { /* An offline server must not hide a cached tab. */ });
}
function restoreRootPage(entry) {
  const fromRail = enterPaneAfterNavigation;
  enterPaneAfterNavigation = false;
  route = entry.route;
  const mountedRevision = ++revision;
  if (route.type === 'home') homeRenderedRevision = mountedRevision;
  pendingRailEntryRevision = null;
  lastRailRightRevision = null;
  cancelAuth(); detailMenu = null;
  main.querySelector('.detail')?._disposeDetail?.();
  main.textContent = '';
  main.appendChild(entry.snapshot);
  updateDetailTrackStatus = null;
  main.classList.toggle('settings-view', route.type === 'settings' || route.type === 'settings-page');
  main.classList.toggle('has-alpha-bar', !!entry.alphabet);
  const restoreOffsets = () => {
    main.scrollTop = entry.route.scroll || 0;
    restoreShelfScrolls(entry.route.shelfScrolls);
  };
  restoreOffsets();
  navigation();
  const libraryTabs = main.querySelector('.library-tabs');
  if (libraryTabs && libraryTabs._resumeLibraryView)
    libraryTabs._resumeLibraryView(mountedRevision);
  forEachPagedGrid(main, node => node._resumeCatalog(mountedRevision));
  if (entry.alphabet) {
    activeAlphabet = entry.alphabet;
    activeAlphabet.resume(() => revision === mountedRevision);
  }
  const focused = Array.from(main.querySelectorAll('[data-focus]')).find(
    node => node.dataset.focus === route.focus);
  if (focused) focusWithoutJump(focused, false);
  else focusFirst(main, fromRail ? preferredPaneControl() : null, fromRail);
  // focusFirst is deferred by a frame. Restore offsets after its focus change
  // too, so Chromium cannot pull a cached Home shelf or pane back to the top.
  requestAnimationFrame(() => {
    if (revision === mountedRevision) restoreOffsets();
  });
  schedulePosters();
  revalidateRestoredLibrary(route, mountedRevision);
}
// Read saved data/artwork while the current route still covers the screen.
// IndexedDB and decoding are asynchronous even without any network traffic;
// clearing the pane first exposes that work as a black navigation blink.
async function prepareNavigation(next, sourceApi) {
  if (!sourceApi || next.forceRefresh) return;
  const scope = catalogScope(activeServer());
  const read = key => savedCatalog.read(savedCatalog.id(scope, key));
  if (next.type === 'home') {
    const rows = catalogCache.peek('home');
    if (rows) await prewarmShelves(rows, sourceApi);
  } else if (next.type === 'library') {
    const view = next.view || 'browse';
    let key;
    if (view === 'browse') key = 'browse:' + JSON.stringify([next.library.id,
      next.sort || 'title', next.filter || 'all', next.alpha || '', 0, null]);
    else if (view === 'recommended') key = 'recommended:' + next.library.id;
    else if (view === 'collections') key = 'collections:' + next.library.id + ':0';
    else if (view === 'playlists') key = 'playlists:0';
    if (!key) return;
    const page = await read(key);
    if (page) {
      if (view === 'recommended') await prewarmShelves(page, sourceApi);
      else await prewarmPosters(page.items, sourceApi, {protectFirst:24});
    }
  } else if (next.type === 'detail') {
    const bundle = await read('detail:' + JSON.stringify([next.id,next.kind]));
    if (bundle) {
      await prewarmDetail(bundle, sourceApi);
      if (bundle.item.folder) {
        const item = bundle.item, grouped = sourceApi instanceof Plex && item.type === 'collection';
        const children = await read('children:' + JSON.stringify([item.id,item.type,grouped,0]));
        if (children) await prewarmPosters(children.items, sourceApi,
          {landscape:item.type === 'season' || item.type === 'Season', protectFirst:24});
      }
    }
  } else if (next.type === 'person') {
    const page = await read('person-media:' + JSON.stringify([next.id,next.actor,0]));
    if (page) await prewarmPosters(page.items, sourceApi, {protectFirst:24});
  }
}
async function go(next, remember = true) {
  // A hidden replay must not open after a different destination is chosen.
  if (player.pendingOpen) { ++playbackLaunch; player.close(); }
  const intent = ++navigationIntent, sourceApi = api;
  const destinationKey = rootKey(next);
  // A detached view already has its decoded images and metadata. Prewarming
  // IndexedDB on the way to it would needlessly delay the instant tab switch.
  const readyRoot = destinationKey && (rootSnapshots.get(destinationKey) ||
    history.find(entry => rootKey(entry.route) === destinationKey));
  const usableRoot = readyRoot && readyRoot.sourceApi === sourceApi &&
    readyRoot.snapshot && readyRoot.snapshot.childNodes.length &&
    (destinationKey !== 'home' || readyRoot.homeComplete &&
      readyRoot.catalogGeneration === catalogCache.generation);
  if (!usableRoot) {
    try { await prepareNavigation(next, sourceApi); } catch (_) { /* Cache is optional. */ }
  }
  if (intent !== navigationIntent || sourceApi !== api) return;

  // Home can have cached API results while its previous render was canceled.
  // Re-select an incomplete Home without pushing a duplicate Back entry.
  if (next.type === 'home' && route.type === 'home') {
    if (!next.forceRefresh && homeRenderedRevision === revision &&
        catalogCache.peek('home', {allowExpired:true})) return;
    route = next;
    render();
    return;
  }
  // Re-selecting other active sidebar destinations leaves their views intact.
  if (rootKey(next) && rootKey(next) === rootKey(route) &&
      !['home','library'].includes(next.type) && !next.forceRefresh) return;
  if (next.type === 'library' && route.type === 'library' &&
      next.library.id === route.library.id && (next.view || 'browse') === (route.view || 'browse') &&
      (next.sort || 'title') === (route.sort || 'title') &&
      (next.filter || 'all') === (route.filter || 'all') &&
      (next.alpha || '') === (route.alpha || '') && !next.forceRefresh) return;
  const fromRail = nav.contains(document.activeElement);
  enterPaneAfterNavigation = fromRail;
  const previousPaneFocus = rememberedPaneFocus;
  rememberedPaneFocus = null;
  const destination = rootKey(next);
  if (destination && (destination !== rootKey(route) || history.length)) {
    if (rootKey(route)) cacheRootPage(capturePage(previousPaneFocus));
    else {
      // A detail view covers a root tab retained in the drilldown stack.
      // Move that original snapshot to the tab cache before clearing details.
      const rootIndex = history.findIndex(entry => rootKey(entry.route));
      if (rootIndex !== -1) cacheRootPage(history.splice(rootIndex,1)[0]);
    }
    clearDrilldownHistory();
    const cached = takeRootPage(destination);
    if (cached) { restoreRootPage(cached); return; }
    route = next;
    render();
    return;
  }
  if (remember) {
    // Pushed details preserve their covered route, including scroll/focus.
    history.push(capturePage(previousPaneFocus));
    if (history.length > 8) releaseSnapshot(history.shift());
  }
  route = next;
  render();
}
function cancelAuth() { if (authAbort) { authAbort.abort(); authAbort = null; } }
// Match the source AlertDialog's cancel-first autofocus, while restoring the
// actual covered screen's focus instead of jumping to its first control.
function dismissExitDialog() {
  dialog.hidden = true;
  dialog.classList.remove('exit-dialog');
  dialog.removeAttribute('aria-labelledby');
  const target = exitDialogReturnFocus;
  exitDialogReturnFocus = null;
  if (target && target.isConnected) focusWithoutJump(target, false);
  else focusFirst();
}
function back() {
  ++navigationIntent;
  if (detailMenu) { closeDetailMenu(); return; }
  if (!dialog.hidden) {
    if (settingsDialogReturnFocus) { closeSettingsDialog(); return; }
    if(episodeTrackReturnFocus){closeEpisodeTrackSheet();return;}
    if(ratingDialogReturnFocus){closeRatingSheet();return;}
    if (dialog.classList.contains('exit-dialog')) { dismissExitDialog(); return; }
    dialog.hidden = true; focusFirst(); return;
  }
  if (player.active) { player.close(); return; }
  // Back still navigates the detail stack, but retires a hidden queued replay.
  if (player.pendingOpen) { ++playbackLaunch; player.close(); }
  if (history.length) {
    const previous = history.pop();
    route = previous.route || previous;
    if (previous.snapshot && previous.sourceApi === api && previous.snapshot.childNodes.length &&
        (route.type !== 'home' || previous.homeComplete &&
          previous.catalogGeneration === catalogCache.generation)) {
      ++revision;
      if (route.type === 'home') homeRenderedRevision = revision;
      cancelAuth();
      main.querySelector('.detail')?._disposeDetail?.();
      main.textContent = '';
      main.appendChild(previous.snapshot);
      main.querySelector('.detail')?._resumeDetail?.(revision);
      const restoredTracks = main.querySelector('.detail-playback-tracks');
      updateDetailTrackStatus = restoredTracks?._updateTracks || null;
      if (restoredTracks?.hidden) restoredTracks._probeTracks?.();
      forEachPagedGrid(main, node => node._resumeCatalog(revision));
      navigation();
      main.scrollTop = route.scroll || 0;
      restoreShelfScrolls(route.shelfScrolls);
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
  // Native MainScreen Back on a tab goes Home, not through previous tabs.
  if (api && route.type !== 'home') { go({type:'home'}); return; }
  exitDialogReturnFocus = document.activeElement;
  dialog.classList.add('exit-dialog');
  dialog.textContent = '';
  const title = el('h2', 'Close Plezy?');
  title.id = 'exit-dialog-title';
  dialog.setAttribute('aria-labelledby', title.id);
  dialog.append(title, el('p', 'Are you sure you want to close Plezy?', 'dialog-description'));
  const actions = el('div', undefined, 'actions');
  actions.append(button('Keep watching', dismissExitDialog), button('Exit', () => window.close()));
  actions.lastElementChild.classList.add('primary');
  dialog.append(actions);
  dialog.hidden = false;
  focusFirst(dialog);
}
function card(item) {
  const labels = cardLabels(item);
  const node = button('', () => go({type: 'detail', id: item.id, kind: item.type})); node.className = 'card'; node.dataset.focus = item.id;
  node.setAttribute('aria-label', labels.title + (labels.subtitle ? ', ' + labels.subtitle : ''));
  node.append(poster(item), el('strong', labels.title), el('small', labels.subtitle));
  node._refreshWatchState = () => {
    node.querySelectorAll('.badge,progress').forEach(control => control.remove());
    if (item.unwatchedCount > 0 && ['show','season','Series','Season'].includes(item.type))
      node.append(el('span', String(item.unwatchedCount), 'badge'));
    else if (item.watched && !(item.resume > 0 && item.duration > 0))
      node.append(el('span', '✓', 'badge'));
    if (item.resume > 0 && item.duration > 0) { const p = el('progress'); p.max = item.duration; p.value = item.resume; node.append(p); }
  };
  node._refreshWatchState();
  return node;
}
// Flutter's sliver-based library lists inflate artwork near the viewport.
 // Chromium 53 ignores <img loading="lazy">. Prefetch a few library rows
 // on both sides of the viewport without decoding entire catalog pages.
// Respect the six-request artwork limit in Plezy's full-performance tier.
const MAX_ARTWORK_IN_FLIGHT = 6;
let posterFrame = 0, artworkInFlight = 0;
let previousPosterScrollTop = main.scrollTop, posterScrollDirection = 0;
// A loading slot becoming free must not remeasure all offscreen images.
// Rebuild geometry only on scroll or DOM layout changes.
let posterQueueDirty = true, posterCandidates = [];
// Native Plezy's OptimizedMediaImage paints decoded memory hits immediately;
// any image not already ready when its DOM node is created fades over 300ms.
function artworkImage(url, persistent, failed, revision = '') {
  // All media artwork uses the same image class, so newly introduced
  // rounded frames inherit clipping rather than leaking square image corners
  // when Chromium 53 composites the opacity fade.
  const img = el('img', undefined, 'artwork-image');
  img.alt = '';
  // Revisioned artwork persists until metadata changes. Artwork without a
  // revision can still be reused immediately in RAM for this session, but
  // is never persisted and therefore cannot go stale across launches.
  const scope = catalogScope(activeServer());
  const diskKey = persistent ? artworkCacheKey(url, revision, scope) : '';
  const key = persistent ? (diskKey || artworkCacheKey(url, 'session', scope)) : '';
  if (key) {
    if (diskKey) img.setAttribute('data-artwork-cache', '1');
    img.setAttribute('data-artwork-key', key);
  }
  img.setAttribute('data-artwork-url', url);
  img.onload = () => {
    if (key && img.src.indexOf('blob:') === 0) artworkCache.markReady(key);
    else if (img.src === url) artworkCache.markDirectImage(url, scope);
    if (img.classList.contains('artwork-ready')) return;
    // A second frame guarantees the transparent starting style was painted,
    // even when IndexedDB or the browser cache resolves during initial layout.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (img.isConnected && img.naturalWidth > 0) img.classList.add('artwork-loaded');
    }));
  };
  img.onerror = () => {
    if (key && img.src.indexOf('blob:') === 0 && !img.hasAttribute('data-artwork-retry')) {
      // Corrupt or unsupported stored image: remove it and try the normal URL.
      img.setAttribute('data-artwork-retry', '1');
      artworkCache.invalidate(key);
      img.classList.remove('artwork-ready', 'artwork-loaded');
      img.src = url;
    } else if (failed) failed(img);
  };
  const ready = key ? artworkCache.peekReady(key) : null;
  if (ready) {
    img.classList.add('artwork-ready');
    img.src = ready; // Set before DOM insertion for the first rendered frame.
  } else if (artworkCache.sawDirectImage(url, scope)) {
    // Native image cache hits decode synchronously. Only skip the fade if
    // Chromium confirms this image is actually ready before DOM insertion.
    img.src = url;
    if (img.complete && img.naturalWidth > 0) img.classList.add('artwork-ready');
  } else {
    img.setAttribute('data-poster-src', url);
  }
  return img;
}
function loadVisiblePosters() {
  posterFrame = 0;
  if (posterQueueDirty) {
    posterQueueDirty = false;
    posterCandidates = [];
    const view = main.getBoundingClientRect();
    const images = main.querySelectorAll('img[data-poster-src]');
    const margins = new Map();
    const visible = [], sideways = [], above = [], below = [];
    // Measure each library layout once per scroll/layout change. Use the real
    // card height and CSS row gap (or flex fallback margins), not a fixed px
    // threshold that stops short on large or landscape TV rows.
    function verticalMargin(img) {
      const container = img.closest('.grid, .episode-list');
      if (!container) return 200; // Keep Home shelves and detail images bounded.
      if (margins.has(container)) return margins.get(container);
      const card = container.querySelector(container.classList.contains('episode-list')
        ? '.episode-row' : '.card');
      let margin = 200;
      if (card) {
        const layout = getComputedStyle(container);
        const cardStyle = getComputedStyle(card);
        const gap = parseFloat(layout.rowGap) || parseFloat(layout.gridRowGap) || 0;
        const cardBottom = parseFloat(cardStyle.marginBottom) || 0;
        margin = artworkPrefetchMargin(card.getBoundingClientRect().height + gap + cardBottom);
      }
      margins.set(container, margin);
      return margin;
    }
    // Read all geometry before writing src/classes, and only when the viewport
    // or card layout changed. Finishing a download reuses this measured queue.
    for (let i = 0; i < images.length; i++) {
      const img = images[i], rect = img.getBoundingClientRect();
      const margin = verticalMargin(img);
      if (rect.bottom < view.top - margin || rect.top > view.bottom + margin ||
          rect.right < view.left - 180 || rect.left > view.right + 180) continue;
      if (rect.bottom >= view.top && rect.top <= view.bottom) {
        if (rect.right >= view.left && rect.left <= view.right) visible.push(img);
        else sideways.push(img);
      } else if (rect.bottom < view.top) above.push(img);
      else below.push(img);
    }
    // Visible images must not queue behind a screenful of speculative reads.
    // Outside the viewport, start with the nearest row in scroll direction;
    // above[] is in document order so its nearest entries come last.
    posterCandidates = visible.concat(sideways, posterScrollDirection < 0
      ? above.reverse().concat(below) : below.concat(above.reverse()));
  }
  const ready = posterCandidates;
  posterCandidates = [];
  for (const img of ready) {
    if (!img.isConnected || !img.hasAttribute('data-poster-src')) continue;
    const url = img.getAttribute('data-poster-src');
    const key = img.getAttribute('data-artwork-key');
    if (key && !img.hasAttribute('data-artwork-probed')) {
      // Disk reads do not consume download permits. A slow network miss must
      // never hold already-downloaded posters behind it while scrolling.
      img.removeAttribute('data-poster-src');
      img.setAttribute('data-artwork-probed', '1');
      artworkCache.cachedSource(key, img.hasAttribute('data-artwork-cache')).then(src => {
        if (!img.isConnected) { img.setAttribute('data-poster-src', url); return; }
        if (src) img.src = src;
        else {
          img.setAttribute('data-poster-src', url);
          // The disk miss is now known; put it directly back in the measured
          // queue without measuring other offscreen posters a second time.
          if (!posterQueueDirty) posterCandidates.push(img);
          schedulePosters();
        }
      });
      continue;
    }
    if (artworkInFlight >= MAX_ARTWORK_IN_FLIGHT) {
      posterCandidates.push(img);
      continue;
    }
    img.removeAttribute('data-poster-src');
    ++artworkInFlight;
    let done = false;
    const timer = setTimeout(finish, 16000);
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      img.removeEventListener('load', finish);
      img.removeEventListener('error', finish);
      artworkInFlight = Math.max(0, artworkInFlight - 1);
      schedulePosters();
    }
    img.addEventListener('load', finish);
    img.addEventListener('error', finish);
    const attach = src => {
      if (!img.isConnected) { finish(); return; }
      img.src = src;
    };
    if (img.hasAttribute('data-artwork-key')) {
      // Only cache misses consume a download slot. resolve still coalesces
      // repeated URLs and catches a file written since the initial probe.
      artworkCache.resolve(img.getAttribute('data-artwork-key'), url,
        img.hasAttribute('data-artwork-cache')).then(attach, () => attach(url));
    } else attach(url); // Cast photos deliberately stay out of disk storage.
  }
}
function schedulePosters() {
  if (!posterFrame) posterFrame = requestAnimationFrame(loadVisiblePosters);
}
main.addEventListener('scroll', () => {
  const delta = main.scrollTop - previousPosterScrollTop;
  if (Math.abs(delta) > 2) posterScrollDirection = delta > 0 ? 1 : -1;
  previousPosterScrollTop = main.scrollTop;
  posterQueueDirty = true;
  schedulePosters();
}, true);
// Chromium 53 supports MutationObserver even when lazy loading and modern
// intersection observers are unavailable. Observe structure, not img.src,
// to avoid invalidating geometry after each individual image completion.
const posterLayoutObserver = new MutationObserver(() => {
  posterQueueDirty = true;
  schedulePosters();
});
posterLayoutObserver.observe(main, {childList:true, subtree:true});
// OptimizedMediaImage uses Symbols.person_rounded in Plezy's cast strip and actor screen.
// Use the same filled person fallback for absent, pending and failed images on Chromium 53.
function personPortrait(imageUrl, className) {
  const node=el('div',undefined,className);
  const fallback=el('span',undefined,'person-placeholder');
  fallback.setAttribute('aria-hidden','true');
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 24 24');
  const head=document.createElementNS('http://www.w3.org/2000/svg','circle');
  head.setAttribute('cx','12');head.setAttribute('cy','8');head.setAttribute('r','4');
  head.setAttribute('fill','currentColor');
  const shoulders=document.createElementNS('http://www.w3.org/2000/svg','path');
  shoulders.setAttribute('d','M12 14c-2.67 0-8 1.34-8 4v1c0 .55.45 1 1 1h14c.55 0 1-.45 1-1v-1c0-2.66-5.33-4-8-4z');
  shoulders.setAttribute('fill','currentColor');
  svg.appendChild(head);svg.appendChild(shoulders);
  fallback.appendChild(svg);node.appendChild(fallback);
  if (imageUrl) node.appendChild(artworkImage(imageUrl, false, img => img.remove()));
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
  path.setAttribute('d', 'M21 5v12.17l-2-2V5H6.83l-2-2H19c1.1 0 2 .9 2 2zM2.1 2.1L.69 3.51l1.31 1.32V19c0 1.1.9 2 2 2h14.17l1.32 1.32 1.41-1.41L2.1 2.1zM4 19V6.83l5.59 5.59L6 17h11.17l2 2H4z');
  icon.append(path);
  node.textContent = '';
  node.append(icon);
}
function poster(item, options = {}) {
  const node = el('div', undefined, 'poster'); const image = api.image(item, options);
  if (image) node.appendChild(artworkImage(image, true, img => {
    img.remove(); unavailablePoster(node);
  }, api.artworkVersion(item, options)));
  else unavailablePoster(node);
  return node;
}
// Page preparation is disk-only. Cached artwork becomes decoded memory hits
// before cards are inserted, including across full app restarts. Uncached art
// still loads lazily through the bounded network queue and fades in.
async function prewarmPosters(items, sourceApi = api, options = {}) {
  // Prewarm only the opening viewport and two adjacent rows, as Plezy's
  // sliver prefetch does. The rest is decoded on demand by the scroll queue.
  const limit = artworkWindowCount(main.clientWidth, main.clientHeight,
    {landscape:!!options.landscape});
  const keys = [];
  for (const item of items.slice(0, limit)) {
    const url = sourceApi.image(item, options);
    if (!url) continue;
    const key = artworkCacheKey(url, sourceApi.artworkVersion(item, options), catalogScope(sourceApi.server));
    if (key) keys.push(key);
  }
  if (options.protectFirst) artworkCache.protect(keys.slice(0, options.protectFirst));
  await artworkCache.prewarm(keys);
}
async function prewarmShelves(shelves, sourceApi = api) {
  // Home/recommendations can contain arbitrarily many horizontal shelves.
  // Decode the visible shelf columns and nearby rows, never every shelf.
  const landing = shelfWindow(shelves, main.clientWidth, main.clientHeight);
  const keys = [];
  for (const item of landing) {
    const url = sourceApi.image(item);
    if (!url) continue;
    const key = artworkCacheKey(url, sourceApi.artworkVersion(item), catalogScope(sourceApi.server));
    if (key) keys.push(key);
  }
  artworkCache.protect(keys);
  await artworkCache.prewarm(keys);
}
async function prewarmDetail({item, parentShow}, sourceApi) {
  const episode = item.type === 'episode' || item.type === 'Episode';
  const posterItem = item.poster ? item : (parentShow || item);
  await prewarmPosters([posterItem], sourceApi, {detail:true, landscape:episode});
  const hero = item.background ? item : parentShow;
  if (sourceApi instanceof Plex && hero?.background) {
    const key = artworkCacheKey(sourceApi.backdrop(hero), sourceApi.backdropVersion(hero), catalogScope(sourceApi.server));
    if (key) await artworkCache.prewarm([key]);
  }
}
function cards(items, grid = false) {
  const node = el('div', undefined, grid ? 'grid' : 'cards'); items.forEach(item => node.append(card(item))); return node;
}
// Source: lib/widgets/episode_card.dart — 16:9 thumb, play overlay,
// index/title, 3-line synopsis and duration/air-date/quality metadata.
function episodeCard(item, onChanged = () => {}) {
  const label = (item.raw?.index != null ? item.raw.index + '. ' : '') + item.title;
  const entry = el('div', undefined, 'episode-entry');
  entry.dataset.catalogId = item.id;
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
  if (metadata.length) {
    const meta = el('small', undefined, 'episode-row-meta');
    metadata.forEach((value, index) => {
      if (index) meta.append(el('span', '•', 'episode-row-meta-separator'));
      meta.append(el('span', value, 'episode-row-meta-value'));
    });
    details.append(meta);
  }
  node.append(image, details);
  entry._refreshWatchState = () => {
    Array.from(image.querySelectorAll('.badge,.episode-progress')).forEach(control => control.remove());
    if(item.watched)image.append(el('span','✓','badge'));
    if(item.resume>0 && item.duration>0){
      const progress=el('progress',undefined,'episode-progress');
      progress.max=item.duration;progress.value=item.resume;image.append(progress);
    }
    entry._catalogSignature=JSON.stringify(item);
  };
  const more = detailMoreOptions(() => episodeMenuActions(item,
    () => { entry._refreshWatchState(); onChanged(); },
    () => { ++detailWatchEpoch; }), true);
  more.classList.add('episode-row-more');
  more.querySelector('.detail-icon').dataset.focus = item.id + ':more';
  more.querySelector('.detail-icon').setAttribute('aria-label','More options for '+label);
  more.querySelector('.detail-icon').setAttribute('title','More options for '+label);
  entry.append(node, more);
  return entry;
}
async function paginated(loader, currentRevision, options = {}) {
  let mountedRevision = currentRevision;
  // The first page may be a persisted snapshot. Refresh callbacks replace
  // only the grid, preserving focus and scroll; unchanged pages never repaint.
  let start = 0, loading = false, completed = false, listening = false;
  let pageGeneration = 0, forceShiftedPages = false;
  const loadedPages = new Map();
  let watchedOverride;
  const watchExceptions = new Map();
  const applyWatchOverride = item => {
    const watched = watchExceptions.has(item.id) ? watchExceptions.get(item.id) : watchedOverride;
    if (watched !== undefined) updateLocalWatchState(item, watched);
  };
  const grid = options.grouped ? el('div', undefined, 'collection-sections') :
    options.episodes ? el('div', undefined, 'episode-list') : cards([], true);
  const sentinel = el('div', undefined, 'page-sentinel');
  const errorMessage = el('p', '', 'error');
  errorMessage.setAttribute('role', 'alert');
  const retry = button('Retry loading', () => load(), 'library-retry');
  retry.hidden = true;
  main.append(grid, sentinel, errorMessage, retry);
  const windowed = options.windowed ? libraryPageWindow({main, grid, paint:paintWindow,
    focus:focusWithoutJump}) : null;
  let pendingFocus = null, total = 0;
  if (windowed) {
    grid._libraryWindow = windowed;
    grid._moveAcrossPage = (current, direction) => {
      pendingFocus = null;
      const index = windowed.adjacentIndex(current, direction);
      if (index < 0 || windowed.isMounted(index)) return false;
      if (windowed.has(index)) {
        focusWithoutJump(windowed.reveal(index));
        return true;
      }
      if (completed || index >= total || errorMessage.textContent) return false;
      pendingFocus = {current, direction, intent:navigationIntent};
      load();
      return true;
    };
    grid.addEventListener('focusout', () => { pendingFocus = null; });
    windowed.resume();
  }
  const startedAt = options.startedAt === undefined ? Date.now() : options.startedAt;
  function makeCard(item) {
    const node = options.episodes ? episodeCard(item,
      () => {
        watchExceptions.set(item.id, item.watched);
        options.onWatchChanged?.(loadedPages);
      }) : card(item);
    node._catalogSignature = JSON.stringify(item);
    node._catalogItem = item;
    return node;
  }
  function addPage(target, page) {
    const fragment = document.createDocumentFragment();
    if (options.grouped) {
      let lastSection = target.lastElementChild;
      for (const group of page.groups) {
        if (!group.items.length) continue;
        if (!lastSection || lastSection.dataset.libraryId !== String(group.libraryId)) {
          lastSection = el('section', undefined, 'collection-library-section');
          lastSection.dataset.libraryId = String(group.libraryId);
          lastSection.append(el('h2', group.libraryTitle, 'detail-children-title'),
            cards([], true));
          fragment.appendChild(lastSection);
        }
        const cardsFragment = document.createDocumentFragment();
        group.items.forEach(item => cardsFragment.appendChild(makeCard(item)));
        lastSection.querySelector('.grid').appendChild(cardsFragment);
      }
    } else {
      page.items.forEach(item => fragment.appendChild(makeCard(item)));
    }
    target.appendChild(fragment);
  }
  // Reconcile items by stable ID and metadata. An unchanged card keeps its
  // DOM, click handler, focus and decoded <img>; only changed cards are made.
  // Insert/move nodes only where the server actually changed their position.
  function reconcileCards(container, items) {
    const existing = new Map();
    Array.from(container.children).forEach(node => {
      const key = node.dataset && (node.dataset.catalogId || node.dataset.focus);
      if (key) existing.set(String(key), node);
    });
    items.forEach((item, index) => {
      const key = String(item.id), signature = JSON.stringify(item);
      let node = existing.get(key);
      existing.delete(key);
      if (!node || node._catalogSignature !== signature) node = makeCard(item);
      if (container.children[index] !== node)
        container.insertBefore(node, container.children[index] || null);
    });
    while (container.children.length > items.length)
      container.removeChild(container.lastChild);
  }
  function paintWindow(items) {
    const wanted = new Set(items.map(item => item.id));
    for (const node of Array.from(grid.children))
      if (!wanted.has(node._catalogItem?.id)) node.remove();
    reconcileCards(grid, items);
    schedulePosters();
  }
  function repaintPages() {
    const oldFocus = grid.contains(document.activeElement) ?
      document.activeElement.dataset.focus : null;
    const scroll = main.scrollTop;
    if (options.grouped) {
      // Adjacent paginated groups of the same library share a section.
      const groups = [];
      for (const page of loadedPages.values()) for (const group of page.groups) {
        if (!group.items.length) continue;
        let dest = groups[groups.length - 1];
        if (!dest || String(dest.libraryId) !== String(group.libraryId)) {
          dest = {libraryId:group.libraryId, libraryTitle:group.libraryTitle, items:[]};
          groups.push(dest);
        }
        dest.items.push(...group.items);
      }
      const available = Array.from(grid.querySelectorAll('.collection-library-section'));
      const used = new Set();
      groups.forEach((group, index) => {
        let section = available.find(node => !used.has(node) &&
          node.dataset.libraryId === String(group.libraryId));
        if (!section) {
          section = el('section', undefined, 'collection-library-section');
          section.dataset.libraryId = String(group.libraryId);
          section.append(el('h2', group.libraryTitle, 'detail-children-title'),
            cards([], true));
        }
        used.add(section);
        const heading = section.querySelector('h2');
        if (heading.textContent !== group.libraryTitle) heading.textContent = group.libraryTitle;
        if (grid.children[index] !== section)
          grid.insertBefore(section, grid.children[index] || null);
        reconcileCards(section.querySelector('.grid'), group.items);
      });
      while (grid.children.length > groups.length) grid.removeChild(grid.lastChild);
    } else {
      const items = [];
      for (const page of loadedPages.values()) items.push(...page.items);
      if (windowed) {
        windowed.replace(items);
        if (!items.length) grid.append(el('p', 'No titles found.', 'muted'));
        return;
      }
      reconcileCards(grid, items);
    }
    if (!grid.children.length) grid.append(el('p', 'No titles found.', 'muted'));
    main.scrollTop = scroll;
    if (oldFocus && (!grid.contains(document.activeElement) ||
        document.activeElement.dataset.focus !== oldFocus)) {
      const selected = Array.from(grid.querySelectorAll('[data-focus]')).find(
        node => node.dataset.focus === oldFocus);
      if (selected) focusWithoutJump(selected, false);
    }
    schedulePosters();
  }
  function listen() {
    if (listening) return;
    listening = true;
    main.addEventListener('scroll', onScroll);
    if (observer) observer.observe(sentinel);
  }
  function cleanup() {
    if (!listening) return;
    listening = false;
    main.removeEventListener('scroll', onScroll);
    if (observer) observer.disconnect();
  }
  async function applyFresh(offset, initialPage, update) {
    const watchEpoch = detailWatchEpoch;
    const isCurrentPage = () => loadedPages.get(offset) === initialPage;
    if (!update || !update.changed || mountedRevision !== revision ||
        !grid.isConnected || !isCurrentPage()) return;
    const requestRevision = mountedRevision;
    if (!windowed) await prewarmPosters(update.value.items || [], api,
      {landscape:!!options.episodes, protectFirst:offset === 0 ? 24 : 0});
    if (mountedRevision !== revision || !grid.isConnected ||
        (windowed && mountedRevision !== requestRevision) || !isCurrentPage() ||
        detailWatchEpoch !== watchEpoch) return;
    if (watchedOverride !== undefined)
      update.value.items.forEach(applyWatchOverride);
    loadedPages.set(offset, update.value);
    // Plex offsets refer to positions, not title IDs. An insert, removal or
    // reorder can shift every later page without changing this page's length.
    // Keep metadata-only updates cheap, but never join different orderings.
    const shifted = initialPage.items.length !== update.value.items.length ||
      initialPage.items.some((item, index) => item.id !== update.value.items[index].id);
    if (shifted) {
      for (const key of Array.from(loadedPages.keys()))
        if (key > offset) loadedPages.delete(key);
      // Date grids validate cache lineage against the new predecessor.
      // Other paginators still need to bypass their old offset cache.
      ++pageGeneration;
      forceShiftedPages = !windowed;
      loading = false;
      pendingFocus = null;
      errorMessage.textContent = '';
      retry.hidden = true;
    }
    let next = 0;
    for (const [key, page] of loadedPages) next = Math.max(next, key + page.items.length);
    start = next;
    total = update.value.total;
    completed = !update.value.items.length || start >= total;
    repaintPages();
    if (completed) cleanup();
    else { listen(); requestAnimationFrame(check); }
  }
  function predecessorOf(offset) {
    if (!windowed) return null;
    let predecessor = null;
    for (const [key, page] of loadedPages) {
      if (key >= offset) break;
      predecessor = {offset:key, page};
    }
    return predecessor;
  }
  async function repairBoundary(offset, isCurrent) {
    // Walk back only if Plex also moved the preceding boundary. The first
    // verifiable update discards shifted successors through applyFresh.
    for (let previous = predecessorOf(offset); previous && isCurrent();) {
      const {offset, page} = previous;
      previous = predecessorOf(offset);
      try {
        const result = await loader(offset, false, previous);
        if (!isCurrent()) return;
        // A detached refresh may already have repaired this page on disk.
        if (result.cached && JSON.stringify(page) !== JSON.stringify(result.value)) {
          await applyFresh(offset, page, {value:result.value, changed:true});
          watchFresh(offset, result.value, result.fresh);
          return;
        }
        const update = result.fresh ? await result.fresh : {value:result.value, changed:true};
        if (update.error) throw update.error;
        if (isCurrent() && update.changed) await applyFresh(offset, page, update);
        return;
      } catch (error) {
        if (!(error instanceof PlexLibraryBoundaryChanged)) throw error;
      }
    }
  }
  function watchFresh(offset, initialPage, pending) {
    if (!pending) return;
    const watchEpoch = detailWatchEpoch;
    const requestRevision = mountedRevision;
    const requestGeneration = pageGeneration;
    const isCurrent = () => watchEpoch === detailWatchEpoch &&
      (!windowed || (mountedRevision === requestRevision && mountedRevision === revision &&
        grid.isConnected && pageGeneration === requestGeneration));
    pending.then(update => {
      if (!isCurrent()) return;
      if (update.error instanceof PlexLibraryBoundaryChanged)
        return repairBoundary(offset, isCurrent);
      return applyFresh(offset, initialPage, update);
    }).catch(() => { /* Offline updates keep the saved view usable. */ });
  }
  async function revalidateFirstPage(requestRevision) {
    const reconcile = page => {
      if (requestRevision !== mountedRevision || mountedRevision !== revision || !grid.isConnected)
        return;
      const original = loadedPages.get(0);
      if (original && JSON.stringify(original) !== JSON.stringify(page))
        return applyFresh(0, original, {value:page, changed:true});
    };
    const result = await options.reloadFirstPage();
    // A refresh may have updated the cache while this grid was detached.
    // Compare the cached page with the mounted one before extending it.
    await reconcile(result.value);
    const update = await result.fresh;
    if (update?.changed) await reconcile(update.value);
  }
  grid._markWatched = watched => {
    watchedOverride = watched;
    watchExceptions.clear();
    for (const page of loadedPages.values()) {
      for (const item of page.items) updateLocalWatchState(item, watched);
    }
    for (const node of Array.from(grid.children)) {
      node._refreshWatchState?.();
      if (node._catalogItem) node._catalogSignature = JSON.stringify(node._catalogItem);
    }
    if (options.onWatchChanged) options.onWatchChanged(loadedPages);
  };
  grid._applyCatalogUpdate = (offset, update) => {
    const original = loadedPages.get(offset);
    if (original) return applyFresh(offset, original, update);
  };
  grid._suspendCatalog = grid._destroyCatalog = () => {
    pendingFocus = null;
    if (windowed) {
      ++pageGeneration;
      loading = false;
      windowed.suspend();
    }
    cleanup();
  };
  grid._resumeCatalog = restoredRevision => {
    mountedRevision = restoredRevision;
    windowed?.resume();
    if (options.reloadFirstPage && loadedPages.has(0))
      revalidateFirstPage(restoredRevision).catch(() => { /* Keep the cached grid offline. */ });
    if (!completed) { listen(); requestAnimationFrame(check); }
  };
  async function load() {
    if (loading || completed || mountedRevision !== revision || !grid.isConnected) return;
    loading = true;
    retry.hidden = true;
    errorMessage.textContent = '';
    const offset = start;
    const requestRevision = mountedRevision;
    const requestGeneration = pageGeneration;
    const canApply = () => mountedRevision === revision && grid.isConnected &&
      requestGeneration === pageGeneration &&
      (!windowed || (requestRevision === mountedRevision && offset === start));
    try {
      let response = offset === 0 ? options.initialPage : null;
      options.initialPage = null;
      if (!response) {
        try {
          response = await loader(offset, forceShiftedPages, predecessorOf(offset));
        } catch (error) {
          if (!(error instanceof PlexLibraryBoundaryChanged) || !canApply()) throw error;
          await repairBoundary(offset, canApply);
          if (!canApply()) return;
          response = await loader(offset, true, predecessorOf(offset));
        }
      }
      const page = response && Object.prototype.hasOwnProperty.call(response, 'value')
        ? response.value : response;
      const fresh = response && response.fresh;
      if (!canApply()) return;
      // Preserve first-frame cached navigation, but never gate scrolling
      // entries on disk reads or image decoding. schedulePosters handles them.
      if (offset === 0) await prewarmPosters(page.items, api,
        {landscape:!!options.episodes, protectFirst:24});
      if (!canApply()) return;
      if (start === 0) fadeDelayedContent(grid, startedAt);
      if (watchedOverride !== undefined)
        page.items.forEach(applyWatchOverride);
      if (windowed) windowed.append(page.items);
      else addPage(grid, page);
      loadedPages.set(offset, page);
      if (watchedOverride !== undefined) options.onWatchChanged?.(loadedPages);
      start += page.items.length;
      total = page.total;
      completed = !page.items.length || start >= total;
      if (pendingFocus && pendingFocus.intent === navigationIntent &&
          pendingFocus.current === document.activeElement) {
        const index = windowed.adjacentIndex(pendingFocus.current, pendingFocus.direction);
        if (index >= 0 && windowed.has(index)) {
          pendingFocus = null;
          focusWithoutJump(windowed.reveal(index));
        } else if (index >= 0 && !completed) {
          requestAnimationFrame(() => { if (pendingFocus) load(); });
        }
      }
      if (completed) { pendingFocus = null; cleanup(); }
      if (!start && !grid.children.length) grid.append(el('p', 'No titles found.', 'muted'));
      schedulePosters();
      watchFresh(offset, page, fresh);
    } catch (error) {
      if (canApply()) {
        pendingFocus = null;
        errorMessage.textContent = 'Could not load library titles: ' + error.message;
        retry.hidden = false;
      }
    } finally {
      if (requestGeneration === pageGeneration) {
        loading = false;
        if (mountedRevision === revision && grid.isConnected && !completed && !errorMessage.textContent)
          requestAnimationFrame(check);
      }
    }
  }
  function check() {
    if (mountedRevision !== revision || !grid.isConnected || completed) { cleanup(); return; }
    if (loading || (windowed && errorMessage.textContent)) return;
    const rect = sentinel.getBoundingClientRect();
    const pane = main.getBoundingClientRect();
    if (rect.top <= pane.bottom + pane.height * 0.8) load();
  }
  const onScroll = () => check();
  const observer = typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver(check, {root: main, rootMargin: '700px'}) : null;
  listen();
  await load();
  if (completed) cleanup();
  else requestAnimationFrame(check);
}
async function render(prepared = null) {
  let currentRevision = ++revision;
  pendingRailEntryRevision=null;lastRailRightRevision=null;
  const focusFromRail = enterPaneAfterNavigation;
  enterPaneAfterNavigation = false;
  let preferredFocus = null, detailRefresh = null;
  updateDetailTrackStatus = null;
  cancelAuth(); detailMenu = null;
  if (activeAlphabet) { activeAlphabet.destroy(); activeAlphabet = null; }
  main.classList.remove('has-alpha-bar');
  main.querySelector('.detail')?._disposeDetail?.();
  main.querySelector('.paged-window-grid')?._destroyCatalog();
  main.textContent = ''; main.scrollTop = 0; navigation();
  main.classList.toggle('settings-view', route.type === 'settings' || route.type === 'settings-page');
  const valid = () => currentRevision === revision;
  try {
    if (!api && !['settings', 'settings-page', 'add', 'plex', 'simkl'].includes(route.type)) route = {type: 'settings'};
    if (route.type === 'settings') {
      settings();
      if (!api) preferredFocus = main.querySelector('[data-focus="setting:plex-sign-in"]');
    }
    else if (route.type === 'settings-page') {
      settingsSubpage(route.page, route.serverId);
      preferredFocus = main.querySelector('.settings-tile:not(:disabled)');
    }
    else if (route.type === 'add') addForm(route.kind);
    else if (route.type === 'plex') { await plexSignIn(); return; }
    else if (route.type === 'simkl') { await simklSignIn(); return; }
    else if (route.type === 'home') {
      title('Your next watch', activeServer().name);
      const contentStartedAt = beginContentEntrance();
      // Keep the first frame quiet instead of flashing a temporary text
      // message while the home shelves are fetched.
      const rows = await catalogCache.get('home', () => api.home()); if (!valid()) return;
      await prewarmShelves(rows);
      if (!valid()) return;
      if (!rows.length) {
        const empty = el('section');
        empty.append(el('p', 'No recommendations yet. Browse a library to find something to watch.'),
          button('Browse libraries', () => go({type: 'libraries'}), 'primary'));
        main.append(fadeDelayedContent(empty, contentStartedAt));
      }
      rows.forEach(row => { const section = el('section', undefined, 'shelf'); section.append(el('h2', row.title), cards(row.items)); main.append(fadeDelayedContent(section, contentStartedAt)); });
      // Empty-state content is a completed render too; a heading alone is not.
      homeRenderedRevision = currentRevision;
    } else if (route.type === 'libraries') {
      title('Libraries', activeServer().name);
      const contentStartedAt = beginContentEntrance();
      const libraries = libraryCacheFor === api ? libraryCache : await api.libraries(); if (!valid()) return;
      if (libraryCacheFor !== api) { libraryCacheFor = api; libraryCache = libraries; navigation(); }
      if (!libraries.length) main.append(fadeDelayedContent(el('p', 'No video libraries are available for this account.'), contentStartedAt));
      else main.append(fadeDelayedContent(el('p', 'Select a library from the navigation rail to browse its recommended titles, collections and playlists.', 'muted'), contentStartedAt));
    } else if (route.type === 'library') {
      libraryRenderRevision = currentRevision;
      const forceRefresh = !!route.forceRefresh;
      if (forceRefresh) delete route.forceRefresh;
      title(route.library.title); const currentApi = api;
      const view = route.view || 'browse';
      const tabs = el('div', undefined, 'library-tabs');
      // This tab's DOM can be detached and restored without remounting it.
      // Refresh the revision gate used by async data and alphabet callbacks.
      tabs._resumeLibraryView = restoredRevision => { currentRevision = restoredRevision; };
      [{id:'recommended', name:'Recommended'}, {id:'browse',name:'Browse'},
        {id:'collections',name:'Collections'}, {id:'playlists',name:'Playlists'}].forEach(tab => {
        const control = button(tab.name, () => go({...route, view: tab.id, forceRefresh:false}, false),
          view === tab.id ? 'active' : '');
        control.setAttribute('aria-pressed', String(view === tab.id));
        tabs.append(control);
      });
      main.append(tabs);
      const contentStartedAt = beginContentEntrance();
      if (currentApi instanceof Plex && view === 'collections') {
        await paginated((start, shifted) => savedPage('collections:' + route.library.id + ':' + start,
          () => currentApi.collections(route.library.id, start),
          {force:forceRefresh || shifted, priority:start === 0}), currentRevision,
          {startedAt:contentStartedAt});
        if (valid()) focusFirst(main, focusFromRail ? preferredPaneControl() : null, focusFromRail);
        return;
      }
      if (currentApi instanceof Plex && view === 'playlists') {
        await paginated((start, shifted) => savedPage('playlists:' + start,
          () => currentApi.playlists(start),
          {force:forceRefresh || shifted, priority:start === 0}), currentRevision,
          {startedAt:contentStartedAt});
        if (valid()) focusFirst();
        return;
      }
      if (currentApi instanceof Plex && view === 'recommended') {
        const result = await savedPage('recommended:' + route.library.id,
          () => currentApi.recommended(route.library.id),
          {force:forceRefresh, priority:true});
        if (!valid()) return;
        const anchor = document.createComment('recommended-shelves');
        main.append(anchor);
        let mounted = [], paintGeneration = 0;
        async function paintShelves(shelves, updated = false) {
          const generation = ++paintGeneration;
          await prewarmShelves(shelves, currentApi);
          if (!valid() || !anchor.isConnected || generation !== paintGeneration) return;
          const focused = updated && main.contains(document.activeElement)
            ? document.activeElement : null;
          const section = focused?.closest('.shelf');
          const focusKey = focused?.dataset.focus;
          const scroll = main.scrollTop;
          const horizontal = new Map(mounted.filter(node => node.classList.contains('shelf'))
            .map(node => [node, node.querySelector('.cards').scrollLeft]));
          mounted = reconcileRecommendedShelves(anchor, mounted, shelves, card);
          if (!updated) mounted.forEach(node => fadeDelayedContent(node, contentStartedAt));
          if (updated) {
            if (focused && document.activeElement !== focused) {
              const originalSection = section && mounted.includes(section) ? section : null;
              const candidates = originalSection
                ? Array.from(originalSection.querySelectorAll('[data-focus]'))
                : [];
              let selected = focused.isConnected ? focused : candidates.find(
                node => node.dataset.focus === focusKey);
              if (!selected && focusKey) selected = Array.from(
                main.querySelectorAll('.shelf [data-focus]')).find(
                node => node.dataset.focus === focusKey);
              if (selected) focusWithoutJump(selected, false);
            }
            main.scrollTop = scroll;
            horizontal.forEach((left, node) => {
              if (mounted.includes(node)) node.querySelector('.cards').scrollLeft = left;
            });
          }
          schedulePosters();
        }
        tabs._applyRecommendedUpdate = shelves => paintShelves(shelves, true);
        await paintShelves(result.value);
        if (result.fresh) result.fresh.then(update => {
          if (update.changed && valid()) paintShelves(update.value, true).catch(() => {});
        }).catch(() => {});
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
      const refreshAction = detailButton('Refresh', () => {
        // Explicit refresh must fetch a new page and new artwork revisions.
        catalogCache.clear();
        go({...route, forceRefresh:true}, false);
      }, 'restart', 'library-toolbar-button');
      toolbar.append(sortAction, filterAction, refreshAction);
      filters.hidden = true; watchFilters.hidden = true;
      main.append(toolbar, filters, watchFilters);
      const libraryRoute = {...route};
      const browseKey = (offset, count) => 'browse:' + JSON.stringify([
        libraryRoute.library.id, selected, selectedFilter, libraryRoute.alpha || '',
        offset, count || null]);
      const isPlexDateSort = currentApi instanceof Plex &&
        (selected === 'recent' || selected === 'release');
      const libraryLoader = (start, count, shifted = false, predecessor, force = forceRefresh) =>
        savedPage(browseKey(start, count),
          () => predecessor
            ? currentApi.listAfter(libraryRoute.library.id, selected, selectedFilter, predecessor)
            : currentApi.list(libraryRoute.library.id, start, selected, selectedFilter, count,
              currentApi instanceof Jellyfin ? libraryRoute.alpha : undefined),
          {force:force || shifted, priority:start === 0 && !libraryRoute.alpha,
            predecessor:predecessor ? {key:browseKey(predecessor.offset), page:predecessor.page} : null});
      if (currentApi instanceof Plex && selected === 'title') {
        // Flutter LibraryBrowseTab starts the first page and firstCharacter
        // fetch together; hide the rail on an unsupported server/failed index.
        // The first titles page is independent of the alphabet index.
        // Missing/slow bucket metadata must never delay visible cached titles.
        const characterRequest = savedPage(
          'characters:' + JSON.stringify([route.library.id, selectedFilter]),
          () => currentApi.firstCharacters(route.library.id, selectedFilter),
          {force:forceRefresh, priority:true}).catch(() => ({value:[],fresh:null}));
        const firstResult = await libraryLoader(0).catch(error => ({error}));
        if (!valid()) return;
        if (firstResult.error) {
          await paginated((start, shifted) => libraryLoader(start, undefined, shifted), currentRevision,
            {startedAt:contentStartedAt});
        } else if (firstResult.value.total >= 80) {
          await prewarmPosters(firstResult.value.items, currentApi, {protectFirst:24});
          if (!valid()) return;
          // Further pages can be restored from disk too, but alpha navigation
          // uses true Plex offsets rather than flattened sorted list positions.
          const alphaLoader = async (start, count) => {
            const result = await libraryLoader(start, count);
            if (result.fresh) result.fresh.then(async update => {
              if (!update.changed || !valid() || !activeAlphabet) return;
              await prewarmPosters(update.value.items, currentApi);
              if (valid() && activeAlphabet)
                activeAlphabet.updateRange(start, update.value);
            }).catch(() => {});
            return result.value;
          };
          activeAlphabet = mountAlphabetLibrary({
            main, firstPage: firstResult.value, characters:[], showRail:false,
            loader: alphaLoader,
            card, schedulePosters, focusWithoutJump, isActive: valid,
            startedAt:contentStartedAt,
            prewarmPage: (items, targetOffset = 0, columns = 1) =>
              prewarmPosters(items.slice(artworkWindowStart(targetOffset, columns)), currentApi)
          });
          if (firstResult.fresh) firstResult.fresh.then(async update => {
            if (!update.changed || !valid() || !activeAlphabet) return;
            await prewarmPosters(update.value.items, currentApi, {protectFirst:24});
            if (valid() && activeAlphabet) activeAlphabet.updateRange(0, update.value);
          }).catch(() => {});
          characterRequest.then(result => {
            if (!valid() || !activeAlphabet) return;
            const apply = characters => {
              if (!valid() || !activeAlphabet) return;
              activeAlphabet.updateCharacters(characters);
              const enabled = showPlexAlphaBar(firstResult.value.total, characters, selected);
              activeAlphabet.setRailVisible(enabled);
              main.classList.toggle('has-alpha-bar', enabled);
            };
            apply(result.value);
            if (result.fresh) result.fresh.then(update => {
              if (update.changed) apply(update.value);
            }).catch(() => {});
          }).catch(() => {});
        } else {
          await paginated((start, shifted) => libraryLoader(start, undefined, shifted), currentRevision,
            {initialPage:firstResult, startedAt:contentStartedAt});
        }
      } else if (currentApi instanceof Jellyfin) {
        // Native MediaBrowserAlphaBarStrategy uses a synthetic 27-letter
        // NameStartsWith filter rather than the Plex offset/scroll strategy.
        const firstPage = await libraryLoader(0).catch(error => ({error}));
        if (!valid()) return;
        if (firstPage.error) {
          await paginated((start, shifted) => libraryLoader(start, undefined, shifted), currentRevision, {startedAt:contentStartedAt});
        } else if (firstPage.value.total >= 80 || route.alpha) {
          main.classList.add('has-alpha-bar');
          await paginated((start, shifted) => libraryLoader(start, undefined, shifted), currentRevision,
            {initialPage:firstPage, startedAt:contentStartedAt});
          if (!valid()) return;
          activeAlphabet = mountMediaBrowserAlphabet({
            main, selected:route.alpha, focusWithoutJump,
            onPrefixChange: next => go({...route, alpha:next, alphaFocus:true}, false)
          });
        } else {
          await paginated((start, shifted) => libraryLoader(start, undefined, shifted), currentRevision,
            {initialPage:firstPage, startedAt:contentStartedAt});
        }
      } else {
        await paginated((start, shifted, predecessor) =>
          libraryLoader(start, undefined, shifted, predecessor), currentRevision, {startedAt:contentStartedAt,
          windowed:isPlexDateSort, reloadFirstPage:isPlexDateSort
            ? () => libraryLoader(0, undefined, false, null, false) : null});
      }
      if (valid() && route.alphaFocus && activeAlphabet) activeAlphabet.focus();
      if (valid() && pendingRailEntryRevision===currentRevision) {
        pendingRailEntryRevision=null;
        // A deliberate move away while loading cancels the pending handoff.
        if (document.activeElement !== main) { schedulePosters(); return; }
        focusFirst(main, preferredPaneControl(), true);
      }
    } else if (route.type === 'person' && api instanceof Plex) {
      // Plezy ActorMediaScreen._buildActorHeader, not a movie-detail poster.
      const currentApi=api, personRoute={...route};
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
      const contentStartedAt=beginContentEntrance();
      // The catalog lookup must survive unavailable Plex Discover details.
      savedPage('person-details:' + personRoute.id, () => currentApi.personDetails(personRoute.id)).then(result=>{
        const paintDetails = details => {
          if(!valid()||!header.isConnected||!details)return;
          facts.textContent=''; bio.textContent='';
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
          if(facts.childNodes.length)fadeDelayedContent(facts,contentStartedAt);
          if(details.biography){
            const text=el('p',details.biography,'actor-biography-text');
            const long=details.biography.length>320;
            if(long)text.classList.add('collapsed');
            bio.append(text);
            fadeDelayedContent(bio,contentStartedAt);
            if(long){
              const expand=button('Show more',()=>{
                const open=text.classList.toggle('collapsed');
                expand.textContent=open?'Show more':'Show less';
              },'actor-biography-toggle');
              expand.dataset.focus='actor-biography';
              bio.append(expand);
            }
          }
        };
        paintDetails(result.value);
        if (result.fresh) result.fresh.then(update => {
          if (update.changed) paintDetails(update.value);
        }).catch(()=>{});
      }).catch(()=>{});
      await paginated(async start=>{
        const result=await savedPage('person-media:' + JSON.stringify([personRoute.id,personRoute.actor,start]),
          () => currentApi.personMedia(personRoute.id,start,personRoute.actor), {priority:start===0});
        const page=result.value;
        if(!start&&valid()&&header.isConnected){
          fadeDelayedContent(count,contentStartedAt);
          count.textContent=page.total+' '+(page.total===1?'title':'titles');
        }
        if (!start && result.fresh) result.fresh.then(update => {
          if (update.changed && valid() && header.isConnected)
            count.textContent=update.value.total+' '+(update.value.total===1?'title':'titles');
        }).catch(()=>{});
        return result;
      },currentRevision,{startedAt:contentStartedAt});
    } else if (route.type === 'search') searchForm();
    else if (route.type === 'detail') {
      const currentApi = api, detailRoute = {...route};
      const detailServerScope = catalogScope(activeServer());
      const result = prepared?.detailBundle ? {value:prepared.detailBundle} :
        await savedPage('detail:' + JSON.stringify([detailRoute.id, detailRoute.kind]), async () => {
          const item = await currentApi.detail(detailRoute.id, detailRoute.kind);
          const raw = item.raw || {};
          const parentId = currentApi instanceof Plex
            ? (item.type === 'season' ? raw.parentRatingKey :
              item.type === 'episode' ? raw.grandparentRatingKey : null) : null;
          let parentShow = null;
          if (parentId) {
            try { parentShow = await currentApi.detail(parentId, 'show'); } catch (_) {}
          }
          return {item, parentShow};
        }, {force:!!prepared?.force});
      if (!valid()) return;
      const {item, parentShow} = result.value;
      const watchEpochAtRender = detailWatchEpoch;
      const isPlexShow = currentApi instanceof Plex && item.type === 'show';
      const isSeason = item.type === 'season' || item.type === 'Season';
      const isEpisode = item.type === 'episode' || item.type === 'Episode';
      const raw = item.raw || {};
      if (!prepared?.detailBundle) {
        await prewarmDetail(result.value, currentApi);
        if (!valid()) return;
      }
      if (result.fresh) detailRefresh = async () => {
        const update = await result.fresh;
        if (!update.changed || !valid() || detailWatchEpoch !== watchEpochAtRender ||
            player.active || !dialog.hidden || detailMenu) return;
        await prewarmDetail(update.value, currentApi);
        if (!valid() || detailWatchEpoch !== watchEpochAtRender ||
            player.active || !dialog.hidden || detailMenu) return;
        const focus = main.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
        const railFocus = nav.contains(document.activeElement) ? document.activeElement.dataset.navId : null;
        const scroll = main.scrollTop, nextRevision = revision + 1;
        await render({detailBundle:update.value});
        if (revision !== nextRevision || api !== currentApi || route.id !== detailRoute.id || route.type !== 'detail') return;
        if (railFocus) {
          const railTarget = Array.from(nav.querySelectorAll('[data-nav-id]')).find(n => n.dataset.navId === railFocus);
          if (railTarget) focusWithoutJump(railTarget, false);
        }
        main.scrollTop = scroll;
        const target = focus && Array.from(main.querySelectorAll('[data-focus]')).find(n => n.dataset.focus === focus);
        if (target) focusWithoutJump(target, false);
      };
      const showRaw = parentShow?.raw || {};
      const content = el('div', undefined, 'detail'), info = el('div', undefined, 'detail-info');
      // Back reattaches this DOM with its original handlers. Keep an active
      // revision separate from render()'s stale async guard.
      let mountedDetailRevision = currentRevision, detailDisposed = false;
      const detailActive = () => !detailDisposed && currentApi === api &&
        mountedDetailRevision === revision && content.isConnected &&
        route.type === 'detail' && String(route.id) === String(detailRoute.id) &&
        route.kind === detailRoute.kind;
      content._resumeDetail = restoredRevision => { mountedDetailRevision = restoredRevision; };
      content._disposeDetail = () => { detailDisposed = true; };
      if (isSeason) content.classList.add('detail-season');
      content.classList.add(item.type === 'episode' || item.type === 'Episode' ? 'detail-episode' : 'detail-media');
      const heroMedia = item.background ? item : (parentShow?.background ? parentShow : null);
      if (api instanceof Plex && heroMedia) {
        const hero = el('div', undefined, 'detail-backdrop');
        // Server-transcoded low-resolution artwork, not a source-sized image.
        hero.append(artworkImage(api.backdrop(heroMedia), true, null,
          api.backdropVersion(heroMedia)), el('div', undefined, 'detail-backdrop-shade'));
        main.append(hero);
      }
      if (parentShow) {
        const parentLink = button(parentShow.title, () => go({type:'detail',id:parentShow.id,kind:'show'}), 'detail-series-link');
        parentLink.dataset.focus = 'detail-series';
        info.append(parentLink);
      }
      if (isEpisode && raw.parentIndex != null && raw.index != null) {
        const context = el('p', undefined, 'detail-context');
        if (currentApi instanceof Plex && raw.parentRatingKey) {
          const seasonLink = button('Season ' + raw.parentIndex,
            () => go({type:'detail', id:raw.parentRatingKey, kind:'season'}), 'detail-season-link');
          seasonLink.dataset.focus = 'detail-season';
          context.append(seasonLink);
        } else context.append(document.createTextNode('Season ' + raw.parentIndex));
        context.append(document.createTextNode(' · Episode ' + raw.index));
        info.append(context);
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
          if(!ratingLine.parentNode)chips.append(ratingLine);
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
        if(ratingLine.children.length&&!ratingLine.parentNode)chips.append(ratingLine);
        if(!ratingLine.children.length&&ratingLine.parentNode)ratingLine.remove();
      }
      showRatings();
      if(ratingsLoading) {
        // Results belong to this DOM snapshot, even while it is detached.
        // Only update its own chip; never update another route or account.
        const ratingsAlive=()=>!detailDisposed&&currentApi===api;
        // All active sources start independently. Keep the loader inside
        // the pill, then publish their combined result in a single render.
        const personalTask=simklReady?simklTracker.getTitleRating(api,ratingItem)
          .then(score=>{if(ratingsAlive()&&!ownRatingChanged)ownRating=score;})
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
          if(!ratingsAlive())return;
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
          if(ratingsAlive())community=mergeProviderRatings(answers);
        })();
        Promise.all([communityTask,personalTask]).then(()=>{
          if(!ratingsAlive())return;
          ratingsLoading=false;
          showRatings();
        }).catch(error=>{
          console.warn('Rating loading failed',error);
          if(!ratingsAlive())return;
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
      const refreshWatchState = watched => {
        refreshDetailWatchActions(actions, item);
        if (item.folder && detailActive())
          forEachPagedGrid(main, grid => grid._markWatched(watched));
      };
      // The original watch request may finish while this detail is reopened
      // from a cached item. Refresh this instance only when identity and
      // account scope match; do not remount the DOM or steal focus.
      content._syncWatchState = (sourceApi, sourceScope, sourceRoute, watched) => {
        if (!detailActive() || currentApi !== sourceApi ||
            detailServerScope !== sourceScope ||
            String(detailRoute.id) !== String(sourceRoute.id) ||
            detailRoute.kind !== sourceRoute.kind) return;
        updateLocalWatchState(item, watched);
        refreshWatchState(watched);
      };
      let watchMutationPending = false;
      const markDetailWatched = async watched => {
        if (watchMutationPending) return;
        watchMutationPending = true;
        const trackerEpochAtMutation = simklTracker.epoch;
        // Retire a background detail revalidation that may have started before
        // the user's watch action, so it cannot remount stale metadata.
        ++detailWatchEpoch;
        try {
          await currentApi.watched(item, watched);
          // WatchActions finishes acknowledged writes even if the initiating
          // detail is unmounted. A different server/account must not inherit it.
          if (currentApi !== api || catalogScope(activeServer()) !== detailServerScope) return;
          updateLocalWatchState(item, watched);
          // Invalidate any detail revalidation started before the acknowledgment.
          ++detailWatchEpoch;
          catalogCache.clear();
          persistDetailWatchState(item, detailRoute, detailServerScope);
          if (currentApi instanceof Plex && simklTracker.epoch === trackerEpochAtMutation)
            simklTracker.markWatched(currentApi, item, watched);
          // Keep the original detached snapshot coherent, but also reconcile a
          // newly mounted detail for this same title after Back/reopening.
          if (!detailDisposed) refreshWatchState(watched);
          const visibleDetail = main.querySelector('.detail');
          if (visibleDetail && visibleDetail !== content)
            visibleDetail._syncWatchState?.(currentApi, detailServerScope, detailRoute, watched);
          if (!detailActive()) return;
          notify(watched ? 'Marked as watched' : 'Marked as unwatched');
        } finally { watchMutationPending = false; }
      };
      const chooseEpisode = async () => {
        if (item.type === 'show' || item.type === 'Series') {
          try {
            const next = await currentApi.onDeck(item.id);
            if (next) {
              try { return await currentApi.detail(next.id,'episode'); }
              catch (_) { return next; }
            }
          } catch (_) { /* On Deck is optional */ }
        }
        const first = await currentApi.children(item.id);
        if (item.type === 'season' || item.type === 'Season')
          return first.items.find(e => e.type === 'episode' || e.type === 'Episode') || null;
        let firstEpisode=null;
        for (const season of first.items) {
          const episodes = await currentApi.children(season.id);
          const candidates=episodes.items.filter(e => e.type === 'episode' || e.type === 'Episode');
          const resumed=candidates.find(e=>e.resume>0);
          if(resumed) {
            try { return await currentApi.detail(resumed.id,'episode'); }
            catch (_) { return resumed; }
          }
          if(!firstEpisode)firstEpisode=candidates.find(e=>!e.watched)||candidates[0];
        }
        if(firstEpisode)return firstEpisode;
        return null;
      };
      // Native _buildPlaybackTracksStatus sits at the far right of the hero's
      // action row, outside its 60% text column. It is not a focus target.
      const trackStatus = el('div', undefined, 'detail-playback-tracks');
      trackStatus.hidden = true;
      trackStatus.setAttribute('role','note');
      const statusLine = el('div', undefined, 'detail-playback-tracks-line');
      trackStatus.append(statusLine);
      let statusTarget = null, trackProbeGeneration = 0;
      const trackStatusLive = () => currentApi === api && route.type === 'detail' &&
        String(route.id) === String(detailRoute.id) && trackStatus.isConnected;
      const paintTrackStatus = incoming => {
        if (!trackStatusLive()) return;
        if (incoming && statusTarget && String(incoming.id) === String(statusTarget.id))
          Object.assign(statusTarget, incoming);
        const index = item.folder ? 0 : route.mediaIndex || 0;
        const preview = statusTarget && previewDetailTracks(statusTarget, index, episodeTrackChoices);
        trackStatus.hidden = !preview;
        if (!preview) return;
        trackStatus.setAttribute('aria-label', preview.label);
        // The action row and the right-side note share a baseline. Avoid
        // stretching the left action row or adding a sixth D-pad stop.
        const container = content.getBoundingClientRect();
        const buttons = Array.from(actions.children).filter(node => !node.hidden);
        const last = buttons[buttons.length - 1]?.getBoundingClientRect();
        const left = Math.max(container.width * .60, last ? last.right - container.left + 12 : 0);
        trackStatus.style.left = Math.min(container.width, left) + 'px';
        trackStatus.style.top = (actions.getBoundingClientRect().bottom - container.top - 56) + 'px';
        // FittedMetadataLine's priority order: long codec details, picture
        // labels, audio language, then the subtitle decision. Never clip the
        // trailing subtitle text because a preceding quality label is long.
        const units = preview.parts.map(part => ({...part, visible:true, showDetail:!!part.detail}));
        const draw = () => {
          statusLine.textContent = '';
          units.filter(part => part.visible).forEach((part, i) => {
            if (i) statusLine.append(el('span', '  •  ', 'detail-track-separator'));
            const unit = el('span', undefined, 'detail-track-unit');
            if (part.kind) unit.append(detailSvg(part.kind === 'audio' ? 'volume' : 'subtitles'));
            unit.append(el('span', part.primary));
            if (part.showDetail) unit.append(el('span', ' · ' + part.detail));
            statusLine.append(unit);
          });
        };
        draw();
        for (let attempt = 0; attempt < units.length * 2 &&
             statusLine.getBoundingClientRect().width > trackStatus.clientWidth + 1; attempt++) {
          let candidate = -1, priority = -1;
          units.forEach((part, i) => {
            const next = part.showDetail ? 3 : part.visible ? part.priority : -1;
            if (next >= priority && next >= 0) { priority = next; candidate = i; }
          });
          if (candidate < 0) break;
          if (units[candidate].showDetail) units[candidate].showDetail = false;
          else units[candidate].visible = false;
          draw();
        }
      };
      updateDetailTrackStatus = paintTrackStatus;
      const probeTrackStatus = async () => {
        const generation = ++trackProbeGeneration;
        try {
          const target = item.folder ? await chooseEpisode() : item;
          if (!target || !trackStatusLive() || generation !== trackProbeGeneration) return;
          const index = item.folder ? 0 : route.mediaIndex || 0;
          const detailed = sourceStreamsComplete(target,index) ? target :
            await currentApi.detail(target.id,target.type);
          if (!trackStatusLive() || generation !== trackProbeGeneration) return;
          statusTarget = detailed;
          paintTrackStatus();
        } catch (_) { /* A failed metadata probe must not prevent Play. */ }
      };
      trackStatus._updateTracks = paintTrackStatus;
      trackStatus._probeTracks = probeTrackStatus;
      if (item.folder && (isPlexShow || isSeason)) {
        actions.append(detailButton('Play', async () => {
          const expectedRevision = revision;
          const episode = await chooseEpisode();
          if (!detailActive() || revision !== expectedRevision) return;
          if (episode) play(episode, episode.resume || 0);
          else notify('No playable episodes were found.');
        }, 'play', 'detail-play'));
        // Show/season actions from MediaDetailScreen.action_buttons.dart.
        let shuffleRequest = 0;
        actions.append(detailButton('Shuffle', async () => {
          const currentApi = api, expected = revision;
          const playbackAtStart = playbackLaunch, request = ++shuffleRequest;
          const isCurrent = () => detailActive() && expected === revision && currentApi === api &&
            request === shuffleRequest && playbackAtStart === playbackLaunch;
          let random;
          try {
            random = await shuffledEpisode(currentApi, item, isCurrent);
          } catch (error) {
            if (isCurrent()) throw error;
            return;
          }
          if (!isCurrent()) return;
          if (random) return play(random, 0);
          notify('No playable episodes were found.');
        }, 'shuffle', 'detail-icon'));
        actions.append(detailWatchButton(item, markDetailWatched));
        if (api instanceof Plex) actions.append(detailButton('Rate',()=>showRatingSheet(item,api,
          ({tracker,value})=>{
            if(tracker && ratingItem?.id===item.id){ownRatingChanged=true;ownRating=value;showRatings();}
          }),'rating','detail-icon'));
        const extra = [];
        if (parentShow) extra.push({label:'View series', action:() =>
          go({type:'detail',id:parentShow.id,kind:'show'})});
        extra.push({label:'Audio & Subtitles', action:() => showMediaTrackSheet(item, chooseEpisode)});
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
          select.onchange = () => {
            route.mediaIndex = Number(select.value);
            trackStatus.hidden = true;
            probeTrackStatus();
          };
          version.append(select); actions.append(version);
        }
        const restart = detailButton('Play from beginning',
          () => play(item, 0), 'restart', 'detail-icon detail-restart');
        restart.hidden = !(item.resume > 0);
        actions.append(restart);
        actions.append(detailWatchButton(item, markDetailWatched));
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
        if (!isEpisode) extra.push({label:'Audio & Subtitles', action:() => showMediaTrackSheet(item)});
        if (parentShow) extra.push({label:'View series', action:() =>
          go({type:'detail',id:parentShow.id,kind:'show'})});
        if (isEpisode && raw.parentRatingKey) extra.push({label:'View season', action:() =>
          go({type:'detail',id:raw.parentRatingKey,kind:'season'})});
        actions.append(detailMoreOptions(() => isEpisode ? episodeMenuActions(item, () => {
          persistDetailWatchState(item, detailRoute, detailServerScope);
          refreshDetailWatchActions(actions, item);
        }, () => { ++detailWatchEpoch; }).concat(extra) : extra));
      }
      info.append(actions);
      content.append(trackStatus);
      // The parent-show link precedes season and episode actions. Start TV
      // focus on Play/Resume, keeping the link available via D-pad navigation.
      if (isSeason || isEpisode) preferredFocus = actions.querySelector('.detail-play');
      if (!item.background && !isEpisode) content.append(poster(item.poster ? item : (parentShow || item), {detail:true}));
      content.append(info);
      if (isEpisode)
        content.append(poster(item, {detail:true,landscape:true}));
      else if (isSeason && item.background)
        content.append(poster(item.poster ? item : (parentShow || item), {detail:true}));
      main.append(content);
      // As in native _scheduleTargetProbe, allow the detail to paint before
      // fetching the playable episode's stream catalog.
      setTimeout(() => { if (valid() && content.isConnected) probeTrackStatus(); }, 350);
      if (item.folder) {
        const currentApi = api;
        const grouped = currentApi instanceof Plex && item.type === 'collection';
        if (!grouped) {
          const heading = el('h2', item.type === 'show' || item.type === 'Series' ? 'Seasons' :
            item.type === 'season' ? 'Episodes' : 'Titles');
          heading.className = 'detail-children-title';
          main.append(heading);
        }
        const loadChildren = grouped ? mergedCollectionLoader(currentApi, item,
          collectionIndex, catalogScope(activeServer()))
          : start => currentApi.children(item.id, start, item.type);
        // Merged collections have a stateful cursor. Cached pages can be
        // consumed before revalidation finishes, so serialize cursor advances.
        let childrenRequest = Promise.resolve();
        const requestChildren = start => {
          const task = childrenRequest.then(() => loadChildren(start));
          childrenRequest = task.catch(() => {});
          return task;
        };
        await paginated(start => savedPage('children:' + JSON.stringify([item.id,item.type,grouped,start]),
          () => requestChildren(start), {priority:start===0}), currentRevision, {grouped,
          episodes: item.type === 'season' || item.type === 'Season',
          startedAt:beginContentEntrance(),
          onWatchChanged: pages => {
            for (const [start, page] of pages) {
              const key = savedCatalog.id(detailServerScope,
                'children:' + JSON.stringify([item.id,item.type,grouped,start]));
              savedCatalog.generations.set(key, (savedCatalog.generations.get(key) || 0) + 1);
              savedCatalog.remember(key, page);
              savedCatalog.write(key, page, start === 0).catch(() => {});
            }
          }});
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
          if(code===37 && selectedIndex===0)return false;
          if(code===37)select(selectedIndex-1);
          if(code===39)select(selectedIndex+1);
          if(code===13)openActor(actors[selectedIndex]);
          return true;
        };
        select(0);
        section.append(strip); main.append(section);
      }
    }
  } catch (error) {
    if (!valid()) return;
    main.append(el('p', error.message, 'error'), button('Retry', render), button('Settings', () => go({type: 'settings'})));
  } finally {
    if (libraryRenderRevision === currentRevision) libraryRenderRevision = null;
  }
  if (valid()) {
    if (detailRefresh) detailRefresh().catch(() => {});
    schedulePosters();
    if (route.focus) {
      const found = Array.from(main.querySelectorAll('[data-focus]')).find(n => n.dataset.focus === route.focus);
      // Restore the previous reading/scroll position BEFORE focusing its card.
      // Native focus scrolling must not pull a restored library back to row 1.
      main.scrollTop = route.scroll || 0;
      restoreShelfScrolls(route.shelfScrolls);
      if (found) focusWithoutJump(found, false);
      else focusFirst(main, focusFromRail ? preferredPaneControl() : preferredFocus, focusFromRail);
    } else if (!(route.alphaFocus && activeAlphabet))
      focusFirst(main, focusFromRail ? preferredPaneControl() : preferredFocus, focusFromRail);
  }
}
function sourceStreamsComplete(item, mediaIndex) {
  return !!(item.raw?.Media?.[mediaIndex]?.Part?.[0]?.Stream ||
    item.raw?.MediaSources?.[mediaIndex]?.MediaStreams || item.raw?.MediaStreams);
}
async function play(item, start, transcode = false) {
  const sourceApi = api, sourceRoute = route, mediaIndex = route.mediaIndex || 0;
  const launch = ++playbackLaunch;
  // Stream IDs belong to a specific media part. Resolve the complete catalog
  // for movie and episode launch, including from lightweight Home cards.
  const playable = ['movie','episode'].includes(String(item.type).toLowerCase());
  if (playable && !sourceStreamsComplete(item, mediaIndex)) {
    try {
      const detailed = await sourceApi.detail(item.id, item.type);
      if (sourceApi !== api || sourceRoute !== route || launch !== playbackLaunch) return;
      Object.assign(item, detailed);
    } catch (error) {
      // Metadata lookups should not prevent normal playback when offline.
      if (sourceApi !== api || sourceRoute !== route || launch !== playbackLaunch) return;
    }
  }
  if (launch !== playbackLaunch) return;
  const tracks = mediaSourceTracks(item, mediaIndex);
  playbackReturn = {
    route, api, item,
    focus: main.contains(document.activeElement) ? document.activeElement : null
  };
  return player.open(api, item, {start, mediaIndex,
    transcode: transcode || state.quality === 'transcode',
    ...(playable ? episodeTrackChoices.resolve(item, mediaIndex, tracks) : {})});
}
function settings() {
  title(api ? 'Settings' : 'Welcome to Plezy');
  if (api) {
    settingsGroup(null, [
      settingsTile('Video Playback', 'Configure playback quality, subtitles and skipping.', 'play',
        () => go({type:'settings-page',page:'playback'}), 'playback'),
      ...(libraryCacheFor === api && libraryCache && libraryCache.length ? [
        settingsTile('Manage Libraries', 'Choose which libraries appear in the sidebar.', 'libraries',
          () => go({type:'settings-page',page:'libraries'}), 'libraries')] : []),
      settingsTile('Services', [validSession(state.simkl) ? 'Simkl' : '', state.mdblistApiKey ? 'MDBList' : '']
        .filter(Boolean).join(' · ') || 'Connect tracking and community ratings services.', 'sync',
        () => go({type:'settings-page',page:'services'}), 'services')
    ]);
    settingsGroup('Connections', [
      settingsTile('Add Connection', 'Connect another media server.', 'link',
        () => go({type:'settings-page',page:'add-connection'}), 'add-connection'),
      ...state.servers.map(server => settingsTile(server.name,
        server.kind.toUpperCase() + (server.id === activeServer()?.id ? ' · Active' : ''),
        'server', () => go({type:'settings-page',page:'server',serverId:server.id}), 'server:' + server.id))
    ]);
    settingsGroup(null, [settingsTile('About', 'Plezy for webOS · ' + VERSION, 'info',
      () => go({type:'settings-page',page:'about'}), 'about')]);
  } else {
    main.append(el('p', 'Connect a media server to get started.', 'settings-description'));
    settingsGroup('Connections', connectionChoices());
    settingsGroup(null,[settingsTile('Services','Connect Simkl or MDBList.','sync',
      ()=>go({type:'settings-page',page:'services'}),'services')]);
  }
}

// Port of SettingsGroup, SettingNavigationTile, SettingSwitchTile and
// SettingSelectionTile. Flutter's rounded Materials and symbol font become
// individual shaped DOM rows and bundled SVGs on Chromium 53. No new prefs.
function settingsIcon(name) {
  const paths = {
    play:'M8 5v14l11-7z M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z',
    libraries:'M4 4h16v3H4zm0 5h16v3H4zm0 5h16v3H4zm0 5h16v2H4z',
    sync:'M12 4V1L8 5l4 4V6a6 6 0 0 1 5.7 4h2.1A8 8 0 0 0 12 4zm0 16v3l4-4-4-4v3a6 6 0 0 1-5.7-4H4.2A8 8 0 0 0 12 20z',
    link:'M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.5 1.5 1.6 1.6 1.5-1.5a2.8 2.8 0 0 1 4 4l-3 3a2.8 2.8 0 0 1-4 0z M14 11a5 5 0 0 0-7.1 0l-3 3A5 5 0 0 0 11 21l1.5-1.5-1.6-1.6-1.5 1.5a2.8 2.8 0 0 1-4-4l3-3a2.8 2.8 0 0 1 4 0z',
    server:'M4 3h16v8H4zm3 3v2h2V6zm-3 7h16v8H4zm3 3v2h2v-2z',
    info:'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1 4h2v2h-2zm0 4h2v8h-2z',
    quality:'M3 5h18v14H3zm3 3v8h12V8z',
    intro:'M4 4h3v16H4zm5 0 11 8-11 8z',
    timer:'M10 2h4v2h-4zm2 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm1 2v5l-4 3-1-1.5 3-2.5V8z',
    tune:'M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z',
    pattern:'M3 4h18v3H3zm0 6h10v3H3zm0 6h18v3H3z',
    subtitles:'M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm1 6v2h6v-2zm8 0v2h6v-2zm-8 4v2h14v-2z',
    size:'M3 4h18v3h-9v13H9V7H3z',
    color:'M5 19h14v2H5zM12 2l7 15h-3l-1-3H9l-1 3H5zm0 5-2 5h4z',
    position:'M3 18h18v3H3zM10 3h4v10h4l-6 5-6-5h4z',
    margins:'M2 2h8v2H4v6H2zm12 0h8v8h-2V4h-6zM2 14h2v6h6v2H2zm18 0h2v8h-8v-2h6z',
    bold:'M6 3h8a5 5 0 0 1 3 9 5 5 0 0 1-3 9H6zm4 4v4h4a2 2 0 0 0 0-4zm0 8v3h4a1.5 1.5 0 0 0 0-3z',
    italic:'M9 3h10v3h-4l-4 12h4v3H5v-3h3l4-12H9z',
    border:'M3 3h18v18H3zm3 3v12h12V6z',
    hidden:'M2 4l18 17 1.5-1.5-18-17z M12 7c5 0 9 5 10 5-.6 1.5-2 3.1-4 4.2l-2-2a5 5 0 0 0-6.2-6.2L8 6.7c1.3-.5 2.7-.7 4-.7z',
    plex:'M7 3h4l6 9-6 9H7l6-9z',
    service:'M4 4h16v16H4zm3 3v10h10V7z'
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('aria-hidden','true');
  const path = document.createElementNS('http://www.w3.org/2000/svg','path');
  path.setAttribute('d',paths[name] || paths.info); path.setAttribute('fill','currentColor');
  if(name==='play') path.setAttribute('fill-rule','evenodd');
  svg.append(path); return svg;
}
function settingsGroup(heading, rows) {
  if (!rows.length) return;
  const group = el('section', undefined, 'settings-group');
  if (heading) group.append(el('h2',heading,'settings-group-heading'));
  const items = el('div',undefined,'settings-group-items');
  rows.forEach(row => items.append(row)); group.append(items); main.append(group);
}
function settingsTile(label, description, icon, action, key, kind = 'chevron') {
  const row = button('',action,'settings-tile');
  row.setAttribute('aria-label',label);
  row.dataset.focus='setting:' + key;
  const stack=el('span',undefined,'settings-tile-copy');
  stack.append(el('span',label,'settings-tile-title'));
  const summary=el('span',description,'settings-tile-subtitle');
  if (description) stack.append(summary);
  row.append(settingsIcon(icon),stack);
  if (kind==='switch') row.append(el('span',undefined,'settings-switch'));
  else if (kind==='color') row.append(el('span',undefined,'settings-color-swatch'));
  else row.append(el('span','›','settings-chevron'));
  return row;
}
function settingsPage(titleText, description) {
  const heading=el('header',undefined,'settings-page-header');
  const backButton=button('‹',back,'settings-back');
  backButton.setAttribute('aria-label','Back');
  heading.append(backButton,el('h1',titleText)); main.append(heading);
  if (description) main.append(el('p',description,'settings-description'));
}
function settingsToggle(field,label,description,icon) {
  const row=settingsTile(label,description,icon,() => {
    state[field]=!state[field];persist();reflect();
  },field,'switch');
  const reflect=() => {
    row.setAttribute('aria-pressed',String(!!state[field]));
    row.querySelector('.settings-switch').classList.toggle('on',!!state[field]);
  };
  reflect(); return row;
}
function closeSettingsDialog() {
  dialog.hidden=true;dialog.classList.remove('settings-dialog');
  dialog.removeAttribute('aria-label');
  const target=settingsDialogReturnFocus;
  settingsDialogReturnFocus=null;
  if (target && target.isConnected) focusWithoutJump(target,false);
  else focusFirst();
}
function openSettingsDialog(origin,heading) {
  dialog.classList.remove('exit-dialog');dialog.classList.add('settings-dialog');
  dialog.textContent='';dialog.setAttribute('aria-label',heading);
  dialog.append(el('h2',heading)); settingsDialogReturnFocus=origin;
  dialog.hidden=false;
}
function settingsSelection(field,label,description,icon,options) {
  const summary=() => options.find(item=>item[0]===state[field])?.[1] || '';
  const row=settingsTile(label,summary() + (description?' · '+description:''),icon,() => {
    openSettingsDialog(row,label);
    const choices=el('div',undefined,'settings-dialog-options');
    let selected=null;
    options.forEach(([value,text]) => {
      const choice=button(text,() => {
        state[field]=value;persist();
        row.querySelector('.settings-tile-subtitle').textContent=summary()+(description?' · '+description:'');
        closeSettingsDialog();
      },'settings-choice');
      choice.setAttribute('aria-pressed',String(value===state[field]));
      choices.append(choice);
      if(value===state[field])selected=choice;
    });
    dialog.append(choices,button('Cancel',closeSettingsDialog,'settings-cancel'));
    focusWithoutJump(selected || choices.firstChild,false);
  },field);
  return row;
}
function settingsTextInput(field,label,description,icon,{pattern=false}={}) {
  const summary=() => pattern?(state[field] || (field==='introPattern'?DEFAULT_INTRO_PATTERN:DEFAULT_CREDITS_PATTERN)) : state[field]+' seconds';
  const row=settingsTile(label,summary(),icon,() => {
    openSettingsDialog(row,label);
    dialog.append(el('p',description,'settings-dialog-description'));
    const form=el('form',undefined,'settings-dialog-form');form.noValidate=true;
    const input=el('input');input.type=pattern?'text':'number';input.value=String(summary());
    if(!pattern){input.value=String(state[field]);input.min='1';input.max='30';}
    input.setAttribute('aria-label',label);input.spellcheck=false;
    const error=el('p','','error');error.setAttribute('role','status');
    const actions=el('div',undefined,'settings-dialog-actions');
    const cancel=button('Cancel',closeSettingsDialog,'settings-cancel');
    const save=el('button','Save','primary');save.type='submit';
    actions.append(cancel,save);form.append(input,error,actions);
    form.addEventListener('submit',event => {
      event.preventDefault();
      const value=pattern?input.value:Number(input.value);
      try {
        if(pattern){if(!value.trim())throw Error();new RegExp(value,'i');}
        else if(!Number.isInteger(value)||value<1||value>30)throw Error();
      }catch(_){error.textContent=pattern?'Enter a nonempty valid regular expression.':'Use a delay between 1 and 30 seconds.';return;}
      state[field]=value;persist();
      row.querySelector('.settings-tile-subtitle').textContent=summary();
      closeSettingsDialog();
    });
    dialog.append(form);focusWithoutJump(input,false);
  },field);
  return row;
}
// Upstream SettingNumberTile opens TvNumberSpinner on TV. Left/right adjust;
// OK confirms, while Back cancels and restores the originating row.
function settingsNumber(field,label,icon,format) {
  const [min,max]=SUBTITLE_STYLE_BOUNDS[field];
  const row=settingsTile(label,format(state[field]),icon,()=>{
    openSettingsDialog(row,label);
    let value=state[field];
    const spinner=el('div',undefined,'settings-number-value');
    spinner.setAttribute('role','button');spinner.tabIndex=0;
    spinner.addEventListener('click',()=>focusWithoutJump(spinner,false));
    spinner.setAttribute('aria-label',label);
    const update=()=>{spinner.textContent=String(value);};
    const adjust=step=>{value=Math.max(min,Math.min(max,value+step));update();};
    const input=el('div',undefined,'settings-number-spinner');
    const minus=el('span','−','settings-number-step');
    const plus=el('span','+','settings-number-step');
    minus.addEventListener('click',()=>adjust(-1));
    plus.addEventListener('click',()=>adjust(1));
    update();input.append(minus,spinner,plus);
    const actions=el('div',undefined,'settings-dialog-actions');
    const cancel=button('Cancel',closeSettingsDialog,'settings-cancel');
    const save=button('Save',()=>{
      state[field]=value;persist();row.querySelector('.settings-tile-subtitle').textContent=format(value);
      closeSettingsDialog();
    },'primary');
    actions.append(cancel,save);
    // Numeric dialogs have just three focus stops. Explicit D-pad routes
    // prevent geometry navigation (and TV spatial navigation) from skipping
    // the value or trapping focus on the actions.
    const editor=el('div',undefined,'settings-number-editor');
    editor.addEventListener('keydown',event=>{
      // Some webOS engines move document.activeElement during the keydown
      // dispatch, before handlers run. The event target still identifies the
      // control which received the key, so use it as the navigation source.
      const current=event.target, key=event.keyCode;
      let next=null;
      if(current===spinner){
        if(key===37 || key===39)adjust(key===37?-1:1);
        else if(key===40)next=save;
        else if(key===13){save.click();event.preventDefault();event.stopPropagation();return;}
        else if(key!==38)return;
      } else if(current===save || current===cancel){
        if(key===38)next=spinner;
        else if(key===37 && current===save)next=cancel;
        else if(key===39 && current===cancel)next=save;
        else if(![37,39,40].includes(key))return;
      } else return;
      event.preventDefault();event.stopPropagation();
      focusWithoutJump(next || current,false);
    },true);
    editor.append(input,el('p','Range: '+min+'–'+max,'settings-dialog-description'),actions);
    dialog.append(editor);
    focusWithoutJump(spinner,false);
  },field);
  return row;
}

function hexToHsv(hex) {
  const channels=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255);
  const [r,g,b]=channels,max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;
  let h=0;
  if(delta>0) {
    if(max===r) h=((g-b)/delta)%6;
    else if(max===g) h=(b-r)/delta+2;
    else h=(r-g)/delta+4;
  }
  return [Math.round((h*60+360)%360),max===0?0:Math.round(delta/max*100),Math.round(max*100)];
}
function hsvToHex([h,s,v]) {
  const c=v/100*s/100,x=c*(1-Math.abs((h/60)%2-1)),m=v/100-c;
  const rgb=h<60?[c,x,0]:h<120?[x,c,0]:h<180?[0,c,x]:
    h<240?[0,x,c]:h<300?[x,0,c]:[c,0,x];
  return '#'+rgb.map(n=>Math.round((n+m)*255).toString(16).padStart(2,'0')).join('').toUpperCase();
}
// TV Color Picker: hue/saturation/value adjust horizontally, vertical keys
// traverse rows; the six-digit hex field permits exact colors.
function settingsColor(field,label,icon) {
  const row=settingsTile(label,'',icon,()=>{
    openSettingsDialog(row,label);
    let channels=hexToHsv(state[field]),hex=state[field];
    const preview=el('div',undefined,'settings-color-preview');
    const channelRows=[];
    const hexInput=el('input');hexInput.type='text';hexInput.maxLength=7;
    hexInput.setAttribute('aria-label','Hex Color');hexInput.spellcheck=false;
    const error=el('p','','error');error.setAttribute('role','status');
    const sync=(fromHex=false)=>{
      if(!fromHex){hex=hsvToHex(channels);hexInput.value=hex.substring(1);}
      preview.style.backgroundColor=hex;
      channelRows.forEach((entry,index)=>entry.textContent=
        ['H','S','V'][index]+'   '+channels[index]+(index===0?'°':'%'));
      error.textContent='';
    };
    const form=el('form',undefined,'settings-dialog-form');form.noValidate=true;
    const controls=el('div',undefined,'settings-color-channels');
    ['Hue','Saturation','Brightness'].forEach((name,index)=>{
      const channel=el('div',undefined,'settings-color-channel');
      channel.setAttribute('role','button');channel.tabIndex=0;
      channel.addEventListener('click',()=>focusWithoutJump(save,false));
      channel.setAttribute('aria-label',name);
      channel.addEventListener('keydown',event=>{
        if(event.keyCode===13){
          event.preventDefault();event.stopPropagation();
          save.click();return;
        }
        if(event.keyCode!==37 && event.keyCode!==39)return;
        event.preventDefault();event.stopPropagation();
        channels[index]=Math.max(0,Math.min(index===0?360:100,
          channels[index]+(event.keyCode===37?-5:5)));
        sync();
        setTimeout(()=>{if(!dialog.hidden && channel.isConnected)focusWithoutJump(channel,false);},0);
      });
      channelRows.push(channel);controls.append(channel);
    });
    hexInput.addEventListener('input',()=>{
      const entered='#'+hexInput.value.replace(/^#/,'').trim();
      if(/^#[0-9a-fA-F]{6}$/.test(entered)){
        hex=entered.toUpperCase();channels=hexToHsv(hex);sync(true);
      }
    });
    const hexLabel=el('label','Hex Color','settings-color-hex');hexLabel.append(hexInput);
    const actions=el('div',undefined,'settings-dialog-actions');
    const save=el('button','Save','primary');save.type='submit';
    actions.append(button('Cancel',closeSettingsDialog,'settings-cancel'),save);
    form.addEventListener('submit',event=>{
      event.preventDefault();
      const entered='#'+hexInput.value.replace(/^#/,'').trim();
      if(!/^#[0-9a-fA-F]{6}$/.test(entered)){
        error.textContent='Enter a six-digit hexadecimal color.';focusWithoutJump(hexInput,false);return;
      }
      state[field]=entered.toUpperCase();persist();reflect();closeSettingsDialog();
    });
    form.append(preview,controls,hexLabel,error,actions);dialog.append(form);
    hexInput.value=hex.substring(1);
    sync(true);focusWithoutJump(channelRows[0],false);
  },field,'color');
  const reflect=()=>{row.querySelector('.settings-color-swatch').style.backgroundColor=state[field];};
  reflect();return row;
}
function connectionChoices() {
  return [
    settingsTile('Sign in with Plex','Connect your Plex account.','plex',()=>go({type:'plex'}),'plex-sign-in'),
    settingsTile('Add Jellyfin','Connect a Jellyfin server.','server',()=>go({type:'add',kind:'jellyfin'}),'jellyfin'),
    settingsTile('Add Emby','Connect an Emby server.','server',()=>go({type:'add',kind:'emby'}),'emby'),
    settingsTile('Manual Plex server','Connect by server URL.','plex',()=>go({type:'add',kind:'plex'}),'plex-manual')
  ];
}
function settingsSubpage(page,serverId) {
  if(page==='playback') {
    settingsPage('Video Playback');
    settingsGroup('Player',[
      settingsToggle('srtPlayback','Enhanced SRT playback',
        'Use Direct Play and locally rendered SRT subtitles. Off uses original Plex burn-in.','subtitles'),
      settingsSelection('quality','Quality','Compatible playback requires server transcoding permission.',
        'quality',[['auto','Automatic'],['transcode','Compatible H.264 / AAC']])
    ]);
    settingsGroup('Subtitles',[
      settingsTile('Subtitle Styling','Customize subtitle appearance','subtitles',
        ()=>go({type:'settings-page',page:'subtitle-styling'}),'subtitle-styling')
    ]);
    const skipModes=[['off','Off'],['button','Show skip button'],['auto','Automatic skip']];
    settingsGroup('Auto-play & Skip',[
      settingsSelection('skipIntroMode','Skip intro','', 'intro',skipModes),
      settingsSelection('skipCreditsMode','Skip credits','', 'intro',skipModes),
      settingsToggle('forceSkipMarkerFallback','Prefer chapter markers',
        'Use chapter titles as skip markers instead of server markers.','tune'),
      settingsTextInput('autoSkipDelay','Automatic skip delay','Seconds before automatic skipping (1–30).','timer'),
      settingsTextInput('introPattern','Intro chapter pattern','Regular expression for matching intro chapters.','pattern',{pattern:true}),
      settingsTextInput('creditsPattern','Credits chapter pattern','Regular expression for matching credits chapters.','pattern',{pattern:true})
    ]);
  } else if(page==='subtitle-styling') {
    settingsPage('Subtitle Styling');
    settingsGroup('Text',[
      settingsNumber('subtitleFontSize','Font Size','size',value=>String(value)),
      settingsColor('subtitleTextColor','Text Color','color'),
      settingsNumber('subtitlePosition','Position','position',value=>
        value===0?'Top':value===100?'Bottom':value+'%'),
      settingsToggle('subtitleUseMargins','Use margins',
        'Allow text subtitles in the space outside the video. Styled subtitles may keep their original placement.','margins'),
      settingsToggle('subtitleBold','Bold','','bold'),
      settingsToggle('subtitleItalic','Italic','','italic')
    ]);
    settingsGroup('Border',[
      settingsNumber('subtitleBorderSize','Border Size','border',value=>String(value)),
      settingsColor('subtitleBorderColor','Border Color','color')
    ]);
  } else if(page==='libraries') {
    settingsPage('Manage Libraries','Choose which libraries appear in Plezy’s navigation rail.');
    if(libraryCacheFor!==api || !libraryCache) return;
    settingsGroup('Navigation',libraryCache.map(library=>{
      const key=activeServer().id+':'+library.id;
      const label=()=> (state.hiddenLibraryIds.includes(key)?'Show ':'Hide ')+library.title+' in sidebar';
      const row=settingsTile(label(),library.title,'libraries',()=>{
        const hidden=state.hiddenLibraryIds.includes(key);
        state.hiddenLibraryIds=hidden?state.hiddenLibraryIds.filter(x=>x!==key):state.hiddenLibraryIds.concat(key);
        persist();navigation();
        row.setAttribute('aria-label',label());row.querySelector('.settings-tile-title').textContent=label();
        row.setAttribute('aria-pressed',String(!state.hiddenLibraryIds.includes(key)));
        row.querySelector('.settings-switch').classList.toggle('on',!state.hiddenLibraryIds.includes(key));
      },'library:'+library.id,'switch');
      row.setAttribute('aria-pressed',String(!state.hiddenLibraryIds.includes(key)));
      row.querySelector('.settings-switch').classList.toggle('on',!state.hiddenLibraryIds.includes(key));
      return row;
    }));
  } else if(page==='services') {
    settingsPage('Services','Connect services for viewing progress and community ratings.');
    settingsGroup(null,[
      settingsTile('Simkl',validSession(state.simkl)?'Connected':'Not connected','service',
        ()=>go({type:'settings-page',page:'simkl-settings'}),'simkl'),
      settingsTile('MDBList',state.mdblistApiKey?'Connected':'Not connected','service',
        ()=>go({type:'settings-page',page:'mdblist-settings'}),'mdblist')
    ]);
  } else if(page==='simkl-settings') {
    settingsPage('Simkl');
    if(validSession(state.simkl)) {
      settingsGroup('Account',[
        ...(simklTracker.pendingStops().length ? [settingsTile('Retry saved Simkl stops ('+simklTracker.pendingStops().length+')',
          'Retry tracking updates that could not be sent.','sync',async()=>{
            await simklTracker.retryPending();if(route.page==='simkl-settings')render();
          },'simkl-retry')] : []),
        settingsTile('Disconnect Simkl','Stop synchronizing playback history.','service',()=>{
          simklTracker.reset();state.simkl=null;persist();render();
        },'simkl-disconnect')
      ]);
      main.append(el('p','Plex movies and episodes are tracked when playback starts, pauses, or stops. Manual watched changes also sync. Plex resume tracking remains independent.','settings-description'));
    } else settingsGroup('Account',[
      settingsTile('Connect Simkl','Link with a code on your phone.','link',()=>go({type:'simkl'}),'simkl-connect')
    ]);
  } else if(page==='mdblist-settings') {
    settingsPage('MDBList','Additional IMDb, Rotten Tomatoes, TMDB, Metacritic, Letterboxd, Trakt and MAL scores for the Plezy ratings pill.');
    if(state.mdblistApiKey) settingsGroup('Account',[
      settingsTile('Disconnect MDBList','Remove your API key from this TV.','service',()=>{
        state.mdblistApiKey='';persist();render();
      },'mdblist-disconnect')
    ]);
    else {
      const group=el('section',undefined,'settings-group');
      group.append(el('h2','Account','settings-group-heading'));
      const form=el('form',undefined,'settings-connect-form');
      const keyInput=el('input');keyInput.type='password';keyInput.required=true;
      keyInput.placeholder='MDBList API key';keyInput.setAttribute('aria-label','MDBList API key');keyInput.autocomplete='off';
      const submit=el('button','Connect MDBList','primary');submit.type='submit';
      const message=el('p','','muted');message.setAttribute('role','status');
      form.append(keyInput,submit,message);
      form.onsubmit=async event=>{
        event.preventDefault();const key=keyInput.value.trim(),expected=revision;
        if(!key)return;
        submit.disabled=true;message.textContent='Checking MDBList key…';
        try{
          await verifyMdblistKey(key);
          if(expected!==revision)return;
          state.mdblistApiKey=key;persist();keyInput.value='';render();
        }catch(error){if(expected===revision)message.textContent=error.message;}
        finally{submit.disabled=false;}
      };
      group.append(form);main.append(group);
    }
  } else if(page==='add-connection') {
    settingsPage('Add Connection');settingsGroup(null,connectionChoices());
  } else if(page==='server') {
    const server=state.servers.find(s=>s.id===serverId);
    if(!server){go({type:'settings'},false);return;}
    settingsPage(server.name,server.kind.toUpperCase()+' · '+server.url);
    settingsGroup('Connection',[
      settingsTile(server.id===activeServer()?.id?'Open server':'Switch to server',
        'Browse this server’s libraries and recommendations.','server',()=>{
          state.active=server.id;persist();setClient();go({type:'home'},false);
        },'server-open'),
      settingsTile('Remove from this TV','Removes the saved account token and catalog.','hidden',()=>{
        const scope = catalogScope(server);
        savedCatalog.removeScope(scope).catch(()=>{});
        artworkCache.removeScope(scope).catch(()=>{});
        state.servers=state.servers.filter(s=>s.id!==server.id);persist();setClient();go({type:'settings'},false);
      },'server-remove')
    ]);
  } else if(page==='about') {
    settingsPage('About');
    const about=el('section',undefined,'settings-about');
    const logo=el('img');logo.src='icon.png';logo.alt='Plezy';
    about.append(logo,el('h2','Plezy'),el('p','Version '+VERSION,'muted'),
      el('p','Community port for webOS 4.x and newer. Account tokens are stored on this TV; passwords are not. Removing a connection clears its token.'));
    main.append(about);
    settingsGroup('Diagnostics',[
      settingsToggle('diagnosticsEnabled','Enable diagnostics',
        'Show optional on-screen diagnostics during playback. Off by default; applies to the next playback.','info')
    ]);
  }
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
    results.classList.remove('content-enter');
    results.textContent = 'Searching…';
    const contentStartedAt=beginContentEntrance();
    try {
      const items = await currentApi.search(route.query); if (current !== searchRevision || revision !== expected) return;
      results.textContent = ''; results.append(el('h2', items.length + ' results'), cards(items, true));
      fadeDelayedContent(results,contentStartedAt);
      focusFirst(results);
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
          state.active = servers[0].id; persist(); setClient(); go({type: 'home'}, false); return;
        }
        // An account can have multiple owned/shared Plex servers. Let viewers
        // choose instead of silently opening whichever resource was listed first.
        code.remove();
        status.textContent = 'Choose a Plex server to browse:';
        const choices = el('div', undefined, 'actions');
        servers.forEach(server => choices.append(button(server.name, () => {
          state.active = server.id; persist(); setClient(); go({type: 'home'}, false);
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
        state.simkl = result.session; persist(); clearNavigationHistory();
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
  if (current.classList?.contains('cast-strip') && [37,39].includes(event.keyCode)) {
    event.preventDefault();
    // Left at the first cast member exits its locked-focus row.
    if (current.castKey?.(event.keyCode) !== false) return;
  }
  if (current.tagName === 'SELECT' && ['left', 'right'].includes(direction)) {
    event.preventDefault(); current.selectedIndex = Math.max(0, Math.min(current.options.length - 1, current.selectedIndex + (direction === 'left' ? -1 : 1)));
    current.dispatchEvent(new Event('change')); return;
  }
  if (current.tagName === 'INPUT' && ['left', 'right'].includes(direction)) return;
  event.preventDefault();
  const root = !dialog.hidden ? dialog : player.active ? player.root : document.querySelector('#shell');
  // Reuse geometry only during this synchronous focus decision. A new key
  // gets fresh bounds after scrolling, resize, animation or page changes.
  const bounds = new Map();
  const rectFor = node => {
    if (!bounds.has(node)) bounds.set(node, node.getBoundingClientRect());
    return bounds.get(node);
  };
  const inRail = nav.contains(current);
  const inMain = main.contains(current);
  if (activeAlphabet && route.type === 'library' && (route.view||'browse') === 'browse' &&
      inMain && direction === 'right' && current.matches('.grid .card')) {
    const rect = rectFor(current);
    const later = Array.from(main.querySelectorAll('.grid .card')).some(node => {
      const other = rectFor(node);
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
    if (libraryRenderRevision===revision && !main.querySelector('.grid .card,.shelf .card')) {
      // Flutter retains focus requests until the grid item is attached.
      // Park on the pane while loading; focusing a toolbar control would
      // make focusFirst treat our own temporary focus as a user's choice.
      pendingRailEntryRevision=revision;
      main.tabIndex = -1;
      focusWithoutJump(main, false);
      return;
    }
    const restored = rememberedPaneFocus && rememberedPaneFocus.isConnected &&
      main.contains(rememberedPaneFocus) ? rememberedPaneFocus : null;
    const windowed = main.querySelector('.paged-window-grid')?._libraryWindow;
    const target = restored || (windowed && rememberedPaneFocus?._libraryWindowIndex !== undefined &&
      windowed.focusById(rememberedPaneFocus._catalogItem.id)) || preferredPaneControl();
    if (target) focusWithoutJump(target);
    else { main.tabIndex = -1; focusWithoutJump(main); }
    return;
  }
  const validControls = scope => Array.from(scope.querySelectorAll(
    'button:not(:disabled),input,select,.cast-strip[tabindex]')).filter(node =>
      node !== current && node.getClientRects().length && !node.hidden);
  const choose = (candidates, axis) => nextFocus(rectFor(current),
    candidates.map(value => ({value, rect: rectFor(value)})), axis);
  const focusLastRailItem = () => {
    const controls = Array.from(nav.querySelectorAll('button[data-nav-id]:not(:disabled)'))
      .filter(node => !node.hidden && node.getClientRects().length);
    // Home is the first destination; it is the default before any rail focus
    // and when the remembered destination has been removed or hidden.
    const target = controls.find(node => node.dataset.navId === rememberedRailFocusId) ||
      controls[0];
    if (target) {
      rememberedPaneFocus = current;
      focusWithoutJump(target);
    }
  };
  if (dialog.hidden && !player.active && (inRail || inMain)) {
    const pagedGrid = inMain && current.closest('.paged-window-grid');
    if (pagedGrid && pagedGrid._moveAcrossPage(current, direction)) return;
    if (current === main && (direction === 'up' || direction === 'down')) {
      const target = main.querySelector('.paged-window-grid')?._libraryWindow.visibleCard();
      if (target) { focusWithoutJump(target); return; }
    }
    // Match upstream CastMemberStrip's onNavigateDown/onNavigateUp: the
    // last season/episode row leads into Cast, not off to a distant action.
    if (inMain && direction==='down' && current.matches('.grid .card,.episode-list .episode-row')) {
      const cast=main.querySelector('.cast-strip[tabindex]');
      if(cast){
        const currentRect=rectFor(current);
        const later=Array.from(main.querySelectorAll('.grid .card,.episode-list .episode-row'))
          .some(node=>node!==current && rectFor(node).top>currentRect.top+8);
        if(!later){focusWithoutJump(cast);return;}
      }
    }
    if (inMain && direction==='up' && current.classList.contains('cast-strip')) {
      const previous=Array.from(main.querySelectorAll('.grid .card,.episode-list .episode-row')).pop() ||
        main.querySelector('.detail-play');
      if(previous){focusWithoutJump(previous);return;}
    }
    const source = inRail ? nav : main;
    // HubSection consumes Right inside its locked-focus carousel, including
    // at the last card. Searching the whole pane here can jump into a lower
    // shelf whose cards happen to extend farther to the right.
    if (inMain && direction === 'right' && current.matches('.cards .card')) {
      const next = choose(validControls(current.closest('.cards')), 'right');
      if (next) focusWithoutJump(next);
      return;
    }
    // Spatial search must not send Left from the first artwork column to
    // a filter button somewhere up the screen. Flutter's D-pad focus boundary
    // returns to the last focused rail destination when the current row ends.
    if (inMain && direction === 'left') {
      if (current.classList.contains('cast-strip')) {
        focusLastRailItem();
        return;
      }
      // The first poster in a media row has no left-hand peer. Never
      // diagonally select a toolbar/tab from the row above it.
      const card = current.closest('.grid .card, .cards .card');
      const firstPoster = card && card.parentNode && card ===
        card.parentNode.querySelector('.card');
      if (firstPoster) {
        focusLastRailItem();
        return;
      }
      const rect = rectFor(current);
      const rowCandidates = validControls(main).filter(node => {
        const box = rectFor(node);
        return box.right <= rect.left + 8 &&
          box.top < rect.bottom - 4 && box.bottom > rect.top + 4;
      });
      const adjacent = choose(rowCandidates, 'left');
      if (adjacent) { focusWithoutJump(adjacent); return; }
      focusLastRailItem();
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
