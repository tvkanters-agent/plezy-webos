// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import {diskPressure, evictionsForBudget, preferredDiskBudget, quotaRecoveryTarget} from '../src/cache-budget.js';

test('thousands of small entries remain cached while total bytes fit', () => {
  const rows = Array.from({length: 20000}, (_, i) =>
    ({key:'page-'+i,bytes:512,used:i,priority:i === 0}));
  assert.deepEqual(evictionsForBudget(rows, 12 * 1024 * 1024), []);
});

test('byte pressure discards deep-scrolled pages before landing pages regardless of age', () => {
  const rows=[{key:'landing',bytes:100,used:1,priority:true},
    {key:'old-scroll',bytes:100,used:2},
    {key:'new-scroll',bytes:100,used:3},
    {key:'landing-2',bytes:100,used:0,priority:true}];
  assert.deepEqual(evictionsForBudget(rows, 250), ['old-scroll','new-scroll']);
  assert.deepEqual(evictionsForBudget(rows, 100), ['old-scroll','new-scroll','landing-2']);
});

test('disk quota budget is generous without unsupported browser APIs', async () => {
  assert.equal(await preferredDiskBudget(768*1024*1024, .7),768*1024*1024);
});

test('quota retry can reclaim disk space when actual quota is smaller than the fallback', () => {
  assert.equal(quotaRecoveryTarget(100,1000,10),75);
  assert.equal(quotaRecoveryTarget(100,1000,50),50);
  assert.equal(quotaRecoveryTarget(10,1000,32),0);
});

test('storage quota checks are optional on older webOS Chromium engines', async () => {
  assert.equal(await diskPressure(1024*1024*1024),false);
});
