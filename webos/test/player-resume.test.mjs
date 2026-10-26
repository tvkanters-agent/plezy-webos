import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Player} from '../src/player.js';

// Exercise the LG source contract without pretending desktop Chromium implements
// the native pipeline. Decoder/network behaviour still requires a real TV.
for (const transcode of [false, true]) {
  test(`LG ${transcode ? 'HLS' : 'direct'} opens at resume position without a second seek`, () => {
    const oldWindow = globalThis.window, oldDocument = globalThis.document;
    const sources = [], operations = [];
    globalThis.window = {PalmSystem: {}};
    globalThis.document = {createElement: () => ({
      attributes: {}, setAttribute(k,v) { this.attributes[k]=v; },
      addEventListener() {}
    })};
    try {
      let currentTime = 0;
      const video = {readyState: 0, seeking: false, duration: 1800, style: {},
        appendChild(source) {sources.push(source);operations.push('source');},
        load() {operations.push('load');},
        get currentTime() {return currentTime;},
        set currentTime(value) {throw new Error('unexpected local seek to '+value);}
      };
      const player = Object.assign(Object.create(Player.prototype), {
        video, generation: 1, initialSeekTarget: 720.125, initialSeekPending: true,
        pendingStart: 720.125, item: {duration: 1800},
        session: {url: 'https://plex.test/video', start: 720.125, transcode},
        showBuffering(show) {operations.push(show ? 'buffering' : 'ready');}
      });
      player.loadSource(player.session);
      assert.deepEqual(operations, ['source','load']);
      assert.equal(sources[0].attributes.src, player.session.url);
      const [mime, option] = sources[0].attributes.type.split(';mediaOption=');
      assert.equal(mime, transcode ? 'application/vnd.apple.mpegurl' : 'video/mp4');
      assert.equal(JSON.parse(decodeURIComponent(option)).option.transmission.playTime.start, 720125);
      assert.equal(player.position(), 720.125, 'startup progress must not overwrite the saved position with zero');
      video.readyState = 1;
      player.resume(); // loadedmetadata must not undo the native start option.
      player.startAfterInitialSeek();
      assert.equal(player.initialSeekPending, true);
      currentTime = 720.125; video.readyState = 2;
      player.resume(); player.startAfterInitialSeek();
      assert.equal(player.initialSeekPending, false);
      assert.equal(player.position(),720.125);
      assert.equal(player.timelineDuration(),1800);
      assert.equal(video.style.visibility,'visible');
    } finally {globalThis.window=oldWindow;globalThis.document=oldDocument;}
  });
}

test('release removes native sources before load, so reopening cannot select an old episode', async () => {
  const operations=[];
  const player=Object.assign(Object.create(Player.prototype), {
    generation:1, session:null, video:{style:{}, currentTime:0,
      pause(){operations.push('pause');}, removeAttribute(){operations.push('remove src');},
      querySelectorAll(){return [{remove(){operations.push('remove source');}}];},
      load(){operations.push('load');}},
    showBuffering(){}, track(){}
  });
  await player.release();
  assert.deepEqual(operations,['pause','remove src','remove source','load']);
});
