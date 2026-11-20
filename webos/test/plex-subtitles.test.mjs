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
      {streamType:3,id:92,codec:'ass',selected:0},
      {streamType:3,id:93,codec:'pgs',selected:0}
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
  assert.equal(session.transcode,false, 'extracting embedded text allows Direct Play');
  assert.equal(session.subtitleAsset.embedded,true);
  const extraction = new URL(session.subtitleAsset.url);
  assert.equal(extraction.pathname,'/subtitles/:/transcode/universal/start');
  const subtitleDecision = new URL(session.subtitleAsset.decisionUrl);
  assert.equal(subtitleDecision.pathname,'/video/:/transcode/universal/decision');
  assert.equal(subtitleDecision.search,extraction.search);
  assert.equal(extraction.searchParams.get('subtitleStreamID'),'92');
  assert.equal(extraction.searchParams.get('directPlay'),'1');
  assert.equal(extraction.searchParams.get('protocol'),'http');
  assert.equal(extraction.searchParams.get('X-Plex-Token'),'token');
  assert.equal(extraction.searchParams.has('offset'),false);
  assert.equal(requests.filter(r=>r.method==='PUT').at(-1).params.subtitleStreamID,92);
  await session.extrasPromise;

  session=await api.playback(item,{subtitle:93});
  assert.equal(session.transcode,true, 'image subtitle still requires burn-in');
  assert.equal(session.subtitleAsset,null);
  assert.equal(session.subtitleBurnedIn,true);
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

test('real Plex sidecar keys request the codec extension and UTF-8, including SSA', async () => {
  const api = new Plex({url:'http://plex.test',token:'token'}, 'tv-test');
  api.get = async () => ({MediaContainer:{Metadata:[{}]}});
  for (const [codec, suffix, format] of [
    ['srt','srt','srt'], ['subrip','srt','srt'], ['ass','ass','ass'], ['ssa','ssa','ass']
  ]) {
    const media = makeMedia('mkv');
    media.Part[0].Stream = [
      {streamType:3,id:90,codec,key:'/library/streams/90?download=1',selected:1}
    ];
    assert.deepEqual(plexExternalSubtitle(media), {
      id:90, format, key:'/library/streams/90.' + suffix + '?download=1'
    });
    const session = await api.playback({id:'123',raw:{Media:[media]}});
    const url = new URL(session.subtitleAsset.url);
    assert.equal(url.pathname, '/library/streams/90.' + suffix);
    assert.equal(url.searchParams.get('encoding'), 'utf-8');
    assert.equal(url.searchParams.get('download'), '1');
    assert.equal(url.searchParams.get('X-Plex-Token'), 'token');
    assert.equal(new URL(session.url).searchParams.get('subtitles'), 'none');
    await session.extrasPromise;
  }
  const media = makeMedia();
  media.Part[0].Stream[2].key = '/library/streams/90.SRT?download=1';
  assert.equal(plexExternalSubtitle(media).key, '/library/streams/90.SRT?download=1');
});

test('embedded text extraction keeps the chosen media version, stream and timeline separate from HLS', async () => {
  const api = new Plex({url:'http://plex.test',token:'token'}, 'tv-test');
  const requests = [];
  api.get = async (path, params) => {
    requests.push(api.url(path,params));
    return {MediaContainer:{Metadata:[{}]}};
  };
  const media = makeMedia('mkv');
  media.Part[0].Stream = [{streamType:3,id:94,codec:'srt',selected:'1'}];
  const session = await api.playback({id:'456',raw:{Media:[makeMedia(),media]}},{mediaIndex:1,start:60});
  assert.equal(session.subtitleBurnedIn,false);
  assert.equal(session.start,60);
  const video = new URL(session.url);
  const decision = new URL(requests[0]);
  assert.equal(decision.pathname,'/video/:/transcode/universal/decision');
  assert.equal(decision.search,video.search);
  const extraction = new URL(session.subtitleAsset.url);
  assert.equal(extraction.pathname,'/subtitles/:/transcode/universal/start');
  assert.equal(extraction.searchParams.get('path'),'/library/metadata/456');
  assert.equal(extraction.searchParams.get('mediaIndex'),'1');
  assert.equal(extraction.searchParams.get('partIndex'),'0');
  assert.equal(extraction.searchParams.get('subtitleStreamID'),'94');
  assert.equal(extraction.searchParams.get('protocol'),'http');
  assert.equal(extraction.searchParams.get('subtitles'),'sidecar');
  assert.equal(extraction.searchParams.get('copyts'),'1');
  assert.equal(extraction.searchParams.get('hasMDE'),'1');
  assert.equal(extraction.searchParams.get('X-Plex-Platform'),'Chrome');
  assert.equal(extraction.searchParams.get('X-Plex-Session-Identifier'),extraction.searchParams.get('session'));
  assert.equal(extraction.searchParams.has('X-Plex-Client-Profile-Extra'),false);
  assert.equal(extraction.searchParams.has('videoResolution'),false);
  assert.equal(extraction.searchParams.has('offset'),false);
  assert.notEqual(extraction.searchParams.get('session'),video.searchParams.get('session'));
  assert.equal(video.searchParams.get('protocol'),'hls');
  assert.equal(video.searchParams.get('X-Plex-Platform'),'Generic');
  assert.equal(video.searchParams.get('X-Plex-Client-Profile-Name'),'Generic');
  assert.match(video.searchParams.get('X-Plex-Client-Profile-Extra'),/protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac/);
  assert.equal(video.searchParams.get('X-Plex-Session-Identifier'),video.searchParams.get('session'));
  assert.equal(video.searchParams.get('subtitles'),'none');
  assert.equal(video.searchParams.get('subtitleStreamID'),'0');
  await session.extrasPromise;
});

