// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import {gridWindowRange} from '../src/grid-window.js';

test('a single page is fully mounted, larger catalogs are bounded', () => {
  assert.deepEqual(gridWindowRange(60,6,0,4), {start:0,end:60,topRows:0,bottomRows:0});
  const range = gridWindowRange(1200,6,0,4);
  assert.equal(range.start,0);
  assert.ok(range.end <= 60);
  assert.equal(range.bottomRows,200-range.end/6);
});
test('moving down only repaints after crossing the focus buffer', () => {
  const initial = gridWindowRange(1200,6,50,3);
  assert.deepEqual(gridWindowRange(1200,6,51,3,initial),initial);
  const moved = gridWindowRange(1200,6,initial.end/6-1,3,initial);
  assert.ok(moved.start > initial.start);
});
test('adding pages adjusts virtual height without remounting existing cards', () => {
  const first = gridWindowRange(300,5,30,3);
  const expanded = gridWindowRange(400,5,30,3,first);
  assert.equal(expanded.start,first.start);
  assert.equal(expanded.end,first.end);
  assert.equal(expanded.bottomRows,first.bottomRows+20);
});
test('last partial row has no spurious bottom spacer', () => {
  const range = gridWindowRange(1001,6,165,4);
  assert.equal(range.end,1001);
  assert.equal(range.bottomRows,0);
});
