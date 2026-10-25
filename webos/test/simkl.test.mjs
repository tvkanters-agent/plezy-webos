import {test} from 'node:test';
import assert from 'node:assert/strict';
import {beginSimklLink, pollSimklLink, parseSession, validSession, scrobblePayload,
  simklMovieIds, progressPercent, SimklTracker, SIMKL_CLIENT_ID} from '../src/simkl.js';

const token = (value='simkl_at_example') => ({
  access_token:value,refresh_token:'simkl_rt_test',expires_in:3600,scope:'media:read media:write'
});
function respond(body, status=200) { return new Response(JSON.stringify(body),{status}); }
function mock(fn) {const original=globalThis.fetch;globalThis.fetch=fn;return()=>{globalThis.fetch=original;};}
function saved(overrides={}) {return {...parseSession(token()),...overrides};}
const movie={type:'movie',title:'Test film',raw:{title:'Test film',year:2024,
  Guid:[{id:'imdb://tt1234567'},{id:'tmdb://9988'},{id:'tvdb://bad'},{id:'bad://123'}]}};
test('Simkl V2 device link requests write access and polls using JSON',async()=>{
  const calls=[];const restore=mock(async(url,opts)=>{
    calls.push({url:new URL(url),opts});
    return respond(calls.length===1?{device_code:'device',user_code:'ABCD-EFGH',
      verification_uri:'https://simkl.com/device',expires_in:900,interval:5}:token());
  });
  try{
    const code=await beginSimklLink();
    const result=await pollSimklLink(code);
    assert.equal(code.user_code,'ABCD-EFGH');
    assert.equal(result.session.accessToken,'simkl_at_example');
    assert.equal(calls[0].url.pathname,'/oauth2/device');
    assert.equal(JSON.parse(calls[0].opts.body).scope,'media:read media:write');
    assert.equal(calls[1].url.pathname,'/oauth2/token');
    assert.equal(JSON.parse(calls[1].opts.body).grant_type,'urn:ietf:params:oauth:grant-type:device_code');
    assert.equal(JSON.parse(calls[1].opts.body).device_code,'device');
    assert.equal(calls[0].url.search,'', 'OAuth requests must not carry API identity URL parameters');
    assert.equal(calls[1].url.search,'', 'OAuth token polls also use the bare OAuth URL');
    assert.equal(JSON.parse(calls[0].opts.body).client_id,SIMKL_CLIENT_ID);
    assert.equal(JSON.parse(calls[1].opts.body).client_id,SIMKL_CLIENT_ID);
    assert.equal(calls[0].opts.headers['Content-Type'],'application/json');
    assert.equal(calls[1].opts.headers['Content-Type'],'application/json');
    assert.equal(calls[0].opts.headers['simkl-api-key'],SIMKL_CLIENT_ID);
  }finally{restore();}
});
test('Simkl device flow treats pending and slow down as nonterminal but rejects read-only tokens',async()=>{
  let count=0;
  const restore=mock(async()=>{
    count++;
    if(count===1)return respond({error:'authorization_pending'},400);
    if(count===2)return respond({error:'slow_down'},400);
    return respond({...token(),scope:'media:read'});
  });
  try{
    assert.equal((await pollSimklLink({device_code:'test'})).pending,true);
    assert.equal((await pollSimklLink({device_code:'test'})).slowDown,true);
    await assert.rejects(pollSimklLink({device_code:'test'}),/writable session/);
  }finally{restore();}
});
test('Simkl normalizes Plex external GUIDs and builds series-level episode IDs',()=>{
  assert.deepEqual(simklMovieIds(movie.raw),{imdb:'tt1234567',tmdb:9988});
  assert.deepEqual(scrobblePayload(movie),{movie:{ids:{imdb:'tt1234567',tmdb:9988}}});
  const episode={type:'episode',raw:{index:3,parentIndex:2,grandparentTitle:'Series Name',
    Guid:[{id:'tmdb://9999'}]}};
  const show={raw:{title:'Series Name',year:2020,Guid:[{id:'tvdb://321'}]}};
  assert.deepEqual(scrobblePayload(episode,show),{show:{ids:{tvdb:321}},
    episode:{season:2,number:3}});
  assert.equal(scrobblePayload({type:'show',raw:{}}),null);
  assert.equal(scrobblePayload({type:'episode',raw:{index:2,parentIndex:null}}),null);
  assert.equal(progressPercent(90,100),90);
  assert.equal(progressPercent(110,100),100);
  assert.equal(progressPercent(5,0),null);
  assert.equal(progressPercent(1,100,true),100);
});
test('Simkl scrobbles only real play/pause/stop events, paced and without heartbeats',async()=>{
  const calls=[],session=saved();
  const restore=mock(async(url,opts)=>{calls.push({url:new URL(url),opts});return respond({action:'start'});});
  try{
    const tracker=new SimklTracker(()=>session,()=>{});
    const play=tracker.createPlayback({server:{kind:'plex'}},movie);
    await play.event('start',10,100);
    await play.event('start',20,100);
    await play.event('pause',55,100);
    await play.event('stop',96,100,true);
    await play.event('stop',96,100,true);
    assert.deepEqual(calls.map(c=>c.url.pathname),['/scrobble/start','/scrobble/pause','/scrobble/stop']);
    assert.deepEqual(calls.map(c=>JSON.parse(c.opts.body).progress),[10,55,100]);
    assert.ok(calls.every(c=>c.opts.headers.Authorization==='Bearer '+session.accessToken));
    assert.equal(tracker.createPlayback({server:{kind:'jellyfin'}},movie),null);
  }finally{restore();}
});
test('Simkl expires and refreshes tokens before sending scrobbles',async()=>{
  const calls=[];let session=saved({expiresAt:Date.now()+1000});
  const restore=mock(async(url,opts)=>{
    calls.push({path:new URL(url).pathname,opts});
    return new URL(url).pathname==='/oauth2/token'?respond({...token('simkl_at_new'),refresh_token:'simkl_rt_new'}):respond({action:'start'});
  });
  try{
    const tracker=new SimklTracker(()=>session,newSession=>{session=newSession;});
    await tracker.createPlayback({server:{kind:'plex'}},movie).event('start',0,100);
    assert.deepEqual(calls.map(c=>c.path),['/oauth2/token','/scrobble/start']);
    assert.equal(JSON.parse(calls[0].opts.body).grant_type,'refresh_token');
    assert.equal(calls[1].opts.headers.Authorization,'Bearer simkl_at_new');
    assert.equal(session.refreshToken,'simkl_rt_new');
  }finally{restore();}
});
test('Simkl invalid refresh disables tracking without exposing the token',async()=>{
  let session=saved({expiresAt:0}),error;
  const restore=mock(async()=>respond({error:'invalid_grant'},400));
  try{
    const tracker=new SimklTracker(()=>session,newSession=>{session=newSession;},message=>{error=message;});
    await tracker.createPlayback({server:{kind:'plex'}},movie).event('start',0,100);
    assert.equal(session,null);
    assert.match(error,/HTTP 400/);
    assert.ok(!error.includes('simkl_rt_test'));
  }finally{restore();}
});
test('Simkl duplicate stop is accepted and a never-started item is ignored',async()=>{
  const calls=[],session=saved();
  const restore=mock(async(url,opts)=>{calls.push(new URL(url).pathname);return respond({error:'already watched'},409);});
  try{
    const tracker=new SimklTracker(()=>session,()=>{});
    await tracker.createPlayback({server:{kind:'plex'}},movie).event('stop',50,100);
    assert.equal(calls.length,0);
    const playback=tracker.createPlayback({server:{kind:'plex'}},movie);
    await playback.event('start',0,100);
    await playback.event('stop',100,100,true);
    assert.deepEqual(calls,['/scrobble/start','/scrobble/stop']);
  }finally{restore();}
});

