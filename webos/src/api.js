// SPDX-License-Identifier: GPL-3.0-only
// Protocols ported from lib/services/{plex,jellyfin}_* and their client parts.
import {VERSION, baseUrl, endpoint, request, seconds, id} from './core.js';
import {plexExternalIds} from './external-ids.js';
import {trackLanguageName} from './languages.js';
import {plexPlaybackNavigation, jellyfinPlaybackNavigation} from './skip-markers.js';
const enc = encodeURIComponent;
const PAGE = 60;
// Plex stores an artwork timestamp in its /thumb/<timestamp> and /art/<timestamp>
// paths. Its metadata updatedAt is a fallback ONLY for an item's own image:
// a child item's timestamp cannot version its parent/series artwork.
function plexArtworkRevision(path, updatedAt) {
  const match = /\/(?:thumb|art|poster)\/(\d+)(?:[/?#]|$)/.exec(path || '');
  if (match) return match[1];
  return updatedAt !== undefined && updatedAt !== null && updatedAt !== ''
    ? String(updatedAt) : '';
}
const FIELDS = 'Overview,MediaSources,MediaStreams,UserData,PrimaryImageAspectRatio';
// Plezy identifies Plex's Continue Watching / On Deck hub semantically,
// even when the server supplies a different display title.
function plexHomeHubTitle(hub) {
  const title = (hub.title || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  const keys = [hub.hubIdentifier, hub.identifier, hub.key, hub.type].filter(Boolean);
  const onDeck = title === 'continuewatching' || title === 'ondeck' ||
    keys.some(value => /(?:^|[./_-])(?:continuewatching|ondeck|inprogress|continue)(?=$|[./_-])/i.test(String(value)));
  return onDeck ? 'On Deck' : hub.title || 'Recommended';
}
function plexItem(raw) {
  // WatchedIndicator in upstream shows remaining episodes, not a checkmark
  // until all show/season leaves are watched.
  const leaves = Number(raw.leafCount), viewed = Number(raw.viewedLeafCount);
  const unwatchedCount = ['show','season'].includes(raw.type) &&
    Number.isFinite(leaves) && Number.isFinite(viewed) && leaves >= viewed
    ? Math.max(0, leaves - viewed) : null;
  return {id: String(raw.ratingKey), title: raw.title || 'Untitled', type: raw.type,
    subtitle: raw.grandparentTitle || raw.parentTitle || String(raw.year || ''),
    summary: raw.summary || '', year: raw.year, duration: (raw.duration || 0) / 1000,
    resume: (raw.viewOffset || 0) / 1000,
    watched: unwatchedCount !== null ? unwatchedCount === 0 : !!raw.viewCount,
    unwatchedCount,
    poster: raw.type === 'episode' ? (raw.grandparentThumb || raw.parentThumb || raw.thumb)
      : (raw.thumb || raw.parentThumb || raw.grandparentThumb),
    background: raw.art || raw.grandparentArt || '',
    folder: ['show', 'season', 'collection', 'playlist'].includes(raw.type), raw};
}
// JS translation of lib/utils/track_label_builder.dart's two-line subtitle
// and audio labels. Keep stream descriptions (SDH, commentary, forced) instead
// of replacing title with generic language/codec text.
export function plexTrackLabel(stream, kind, index = 0) {
  const clean = value => typeof value === 'string' ? value.trim() : '';
  const language = clean(stream.languageCode) || clean(stream.language);
  const lang = trackLanguageName(language);
  const title = clean(stream.title);
  const display = clean(stream.extendedDisplayTitle) || clean(stream.displayTitle);
  let primary = lang || title || display || (kind === 'subtitle' ? 'Subtitle ' : 'Audio ') + (index + 1);
  const forced = kind === 'subtitle' && (stream.forced === true || stream.forced === 1 || stream.forced === '1' ||
    /\bforced\b/i.test(title));
  if (forced && !/\bforced\b/i.test(primary)) primary += ' (Forced)';
  const descriptions = [];
  if (title && title.toLowerCase() !== lang.toLowerCase() && title.toLowerCase() !== primary.toLowerCase())
    descriptions.push(title);
  // Plex often exposes SDH/commentary only in displayTitle, not title.
  // Retain that server metadata if it adds information to the language.
  if (display && display.toLowerCase() !== primary.toLowerCase() &&
      (!title || display.toLowerCase() !== title.toLowerCase()) &&
      !descriptions.some(value => value.toLowerCase() === display.toLowerCase()))
    descriptions.push(display);
  if (kind === 'subtitle' && (stream.hearingImpaired || stream.sdh || stream.closedCaptions) &&
      !/\b(SDH|CC|hearing.impaired)\b/i.test(primary + ' ' + descriptions.join(' ')))
    descriptions.push(stream.closedCaptions ? 'CC' : 'SDH');
  if (stream.codec) descriptions.push(String(stream.codec).toUpperCase());
  if (kind === 'audio' && stream.channels) descriptions.push(stream.channels + ' channels');
  return {primary, secondary: descriptions.join(' · '),
    label: primary + (descriptions.length ? ' · ' + descriptions.join(' · ') : '')};
}
function jellyItem(raw) {
  return {id: raw.Id, title: raw.Name || 'Untitled', type: raw.Type,
    subtitle: raw.SeriesName || String(raw.ProductionYear || ''),
    summary: raw.Overview || '', year: raw.ProductionYear, duration: seconds(raw.RunTimeTicks),
    resume: seconds(raw.UserData && raw.UserData.PlaybackPositionTicks), watched: !!(raw.UserData && raw.UserData.Played),
    folder: !!raw.IsFolder || ['Series', 'Season', 'BoxSet', 'CollectionFolder'].includes(raw.Type), raw};
}
// Plezy derives missing markers from chapter titles for all supported backends.
export function plexNavigation(raw, settings = {}) {
  return plexPlaybackNavigation(raw, settings);
}
export function plexIdentity(deviceId) {
  return {'X-Plex-Product': 'Plezy webOS', 'X-Plex-Version': VERSION,
    'X-Plex-Client-Identifier': deviceId, 'X-Plex-Platform': 'webOS', 'X-Plex-Device': 'TV', 'X-Plex-Device-Name': 'Plezy webOS TV'};
}
export async function plexPin(deviceId, signal) {
  // Weak four-character pins are the TV plex.tv/link flow. Strong pins are for
  // the full app.plex.tv/auth URL and cannot be entered into the link form.
  return request(endpoint('https://plex.tv', '/api/v2/pins', {...plexIdentity(deviceId), strong: false}), {method: 'POST', signal});
}
export async function pollPlexPin(deviceId, pin, signal) {
  return request(endpoint('https://plex.tv', '/api/v2/pins/' + enc(pin.id), {...plexIdentity(deviceId), code: pin.code}), {signal});
}
export async function plexServers(deviceId, token, signal) {
  const resources = await request(endpoint('https://plex.tv', '/api/v2/resources', {...plexIdentity(deviceId),
    'X-Plex-Token': token, includeHttps: 1, includeRelay: 1}), {signal});
  const results = await Promise.all(resources.filter(r => (r.provides || '').split(',').includes('server')).map(async resource => {
    // Try verified HTTPS first; plain HTTP only when that is an advertised
    // connection. Never synthesize a TLS bypass or disable certificate checks.
    const connections = (resource.connections || []).slice().sort((a, b) =>
      (Number(b.protocol === 'https') * 2 + Number(b.local)) - (Number(a.protocol === 'https') * 2 + Number(a.local)));
    for (const connection of connections) {
      if (signal && signal.aborted) return null;
      try {
        const server = {id: resource.clientIdentifier, kind: 'plex', name: resource.name,
          url: baseUrl(connection.uri), token: resource.accessToken || token};
        await new Plex(server, deviceId).probe(signal, 5000);
        return server;
      } catch (_) { /* Try the next connection advertised by this server. */ }
    }
    return null;
  }));
  return results.filter(Boolean);
}
export class Plex {
  constructor(server, deviceId) { this.server = server; this.deviceId = deviceId; }
  url(path, params = {}) { return endpoint(this.server.url, path, {...plexIdentity(this.deviceId), 'X-Plex-Token': this.server.token, ...params}); }
  get(path, params = {}, options = {}) { return request(this.url(path, params), options); }
  async probe(signal, timeout = 15000) { return this.get('/', {}, {signal, timeout}); }
  async libraries() {
    const data = await this.get('/library/sections');
    return (data.MediaContainer.Directory || []).filter(x => ['movie', 'show'].includes(x.type)).map(x => ({id: x.key, title: x.title}));
  }
  async collections(library, start = 0) {
    const data = (await this.get('/library/sections/' + enc(library) + '/collections', {
      'X-Plex-Container-Start': start, 'X-Plex-Container-Size': PAGE})).MediaContainer;
    return {items: (data.Metadata || []).map(plexItem), total: data.totalSize || data.size || 0};
  }
  async playlists(start = 0) {
    const data = (await this.get('/playlists', {playlistType: 'video',
      'X-Plex-Container-Start': start, 'X-Plex-Container-Size': PAGE})).MediaContainer;
    return {items: (data.Metadata || []).map(plexItem), total: data.totalSize || data.size || 0};
  }
  async recommended(library) {
    const data = (await this.get('/library/sections/' + enc(library) + '/hubs', {count: 20})).MediaContainer;
    return (data.Hub || []).map(h => ({title: h.title || 'Recommended',
      items: (h.Metadata || []).filter(item => ['movie', 'show', 'episode', 'season'].includes(item.type)).map(plexItem)}))
      .filter(h => h.items.length);
  }
  async home() {
    // Different Plex Media Server versions and accounts expose different
    // recommended hubs. Fall back to documented library endpoints when the
    // global hub list is empty or unavailable; preserve authentication errors.
    let hubsError;
    try {
      const data = await this.get('/hubs', {count: 20});
      const rows = ((data.MediaContainer || {}).Hub || []).map(h => ({
        title: plexHomeHubTitle(h),
        items: (h.Metadata || []).filter(x => ['movie', 'show', 'season', 'episode'].includes(x.type)).map(plexItem)
      })).filter(row => row.items.length);
      if (rows.length) return rows;
    } catch (error) {
      if (error.status === 401 || error.status === 403) throw error;
      hubsError = error;
    }
    const [continueResult, sectionsResult] = await Promise.allSettled([
      this.get('/hubs/continueWatching', {count: 20}), this.libraries()
    ]);
    const rows = [];
    if (continueResult.status === 'fulfilled') {
      const container = continueResult.value.MediaContainer || {};
      const entries = container.Metadata || (container.Hub || []).reduce((acc, h) => acc.concat(h.Metadata || []), []);
      const items = entries.filter(x => ['movie', 'episode'].includes(x.type)).map(plexItem);
      if (items.length) rows.push({title: 'On Deck', items});
    }
    if (sectionsResult.status === 'fulfilled') {
      // Cap parallel fan-out for users with dozens of libraries.
      const sections = sectionsResult.value.slice(0, 6);
      const recent = await Promise.allSettled(sections.map(section => this.get(
        '/library/sections/' + enc(section.id) + '/recentlyAdded', {'X-Plex-Container-Size': 16}
      )));
      recent.forEach((result, i) => {
        if (result.status !== 'fulfilled') return;
        const items = ((result.value.MediaContainer || {}).Metadata || [])
          .filter(x => ['movie', 'show', 'season', 'episode'].includes(x.type)).map(plexItem);
        if (items.length) rows.push({title: 'Recently added · ' + sections[i].title, items});
      });
    }
    if (!rows.length && hubsError && continueResult.status === 'rejected' && sectionsResult.status === 'rejected') {
      throw hubsError;
    }
    return rows;
  }
  // PlexAlphaBarStrategy.loadCharacters: native per-letter buckets, with
  // includeCollections=1 and the same watched filter as the browse page.
  async firstCharacters(library, filter = 'all') {
    const params = {includeCollections: '1'};
    if (filter === 'unwatched') params.unwatched = '1';
    const data = (await this.get('/library/sections/' + enc(library) + '/firstCharacter', params)).MediaContainer;
    return (data.Directory || []).map(entry => ({
      key: String(entry.key || ''), title: String(entry.title || ''),
      size: Number(entry.size) || 0
    }));
  }
  async list(library, start = 0, sort = 'title', filter = 'all', limit = PAGE) {
    const order = {title: 'titleSort', recent: 'addedAt:desc', release: 'originallyAvailableAt:desc'}[sort] || 'titleSort';
    const section = filter === 'unwatched' ? 'unwatched' : 'all';
    const data = (await this.get('/library/sections/' + enc(library) + '/' + section, {
      'X-Plex-Container-Start': start, 'X-Plex-Container-Size': limit, sort: order})).MediaContainer;
    return {items: (data.Metadata || []).map(plexItem), total: data.totalSize || data.size || 0};
  }
  async search(query) {
    const data = await this.get('/hubs/search', {query, limit: 60});
    return (data.MediaContainer.Hub || []).reduce((all, h) => all.concat(h.Metadata || []), [])
      .filter(x => ['movie', 'show', 'season', 'episode'].includes(x.type)).map(plexItem);
  }
  async fetchExternalIds(itemId) {
    // Port PlexClient.fetchExternalIds exactly: missing/deleted metadata is
    // empty, but network/auth/server failures must not masquerade as no IDs.
    let data;
    try { data = await this.get('/library/metadata/' + enc(itemId), {includeGuids: 1}); }
    catch (error) { if (error.status === 404) return {}; throw error; }
    const metadata = data?.MediaContainer?.Metadata;
    return plexExternalIds(Array.isArray(metadata) ? metadata[0] : null);
  }
  async detail(itemId, kind = '') {
    const path = kind === 'collection' ? '/library/collections/' + enc(itemId) :
      kind === 'playlist' ? '/playlists/' + enc(itemId) : '/library/metadata/' + enc(itemId);
    const data = await this.get(path, {includeGuids: 1, includeMarkers: 1, includeChapters: 1});
    return plexItem(data.MediaContainer.Metadata[0]);
  }
  async children(itemId, start = 0, kind = '') {
    const path = kind === 'collection' ? '/library/collections/' + enc(itemId) + '/children' :
      kind === 'playlist' ? '/playlists/' + enc(itemId) + '/items' :
      '/library/metadata/' + enc(itemId) + '/children';
    const data = (await this.get(path, {
      'X-Plex-Container-Start': start, 'X-Plex-Container-Size': PAGE})).MediaContainer;
    return {items: (data.Metadata || []).map(plexItem), total: data.totalSize || data.size || 0};
  }
  // Walk a show's episodes by metadata hierarchy, including season boundaries.
  // Avoid fetching a whole series' thousands of episodes for a single next item.
  async episodeChildren(parentId) {
    const episodes = [];
    for (let start = 0; start < 1000; ) {
      const page = await this.children(parentId, start);
      episodes.push(...page.items);
      if (!page.items.length) break;
      start += page.items.length;
      if (start >= page.total) break;
    }
    return episodes;
  }
  async nextEpisode(item) {
    if (!item || item.type !== 'episode' || !item.raw || !item.raw.parentRatingKey) return null;
    const raw = item.raw;
    const siblings = await this.episodeChildren(raw.parentRatingKey);
    const index = Number(raw.index);
    const later = siblings.filter(episode => episode.type === 'episode'
      && Number.isFinite(index) && Number(episode.raw.index) > index)
      .sort((a, b) => Number(a.raw.index) - Number(b.raw.index));
    if (later.length) return later[0];
    if (!raw.grandparentRatingKey) return null;
    const seasons = await this.episodeChildren(raw.grandparentRatingKey);
    const currentSeason = seasons.find(season => String(season.id) === String(raw.parentRatingKey));
    const currentIndex = Number.isFinite(Number(raw.parentIndex)) ? Number(raw.parentIndex)
      : (currentSeason ? Number(currentSeason.raw.index) : NaN);
    if (!Number.isFinite(currentIndex)) return null;
    const following = seasons.filter(season => season.type === 'season'
      && Number(season.raw.index) > currentIndex)
      .sort((a, b) => Number(a.raw.index) - Number(b.raw.index));
    for (const season of following) {
      const episodes = (await this.episodeChildren(season.id)).filter(episode => episode.type === 'episode');
      episodes.sort((a, b) => Number(a.raw.index) - Number(b.raw.index));
      if (episodes.length) return episodes[0];
    }
    return null;
  }
  image(item, options = {}) {
    // OptimizedMediaImage uses different poster/thumbnail/detail dimensions.
    // Request the correct image path: an episode's landscape thumb is NOT
    // its grandparent series poster used by the small poster carousel.
    const landscape = !!options.landscape;
    const image = landscape && item.type === 'episode' ?
      (item.raw?.thumb || item.poster) : item.poster;
    if (!image) return '';
    const width = landscape ? (options.detail ? 960 : 480) : (options.detail ? 600 : 320);
    const height = landscape ? (options.detail ? 540 : 270) : (options.detail ? 900 : 480);
    return this.url('/photo/:/transcode', {width, height,
      minSize: 1, upscale: 0, url: image});
  }
  artworkVersion(item, options = {}) {
    const raw = item.raw || {};
    const image = options.landscape && item.type === 'episode'
      ? (raw.thumb || item.poster) : item.poster;
    return plexArtworkRevision(image, image === raw.thumb ? raw.updatedAt : null);
  }
  backdrop(item) {
    return item.background ? this.url('/photo/:/transcode',
      {width: 1280, height: 720, minSize: 1, upscale: 0, url: item.background}) : '';
  }
  backdropVersion(item) {
    const raw = item.raw || {};
    return plexArtworkRevision(item.background,
      item.background === raw.art ? raw.updatedAt : null);
  }
  async onDeck(showId) {
    const data = (await this.get('/library/metadata/' + enc(showId) + '/onDeck')).MediaContainer;
    return (data.Metadata || []).map(plexItem)[0] || null;
  }
  // Plezy PlexClient.fetchPersonDetails: resolve PMS tagKey, then query
  // Plex Discover. Details are optional; the actor's filmography is not.
  async personDetails(personId) {
    const tag=(await this.get('/library/people/'+enc(personId))).MediaContainer?.Directory;
    const entry=Array.isArray(tag)?tag[0]:tag;
    if(!entry?.tagKey) return null;
    const response=await fetch('https://discover.provider.plex.tv/library/people/'+
      enc(entry.tagKey),{headers:{'X-Plex-Token':this.server.token,Accept:'application/json'}});
    if(!response.ok) return null;
    const result=await response.json();
    const metadata=result.MediaContainer?.Metadata;
    const person=Array.isArray(metadata)?metadata[0]:metadata;
    if(!person)return null;
    return {biography:person.summary||null, bornAt:person.bornAt||null,
      diedAt:person.diedAt||null,birthPlace:person.birthPlace||null};
  }
  // Plex's per-person /media can be section-scoped. Cross-library actors have
  // separate numeric tags: search returns the corresponding exact-name filters.
  async personMedia(personId, start = 0, actorName = '') {
    if(!this._personFilmographies)this._personFilmographies=new Map();
    const key=String(personId)+'|'+String(actorName).toLowerCase();
    if(!this._personFilmographies.has(key)) {
      const promise=this.loadPersonFilmography(personId,actorName).catch(error=>{
        this._personFilmographies.delete(key);throw error;
      });
      this._personFilmographies.set(key,promise);
    }
    const items=await this._personFilmographies.get(key);
    return {items:items.slice(start,start+PAGE),total:items.length};
  }
  async loadPersonFilmography(personId, actorName) {
    const sources=[{path:'/library/people/'+enc(personId)+'/media',actor:null}];
    if(actorName?.trim()){
      try{
        const response=(await this.get('/hubs/search',{query:actorName.trim(),limit:100})).MediaContainer;
        for(const hub of response?.Hub||[])for(const person of hub.Directory||[]){
          if(String(person.tag||'').trim().toLowerCase()!==actorName.trim().toLowerCase())continue;
          const match=/^\/(library\/sections\/\d+\/all)\?actor=(\d+)(?:&|$)/.exec(person.key||'');
          if(!match)continue;
          const path='/'+match[1];
          if(!sources.some(x=>x.path===path&&x.actor===match[2]))
            sources.push({path,actor:match[2]});
        }
      }catch(_){/* Preserve PMS person listing when actor search is unavailable. */}
    }
    const lists=await Promise.all(sources.map(async(source,index)=>{
      const found=[];
      for(let offset=0;offset<2000;offset+=200) {
        try{
          const params={'X-Plex-Container-Start':offset,'X-Plex-Container-Size':200};
          if(source.actor)params.actor=source.actor;
          const container=(await this.get(source.path,params)).MediaContainer;
          const rows=Array.isArray(container?.Metadata)?container.Metadata:[];
          found.push(...rows.filter(x=>x.type==='movie'||x.type==='show').map(plexItem));
          if(!rows.length || offset+rows.length>=Number(container?.totalSize||container?.size||rows.length))break;
        }catch(error) {
          if(index===0&&sources.length===1&&offset===0)throw error;
          break;
        }
      }
      return found;
    }));
    const items=new Map();
    for(const list of lists)for(const item of list)items.set(item.id,item);
    return [...items.values()];
  }
  async watched(item, played) { await this.get(played ? '/:/scrobble' : '/:/unscrobble', {key: item.id, identifier: 'com.plexapp.plugins.library'}); }
  async rate(item, value) {
    if (!Number.isFinite(value) || (value !== -1 && (value < 0 || value > 10)))
      throw new Error('Invalid Plex rating.');
    // Plex responds with XML or an empty body, not necessarily JSON.
    const response=await fetch(this.url('/:/rate',{
      key:item.id,identifier:'com.plexapp.plugins.library',rating:value}),{method:'PUT'});
    if (!response.ok) throw new Error('Plex rating returned HTTP '+response.status+'.');
    return true;
  }
  async playback(item, options = {}) {
    const mediaIndex = options.mediaIndex ?? 0;
    if (!Number.isInteger(mediaIndex) || mediaIndex < 0) throw new Error('Invalid media version.');
    const media = (item.raw.Media || [])[mediaIndex];
    const part = media && (media.Part || [])[0];
    if (!part) throw new Error('This version has no playable media.');
    if (media.Part.length > 1) throw new Error('Multi-part files are not supported yet. Choose another version.');
    const sessionId = id();
    const transcode = options.transcode || !['mp4', 'm4v', 'mov'].includes(media.container)
      || media.videoCodec !== 'h264' || !['aac', 'mp3'].includes(media.audioCodec)
      || options.audio !== undefined || (options.subtitle !== undefined && options.subtitle !== -1);
    // Conservative direct play, with user-accessible HLS fallback for TV-specific limits.
    const params = {path: '/library/metadata/' + item.id, mediaIndex, partIndex: 0,
      protocol: 'hls', directPlay: 0, directStream: 0, videoCodec: 'h264', audioCodec: 'aac',
      maxVideoBitrate: 12000, videoResolution: '1920x1080', videoQuality: 100,
      // Match Plezy's full-title HLS timeline. The player supplies the
      // resume point to the decoder at open, not to the transcoder URL.
      session: sessionId,
      subtitleSize: 100, subtitles: 'burn',
      'X-Plex-Platform': 'Chrome', 'X-Plex-Client-Profile-Extra': 'add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac)'};
    if (options.audio !== undefined || options.subtitle !== undefined) {
      await this.get('/library/parts/' + enc(part.id), {audioStreamID: options.audio,
        subtitleStreamID: options.subtitle === -1 ? 0 : options.subtitle, allParts: 1}, {method: 'PUT'});
    }
    return {url: transcode ? this.url('/video/:/transcode/universal/start.m3u8', params) : this.url(part.key),
      sessionId, sourceId: String(part.id), transcode, item,
      start: Math.max(0, Number(options.start) || 0),
      ...plexNavigation(item.raw, options.skipSettings),
      audio: (part.Stream || []).filter(s => s.streamType === 2)
        .map((s, index) => ({id:s.id, ...plexTrackLabel(s, 'audio', index)})),
      subtitles: (part.Stream || []).filter(s => s.streamType === 3)
        .map((s, index) => ({id:s.id, ...plexTrackLabel(s, 'subtitle', index)})),
      options};
  }
  async report(session, state, position, duration) {
    // Plex's timeline API is POST. It often returns XML or an empty 200,
    // neither of which is a request failure. Do not feed it to request()
    // (which parses JSON and would falsely show "progress not synced").
    const itemId = session.item.id;
    const params = {ratingKey: itemId, key: '/library/metadata/' + itemId,
      identifier: 'com.plexapp.plugins.library',
      state: state === 'start' ? 'playing' : state,
      time: Math.round(Math.max(0, position || 0) * 1000),
      duration: Math.round(Math.max(0, duration || session.item.duration || 0) * 1000),
      'X-Plex-Session-Identifier': session.sessionId};
    const url = this.url('/:/timeline', params);
    const response = await fetch(url, {method: 'POST', headers: {Accept: '*/*'}});
    if (!response.ok) {
      const error = new Error('Plex playback timeline returned HTTP ' + response.status + '.');
      error.status = response.status; throw error;
    }
  }
  async stop(session) {
    if (session.transcode) await this.get('/video/:/transcode/universal/stop', {session: session.sessionId});
  }
}
export class Jellyfin {
  constructor(server, deviceId) { this.server = server; this.deviceId = deviceId; }
  headers() {
    // Keep all dynamic auth values out of the quoted MediaBrowser header.
    return {'X-Emby-Authorization': 'MediaBrowser Client="Plezy webOS", Device="LG TV", DeviceId="' + this.deviceId + '", Version="' + VERSION + '"',
      ...(this.server.token ? {'X-Emby-Token': this.server.token} : {}), 'Content-Type': 'application/json'};
  }
  url(path, params = {}) { return endpoint(this.server.url, path, {api_key: this.server.token, ...params}); }
  call(path, params = {}, options = {}) {
    return request(endpoint(this.server.url, path, params), {...options, headers: this.headers()});
  }
  async login(username, password) {
    const info = await this.call('/System/Info/Public');
    const data = await this.call('/Users/AuthenticateByName', {}, {method: 'POST', body: {Username: username, Pw: password}});
    if (!data.AccessToken || !data.User || !data.User.Id) throw new Error('The server returned an incomplete sign-in response.');
    return {...this.server, id: info.Id + ':' + data.User.Id, name: info.ServerName + ' · ' + data.User.Name,
      token: data.AccessToken, userId: data.User.Id};
  }
  userPath(path = '') { return '/Users/' + enc(this.server.userId) + path; }
  async libraries() {
    return ((await this.call(this.userPath('/Views'))).Items || [])
      .filter(x => !x.CollectionType || ['movies', 'tvshows', 'boxsets', 'homevideos'].includes(x.CollectionType))
      .map(x => ({id: x.Id, title: x.Name}));
  }
  async home() {
    // Emby and older Jellyfin instances can omit one of these endpoints. Keep
    // usable home shelves when another endpoint still returns valid content.
    const results = await Promise.allSettled([
      this.call(this.userPath('/Items/Resume'), {Limit: 20, MediaTypes: 'Video', Fields: FIELDS}),
      this.call(this.userPath('/Items/Latest'), {Limit: 20, IncludeItemTypes: 'Movie,Episode', Fields: FIELDS}),
      this.call('/Shows/NextUp', {UserId: this.server.userId, Limit: 20, Fields: FIELDS})]);
    if (results.every(result => result.status === 'rejected')) throw results[0].reason;
    const [resume, latest, next] = results.map(result => result.status === 'fulfilled' ? result.value : {});
    return [{title: 'Continue watching', items: (resume.Items || []).map(jellyItem)},
      {title: 'Next up', items: (next.Items || []).map(jellyItem)},
      {title: 'Recently added', items: (Array.isArray(latest) ? latest : latest.Items || []).map(jellyItem)}].filter(x => x.items.length);
  }
  async list(library, start = 0, sort = 'title', filter = 'all', limit = PAGE, alphaPrefix = null) {
    const order = {title: ['SortName', 'Ascending'], recent: ['DateCreated', 'Descending'],
      release: ['PremiereDate', 'Descending']}[sort] || ['SortName', 'Ascending'];
    // MediaBrowserAlphaBarStrategy uses NameStartsWith, with # as
    // NameLessThan=A, unlike Plex's cumulative index jumps.
    const data = await this.call(this.userPath('/Items'), {ParentId: library, StartIndex: start, Limit: limit,
      Fields: FIELDS, SortBy: order[0], SortOrder: order[1],
      IsPlayed: filter === 'unwatched' ? false : undefined,
      NameStartsWith: alphaPrefix && alphaPrefix !== '#' ? alphaPrefix : undefined,
      NameLessThan: alphaPrefix === '#' ? 'A' : undefined});
    return {items: (data.Items || []).map(jellyItem), total: data.TotalRecordCount || 0};
  }
  async search(query) {
    const data = await this.call(this.userPath('/Items'), {SearchTerm: query, Recursive: true,
      IncludeItemTypes: 'Movie,Series,Episode', Limit: PAGE, Fields: FIELDS});
    return (data.Items || []).map(jellyItem);
  }
  async detail(itemId) { return jellyItem(await this.call(this.userPath('/Items/') + enc(itemId))); }
  async children(itemId, start = 0) { return this.list(itemId, start); }
  image(item, options = {}) {
    const raw = item.raw;
    const landscape = !!options.landscape;
    const width = landscape ? (options.detail ? 960 : 480) : (options.detail ? 600 : 320);
    const imageId = landscape && raw.ImageTags?.Primary ? item.id :
      raw.ImageTags && raw.ImageTags.Primary ? item.id : raw.SeriesId || item.id;
    const tag = imageId === item.id ? raw.ImageTags?.Primary : raw.SeriesPrimaryImageTag;
    return this.url('/Items/' + enc(imageId) + '/Images/Primary',
      {maxWidth: width, quality: 85, tag: tag || undefined});
  }
  artworkVersion(item, options = {}) {
    const raw = item.raw || {};
    const landscape = !!options.landscape;
    const imageId = landscape && raw.ImageTags?.Primary ? item.id :
      raw.ImageTags && raw.ImageTags.Primary ? item.id : raw.SeriesId || item.id;
    // An episode's updatedAt does not describe the poster of its series.
    return String((imageId === item.id ? raw.ImageTags?.Primary : raw.SeriesPrimaryImageTag) || '');
  }
  async watched(item, played) {
    await this.call(this.userPath('/PlayedItems/') + enc(item.id), {}, {method: played ? 'POST' : 'DELETE'});
  }
  async playback(item, options = {}) {
    // Native Plezy fetches Jellyfin's media segments independently of playback
    // and uses chapters immediately if the server lacks the endpoint.
    // Emby does not implement /MediaSegments.
    const markerPromise = this.server.kind === 'jellyfin'
      ? this.call('/MediaSegments/' + enc(item.id)).then(segments =>
        jellyfinPlaybackNavigation(item.raw, segments, options.skipSettings).markers).catch(() => null)
      : null;
    const navigation = jellyfinPlaybackNavigation(item.raw, [], options.skipSettings);
    const transcode = !!options.transcode || options.audio !== undefined || (options.subtitle !== undefined && options.subtitle !== -1);
    const data = await this.call('/Items/' + enc(item.id) + '/PlaybackInfo', {UserId: this.server.userId}, {
      method: 'POST', body: {UserId: this.server.userId, StartTimeTicks: 0, MaxStreamingBitrate: 12000000,
        EnableDirectPlay: !transcode, EnableDirectStream: false, EnableTranscoding: true,
        AllowVideoStreamCopy: !transcode, AllowAudioStreamCopy: !transcode,
        AudioStreamIndex: options.audio, SubtitleStreamIndex: options.subtitle === undefined ? -1 : options.subtitle,
        DeviceProfile: {Name: 'Plezy webOS', MaxStreamingBitrate: 12000000,
          DirectPlayProfiles: [{Container: 'mp4,m4v', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac,mp3'}],
          TranscodingProfiles: [{Container: 'ts', Type: 'Video', Protocol: 'hls', VideoCodec: 'h264', AudioCodec: 'aac',
            MaxAudioChannels: '2', Context: 'Streaming', MinSegments: 1, BreakOnNonKeyFrames: true}],
          CodecProfiles: [], SubtitleProfiles: [{Format: 'srt', Method: 'Encode'}, {Format: 'ass', Method: 'Encode'},
            {Format: 'ssa', Method: 'Encode'}, {Format: 'pgssub', Method: 'Encode'}, {Format: 'dvdsub', Method: 'Encode'}]}}});
    if (data.ErrorCode) throw new Error('The server cannot prepare this video: ' + data.ErrorCode);
    const source = (data.MediaSources || [])[0];
    if (!source) throw new Error('No playable media source was returned.');
    const direct = !transcode && source.SupportsDirectPlay;
    if (!direct && !source.TranscodingUrl) throw new Error('The server cannot transcode this video. Check transcoding permissions.');
    // A reverse proxy prefix may already be included in a server's returned URL.
    let streamPath = source.TranscodingUrl;
    const prefix = new URL(this.server.url).pathname.replace(/\/$/, '');
    if (prefix && streamPath && streamPath.startsWith(prefix + '/')) streamPath = streamPath.slice(prefix.length);
    return {url: direct ? this.url('/Videos/' + enc(item.id) + '/stream', {Static: true, MediaSourceId: source.Id,
      DeviceId: this.deviceId, PlaySessionId: data.PlaySessionId}) : this.url(streamPath),
      sessionId: data.PlaySessionId, sourceId: source.Id, transcode: !direct, item, start: options.start || 0, options,
      ...navigation, markerPromise,
      audio: (source.MediaStreams || []).filter(s => s.Type === 'Audio').map(s => ({id: s.Index, label: s.DisplayTitle || s.Language || s.Codec})),
      subtitles: (source.MediaStreams || []).filter(s => s.Type === 'Subtitle').map(s => ({id: s.Index, label: s.DisplayTitle || s.Language || s.Codec}))};
  }
  async report(session, state, position) {
    const path = state === 'start' ? '/Sessions/Playing' : state === 'stopped' ? '/Sessions/Playing/Stopped' : '/Sessions/Playing/Progress';
    await this.call(path, {}, {method: 'POST', body: {ItemId: session.item.id, MediaSourceId: session.sourceId,
      PlaySessionId: session.sessionId, PositionTicks: Math.round(position * 10000000), IsPaused: state === 'paused',
      CanSeek: true, PlayMethod: session.transcode ? 'Transcode' : 'DirectPlay',
      AudioStreamIndex: session.options.audio, SubtitleStreamIndex: session.options.subtitle}});
  }
  async stop(session) {
    if (session.transcode) await this.call('/Videos/ActiveEncodings', {DeviceId: this.deviceId, PlaySessionId: session.sessionId}, {method: 'DELETE'});
  }
}
export function client(server, deviceId) { return server.kind === 'plex' ? new Plex(server, deviceId) : new Jellyfin(server, deviceId); }
