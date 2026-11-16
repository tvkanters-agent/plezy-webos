import {test} from 'node:test';
import {deepStrictEqual, equal} from 'node:assert/strict';
import {mediaSourceTracks, Plex} from '../src/api.js';

test('uses stream IDs and selected flags from the requested Plex media version', () => {
  const item={raw:{Media:[
    {Part:[{Stream:[{streamType:2,id:3,languageCode:'eng',selected:1}]}]},
    {Part:[{Stream:[
      {streamType:2,id:0,languageCode:'fra',selected:1,codec:'eac3',channels:6},
      {streamType:2,id:5,languageCode:'eng',selected:0},
      {streamType:3,id:0,languageCode:'eng',selected:1,forced:1,key:'/library/streams/12.srt',offset:125},
      {streamType:3,id:6,languageCode:'spa',selected:0}
    ]}]}
  ]}};
  const tracks=mediaSourceTracks(item,1);
  deepStrictEqual(tracks.audio.map(t=>t.id),[0,5]);
  deepStrictEqual(tracks.subtitles.map(t=>t.id),[0,6]);
  equal(tracks.audio[0].selected,true);
  equal(tracks.audio[1].selected,false);
  equal(tracks.subtitles[0].selected,true);
  equal(tracks.subtitles[0].primary,'English (Forced)');
  equal(tracks.subtitles[0].key,'/library/streams/12.srt');
  equal(tracks.subtitles[0].offset,125);
  equal(mediaSourceTracks(item,0).audio[0].id,3);
});

test('uses Jellyfin media stream indices without conflating stream zero with Off', () => {
  const tracks=mediaSourceTracks({raw:{MediaSources:[{MediaStreams:[
    {Type:'Audio',Index:0,Language:'eng',Codec:'aac',IsDefault:true},
    {Type:'Subtitle',Index:0,Language:'fra',Codec:'srt',IsDefault:true}
  ]}]}});
  equal(tracks.audio[0].id,0);
  equal(tracks.subtitles[0].id,0);
  equal(tracks.subtitles[0].selected,true);
});

test('writes a Plex external subtitle offset in milliseconds', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl, requestedOptions;
  globalThis.fetch = async (url, options) => {
    requestedUrl = String(url);
    requestedOptions = options;
    return {ok:true};
  };
  try {
    const plex = new Plex({url:'http://plex.test', token:'token'}, 'device');
    await plex.setSubtitleOffset({key:'/library/streams/42.srt'}, -1250);
    equal(requestedOptions.method, 'PUT');
    equal(new URL(requestedUrl).pathname, '/library/streams/42.srt');
    equal(new URL(requestedUrl).searchParams.get('offset'), '-1250');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