test('Simkl manual watched and unwatched changes use movie/episode history endpoints',async()=>{
  const calls=[];const session=saved();
  const restore=mock(async(url,opts)=>{calls.push({path:new URL(url).pathname,body:JSON.parse(opts.body)});return respond({});});
  try{
    const tracker=new SimklTracker(()=>session,()=>{});
    const api={server:{kind:'plex'},detail:async()=>({raw:{title:'Show',Guid:[{id:'tvdb://135'}]}})};
    await tracker.markWatched(api,movie,true);
    await tracker.markWatched(api,{type:'episode',raw:{
      parentIndex:1,index:2,grandparentRatingKey:'show',grandparentTitle:'Show'}},false);
    assert.equal(calls[0].path,'/sync/history');
    assert.equal(calls[0].body.movies[0].ids.imdb,'tt1234567');
    assert.equal(calls[1].path,'/sync/history/remove');
    assert.equal(calls[1].body.shows[0].ids.tvdb,135);
    assert.equal(calls[1].body.shows[0].seasons[0].number,1);
    assert.equal(calls[1].body.shows[0].seasons[0].episodes[0].number,2);
  }finally{restore();}
});

test('Simkl never sends an old account playback after disconnect and relink',async()=>{
  const calls=[];let session=saved();
  const restore=mock(async(url,opts)=>{calls.push(new URL(url).pathname);return respond({});});
  try{
    let finish;const blocker=new Promise(resolve=>{finish=resolve;});
    const api={server:{kind:'plex'},detail:()=>blocker};
    const item={type:'episode',raw:{index:1,parentIndex:1,grandparentRatingKey:'show',grandparentTitle:'A'}};
    const tracker=new SimklTracker(()=>session,newSession=>{session=newSession;});
    const playback=tracker.createPlayback(api,item);
    const first=playback.event('start',10,100);
    tracker.reset();
    session=saved({accessToken:'simkl_at_second'});
    finish({raw:{title:'A',Guid:[{id:'tvdb://23'}]}});
    await first;
    assert.deepEqual(calls,[]);
  }finally{restore();}
});

