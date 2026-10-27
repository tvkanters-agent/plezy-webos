// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import {PersistentCatalogCache, catalogScope} from '../src/persistent-catalog.js';

const server = {kind:'plex',id:'server',url:'http://plex.test',token:'sensitive-token'};
test('scopes distinguish accounts and never embed raw tokens', () => {
  const scope = catalogScope(server);
  assert.ok(!scope.includes('sensitive-token'));
  assert.notEqual(scope, catalogScope({...server,token:'other-token'}));
  assert.notEqual(scope, catalogScope({...server,id:'different'}));
  assert.notEqual(scope, catalogScope({...server,userId:'other-user'}));
});

test('persistent pages show existing data while requesting updates', async () => {
  const cache = new PersistentCatalogCache({indexedDB:null});
  const first = await cache.page('server','browse',()=>({items:[{title:'Old'}],total:1}));
  assert.equal(first.cached,false);
  let finish;
  const stale = await cache.page('server','browse',() => new Promise(resolve => { finish=resolve; }));
  assert.equal(stale.cached,true);
  assert.equal(stale.value.items[0].title,'Old');
  finish({items:[{title:'New'}],total:1});
  const updated = await stale.fresh;
  assert.equal(updated.changed,true);
  assert.equal(updated.value.items[0].title,'New');
  const again = await cache.page('server','browse',()=>({items:[{title:'New'}],total:1}));
  assert.equal(again.cached,true);
  assert.equal((await again.fresh).changed,false);
});

test('offline failure leaves saved metadata available', async () => {
  const cache = new PersistentCatalogCache({indexedDB:null});
  await cache.page('server','browse',()=>[1]);
  const result = await cache.page('server','browse',()=>{throw new Error('offline');});
  assert.deepEqual(result.value,[1]);
  const update = await result.fresh;
  assert.equal(update.changed,false);
  assert.match(update.error.message,/offline/);
  await assert.rejects(cache.page('server','uncached',()=>{throw new Error('offline');}),/offline/);
});

test('forced refresh skips saved data and overwrites it with the live page', async () => {
  const cache = new PersistentCatalogCache({indexedDB:null});
  await cache.page('server','browse',()=>['old']);
  const updated = await cache.page('server','browse',()=>['new'],{force:true});
  assert.equal(updated.cached,false);
  assert.deepEqual(updated.value,['new']);
  assert.deepEqual((await cache.page('server','browse',()=>['new'])).value,['new']);
});

test('newer refresh wins when network responses arrive out of order', async () => {
  const cache = new PersistentCatalogCache({indexedDB:null});
  await cache.page('server','browse',()=>['seed']);
  let older;
  const old = await cache.page('server','browse',()=>new Promise(resolve=>{older=resolve;}));
  const newer = await cache.page('server','browse',()=>['new']);
  assert.equal((await newer.fresh).changed,true);
  older(['old']);
  assert.equal((await old.fresh).changed,false);
  assert.deepEqual((await cache.page('server','browse',()=>['new'])).value,['new']);
});

test('a removed account cannot reuse its in-memory library pages', async () => {
  const cache = new PersistentCatalogCache({indexedDB:null});
  await cache.page('s1','browse',()=>['private']);
  await cache.page('s2','browse',()=>['other']);
  await cache.removeScope('s1');
  const reread = await cache.page('s1','browse',()=>['fresh']);
  assert.equal(reread.cached,false);
  assert.deepEqual((await cache.page('s2','browse',()=>['other'])).value,['other']);
});

test('hundreds of cached pages do not expire just because of entry count', async () => {
  const cache = new PersistentCatalogCache({indexedDB:null,memoryBytes:1024*1024});
  for(let i=0;i<400;i++)await cache.page('same-account','browse:'+i,
    ()=>({items:[{title:'Movie '+i}],total:400}));
  assert.equal(cache.memory.size,400);
  const reused=await cache.page('same-account','browse:0',()=>({items:[],total:0}));
  assert.equal(reused.cached,true);
  assert.equal(reused.value.items[0].title,'Movie 0');
});

test('catalog memory eviction keeps first page before deep-scrolled pages', async () => {
  const cache=new PersistentCatalogCache({indexedDB:null,memoryBytes:256});
  await cache.page('same-account','browse:0',()=>({items:['landing'],total:2000}),
    {priority:true});
  for(let i=1;i<200;i++)await cache.page('same-account','browse:'+i,
    ()=>({items:['scrolled-'+i],total:2000}));
  const first=await cache.page('same-account','browse:0',
    ()=>({items:[],total:0}),{priority:true});
  assert.equal(first.cached,true);
  assert.equal(first.value.items[0],'landing');
  assert.ok(cache.memoryBytes<=256);
});

test('overlapping page readers share one request without losing background updates', async () => {
  const cache = new PersistentCatalogCache({indexedDB:null});
  await cache.page('s','page',()=>['old']);
  let release, requests=0;
  const loader=()=>{requests++;return new Promise(resolve=>{release=resolve;});};
  const [a,b]=await Promise.all([
    cache.page('s','page',loader),cache.page('s','page',loader)
  ]);
  assert.equal(requests,1);
  assert.deepEqual(a.value,['old']);
  assert.deepEqual(b.value,['old']);
  release(['new']);
  assert.equal((await a.fresh).changed,true);
  assert.deepEqual((await b.fresh).value,['new']);
  assert.deepEqual(cache.memory.get(cache.id('s','page')).data,['new']);
});

test('force refresh replaces a pending ordinary request, and logout cannot restore it', async () => {
  const cache = new PersistentCatalogCache({indexedDB:null});
  await cache.page('s','page',()=>['seed']);
  let oldResolve;
  const older=await cache.page('s','page',()=>new Promise(resolve=>{oldResolve=resolve;}));
  const forced=await cache.page('s','page',()=>['forced'],{force:true});
  assert.deepEqual(forced.value,['forced']);
  oldResolve(['late']);
  assert.equal((await older.fresh).changed,false);
  assert.deepEqual(cache.memory.get(cache.id('s','page')).data,['forced']);
  let abandoned;
  const pending=await cache.page('s','page',()=>new Promise(resolve=>{abandoned=resolve;}));
  await cache.removeScope('s');
  abandoned(['discarded']);
  assert.equal((await pending.fresh).changed,false);
  assert.deepEqual((await cache.page('s','page',()=>['next'])).value,['next']);
});
