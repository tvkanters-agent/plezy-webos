import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Plex, mediaSourceTracks, plexExternalSubtitle} from '../src/api.js';
import {EpisodeTrackPreferences} from '../src/episode-track-preferences.js';

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

test('compatibility mode restores pre-change Plex HLS and burn-in for MKV SRT and ASS',async()=>{
  for (const codec of ['srt','ass']) {
    const api=new Plex({url:'http://plex.test',token:'token'},'tv-test');
    const calls=[];
    api.get=async(path,params,options)=>{
      calls.push({path,params,options});
      return {MediaContainer:{Metadata:[{}]}};
    };
    const media=makeMedia('mkv');
    media.Part[0].Stream=[{streamType:3,id:92,codec,selected:1}];
    const item={id:'123',title:'Test',duration:120,raw:{Media:[media]}};
    const session=await api.playback(item,{srtPlayback:false,assPlayback:false,start:45});
    const url=new URL(session.url);
    assert.equal(session.transcode,true);
    assert.equal(session.start,45);
    assert.equal(session.subtitleAsset,null);
    assert.equal(session.legacyPlexPlayback,true);
    assert.equal(session.subtitleBurnedIn,true);
    assert.equal(url.pathname,'/video/:/transcode/universal/start.m3u8');
    assert.equal(url.searchParams.get('X-Plex-Platform'),'Chrome');
    assert.equal(url.searchParams.get('subtitles'),'burn');
    assert.equal(url.searchParams.get('directPlay'),'0');
    assert.equal(url.searchParams.has('hasMDE'),false);
    assert.equal(url.searchParams.has('subtitleStreamID'),false);
    assert.equal(url.searchParams.get('fastSeek'),'1');
    assert.equal(url.searchParams.get('secondsPerSegment'),'2');
    assert.equal(url.searchParams.get('directStreamAudio'),'1');
    assert.equal(url.searchParams.get('directStream'),'0');
    assert.equal(url.searchParams.get('audioCodec'),'aac');
    assert.equal(url.searchParams.get('X-Plex-Incomplete-Segments'),'1');
    assert.equal(url.searchParams.has('offset'),false);
    assert.deepEqual(calls.map(call=>call.path),['/library/parts/55','/library/metadata/123']);
    assert.equal(calls[0].params.subtitleStreamID,92);
    await session.extrasPromise;

    const selected=await api.playback(item,{srtPlayback:false,assPlayback:false,subtitle:92,mediaIndex:0});
    assert.equal(selected.transcode,true);
    assert.deepEqual(calls.slice(-2).map(call=>call.path),[
      '/library/parts/55','/library/metadata/123']);
    assert.equal(calls.at(-2).params.subtitleStreamID,92);
    assert.equal(calls.at(-2).options.method,'PUT');
    await selected.extrasPromise;
  }
});

