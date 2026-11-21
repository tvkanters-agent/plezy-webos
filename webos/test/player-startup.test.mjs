import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Player} from '../src/player.js';
import {Plex} from '../src/api.js';

test('metadata and decoded-but-frozen startup keep the recovery deadline; clock progress clears it',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let expired=0;
  const player=Object.assign(Object.create(Player.prototype),{
    session:{},initialSeekTarget:0,initialSeekPending:false,pendingStart:0,
    video:{readyState:1,currentTime:0,videoWidth:1920},startupComplete:false
  });
  player.startTimeout=setTimeout(()=>expired++,30000);
  player.resume(); // loadedmetadata used to clear this timer
  player.video.readyState=2;player.hasFirstFrame=true;
  player.checkStartupProgress();
  t.mock.timers.tick(30000);
  assert.equal(expired,1);
  player.startTimeout=setTimeout(()=>expired++,30000);
  player.video.currentTime=.25;player.checkStartupProgress();
  assert.equal(player.startupComplete,true);
  t.mock.timers.tick(30000);assert.equal(expired,1);
});
test('paused reopen needs one decoded frame while a resume target stays gated',()=>{
  const player=Object.assign(Object.create(Player.prototype),{
    session:{},initialSeekTarget:125,initialSeekPending:true,pendingStart:0,
    video:{readyState:1,currentTime:125,videoWidth:1920},hasFirstFrame:true,openIntentPlaying:false
  });
  player.checkStartupProgress();assert.notEqual(player.startupComplete,true);
  player.initialSeekPending=false;player.checkStartupProgress();assert.equal(player.startupComplete,true);
});
test('initial-resume ASS prewarm starts the cache before native frames but gates uncached range reads',async()=>{
  const session={subtitleAsset:{format:'ass',partUrl:'http://plex.test/episode.mkv'}};
  const seen=[];
  const player=Object.assign(Object.create(Player.prototype),{
    session,generation:8,enhancedPlaybackActive:true,options:{},
    initialSeekPending:true,initialSeekTarget:125,pendingStart:0,
    subtitleSyncOffsetMs:0,video:{currentTime:0},
    subtitleOverlay:{load:async(asset,offset,position,timing,networkReady)=>{
      seen.push({stage:'cache',asset,position,networkReady});
      await networkReady;
      seen.push({stage:'network'});
    }}
  });
  player.startEmbeddedAssPreload(session,8);
  assert.equal(seen.length,1,'persistent ASS/cache work begins while initial seek is pending');
  assert.equal(seen[0].position,125,'the initial cache preview targets the resume position');
  assert.equal(seen[0].asset,session.subtitleAsset);
  player.scheduleEmbeddedSubtitle();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(seen.length,1,'no MKV range request before the video resumes');
  player.initialSeekPending=false;
  player.video.currentTime=125;
  player.scheduleEmbeddedSubtitle();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(seen.length,2,'decoder readiness releases only the MKV network stage');
  assert.equal(player.assSubtitleNetworkGate,null);
  player.scheduleEmbeddedSubtitle();
  assert.equal(seen.length,2,'the same subtitle is not reloaded');
});

