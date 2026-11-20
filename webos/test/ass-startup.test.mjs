import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assStartupPreview} from '../src/ass-startup.js';

const heading = '[Script Info]\nPlayResX: 384\nPlayResY: 288\n' +
  '[V4+ Styles]\nFormat: Name, Fontname\nStyle: Signs,EmbeddedFont\n' +
  '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
const line = (order,start,end,body,layer=0) =>
  'Dialogue: '+layer+','+start+','+end+',Signs,,0,0,0,,'+body+' '+order+'\n';

test('a cached ASS track loads active multilayer vector signs before distant events',()=>{
  const script=heading+
    line(1,'0:00:01.00','0:00:05.00','{\\p1}m 0 0 l 20 20')+
    line(2,'0:00:02.00','0:00:05.00','{\\pos(42,12)}Overlay',2)+
    line(3,'0:00:04.00','0:00:06.00','Coming soon')+
    line(4,'0:30:00.00','0:30:06.00','Distant');
  const early=assStartupPreview(script,3,8);
  assert.ok(early);
  assert.ok(early.startsWith(heading),'preserve fonts, styles and exact ASS formatting');
  assert.match(early, /\\p1/);
  assert.match(early,/Overlay 2/);
  assert.match(early,/Coming soon 3/);
  assert.doesNotMatch(early,/Distant 4/);
  assert.ok(early.indexOf('Overlay 2')>early.indexOf('m 0 0 l 20 20'),
    'preserve original script order and sign layering');
});

test('a distant resume position starts with its closest future cue',()=>{
  const script=heading+
    line(1,'0:00:00.00','0:00:02.00','Start')+
    line(2,'0:02:00.00','0:02:04.00','Next')+
    line(3,'0:20:00.00','0:20:02.00','End');
  const chosen=assStartupPreview(script,100,3);
  assert.match(chosen,/Next 2/);
  assert.doesNotMatch(chosen,/Start 1/);
  assert.doesNotMatch(chosen,/End 3/);
});

test('unknown event field layouts use the complete ASS script',()=>{
  const custom=heading.replace('Layer, Start, End','Start, End, Layer');
  assert.equal(assStartupPreview(custom+line(1,'0:00:01.00','0:00:02.00','Test'),1),null);
  assert.equal(assStartupPreview(heading+line(1,'0:00:01.00','0:00:02.00','Only'),1),null);
});
