import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SubtitleOverlay, subtitleTime} from '../src/subtitles.js';

test('positive subtitle sync offsets delay SRT and ASS relative to video', () => {
  assert.equal(subtitleTime(9, 1500), 7.5);
  assert.equal(subtitleTime(9, -750), 9.75);
  assert.equal(subtitleTime(0.5, 2000), -1.5,
    'a delayed cue at zero must remain hidden before its delayed start');

  const overlay = new SubtitleOverlay({currentTime:10}, {textContent:''});
  const srt = {currentTime:0};
  overlay.renderer = srt;
  overlay.kind = 'srt';
  overlay.update(1250);
  assert.equal(srt.currentTime, 8.75);
  overlay.video.currentTime = 20;
  overlay.update(1250);
  assert.equal(srt.currentTime, 18.75, 'SRT follows playback without reparsing on every frame');

  const times = [];
  const ass = {timeOffset:0, setIsPaused:(paused,value) => times.push([paused,value]),setRate:()=>{}};
  overlay.renderer = ass;
  overlay.kind = 'ass';
  overlay.update(1000);
  assert.equal(ass.timeOffset, -1);
  assert.deepEqual(times, [[false,19]]);
  overlay.update(1000);
  assert.equal(times.length, 1, 'libass listens to video timeupdate itself');
  overlay.update(-500);
  assert.equal(ass.timeOffset, 0.5);
  assert.deepEqual(times, [[false,19],[false,20.5]]);
});

test('switching subtitle files releases the previous renderer and pending download', () => {
  const element = {textContent:'old subtitle'};
  const overlay = new SubtitleOverlay({currentTime:0}, element);
  let aborted = false;
  let destroyed = false;
  overlay.abort = {abort:() => {aborted = true;}};
  overlay.renderer = {destroy:() => {destroyed = true;}};
  overlay.clear();
  assert.equal(aborted, true);
  assert.equal(destroyed, true);
  assert.equal(overlay.renderer, null);
  assert.equal(element.textContent, '');
});

test('disabling enhanced playback disposes subtitle video listeners and rendering state',()=>{
  const attached=[];const detached=[];
  const video={
    currentTime:0,
    addEventListener(type,handler){attached.push({type,handler});},
    removeEventListener(type,handler){detached.push({type,handler});}
  };
  const element={textContent:'caption'};
  const overlay=new SubtitleOverlay(video,element);
  let destroyed=false;
  overlay.renderer={destroy(){destroyed=true;}};
  overlay.dispose();
  assert.deepEqual(attached.map(entry=>entry.type),
    ['playing','pause','ended','seeking','waiting','seeked','timeupdate','ratechange','loadedmetadata']);
  assert.deepEqual(detached,attached);
  assert.equal(overlay.listeners.length,0);
  assert.equal(destroyed,true);
  assert.equal(element.textContent,'');
});

test('ASS sync restores video time, paused state and rate immediately after seeking', () => {
  const listeners=new Map();
  const video={currentTime:10,paused:false,ended:false,seeking:false,playbackRate:1,
    addEventListener(type,callback){listeners.set(type,callback);},
    removeEventListener(){}};
  const overlay=new SubtitleOverlay(video,{textContent:''});
  const clocks=[],rates=[];
  overlay.kind='ass';
  overlay.renderer={timeOffset:0,setIsPaused:(paused,time)=>clocks.push([paused,time]),
    setRate:rate=>rates.push(rate),dispose(){}};
  video.seeking=true;
  listeners.get('seeking')();
  assert.deepEqual(clocks.pop(),[true,10]);
  video.currentTime=160;
  video.seeking=false;
  listeners.get('seeked')();
  assert.deepEqual(clocks.pop(),[false,160],
    'seeked must restore playing state, not only send the timestamp');
  listeners.get('waiting')();
  assert.deepEqual(clocks.pop(),[true,160], 'buffering must freeze the worker clock');
  video.currentTime=161;
  listeners.get('timeupdate')();
  assert.deepEqual(clocks.pop(),[false,161], 'decoder progress unfreezes a stalled worker without playing');
  listeners.get('waiting')();
  video.currentTime=150;
  listeners.get('timeupdate')();
  assert.deepEqual(clocks.pop(),[false,150], 'backward decoder progress also releases a stale buffer latch');
  listeners.get('waiting')();
  video.currentTime=170;
  listeners.get('seeked')();
  assert.deepEqual(clocks.pop(),[false,170], 'seeked clears stale buffering even without playing');
  video.paused=true;
  listeners.get('pause')();
  assert.deepEqual(clocks.pop(),[true,170]);
  video.playbackRate=1.25;
  listeners.get('ratechange')();
  assert.equal(rates.pop(),1.25);
  overlay.dispose();
});

