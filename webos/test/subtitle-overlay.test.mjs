import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SubtitleOverlay, subtitleTime} from '../src/subtitles.js';

test('positive subtitle sync offsets delay SRT and ASS relative to video', () => {
  assert.equal(subtitleTime(9, 1500), 7.5);
  assert.equal(subtitleTime(9, -750), 9.75);
  assert.equal(subtitleTime(0.5, 2000), 0);

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
