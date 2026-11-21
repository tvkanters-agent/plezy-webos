import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Plex} from '../src/api.js';

const server = {url:'https://plex.test/prefix',token:'token',kind:'plex'};
const item = {id:'42'};
const createPlex = () => new Plex(server,'device');

test('Plex watched and rating operations accept XML/empty success without parsing JSON', async t => {
  const calls = [];
  t.mock.method(globalThis,'fetch',async (url,options) => {
    calls.push({url:new URL(url),options});
    return calls.length % 2
      ? new Response('<MediaContainer/>',{status:200,headers:{'Content-Type':'application/xml'}})
      : new Response('',{status:200});
  });
  const plex = createPlex();
  await plex.watched(item,true);
  await plex.watched(item,false);
  assert.equal(await plex.rate(item,7.5),true);
  assert.equal(await plex.rate(item,-1),true);
  assert.deepEqual(calls.map(call => call.url.pathname),[
    '/prefix/:/scrobble','/prefix/:/unscrobble','/prefix/:/rate','/prefix/:/rate'
  ]);
  assert.deepEqual(calls.map(call => call.options.method),['GET','GET','PUT','PUT']);
  assert.deepEqual(calls.map(call => call.url.searchParams.get('rating')),[null,null,'7.5','-1']);
  for (const call of calls) {
    assert.equal(call.url.searchParams.get('key'),'42');
    assert.equal(call.url.searchParams.get('identifier'),'com.plexapp.plugins.library');
    assert.ok(call.options.signal,'request must install a cancellation signal');
  }
});

test('Plex watched and rating actions reject HTTP errors with status and allow retry', async t => {
  let status = 503;
  t.mock.method(globalThis,'fetch',async () => new Response('',{status}));
  const plex = createPlex();
  await assert.rejects(plex.watched(item,true),error => error.status === 503);
  status = 403;
  await assert.rejects(plex.watched(item,false),error => error.status === 403);
  status = 500;
  await assert.rejects(plex.rate(item,8),error => error.status === 500);
  status = 200;
  await plex.watched(item,true);
  assert.equal(await plex.rate(item,8),true);
  await assert.rejects(plex.rate(item,11),/Invalid Plex rating/);
});

test('stalled Plex watched and rating requests time out and can be retried', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let stalled = true, requests = 0;
  t.mock.method(globalThis,'fetch',(url,options) => {
    requests++;
    if (!stalled) return Promise.resolve(new Response('',{status:200}));
    return new Promise((resolve,reject) => {
      options.signal.addEventListener('abort',() =>
        reject(new DOMException('aborted','AbortError')),{once:true});
    });
  });
  const plex = createPlex();
  const watched = plex.watched(item,true);
  t.mock.timers.tick(15000);
  await assert.rejects(watched,/Request cancelled or timed out/);
  const rating = plex.rate(item,8);
  t.mock.timers.tick(15000);
  await assert.rejects(rating,/Request cancelled or timed out/);
  stalled = false;
  await plex.watched(item,false);
  assert.equal(await plex.rate(item,8),true);
  assert.equal(requests,4);
});

test('Next Episode does not jump past an episode after the old 1,000-item scan boundary', async t => {
  const all = Array.from({length:1100},(_,index) => ({
    ratingKey:'ep'+(index+1),type:'episode',title:'Episode '+(index+1),
    index:index+1,parentRatingKey:'s1',grandparentRatingKey:'series',parentIndex:1
  }));
  const starts = [];
  t.mock.method(globalThis,'fetch',async url => {
    const request = new URL(url);
    assert.equal(request.pathname,'/prefix/library/metadata/s1/children',
      'a following season must not be requested before the current one is exhausted');
    const start = Number(request.searchParams.get('X-Plex-Container-Start'));
    const size = Number(request.searchParams.get('X-Plex-Container-Size'));
    starts.push(start);
    assert.equal(size,60);
    return new Response(JSON.stringify({MediaContainer:{
      Metadata:all.slice(start,start+size),totalSize:all.length
    }}));
  });
  const result = await createPlex().nextEpisode({type:'episode',raw:all[1019]});
  assert.equal(result.id,'ep1021');
  assert.equal(starts.at(-1),1080);
  assert.equal(starts.length,19,'scan each server page once and stop at the reported total');
});

test('Plex children pagination advances through short pages and missing episode numbers', async t => {
  const all = [1,3,8,9,20].map(index => ({
    ratingKey:'ep'+index,type:'episode',index,parentRatingKey:'s1',grandparentRatingKey:'series'
  }));
  const starts = [];
  t.mock.method(globalThis,'fetch',async url => {
    const start = Number(new URL(url).searchParams.get('X-Plex-Container-Start'));
    starts.push(start);
    return new Response(JSON.stringify({MediaContainer:{
      Metadata:all.slice(start,start+2),totalSize:all.length
    }}));
  });
  const result = await createPlex().nextEpisode({type:'episode',raw:all[0]});
  assert.equal(result.id,'ep3');
  assert.deepEqual(starts,[0,2,4]);
});

test('Plex children pagination stops when the server returns an empty page', async t => {
  let calls = 0;
  t.mock.method(globalThis,'fetch',async () => {
    calls++;
    return new Response(JSON.stringify({MediaContainer:{Metadata:[],totalSize:1100}}));
  });
  assert.deepEqual(await createPlex().episodeChildren('s1'),[]);
  assert.equal(calls,1);
});
