import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseBif, bifFrameAt} from '../src/scrub-preview.js';

function bif(images, multiplier = 1000) {
  const tableEnd = 64 + (images.length + 1) * 8;
  const bytes = new Uint8Array(tableEnd + images.reduce((sum, image) => sum + image.length, 0));
  bytes.set([0x89, 0x42, 0x49, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(12, images.length, true);
  view.setUint32(16, multiplier, true);
  let offset = tableEnd;
  images.forEach((image, i) => {
    view.setUint32(64 + i * 8, i * 10, true);
    view.setUint32(64 + i * 8 + 4, offset, true);
    bytes.set(image, offset);
    offset += image.length;
  });
  view.setUint32(64 + images.length * 8, 0xffffffff, true);
  view.setUint32(64 + images.length * 8 + 4, offset, true);
  return bytes;
}

test('Plex BIF selects the last frame at or before the requested seek time', () => {
  const frames = parseBif(bif([[11,12], [21,22,23], [31]]));
  assert.equal(frames.length, 3);
  assert.deepEqual([...bifFrameAt(frames, 0).bytes], [11,12]);
  assert.deepEqual([...bifFrameAt(frames, 19.99).bytes], [21,22,23]);
  assert.deepEqual([...bifFrameAt(frames, 999).bytes], [31]);
});

test('BIF honors the timestamp multiplier and its zero default', () => {
  assert.equal(bifFrameAt(parseBif(bif([[1],[2]], 500)), 5).index, 1);
  assert.equal(bifFrameAt(parseBif(bif([[1],[2]], 0)), 5).index, 0);
});

test('malformed BIF indexes never produce out-of-bounds frame slices', () => {
  const valid = bif([[1,2],[3,4]]);
  assert.equal(parseBif(new Uint8Array(12)), null);
  assert.equal(parseBif(new Uint8Array(valid.length)), null);
  const badCount = valid.slice();
  new DataView(badCount.buffer).setUint32(12, 10000, true);
  assert.equal(parseBif(badCount), null);
  const badOffset = valid.slice();
  new DataView(badOffset.buffer).setUint32(64 + 2 * 8 + 4, 0xffffffff, true);
  assert.equal(parseBif(badOffset).length, 1);
  assert.equal(bifFrameAt(null, 4), null);
});
