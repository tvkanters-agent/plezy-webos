import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Plex} from '../src/api.js';
import {plexDirectPlayMime, plexSubtitleAsset} from '../src/plex-direct-play.js';

function media(container = 'mkv', videoCodec = 'hevc', audioCodec = 'eac3', extra = {}) {
  return {container, videoCodec, audioCodec, width: 3840, height: 2160, bitrate: 20000,
    Part: [{id: 55, key: '/library/parts/55/file.mkv',
      Stream: [
        {streamType: 1, id: 20, codec: videoCodec, bitDepth: videoCodec === 'h264' ? 8 : 10},
        {streamType: 2, id: 21, codec: audioCodec, selected: 1},
        {streamType: 2, id: 22, codec: 'aac', selected: 0}
      ]}], ...extra};
}

test('LG 4.x direct-plays supported MP4 and Matroska codecs, including HEVC', () => {
  assert.equal(plexDirectPlayMime(media('mp4', 'h264', 'aac', {width: 1920, height: 1080})), 'video/mp4');
  assert.equal(plexDirectPlayMime(media('mp4', 'hevc', 'eac3')), 'video/mp4');
  assert.equal(plexDirectPlayMime(media('mkv', 'h264', 'aac', {width: 1920, height: 1080})), 'video/x-matroska');
  assert.equal(plexDirectPlayMime(media()), 'video/x-matroska');
  assert.equal(plexDirectPlayMime(media('matroska', 'hevc', 'ac3')), 'video/x-matroska');
  assert.equal(plexDirectPlayMime(media('mkv', 'h264', 'dca', {width: 1920, height: 1080})), 'video/x-matroska');
});

test('unsupported formats remain on Plex HLS instead of attempting native playback', () => {
  assert.equal(plexDirectPlayMime(media('mkv', 'av1', 'aac')), null);
  assert.equal(plexDirectPlayMime(media('mkv', 'hevc', 'truehd')), null);
  assert.equal(plexDirectPlayMime(media('mkv', 'h264', 'dca')), null, '4K DTS is not in LG UHD support matrix');
  assert.equal(plexDirectPlayMime(media('mkv', 'h264', 'aac', {width: 1920, height: 1080,
    Part: [{id: 55, Stream: [{streamType: 1, bitDepth: 10}]}]})), null);
  assert.equal(plexDirectPlayMime(media('mp4', 'hevc', 'aac', {bitrate: 70000})), null);
  assert.equal(plexDirectPlayMime(media('mp4', 'hevc', 'aac', {width: 7680})), null);
  assert.equal(plexDirectPlayMime(media('mov', 'h264', 'ac3', {width: 1920, height: 1080,
    bitrate: 20000, Part: [{id: 55}]})), 'video/mp4');
});

test('explicit incompatible track and quality requests retain transcoding', () => {
  const input = media('mkv', 'hevc', 'aac');
  assert.equal(plexDirectPlayMime(input, {subtitle: 90}), null);
  assert.equal(plexDirectPlayMime(input, {audio: 22}), null);
  assert.equal(plexDirectPlayMime(input, {transcode: true}), null);
  assert.equal(plexDirectPlayMime(input, {audio: 21, subtitle: -1}), 'video/x-matroska',
    'choosing the native first audio stream must not needlessly transcode');
  const secondAudioDefault = media('mkv', 'hevc', 'aac');
  secondAudioDefault.Part[0].Stream[1].selected = 0;
  secondAudioDefault.Part[0].Stream[2].selected = 1;
  assert.equal(plexDirectPlayMime(secondAudioDefault), null,
    'Plex selecting a later audio track cannot be applied by the native part URL');
  const defaultSubtitle = media('mkv', 'hevc', 'aac');
  defaultSubtitle.Part[0].Stream.push({streamType: 3, id: 90, selected: 1});
  assert.equal(plexDirectPlayMime(defaultSubtitle), null, 'server-default subtitles must remain visible');
  assert.equal(plexDirectPlayMime(defaultSubtitle, {subtitle: -1}), 'video/x-matroska',
    'turning server-default subtitles off may Direct Play');
});

