import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EpisodeTrackPreferences} from '../src/episode-track-preferences.js';
import {savePlexShowTracks} from '../src/plex-show-tracks.js';

const part = (id, streams) => ({id, Stream:streams});
const ass = (id, title) => ({streamType:3, id, codec:'ass', languageCode:'eng', title});
const episode = (id, parts) => ({ratingKey:id, type:'episode', grandparentRatingKey:'series',
  Media:parts.map(p => ({Part:[p]}))});
const origin = episode('1', [part(10,[ass(11,'Signs only'),ass(12,'Full')])]);
const item = {id:'1', type:'episode', raw:origin};
const selected = {id:12, codec:'ass', language:'eng', title:'Full'};

test('sync paginates and uses each edition’s own matching IDs; unmatched parts and other shows are skipped',async()=>{
  const rows = [origin, episode('2',[part(20,[ass(21,'Signs only')]),
      part(30,[ass(32,'Full'),ass(31,'Signs only')])]),
    {...episode('3',[part(40,[ass(41,'Full')])]),grandparentRatingKey:'unrelated'}];
  const offsets=[], writes=[];
  const api={get:async(path,params,options)=>{
    if (options?.method==='PUT') { writes.push([path,params]); return {}; }
    if (path.endsWith('/grandchildren')) {
      const offset=params['X-Plex-Container-Start'];
      offsets.push(offset);
      return {MediaContainer:{offset,totalSize:rows.length,Metadata:rows.slice(offset,offset+2)}};
    }
    return {MediaContainer:{Metadata:[rows.find(row=>path.endsWith('/'+row.ratingKey))]}};
  }};
  const prefs=new EpisodeTrackPreferences();
  prefs.record(item,0,'subtitle',selected,true);
  await prefs.flush((...args)=>savePlexShowTracks(api,...args),()=>true,assert.fail);
  assert.deepEqual(offsets,[0,2]);
  assert.deepEqual(writes,[
    ['/library/parts/10',{subtitleStreamID:12,allParts:0}],
    ['/library/parts/30',{subtitleStreamID:32,allParts:0}]
  ]);
});

test('a newer choice retires the active pass, and an interrupted server save is retried after relaunch',async()=>{
  const data=new Map();
  const storage={getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value)};
  const prefs=new EpisodeTrackPreferences(storage,'account');
  prefs.record(item,0,'subtitle',selected,true);
  let release;
  const delayed=new Promise(resolve=>{release=resolve;});
  const results=[];
  const job=prefs.flush(async(show,choices,current)=>{
    if (!choices.subtitle.off) {
      await delayed;
      assert.equal(current(),false);
    } else {
      results.push('off');
      throw new Error('Plex is offline');
    }
  },()=>true,()=>results.push('failed'));
  prefs.record(item,0,'subtitle',{id:-1},true);
  release();
  await job;
  assert.deepEqual(results,['off','failed']);
  const saved=new EpisodeTrackPreferences(storage,'account');
  await saved.flush(async(show,choices)=>{
    assert.equal(show,'series');
    assert.equal(choices.subtitle.off,true);
    assert.equal(choices.pending.subtitle.id,-1);
    results.push('saved');
  },()=>true,assert.fail);
  await new EpisodeTrackPreferences(storage,'account').flush(assert.fail,()=>true,assert.fail);
  assert.deepEqual(results,['off','failed','saved']);
});
