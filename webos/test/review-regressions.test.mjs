import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Player} from '../src/player.js';
import {Plex} from '../src/api.js';

test('Plex track selection accepts XML success and still rejects HTTP errors', async t => {
  const api = new Plex({url:'http://plex.test',token:'fixture'},'tv');
  const item = {id:'movie',raw:{Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',
    Part:[{id:'part',key:'/video.mp4',Stream:[]}]}]}};
  let refused = false;
  t.mock.method(globalThis,'fetch',async (url,options) => {
    if (options?.method === 'PUT')
      return new Response('<MediaContainer/>',{status:refused ? 500 : 200,
        headers:{'Content-Type':'application/xml'}});
    return new Response(JSON.stringify({MediaContainer:{Metadata:[{}]}}));
  });
  const session = await api.playback(item,{audio:12,subtitle:-1});
  await session.extrasPromise;
  assert.equal(session.options.audio,12);
  refused = true;
  await assert.rejects(api.playback(item,{audio:12}),/HTTP 500/);
});

test('rapid track restarts merge choices and retain the original playback position', async () => {
  const opens = [];
  const player = Object.assign(Object.create(Player.prototype),{
    item:{id:'episode'},api:{},session:{},options:{start:0},closing:false,
    sheet:{hidden:true},video:{paused:false},position:() => 64,
    open(api,item,options,tracking,focus,playing) {
      opens.push({options,playing});
      this.openIntentPlaying = playing;
      this.session = null; // asynchronous source cleanup is still pending
      return Promise.resolve();
    }
  });
  await player.reopen({audio:12});
  await player.reopen({subtitle:31});
  assert.equal(opens[1].options.audio,12);
  assert.equal(opens[1].options.subtitle,31);
  assert.equal(opens[1].options.start,64);
});

test('a paused viewing remains paused across successive track restarts', async () => {
  const opens = [];
  const player = Object.assign(Object.create(Player.prototype),{
    item:{id:'episode'},api:{},session:{},options:{},closing:false,
    sheet:{hidden:true},video:{paused:true},position:() => 22,
    open(api,item,options,tracking,focus,playing) {
      opens.push(playing);this.openIntentPlaying = playing;this.session = null;
      return Promise.resolve();
    }
  });
  await player.reopen({audio:12});
  await player.reopen({subtitle:31});
  assert.deepEqual(opens,[false,false]);
});

test('subtitle offsets are isolated by server and account as well as item', () => {
  const player = Object.assign(Object.create(Player.prototype),{
    item:{id:'123'},api:{server:{kind:'plex',id:'server',url:'http://one.test',token:'first'}}
  });
  const first = player.subtitleSyncStorageKey();
  player.api.server.url = 'http://two.test';
  assert.notEqual(player.subtitleSyncStorageKey(),first);
  player.api.server.url = 'http://one.test';
  player.api.server.token = 'second';
  assert.notEqual(player.subtitleSyncStorageKey(),first);
});
