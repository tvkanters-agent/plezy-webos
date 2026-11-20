import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readState} from '../src/core.js';
import {SUBTITLE_STYLE_DEFAULTS, subtitleStyle, videoInsets,
  applySrtStyle, applySrtPosition, resetSrtStyle} from '../src/subtitle-style.js';

test('native Plezy subtitle defaults, bounds and durable values survive reload',()=>{
  assert.deepEqual(subtitleStyle(),SUBTITLE_STYLE_DEFAULTS);
  const values={subtitleFontSize:80,subtitleTextColor:'#12ab34',subtitlePosition:150,
    subtitleUseMargins:false,subtitleBold:true,subtitleItalic:true,
    subtitleBorderSize:5,subtitleBorderColor:'#345abc'};
  const loaded=readState({getItem:()=>JSON.stringify(values)});
  assert.deepEqual(subtitleStyle(loaded),
    {...values,subtitleTextColor:'#12AB34',subtitleBorderColor:'#345ABC'});
  assert.deepEqual(subtitleStyle({subtitleFontSize:81,subtitleBorderSize:-1,
    subtitlePosition:151,subtitleTextColor:'red',subtitleBorderColor:'#BADHEX',
    subtitleBold:1}),SUBTITLE_STYLE_DEFAULTS);
});

test('SRT style matches MPV 720p units, colors and flags, without a background box',()=>{
  const values={};
  const element={offsetHeight:1080,style:{
    setProperty(name,value){values[name]=value;}
  }};
  applySrtStyle(element,{videoWidth:1920,videoHeight:800,offsetWidth:1920,offsetHeight:1080},{
    subtitleFontSize:40,subtitleTextColor:'#ff9900',subtitleBorderSize:2,
    subtitleBorderColor:'#123456',subtitleUseMargins:false,subtitleBold:true,subtitleItalic:true
  });
  assert.equal(element.style.fontSize,'60.00px');
  assert.equal(element.style.fontWeight,'700');
  assert.equal(element.style.fontStyle,'italic');
  assert.equal(values['--cue-color'],'#FF9900');
  assert.equal(values['--cue-border-radius'],'3.00px');
  assert.equal(values['--cue-text-shadow'],'none');
  assert.equal(values['--cue-bg-color'],'transparent');
  assert.ok(Math.abs(parseFloat(element.style.top)-12.963)<0.001);
  assert.equal(element.style.left,'0%');
  assert.equal(element.style.bottom,element.style.top);
  applySrtStyle(element,{offsetWidth:1920,offsetHeight:1080},{subtitleBorderSize:0});
  assert.equal(values['--cue-border-radius'],'0.00px');
  assert.equal(values['--cue-outline-filter'],'none');
  assert.equal(values['--cue-text-shadow'],'none');
  assert.equal(element.style.top,'0%');
  assert.equal(element.style.fontSize,'57.00px');
  applySrtStyle(element,{offsetWidth:1920,offsetHeight:1080},{subtitleBorderSize:5,
    subtitleBorderColor:'#FF0088'});
  assert.equal(values['--cue-border-radius'],'7.50px');
  assert.equal(values['--cue-text-shadow'],'none');
});

test('subtitle outline filter is reused, scales with border size and cleans up for ASS',()=>{
  const nodes=[];
  const createElementNS=(_,tag)=>({tag,attributes:{},children:[],style:{},
    setAttribute(name,value){this.attributes[name]=value;},
    append(...children){this.children.push(...children);},
    remove(){this.removed=true;}});
  const properties={};
  const element={ownerDocument:{createElementNS},parentNode:{append(node){nodes.push(node);}},
    offsetHeight:720,style:{setProperty(name,value){properties[name]=value;},
      removeProperty(name){delete properties[name];}}};
  applySrtStyle(element,{offsetHeight:720},{subtitleBorderSize:3,subtitleBorderColor:'#112233'});
  assert.equal(nodes.length,1);
  const filter=nodes[0].children[0];
  assert.equal(filter.tag,'filter');
  const blur=filter.children[0],flood=filter.children[2];
  assert.equal(blur.attributes.stdDeviation,'1.50');
  assert.equal(flood.attributes['flood-color'],'#112233');
  assert.match(properties['--cue-outline-filter'],/^url\(#plezy-srt-outline-\d+\)$/);
  applySrtStyle(element,{offsetHeight:1080},{subtitleBorderSize:5,subtitleBorderColor:'#AABBCC'});
  assert.equal(nodes.length,1,'one reusable filter instead of one per cue or style update');
  assert.equal(blur.attributes.stdDeviation,'3.75');
  assert.equal(flood.attributes['flood-color'],'#AABBCC');
  applySrtStyle(element,{offsetHeight:1080},{subtitleBorderSize:0});
  assert.equal(properties['--cue-outline-filter'],'none');
  resetSrtStyle(element);
  assert.equal(nodes[0].removed,true);
  assert.equal(element._plezyOutlineFilter,null);
  assert.equal(properties['--cue-border-radius'],undefined);
});

test('margins switch uses actual fitted video dimensions, with safe unknown metadata',()=>{
  assert.deepEqual(videoInsets({videoWidth:1920,videoHeight:1080,offsetWidth:1920,offsetHeight:1080},false),
    {top:0,left:0});
  const portrait={videoWidth:1000,videoHeight:1080,offsetWidth:1920,offsetHeight:1080};
  assert.ok(videoInsets(portrait,false).left>20);
  assert.deepEqual(videoInsets(portrait,true),{top:0,left:0});
  assert.deepEqual(videoInsets({videoWidth:0,videoHeight:0,offsetWidth:1920,offsetHeight:1080},false),
    {top:0,left:0});
  assert.ok(videoInsets({videoWidth:0,videoHeight:0,offsetWidth:1920,offsetHeight:1080},false,2.4).top>12);
});

test('switching to ASS dialogue removes SRT-only styles and restores its original background',()=>{
  const variables={'--cue-color':'#FF0000','--cue-bg-color':'transparent',
    '--cue-text-shadow':'none','--cue-border-radius':'3px','--cue-outline-filter':'url(#test)'};
  const node={style:{fontSize:'60px',fontWeight:'700',fontStyle:'italic',top:'12%',
    right:'0%',bottom:'12%',left:'0%',removeProperty(name){delete variables[name];}}};
  resetSrtStyle(node);
  assert.equal(node.style.fontSize,'');
  assert.equal(node.style.top,'');
  assert.deepEqual(variables,{});
  resetSrtStyle({textContent:''}); // Lightweight legacy test overlays have no style object.
});

test('position adjusts only unpositioned text cues, keeping authored positions',()=>{
  const auto={line:'auto',snapToLines:true,lineAlign:'start',vertical:''};
  const authored={line:20,snapToLines:false,lineAlign:'start',vertical:''};
  const vertical={line:'auto',vertical:'rl'};
  applySrtPosition({cues:[auto,authored,vertical]},0,720,38);
  assert.equal(auto.line,0);
  assert.equal(auto.snapToLines,true);
  assert.equal(auto.lineAlign,'start');
  assert.equal(authored.line,20);
  assert.equal(vertical.line,'auto');
  const middle={line:'auto',vertical:''};
  applySrtPosition({cues:[middle]},50,720,38);
  assert.ok(middle.line>=6 && middle.line<=8);
  const low={line:'auto',vertical:''};
  applySrtPosition({cues:[low]},150);
  assert.equal(low.line,'auto');
  assert.equal(low.style['--cue-transform'],'translateY(50vh)');
});
