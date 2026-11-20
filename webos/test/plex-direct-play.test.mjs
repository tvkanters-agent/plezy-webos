import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Plex} from '../src/api.js';
import {plexDirectPlayMime} from '../src/plex-direct-play.js';

function media(container='mkv', vc='hevc', ac='eac3') {
  return {container, videoCodec:vc, audioCodec:ac, width:3840, height:2160, bitrate:20000,
    Part:[{id:55,key:'/library/parts/55/file.'+container,Stream:[
      {streamType:1,id:20,codec:vc,bitDepth:vc==='h264'?8:10,profile:vc==='h264'?'high':'main 10',
        level:vc==='h264'?51:153,frameRate:23.976,chromaSubsampling:'4:2:0'},
      {streamType:2,id:21,codec:ac,channels:6,samplingRate:48000,selected:1}
    ]}]};
}
const direct = (m, options={}) => plexDirectPlayMime(m,options,true);
test('C8 native gate accepts validated HEVC/AVC MP4/MKV with compatible audio',()=>{
  for (const c of ['mp4','mkv','matroska']) for (const v of ['h264','hevc'])
    for (const a of ['aac','ac3','eac3'])
      assert.equal(direct(media(c,v,a)),c==='mp4'?'video/mp4':'video/x-matroska');
  assert.equal(plexDirectPlayMime(media(),{},false),null,'desktop preview cannot decode LG formats');
  const legacy={container:'mp4',videoCodec:'h264',audioCodec:'aac',
    Part:[{key:'/movie.mp4',Stream:[]}]};
  assert.equal(plexDirectPlayMime(legacy,{},false),'video/mp4');
});
test('reject known limits, unknown expanded metadata and conflicting summary codecs',()=>{
  const cases=[
    m=>{m.bitrate=60001;},
    m=>{m.width=4096;},
    m=>{m.height=4320;},
    m=>{m.Part[0].Stream[0].frameRate=120;},
    m=>{m.Part[0].Stream[0].level=156;},
    m=>{m.Part[0].Stream[0].profile='main 4:4:4';},
    m=>{m.Part[0].Stream[0].chromaSubsampling='4:2:2';},
    m=>{m.Part[0].Stream[0].bitDepth=12;},
    m=>{m.Part[0].Stream[0].DOVIPresent=1;},
    m=>{m.Part[0].Stream[1].codec='truehd';},
    m=>{m.Part[0].Stream[1].codec='aac';m.Part[0].Stream[1].profile='main';},
    m=>{m.Part[0].Stream[1].samplingRate=192000;},
    m=>{m.Part[0].Stream[1].channels=16;},
    m=>{m.bitrate=undefined;},
    m=>{m.width=0;},
    m=>{m.Part[0].Stream=[];},
    m=>{delete m.Part[0].Stream[0].profile;},
    m=>{delete m.Part[0].Stream[0].frameRate;},
    m=>{delete m.Part[0].Stream[0].level;},
    m=>{m.Part[0].Stream[0].bitDepth='invalid';},
    m=>{delete m.Part[0].key;},
    m=>{m.Part.push({...m.Part[0]});}
  ];
  for(const [i,change] of cases.entries()) {
    const m=media();change(m);assert.equal(direct(m),null,'rejection case '+i);
  }
  const avc=media('mp4','h264','aac');
  avc.Part[0].Stream[0].bitDepth=10;
  assert.equal(direct(avc),null,'AVC Hi10P');
  for(const vc of ['h264','hevc']) {
    const hd=media('mkv',vc);hd.width=1920;hd.height=1080;
    assert.equal(direct(hd),null,'HD has a lower level ceiling than UHD');
  }
});
test('HD DTS core and PCM require explicit compatible profiles and audio parameters',()=>{
  const m=media('mkv','h264','dca');m.width=1920;m.height=1080;
  m.Part[0].Stream[0].level=42;m.Part[0].Stream[1].profile='core';
  assert.equal(direct(m),'video/x-matroska');
  m.Part[0].Stream[1].profile='dts-hd ma';
  assert.equal(direct(m),null);
  const pcm=media('mkv','h264','pcm_s16le');pcm.width=1920;pcm.height=1080;
  pcm.Part[0].Stream[0].level=42;pcm.Part[0].Stream[1].channels=2;
  assert.equal(direct(pcm),'video/x-matroska');
  pcm.Part[0].Stream[1].channels=6;assert.equal(direct(pcm),null);
});
test('track selection cannot be replaced by the file default; local text need not transcode',()=>{
  const m=media();
  assert.equal(direct(m,{audio:21}),'video/x-matroska');
  assert.equal(direct(m,{audio:22}),null);
  assert.equal(direct(m,{transcode:true}),null);
  assert.equal(direct(m,{burnSubtitles:true}),null);
  const sub={streamType:3,id:90,selected:'1',codec:'srt',key:'/sub.srt'};
  m.Part[0].Stream.push(sub);
  assert.equal(direct(m),null);
  assert.equal(direct(m,{localSubtitle:true}),'video/x-matroska');
  assert.equal(direct(m,{subtitle:'-1'}),'video/x-matroska');
  m.Part[0].Stream.push({streamType:2,id:22,codec:'aac',selected:1});
  assert.equal(direct(m,{audio:21,subtitle:-1}),null,'container default need not be first');
});
test('Plex native URL, MIME, sidecar and HLS fallback preserve version, position and track IDs',async()=>{
  const oldWindow=globalThis.window;globalThis.window={PalmSystem:{}};
  try {
    const m=media();m.Part[0].Stream.push({streamType:3,id:90,codec:'ass',key:'/sub.ass',selected:1});
    const item={id:'123',duration:1200,raw:{Media:[media('avi'),m]}};
    const api=new Plex({url:'http://plex.test/prefix',token:'token'},'tv');
    const calls=[];api.get=async(path,params,options)=>{
      calls.push({path,params,options});return {MediaContainer:{Metadata:[{}]}};
    };
  const options={srtPlayback:true,assPlayback:true,mediaIndex:1,start:125.25,subtitle:90,audio:21};
    const session=await api.playback(item,options);
    assert.equal(session.transcode,false);
    assert.equal(session.mimeType,'video/x-matroska');
    assert.equal(new URL(session.url).pathname,'/prefix/library/parts/55/file.mkv');
    assert.equal(session.start,125.25);
    assert.equal(session.subtitleAsset.format,'ass');
    assert.equal(calls[0].params.audioStreamID,21);
    assert.equal(calls[0].params.subtitleStreamID,90);
    await session.extrasPromise;
    const hls=await api.playback(item,{...options,transcode:true});
    const url=new URL(hls.url);
    assert.equal(url.searchParams.get('directPlay'),'0');
    assert.equal(url.searchParams.get('directStream'),'0');
    assert.equal(url.searchParams.get('mediaIndex'),'1');
    assert.equal(url.searchParams.has('offset'),false);
    assert.equal(url.searchParams.get('subtitles'),'none');
    assert.equal(hls.start,125.25);
    assert.deepEqual(hls.subtitleAsset,session.subtitleAsset);
    await hls.extrasPromise;
    const burn=await api.playback(item,{...options,transcode:true,burnSubtitles:true});
    assert.equal(burn.subtitleAsset,null);
    assert.equal(new URL(burn.url).searchParams.get('subtitles'),'burn');
    await burn.extrasPromise;
    const off=await api.playback(item,{...options,subtitle:'-1',transcode:true});
    assert.equal(new URL(off.url).searchParams.get('subtitles'),'burn');
    assert.equal(calls.filter(c=>c.options?.method==='PUT').at(-1).params.subtitleStreamID,0);
    await off.extrasPromise;
  } finally {globalThis.window=oldWindow;}
});
