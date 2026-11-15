import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chapterIndexAtPosition, chapterSeekTarget} from '../src/chapters.js';
import {plexPlaybackNavigation} from '../src/skip-markers.js';

const chapters = [{start:0,title:'One'}, {start:10,title:'Two'}, {start:20,title:'Three'}];

test('chapter position starts inclusively and ends at the next chapter', () => {
  assert.equal(chapterIndexAtPosition(0,chapters),0);
  assert.equal(chapterIndexAtPosition(9.999,chapters),0);
  assert.equal(chapterIndexAtPosition(10,chapters),1);
  assert.equal(chapterIndexAtPosition(3600,chapters),2);
  assert.equal(chapterIndexAtPosition(-1,chapters),-1);
  assert.equal(chapterIndexAtPosition(12,[{start:0,end:12},{start:15}]),-1);
});

test('previous/next chapter seek uses Plezy’s strict three-second threshold', () => {
  assert.equal(chapterSeekTarget(9.999,chapters,true),10);
  assert.equal(chapterSeekTarget(10,chapters,true),20);
  assert.equal(chapterSeekTarget(20,chapters,true),null);
  assert.equal(chapterSeekTarget(13,chapters,false),0);
  assert.equal(chapterSeekTarget(13.001,chapters,false),10);
  assert.equal(chapterSeekTarget(3,chapters,false),0);
  assert.equal(chapterSeekTarget(0,chapters,false),null);
  assert.equal(chapterSeekTarget(0,[],true),null);
});

test('Plex preserves chapter title, thumbnail and explicit end for its native sheet', () => {
  const nav = plexPlaybackNavigation({duration:120000,Chapter:[
    {title:'Opening',startTimeOffset:0,endTimeOffset:14000,thumb:'/library/metadata/1/chapter.jpg'},
    {title:'Main',startTimeOffset:14000}
  ]});
  assert.deepEqual(nav.chapters,[
    {title:'Opening',start:0,end:14,thumb:'/library/metadata/1/chapter.jpg'},
    {title:'Main',start:14,end:null,thumb:null}
  ]);
  assert.deepEqual(nav.markers,[{type:'intro',start:0,end:14}]);
});

test('Plex uses Chapter.tag, like the upstream playback extras mapper', () => {
  const nav = plexPlaybackNavigation({duration:120000,Chapter:[
    {tag:'Opening',startTimeOffset:0,endTimeOffset:16000},
    {tag:'The story',startTimeOffset:16000}
  ]});
  assert.equal(nav.chapters[0].title,'Opening');
  assert.deepEqual(nav.markers,[{type:'intro',start:0,end:16}]);
});
