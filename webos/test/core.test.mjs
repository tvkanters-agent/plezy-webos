import {test} from 'node:test';
import assert from 'node:assert/strict';
import {baseUrl, endpoint, time, seconds, nextFocus, readState, request, id} from '../src/core.js';
import {Plex, Jellyfin, plexPin, plexServers, plexNavigation, plexTrackLabel} from '../src/api.js';
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
  assert.equal(hls.timelineOffset,0);
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

test('unwatched library filtering is server-side for Plex and Jellyfin',async()=>{
  const calls=[];
  const restore=mock(async url=>{
    calls.push(new URL(url));
    return json(url.includes('/library/sections/') ? {MediaContainer:{Metadata:[],totalSize:0}} : {Items:[],TotalRecordCount:0});
  });
  try{
    await new Plex(server,'device').list('movies',0,'title','unwatched');
    await new Jellyfin(server,'device').list('movies',0,'title','unwatched');
    await new Jellyfin(server,'device').list('movies',0,'title','all');
    assert.equal(calls[0].pathname,'/prefix/library/sections/movies/unwatched');
    assert.equal(calls[1].searchParams.get('IsPlayed'),'false');
    assert.equal(calls[2].searchParams.has('IsPlayed'),false);
  }finally{restore();}
});

test('Plex home falls back to continue watching and recently added when global hubs are empty',async()=>{
  const calls=[];
  const restore=mock(async url=>{
    const path=new URL(url).pathname;calls.push(path);
    if(path==='/prefix/hubs')return json({MediaContainer:{Hub:[]}});
    if(path==='/prefix/hubs/continueWatching')return json({MediaContainer:{Metadata:[
      {ratingKey:10,title:'Keep watching',type:'episode',viewOffset:1000}]}});
    if(path==='/prefix/library/sections')return json({MediaContainer:{Directory:[
      {key:'5',title:'Movies',type:'movie'},{key:'6',title:'Music',type:'artist'}]}});
    if(path==='/prefix/library/sections/5/recentlyAdded')return json({MediaContainer:{Metadata:[
      {ratingKey:12,title:'New film',type:'movie'}]}});
    return new Response('',{status:404});
  });
  try {
    const rows=await new Plex(server,'device').home();
    assert.deepEqual(rows.map(row=>row.title),['Continue watching','Recently added · Movies']);
    assert.equal(rows[0].items[0].resume,1);
    assert.equal(rows[1].items[0].title,'New film');
    assert.ok(calls.includes('/prefix/library/sections/5/recentlyAdded'));
    assert.ok(!calls.includes('/prefix/library/sections/6/recentlyAdded'));
  }finally{restore();}
});
test('Plex home preserves sign-in errors without probing unrelated endpoints',async()=>{
  const calls=[];
  const restore=mock(async url=>{calls.push(new URL(url).pathname);return new Response('',{status:401});});
  try {
    await assert.rejects(new Plex(server,'device').home(),/Sign-in was rejected/);
    assert.deepEqual(calls,['/prefix/hubs']);
  }finally{restore();}
});
test('Plex home retains useful shelves when one fallback endpoint fails',async()=>{
  const restore=mock(async url=>{
    const path=new URL(url).pathname;
    if(path==='/prefix/hubs'||path==='/prefix/hubs/continueWatching')return new Response('',{status:404});
    if(path==='/prefix/library/sections')return json({MediaContainer:{Directory:[{key:'5',title:'TV',type:'show'}]}});
    if(path==='/prefix/library/sections/5/recentlyAdded')return json({MediaContainer:{Metadata:[
      {ratingKey:44,title:'Show',type:'show'}]}});
    throw new Error('unexpected request');
  });
  try {
    const rows=await new Plex(server,'device').home();
    assert.equal(rows.length,1);
    assert.equal(rows[0].title,'Recently added · TV');
  }finally{restore();}
});