test('Simkl refresh cannot restore a disconnected or relinked account',async()=>{
  let session=saved({expiresAt:0});
  let finish;
  const original=session;
  const restore=mock(async()=>new Promise(resolve=>{finish=resolve;}));
  try{
    const tracker=new SimklTracker(()=>session,next=>{session=next;});
    const refreshing=tracker.refresh().catch(e=>e.message);
    await new Promise(resolve=>setTimeout(resolve,0));
    tracker.reset();
    session=saved({accessToken:'simkl_at_new_account'});
    finish(respond(token('simkl_at_old_account')));
    const result=await refreshing;
    assert.match(result,/account changed/);
    assert.equal(session.accessToken,'simkl_at_new_account');
    assert.notEqual(session.accessToken,original.accessToken);
  }finally{restore();}
});

test('Simkl preserves failed final stops across reload and retries on the next user event',async()=>{
  let session=saved(),failStop=true;const calls=[];
  const restore=mock(async(url,opts)=>{
    const path=new URL(url).pathname;calls.push(path);
    return respond({},path==='/scrobble/stop'&&failStop?503:200);
  });
  try{
    let tracker=new SimklTracker(()=>session,value=>{session=value;});
    const playing=tracker.createPlayback({server:{kind:'plex'}},movie);
    await playing.event('start',0,100);tracker.lastWrite=0;
    await playing.event('stop',90,100);
    assert.equal(session.pendingStops.length,1);assert.equal(session.pendingStops[0].body.progress,90);
    failStop=false;
    tracker=new SimklTracker(()=>session,value=>{session=value;});
    await tracker.createPlayback({server:{kind:'plex'}},movie).event('start',0,100);
    assert.deepEqual(calls,['/scrobble/start','/scrobble/stop','/scrobble/stop','/scrobble/start']);
    assert.deepEqual(session.pendingStops,[]);
  }finally{restore();}
});
test('Simkl unknown duration does not suppress a later valid start',async()=>{
  let session=saved();const calls=[];
  const restore=mock(async(url)=>{calls.push(new URL(url).pathname);return respond({});});
  try{const tracker=new SimklTracker(()=>session,value=>{session=value;});const play=tracker.createPlayback({server:{kind:'plex'}},movie);
    await play.event('start',0,0);await play.event('start',1,100);assert.deepEqual(calls,['/scrobble/start']);
  }finally{restore();}
});
test('Simkl daily quota keeps final stops without hammering the API',async()=>{
  let session=saved();let calls=0;
  const restore=mock(async()=>{calls++;return new Response(JSON.stringify({error:'user_limit_exceeded'}),{status:429,headers:{'Retry-After':'7200'}});});
  try{const tracker=new SimklTracker(()=>session,value=>{session=value;});const play=tracker.createPlayback({server:{kind:'plex'}},movie);
    await play.event('start',0,100);await play.event('stop',90,100);await tracker.retryPending();
    assert.equal(calls,1);assert.equal(session.pendingStops.length,1);assert.ok(tracker.holdUntil>Date.now()+7190000);
    const reloaded=new SimklTracker(()=>session,value=>{session=value;});await reloaded.retryPending();assert.equal(calls,1);
  }finally{restore();}
});
test('Simkl ignores a rate-limit response from a disconnected account',async()=>{
  let session=saved(),complete;
  const restore=mock(async()=>new Promise(resolve=>{complete=resolve;}));
  try{const tracker=new SimklTracker(()=>session,value=>{session=value;});const pending=tracker.scrobble('start',{});
    await new Promise(resolve=>setTimeout(resolve,0));tracker.reset();session=saved({accessToken:'simkl_at_other'});
    complete(respond({error:'user_limit_exceeded'},429));await pending;assert.equal(tracker.holdUntil,0);
  }finally{restore();}
});
test('Simkl manual unwatched action supersedes a saved stop for that title',async()=>{
  let session=saved({pendingStops:[{id:'old',body:{...scrobblePayload(movie),progress:90}}]});
  const calls=[];const restore=mock(async(url)=>{calls.push(new URL(url).pathname);return respond({});});
  try{const tracker=new SimklTracker(()=>session,value=>{session=value;});await tracker.markWatched({server:{kind:'plex'}},movie,false);
    assert.deepEqual(session.pendingStops,[]);assert.deepEqual(calls,['/sync/history/remove']);
  }finally{restore();}
});

