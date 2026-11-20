import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readState} from '../src/core.js';
import {SUBTITLE_STYLE_DEFAULTS, subtitleStyle, videoInsets,
  applySrtStyle, resetSrtStyle} from '../src/subtitle-style.js';

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

test('Pixi SRT style matches MPV 720p font units, colors, flags and video insets',()=>{
  const element={offsetHeight:1080,style:{}};
  const style=applySrtStyle(element,{videoWidth:1920,videoHeight:800,offsetWidth:1920,offsetHeight:1080},{
    subtitleFontSize:40,subtitleTextColor:'#ff9900',subtitleBorderSize:2,
    subtitleBorderColor:'#123456',subtitleUseMargins:false,subtitleBold:true,subtitleItalic:true
  });
  assert.equal(element.style.fontSize,'60.00px');
  assert.equal(element.style.fontWeight,'700');
  assert.equal(element.style.fontStyle,'italic');
  assert.equal(style.subtitleTextColor,'#FF9900');
  assert.equal(style.subtitleBorderSize,2);
  assert.equal(style.subtitleBorderColor,'#123456');
  assert.ok(Math.abs(parseFloat(element.style.top)-12.963)<0.001);
  assert.equal(element.style.left,'0%');
  assert.equal(element.style.bottom,element.style.top);
  applySrtStyle(element,{offsetWidth:1920,offsetHeight:1080},{subtitleBorderSize:0});
  assert.equal(element.style.top,'0%');
  assert.equal(element.style.fontSize,'57.00px');
});

test('subtitle styling resets for ASS after the Pixi canvas is destroyed',()=>{
  const element={offsetHeight:720,style:{}};
  applySrtStyle(element,{offsetHeight:720},{subtitleBorderSize:3,subtitleBorderColor:'#112233'});
  assert.equal(element.style.fontSize,'38.00px');
  applySrtStyle(element,{offsetHeight:1080},{subtitleBorderSize:5,subtitleBorderColor:'#AABBCC'});
  assert.equal(element.style.fontSize,'57.00px');
  resetSrtStyle(element);
  assert.equal(element.style.fontSize,'');
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
  const node={style:{fontSize:'60px',fontWeight:'700',fontStyle:'italic',top:'12%',
    right:'0%',bottom:'12%',left:'0%'}};
  resetSrtStyle(node);
  assert.equal(node.style.fontSize,'');
  assert.equal(node.style.top,'');
  resetSrtStyle({textContent:''}); // Lightweight legacy test overlays have no style object.
});