test('ASS video seeking invalidates stale pixels before a paused decoder repaints',()=>{
  const callbacks=new Map();
  const video={currentTime:1,paused:true,seeking:false,ended:false,playbackRate:1,
    addEventListener(name,listener){callbacks.set(name,listener);},
    removeEventListener(){}};
  const overlay=new SubtitleOverlay(video,{textContent:''});
  const clears=[];
  overlay.kind='ass';
  overlay.renderer={canvas:{width:640,height:360},
    ctx:{clearRect(...values){clears.push(values);}},
    setIsPaused(){},setRate(){},dispose(){}};
  callbacks.get('timeupdate')();
  assert.equal(clears.length,0,'ordinary playback must not blank ASS');
  video.currentTime=6.5;
  video.seeking=true;
  callbacks.get('seeking')();
  assert.deepEqual(clears,[[0,0,640,360]],
    'seek immediately discards pixels from the previous subtitle timestamp');
  overlay.dispose();
});

test('ASS renderer survives repeated playback of an identical track and font set',async t=>{
  const original=globalThis.window;
  const instances=[];
  class FakeOctopus {
    constructor(options) {
      this.fonts=options.fonts;
      this.canvasParent={style:{}};
      this.canvas={style:{}};
      this.worker={addEventListener(){},removeEventListener(){},postMessage(){}};
      this.setTrackCalls=[];
      instances.push(this);
    }
    setTrack(script){this.setTrackCalls.push(script);}
    setIsPaused(){}
    setRate(){}
    plezySuspendVideo(){this.suspended=true;}
    plezyResumeVideo(){this.suspended=false;}
    dispose(){this.destroyed=true;}
  }
  globalThis.window={SubtitlesOctopus:FakeOctopus};
  t.after(()=>{globalThis.window=original;});
  const video={currentTime:1,paused:true,playbackRate:1};
  const overlay=new SubtitleOverlay(video,{textContent:''});
  const font={name:'font.ttf',bytes:Uint8Array.of(1,2,3)};
  const content='[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,A';
  await overlay.renderStyledAss({fonts:[font]},content,overlay.generation);
  const first=overlay.renderer;
  first._plezyFullyReady=true;
  overlay.clear();
  assert.equal(first.suspended,true);
  assert.equal(first.destroyed,undefined);
  await overlay.renderStyledAss({fonts:[font]},content,overlay.generation);
  assert.equal(overlay.renderer,first);
  assert.deepEqual(first.setTrackCalls,[]);
  assert.equal(first.suspended,false);
  overlay.clear();
  await overlay.renderStyledAss({fonts:[font]},content+'\n',overlay.generation);
  assert.equal(overlay.renderer,first);
  assert.deepEqual(first.setTrackCalls,[content+'\n']);
  overlay.clear();
  await overlay.renderStyledAss({fonts:[{name:'font.ttf',bytes:Uint8Array.of(9,9,9)}]},content,overlay.generation);
  assert.equal(instances.length,2);
  assert.equal(first.destroyed,true,'different fonts must not inherit stale registered faces');
  overlay.dispose();
  assert.equal(instances[1].destroyed,true,'enhanced mode off must release the retained worker');
});

