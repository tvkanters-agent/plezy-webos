import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cueRuns,cueIndex,activeCues,PixiSrtRenderer} from '../src/pixi-subtitles.js';

test('inline SRT emphasis, HTML entities and explicit line breaks are rendered as text',()=>{
  assert.deepEqual(cueRuns('<b>Bold</b> &amp; <i>italic</i><br>Next &lt;3'),[
    [{text:'Bold',bold:true,italic:false},{text:' & ',bold:false,italic:false},
      {text:'italic',bold:false,italic:true}],
    [{text:'Next <3',bold:false,italic:false}]
  ]);
  assert.deepEqual(cueRuns('<img src="file:///oops">\n&amp;'),[[],[{text:'&',bold:false,italic:false}]],
    'untrusted subtitle markup never becomes DOM or graphics');
});

test('cue clock finds overlapping intervals and does not include ended cues',()=>{
  const a={startTime:10,endTime:14},b={startTime:11,endTime:12},c={startTime:13,endTime:15};
  const index=cueIndex({cues:[c,a,b]});
  assert.deepEqual(activeCues(index,9.99),[]);
  assert.deepEqual(activeCues(index,11.5),[a,b]);
  assert.deepEqual(activeCues(index,12),[a]);
  assert.deepEqual(activeCues(index,14),[c]);
  assert.deepEqual(activeCues(index,15),[]);
});

function mockPixi() {
  const renders=[],destroyed=[];
  class Container {
    constructor(){this.children=[];}
    addChild(child){this.children.push(child);}
    removeChildren(){const result=this.children;this.children=[];return result;}
    destroy(){for(const child of this.children)child.destroy();}
  }
  class CanvasRenderer {
    constructor({view}){this.view=view;}
    resize(w,h){this.view.width=w;this.view.height=h;}
    render(stage){renders.push(stage.children.map(c=>({text:c.text,style:c.style,x:c.x,y:c.y,resolution:c.resolution})));}
    destroy(){}
  }
  class TextStyle {
    constructor(options){Object.assign(this,options);}
    toFontString(){return `${this.fontStyle} ${this.fontWeight} ${this.fontSize}px Arial`;}
  }
  class Text {
    constructor(value,style){this.text=value;this.style=style;}
    destroy(){destroyed.push(this.text);}
  }
  return {PIXI:{Container,CanvasRenderer,TextStyle,Text,TextMetrics:{measureFont:()=>({ascent:40})}},renders,destroyed};
}

test('PixiSrtRenderer draws 2x rounded text borders behind the glyph and never repaints every clock tick',()=>{
  const {PIXI,renders,destroyed}=mockPixi();
  const nodes=[];
  const doc={createElement(tag){
    if(tag==='canvas')return {height:0,style:{},setAttribute(){},remove(){},getContext(){
      return {measureText:text=>({width:text.length*10})};
    }};
    return {className:'',style:{},textContent:'',remove(){}};
  }};
  const element={ownerDocument:doc,clientWidth:1920,clientHeight:1080,
    appendChild:node=>nodes.push(node)};
  const renderer=new PixiSrtRenderer(PIXI,element,{offsetHeight:1080},{
    subtitleFontSize:40,subtitleTextColor:'#ff0000',subtitleBorderSize:2,
    subtitleBorderColor:'#00ff00',subtitleBold:false,subtitlePosition:50
  });
  renderer.changeTrack({cues:[{startTime:10,endTime:11,text:'<i>W</i>AVY\nSECOND',
    line:'auto',align:'center',position:'auto',size:100}]});
  renderer.currentTime=10.25;
  const labels=renders.at(-1);
  assert.equal(nodes[0].width,1920);
  assert.equal(nodes[0].height,1080);
  assert.deepEqual(labels.map(l=>l.text),['W','AVY','SECOND']);
  assert.ok(labels.every(l=>l.resolution===2));
  assert.ok(labels.every(l=>l.style.strokeThickness===6)); // 2 * 2 * 1080 / 720
  assert.ok(labels.every(l=>l.style.lineJoin==='round' && l.style.fill==='#FF0000' && l.style.stroke==='#00FF00'));
  assert.equal(labels[0].style.fontStyle,'italic');
  assert.equal(labels[1].style.fontStyle,'normal');
  assert.ok(labels[2].y>labels[0].y+40);
  assert.ok(labels[0].y>400 && labels[0].y<540,'position=50 places text near screen centre');
  const count=renders.length;
  for(let time=10.26;time<10.9;time+=0.01)renderer.currentTime=time;
  assert.equal(renders.length,count,'60 FPS clock does not redraw the same caption');
  renderer.setStyle({subtitleFontSize:40,subtitlePosition:0,subtitleBorderSize:0});
  assert.equal(renders.at(-1)[0].style.strokeThickness,0,'border 0 draws no ring');
  assert.ok(renders.at(-1)[0].y<90,'position 0 stays near the top instead of disappearing');
  renderer.setStyle({subtitleFontSize:40,subtitlePosition:100,subtitleBorderSize:5});
  assert.equal(renders.at(-1)[0].style.strokeThickness,15);
  assert.ok(renders.at(-1)[0].y>850,'position 100 anchors the block near the bottom');
  renderer.currentTime=11;
  assert.equal(renders.at(-1).length,0);
  assert.ok(destroyed.length>=3);
  renderer.destroy();
});
