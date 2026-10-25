// SPDX-License-Identifier: GPL-3.0-only
// Simkl device authorization and event-only scrobbling, adapted from Plezy's
// SimklAuthService / SimklClient / SimklTracker.
import {VERSION, id} from './core.js';

export const SIMKL_CLIENT_ID = 'ec68bc6a9d04b3c50af8cc495f9c9bf478c2371b979aed7e3385bdb771b9b18d';
const BASE = 'https://api.simkl.com';
const SCOPE = 'media:read media:write';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const WRITE_GAP_MS = 1100;

function endpoint(path) {
  const url = new URL(path, BASE);
  // OAuth V2 endpoints are NOT normal Simkl API requests. Plezy's original
  // working client posts client_id/scope in the form body to a bare OAuth URL.
  // Do not add regular API identity query parameters to OAuth grant requests.
  if (!path.startsWith('/oauth2/')) {
    url.searchParams.set('client_id', SIMKL_CLIENT_ID);
    url.searchParams.set('app-name', 'plezy');
    url.searchParams.set('app-version', VERSION);
  }
  return url.href;
}
function oauthFailure(label, result) {
  const data = result && result.data || {};
  // Simkl includes a structured OAuth error and sometimes an explanation on
  // HTTP 400. Show the reason, never tokens, device codes or full responses.
  const code = typeof data.error === 'string' && /^[a-z_]{2,40}$/.test(data.error)
    ? data.error : '';
  const description = typeof data.error_description === 'string'
    ? data.error_description : (typeof data.message === 'string' ? data.message : '');
  const safeDescription = description.replace(/[A-Za-z0-9_\-]{24,}/g, '[redacted]')
    .replace(/[\r\n\t]+/g, ' ').slice(0, 160);
  return new Error(label + ' (HTTP ' + result.status + (code ? ': ' + code : '') + ').' +
    (safeDescription ? ' ' + safeDescription : ''));
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
        ...((form || body) ? {'Content-Type': 'application/json', 'simkl-api-key': SIMKL_CLIENT_ID} : {}),
        ...(token ? {Authorization: 'Bearer ' + token} : {})
      },
      // Simkl OAuth V2 expects JSON just like authenticated API writes.
      // Upstream Dart's form-looking bodyFields hide the protocol difference.
      body: form || body ? JSON.stringify(form || body) : undefined,
      signal: controller.signal
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) { /* Status still determines failure. */ }
    return {status: response.status, data, retryAfter: response.headers.get('Retry-After')};
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Simkl request cancelled or timed out.');
    throw new Error('Simkl is unreachable from this TV. Check the network, TLS certificate and CORS support.');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abort);
  }
}
export function parseSession(response, previous) {
  const scope = response && (response.scope || previous?.scope);
  if (!response || typeof response.access_token !== 'string' ||
      !response.access_token.startsWith('simkl_at_') ||
      typeof scope !== 'string' || !scope.split(' ').includes('media:write')) {
    throw new Error('Simkl did not grant a writable session. Reconnect with media:write permission.');
  }
  const refreshToken = response.refresh_token || (previous && previous.refreshToken);
  if (!refreshToken || typeof refreshToken !== 'string') throw new Error('Simkl omitted the refresh token.');
  const expires = Number(response.expires_in);
  if (!Number.isFinite(expires) || expires <= 0) throw new Error('Simkl returned an invalid token lifetime.');
  return {accessToken: response.access_token, refreshToken, expiresAt: Date.now() + expires * 1000,
    scope: response.scope || previous?.scope, pendingStops: previous?.pendingStops || [], retryNotBefore: previous?.retryNotBefore || 0};
}
export function validSession(session) {
  return !!(session && typeof session.accessToken === 'string' &&
    session.accessToken.startsWith('simkl_at_') && typeof session.refreshToken === 'string' &&
    session.refreshToken && Number.isFinite(session.expiresAt) &&
    typeof session.scope === 'string' && session.scope.split(' ').includes('media:write'));
}
export async function beginSimklLink(signal) {
  const result = await send('/oauth2/device', {form: {client_id: SIMKL_CLIENT_ID, scope: SCOPE}, signal});
  if (result.status !== 200) throw oauthFailure('Simkl device linking failed', result);
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
  throw oauthFailure('Simkl authorization failed', result);
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
  if (series.year || raw.grandparentYear) media.year = Number(series.year || raw.grandparentYear);
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
    this.holdUntil = Number(this.getSession()?.retryNotBefore) || 0;
    this.epoch = 0;
    this.unmatched = {};
    this.matches = {};
  }
  reset() {
    // Pending writes from a disconnected account must never be sent using
    // credentials for a different account linked on the same TV.
    ++this.epoch;
    this.holdUntil = 0; this.lastWrite = 0; this.unmatched = {}; this.matches = {};
  }
  async itemPayload(api, item) {
    let show = null, media = item;
    if (item.type === 'episode' && item.raw?.grandparentRatingKey) {
      show = await api.detail(item.raw.grandparentRatingKey);
    } else if (item.type === 'movie' && item.id) {
      // Plex home hubs often contain stale or incomplete GUIDs and release
      // years. Fetch full details with includeGuids before first scrobble.
      try { media = await api.detail(item.id); } catch (_) { /* title/year fallback */ }
    }
    return scrobblePayload(media, show);
  }
  createPlayback(api, item) {
    if (api?.server?.kind !== 'plex' || !validSession(this.getSession())) return null;
    const context = this.itemPayload(api, item), epoch = this.epoch;
    // A failure to look up Plex show identifiers must not interrupt playback.
    context.catch(() => {});
    let lastAction = null, stopped = false;
    const stopId = id();
    return {
      event: (action, position, duration, ended = false) => {
        if (stopped || !['start', 'pause', 'stop'].includes(action)) return Promise.resolve();
        if (action === 'pause' && lastAction !== 'start') return Promise.resolve();
        if (action === 'start' && lastAction === 'start') return Promise.resolve();
        if (action === 'stop' && lastAction === null) { stopped = true; return Promise.resolve(); }
        const percent = progressPercent(position, duration, ended);
        if (percent === null) return Promise.resolve();
        if (action === 'stop') stopped = true;
        lastAction = action;
        this.queue = this.queue.catch(() => {}).then(async () => {
          if (this.epoch !== epoch || !validSession(this.getSession())) return;
          const payload = await context;
          if (!payload || this.epoch !== epoch) return;
          const body = {...payload, progress: percent};
          const key = JSON.stringify(payload);
          if (this.unmatched[key]) return;
          // Persist a final stop before attempting delivery. Retry only on a
          // subsequent user action (or explicit Retry), never a heartbeat.
          if (action === 'stop') this.saveStop(stopId, body, epoch);
          else await this.retryPendingStops(epoch, 1);
          try {
            await this.scrobble(action, body, epoch);
            if (action === 'stop') this.removeStop(stopId, epoch);
          } catch (error) {
            if (error.simklUnmatched) {
              this.unmatched[key] = true;
              // An unidentifiable title will never become identifiable by
              // replaying exactly the same IDs; do not retain dead stops.
              if (action === 'stop') this.removeStop(stopId, epoch);
            }
            throw error;
          }
        }).catch(error => this.onError(error.message));
        return this.queue;
      }
    };
  }
  // Explicit Plex mark watched/unwatched also syncs to Simkl, even if the
  // movie/episode was never opened in the player.
  markWatched(api, item, watched) {
    if (api?.server?.kind !== 'plex' || !validSession(this.getSession())) return Promise.resolve();
    const context = this.itemPayload(api, item), epoch = this.epoch;
    context.catch(() => {});
    this.queue = this.queue.catch(() => {}).then(async () => {
      if (this.epoch !== epoch || !validSession(this.getSession())) return;
      const payload = await context;
      if (!payload || this.epoch !== epoch) return;
      // A manual watch-state decision supersedes a queued playback stop for
      // this same title (especially Mark unwatched after a failed watched stop).
      this.setSession({...this.getSession(), pendingStops: this.pendingStops().filter(entry => {
        const {progress, ...media} = entry.body;
        return JSON.stringify(media) !== JSON.stringify(payload);
      })});
      const body = payload.movie ? {movies: [payload.movie]} : {
        shows: [{...payload.show, seasons: [{number: payload.episode.season,
          episodes: [{number: payload.episode.number}]}]}]
      };
      return this.post('/sync/history' + (watched ? '' : '/remove'), body, false, epoch);
    }).catch(error => this.onError(error.message));
    return this.queue;
  }
  pendingStops() {
    const pending = this.getSession()?.pendingStops;
    return Array.isArray(pending) ? pending.filter(entry => entry && typeof entry.id === 'string'
      && entry.body && Number.isFinite(entry.body.progress)
      && (entry.body.movie || (entry.body.show && entry.body.episode))).slice(-50) : [];
  }
  saveStop(stopId, body, epoch) {
    if (epoch !== this.epoch || !validSession(this.getSession())) return;
    const pending = this.pendingStops().filter(entry => entry.id !== stopId);
    if (pending.length >= 50) throw new Error('Simkl has 50 unsent stops. Use Retry saved updates in settings.');
    this.setSession({...this.getSession(), pendingStops: pending.concat({id: stopId, body})});
  }
  removeStop(stopId, epoch) {
    if (epoch === this.epoch && validSession(this.getSession())) {
      this.setSession({...this.getSession(), pendingStops: this.pendingStops().filter(entry => entry.id !== stopId)});
    }
  }
  async retryPendingStops(epoch = this.epoch, limit = 50) {
    for (const entry of this.pendingStops().slice(0, limit)) {
      if (epoch !== this.epoch || !validSession(this.getSession())) return;
      await this.scrobble('stop', entry.body, epoch);
      this.removeStop(entry.id, epoch);
    }
  }
  retryPending() {
    const epoch = this.epoch;
    this.queue = this.queue.catch(() => {}).then(() => this.retryPendingStops(epoch))
      .catch(error => this.onError(error.message));
    return this.queue;
  }
  async refresh() {
    if (!this.refreshTask) {
      this.refreshTask = (async () => {
        const existing = this.getSession(), epoch = this.epoch;
        if (!validSession(existing)) throw new Error('Connect Simkl to continue tracking.');
        const res = await send('/oauth2/token', {form: {grant_type: 'refresh_token',
          client_id: SIMKL_CLIENT_ID, refresh_token: existing.refreshToken}});
        if (this.epoch !== epoch) throw new Error('Simkl account changed during token refresh.');
        if (res.status !== 200) {
          if ([400, 401, 403].includes(res.status)) this.setSession(null);
          throw new Error('Simkl token refresh failed (HTTP ' + res.status + ').');
        }
        const session = parseSession(res.data, existing);
        session.pendingStops = this.pendingStops();
        session.retryNotBefore = this.holdUntil;
        this.setSession(session);
        return session;
      })().finally(() => { this.refreshTask = null; });
    }
    return this.refreshTask;
  }
  async resolveUnmatched(body) {
    const media = body.movie || body.show;
    const title = typeof media?.title === 'string' ? media.title.trim() : '';
    if (!title) return null;
    const kind = body.movie ? 'movie' : 'tv';
    const key = kind + ':' + title.toLowerCase() + ':' + (media.year || '');
    if (this.matches[key]) return this.matches[key];
    // Simkl already tried our IMDb/TMDB/TVDB IDs. Only after id_err, try
    // a text lookup. Do not silently choose a fuzzy match with a wrong year.
    const path = '/search/' + kind + '?q=' + encodeURIComponent(title) + '&limit=10';
    const result = await send(path);
    if (result.status !== 200 || !Array.isArray(result.data)) return null;
    const exact = result.data.filter(entry =>
      entry && typeof entry.title === 'string' &&
      entry.title.trim().toLowerCase() === title.toLowerCase() &&
      (!media.year || Number(entry.year) === Number(media.year)) &&
      Number.isInteger(Number(entry.ids?.simkl_id)) &&
      Number(entry.ids.simkl_id) > 0);
    if (exact.length !== 1) return null;
    const id = Number(exact[0].ids.simkl_id);
    this.matches[key] = id;
    return id;
  }
  async scrobble(action, body, epoch = this.epoch) {
    const media = body.movie || body.show;
    const kind = body.movie ? 'movie' : 'tv';
    const key = kind + ':' + (media?.title || '').trim().toLowerCase() + ':' + (media?.year || '');
    if (this.matches[key] && media) {
      const updated = {...media, ids: {...media.ids, simkl: this.matches[key]}};
      body = {...body, [body.movie ? 'movie' : 'show']: updated};
    }
    try {
      return await this.post('/scrobble/' + action, body, action === 'stop', epoch);
    } catch (error) {
      if (!error.simklUnmatched || epoch !== this.epoch) throw error;
      // One exact-title / matching-year lookup, no endless retries or
      // ambiguous automatic matching. Never retry for HTTP transport errors.
      const simklId = await this.resolveUnmatched(body);
      if (!simklId || epoch !== this.epoch) throw error;
      const resolved = {...media, ids: {...media.ids, simkl: simklId}};
      return this.post('/scrobble/' + action,
        {...body, [body.movie ? 'movie' : 'show']: resolved}, action === 'stop', epoch);
    }
  }
  async post(path, body, allowConflict = false, epoch = this.epoch) {
    if (epoch !== this.epoch || !validSession(this.getSession())) return;
    // Do not leave every later playback event waiting behind a daily quota.
    if (this.holdUntil > Date.now()) throw new Error('Simkl updates are on hold. Saved stops can be retried later.');
    const waiting = this.lastWrite + WRITE_GAP_MS - Date.now();
    if (waiting > 0) await new Promise(resolve => setTimeout(resolve, waiting));
    if (epoch !== this.epoch) return;
    let current = this.getSession();
    if (!validSession(current)) return;
    if (current.expiresAt < Date.now() + 60000) current = await this.refresh();
    if (epoch !== this.epoch) return;
    const post = token => send(path, {body, token});
    this.lastWrite = Date.now();
    let result = await post(current.accessToken);
    if (epoch !== this.epoch) return;
    if (result.status === 401) {
      // Refresh once and replay only with a valid new token.
      current = this.getSession()?.accessToken !== current.accessToken ? this.getSession() : await this.refresh();
      if (epoch !== this.epoch || !validSession(current)) return;
      const delay = this.lastWrite + WRITE_GAP_MS - Date.now();
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      if (epoch !== this.epoch) return;
      this.lastWrite = Date.now();
      result = await post(current.accessToken);
      if (epoch !== this.epoch) return;
    }
    if (result.status === 409 && allowConflict) return;
    if (result.status === 429 || result.status === 412 ||
        (result.status === 400 && result.data?.error === 'RATE_LIMIT')) {
      const code = result.data?.error;
      const quota = ['user_limit_exceeded', 'app_limit_exceeded'].includes(code);
      let hold = result.status === 412 ? 300000 : result.status === 400 ? 5000
        : code === 'rate_limit' ? 2000 : quota ? 3600000 : 60000;
      if (result.status === 429 && code !== 'rate_limit' && result.retryAfter) {
        const delay = /^\d+$/.test(result.retryAfter) ? Number(result.retryAfter) * 1000
          : Date.parse(result.retryAfter) - Date.now();
        if (Number.isFinite(delay) && delay > 0) hold = Math.max(hold, delay);
      }
      this.holdUntil = Date.now() + hold;
      this.setSession({...this.getSession(), retryNotBefore: this.holdUntil});
      throw new Error('Simkl rate limited this update. Final stops are saved for the next action or Retry in settings.');
    }
    if (result.status === 404 && path.indexOf('/scrobble/') === 0 &&
        ['id_err', 'not_found', 'item_not_found'].includes(result.data?.error)) {
      const error = new Error('Simkl could not match this Plex title (HTTP 404). Check the IMDb/TMDb/TVDb identifiers; tracking will skip this title for now.');
      error.simklUnmatched = true;
      throw error;
    }
    if (result.status < 200 || result.status >= 300) {
      const code = typeof result.data?.error === 'string' && /^[a-z_]{2,40}$/.test(result.data.error)
        ? ' · ' + result.data.error : '';
      throw new Error('Simkl tracking rejected ' + path + ' (HTTP ' + result.status + code + ').');
    }
  }
}
