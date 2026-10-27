import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cardLabels} from '../src/card-labels.js';

test('Plezy episode cards show series headline and season / episode caption',()=>{
  const episode={type:'episode',title:'The Beginning',subtitle:'Example Series',
    raw:{grandparentTitle:'Example Series',parentIndex:2,index:4}};
  assert.deepEqual(cardLabels(episode),{title:'Example Series',subtitle:'S2 E4 · The Beginning'});
  assert.equal(episode.title,'The Beginning'); // Detail and playback remain unchanged.
});
test('Plezy episode captions include specials (season zero) and optional episode index',()=>{
  assert.deepEqual(cardLabels({type:'episode',title:'Special',raw:{grandparentTitle:'Series',parentIndex:0,index:3}}),
    {title:'Series',subtitle:'S0 E3 · Special'});
  assert.deepEqual(cardLabels({type:'episode',title:'Special',raw:{grandparentTitle:'Series',parentIndex:'2'}}),
    {title:'Series',subtitle:'S2 · Special'});
});
test('Episode cards degrade gracefully when numbering or series is missing',()=>{
  assert.deepEqual(cardLabels({type:'episode',title:'Pilot',subtitle:'Series',raw:{grandparentTitle:'Series'}}),
    {title:'Series',subtitle:'Pilot'});
  assert.deepEqual(cardLabels({type:'episode',title:'Pilot',subtitle:'Season 1',raw:{parentIndex:1,index:1}}),
    {title:'Pilot',subtitle:'S1 E1 · Pilot'});
  assert.deepEqual(cardLabels({type:'episode',title:'Pilot',subtitle:'Season 1'}),
    {title:'Pilot',subtitle:'Season 1'});
});
test('Jellyfin episodes follow the same series / caption order as Plex',()=>{
  assert.deepEqual(cardLabels({type:'Episode',title:'Last Stand',subtitle:'Jellyfin Series',
    raw:{SeriesName:'Jellyfin Series',ParentIndexNumber:3,IndexNumber:6}}),
    {title:'Jellyfin Series',subtitle:'S3 E6 · Last Stand'});
});
test('Non-episode cards keep their original title and subtitle',()=>{
  const movie={type:'movie',title:'Movie',subtitle:'2026'};
  const series={type:'show',title:'Series',subtitle:'2020'};
  assert.deepEqual(cardLabels(movie),{title:'Movie',subtitle:'2026'});
  assert.deepEqual(cardLabels(series),{title:'Series',subtitle:'2020'});
});
