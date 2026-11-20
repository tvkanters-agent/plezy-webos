import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AssTrackCache} from '../src/ass-track-cache.js';

function fakeDb() {
  const saved=new Map();
  const db={createObjectStore(){},transaction(){
    const tx={objectStore:()=>({
      put(entry){queueMicrotask(()=>{saved.set(entry.key,entry);tx.oncomplete?.();});},
      get(key){const req={};queueMicrotask(()=>{req.result=saved.get(key);req.onsuccess?.();});return req;}
    })};
    return tx;
  }};
  const factory={open(){
    const req={result:db};
    queueMicrotask(()=>{req.onupgradeneeded?.();req.onsuccess?.();});
    return req;
  }};
  return {factory,saved};
}

test('a reopened MKV gets its complete ASS text and font manifest without range reads',async()=>{
  const {factory}=fakeDb();
  const first=new AssTrackCache(factory);
  const key='plex:part42:1048576:1';
  const script='[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,\u6f22';
  const fonts=[{name:'sign.ttf',length:8192,crc:'cafebabe'}];
  first.put(key,script,fonts);
  await first.persist({key,script,fonts,used:Date.now()});
  const next=new AssTrackCache(factory);
  const restored=await next.get(key);
  assert.equal(restored.key,key);
  assert.equal(restored.script,script);
  assert.deepEqual(restored.fonts,fonts);
  assert.equal(await next.get('plex:different-part:1048576:1'),null);
  assert.equal(await next.get('plex:part42:1048577:1'),null);
});

test('very large tracks are not stored in the on-device ASS cache',async()=>{
  const cache=new AssTrackCache(null);
  cache.put('big','A'.repeat(20*1024*1024),[]);
  assert.equal(await cache.get('big'),null);
});
