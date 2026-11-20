import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AssEventAppender, parseAssEvent} from '../src/ass-events.js';

const header = '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
const first = 'Dialogue: 1,0:02:40.01,0:02:41.01,Signs,,0,0,0,,{\\pos(300,75)}First, sign';
const second = 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Earlier dialogue';

test('incremental ASS events retain style, layer, timing, commas and override tags', () => {
  assert.deepEqual(parseAssEvent(first, new Map([['default',0],['signs',2]]), 15), {
    ReadOrder:15,Layer:1,Start:160010,Duration:1000,Style:2,Name:'',MarginL:0,MarginR:0,
    MarginV:0,Effect:'',Text:'{\\pos(300,75)}First, sign'
  });
});

test('a growing ASS stream appends only newly extracted events and does not replace the track', () => {
  const sent = [];
  let ready;
  const renderer = {video:{currentTime:160.5},timeOffset:-1,
    worker:{postMessage:message=>sent.push(message)},
    getStyles:callback=>{ready=callback;},setCurrentTime:time=>sent.push({target:'video',time})};
  const append = new AssEventAppender(renderer, header + first + '\n');
  append.remember(header + second + '\n' + first + '\n');
  append.remember(header + first + '\n' + second + '\n' + second + '\n');
  assert.equal(sent.length,0,'events wait for the worker to load its initial styles');
  append.ready();
  ready([{_index:0,Name:'Default'},{_index:2,Name:'Signs'}]);
  assert.equal(sent[0].target,'create-events');
  assert.equal(sent[0].events.length,2,'duplicate dialogue lines are counted, not collapsed');
  assert.equal(sent[0].events[0].Text,'Earlier dialogue');
  assert.equal(sent[0].events[1].Text,'Earlier dialogue');
  assert.deepEqual(sent[1],{target:'video',time:159.5});
  append.remember(header + first + '\n' + second + '\n' + second + '\n');
  assert.equal(sent.length,2,'unchanged previews do not repaint');
  append.dispose();
  append.remember(header + first + '\n' + second + '\n' + second + '\n' + first + '\n');
  assert.equal(sent.length,2,'released tracks cannot receive delayed events');
});
