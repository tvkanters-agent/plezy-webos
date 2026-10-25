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
    poster: raw.thumb || raw.parentThumb || raw.grandparentThumb,
    folder: ['show', 'season', 'collection'].includes(raw.type), raw};
}
function jellyItem(raw) {
  return {id: raw.Id, title: raw.Name || 'Untitled', type: raw.Type,
    subtitle: raw.SeriesName || String(raw.ProductionYear || ''),
    summary: raw.Overview || '', year: raw.ProductionYear, duration: seconds(raw.RunTimeTicks),
    resume: seconds(raw.UserData && raw.UserData.PlaybackPositionTicks), watched: !!(raw.UserData && raw.UserData.Played),
    folder: !!raw.IsFolder || ['Series', 'Season', 'BoxSet', 'CollectionFolder'].includes(raw.Type), raw};
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
  async home() {
    const data = await this.get('/hubs', {count: 20});
    return (data.MediaContainer.Hub || []).map(h => ({title: h.title, items: (h.Metadata || [])
      .filter(x => ['movie', 'show', 'season', 'episode'].includes(x.type)).map(plexItem)})).filter(x => x.items.length);
  }
  async list(library, start = 0) {
    const data = (await this.get('/library/sections/' + enc(library) + '/all', {
      'X-Plex-Container-Start': start, 'X-Plex-Container-Size': PAGE, sort: 'titleSort'})).MediaContainer;
    return {items: (data.Metadata || []).map(plexItem), total: data.totalSize || data.size || 0};
  }
  async search(query) {
    const data = await this.get('/hubs/search', {query, limit: 60});
    return (data.MediaContainer.Hub || []).reduce((all, h) => all.concat(h.Metadata || []), [])
      .filter(x => ['movie', 'show', 'season', 'episode'].includes(x.type)).map(plexItem);
  }
  async detail(itemId) { return plexItem((await this.get('/library/metadata/' + enc(itemId))).MediaContainer.Metadata[0]); }
  async children(itemId, start = 0) {
    const data = (await this.get('/library/metadata/' + enc(itemId) + '/children', {
      'X-Plex-Container-Start': start, 'X-Plex-Container-Size': PAGE})).MediaContainer;
    return {items: (data.Metadata || []).map(plexItem), total: data.totalSize || data.size || 0};
  }
  image(item) { return item.poster ? this.url(item.poster) : ''; }
  async watched(item, played) { await this.get(played ? '/:/scrobble' : '/:/unscrobble', {key: item.id, identifier: 'com.plexapp.plugins.library'}); }
  async playback(item, options = {}) {
    const media = (item.raw.Media || [])[0];
    const part = media && (media.Part || [])[0];
    if (!part) throw new Error('This item has no playable media.');
    const sessionId = id();
    const transcode = options.transcode || !['mp4', 'm4v', 'mov'].includes(media.container)
      || media.videoCodec !== 'h264' || !['aac', 'mp3'].includes(media.audioCodec)
      || options.audio !== undefined || (options.subtitle !== undefined && options.subtitle !== -1);
    // Conservative direct play, with user-accessible HLS fallback for TV-specific limits.
    const params = {path: '/library/metadata/' + item.id, mediaIndex: 0, partIndex: 0,
      protocol: 'hls', directPlay: 0, directStream: 0, videoCodec: 'h264', audioCodec: 'aac',
      maxVideoBitrate: 12000, videoResolution: '1920x1080', videoQuality: 100,
      session: sessionId, offset: 0, subtitleSize: 100, subtitles: 'burn',
      'X-Plex-Platform': 'Chrome', 'X-Plex-Client-Profile-Extra': 'add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac)'};
    if (options.audio !== undefined || options.subtitle !== undefined) {
      await this.get('/library/parts/' + enc(part.id), {audioStreamID: options.audio,
        subtitleStreamID: options.subtitle === -1 ? 0 : options.subtitle, allParts: 1}, {method: 'PUT'});
    }
    return {url: transcode ? this.url('/video/:/transcode/universal/start.m3u8', params) : this.url(part.key),
      sessionId, sourceId: String(part.id), transcode, item, start: options.start || 0,
      audio: (part.Stream || []).filter(s => s.streamType === 2).map(s => ({id: s.id, label: s.displayTitle || s.language || s.codec})),
      subtitles: (part.Stream || []).filter(s => s.streamType === 3).map(s => ({id: s.id, label: s.displayTitle || s.language || s.codec})),
      options};
  }
  async report(session, state, position, duration) {
    await this.get('/:/timeline', {ratingKey: session.item.id, key: '/library/metadata/' + session.item.id,
      state: state === 'start' ? 'playing' : state, time: Math.round(position * 1000),
      duration: Math.round((duration || session.item.duration) * 1000), hasMDE: 1, session: session.sessionId});
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
    const [resume, latest, next] = await Promise.all([
      this.call(this.userPath('/Items/Resume'), {Limit: 20, MediaTypes: 'Video', Fields: FIELDS}),
      this.call(this.userPath('/Items/Latest'), {Limit: 20, IncludeItemTypes: 'Movie,Episode', Fields: FIELDS}),
      this.call('/Shows/NextUp', {UserId: this.server.userId, Limit: 20, Fields: FIELDS})]);
    return [{title: 'Continue watching', items: (resume.Items || []).map(jellyItem)},
      {title: 'Next up', items: (next.Items || []).map(jellyItem)},
      {title: 'Recently added', items: (Array.isArray(latest) ? latest : latest.Items || []).map(jellyItem)}].filter(x => x.items.length);
  }
  async list(library, start = 0) {
    const data = await this.call(this.userPath('/Items'), {ParentId: library, StartIndex: start, Limit: PAGE,
      Fields: FIELDS, SortBy: 'SortName', SortOrder: 'Ascending'});
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
