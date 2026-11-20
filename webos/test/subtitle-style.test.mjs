import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readState} from '../src/core.js';
import {SUBTITLE_STYLE_DEFAULTS, subtitleStyle, videoInsets,
  subtitleOutline, applySrtStyle, applySrtPosition, resetSrtStyle} from '../src/subtitle-style.js';

test('rounded SRT outlines place shadows behind the fill on a circular contour',()=>{
  assert.equal(subtitleOutline(0,'#000000'),'none');
  for (const radius of [1,3,5,7.5]) {
    const offsets=subtitleOutline(radius,'#000000').split(', ').map(shadow=>{
      const match=/^(-?[\d.]+)px (-?[\d.]+)px 0 #000000$/.exec(shadow);
      assert.ok(match,'valid CSS shadow: '+shadow);
      return [+match[1],+match[2]];
    });
    assert.ok(offsets.length>=12);
    assert.ok(offsets.length<=96);
    assert.ok(offsets.every(([x,y])=>Math.abs(Math.hypot(x,y)-radius)<0.02),
      'round rather than square offsets; no diagonal spikes');
    assert.ok(offsets.some(([x,y])=>x>0&&y>0));
    assert.ok(offsets.some(([x,y])=>x<0&&y>0));
    assert.ok(offsets.some(([x,y])=>x<0&&y<0));
    assert.ok(offsets.some(([x,y])=>x>0&&y<0));
  }
});

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
  assert.ok(values['--cue-text-shadow'].includes('0 #123456'));
  assert.ok(values['--cue-text-shadow'].split(', ').length>=12);
  assert.equal(values['--cue-bg-color'],'transparent');
  assert.ok(Math.abs(parseFloat(element.style.top)-12.963)<0.001);
  assert.equal(element.style.left,'0%');
  assert.equal(element.style.bottom,element.style.top);
  applySrtStyle(element,{offsetWidth:1920,offsetHeight:1080},{subtitleBorderSize:0});
  assert.equal(values['--cue-text-shadow'],'none');
  assert.equal(element.style.top,'0%');
  assert.equal(element.style.fontSize,'57.00px');
  applySrtStyle(element,{offsetWidth:1920,offsetHeight:1080},{subtitleBorderSize:5,
    subtitleBorderColor:'#FF0088'});
  assert.ok(values['--cue-text-shadow'].includes('0 #FF0088'));
  assert.ok(values['--cue-text-shadow'].split(', ').length>30);
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
    '--cue-text-shadow':'1px 1px #000000'};
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