test('an active LG decoder schedules MKV subtitles before the later clock gate, only once', t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const session={subtitleAsset:{partUrl:'http://plex.test/movie.mkv'}};
  let reads=0;
  const player=Object.assign(Object.create(Player.prototype),{
    session,generation:2,enhancedPlaybackActive:true,options:{},
    initialSeekPending:false,pendingStart:0,startupComplete:false,
    loadSubtitleAsset(asset,generation){
      assert.equal(asset,session);assert.equal(generation,2);reads++;
      this.subtitleLoadSession=session;
    }
  });
  player.scheduleEmbeddedSubtitle();
  player.scheduleEmbeddedSubtitle();
  t.mock.timers.tick(199);assert.equal(reads,0);
  t.mock.timers.tick(1);assert.equal(reads,1);
  player.scheduleEmbeddedSubtitle();t.mock.timers.tick(200);
  assert.equal(reads,1,'never read the same track twice after the clock gate');
  player.subtitleLoadSession=null;
  player.scheduleEmbeddedSubtitle();
  player.generation++;
  t.mock.timers.tick(200);assert.equal(reads,1,'old sessions cannot restart extraction');
});
test('early MKV subtitle reads do not bypass resume seeks or compatibility playback',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let reads=0;
  const player=Object.assign(Object.create(Player.prototype),{
    session:{subtitleAsset:{partUrl:'http://plex.test/movie.mkv'}},generation:1,
    enhancedPlaybackActive:true,options:{},initialSeekPending:true,pendingStart:0,
    loadSubtitleAsset(){reads++;}
  });
  player.scheduleEmbeddedSubtitle();t.mock.timers.tick(200);
  player.initialSeekPending=false;player.pendingStart=125;
  player.scheduleEmbeddedSubtitle();t.mock.timers.tick(200);
  player.pendingStart=0;player.enhancedPlaybackActive=false;
  player.scheduleEmbeddedSubtitle();t.mock.timers.tick(200);
  player.enhancedPlaybackActive=true;player.options.skipMatroskaSubtitles=true;
  player.scheduleEmbeddedSubtitle();t.mock.timers.tick(200);
  assert.equal(reads,0);
  // The first decoded frame also exists on an intentionally paused reopen.
  // Don't depend on another 'playing' event that may never arrive.
  player.options.skipMatroskaSubtitles=false;player.pauseAfterOpen=true;
  player.session.subtitleAsset.format='ass';
  player.scheduleEmbeddedSubtitle();t.mock.timers.tick(0);
  assert.equal(reads,1,'ASS starts on the first frame without a 200ms deferral');
});
test('switching enabled SRT and ASS replaces only the overlay; burn-in requires reopening',()=>{
  const api=new Plex({url:'http://plex.test',token:'fixture'},'tv');
  const media={container:'mkv',Part:[{id:55,key:'/library/parts/55/file.mkv',Stream:[
    {streamType:3,id:90,codec:'srt',selected:1},
    {streamType:3,id:91,codec:'ass',selected:0}
  ]}]};
  const item={id:'movie',raw:{Media:[media]}};
  const session={enhancedPlayback:true,subtitleAsset:{id:90,format:'srt'},subtitleBurnedIn:false,
    subtitles:[{id:90,selected:true},{id:91,selected:false}]};
  const prefs={srtPlayback:true,assPlayback:true};
  let clears=0,reads=0,reloads=0;
  const player=Object.assign(Object.create(Player.prototype),{
    api,item,session,options:{},closing:false,generation:1,
    subtitleOverlay:{clear(){clears++;}},preferences:()=>prefs,
    scheduleEmbeddedSubtitle(){reads++;},updateSubtitleSyncControls(){},
    reopen(){reloads++;}
  });
  assert.equal(player.switchLocalSubtitle(91),true);
  assert.equal(player.session,session);
  assert.equal(session.subtitleAsset.format,'ass');
  assert.equal(player.options.subtitle,91);
  assert.deepEqual([clears,reads,reloads],[1,1,0]);
  prefs.assPlayback=false;
  assert.equal(player.switchLocalSubtitle(91),false,'disabled ASS must use Plex burn-in');
  assert.deepEqual([clears,reads,reloads],[1,1,0]);
  assert.equal(player.switchLocalSubtitle(90),true,'enabled SRT can replace ASS without reopening');
  assert.equal(player.switchLocalSubtitle(-1),true,'turning subtitles off needs no video reload');
  assert.equal(session.subtitleAsset,null);
  assert.deepEqual([clears,reads,reloads],[3,2,0]);
});
test('Play rejection without a media error invokes recovery, while autoplay denial waits for a gesture',async()=>{
  for(const name of ['NotSupportedError','NotAllowedError','AbortError']) {
    let failures=0;
    const player=Object.assign(Object.create(Player.prototype),{
      session:{},generation:3,status:{},video:{play:async()=>{throw {name};}},
      failed(){failures++;},showBuffering(){}
    });
    await player.beginVideoPlayback(3);
    assert.equal(failures,name==='NotSupportedError'?1:0,name);
    if(name==='NotAllowedError')assert.match(player.status.textContent,/Press Play/);
  }
});
test('pending native recovery cannot hide HLS errors or duplicate fallback for its old session',async()=>{
  let finish,opens=0;
  const native={transcode:false},hls={transcode:true};
  const player=Object.assign(Object.create(Player.prototype),{
    session:native,status:{},showBuffering(){},reveal(){},clearResumeAfterSeek(){},
    reopen(changes){opens++;assert.deepEqual(changes,{transcode:true});
      return new Promise(resolve=>{finish=resolve;});}
  });
  const pending=player.failed();
  await player.failed();assert.equal(opens,1);
  player.session=hls;await player.failed();
  assert.match(player.status.textContent,/Video could not play/);
  assert.equal(opens,1,'never loop through another HLS restart');
  finish();await pending;assert.equal(player.recoveringSession,null);
});
test('local subtitle failures retry Plex burn-in only once, without toasts or stale restarts',async t=>{
  t.mock.method(console,'warn',()=>{});
  let finish;
  const first={subtitleAsset:{partUrl:'http://plex.test/movie.mkv'},subtitleBurnedIn:false};
  const player=Object.assign(Object.create(Player.prototype),{
    session:first,enhancedPlaybackActive:true,notify(){throw new Error('A subtitle fallback must be silent');},
    reopen(changes){
      assert.deepEqual(changes,{burnSubtitles:true});
      return new Promise(resolve=>{finish=resolve;});
    }
  });
  const pending=player.subtitleFailed(new Error('MKV reader and Plex extraction failed'),first);
  await player.subtitleFailed(new Error('Late worker error'),first);
  assert.equal(typeof finish,'function','only one burn-in retry was started');
  const next={subtitleAsset:null,subtitleBurnedIn:true};
  player.session=next;
  await player.subtitleFailed(new Error('stale source error'),first);
  await player.subtitleFailed(new Error('new session error'),next);
  finish();await pending;
  assert.equal(player.recoveringSession,null);
});
test('compatibility playback cannot trigger subtitle fallback or write subtitle offsets',async()=>{
  const session={subtitleAsset:{partUrl:'http://plex.test/movie.mkv'},subtitleBurnedIn:false};
  const player=Object.assign(Object.create(Player.prototype),{
    session,enhancedPlaybackActive:false,subtitleSyncOffsetMs:0,
    reopen(){throw new Error('Enhanced subtitle recovery must not start');},
    subtitleSyncStorageKey(){throw new Error('Enhanced subtitle storage must not be touched');}
  });
  player.loadSubtitleSyncOffset();
  await player.subtitleFailed(new Error('stray renderer callback'),session);
  player.setSubtitleSyncOffset(400);
  player.applySubtitleSyncOffset();
  assert.equal(player.subtitleSyncOffsetMs,0);
});
test('Matroska source passes MIME and native resume; obsolete source errors are ignored',()=>{
  const oldWindow=globalThis.window,oldDocument=globalThis.document;
  const sources=[];globalThis.window={PalmSystem:{}};
  globalThis.document={createElement:()=>({attributes:{},events:{},
    setAttribute(k,v){this.attributes[k]=v;},addEventListener(k,fn){this.events[k]=fn;}})};
  try {
    let failures=0;
    const session={url:'http://plex.test/file.mkv',transcode:false,mimeType:'video/x-matroska'};
    const player=Object.assign(Object.create(Player.prototype),{
      session,generation:3,initialSeekTarget:125.25,pendingStart:125.25,
      video:{appendChild(s){sources.push(s);},load(){}},failed(){failures++;}
    });
    player.loadSource(session);
    const [mime,encoded]=sources[0].attributes.type.split(';mediaOption=');
    assert.equal(mime,'video/x-matroska');
    assert.equal(JSON.parse(decodeURIComponent(encoded)).option.transmission.playTime.start,125250);
    assert.equal(player.pendingStart,0);
    player.generation++;sources[0].events.error();assert.equal(failures,0);
    player.generation--;sources[0].events.error();assert.equal(failures,1);
  } finally {globalThis.window=oldWindow;globalThis.document=oldDocument;}
});