test('Simkl HTTP 400 displays the structured OAuth reason without leaking secrets', async()=>{
  const restore=mock(async()=>respond({error:'invalid_request',error_description:
    'Missing device authorization parameter'},400));
  try {
    await assert.rejects(beginSimklLink(),/HTTP 400: invalid_request.*Missing device authorization parameter/);
  } finally {restore();}
  const secret='simkl_rt_' + 'a'.repeat(32);
  const restoreSecret=mock(async()=>respond({error:'invalid_request',message:
    'Rejected token ' + secret},400));
  try {
    await assert.rejects(beginSimklLink(),error=>{
      assert.match(error.message,/invalid_request/);
      assert.ok(!error.message.includes(secret));
      return true;
    });
  } finally {restoreSecret();}
});

test('Simkl fetches full Plex movie GUIDs when home hub omits external identifiers',async()=>{
  const restore=mock(async()=>respond({action:'start'}));
  try{
    const tracker=new SimklTracker(()=>saved(),()=>{});
    let detailCalls=0;
    const payload=await tracker.itemPayload({detail:async()=>{detailCalls++;
      return {type:'movie',title:'Film',raw:{title:'Film',year:2025,Guid:[{id:'imdb://tt7654321'}]}};}},
      {type:'movie',id:'movie1',title:'Film',raw:{title:'Film',guid:'plex://movie/xyz'}});
    assert.equal(detailCalls,1);
    assert.equal(payload.movie.ids.imdb,'tt7654321');
  }finally{restore();}
});