test('enhanced SRT requires opt-in; ASS always uses Plex burn-in',async()=>{
  for(const codec of ['srt','ass']){
    const api=new Plex({url:'http://plex.test',token:'token'},'tv-test');
    const requests=[];
    api.get=async(path,params,options)=>{
      requests.push({path,params,options});
      return {MediaContainer:{Metadata:[{}]}};
    };
    const media=makeMedia('mkv');
    media.Part[0].Stream=[{streamType:3,id:92,codec,selected:1}];
    const item={id:'123',raw:{Media:[media]}};
    for(const enhancedPlayback of [undefined,false,'true',1,null]){
      requests.length=0;
      const session=await api.playback(item,{enhancedPlayback,start:31});
      assert.equal(session.legacyPlexPlayback,true);
      assert.equal(session.enhancedPlayback,undefined);
      assert.equal(session.subtitleAsset,null);
      assert.equal(session.subtitleBurnedIn,true);
      assert.equal(new URL(session.url).searchParams.get('subtitles'),'burn');
      assert.equal(requests.some(call=>call.path.includes('/decision')),false);
      await session.extrasPromise;
    }
    requests.length=0;
    const session=await api.playback(item,{srtPlayback:true,assPlayback:true,start:31});
    assert.equal(!!session.enhancedPlayback,codec==='srt');
    assert.equal(!!session.legacyPlexPlayback,codec==='ass');
    assert.equal(session.subtitleAsset?.format||null,codec==='srt'?'srt':null);
    assert.equal(new URL(session.url).searchParams.get('subtitles'),codec==='srt'?'none':'burn');
    assert.equal(requests.some(call=>call.path.includes('/decision')),codec==='srt');
    await session.extrasPromise;
  }
});
test('the selected subtitle codec alone determines the route before requesting playback',async()=>{
  const api=new Plex({url:'http://plex.test',token:'token'},'tv-test');
  const requests=[];
  api.get=async(path,params,options)=>{
    requests.push({path,params,options});
    return {MediaContainer:{Metadata:[{}]}};
  };
  const media=makeMedia('mkv'),item={id:'123',raw:{Media:[media]}};
  for(const [srtPlayback,assPlayback,subtitle,format] of [
    [false,false,90,null],[true,false,90,'srt'],
    [true,false,91,null],[false,true,90,null],
    [false,true,91,null],[true,true,91,null],
    [true,true,-1,null],[true,true,93,null]
  ]){
    requests.length=0;
    const session=await api.playback(item,{srtPlayback,assPlayback,subtitle});
    await session.extrasPromise;
    assert.equal(session.subtitleAsset?.format||null,format);
    assert.equal(!!session.enhancedPlayback,!!format);
    assert.equal(!!session.legacyPlexPlayback,!format);
    assert.equal(requests.some(call=>call.path.includes('/decision')),!!format);
    assert.equal(new URL(session.url).searchParams.get('X-Plex-Platform'),format?'Generic':'Chrome');
    assert.equal(new URL(session.url).searchParams.get('subtitles'),format?'none':'burn');
  }
});
test('compatibility mode retains the historical MP4 direct-versus-compatible decision',async()=>{
  const api=new Plex({url:'http://plex.test',token:'token'},'tv-test');
  const calls=[];api.get=async(path,params,options)=>{
    calls.push({path,params,options});return {MediaContainer:{Metadata:[{}]}};
  };
  const item={id:'123',raw:{Media:[makeMedia()]}};
  const direct=await api.playback(item,{srtPlayback:false,assPlayback:false,subtitle:-1});
  assert.equal(direct.transcode,false);
  assert.equal(direct.subtitleAsset,null);
  assert.equal(new URL(direct.url).pathname,'/library/parts/55/file.mp4');
  await direct.extrasPromise;
  const burned=await api.playback(item,{srtPlayback:false,assPlayback:false});
  assert.equal(burned.transcode,true,'a default text track also needs burn-in when its toggle is off');
  assert.equal(burned.subtitleBurnedIn,true);
  await burned.extrasPromise;
  const compatible=await api.playback(item,{srtPlayback:false,assPlayback:false,transcode:true,subtitle:-1});
  assert.equal(compatible.transcode,true);
  assert.equal(new URL(compatible.url).searchParams.has('secondsPerSegment'),false);
  assert.equal(new URL(compatible.url).searchParams.has('directStreamAudio'),false);
  assert.equal(new URL(compatible.url).searchParams.has('X-Plex-Incomplete-Segments'),false);
  assert.equal(new URL(compatible.url).searchParams.get('subtitles'),'burn');
  assert.equal(calls.at(-2).params.subtitleStreamID,0);
  assert.ok(!calls.some(call=>call.path==='/video/:/transcode/universal/decision'));
  await compatible.extrasPromise;
});

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