test('classic Plex HLS resumes at the requested timestamp in the first native buffer',()=>{
  const oldWindow=globalThis.window,oldDocument=globalThis.document;
  const sources=[];globalThis.window={PalmSystem:{}};
  globalThis.document={createElement:()=>({attributes:{},
    setAttribute(k,v){this.attributes[k]=v;},addEventListener(){}})};
  try {
    const session={url:'http://plex.test/start.m3u8',transcode:true,legacyPlexPlayback:true};
    let lateSeeks=0;
    const video={readyState:1,style:{visibility:'hidden'},seeking:false,
      get currentTime(){return this.time || 0;},
      set currentTime(value){this.time=value;lateSeeks++;},
      appendChild(source){sources.push(source);},load(){}};
    const player=Object.assign(Object.create(Player.prototype),{
      session,item:{duration:1200},generation:1,initialSeekTarget:125.25,
      initialSeekPending:true,pendingStart:125.25,
      video,showBuffering(){},update(){},checkStartupProgress(){},
      skipButton:null
    });
    player.loadSource(session);
    const type=sources[0].attributes.type;
    assert.equal(type.split(';mediaOption=')[0],'application/vnd.apple.mpegurl');
    assert.equal(JSON.parse(decodeURIComponent(type.split(';mediaOption=')[1])).option.transmission.playTime.start,
      125250);
    assert.equal(player.pendingStart,0);
    player.resume();
    assert.equal(lateSeeks,0,'never seek after startup has buffered');
    video.readyState=2;
    player.resume();
    assert.equal(lateSeeks,0,'loadeddata must not cause another buffer');
    video.time=125.25; // LG reached the native start timestamp.
    player.startAfterInitialSeek();
    assert.equal(player.initialSeekPending,false);
    assert.equal(video.style.visibility,'visible');
  } finally {globalThis.window=oldWindow;globalThis.document=oldDocument;}
});

