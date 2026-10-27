import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CONTENT_FADE_DELAY_MS, fadeDelayedContent} from '../src/content-entrance.js';

test('fast content remains immediately visible without an animation class', () => {
  const names = [];
  const node = {classList:{add: name => names.push(name)}};
  assert.equal(fadeDelayedContent(node, 1000, 1000 + CONTENT_FADE_DELAY_MS - 1), node);
  assert.deepEqual(names, []);
});

test('late content gets a single container-level fade class', () => {
  const names = [];
  const node = {classList:{add: name => names.push(name)}};
  assert.equal(fadeDelayedContent(node, 1000, 1000 + CONTENT_FADE_DELAY_MS), node);
  assert.deepEqual(names, ['content-enter']);
});