test('SRT direct play, sidecar, embedded MKV and burn-in fallback remain functional',async()=>{
  const api=new Plex({url:'http://plex.test',token:'token'},'tv-test');
  const requests=[];
  api.get=async(path,params,options)=>{
    requests.push({path,params,method:options?.method});
    return {MediaContainer:{Metadata:[{}]}};
  };
  const item={id:'123',title:'Test title',type:'movie',duration:120,raw:{Media:[makeMedia()]}};
  let session=await api.playback(item,{srtPlayback:true,subtitle:90});
  assert.equal(session.transcode,false,'SRT sidecar allows compatible MP4 direct play');
  assert.equal(session.subtitleAsset.format,'srt');
  assert.equal(new URL(session.subtitleAsset.url).pathname,'/library/streams/90.srt');
  assert.equal(requests[0].params.subtitleStreamID,90);
  await session.extrasPromise;

  session=await api.playback(item,{srtPlayback:true,assPlayback:true,subtitle:91});
  assert.equal(session.transcode,true,'ASS is always rendered by Plex');
  assert.equal(session.legacyPlexPlayback,true);
  assert.equal(session.subtitleAsset,null);
  assert.equal(new URL(session.url).searchParams.get('subtitles'),'burn');
  await session.extrasPromise;

  session=await api.playback(item,{srtPlayback:true,subtitle:-1});
  assert.equal(session.transcode,false);
  assert.equal(session.subtitleAsset,null);
  await session.extrasPromise;

  item.raw.Media[0]=makeMedia('mkv');
  item.raw.Media[0].Part[0].Stream.find(stream=>stream.id===92).codec='srt';
  session=await api.playback(item,{srtPlayback:true,subtitle:92});
  assert.equal(session.subtitleAsset.format,'srt');
  assert.equal(session.subtitleAsset.embedded,true);
  assert.equal(new URL(session.subtitleAsset.url).pathname,
    '/subtitles/:/transcode/universal/start');
  assert.equal(new URL(session.subtitleAsset.url).searchParams.get('subtitleStreamID'),'92');
  assert.equal(session.subtitleAsset.partUrl.includes('/library/parts/55/'),true);
  await session.extrasPromise;

  session=await api.playback(item,{srtPlayback:true,subtitle:93});
  assert.equal(session.transcode,true);
  assert.equal(session.subtitleAsset,null);
  assert.equal(new URL(session.url).searchParams.get('subtitles'),'burn');
  await session.extrasPromise;

  session=await api.playback(item,{srtPlayback:true,subtitle:90});
  assert.equal(session.transcode,true,'Matroska direct play stays conservative');
  assert.equal(session.subtitleAsset.format,'srt');
  assert.equal(new URL(session.url).searchParams.get('subtitles'),'none');
  await session.extrasPromise;

  session=await api.playback(item,{srtPlayback:true,subtitle:90,transcode:true,burnSubtitles:true});
  assert.equal(session.subtitleAsset,null);
  assert.equal(new URL(session.url).searchParams.get('subtitles'),'burn');
  await session.extrasPromise;
});
test('Plex sidecar extension resolution preserves SSA metadata but does not render ASS',async()=>{
  const api=new Plex({url:'http://plex.test',token:'token'},'tv-test');
  api.get=async()=>({MediaContainer:{Metadata:[{}]}});
  for(const [codec,suffix,format] of [
    ['srt','srt','srt'],['subrip','srt','srt'],['ass','ass','ass'],['ssa','ssa','ass']
  ]){
    const media=makeMedia('mkv');
    media.Part[0].Stream=[{streamType:3,id:90,codec,
      key:'/library/streams/90?download=1',selected:1}];
    assert.deepEqual(plexExternalSubtitle(media),{
      id:90,format,key:'/library/streams/90.'+suffix+'?download=1'});
    const session=await api.playback({id:'123',raw:{Media:[media]}},
      {srtPlayback:true,assPlayback:true});
    if(format==='srt'){
      const url=new URL(session.subtitleAsset.url);
      assert.equal(url.pathname,'/library/streams/90.'+suffix);
      assert.equal(url.searchParams.get('encoding'),'utf-8');
      assert.equal(url.searchParams.get('download'),'1');
      assert.equal(url.searchParams.get('X-Plex-Token'),'token');
      assert.equal(new URL(session.url).searchParams.get('subtitles'),'none');
    }else{
      assert.equal(session.subtitleAsset,null);
      assert.equal(session.legacyPlexPlayback,true);
      assert.equal(new URL(session.url).searchParams.get('subtitles'),'burn');
    }
    await session.extrasPromise;
  }
  const media=makeMedia();
  media.Part[0].Stream[2].key='/library/streams/90.SRT?download=1';
  assert.equal(plexExternalSubtitle(media).key,'/library/streams/90.SRT?download=1');
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
  const session = await api.playback({id:'456',raw:{Media:[makeMedia(),media]}},
    {srtPlayback:true,assPlayback:true,mediaIndex:1,start:60});
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

test('Plex compatibility burn-in selects the exact embedded SRT/ASS track without an extra decision',async()=>{
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
      return {MediaContainer:{Metadata:[{}]}};
    };
    const session=await api.playback(item,{srtPlayback:true,assPlayback:true,burnSubtitles:true,start:35});
    assert.equal(session.subtitleBurnedIn,true);
    assert.equal(session.start,35);
    assert.deepEqual(requests.slice(0,2).map(call=>[call.path,call.method]),[
      ['/library/parts/55','PUT'],['/library/metadata/123',undefined]
    ]);
    assert.equal(serverSelected,id);
    assert.equal(new URL(session.url).searchParams.get('subtitles'),'burn');
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
    {srtPlayback:true,assPlayback:true,subtitle:92,burnSubtitles:true});
  assert.equal(session.subtitleBurnedIn,true);
  assert.equal(selected,92);
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
    {srtPlayback:true,assPlayback:true,burnSubtitles:true}),/HTTP 503/);
  assert.deepEqual(requests,['/library/parts/55']);
});


