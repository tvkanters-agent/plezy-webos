import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Player} from '../src/player.js';

// Native Plezy uses mpv's paused-for-cache property. In the HTML video port,
// neither stalled (network inactivity) nor waiting alone means playback is
// blocked: the decoder may still have frames, be paused, or already be at EOF.
function makePlayer() {
  const callbacks = new Map();
  const video = {
    readyState: 4, seeking: false, paused: false, ended: false,
    currentTime: 30, duration: 120,
    addEventListener(type, callback) { callbacks.set(type, callback); },
    emit(type) { callbacks.get(type)(); }
  };
  const buffering = {
    hidden: true, style: {}, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; }
  };
  const dummy = () => ({addEventListener() {}, classList: {contains() {return false;}},
    querySelector() {return null;}});
  const root = {hidden: false, addEventListener() {}, querySelector(selector) {
    if (selector === 'video') return video;
    if (selector === '.player-buffering') return buffering;
    return dummy();
  }};
  const oldDocument = globalThis.document;
  globalThis.document = {addEventListener() {}};
  let player;
  try { player = new Player(root, () => {}, () => {}); }
  finally { globalThis.document = oldDocument; }
  player.session = {};
  player.hasFirstFrame = true;
  // These methods are unrelated to the buffering decisions under test.
  player.update = () => {};
  player.resume = () => {};
  player.startAfterInitialSeek = () => {};
  player.reveal = () => {};
  player.report = () => {};
  player.track = () => {};
  return {player, video, buffering};
}

test('network stall while frames remain buffered does not show a spinner', () => {
  const {video, buffering} = makePlayer();
  video.emit('stalled');
  video.emit('waiting');
  assert.equal(buffering.hidden, true);
  video.readyState = 2;
  video.emit('waiting');
  assert.equal(buffering.hidden, false, 'a genuinely starved, playing decoder does need the spinner');
});

test('pausing clears a stall and suppresses late waiting and stalled events', () => {
  const {video, buffering} = makePlayer();
  video.readyState = 2;
  video.emit('waiting');
  assert.equal(buffering.hidden, false);
  video.paused = true;
  video.emit('pause');
  assert.equal(buffering.hidden, true);
  video.readyState = 1;
  video.emit('waiting');
  video.emit('stalled');
  assert.equal(buffering.hidden, true);
});

test('end-of-file events cannot restart a spinner during credits', () => {
  const {player, video, buffering} = makePlayer();
  video.readyState = 1;
  video.currentTime = 119.95;
  video.emit('stalled');
  video.emit('waiting');
  assert.equal(buffering.hidden, true);
  video.currentTime = 115;
  video.ended = true;
  video.emit('waiting');
  assert.equal(buffering.hidden, true);
  video.ended = false;
  player.showBuffering(true);
  video.currentTime = 120;
  video.emit('timeupdate');
  assert.equal(buffering.hidden, true, 'a late EOF timeupdate also clears old buffering');
});

test('paused seek preview waits for seeked, not a new playing event', () => {
  const {player, video, buffering} = makePlayer();
  video.paused = true;
  video.readyState = 1;
  video.seeking = true;
  video.emit('seeking');
  assert.equal(buffering.hidden, false);
  video.emit('pause');
  assert.equal(buffering.hidden, false, 'do not clear an active frame-preview seek');
  video.seeking = false;
  video.emit('seeked');
  assert.equal(buffering.hidden, true, 'a paused seek may never fire playing');

  player.initialSeekPending = true;
  player.showBuffering(true);
  video.emit('pause');
  video.emit('seeked');
  assert.equal(buffering.hidden, false, 'startup still waits for the initial frame');
});
