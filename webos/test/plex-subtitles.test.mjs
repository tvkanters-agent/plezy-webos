import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Plex, plexExternalSubtitle} from '../src/api.js';

function makeMedia(container = 'mp4', videoCodec = 'h264') {
  return {container, videoCodec, audioCodec:'aac', Part:[{id:55,
    key:'/library/parts/55/file.mp4', Stream:[
      {streamType:1,id:20,codec:videoCodec},
      {streamType:2,id:21,codec:'aac',selected:1},
      {streamType:3,id:90,codec:'srt',key:'/library/streams/90.srt',selected:1},
      {streamType:3,id:91,codec:'ass',key:'/library/streams/91.ass',selected:0},
      {streamType:3,id:92,codec:'ass',selected:0}
    ]}]};
}

test('selected external text track resolves from Plex file key, not the first subtitle', () => {
  const media = makeMedia();
  assert.deepEqual(plexExternalSubtitle(media), {id:90,format:'srt',key:'/library/streams/90.srt'});
  assert.deepEqual(plexExternalSubtitle(media,{subtitle:91}),
    {id:91,format:'ass',key:'/library/streams/91.ass'});
  assert.equal(plexExternalSubtitle(media,{subtitle:-1}),null);
  assert.equal(plexExternalSubtitle(media,{subtitle:92}),null, 'embedded subtitle has no external file');
  assert.equal(plexExternalSubtitle(media,{subtitle:12345}),null);
  assert.equal(plexExternalSubtitle(media,{burnSubtitles:true,subtitle:90}).format,'srt');
});

test('local SRT/ASS follows Plex subtitle selection with conservative Direct Play', async () => {
  const api = new Plex({url:'http://plex.test',token:'token'}, 'tv-test');
  const requests=[];
  api.get = async (path,params,options) => {
    requests.push({path,params,method:options?.method});
    return {MediaContainer:{Metadata:[{}]}};
  };
  const media = makeMedia();
  const item={id:'123',title:'Test title',type:'movie',duration:120,raw:{Media:[media]}};
  let session = await api.playback(item,{subtitle:91});
  assert.equal(session.transcode,false, 'a separate ASS file does not force a supported MP4 to HLS');
  assert.equal(session.subtitleAsset.format,'ass');
  assert.equal(new URL(session.subtitleAsset.url).pathname,'/library/streams/91.ass');
  assert.equal(requests[0].params.subtitleStreamID,91);
  await session.extrasPromise;

  session=await api.playback(item,{subtitle:-1});
  assert.equal(session.transcode,false);
  assert.equal(session.subtitleAsset,null);
  await session.extrasPromise;

  session=await api.playback(item,{subtitle:92});
  assert.equal(session.transcode,true, 'embedded subtitle still uses Plex burn-in');
  assert.equal(session.subtitleAsset,null);
  assert.equal(new URL(session.url).searchParams.get('subtitles'),'burn');
  await session.extrasPromise;

  item.raw.Media[0]=makeMedia('mkv');
  session=await api.playback(item,{subtitle:90});
  assert.equal(session.transcode,true, 'do not restore unstable Matroska Direct Play');
  assert.equal(session.subtitleAsset.format,'srt');
  const url=new URL(session.url);
  assert.equal(url.searchParams.get('subtitles'),'none', 'no duplicate Plex burn-in');
  assert.equal(url.searchParams.get('subtitleStreamID'),'0');
  await session.extrasPromise;

  session=await api.playback(item,{subtitle:90,transcode:true,burnSubtitles:true});
  assert.equal(session.transcode,true);
  assert.equal(session.subtitleAsset,null, 'worker/download failure uses Plex burn-in');
  assert.equal(new URL(session.url).searchParams.get('subtitles'),'burn');
  await session.extrasPromise;
});