test('cross-season track choices preserve enhanced SRT, ASS burn-in and HLS audio preferences',async()=>{
  for (const codec of ['srt','ass']) {
    const episode=(id,season,partId,streamIds)=>({
      id,type:'episode',title:id,duration:120,
      raw:{grandparentRatingKey:'show-1',parentRatingKey:season,Media:[{
        container:'mkv',videoCodec:'h264',audioCodec:'aac',
        Part:[{id:partId,key:'/library/parts/'+partId+'/file.mkv',Stream:[
          {streamType:2,id:streamIds[0],languageCode:'eng',codec:'aac',selected:1},
          {streamType:2,id:streamIds[1],languageCode:'fra',codec:'ac3'},
          {streamType:3,id:streamIds[2],languageCode:'eng',codec,selected:1},
          {streamType:3,id:streamIds[3],languageCode:'spa',codec}
        ]}]
      }]}
    });
    const first=episode('episode-1','season-1',55,[11,12,31,32]);
    // The old French/Spanish IDs now refer to English tracks; carrying an ID
    // instead of the intent would silently select the wrong audio and captions.
    const second=episode('episode-2','season-2',56,[12,42,32,52]);
    const preferences=new EpisodeTrackPreferences();
    const firstTracks=mediaSourceTracks(first);
    preferences.record(first,0,'audio',firstTracks.audio[1]);
    preferences.record(first,0,'subtitle',firstTracks.subtitles[1]);
    const selected=preferences.resolve(second,0,mediaSourceTracks(second));
    assert.deepEqual(selected,{audio:42,subtitle:52});

    const api=new Plex({id:'plex',url:'http://plex.test',token:'token'},'tv-test');
    const requests=[];
    api.get=async(path,params,options)=>{
      requests.push({path,params,options});
      return {MediaContainer:{Metadata:[{}]}};
    };
    const selectedSession=await api.playback(second,{...selected,srtPlayback:true,assPlayback:true});
    assert.equal(!!selectedSession.enhancedPlayback,codec==='srt');
    assert.equal(selectedSession.transcode,true,'multi-audio MKV must use HLS on webOS');
    assert.equal(selectedSession.subtitleAsset?.id||null,codec==='srt'?52:null);
    assert.equal(selectedSession.subtitleAsset?.format||null,codec==='srt'?'srt':null);
    const selectedUrl=new URL(selectedSession.url);
    assert.equal(selectedUrl.searchParams.get('audioStreamID'),'42');
    assert.equal(selectedUrl.searchParams.get('subtitleStreamID'),codec==='srt'?'0':null);
    assert.equal(selectedUrl.searchParams.get('subtitles'),codec==='srt'?'none':'burn');
    const selectedPart=requests.find(request=>request.path==='/library/parts/56');
    assert.equal(selectedPart.params.audioStreamID,42);
    assert.equal(selectedPart.params.subtitleStreamID,52);
    assert.equal(requests.some(request=>request.path.endsWith('/decision')),codec==='srt');
    await selectedSession.extrasPromise;

    requests.length=0;
    const legacy=await api.playback(second,{...selected,srtPlayback:false,assPlayback:false});
    assert.equal(legacy.legacyPlexPlayback,true);
    assert.equal(legacy.subtitleAsset,null);
    const legacyUrl=new URL(legacy.url);
    assert.equal(legacyUrl.searchParams.get('audioStreamID'),'42');
    assert.equal(legacyUrl.searchParams.get('subtitles'),'burn');
    const legacyPart=requests.find(request=>request.path==='/library/parts/56');
    assert.equal(legacyPart.params.audioStreamID,42);
    assert.equal(legacyPart.params.subtitleStreamID,52);
    await legacy.extrasPromise;

    const unrelated={...second,id:'unrelated',
      raw:{...second.raw,grandparentRatingKey:'other-show'}};
    assert.deepEqual(preferences.resolve(unrelated,0,mediaSourceTracks(unrelated)),{});
  }
});
