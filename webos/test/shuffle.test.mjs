import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Plex} from '../src/api.js';
import {shuffledEpisode} from '../src/shuffle.js';

const server = {url:'https://plex.test/prefix',token:'token',kind:'plex'};
const plex = () => new Plex(server,'device');

test('series Shuffle scans all season and episode pages before choosing a playable episode', async t => {
  const episodes = Array.from({length:65},(_,i) => ({
    ratingKey:'s2e'+(i+1),type:'episode',title:'Episode '+(i+1)
  }));
  const rows = {
    show:[{ratingKey:'s1',type:'season'},{ratingKey:'s2',type:'season'}],
    s1:[{ratingKey:'s1e1',type:'episode'}],
    s2:episodes
  };
  const calls = [];
  t.mock.method(globalThis,'fetch',async url => {
    const request = new URL(url);
    const match = /^\/prefix\/library\/metadata\/([^/]+)\/children$/.exec(request.pathname);
    assert.ok(match,'only fetch children of the show or its seasons');
    const parent = match[1];
    const start = Number(request.searchParams.get('X-Plex-Container-Start'));
    const size = Number(request.searchParams.get('X-Plex-Container-Size'));
    assert.equal(size,60);
    calls.push([parent,start]);
    return new Response(JSON.stringify({MediaContainer:{
      Metadata:rows[parent].slice(start,start+size),totalSize:rows[parent].length
    }}));
  });
  const chosen = await shuffledEpisode(plex(),{id:'show',type:'show'},()=>true,()=>0);
  assert.equal(chosen.id,'s2e65');
  assert.deepEqual(calls,[['show',0],['s1',0],['s2',0],['s2',60]]);
});

test('season Shuffle stays in the selected season, even with sibling seasons present', async () => {
  const calls = [];
  const api = {children:async (id,start,kind) => {
    calls.push([id,start,kind]);
    return {items:[{id:'s1e1',type:'Episode'},{id:'s1e2',type:'episode'}],total:2};
  }};
  const chosen = await shuffledEpisode(api,{id:'s1',type:'Season'},()=>true,()=>0);
  assert.equal(chosen.id,'s1e2');
  assert.deepEqual(calls,[['s1',0,'Season']]);
});

test('Shuffle skips empty seasons and reports no playable episode only for empty shows', async () => {
  const calls = [];
  const api = {children:async id => {
    calls.push(id);
    return id === 'show'
      ? {items:[{id:'empty',type:'season'}],total:1}
      : {items:[],total:0};
  }};
  assert.equal(await shuffledEpisode(api,{id:'show',type:'show'}),null);
  assert.deepEqual(calls,['show','empty']);
  assert.equal(await shuffledEpisode({children:async () => ({items:[],total:0})},
    {id:'empty-show',type:'show'}),null);
});

test('Shuffle stops requesting season pages and never selects an episode after navigation', async () => {
  let resolvePending, requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  const calls = [];
  let current = true;
  const api = {children:async id => {
    calls.push(id);
    if (id === 'show') return {items:[
      {id:'s1',type:'season'},{id:'s2',type:'season'}],total:2};
    if (id === 's1') {
      requestStarted();
      return new Promise(resolve => { resolvePending = resolve; });
    }
    throw new Error('A cancelled Shuffle must not request the next season');
  }};
  const selection = shuffledEpisode(api,{id:'show',type:'show'},()=>current);
  await started;
  current = false;
  resolvePending({items:[{id:'s1e1',type:'episode'}],total:1});
  assert.equal(await selection,null);
  assert.deepEqual(calls,['show','s1']);
});

test('Shuffle can select episodes returned directly by a Jellyfin show', async () => {
  const api = {children:async () => ({
    items:[{id:'one',type:'Episode'},{id:'two',type:'Episode'}],total:2
  })};
  assert.equal((await shuffledEpisode(api,{id:'show',type:'Series'},()=>true,()=>0)).id,'two');
});
