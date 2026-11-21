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
  // A forced refresh deliberately supersedes the coalesced ordinary request.
  const newer = await cache.page('server','browse',()=>['new'],{force:true});
  assert.deepEqual(newer.value,['new']);
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

test('successor cache identity survives first-page order shifts even with equal page lengths', async () => {
  const cache = new PersistentCatalogCache({indexedDB:null});
  const before = {items:[{id:'a'},{id:'b'}],total:4};
  const after = {items:[{id:'new'},{id:'a'}],total:5};
  await cache.page('s','browse:0',()=>before);
  await cache.page('s','browse:2',()=>({items:[{id:'c'},{id:'d'}],total:4}),
    {predecessor:{key:'browse:0',page:before}});
  const refreshed = await cache.page('s','browse:0',()=>after);
  assert.equal((await refreshed.fresh).changed,true);
  await assert.rejects(cache.page('s','browse:2',()=>{throw new Error('Plex 503');},
    {predecessor:{key:'browse:0',page:after}}), /Plex 503/);
  const repaired = await cache.page('s','browse:2',()=>({items:[{id:'b'},{id:'c'}],total:5}),
    {predecessor:{key:'browse:0',page:after}});
  assert.equal(repaired.cached,false);
  const reuse = await cache.page('s','browse:2',()=>repaired.value,
    {predecessor:{key:'browse:0',page:after}});
  assert.equal(reuse.cached,true);
});

test('late successor responses are not saved as belonging to a new predecessor', async () => {
  const cache = new PersistentCatalogCache({indexedDB:null});
  const before = {items:[{id:'0'}],total:3}, after = {items:[{id:'new'}],total:4};
  await cache.page('s','first',()=>before);
  let finish;
  const pending = cache.page('s','second',()=>new Promise(resolve=>{finish=resolve;}),
    {predecessor:{key:'first',page:before}});
  await Promise.resolve();
  const refresh = await cache.page('s','first',()=>after);
  await refresh.fresh;
  finish({items:[{id:'old'}],total:3});
  const old = await pending;
  assert.equal(old.cached,false);
  const next = await cache.page('s','second',()=>({items:[{id:'fresh'}],total:4}),
    {predecessor:{key:'first',page:after}});
  assert.equal(next.cached,false);
  assert.equal(next.value.items[0].id,'fresh');
});

test('a forced successor coalesces only for the same ordered predecessor', async () => {
  const cache = new PersistentCatalogCache({indexedDB:null});
  const older = {items:[{id:'A'}],total:3}, newer = {items:[{id:'B'}],total:4};
  const oldSuccessor = {items:[{id:'old'}],total:3};
  const newSuccessor = {items:[{id:'current'}],total:4};
  const options = page => ({force:true, predecessor:{key:'first',page}});
  await cache.page('s','first',()=>older);
  let finish;
  const pending = cache.page('s','second',() => new Promise(resolve => { finish = resolve; }),
    options(older));
  await cache.page('s','first',()=>newer,{force:true});
  let requests = 0;
  const load = () => { requests++; return newSuccessor; };
  const current = await Promise.all([
    cache.page('s','second',load,options(newer)),
    cache.page('s','second',load,options({...newer}))
  ]);
  assert.equal(requests,1);
  assert.deepEqual(current.map(result => result.value),[newSuccessor,newSuccessor]);
  finish(oldSuccessor);
  await pending;
  const cached = await cache.page('s','second',()=>{throw new Error('Plex 503');},
    {predecessor:{key:'first',page:newer}});
  assert.equal(cached.cached,true);
  assert.deepEqual(cached.value,newSuccessor);
});

test('a successor stamped by an older app version is reloaded', async () => {
  const cache = new PersistentCatalogCache({indexedDB:null});
  const first = {items:[{id:'a'}],total:3};
  await cache.page('s','first',()=>first);
  cache.remember(cache.id('s','second'),{items:[{id:'stale'}],total:3},undefined,false,null,'[2,["a"]]');
  const result = await cache.page('s','second',()=>({items:[{id:'b'}],total:3}),
    {predecessor:{key:'first',page:first}});
  assert.equal(result.cached,false);
  assert.equal(result.value.items[0].id,'b');
});
