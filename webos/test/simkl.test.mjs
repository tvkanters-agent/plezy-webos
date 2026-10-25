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
test('Simkl V2 device link requests write access and polls using form encoding',async()=>{
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
    assert.equal(new URLSearchParams(calls[0].opts.body).get('scope'),'media:read media:write');
    assert.equal(calls[1].url.pathname,'/oauth2/token');
    assert.equal(new URLSearchParams(calls[1].opts.body).get('grant_type'),'urn:ietf:params:oauth:grant-type:device_code');
    assert.equal(new URLSearchParams(calls[1].opts.body).get('device_code'),'device');
    assert.equal(calls[0].url.searchParams.get('client_id'),SIMKL_CLIENT_ID);
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
  assert.deepEqual(scrobblePayload(movie),{movie:{title:'Test film',ids:{imdb:'tt1234567',tmdb:9988},year:2024}});
  const episode={type:'episode',raw:{index:3,parentIndex:2,grandparentTitle:'Series Name',
    Guid:[{id:'tmdb://9999'}]}};
  const show={raw:{title:'Series Name',year:2020,Guid:[{id:'tvdb://321'}]}};
  assert.deepEqual(scrobblePayload(episode,show),{show:{title:'Series Name',year:2020,ids:{tvdb:321}},
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
    assert.equal(new URLSearchParams(calls[0].opts.body).get('grant_type'),'refresh_token');
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
