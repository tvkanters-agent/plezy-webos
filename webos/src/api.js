// SPDX-License-Identifier: GPL-3.0-only
// Protocols ported from lib/services/{plex,jellyfin}_* and their client parts.
import {VERSION, baseUrl, endpoint, request, seconds, id} from './core.js';
const enc = encodeURIComponent;
const PAGE = 60;
const FIELDS = 'Overview,MediaSources,MediaStreams,UserData,PrimaryImageAspectRatio';
function plexItem(raw) {
  return {id: String(raw.ratingKey), title: raw.title || 'Untitled', type: raw.type,
    subtitle: raw.grandparentTitle || raw.parentTitle || String(raw.year || ''),
    summary: raw.summary || '', year: raw.year, duration: (raw.duration || 0) / 1000,
    resume: (raw.viewOffset || 0) / 1000, watched: !!raw.viewCount,
    poster: raw.type === 'episode' ? (raw.grandparentThumb || raw.parentThumb || raw.thumb)
      : (raw.thumb || raw.parentThumb || raw.grandparentThumb),
    background: raw.art || raw.grandparentArt || '',
    folder: ['show', 'season', 'collection', 'playlist'].includes(raw.type), raw};
}
function jellyItem(raw) {
  return {id: raw.Id, title: raw.Name || 'Untitled', type: raw.Type,
    subtitle: raw.SeriesName || String(raw.ProductionYear || ''),
    summary: raw.Overview || '', year: raw.ProductionYear, duration: seconds(raw.RunTimeTicks),
    resume: seconds(raw.UserData && raw.UserData.PlaybackPositionTicks), watched: !!(raw.UserData && raw.UserData.Played),
    folder: !!raw.IsFolder || ['Series', 'Season', 'BoxSet', 'CollectionFolder'].includes(raw.Type), raw};
}
// Plex chapter/marker offsets are milliseconds on the full title timeline.
export function plexNavigation(raw) {
  const duration = Number(raw.duration) / 1000;
  const valid = value => value !== null && value !== undefined && value !== ''
    && Number.isFinite(Number(value)) && Number(value) >= 0;
  const chapters = (Array.isArray(raw.Chapter) ? raw.Chapter : [])
    .filter(c => c && valid(c.startTimeOffset))
    .map((c, i) => ({start: Number(c.startTimeOffset) / 1000, title: c.title || 'Chapter ' + (i + 1)}))
    .filter(c => !duration || c.start < duration).sort((a, b) => a.start - b.start);
  const markers = (Array.isArray(raw.Marker) ? raw.Marker : [])
    .filter(m => m && ['intro', 'credits'].includes(m.type) && valid(m.startTimeOffset) && valid(m.endTimeOffset))
    .map(m => ({type: m.type, start: Number(m.startTimeOffset) / 1000,
      end: Math.min(Number(m.endTimeOffset) / 1000, duration || Infinity)}))
    .filter(m => m.end > m.start).sort((a, b) => a.start - b.start);
  return {chapters, markers};
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
        title: h.title || 'Recommended',
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
      if (items.length) rows.push({title: 'Continue watching', items});
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
  async list(library, start = 0, sort = 'title', filter = 'all') {
    const order = {title: 'titleSort', recent: 'addedAt:desc', release: 'originallyAvailableAt:desc'}[sort] || 'titleSort';
    const section = filter === 'unwatched' ? 'unwatched' : 'all';
    const data = (await this.get('/library/sections/' + enc(library) + '/' + section, {
      'X-Plex-Container-Start': start, 'X-Plex-Container-Size': PAGE, sort: order})).MediaContainer;
    return {items: (data.Metadata || []).map(plexItem), total: data.totalSize || data.size || 0};
  }
  async search(query) {
    const data = await this.get('/hubs/search', {query, limit: 60});
    return (data.MediaContainer.Hub || []).reduce((all, h) => all.concat(h.Metadata || []), [])
      .filter(x => ['movie', 'show', 'season', 'episode'].includes(x.type)).map(plexItem);
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
  image(item) {
    if (!item.poster) return '';
    // Plex's original /library/metadata/.../thumb response can be a large
    // full-resolution JPEG. Ask Plex to decode/resize SERVER-SIDE before an
    // older LG TV receives it; keeps artwork and GUI decode work bounded.
    return this.url('/photo/:/transcode', {width: 320, height: 480,
      minSize: 1, upscale: 0, url: item.poster});
  }
  backdrop(item) {
    return item.background ? this.url('/photo/:/transcode',
      {width: 960, height: 540, minSize: 1, upscale: 0, url: item.background}) : '';
  }
  async onDeck(showId) {
    const data = (await this.get('/library/metadata/' + enc(showId) + '/onDeck')).MediaContainer;
    return (data.Metadata || []).map(plexItem)[0] || null;
  }
  async watched(item, played) { await this.get(played ? '/:/scrobble' : '/:/unscrobble', {key: item.id, identifier: 'com.plexapp.plugins.library'}); }
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
      session: sessionId, offset: 0, subtitleSize: 100, subtitles: 'burn',
      'X-Plex-Platform': 'Chrome', 'X-Plex-Client-Profile-Extra': 'add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac)'};
    if (options.audio !== undefined || options.subtitle !== undefined) {
      await this.get('/library/parts/' + enc(part.id), {audioStreamID: options.audio,
        subtitleStreamID: options.subtitle === -1 ? 0 : options.subtitle, allParts: 1}, {method: 'PUT'});
    }
    return {url: transcode ? this.url('/video/:/transcode/universal/start.m3u8', params) : this.url(part.key),
      sessionId, sourceId: String(part.id), transcode, item, start: options.start || 0, ...plexNavigation(item.raw),
      audio: (part.Stream || []).filter(s => s.streamType === 2).map(s => ({id: s.id, label: s.displayTitle || s.language || s.codec})),
      subtitles: (part.Stream || []).filter(s => s.streamType === 3).map(s => ({id: s.id, label: s.displayTitle || s.language || s.codec})),
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
  async list(library, start = 0, sort = 'title', filter = 'all') {
    const order = {title: ['SortName', 'Ascending'], recent: ['DateCreated', 'Descending'],
      release: ['PremiereDate', 'Descending']}[sort] || ['SortName', 'Ascending'];
    const data = await this.call(this.userPath('/Items'), {ParentId: library, StartIndex: start, Limit: PAGE,
      Fields: FIELDS, SortBy: order[0], SortOrder: order[1],
      IsPlayed: filter === 'unwatched' ? false : undefined});
    return {items: (data.Items || []).map(jellyItem), total: data.TotalRecordCount || 0};
  }
  async search(query) {
    const data = await this.call(this.userPath('/Items'), {SearchTerm: query, Recursive: true,
      IncludeItemTypes: 'Movie,Series,Episode', Limit: PAGE, Fields: FIELDS});
    return (data.Items || []).map(jellyItem);
  }
  async detail(itemId) { return jellyItem(await this.call(this.userPath('/Items/') + enc(itemId))); }
  async children(itemId, start = 0) { return this.list(itemId, start); }
  image(item) {
    const raw = item.raw;
    const imageId = raw.ImageTags && raw.ImageTags.Primary ? item.id : raw.SeriesId || item.id;
    return this.url('/Items/' + enc(imageId) + '/Images/Primary', {maxWidth: 360, quality: 85});
  }
  async watched(item, played) {
    await this.call(this.userPath('/PlayedItems/') + enc(item.id), {}, {method: played ? 'POST' : 'DELETE'});
  }
  async playback(item, options = {}) {
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
