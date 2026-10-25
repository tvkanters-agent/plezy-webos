import {test} from 'node:test';
import assert from 'node:assert/strict';
import {baseUrl, endpoint, time, seconds, nextFocus, readState, request, id} from '../src/core.js';
import {Plex, Jellyfin, plexPin, plexServers} from '../src/api.js';
const server = {url: 'https://media.test/prefix', token: 'secret&token', userId: 'user', kind: 'jellyfin'};
const json = value => new Response(JSON.stringify(value));
function mock(fn) { const old = global.fetch; global.fetch = fn; return () => { global.fetch = old; }; }
test('server URL validation preserves reverse proxy prefixes and rejects credentials', () => {
  assert.equal(baseUrl(' https://media.test/jellyfin/ '), 'https://media.test/jellyfin');
  for (const bad of ['javascript:alert(1)', 'file:///etc', 'https://user:pass@media.test', 'https://media.test?token=x']) assert.throws(() => baseUrl(bad));
});
test('endpoint encodes auth, preserves prefixes and rejects cross-origin media URLs', () => {
  const url = new URL(endpoint(server.url, '/Items/abc', {api_key: server.token}));
  assert.equal(url.pathname, '/prefix/Items/abc'); assert.equal(url.searchParams.get('api_key'), server.token);
  assert.throws(() => endpoint(server.url, 'https://attacker.test/video', {api_key: server.token}));
});
test('time and tick conversion', () => { assert.equal(time(3661), '1:01:01'); assert.equal(time(NaN), '0:00'); assert.equal(seconds(120000000), 12); });
const rect = (x,y) => ({left:x,top:y,right:x+100,bottom:y+100,width:100,height:100});
test('D-pad favors overlapping rows and columns and never moves backwards', () => {
  const origin = rect(200,200), candidates = [{value:'right',rect:rect(350,200)}, {value:'diagonal',rect:rect(250,350)}, {value:'left',rect:rect(0,200)}];
  assert.equal(nextFocus(origin,candidates,'right'), 'right');
  assert.equal(nextFocus(origin,candidates,'left'), 'left');
  assert.equal(nextFocus(origin,candidates,'up'), null);
});
test('corrupt storage recovers without throwing', () => { const state=readState({getItem:()=>'{broken'}); assert.deepEqual(state.servers,[]); assert.equal(state.deviceId.length,32); });
test('HTTP failures are actionable and do not expose token URLs', async () => {
  const restore=mock(async()=>new Response('',{status:401}));
  try { await assert.rejects(request('https://media.test?token=secret'), error=>error.status===401 && !error.message.includes('secret')); } finally {restore();}
});
test('request timeout aborts the underlying fetch', async () => {
  const restore=mock((url, options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')))));
  try { await assert.rejects(request('https://media.test',{timeout:10}), /timed out/); } finally {restore();}
});
test('Jellyfin login does not persist password and uses base path and device identity', async () => {
  const calls=[];const restore=mock(async(url,options)=>{calls.push({url,options});return json(url.endsWith('/System/Info/Public')?{Id:'server',ServerName:'Cinema'}:{AccessToken:'auth',User:{Id:'42',Name:'Viewer'}});});
  try { const result=await new Jellyfin({url:server.url,kind:'jellyfin'},'device').login('Viewer','private');
    assert.equal(result.userId,'42');assert.equal(result.token,'auth');assert.ok(!JSON.stringify(result).includes('private'));
    assert.equal(new URL(calls[1].url).pathname,'/prefix/Users/AuthenticateByName');
    assert.match(calls[1].options.headers['X-Emby-Authorization'],/DeviceId="device"/);
  }finally{restore();}
});
test('Jellyfin negotiates conservative capabilities and uses returned HLS URL without duplicate prefix',async()=>{
  let body;const restore=mock(async(url,opts)=>{body=JSON.parse(opts.body);return json({PlaySessionId:'session',MediaSources:[{Id:'source',SupportsDirectPlay:false,TranscodingUrl:'/prefix/Videos/1/master.m3u8?x=1',MediaStreams:[]}]});});
  try{const result=await new Jellyfin(server,'device').playback({id:'1'},{transcode:true,start:30,subtitle:2});
    assert.equal(result.transcode,true);assert.equal(new URL(result.url).pathname,'/prefix/Videos/1/master.m3u8');
    assert.equal(result.start,30);assert.equal(body.StartTimeTicks,0);assert.equal(body.EnableDirectPlay,false);
    assert.equal(body.SubtitleStreamIndex,2);assert.equal(body.DeviceProfile.TranscodingProfiles[0].AudioCodec,'aac');
  }finally{restore();}
});
test('Jellyfin direct play carries the actual media source id',async()=>{
  const restore=mock(async()=>json({PlaySessionId:'session',MediaSources:[{Id:'source',SupportsDirectPlay:true}]}));
  try{const result=await new Jellyfin(server,'device').playback({id:'1'});const url=new URL(result.url);
    assert.equal(result.transcode,false);assert.equal(url.searchParams.get('MediaSourceId'),'source');assert.equal(url.searchParams.get('Static'),'true');
  }finally{restore();}
});
test('Jellyfin reporting preserves milliseconds as ticks and stop releases encoding',async()=>{
  const calls=[];const restore=mock(async(url,options)=>{calls.push({url,options});return new Response(null,{status:204});});
  try{const api=new Jellyfin(server,'device'),session={item:{id:'1'},sourceId:'source',sessionId:'session',transcode:true,options:{}};
    await api.report(session,'paused',12.345);await api.report(session,'stopped',20);await api.stop(session);
    assert.equal(JSON.parse(calls[0].options.body).PositionTicks,123450000);
    assert.equal(JSON.parse(calls[0].options.body).IsPaused,true);assert.match(calls[1].url,/Playing\/Stopped/);
    assert.equal(calls[2].options.method,'DELETE');assert.equal(new URL(calls[2].url).searchParams.get('PlaySessionId'),'session');
  }finally{restore();}
});
const plexItem={id:'1',duration:100,raw:{Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',Part:[{id:2,key:'/library/parts/2/file.mp4',Stream:[]}]}]}};
test('Plex direct play and explicit compatible playback use distinct URLs',async()=>{
  const api=new Plex(server,'device');const direct=await api.playback(plexItem),hls=await api.playback(plexItem,{transcode:true,start:12});
  assert.equal(direct.transcode,false);assert.match(direct.url,/file.mp4/);
  assert.equal(hls.transcode,true);const url=new URL(hls.url);assert.match(url.pathname,/start.m3u8/);
  assert.equal(url.searchParams.get('directStream'),'0');assert.equal(url.searchParams.get('audioCodec'),'aac');assert.equal(url.searchParams.get('offset'),'0');assert.equal(hls.start,12);
});
test('Plex rejects unsupported direct play and selects HLS for HEVC/MKV',async()=>{
  const item=structuredClone(plexItem);item.raw.Media[0].container='mkv';item.raw.Media[0].videoCodec='hevc';
  assert.equal((await new Plex(server,'device').playback(item)).transcode,true);
});
test('Plex subtitle off is stream id zero, not minus one',async()=>{
  let received;const restore=mock(async(url,options)=>{received={url,options};return new Response(null,{status:204});});
  try{await new Plex(server,'device').playback(plexItem,{subtitle:-1});assert.equal(new URL(received.url).searchParams.get('subtitleStreamID'),'0');assert.equal(received.options.method,'PUT');}finally{restore();}
});
test('Plex TV linking requests a weak pin',async()=>{
  let received;const restore=mock(async(url)=>{received=new URL(url);return json({id:1,code:'ABCD'});});
  try{await plexPin('device');assert.equal(received.searchParams.get('strong'),'false');}finally{restore();}
});
test('Plex discovery uses server-scoped tokens and skips unavailable connections',async()=>{
  const calls=[];const restore=mock(async(url)=>{calls.push(new URL(url));if(url.includes('/resources'))return json([{provides:'server',clientIdentifier:'server',name:'Cinema',accessToken:'scoped',connections:[{uri:'https://offline.test',protocol:'https'},{uri:'http://local.test:32400',protocol:'http',local:true}]}]);if(url.includes('offline'))throw new TypeError('network');return json({MediaContainer:{}});});
  try{const results=await plexServers('device','account');assert.equal(results[0].token,'scoped');assert.equal(results[0].url,'http://local.test:32400');assert.equal(calls[2].searchParams.get('X-Plex-Token'),'scoped');}finally{restore();}
});

test('startup survives denied storage access', () => {
  const state = readState({getItem() { throw new Error('SecurityError'); }});
  assert.deepEqual(state.servers, []);
  assert.match(state.deviceId, /^[0-9a-f]{32}$/);
});
test('startup creates a local device ID without Web Crypto', () => {
  const previous = globalThis.crypto;
  try {
    Object.defineProperty(globalThis, 'crypto', {configurable: true, value: undefined});
    assert.match(id(), /^[0-9a-f]{32}$/);
  } finally {
    Object.defineProperty(globalThis, 'crypto', {configurable: true, value: previous});
  }
});

test('Plex and Jellyfin library sorting is performed server-side', async () => {
  const calls = [];
  const restore = mock(async url => {
    calls.push(new URL(url));
    return json(url.includes('/library/sections/') ? {MediaContainer:{Metadata:[], totalSize:0}} : {Items:[],TotalRecordCount:0});
  });
  try {
    await new Plex(server,'device').list('movies',60,'recent');
    await new Plex(server,'device').list('movies',0,'release');
    await new Jellyfin(server,'device').list('movies',60,'recent');
    await new Jellyfin(server,'device').list('movies',0,'release');
    assert.equal(calls[0].searchParams.get('sort'),'addedAt:desc');
    assert.equal(calls[1].searchParams.get('sort'),'originallyAvailableAt:desc');
    assert.equal(calls[2].searchParams.get('SortBy'),'DateCreated');
    assert.equal(calls[2].searchParams.get('SortOrder'),'Descending');
    assert.equal(calls[2].searchParams.get('StartIndex'),'60');
    assert.equal(calls[3].searchParams.get('SortBy'),'PremiereDate');
  } finally {restore();}
});
test('Jellyfin home still works when one optional shelf endpoint is unsupported', async () => {
  const restore = mock(async url => {
    if (url.includes('/Shows/NextUp')) return new Response('',{status:404});
    if (url.includes('/Items/Resume')) return json({Items:[{Id:'1',Name:'Continue me',Type:'Movie'}]});
    return json([]);
  });
  try {
    const shelves=await new Jellyfin(server,'device').home();
    assert.equal(shelves.length,1);
    assert.equal(shelves[0].items[0].title,'Continue me');
  } finally {restore();}
});
test('Jellyfin home reports failure when all shelves are unavailable', async () => {
  const restore = mock(async () => new Response('',{status:503}));
  try { await assert.rejects(new Jellyfin(server,'device').home(), /HTTP 503/); } finally {restore();}
});

test('partially corrupted saved servers do not crash startup or hide valid accounts', () => {
  const saved={deviceId:'device',active:'good',servers:[
    null,{}, {kind:'plex',id:'bad',url:'file:///bad',token:'x'},
    {kind:'plex',id:'good',url:'https://plex.test',token:'valid'},
    {kind:'jellyfin',id:'missing-user',url:'https://media.test',token:'x'}
  ]};
  const state=readState({getItem:()=>JSON.stringify(saved)});
  assert.deepEqual(state.servers.map(server=>server.id),['good']);
  assert.equal(state.deviceId,'device');
  assert.equal(state.active,'good');
});