test('Plex burn-in selects the exact embedded SRT/ASS track on the part before the decision',async()=>{
  for (const [codec,id] of [['srt',92],['ass',93]]) {
    const api=new Plex({url:'http://plex.test',token:'token'},'tv-test');
    const media=makeMedia('mkv');
    media.Part[0].Stream=[{streamType:3,id,codec,selected:1}];
    const item={id:'123',title:'Test',duration:120,raw:{Media:[media]}};
    const requests=[];
    // PMS burns the stored selection, not a subtitleStreamID from HLS.
    // Simulate a stale/no server selection despite metadata's selected flag.
    let serverSelected=null;
    api.get=async(path,params,options)=>{
      requests.push({path,params,method:options?.method});
      if (options?.method==='PUT') serverSelected=params.subtitleStreamID;
      if (path==='/video/:/transcode/universal/decision') {
        assert.equal(params.subtitles,'burn');
        assert.equal(params.subtitleStreamID,undefined);
        assert.equal(serverSelected,id,'PMS must be told which stream to paint first');
      }
      return {MediaContainer:{Metadata:[{}]}};
    };
    const session=await api.playback(item,{burnSubtitles:true,start:35});
    assert.equal(session.subtitleBurnedIn,true);
    assert.equal(session.start,35);
    assert.deepEqual(requests.slice(0,2).map(call=>[call.path,call.method]),[
      ['/library/parts/55','PUT'],['/video/:/transcode/universal/decision',undefined]
    ]);
    assert.equal(requests[0].params.subtitleStreamID,id);
    assert.equal(requests[0].params.allParts,1);
    await session.extrasPromise;
  }
});

test('Plex burn-in changes a stale or different server selection to the explicit chosen subtitle',async()=>{
  const api=new Plex({url:'http://plex.test',token:'token'},'tv-test');
  const media=makeMedia('mkv');
  media.Part[0].Stream=[
    {streamType:3,id:92,codec:'ass',selected:0},
    {streamType:3,id:93,codec:'pgs',selected:1}
  ];
  let selected=93;
  api.get=async(path,params,options)=>{
    if (options?.method==='PUT') selected=params.subtitleStreamID;
    if (path==='/video/:/transcode/universal/decision') assert.equal(selected,92);
    return {MediaContainer:{Metadata:[{}]}};
  };
  const session=await api.playback({id:'123',raw:{Media:[media]}},
    {subtitle:92,burnSubtitles:true});
  assert.equal(session.subtitleBurnedIn,true);
  await session.extrasPromise;
});

test('a failed Plex part-selection request must prevent an unconfirmed burn-in decision',async()=>{
  const api=new Plex({url:'http://plex.test',token:'token'},'tv-test');
  const media=makeMedia('mkv');
  media.Part[0].Stream=[{streamType:3,id:92,codec:'srt',selected:1}];
  const requests=[];
  api.get=async(path,params,options)=>{
    requests.push(path);
    if(options?.method==='PUT') throw new Error('The server returned HTTP 503.');
    return {};
  };
  await assert.rejects(api.playback({id:'123',raw:{Media:[media]}},
    {burnSubtitles:true}),/HTTP 503/);
  assert.deepEqual(requests,['/library/parts/55']);
});