test('Plex next episode follows episode order and crosses season boundaries',async()=>{
  const calls=[];
  const season1=[
    {ratingKey:'ep1',title:'Episode 1',type:'episode',index:1,parentRatingKey:'s1',grandparentRatingKey:'show',parentIndex:1},
    {ratingKey:'ep2',title:'Episode 2',type:'episode',index:2,parentRatingKey:'s1',grandparentRatingKey:'show',parentIndex:1}
  ];
  const season2=[{ratingKey:'ep3',title:'Episode 3',type:'episode',index:1,parentRatingKey:'s2',grandparentRatingKey:'show',parentIndex:2}];
  const restore=mock(async url=>{
    const path=new URL(url).pathname;calls.push(path);
    let entries=[];
    if(path==='/prefix/library/metadata/s1/children')entries=season1;
    else if(path==='/prefix/library/metadata/s2/children')entries=season2;
    else if(path==='/prefix/library/metadata/show/children')entries=[
      {ratingKey:'s1',title:'Season 1',type:'season',index:1},
      {ratingKey:'s2',title:'Season 2',type:'season',index:2}
    ];
    return json({MediaContainer:{Metadata:entries,totalSize:entries.length}});
  });
  try{
    const plex=new Plex(server,'device');
    const inSeason=await plex.nextEpisode({type:'episode',raw:season1[0]});
    assert.equal(inSeason.id,'ep2');
    assert.deepEqual(calls,['/prefix/library/metadata/s1/children']);
    calls.length=0;
    const nextSeason=await plex.nextEpisode({type:'episode',raw:season1[1]});
    assert.equal(nextSeason.id,'ep3');
    assert.deepEqual(calls,['/prefix/library/metadata/s1/children','/prefix/library/metadata/show/children','/prefix/library/metadata/s2/children']);
    const final=await plex.nextEpisode({type:'episode',raw:season2[0]});
    assert.equal(final,null);
  }finally{restore();}
});
test('Plex episode posters prefer the series poster',async()=>{
  const restore=mock(async()=>json({MediaContainer:{Metadata:[
    {ratingKey:'ep',title:'Episode',type:'episode',thumb:'/episode.jpg',
      grandparentThumb:'/series.jpg',parentThumb:'/season.jpg'}]}}));
  try{
    const plex=new Plex(server,'device');
    const detail=await plex.detail('ep');
    assert.match(plex.image(detail),/series.jpg/);
  }finally{restore();}
});


test('Plex chapters and intro markers use seconds, sorted and clipped to the title',()=>{
 const navigation=plexNavigation({duration:100000,Chapter:[{startTimeOffset:50000,title:'Middle'},{startTimeOffset:0},{startTimeOffset:null},{startTimeOffset:-1},{startTimeOffset:200000}],
 Marker:[{type:'intro',startTimeOffset:5000,endTimeOffset:15000},{type:'credits',startTimeOffset:90000,endTimeOffset:110000},{type:'intro',startTimeOffset:10,endTimeOffset:5},{type:'commercial',startTimeOffset:0,endTimeOffset:1000}]});
 assert.deepEqual(navigation.chapters.map(c=>c.start),[0,50]);
 assert.deepEqual(navigation.markers,[{type:'intro',start:5,end:15},{type:'credits',start:90,end:100}]);
});

test('Plex chosen version controls direct URL, HLS media index and track mutations', async () => {
  const calls=[]; const restore=mock(async(url,options)=>{calls.push({url:new URL(url),options});return json({});});
  const api=new Plex(server,'device');
  const item={id:'movie',raw:{Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',Part:[{id:'first',key:'/first.mp4'}]},
    {container:'mp4',videoCodec:'h264',audioCodec:'aac',Part:[{id:'second',key:'/second.mp4',Stream:[{streamType:2,id:42,language:'French'}]}]}]}};
  try {
    const direct=await api.playback(item,{mediaIndex:1});
    assert.equal(new URL(direct.url).pathname,'/prefix/second.mp4');
    assert.equal(direct.audio[0].id,42);
    const converted=await api.playback(item,{mediaIndex:1,audio:42,transcode:true});
    assert.equal(new URL(converted.url).searchParams.get('mediaIndex'),'1');
    assert.equal(calls[0].url.pathname,'/prefix/library/parts/second');
    for(const mediaIndex of [-1,1.5,9]) await assert.rejects(api.playback(item,{mediaIndex}));
    item.raw.Media[1].Part.push({id:'third',key:'/third.mp4'});
    await assert.rejects(api.playback(item,{mediaIndex:1}),/Multi-part/);
  } finally {restore();}
});