test('Plex playback uses a direct part URL when the TV accepts the source', async () => {
  const m = media();
  const api = new Plex({url: 'http://plex.test', token: 'token'}, 'test-device');
  api.get = async () => ({MediaContainer: {Metadata: [{Media: [m]}]}});
  const item = {id: '123', title: 'HEVC movie', type: 'movie', duration: 1200, raw: {Media: [m]}};
  const session = await api.playback(item);
  assert.equal(session.transcode, false);
  assert.equal(session.mimeType, 'video/x-matroska');
  assert.equal(new URL(session.url).pathname, '/library/parts/55/file.mkv');
  await session.extrasPromise;
});

test('Plex playback retains the existing HLS fallback for incompatible files and selected subtitles', async () => {
  const m = media('mkv', 'hevc', 'truehd');
  const api = new Plex({url: 'http://plex.test', token: 'token'}, 'test-device');
  const requested = [];
  api.get = async (path, params, config) => {
    requested.push({path, params, method: config?.method});
    return {MediaContainer: {Metadata: [{Media: [m]}]}};
  };
  const item = {id: '123', title: 'TrueHD movie', type: 'movie', duration: 1200, raw: {Media: [m]}};
  const session = await api.playback(item, {subtitle: 90});
  const url = new URL(session.url);
  assert.equal(session.transcode, true);
  assert.equal(session.mimeType, null);
  assert.equal(url.pathname, '/video/:/transcode/universal/start.m3u8');
  assert.equal(url.searchParams.get('directPlay'), '0');
  assert.equal(url.searchParams.get('directStream'), '0');
  assert.equal(requested[0].path, '/library/parts/55');
  assert.equal(requested[0].params.subtitleStreamID, 90);
  await session.extrasPromise;
});

test('external SRT and ASS use the selected file without forcing a video transcode', async () => {
  const m = media();
  m.Part[0].Stream.push(
    {streamType:3, id:90, codec:'srt', key:'/library/streams/90.srt', selected:1},
    {streamType:3, id:91, codec:'ass', key:'/library/streams/91.ass', selected:0},
    {streamType:3, id:92, codec:'ass', selected:0}
  );
  assert.equal(plexDirectPlayMime(m), 'video/x-matroska', 'server-default SRT is rendered locally');
  assert.equal(plexSubtitleAsset(m).id, 90);
  assert.equal(plexSubtitleAsset(m, {subtitle:91}).format, 'ass');
  assert.equal(plexDirectPlayMime(m, {subtitle:91}), 'video/x-matroska');
  assert.equal(plexDirectPlayMime(m, {subtitle:92}), null, 'embedded ASS still needs Plex');
  assert.equal(plexDirectPlayMime(m, {subtitle:-1}), 'video/x-matroska');
  assert.equal(plexSubtitleAsset(m, {subtitle:-1}), null);
  assert.equal(plexDirectPlayMime(m, {subtitle:91, burnSubtitles:true}), null);

  const api = new Plex({url:'http://plex.test', token:'token'}, 'test-device');
  const requests = [];
  api.get = async (path, params, config) => {
    requests.push({path,params,method:config?.method});
    return {MediaContainer:{Metadata:[{Media:[m]}]}};
  };
  const item = {id:'123',title:'ASS test',type:'movie',duration:120,raw:{Media:[m]}};
  const direct = await api.playback(item, {subtitle:91});
  assert.equal(direct.transcode, false);
  assert.equal(direct.subtitleAsset.format, 'ass');
  assert.equal(new URL(direct.subtitleAsset.url).pathname, '/library/streams/91.ass');
  assert.equal(requests[0].params.subtitleStreamID, 91, 'selected Plex subtitle ID persists');
  await direct.extrasPromise;

  const hls = await api.playback(item, {subtitle:90, transcode:true});
  assert.equal(hls.transcode, true);
  assert.equal(hls.subtitleAsset.format, 'srt');
  const url = new URL(hls.url);
  assert.equal(url.searchParams.get('subtitles'), 'none', 'avoid duplicated burned captions');
  assert.equal(url.searchParams.get('subtitleStreamID'), '0');
  await hls.extrasPromise;

  const fallback = await api.playback(item, {subtitle:90, transcode:true, burnSubtitles:true});
  assert.equal(fallback.subtitleAsset, null);
  assert.equal(new URL(fallback.url).searchParams.get('subtitles'), 'burn');
  await fallback.extrasPromise;
});
