// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import {CatalogCache} from '../src/catalog-cache.js';

test('catalog cache reuses recent data, coalesces requests and refreshes after expiry', async () => {
  let now = 100, calls = 0, finish;
  const cache = new CatalogCache({ttl: 50, now: () => now});
  const loader = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const a = cache.get('home', loader);
  const b = cache.get('home', loader);
  assert.strictEqual(a, b);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish([{title:'Recent',items:[]}]);
  const data = await a;
  assert.strictEqual(await cache.get('home', loader), data);
  assert.equal(calls, 1);
  now += 50;
  const c = cache.get('home', loader);
  await Promise.resolve();
  assert.equal(calls, 2);
  finish([]);
  assert.deepEqual(await c, []);
});

test('catalog cache bounds entries by least recent use', async () => {
  const cache = new CatalogCache({maxEntries: 2});
  const calls = {a:0,b:0,c:0};
  const get = key => cache.get(key, () => { calls[key]++; return key; });
  await get('a');
  await get('b');
  await get('a');
  await get('c');
  await get('a');
  await get('b');
  assert.deepEqual(calls, {a:1,b:2,c:1});
});

test('errors are retried, not cached', async () => {
  const cache = new CatalogCache();
  let calls = 0;
  await assert.rejects(cache.get('home', () => { calls++; throw new Error('offline'); }), /offline/);
  assert.equal(await cache.get('home', () => { calls++; return 'online'; }), 'online');
  assert.equal(calls, 2);
});

test('cleared in-flight data cannot overwrite new server or refreshed content', async () => {
  const cache = new CatalogCache();
  let finish;
  const stale = cache.get('browse', () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  cache.clear();
  assert.equal(await cache.get('browse', () => 'new'), 'new');
  finish('old');
  assert.equal(await stale, 'old');
  assert.equal(await cache.get('browse', () => { throw new Error('should be cached'); }), 'new');
});