test('resume preserves its target when Plex and the HLS decoder omit duration',()=>{
  const player=Object.assign(Object.create(Player.prototype),{
    session:{},item:{duration:0},pendingStart:125.25,initialSeekPending:true,
    initialSeekTarget:125.25,video:{readyState:2,currentTime:0,duration:NaN}
  });
  player.resume();
  assert.equal(player.video.currentTime,125.25);
  assert.equal(player.pendingStart,0);
});

test('both modes send the exact initial timestamp to LG for Plex HLS and direct sources',()=>{
  const oldWindow=globalThis.window,oldDocument=globalThis.document;
  const sources=[];globalThis.window={PalmSystem:{}};
  globalThis.document={createElement:()=>({attributes:{},
    setAttribute(k,v){this.attributes[k]=v;},addEventListener(){}})};
  try {
    for (const [session,target] of [
      [{transcode:true,legacyPlexPlayback:true},125.25],
      [{transcode:true,srtPlayback:true,assPlayback:true},125.25],
      [{transcode:false,legacyPlexPlayback:true},125.25],
      [{transcode:false,srtPlayback:true,assPlayback:true,mimeType:'video/x-matroska'},125.25],
      [{transcode:true,legacyPlexPlayback:true},0],
      [{transcode:true,srtPlayback:true,assPlayback:true},0]
    ]) {
      const video={appendChild(source){sources.push(source);},load(){}};
      const player=Object.assign(Object.create(Player.prototype),{
        session,generation:1,initialSeekTarget:target,pendingStart:target,video
      });
      player.loadSource({...session,url:'http://plex.test/file'});
      const type=sources.at(-1).attributes.type;
      assert.match(type,/;mediaOption=/);
      assert.equal(type.split(';mediaOption=')[0],session.transcode?'application/vnd.apple.mpegurl':
        (session.mimeType || 'video/mp4'));
      assert.equal(JSON.parse(decodeURIComponent(type.split(';mediaOption=')[1])).option.transmission.playTime.start,
        target*1000);
      assert.equal(player.pendingStart,0);
    }
  } finally {globalThis.window=oldWindow;globalThis.document=oldDocument;}
});

test('legacy Plex startup finishes with its first frame without expanded decoder heuristics',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let failures=0;
  const session={legacyPlexPlayback:true,transcode:true};
  const player=Object.assign(Object.create(Player.prototype),{
    session,generation:3,initialSeekPending:false,pendingStart:0,
    hasFirstFrame:true,video:{readyState:1,videoWidth:0,currentTime:125.25},
    failed(){failures++;}
  });
  player.armStartupTimeout();
  player.checkStartupProgress();
  assert.equal(player.startupComplete,true);
  t.mock.timers.tick(30000);
  assert.equal(failures,0,'legacy playback must not fall into a speculative second restart');
});

test('an audio-only clock does not establish a video frame; old startup deadlines cannot fail new sessions',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let failures=0;
  const player=Object.assign(Object.create(Player.prototype),{
    session:{},generation:1,initialSeekTarget:0,video:{currentTime:2,videoWidth:0},
    failed(){failures++;}
  });
  player.checkStartupProgress();assert.notEqual(player.startupComplete,true);
  player.armStartupTimeout();player.generation++;player.session={};
  t.mock.timers.tick(30000);assert.equal(failures,0);
  player.armStartupTimeout();t.mock.timers.tick(30000);assert.equal(failures,1);
});

