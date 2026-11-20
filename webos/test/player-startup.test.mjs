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
    session:first,notify(){throw new Error('A subtitle fallback must be silent');},
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
