// SPDX-License-Identifier: GPL-3.0-only
// Simkl device authorization and event-only scrobbling, adapted from Plezy's
// SimklAuthService / SimklClient / SimklTracker.
import {VERSION} from './core.js';

export const SIMKL_CLIENT_ID = 'ec68bc6a9d04b3c50af8cc495f9c9bf478c2371b979aed7e3385bdb771b9b18d';
const BASE = 'https://api.simkl.com';
const SCOPE = 'media:read media:write';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const WRITE_GAP_MS = 1100;

function endpoint(path) {
  const url = new URL(path, BASE);
  url.searchParams.set('client_id', SIMKL_CLIENT_ID);
  url.searchParams.set('app-name', 'plezy');
  url.searchParams.set('app-version', VERSION);
  return url.href;
}
async function send(path, {form, body, token, signal, timeout = 15000} = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abort);
  }
  const timer = setTimeout(abort, timeout);
  try {
    const response = await fetch(endpoint(path), {
      method: form || body ? 'POST' : 'GET',
      headers: {
        Accept: 'application/json',
        ...(form ? {'Content-Type': 'application/x-www-form-urlencoded'} : {}),
        ...(body ? {'Content-Type': 'application/json', 'simkl-api-key': SIMKL_CLIENT_ID} : {}),
        ...(token ? {Authorization: 'Bearer ' + token} : {})
      },
      body: form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) { /* Status still determines failure. */ }
    return {status: response.status, data};
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Simkl request cancelled or timed out.');
    throw new Error('Simkl is unreachable from this TV. Check the network, TLS certificate and CORS support.');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abort);
  }
}
export function parseSession(response, previous) {
  if (!response || typeof response.access_token !== 'string' ||
      !response.access_token.startsWith('simkl_at_') ||
      !(response.scope || previous?.scope || '').split(' ').includes('media:write')) {
    throw new Error('Simkl did not grant a writable session. Reconnect with media:write permission.');
  }
  const refreshToken = response.refresh_token || (previous && previous.refreshToken);
  if (!refreshToken || typeof refreshToken !== 'string') throw new Error('Simkl omitted the refresh token.');
  const expires = Number(response.expires_in);
  if (!Number.isFinite(expires) || expires <= 0) throw new Error('Simkl returned an invalid token lifetime.');
  return {accessToken: response.access_token, refreshToken, expiresAt: Date.now() + expires * 1000,
    scope: response.scope || previous?.scope};
}
export function validSession(session) {
  return !!(session && typeof session.accessToken === 'string' &&
    session.accessToken.startsWith('simkl_at_') && typeof session.refreshToken === 'string' &&
    session.refreshToken && Number.isFinite(session.expiresAt) &&
    typeof session.scope === 'string' && session.scope.split(' ').includes('media:write'));
}
export async function beginSimklLink(signal) {
  const result = await send('/oauth2/device', {form: {client_id: SIMKL_CLIENT_ID, scope: SCOPE}, signal});
  if (result.status !== 200) throw new Error('Simkl device linking failed (HTTP ' + result.status + ').');
  const code = result.data;
  if (!code.device_code || !code.user_code || !code.verification_uri) throw new Error('Simkl returned an incomplete link code.');
  return code;
}
export async function pollSimklLink(code, signal) {
  const result = await send('/oauth2/token', {form: {grant_type: DEVICE_GRANT,
    client_id: SIMKL_CLIENT_ID, device_code: code.device_code}, signal});
  if (result.status === 200) return {session: parseSession(result.data)};
  const error = result.data && result.data.error;
  if (error === 'slow_down') return {pending: true, slowDown: true};
  if (error === 'authorization_pending' || result.status >= 500) return {pending: true};
  if (error === 'access_denied' || error === 'expired_token' || error === 'invalid_client') {
    throw new Error('Simkl authorization ' + (error === 'access_denied' ? 'was declined.' : 'expired or was rejected.'));
  }
  throw new Error('Simkl authorization failed (HTTP ' + result.status + ').');
}
export function simklMovieIds(raw) {
  const ids = {};
  const guids = Array.isArray(raw?.Guid) ? raw.Guid : [];
  for (const entry of guids) {
    const match = /^(imdb|tmdb|tvdb):\/\/([^/?#]+)/i.exec(entry?.id || '');
    if (!match) continue;
    const key = match[1].toLowerCase(), value = match[2];
    if (key === 'imdb' && /^tt\d+$/i.test(value)) ids.imdb = value;
    else if ((key === 'tmdb' || key === 'tvdb') && /^\d+$/.test(value)) ids[key] = Number(value);
  }
  // Legacy Plex metadata can carry a provider GUID without a Guid array.
  const legacy = /^(imdb|tmdb|tvdb):\/\/([^/?#]+)/i.exec(raw?.guid || '');
  if (legacy && !ids[legacy[1].toLowerCase()]) {
    const key = legacy[1].toLowerCase(), value = legacy[2];
    if (key === 'imdb' && /^tt\d+$/i.test(value)) ids.imdb = value;
    else if (key !== 'imdb' && /^\d+$/.test(value)) ids[key] = Number(value);
  }
  return ids;
}
export function scrobblePayload(item, show) {
  const raw = item?.raw;
  if (!raw) return null;
  if (item.type === 'movie') {
    const media = {title: item.title || raw.title, ids: simklMovieIds(raw)};
    if (raw.year) media.year = Number(raw.year);
    return media.title || Object.keys(media.ids).length ? {movie: media} : null;
  }
  if (item.type !== 'episode' || raw.parentIndex == null || raw.index == null ||
      !Number.isInteger(Number(raw.parentIndex)) || !Number.isInteger(Number(raw.index)) ||
      Number(raw.parentIndex) < 0 || Number(raw.index) < 1) return null;
  const series = show?.raw || show || {};
  const media = {title: series.title || raw.grandparentTitle, ids: simklMovieIds(series)};
  if (series.year) media.year = Number(series.year);
  if (!media.title && !Object.keys(media.ids).length) return null;
  return {show: media, episode: {season: Number(raw.parentIndex), number: Number(raw.index)}};
}
export function progressPercent(position, duration, ended = false) {
  if (ended) return 100;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) return null;
  return Math.round(Math.max(0, Math.min(100, position / duration * 100)) * 100) / 100;
}

// Only send events when media state changes. Plex still owns its separate
// 10-second heartbeat to keep its own progress / session state up to date.
export class SimklTracker {
  constructor(getSession, setSession, onError = () => {}) {
    this.getSession = getSession;
    this.setSession = setSession;
    this.onError = onError;
    this.queue = Promise.resolve();
    this.refreshTask = null;
    this.lastWrite = 0;
    this.holdUntil = 0;
  }
  async itemPayload(api, item) {
    let show = null;
    if (item.type === 'episode' && item.raw?.grandparentRatingKey) {
      show = await api.detail(item.raw.grandparentRatingKey);
    }
    return scrobblePayload(item, show);
  }
  createPlayback(api, item) {
    if (api?.server?.kind !== 'plex' || !validSession(this.getSession())) return null;
    const context = this.itemPayload(api, item);
    // A failure to look up Plex show identifiers must not interrupt playback.
    context.catch(() => {});
    let lastAction = null, stopped = false;
    return {
      event: (action, position, duration, ended = false) => {
        if (stopped || !['start', 'pause', 'stop'].includes(action)) return Promise.resolve();
        if (action === 'pause' && lastAction !== 'start') return Promise.resolve();
        if (action === 'start' && lastAction === 'start') return Promise.resolve();
        if (action === 'stop' && lastAction === null) { stopped = true; return Promise.resolve(); }
        if (action === 'stop') stopped = true;
        lastAction = action;
        const percent = progressPercent(position, duration, ended);
        if (percent === null) return Promise.resolve();
        this.queue = this.queue.catch(() => {}).then(async () => {
          if (!validSession(this.getSession())) return;
          const payload = await context;
          if (!payload) return;
          await this.scrobble(action, {...payload, progress: percent});
        }).catch(error => this.onError(error.message));
        return this.queue;
      }
    };
  }
  // Explicit Plex mark watched/unwatched also syncs to Simkl, even if the
  // movie/episode was never opened in the player.
  markWatched(api, item, watched) {
    if (api?.server?.kind !== 'plex' || !validSession(this.getSession())) return Promise.resolve();
    const context = this.itemPayload(api, item);
    context.catch(() => {});
    this.queue = this.queue.catch(() => {}).then(async () => {
      if (!validSession(this.getSession())) return;
      const payload = await context;
      if (!payload) return;
      const body = payload.movie ? {movies: [payload.movie]} : {
        shows: [{...payload.show, seasons: [{number: payload.episode.season,
          episodes: [{number: payload.episode.number}]}]}]
      };
      return this.post('/sync/history' + (watched ? '' : '/remove'), body);
    }).catch(error => this.onError(error.message));
    return this.queue;
  }
  async refresh() {
    if (!this.refreshTask) {
      this.refreshTask = (async () => {
        const existing = this.getSession();
        if (!validSession(existing)) throw new Error('Connect Simkl to continue tracking.');
        const res = await send('/oauth2/token', {form: {grant_type: 'refresh_token',
          client_id: SIMKL_CLIENT_ID, refresh_token: existing.refreshToken}});
        if (res.status !== 200) {
          if ([400, 401, 403].includes(res.status)) this.setSession(null);
          throw new Error('Simkl token refresh failed (HTTP ' + res.status + ').');
        }
        const session = parseSession(res.data, existing);
        this.setSession(session);
        return session;
      })().finally(() => { this.refreshTask = null; });
    }
    return this.refreshTask;
  }
  async scrobble(action, body) {
    return this.post('/scrobble/' + action, body, action === 'stop');
  }
  async post(path, body, allowConflict = false) {
    if (!validSession(this.getSession())) return;
    const waiting = Math.max(this.lastWrite + WRITE_GAP_MS, this.holdUntil) - Date.now();
    if (waiting > 0) await new Promise(resolve => setTimeout(resolve, waiting));
    let current = this.getSession();
    if (!validSession(current)) return;
    if (current.expiresAt < Date.now() + 60000) current = await this.refresh();
    const post = token => send(path, {body, token});
    this.lastWrite = Date.now();
    let result = await post(current.accessToken);
    if (result.status === 401) {
      // Refresh once and replay only with a valid new token.
      current = this.getSession()?.accessToken !== current.accessToken ? this.getSession() : await this.refresh();
      if (!validSession(current)) return;
      this.lastWrite = Date.now();
      result = await post(current.accessToken);
    }
    if (result.status === 409 && allowConflict) return;
    if (result.status === 429 || result.status === 412 ||
        (result.status === 400 && result.data?.error === 'RATE_LIMIT')) {
      this.holdUntil = Date.now() + (result.status === 412 ? 300000 : result.status === 400 ? 5000 : 2000);
      throw new Error('Simkl is rate limiting playback updates; later events will retry.');
    }
    if (result.status < 200 || result.status >= 300) throw new Error('Simkl playback tracking failed (HTTP ' + result.status + ').');
  }
}
