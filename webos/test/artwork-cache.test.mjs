import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ArtworkCache, artworkCacheKey} from '../src/artwork-cache.js';

const blob = () => new Blob(['test'], {type:'image/png'});
test('memory image reuse is synchronous after decode and never expires by age', async () => {
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
  now += 365 * 24 * 60 * 60 * 1000;
  assert.equal(cache.peekReady(key), 'blob:test-1');
  assert.deepEqual(revoked, []);
  assert.equal(await cache.resolve(key), 'blob:test-1');
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

// Two artwork revisions for the same server URL must never share the same blob.
test('revisioned keys fetch the real URL and refresh only on revision change', async () => {
  let fetches = 0, created = 0;
  const seen = [];
  const cache = new ArtworkCache({indexedDB:null,
    urls:{createObjectURL:()=> 'blob:revision-'+(++created),revokeObjectURL:()=>{}},
    fetch:async url=>{fetches++; seen.push(url);
      return new Response(blob(),{headers:{'content-type':'image/png'}});}});
  const url='https://plex.test/photo/:/transcode?width=320';
  const oldKey=url+'|revision=1';
  const newKey=url+'|revision=2';
  assert.equal(await cache.resolve(oldKey,url),'blob:revision-1');
  assert.equal(await cache.resolve(oldKey,url),'blob:revision-1');
  assert.equal(await cache.resolve(newKey,url),'blob:revision-2');
  assert.equal(fetches,2);
  assert.deepEqual(seen,[url,url]);
});

test('artwork keys ignore client release version but honor server revisions and sizes', () => {
  const base='https://plex.test/photo/:/transcode?X-Plex-Version=1.2.1&width=320&url=poster';
  const upgraded=base.replace('1.2.1','1.2.2');
  assert.equal(artworkCacheKey(base,'9876'),artworkCacheKey(upgraded,'9876'));
  assert.notEqual(artworkCacheKey(base,'9876'),artworkCacheKey(base,'9877'));
  assert.notEqual(artworkCacheKey(base,'9876'),
    artworkCacheKey(base.replace('width=320','width=600'),'9876'));
  assert.equal(artworkCacheKey(base,''),'');
});

test('unversioned artwork reuses memory without reading or writing disk', async () => {
  let opens=0, fetches=0, created=0;
  const cache = new ArtworkCache({
    indexedDB:{open(){opens++;throw new Error('disk is forbidden');}},
    urls:{createObjectURL:()=> 'blob:session-'+(++created),revokeObjectURL:()=>{}},
    fetch:async()=>{fetches++; return new Response(blob(),{headers:{'content-type':'image/png'}});}
  });
  const url='https://plex.test/library/metadata/4/thumb';
  const key='session:'+url;
  assert.equal(await cache.resolve(key,url,false),'blob:session-1');
  cache.markReady(key);
  assert.equal(cache.peekReady(key),'blob:session-1');
  assert.equal(await cache.resolve(key,url,false),'blob:session-1');
  assert.equal(fetches,1);
  assert.equal(opens,0);
});
test('session tracks direct browser-loaded artwork within bounded metadata', () => {
  const cache = new ArtworkCache({indexedDB:null});
  assert.equal(cache.sawDirectImage('http://plex.test/image'),false);
  cache.markDirectImage('http://plex.test/image');
  assert.equal(cache.sawDirectImage('http://plex.test/image'),true);
  for(let i=0;i<514;i++) cache.markDirectImage('http://plex.test/art/'+i);
  assert.equal(cache.sawDirectImage('http://plex.test/image'),false);
  assert.equal(cache.directLoaded.size,512);
});

test('deep scrolling does not evict the first viewport even with hundreds of posters', () => {
  let serial=0;
  const revoked=[];
  const cache=new ArtworkCache({indexedDB:null,memoryBytes:100,
    urls:{createObjectURL:()=> 'blob:key-'+(++serial),
      revokeObjectURL:url=>revoked.push(url)}});
  const tiny=new Blob([new Uint8Array(1)]);
  const landing=Array.from({length:12},(_,i)=>'landing-'+i);
  cache.protect(landing);
  landing.forEach(key=>cache.remember(key,tiny));
  for(let i=0;i<600;i++)cache.remember('scrolled-'+i,tiny);
  assert.deepEqual(landing.map(key=>!!cache.peek(key)),Array(12).fill(true));
  assert.ok(cache.memoryBytes<=100);
  assert.ok(cache.memory.size<=100);
  assert.ok(revoked.length>0);
});

test('compressed artwork memory is limited by bytes, not 128-item entry count', () => {
  let serial=0;
  const cache=new ArtworkCache({indexedDB:null,memoryBytes:1024*1024,
    urls:{createObjectURL:()=> 'blob:key-'+(++serial),revokeObjectURL:()=>{}}});
  for(let i=0;i<350;i++)cache.remember('art-'+i,new Blob([new Uint8Array(1)]));
  assert.equal(cache.memory.size,350);
});

test('protection spans many libraries without discarding first-screen keys by count', () => {
  const cache=new ArtworkCache({indexedDB:null});
  cache.protect(Array.from({length:400},(_,i)=>'photo-'+i));
  assert.equal(cache.protectedKeys.size,400);
  assert.ok(cache.protectedKeys.has('photo-399'));
  assert.ok(cache.protectedKeys.has('photo-0'));
});

test('bitmap pressure releases decoders without revoking compressed artwork', async () => {
  const previous=globalThis.Image, revoked=[];
  let created=0, fetches=0;
  globalThis.Image=class {
    naturalWidth=10; naturalHeight=10;
    set src(value) { queueMicrotask(()=>this.onload()); }
  };
  try {
    const cache=new ArtworkCache({indexedDB:null,decodedBytes:800,memoryBytes:10000,
      urls:{createObjectURL:()=> 'blob:bitmap-'+(++created),revokeObjectURL:url=>revoked.push(url)},
      fetch:async()=>{fetches++;return new Response(blob());}});
    cache.protect(['landing-a','landing-b']);
    await cache.resolve('landing-a','https://media.test/a');
    await cache.resolve('landing-b','https://media.test/b');
    const scrolled=await cache.resolve('scroll','https://media.test/scroll');
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(cache.memory.size,3);
    assert.ok(cache.decodedBytes<=800);
    assert.deepEqual(revoked,[]);
    assert.equal(cache.peekReady('scroll'),scrolled,'recent scrolling must get bitmap RAM too');
    assert.equal(await cache.resolve('landing-a','https://media.test/a'),'blob:bitmap-1');
    assert.equal(fetches,3,'bitmap eviction must not force another download');
    await cache.prewarm(['landing-a']);
    assert.equal(cache.peekReady('landing-a'),'blob:bitmap-1','prewarm redecodes a retained blob');
    assert.equal(fetches,3);
  } finally { globalThis.Image=previous; }
});

test('a temporarily unreachable server can populate artwork again after backoff',async()=>{
  let now=0,requests=0;
  const cache=new ArtworkCache({indexedDB:null,now:()=>now,
    urls:{createObjectURL:()=> 'blob:recovered',revokeObjectURL:()=>{}},
    fetch:async()=>{if(++requests===1)throw new TypeError('disconnected');return new Response(blob());}});
  assert.equal(await cache.resolve('a','https://media.test/a'),'https://media.test/a');
  now=1000;
  assert.equal(await cache.resolve('b','https://media.test/b'),'https://media.test/b');
  now=31000;
  assert.equal(await cache.resolve('c','https://media.test/c'),'blob:recovered');
  assert.equal(requests,2);
});

test('an entry rejected by the compressed budget never returns a revoked URL',()=>{
  const cache=new ArtworkCache({indexedDB:null,memoryBytes:1,
    urls:{createObjectURL:()=> 'blob:evicted',revokeObjectURL:()=>{}}});
  assert.equal(cache.remember('oversized',blob()),null);
});

test('protected landing files cannot starve newly scrolled compressed artwork',()=>{
  let serial=0;
  const cache=new ArtworkCache({indexedDB:null,memoryBytes:12,
    urls:{createObjectURL:()=> 'blob:reserve-'+(++serial),revokeObjectURL:()=>{}}});
  cache.protect(['a','b','c']);
  for(const key of ['a','b','c'])cache.remember(key,blob());
  const scrolled=cache.remember('scroll',blob());
  assert.ok(scrolled);
  assert.equal(cache.peek('scroll'),scrolled);
  assert.ok(cache.memoryBytes<=12);
});