test('Simkl matches upstream ID-only movie and episode requests',async()=>{
  const calls=[],session=saved();
  const restore=mock(async(url,options)=>{
    calls.push({path:new URL(url).pathname,body:JSON.parse(options.body)});
    return respond({});
  });
  try{
    const tracker=new SimklTracker(()=>session,()=>{});
    await tracker.scrobble('start',{...scrobblePayload(movie),progress:20.5});
    const episode={type:'episode',raw:{index:3,parentIndex:1,grandparentRatingKey:'show'}};
    const context=await tracker.itemPayload({detail:async()=>({
      raw:{title:'My Show',Guid:[{id:'tvdb://321'}]}})},episode);
    await tracker.scrobble('stop',{...context,progress:80});
    assert.deepEqual(calls.map(c=>c.path),['/scrobble/start','/scrobble/stop']);
    assert.deepEqual(calls[0].body,{progress:20.5,movie:{ids:{imdb:'tt1234567',tmdb:9988}}});
    assert.deepEqual(calls[1].body,{progress:80,show:{ids:{tvdb:321}},
      episode:{season:1,number:3}});
  } finally{restore();}
});
test('Simkl skips unknown Plex IDs rather than inventing a title match',async()=>{
  const calls=[];
  const restore=mock(async(url)=>{calls.push(new URL(url).pathname);return respond({});});
  try {
    const tracker=new SimklTracker(()=>saved(),()=>{});
    const api={server:{kind:'plex'},detail:async()=>({type:'movie',raw:{
      title:'Unresolved movie',year:2026,guid:'plex://movie/abc'}})};
    const play=tracker.createPlayback(api,{id:'unknown',type:'movie',raw:{title:'Unresolved movie'}});
    await play.event('start',10,100);
    await play.event('stop',30,100);
    assert.deepEqual(calls,[]);
  }finally{restore();}
});
test('Simkl does not invent a title-search fallback after an upstream API 404',async()=>{
  const paths=[],session=saved();
  const restore=mock(async url=>{paths.push(new URL(url).pathname);return respond({error:'id_err'},404);});
  try{
    const tracker=new SimklTracker(()=>session,()=>{});
    await assert.rejects(tracker.scrobble('start',
      {movie:{ids:{imdb:'tt9876543'}},progress:12}),/HTTP 404/);
    assert.deepEqual(paths,['/scrobble/start']);
  }finally{restore();}
});

test('Simkl inherits upstream ExternalIds legacy Plex agent GUID matching',()=>{
 const examples=[
   ['com.plexapp.agents.imdb://tt29768334?lang=en',{imdb:'tt29768334'}],
   ['com.plexapp.agents.themoviedb://1241983',{tmdb:1241983}],
   ['com.plexapp.agents.thetvdb://315500?lang=en',{tvdb:315500}],
   ['com.plexapp.agents.hama://tvdb2-315500',{tvdb:315500}],
   ['com.plexapp.agents.hama://imdb-6455986',{imdb:'tt6455986'}],
   ['com.plexapp.agents.hama://tsdb-69346?lang=en',{tmdb:69346}]
 ];
 for(const [guid,expected] of examples)
   assert.deepEqual(simklMovieIds({guid}),expected,guid);
 for(const guid of ['plex://movie/abc','com.plexapp.agents.hama://anidb2-11905',
     'com.plexapp.agents.hama://tvdb10-315500',
     'com.plexapp.agents.themoviedb://1241983/extra'])
   assert.deepEqual(simklMovieIds({guid}),{},guid);
 assert.deepEqual(simklMovieIds({Guid:[{id:'tvdb://1'}],
   guid:'com.plexapp.agents.thetvdb://2'}),{tvdb:1},
   'modern Plex Guid takes precedence over legacy scalar');
});
