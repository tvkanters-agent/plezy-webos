// SPDX-License-Identifier: GPL-3.0-only
export const VERSION = '1.5.0';
export function id() {
  const bytes = new Uint8Array(16);
  // A device ID is a local client identifier, not a secret. Some webOS app
  // contexts do not expose Web Crypto; keep first launch working on those TVs.
  let filled = false;
  try {
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(bytes);
      filled = true;
    }
  } catch (_) { /* Fall back to a non-cryptographic device ID. */ }
  if (!filled) {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
export function baseUrl(input) {
  let url;
  try { url = new URL(input.trim()); } catch (_) { throw new Error('Enter a full server URL, including http:// or https://.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP(S) server URL without embedded credentials, query parameters, or a fragment.');
  }
  return url.href.replace(/\/+$/, '');
}
// Preserve a reverse proxy's path prefix. Server-supplied URLs may not redirect
// an authentication token to a different origin.
export function endpoint(base, path, params = {}) {
  const root = new URL(base + '/');
  const url = /^https?:\/\//i.test(path) ? new URL(path) : new URL(base + '/' + path.replace(/^\/+/, ''));
  if (url.origin !== root.origin) throw new Error('The server returned a media URL on a different host.');
  Object.keys(params).forEach(key => {
    if (params[key] !== undefined && params[key] !== null) url.searchParams.set(key, String(params[key]));
  });
  return url.href;
}
export async function request(url, {method = 'GET', headers = {}, body, timeout = 15000, signal} = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abort);
  }
  const timer = setTimeout(abort, timeout);
  try {
    const response = await fetch(url, {method, headers: {Accept: 'application/json', ...headers},
      body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal});
    if (!response.ok) {
      const error = new Error(response.status === 401 || response.status === 403
        ? 'Sign-in was rejected. Check your account credentials and server access.'
        : 'The server returned HTTP ' + response.status + '.');
      error.status = response.status;
      throw error;
    }
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch (_) { throw new Error('The server did not return JSON. Check the server URL.'); }
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Request cancelled or timed out. Check that the TV can reach the server.');
    if (error instanceof TypeError) throw new Error('Cannot reach the server. Check its URL, network, certificate and CORS configuration.');
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abort);
  }
}
export function seconds(ticks) { return Math.max(0, Number(ticks) || 0) / 10000000; }
export function time(value) {
  value = Math.max(0, Math.floor(Number(value) || 0));
  const s = String(value % 60).padStart(2, '0');
  const m = Math.floor(value / 60) % 60;
  return value >= 3600 ? Math.floor(value / 3600) + ':' + String(m).padStart(2, '0') + ':' + s : m + ':' + s;
}
export function clamp(value, min, max) { return Math.max(min, Math.min(value, max)); }
export function readState(storage) {
  try {
    const state = JSON.parse(storage ? storage.getItem('plezy.webos') || '{}' : '{}');
    // Valid JSON can still contain stale, partial or corrupted account entries.
    // Ignore malformed servers instead of crashing during first navigation.
    const servers = Array.isArray(state.servers) ? state.servers.filter(server =>
      server && typeof server === 'object' &&
      ['plex', 'jellyfin', 'emby'].includes(server.kind) &&
      typeof server.id === 'string' && !!server.id &&
      typeof server.url === 'string' && /^https?:\/\//i.test(server.url) &&
      typeof server.token === 'string' && !!server.token &&
      (server.kind === 'plex' || (typeof server.userId === 'string' && !!server.userId))) : [];
    return {deviceId: typeof state.deviceId === 'string' && state.deviceId ? state.deviceId : id(),
      servers, active: typeof state.active === 'string' ? state.active : '',
      quality: state.quality === 'transcode' ? 'transcode' : 'auto',
      skipIntroMode: ['off','button','auto'].includes(state.skipIntroMode) ? state.skipIntroMode : 'button',
      skipCreditsMode: ['off','button','auto'].includes(state.skipCreditsMode) ? state.skipCreditsMode : 'button',
      autoSkipDelay: Number.isInteger(state.autoSkipDelay) && state.autoSkipDelay >= 1 && state.autoSkipDelay <= 30
        ? state.autoSkipDelay : 5,
      forceSkipMarkerFallback: state.forceSkipMarkerFallback === true,
      introPattern: typeof state.introPattern === 'string' && state.introPattern.trim() ? state.introPattern : '',
      creditsPattern: typeof state.creditsPattern === 'string' && state.creditsPattern.trim() ? state.creditsPattern : '',
      simkl: state.simkl && typeof state.simkl === 'object' ? state.simkl : null,
      mdblistApiKey: typeof state.mdblistApiKey==='string' ? state.mdblistApiKey : '',
      librariesHidden: state.librariesHidden === true,
      sidebarCollapsed: state.sidebarCollapsed === true,
      hiddenLibraryIds: Array.isArray(state.hiddenLibraryIds)
        ? state.hiddenLibraryIds.filter(x => typeof x === 'string').slice(0,100) : []};
  } catch (_) { return {deviceId: id(), servers: [], active: '', quality: 'auto', skipIntroMode: 'button', skipCreditsMode: 'button',
    autoSkipDelay: 5, forceSkipMarkerFallback: false, introPattern: '', creditsPattern: '',
    simkl: null, mdblistApiKey: '', librariesHidden: false, sidebarCollapsed: false, hiddenLibraryIds: []}; }
}
export function saveState(storage, state) {
  storage.setItem('plezy.webos', JSON.stringify(state));
}
// Geometry-based navigation works with both grids and horizontal media shelves.
export function nextFocus(origin, candidates, direction) {
  const horizontal = direction === 'left' || direction === 'right';
  const sign = direction === 'left' || direction === 'up' ? -1 : 1;
  const center = rect => ({x: rect.left + rect.width / 2, y: rect.top + rect.height / 2});
  const from = center(origin);
  let best = null, bestScore = Infinity;
  candidates.forEach(candidate => {
    const to = center(candidate.rect);
    const forward = (horizontal ? to.x - from.x : to.y - from.y) * sign;
    const perpendicular = Math.abs(horizontal ? to.y - from.y : to.x - from.x);
    if (forward <= 1) return;
    const overlap = horizontal
      ? Math.min(origin.bottom, candidate.rect.bottom) - Math.max(origin.top, candidate.rect.top)
      : Math.min(origin.right, candidate.rect.right) - Math.max(origin.left, candidate.rect.left);
    const score = forward + perpendicular * 3 + (overlap > 0 ? 0 : 10000);
    if (score < bestScore) { bestScore = score; best = candidate.value; }
  });
  return best;
}