test('explicit Pause cancels startup deadline and Play rearms it after an autoplay denial',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let failures=0,plays=0;
  const player=Object.assign(Object.create(Player.prototype),{
    session:{},generation:1,startupComplete:false,resumeAfterSeekTarget:null,
    video:{paused:false,pause(){this.paused=true;},play(){plays++;return Promise.resolve();}},
    clearResumeAfterSeek(){},cancelRemoteSeek(){},reveal(){},failed(){failures++;}
  });
  player.armStartupTimeout();player.toggle();
  t.mock.timers.tick(30000);assert.equal(failures,0);
  player.toggle();assert.equal(plays,1);
  t.mock.timers.tick(30000);assert.equal(failures,1);
});

test('a silent native startup failure retains requested Play rather than a paused decoder observation',async()=>{
  let opened;
  const player=Object.assign(Object.create(Player.prototype),{
    session:{},item:{id:'movie'},sheet:{hidden:true},api:{},options:{mediaIndex:1,subtitle:90},
    startupComplete:false,openIntentPlaying:true,video:{paused:true,error:null},position:()=>125,
    open(...args){opened=args;}
  });
  await player.reopen({transcode:true});
  assert.equal(opened[5],true);
  assert.deepEqual(opened[2],{mediaIndex:1,subtitle:90,transcode:true,start:125});
  player.openIntentPlaying=false;
  await player.reopen({transcode:true});assert.equal(opened[5],false,'explicit Pause still wins');
});

test('a hung Plex timeline cannot indefinitely block release and native fallback',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let aborted=false;
  t.mock.method(globalThis,'fetch',(_,options)=>new Promise((resolve,reject)=>{
    options.signal.addEventListener('abort',()=>{
      aborted=true;reject(Object.assign(new Error('aborted'),{name:'AbortError'}));
    });
  }));
  const api=new Plex({url:'http://plex.test',token:'token'},'tv');
  const reporting=api.report({item:{id:'movie',duration:120},sessionId:'session'},'stopped',20);
  t.mock.timers.tick(15000);
  await assert.rejects(reporting,/timed out/);
  assert.equal(aborted,true);
});

test('a dimensionless LG video with a known first frame can finish subtitle startup',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const player=Object.assign(Object.create(Player.prototype),{
    session:{subtitleAsset:{partUrl:'http://plex.test/part.mkv',format:'ass'}},
    video:{videoWidth:0,webkitDecodedFrameCount:0,currentTime:0,readyState:2},
    initialSeekTarget:0,initialSeekPending:false,pendingStart:0,hasFirstFrame:true,
    openIntentPlaying:false,enhancedPlaybackActive:true,options:{},
    loadSubtitleAsset(){this.loaded=true;},
    generation:1
  });
  player.checkStartupProgress();
  assert.equal(player.startupComplete,true);
  t.mock.timers.tick(0);
  assert.equal(player.loaded,true,'native decoders without reported dimensions still load subtitles');
});

test('burn-in resume waits for a frame at the target before loading seek thumbnails once',()=>{
  const session={legacyPlexPlayback:true,subtitleBurnedIn:true};
  const requests=[];
  const player=Object.assign(Object.create(Player.prototype),{
    session,generation:7,initialSeekPending:true,video:{readyState:2},
    loadSeekFrames(...args){requests.push(args);}
  });
  player.checkStartupProgress();
  assert.deepEqual(requests,[]);
  player.initialSeekPending=false;
  player.video.readyState=1;
  player.checkStartupProgress();
  assert.deepEqual(requests,[]);
  player.hasFirstFrame=true;
  player.checkStartupProgress();
  player.checkStartupProgress();
  assert.deepEqual(requests,[[session,7]]);
});

test('scrubbing during burn-in startup requests previews immediately and follows the latest position',async()=>{
  let finish, requests=0;
  const session={legacyPlexPlayback:true,subtitleBurnedIn:true};
  const player=Object.assign(Object.create(Player.prototype),{
    session,generation:1,seeking:true,initialSeekPending:true,root:{hidden:false},
    timelineDuration:()=>100,seekBar:{parentElement:{clientWidth:800}},
    seekTooltip:{classList:{toggle(){}},style:{},querySelector:()=>({})},seekImage:{},
    api:{scrubPreview(){requests++;return new Promise(resolve=>{finish=resolve;});}}
  });
  player.renderSeekPreview(20);
  player.renderSeekPreview(60);
  assert.equal(requests,1);
  player.initialSeekPending=false;
  player.hasFirstFrame=true;
  player.checkStartupProgress();
  const repaints=[];
  player.renderSeekPreview=seconds=>repaints.push(seconds);
  finish(null);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests,1);
  assert.deepEqual(repaints,[60]);
});
