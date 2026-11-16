import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Plex} from '../src/api.js';
import {plexDirectPlayMime} from '../src/plex-direct-play.js';

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
    'choosing the already selected stream must not needlessly transcode');
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
