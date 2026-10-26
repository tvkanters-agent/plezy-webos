// SPDX-License-Identifier: GPL-3.0-only
// Browser translation of upstream lib/services/trackers/simkl/{simkl_auth_service,
// simkl_client,simkl_tracker}.dart. Preserve the upstream ID-only request
// bodies, endpoint behavior and event model. Do not implement catalog guessing.
import {VERSION, id} from './core.js';

export const SIMKL_CLIENT_ID = 'ec68bc6a9d04b3c50af8cc495f9c9bf478c2371b979aed7e3385bdb771b9b18d';
const BASE = 'https://api.simkl.com';
const SCOPE = 'media:read media:write';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const WRITE_GAP_MS = 1000;

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
        ...((form || body) ? {'Content-Type': 'application/json'} : {}),
        ...(body ? {'simkl-api-key': SIMKL_CLIENT_ID} : {}),
        ...(token ? {Authorization: 'Bearer ' + token} : {})
      },
      // webOS-specific OAuth adaptation: native Plezy uses form bodyFields,
      // but the tested LG browser received HTTP 400 "Invalid JSON request"
      // until OAuth device/token requests were serialized as JSON.
      // Keep upstream grant fields, scope and headers; do not infer behavior.
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
  // Exact browser translation of ExternalIds.fromLegacyPlexGuid and
  // ExternalIds.fillFrom in lib/utils/external_ids.dart. A Plex legacy GUID
  // uses a *com.plexapp.agents.* scheme, not the modern imdb:// form.
  const legacy = /^([a-z.]+):\/\/([^/?#]+)(?:\?[^#]*)?$/i.exec(raw?.guid || '');
  if (legacy) {
    const scheme = legacy[1].toLowerCase(), value = legacy[2].toLowerCase();
    let key = '', normalized = '';
    if (scheme === 'com.plexapp.agents.imdb') {
      key = 'imdb'; normalized = /^tt\d+$/.test(value) ? value : '';
    } else if (scheme === 'com.plexapp.agents.themoviedb' && /^\d+$/.test(value)) {
      key = 'tmdb'; normalized = Number(value);
    } else if (scheme === 'com.plexapp.agents.thetvdb' && /^\d+$/.test(value)) {
      key = 'tvdb'; normalized = Number(value);
    } else if (scheme === 'com.plexapp.agents.hama') {
      const pair = /^(imdb|tmdb|tsdb|tvdb[2-9]?)-((?:tt)?\d+)$/.exec(value);
      if (pair) {
        const source = pair[1], id = pair[2];
        if (source === 'imdb' && /^(?:tt)?\d+$/.test(id)) {
          key = 'imdb'; normalized = id.startsWith('tt') ? id : 'tt' + id;
        } else if (source === 'tmdb' || source === 'tsdb') {
          if (/^\d+$/.test(id)) { key = 'tmdb'; normalized = Number(id); }
        } else if (/^tvdb[2-9]?$/.test(source) && /^\d+$/.test(id)) {
          key = 'tvdb'; normalized = Number(id);
        }
      }
    }
    if (key && normalized && !ids[key]) ids[key] = normalized;
  }
  return ids;
}
// Upstream FribbMappingStore/TrackerIdResolver: map anime to the exact Simkl
// catalog ID where the Plex external IDs may address a different entry.
// Cache one database fetch per app session, not one per playback event.
const FRIBB_URL = 'https://cdn.jsdelivr.net/gh/Fribb/anime-lists@master/anime-list-mini.json';
let fribbRowsTask = null;
function numeric(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
export function findFribbSimklId(rows, ids, {movie = false, season = null} = {}) {
  if (!Array.isArray(rows) || !ids) return null;
  const matching = rows.filter(row => {
    if (!row || !numeric(row.simkl_id)) return false;
    if (!movie && ids.tvdb && numeric(row.tvdb_id) === ids.tvdb) return true;
    const tmdb = row.themoviedb_id;
    if (ids.tmdb) {
      if (movie && (Array.isArray(tmdb?.movie) ? tmdb.movie : [tmdb?.movie]).some(x => numeric(x) === ids.tmdb)) return true;
      if (!movie && numeric(tmdb?.tv) === ids.tmdb) return true;
    }
    const imdb = row.imdb_id;
    return !!(ids.imdb && (Array.isArray(imdb) ? imdb : [imdb]).includes(ids.imdb));
  });
  if (!matching.length) return null;
  if (season != null && Number.isInteger(Number(season))) {
    const bySeason = matching.filter(row => row.season &&
      (Number(row.season.tvdb) === Number(season) || Number(row.season.tmdb) === Number(season)));
    if (bySeason.length === 1) return numeric(bySeason[0].simkl_id);
    if (bySeason.length > 1) return null;
  }
  // A split-cour series can have multiple Simkl entries under one Plex show.
  // Never assign one of those IDs to every episode by guesswork.
  const values = Array.from(new Set(matching.map(row => numeric(row.simkl_id))));
  return values.length === 1 ? values[0] : null;
}
async function fribbSimklId(ids, context) {
  if (!Object.keys(ids).length) return null;
  if (!fribbRowsTask) {
    fribbRowsTask = fetch(FRIBB_URL, {headers:{Accept:'application/json'}})
      .then(response => {
        if (!response.ok) throw new Error('Fribb mapping unavailable');
        return response.json();
      }).catch(() => null);
  }
  return findFribbSimklId(await fribbRowsTask, ids, context);
}
// Simkl now recommends supplying title/year *alongside* external IDs: its
// server-side identity resolution falls back to title when an external ID
// isn't indexed (otherwise the endpoint returns 404 id_err). We do not make
// an unverified second API search or manufacture a Simkl ID.
function scrobbleIdentity(raw, ids, title) {
  const identity = {ids};
  const name = (typeof raw?.title === 'string' && raw.title.trim()) ||
    (typeof title === 'string' && title.trim()) || '';
  if (name) identity.title = name;
  const year = Number(raw?.year);
  if (Number.isInteger(year) && year >= 1870 && year <= 2200) identity.year = year;
  return Object.keys(ids).length || name ? identity : null;
}
export function scrobblePayload(item, show) {
  const raw = item?.raw;
  if (!raw) return null;
  if (item.type === 'movie') {
    const movie = scrobbleIdentity(raw, simklMovieIds(raw), item.title);
    return movie ? {movie} : null;
  }
  if (item.type !== 'episode' || raw.parentIndex == null || raw.index == null ||
      !Number.isInteger(Number(raw.parentIndex)) || !Number.isInteger(Number(raw.index)) ||
      Number(raw.parentIndex) < 0 || Number(raw.index) < 1) return null;
  const series = show?.raw || show || {};
  const identity = scrobbleIdentity(series, simklMovieIds(series),
    show?.title || raw.grandparentTitle);
  return identity ? {show: identity,
    episode: {season: Number(raw.parentIndex), number: Number(raw.index)}} : null;
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
   }
  reset() {
    // Pending writes from a disconnected account must never be sent using
    // credentials for a different account linked on the same TV.
    ++this.epoch;
    this.holdUntil = 0; this.lastWrite = 0;
  }
  async itemPayload(api, item) {
    let show = null, media = item;
    if (item.type === 'episode' && item.raw?.grandparentRatingKey) {
      // Upstream TrackerIdResolver resolves episodes using SHOW-level GUIDs.
      show = await api.detail(item.raw.grandparentRatingKey);
    } else if (item.type === 'movie' && item.id) {
      // The hub projection does not always include GUIDs. Resolve full movie
      // metadata exactly as TrackerIdResolver.resolveForMovie does.
      media = await api.detail(item.id);
    }
    const payload = scrobblePayload(media, show);
    if (!payload) return null;
    const ids = payload.movie ? payload.movie.ids : payload.show.ids;
    const mapped = await fribbSimklId(ids, {
      movie: item.type === 'movie',
      season: item.type === 'episode' ? item.raw?.parentIndex : null
    });
    // Upstream SimklTracker._buildIds prefers Fribb's precise simkl_id,
    // but keeps catalog IDs as fallback for unmapped titles.
    if (mapped) ids.simkl = mapped;
    return payload;
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
           // Persist a final stop before attempting delivery. Retry only on a
          // subsequent user action (or explicit Retry), never a heartbeat.
          if (action === 'stop') this.saveStop(stopId, body, epoch);
          else await this.retryPendingStops(epoch, 1);
          await this.scrobble(action, body, epoch);
          if (action === 'stop') this.removeStop(stopId, epoch);
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
  // Upstream SimklTracker.scrobble sends the ID-only object without any
  // catalog search, fuzzy matching, or second request after a 404.
  async scrobble(action, body, epoch = this.epoch) {
    return this.post('/scrobble/' + action, body, action === 'stop', epoch);
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
      const media = body?.movie || body?.show || {};
      const idKeys = Object.keys(media.ids || {});
      throw new Error('Simkl could not match this title (HTTP 404: ' + result.data.error +
        '). IDs: ' + (idKeys.length ? idKeys.join(', ') : 'none') +
        '; title: ' + (media.title ? 'present' : 'missing') +
        '; year: ' + (media.year ? 'present' : 'missing') +
        '. Check the title and IDs in Plex and whether Simkl has this item.');
    }
    if (result.status < 200 || result.status >= 300) {
      const code = typeof result.data?.error === 'string' && /^[a-z_]{2,40}$/.test(result.data.error)
        ? ' · ' + result.data.error : '';
      throw new Error('Simkl tracking rejected ' + path + ' (HTTP ' + result.status + code + ').');
    }
  }
}