test('rail library visibility persists across restarts',()=>{
 const saved=readState({getItem:()=>JSON.stringify({librariesHidden:true})});
 assert.equal(saved.librariesHidden,true);
 assert.equal(readState({getItem:()=>null}).librariesHidden,false);
});

test('Plex artwork URLs request server-side resized images',()=>{
 const instance = new Plex(server,'device');
 const url=new URL(instance.image({poster:'/library/metadata/123/thumb/old-image'}));
 assert.equal(url.pathname,'/prefix/photo/:/transcode');
 assert.equal(url.searchParams.get('width'),'320');
 assert.equal(url.searchParams.get('height'),'480');
 assert.equal(url.searchParams.get('url'),'/library/metadata/123/thumb/old-image');
});

test('Plex backdrop requests a downsized server-transcoded photo',()=>{
 const api=new Plex(server,'device');
 const url=new URL(api.backdrop({background:'/library/metadata/9/art'}));
 assert.equal(url.searchParams.get('width'),'1280');
 assert.equal(url.searchParams.get('url'),'/library/metadata/9/art');
});

test('Plex collection and playlist details use their distinct item APIs',async()=>{
 const calls=[];
 const restore=mock(async url=>{
   const u=new URL(url);
   calls.push(u.pathname);
   return json({MediaContainer:{Metadata:[{ratingKey:'99',title:'A list',type:'collection'}],totalSize:1}});
 });
 try{
   const plex=new Plex(server,'device');
   await plex.detail('99','collection');
   await plex.children('99',0,'collection');
   await plex.detail('11','playlist');
   await plex.children('11',0,'playlist');
   assert.deepEqual(calls,[
     '/prefix/library/collections/99',
     '/prefix/library/collections/99/children',
     '/prefix/playlists/11',
     '/prefix/playlists/11/items'
   ]);
 }finally{restore();}
});

test('sidebar collapse and individually hidden libraries persist safely',()=>{
 const state=readState({getItem:()=>JSON.stringify({
   sidebarCollapsed:true,hiddenLibraryIds:['plex:12',null,31,'plex:13']
 })});
 assert.equal(state.sidebarCollapsed,true);
 assert.deepEqual(state.hiddenLibraryIds,['plex:12','plex:13']);
});

test('Plex sends timeline via POST and accepts empty or XML 200 responses',async()=>{
  const calls=[];
  const restore=mock(async(url,options={})=>{
    calls.push({url:new URL(url),options});
    return new Response('<MediaContainer/>',{status:200,headers:{'Content-Type':'application/xml'}});
  });
  try {
    const plex=new Plex(server,'device');
    await plex.report({item:{id:'42',duration:120},sessionId:'session-123'},'start',12,120);
    assert.equal(calls.length,1);
    assert.equal(calls[0].options.method,'POST');
    assert.equal(calls[0].url.pathname,'/prefix/:/timeline');
    assert.equal(calls[0].url.searchParams.get('state'),'playing');
    assert.equal(calls[0].url.searchParams.get('ratingKey'),'42');
    assert.equal(calls[0].url.searchParams.get('key'),'/library/metadata/42');
    assert.equal(calls[0].url.searchParams.get('time'),'12000');
    assert.equal(calls[0].url.searchParams.get('duration'),'120000');
    assert.equal(calls[0].url.searchParams.get('identifier'),'com.plexapp.plugins.library');
  } finally {restore();}
});
test('Plex progress sync surfaces a genuine HTTP failure',async()=>{
 const restore=mock(async()=>new Response('',{status:403}));
 try{
   await assert.rejects(new Plex(server,'device').report({item:{id:'42',duration:90},
     sessionId:'session'},'playing',7,90),/timeline returned HTTP 403/);
 }finally{restore();}
});

