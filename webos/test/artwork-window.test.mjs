// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import {artworkWindowCount, artworkWindowStart, shelfWindow} from '../src/artwork-window.js';

test('library page preparation never decodes an entire long page offscreen', () => {
  assert.equal(artworkWindowCount(1140, 700), 30);
  assert.equal(artworkWindowCount(1140, 700, {landscape:true}), 8);
  assert.ok(artworkWindowCount(700, 450) < 60);
});

test('home prewarm skips invisible shelves and horizontally distant cards', () => {
  const shelves=Array.from({length:30}, (_,i)=>({
    items:Array.from({length:100},(_,j)=>({id:i+'-'+j}))
  }));
  const selected=shelfWindow(shelves,800,700);
  assert.equal(selected.length,4*5);
  assert.equal(selected[0].id,'0-0');
  assert.equal(selected[selected.length-1].id,'3-4');
  assert.ok(!selected.some(item=>item.id==='29-0'||item.id==='0-99'));
});

test('alphabet jump prewarms the targeted row rather than offscreen page start',()=>{
  const items=Array.from({length:60},(_,i)=>i);
  const offset=47, columns=5;
  const warmed=items.slice(artworkWindowStart(offset,columns),
    artworkWindowStart(offset,columns)+artworkWindowCount(900,700));
  assert.ok(warmed.includes(offset));
  assert.ok(!warmed.includes(0));
  assert.equal(artworkWindowStart(2,5),0);
});
