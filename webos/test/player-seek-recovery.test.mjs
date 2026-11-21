import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Player} from '../src/player.js';

function makePlayer(t, changes = {}) {
  let plays = 0;
  const player = Object.assign(Object.create(Player.prototype), {
    generation:1, session:{}, closing:false, pendingStart:0,
    video:{currentTime:20, duration:120, readyState:2, seeking:false, paused:false,
      ended:false, play() { plays++; return Promise.resolve(); }, pause() { this.paused = true; }},
    seekBar:{value:'',setAttribute(){}}, report(){}, update(){}, reveal(){}, showBuffering(){},
    ...changes
  });
  t.after(() => player.clearResumeAfterSeek());
  return {player, plays:() => plays};
}

test('every committed seek requests Play even for an unpaused LG pipeline stuck in seeking', t => {
  const {player,plays} = makePlayer(t);
  player.video.seeking = true;
  player.seekTo(40);
  assert.equal(plays(),1);
  assert.equal(player.resumeAfterSeekTarget,40);
});

test('a seek from paused starts playback instead of inheriting the decoder pause', t => {
  const {player,plays} = makePlayer(t);
  player.video.paused = true;
  player.seekTo(40);
  assert.equal(plays(),1);
  assert.equal(player.resumeAfterSeekTarget,40);
  assert.equal(player.video.currentTime,40);
});

test('confirming a remote preview from paused resumes, but canceling it does not', t => {
  const {player,plays} = makePlayer(t, {
    hideSeekPreview() {}, hideControls() {}
  });
  player.video.paused = true;
  player.remoteSeeking = true;
  player.seeking = true;
  player.seekWasPlaying = false;
  player.seekPreview = 50;
  player.cancelRemoteSeek();
  assert.equal(plays(),0);
  assert.equal(player.video.currentTime,20);

  player.remoteSeeking = true;
  player.seeking = true;
  player.seekWasPlaying = false;
  player.commitSeek();
  assert.equal(plays(),1);
  assert.equal(player.resumeAfterSeekTarget,50);
});

test('Pause during a seek from paused cancels automatic recovery through buffering', t => {
  const {player,plays} = makePlayer(t);
  player.video.paused = true;
  player.seekTo(40);
  assert.equal(plays(),1);
  player.toggle();
  assert.equal(player.video.paused,true);
  assert.equal(player.resumeAfterSeekTarget,null);
  assert.equal(player.pauseAfterOpen,true, 'late playing must be caught after Pause');
  player.video.seeking = false;
  player.resumeAfterSeekLanded = true;
  player.tryResumeAfterSeek();
  assert.equal(plays(),1, 'late decoder readiness must not restart a deliberate pause');

  player.seekTo(60);
  assert.equal(player.pauseAfterOpen,false, 'a new confirmed seek clears the old Pause latch');
  assert.equal(player.openIntentPlaying,true);
  assert.equal(plays(),2);
});

test('Play/Pause during a paused remote preview means Pause, not Play', t => {
  const {player,plays} = makePlayer(t, {hideSeekPreview() {}});
  player.video.paused = true;
  player.remoteSeeking = true;
  player.seeking = true;
  player.seekWasPlaying = false;
  player.toggle();
  assert.equal(plays(),0);
  assert.equal(player.video.paused,true);
  assert.equal(player.remoteSeeking,false);
  assert.equal(player.seeking,false);
});

test('buffering longer than fifteen seconds retains the seek play intent', t => {
  let now = 1000;
  t.mock.method(Date,'now',() => now);
  const {player} = makePlayer(t);
  player.queueResumeAfterSeek(40);
  player.video.paused = true;
  player.video.readyState = 1;
  now += 20000;
  player.tryResumeAfterSeek();
  assert.equal(player.resumeAfterSeekTarget,40);
  assert.equal(player.resumeAfterSeekPlayPending,true);
});

test('seeked HLS keyframe landing outside one second still confirms advancing playback', t => {
  const {player} = makePlayer(t);
  player.queueResumeAfterSeek(40);
  player.resumeAfterSeekLanded = true;
  player.video.currentTime = 37;
  player.tryResumeAfterSeek();
  player.video.currentTime = 37.3;
  player.tryResumeAfterSeek();
  assert.equal(player.resumeAfterSeekTarget,null);
});

test('a new chapter seek supersedes a paused decoder recovery without losing play intent', t => {
  const {player,plays} = makePlayer(t);
  player.seekTo(40);
  player.video.paused = true;
  player.seekTo(60);
  assert.equal(player.resumeAfterSeekTarget,60);
  assert.equal(player.video.currentTime,60);
  assert.equal(plays(),2);
});

test('explicit pause cancels both a pending recovery and an unconfirmed preview', t => {
  const {player} = makePlayer(t);
  player.queueResumeAfterSeek(40);
  player.seekWasPlaying = true;
  player.remoteSeeking = true;
  player.cancelRemoteSeek = function () { this.remoteSeeking = false; };
  player.toggle();
  assert.equal(player.resumeAfterSeekTarget,null);
  assert.equal(player.video.paused,true);
  assert.equal(player.remoteSeeking,false);
});