test('Plex partially watched shows and seasons expose remaining episode counts',async()=>{
 const restores=mock(async()=>json({MediaContainer:{Metadata:[
   {ratingKey:'show',title:'Series',type:'show',leafCount:10,viewedLeafCount:3,viewCount:1},
   {ratingKey:'season',title:'Season 1',type:'season',leafCount:5,viewedLeafCount:5,viewCount:1}
 ]}}));
 try {
   const plex=new Plex(server,'device');
   const raw=await plex.children('root');
   assert.equal(raw.items[0].unwatchedCount,7);
   assert.equal(raw.items[0].watched,false);
   assert.equal(raw.items[1].unwatchedCount,0);
   assert.equal(raw.items[1].watched,true);
 } finally{restores();}
});
test('Plex episode thumbnail uses landscape still and detailed art is higher resolution',()=>{
 const plex=new Plex(server,'device');
 const item={type:'episode',poster:'/library/metadata/show/thumb',
   raw:{thumb:'/library/metadata/episode/thumb'}};
 const thumb=new URL(plex.image(item,{landscape:true}));
 assert.equal(thumb.searchParams.get('width'),'480');
 assert.equal(thumb.searchParams.get('height'),'270');
 assert.equal(thumb.searchParams.get('url'),'/library/metadata/episode/thumb');
 const detail=new URL(plex.image(item,{landscape:true,detail:true}));
 assert.equal(detail.searchParams.get('width'),'960');
 const poster=new URL(plex.image(item,{detail:true}));
 assert.equal(poster.searchParams.get('width'),'600');
});

test('Plex subtitle labels retain language, SDH, forced and technical descriptions',()=>{
 const s=plexTrackLabel({language:'English',title:'English SDH',codec:'srt',
   hearingImpaired:true},'subtitle');
 assert.equal(s.primary,'English');
 assert.match(s.secondary,/SDH/);
 assert.match(s.secondary,/SRT/);
 const forced=plexTrackLabel({language:'French',title:'Commentary',forced:true,codec:'ass'},'subtitle');
 assert.match(forced.primary,/Forced/);
 assert.match(forced.secondary,/Commentary/);
 const audio=plexTrackLabel({language:'Japanese',title:'Director commentary',codec:'aac',channels:2},'audio');
 assert.match(audio.secondary,/Director commentary/);
 assert.match(audio.secondary,/2 channels/);
});

test('Plex translates upstream ISO 639 language names and keeps SDH display titles',()=>{
 const s=plexTrackLabel({languageCode:'eng',displayTitle:'English (SDH)',
   codec:'srt'},'subtitle');
 assert.equal(s.primary,'English');
 assert.match(s.secondary,/SDH/);
 const t=plexTrackLabel({languageCode:'fra',title:'French commentary',
   codec:'ass'},'subtitle');
 assert.equal(t.primary,'French');
 assert.match(t.secondary,/commentary/);
});

test('Plex tracker ID fetch matches upstream modern, legacy, empty and HTTP error cases', async () => {
  const api=new Plex(server,'device'); let response, seen;
  const restore=mock(async url=>{seen=new URL(url);return response;});
  try {
    response=json({MediaContainer:{Metadata:[{guid:'plex://show/abc',Guid:[
      {id:'imdb://tt12345'},{id:'tmdb://456'},{id:'tvdb://789'}]}]}});
    assert.deepEqual(await api.fetchExternalIds('show-1'),{imdb:'tt12345',tmdb:456,tvdb:789});
    assert.equal(seen.pathname,'/prefix/library/metadata/show-1');
    assert.equal(seen.searchParams.get('includeGuids'),'1');
    assert.equal(seen.searchParams.has('includeMarkers'),false);
    response=json({MediaContainer:{Metadata:[{guid:'com.plexapp.agents.thetvdb://315500?lang=en'}]}});
    assert.deepEqual(await api.fetchExternalIds('show-1'),{tvdb:315500});
    for(const body of [{},{MediaContainer:{Metadata:[]}},{MediaContainer:{Metadata:[{guid:'plex://show/a'}]}}]) {
      response=json(body);assert.deepEqual(await api.fetchExternalIds('show-1'),{});
    }
    response=new Response('',{status:404});assert.deepEqual(await api.fetchExternalIds('gone'),{});
    response=new Response('',{status:500});await assert.rejects(api.fetchExternalIds('show-1'),/HTTP 500/);
  } finally {restore();}
});
