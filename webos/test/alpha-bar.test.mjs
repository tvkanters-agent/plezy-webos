// Ported acceptance cases from test/screens/libraries/{alpha_jump_helper,
// alpha_jump_bar}_test.dart and PlexAlphaBarStrategy.shouldShow.
import test from 'node:test';
import assert from 'node:assert/strict';
import {alphaIndex, alphaPageStart, showPlexAlphaBar} from '../src/alpha-bar.js';

const chars = [
  {key:'A', title:'A', size:3},
  {key:'B', title:'B', size:4},
  {key:'C', title:'C', size:2}
];

test('Plex bucket counts map to native cumulative offsets', () => {
  const index = alphaIndex(chars);
  assert.deepEqual(index.letters, ['A','B','C']);
  assert.deepEqual([index.offsets.A,index.offsets.B,index.offsets.C],[0,3,7]);
  assert.deepEqual([0,3,8].map(index.currentLetter), ['A','B','C']);
});
test('descending title sort reverses buckets and offsets', () => {
  const index = alphaIndex(chars,true);
  assert.deepEqual(index.letters,['C','B','A']);
  assert.deepEqual([index.offsets.C,index.offsets.B,index.offsets.A],[0,2,6]);
  assert.deepEqual([0,2,8].map(index.currentLetter),['C','B','A']);
});
test('only populated Plex letters are shown; large scripts retain highest counts in order', () => {
  const alphabet = Array.from({length:28},(_,i)=>({
    title:String.fromCharCode(65+i),size:i%4+1
  }));
  const index = alphaIndex(alphabet);
  const small = index.displayLetters(6);
  assert.equal(small.length,6);
  assert.deepEqual(small.slice().sort((a,b)=>index.letters.indexOf(a)-index.letters.indexOf(b)),small);
});
test('Plex bar threshold follows upstream title-sort/80-item/six-bucket conditions', () => {
  const letters = 'ABCDEF'.split('').map(letter=>({title:letter,size:15}));
  assert.equal(showPlexAlphaBar(80, letters),true);
  assert.equal(showPlexAlphaBar(79, letters),false);
  assert.equal(showPlexAlphaBar(180, letters.slice(0,5)),false);
  assert.equal(showPlexAlphaBar(180, letters, 'recent'),false);
  assert.equal(showPlexAlphaBar(180, letters, 'release'),false);
});
test('sparse jump pages align to rows, including end of large libraries', () => {
  assert.equal(alphaPageStart(0,7,900),0);
  assert.equal(alphaPageStart(150,7,900),126);
  assert.equal(alphaPageStart(895,7,900),882);
  assert.equal(alphaPageStart(150,6,900),120);
});
