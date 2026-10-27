import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ArtworkCache, ARTWORK_TTL_MS} from '../src/artwork-cache.js';

const blob = () => new Blob(['test'], {type:'image/png'});
test('memory image reuse is synchronous only after decode and expires on schedule', async () => {
  let now = 1000, created = 0;
  const revoked = [];
  const cache = new ArtworkCache({indexedDB:null, now:()=>now,
    urls:{createObjectURL:()=> 'blob:test-'+(++created), revokeObjectURL:url=>revoked.push(url)},
    fetch:async()=>new Response(blob(),{headers:{'content-type':'image/png'}})});
  const key = 'https://plex.test/poster.png';
  assert.equal(cache.peekReady(key), null);
  assert.equal(await cache.resolve(key), 'blob:test-1');
  assert.equal(cache.peekReady(key), null);
  cache.markReady(key);
  assert.equal(cache.peekReady(key), 'blob:test-1');
  now += ARTWORK_TTL_MS + 1;
  assert.equal(cache.peekReady(key), null);
  assert.deepEqual(revoked, ['blob:test-1']);
  assert.equal(await cache.resolve(key), 'blob:test-2');
});
test('simultaneous artwork readers share one network request', async () => {
  let fetches = 0;
  let release;
  const cache = new ArtworkCache({indexedDB:null,
    urls:{createObjectURL:()=> 'blob:poster', revokeObjectURL:()=>{}},
    fetch:()=> { fetches++; return new Promise(resolve=>{release=resolve;}); }});
  const a=cache.resolve('https://plex.test/cover');
  const b=cache.resolve('https://plex.test/cover');
  // Both callers get exactly the same in-flight operation.
  assert.strictEqual(a,b);
  await new Promise(resolve=>setImmediate(resolve));
  release(new Response(blob(),{headers:{'content-type':'image/png'}}));
  assert.equal(await a, 'blob:poster');
  assert.equal(fetches,1);
});
test('unsupported CORS endpoint falls back to direct images without repeating fetches', async () => {
  let fetches = 0;
  const cache = new ArtworkCache({indexedDB:null,
    fetch:async()=>{fetches++; throw new TypeError('CORS');}});
  assert.equal(await cache.resolve('https://plex.test/a'), 'https://plex.test/a');
  assert.equal(await cache.resolve('https://plex.test/b'), 'https://plex.test/b');
  assert.equal(fetches,1);
});
test('too-large images load normally without being retained', async () => {
  let created=0;
  const cache = new ArtworkCache({indexedDB:null,
    urls:{createObjectURL:()=>{created++;return 'blob:unused';},revokeObjectURL:()=>{}},
    fetch:async()=>new Response(new Blob([new Uint8Array(3*1024*1024+1)]),
      {headers:{'content-type':'image/png'}})});
  assert.equal(await cache.resolve('https://plex.test/huge'), 'https://plex.test/huge');
  assert.equal(created,0);
});