test('a sync adjustment during download supplies the current offset to ASS', async t => {
  let resolveDownload, options;
  const download = new Promise(resolve => { resolveDownload = resolve; });
  t.mock.method(globalThis,'fetch',async () => ({ok:true,text:() => download}));
  const previousWindow = globalThis.window;
  globalThis.window = {SubtitlesOctopus:function (value) {
    options = value;
    this.dispose = () => {};
    this.setCurrentTime = () => {};
  }};
  t.after(() => { globalThis.window = previousWindow; });
  const overlay = new SubtitleOverlay({currentTime:10}, {textContent:''});
  t.after(() => overlay.clear());
  const loading = overlay.load({url:'http://plex.test/sub.ass',format:'ass'},0);
  overlay.update(2500);
  resolveDownload('[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello');
  await loading;
  assert.equal(options.timeOffset,-2.5);
  assert.equal(overlay.offsetMs,2500);
});

test('SRT clock renders between timeupdate events and is cancelled on clear', t => {
  const previousRequest = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  let callback, cancelled = 0;
  globalThis.requestAnimationFrame = next => { callback = next; return 7; };
  globalThis.cancelAnimationFrame = id => { cancelled = id; };
  t.after(() => {
    globalThis.requestAnimationFrame = previousRequest;
    globalThis.cancelAnimationFrame = previousCancel;
  });
  const video = {currentTime:1,paused:false,ended:false,seeking:false};
  const overlay = new SubtitleOverlay(video,{textContent:''});
  overlay.renderer = {currentTime:0,destroy(){}};
  const renderer = overlay.renderer;
  overlay.kind = 'srt';
  overlay.startClock();
  video.currentTime = 1.125;
  callback();
  assert.equal(renderer.currentTime,1.125);
  overlay.clear();
  assert.equal(cancelled,7);
});

test('an ASS worker that never becomes ready reports one render failure and is cancelled on release', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  t.mock.method(globalThis,'fetch',async () => ({ok:true,text:async()=>
    '[Script Info]\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
    'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello\n'}));
  const previousWindow=globalThis.window;
  let callbacks;
  globalThis.window={SubtitlesOctopus:function (options) {
    callbacks=options;
    this.dispose=()=>{};
    this.setCurrentTime=()=>{};
  }};
  t.after(()=>{globalThis.window=previousWindow;});
  const overlay=new SubtitleOverlay({currentTime:1}, {textContent:''});
  let errors=0;
  overlay.onError=()=>{errors++;};
  await overlay.load({url:'http://plex.test/sub.ass',format:'ass'},0);
  t.mock.timers.tick(20000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors,1);
  overlay.clear();
  t.mock.timers.tick(20000);
  assert.equal(errors,1);
  assert.equal(callbacks.onReady,undefined,
    'the first worker log is not a reliable libass-ready signal');
  callbacks.onError(new Error('worker arrived too late'));
  assert.equal(errors,1);
});

test('an ASS worker signals runtime ready before the startup timeout',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  t.mock.method(globalThis,'fetch',async()=>({ok:true,text:async()=>
    '[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello\n'}));
  const previousWindow=globalThis.window;
  const messages=[];
  globalThis.window={SubtitlesOctopus:function(options){
    this.dispose=()=>{};
    this.worker={addEventListener(type,handler){
      queueMicrotask(()=>{
        handler({data:{target:'ready'}});
        handler({data:{target:'get-styles',styles:[]}});
      });
    },removeEventListener(){},postMessage(value){messages.push(value);}};
    this.setIsPaused=()=>{};
    this.setRate=()=>{};
  }};
  t.after(()=>{globalThis.window=previousWindow;});
  const overlay=new SubtitleOverlay({currentTime:1,paused:false,playbackRate:1.25},{textContent:''});
  let errors=0;
  overlay.onError=()=>{errors++;};
  await overlay.load({url:'http://plex.test/sub.ass',format:'ass'},0);
  await new Promise(resolve=>setImmediate(resolve));
  t.mock.timers.tick(20000);
  assert.ok(messages.some(data=>data.target==='video' && data.currentTime===1 &&
    data.isPaused===false && data.rate===1.25));
  assert.equal(errors,0);
  overlay.clear();
});
