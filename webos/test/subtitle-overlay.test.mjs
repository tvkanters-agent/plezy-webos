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
  const ass = {timeOffset:0, setCurrentTime:value => times.push(value)};
  overlay.renderer = ass;
  overlay.kind = 'ass';
  overlay.update(1000);
  assert.equal(ass.timeOffset, -1);
  assert.deepEqual(times, [19]);
  overlay.update(1000);
  assert.equal(times.length, 1, 'libass listens to video timeupdate itself');
  overlay.update(-500);
  assert.equal(ass.timeOffset, 0.5);
  assert.deepEqual(times, [19, 20.5]);
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
  assert.deepEqual(attached.map(entry=>entry.type),['playing','pause','ended','seeking','seeked','loadedmetadata']);
  assert.deepEqual(detached,attached);
  assert.equal(overlay.listeners.length,0);
  assert.equal(destroyed,true);
  assert.equal(element.textContent,'');
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
  assert.equal(typeof callbacks.onReady,'function');
  callbacks.onError(new Error('worker arrived too late'));
  assert.equal(errors,1);
});

test('an ASS worker that calls ready synchronously must not trigger a false fallback',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  t.mock.method(globalThis,'fetch',async()=>({ok:true,text:async()=>
    '[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello\n'}));
  const previousWindow=globalThis.window;
  let paused, rate;
  globalThis.window={SubtitlesOctopus:function(options){
    this.dispose=()=>{};
    this.setIsPaused=(value,time)=>{paused=[value,time];};
    this.setRate=value=>{rate=value;};
    options.onReady();
  }};
  t.after(()=>{globalThis.window=previousWindow;});
  const overlay=new SubtitleOverlay({currentTime:1,paused:false,playbackRate:1.25},{textContent:''});
  let errors=0;
  overlay.onError=()=>{errors++;};
  await overlay.load({url:'http://plex.test/sub.ass',format:'ass'},0);
  t.mock.timers.tick(20000);
  assert.deepEqual(paused,[false,1]);
  assert.equal(rate,1.25);
  assert.equal(errors,0);
  overlay.clear();
});
