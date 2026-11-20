import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AssFontCache, fontCacheKey} from '../src/ass-font-cache.js';

test('font identities are series-scoped unless the container provides a checksum', () => {
  assert.notEqual(fontCacheKey('server:show-one','sign.ttf',4096),
    fontCacheKey('server:show-two','sign.ttf',4096));
  assert.equal(fontCacheKey('server:show-one','sign.ttf',4096,'beef'),
    fontCacheKey('server:show-two','SIGN.TTF',4096,'beef'));
});

test('a second player session retrieves persisted font bytes without their source file', async () => {
  const records=new Map();
  const db={createObjectStore(){},transaction(){
    const tx={objectStore:()=>({
      put(entry){queueMicrotask(()=>{records.set(entry.key,entry);tx.oncomplete?.();});},
      get(key){const req={};queueMicrotask(()=>{req.result=records.get(key);req.onsuccess?.();});return req;}
    })};
    return tx;
  }};
  const factory={open(){
    const request={result:db};
    queueMicrotask(()=>{request.onupgradeneeded?.();request.onsuccess?.();});
    return request;
  }};
  const bytes=Uint8Array.from([0,1,2,3,4,5]);
  const first=new AssFontCache(factory);
  first.put('plex:show','sign.ttf',bytes);
  await first.persist(fontCacheKey('plex:show','sign.ttf',6),bytes);
  const second=new AssFontCache(factory);
  assert.deepEqual(await second.get('plex:show','sign.ttf',6),bytes);
  assert.equal(await second.get('plex:other','sign.ttf',6),null);
  assert.equal(await second.get('plex:show','sign.ttf',7),null);
});
