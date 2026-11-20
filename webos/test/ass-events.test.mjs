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

test('paused ASS event imports force a redraw after the worker installs the events',()=>{
  const sent=[];
  let stylesReply;
  const renderer={video:{currentTime:6.5,paused:true,seeking:false},timeOffset:0,
    worker:{postMessage:msg=>sent.push(msg)},
    getStyles:fn=>{stylesReply=fn;},
    setCurrentTime:time=>sent.push({target:'video',time})};
  const appender=new AssEventAppender(renderer,header+first+'\n');
  appender.remember(header+first+'\n'+second+'\n');
  appender.ready();
  stylesReply([{Name:'Default',_index:0},{Name:'Signs',_index:2}]);
  assert.deepEqual(sent.map(msg=>msg.target),
    ['create-events','video','plezy-force-frame'],
    'paused redraw must receive the new subtitle time before forcing a frame');
  appender.dispose();
});

test('the fully initialized worker style reply installs pending events without a premature second query',()=>{
  const sent=[];
  const renderer={video:{currentTime:1.5,paused:false},timeOffset:0,
    worker:{postMessage:message=>sent.push(message),
      addEventListener(){throw new Error('Styles were already supplied');}},
    setCurrentTime:time=>sent.push({target:'video',time})};
  const appender=new AssEventAppender(renderer,header+first+'\n');
  appender.remember(header+first+'\n'+second+'\n');
  assert.deepEqual(sent,[],'no event import while the worker is booting');
  appender.ready([{Name:'Default',_index:0},{Name:'Signs',_index:2}]);
  assert.deepEqual(sent.map(msg=>msg.target),['create-events','video']);
  assert.equal(sent[0].events[0].Text,'Earlier dialogue');
  appender.ready();
  assert.equal(sent.length,2,'initialization must be idempotent');
  appender.dispose();
});

test('long ASS streams import events near the resume or seek timestamp first',()=>{
  const sent=[];
  const renderer={video:{currentTime:125.5,paused:false,seeking:false},timeOffset:0,
    worker:{postMessage:message=>sent.push(message)},
    setCurrentTime:time=>sent.push({target:'video',time})};
  const headerScript=header+first+'\n';
  const distant='Dialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,Distant';
  const resumed='Dialogue: 0,0:02:05.00,0:02:12.00,Default,,0,0,0,,Resume subtitle';
  const seeking='Dialogue: 0,0:03:40.00,0:03:41.00,Default,,0,0,0,,Seek subtitle';
  const appender=new AssEventAppender(renderer,headerScript,125.5);
  appender.remember(headerScript+distant+'\n'+seeking+'\n'+resumed+'\n');
  appender.ready([{Name:'Default',_index:0},{Name:'Signs',_index:2}]);
  assert.equal(sent[0].events[0].Text,'Resume subtitle');
  assert.deepEqual(sent[0].events.slice(1).map(event=>event.Text),
    ['Distant','Seek subtitle']);
  appender.dispose();

  const next=new AssEventAppender(renderer,headerScript,125.5);
  next.remember(headerScript+distant+'\n'+resumed+'\n'+seeking+'\n');
  next.prioritize(220.5);
  sent.length=0;
  next.ready([{Name:'Default',_index:0},{Name:'Signs',_index:2}]);
  assert.equal(sent[0].events[0].Text,'Seek subtitle',
    'a seek overtakes unrelated unimported vector-sign events');
  next.dispose();
});
