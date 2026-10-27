// Ported acceptance cases from test/media/media_source_info_test.dart and
// lib/services/jellyfin_media_info_mapper.dart.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {plexPlaybackNavigation, jellyfinPlaybackNavigation} from '../src/skip-markers.js';

test('Plex native markers retain full-title millisecond ranges', () => {
  const nav = plexPlaybackNavigation({duration:120000, Marker:[
    {type:'intro',startTimeOffset:5000,endTimeOffset:20000},
    {type:'credits',startTimeOffset:98000,endTimeOffset:120000}
  ]});
  assert.deepEqual(nav.markers, [{type:'intro',start:5,end:20},{type:'credits',start:98,end:120}]);
});
test('Plex chapters fill missing intro; native marker wins unless fallback forced', () => {
  const raw = {duration:120000,
    Chapter:[{title:'Opening',startTimeOffset:0,endTimeOffset:14000},
      {title:'Middle',startTimeOffset:14000,endTimeOffset:100000},
      {title:'Credits',startTimeOffset:100000,endTimeOffset:120000}],
    Marker:[{type:'intro',startTimeOffset:1000,endTimeOffset:9000}]};
  assert.deepEqual(plexPlaybackNavigation(raw).markers, [
    {type:'intro',start:1,end:9},{type:'credits',start:100,end:120}]);
  assert.deepEqual(plexPlaybackNavigation(raw,{forceSkipMarkerFallback:true}).markers, [
    {type:'intro',start:0,end:14},{type:'credits',start:100,end:120}]);
});
test('long opening chapter and early credits title are not false skip prompts', () => {
  const nav=plexPlaybackNavigation({duration:900000,
    Chapter:[{title:'Opening Credits',startTimeOffset:0,endTimeOffset:400000},
      {title:'Action',startTimeOffset:400000,endTimeOffset:800000},
      {title:'Closing Day',startTimeOffset:800000,endTimeOffset:850000}]});
  assert.equal(nav.markers.length,0);
});
test('unknown PMS marker types are reclassified using Plezy chapter patterns', () => {
  const nav=plexPlaybackNavigation({duration:120000,
    Marker:[{type:'Introduction',startTimeOffset:0,endTimeOffset:14000}]});
  assert.deepEqual(nav.markers,[{type:'intro',start:0,end:14}]);
});
test('Jellyfin uses native segments and falls back to chapters for Emby', () => {
  const raw={RunTimeTicks:1200000000,Chapters:[
    {Name:'Intro',StartPositionTicks:0},{Name:'Story',StartPositionTicks:150000000},
    {Name:'Ending',StartPositionTicks:1000000000}]};
  assert.deepEqual(jellyfinPlaybackNavigation(raw,{Items:[{Type:'Intro',StartTicks:10000000,EndTicks:140000000}]}).markers,[
    {type:'intro',start:1,end:14},{type:'credits',start:100,end:120}]);
  assert.deepEqual(jellyfinPlaybackNavigation(raw).markers,[
    {type:'intro',start:0,end:15},{type:'credits',start:100,end:120}]);
});
test('custom patterns match one type and blank patterns use safe defaults', () => {
  const raw={duration:120000,Chapter:[{title:'OP 2',startTimeOffset:0,endTimeOffset:15000},
    {title:'Middle',startTimeOffset:15000,endTimeOffset:120000}]};
  assert.equal(plexPlaybackNavigation(raw,{introPattern:'^foo$'}).markers.length,0);
  assert.equal(plexPlaybackNavigation(raw,{introPattern:' '}).markers[0].type,'intro');
});
