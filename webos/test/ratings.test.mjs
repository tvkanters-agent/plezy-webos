import {test} from 'node:test';
import assert from 'node:assert/strict';
import {plexRatings, simklRatings, communityRatings, mergeRatings, ratingBadgeInfo} from '../src/ratings.js';

test('Plex multi-provider ratings retain IMDb, TMDB and Rotten Tomatoes panels',()=>{
 const ratings=plexRatings({
   Rating:[{image:'imdb://image.rating',type:'audience',value:8.1},
     {image:'themoviedb://image.rating',type:'audience',value:7.6},
     {image:'rottentomatoes://image.rating.ripe',type:'critic',value:8.9},
     {image:'rottentomatoes://image.rating.upright',type:'audience',value:7.4}],
   rating:8.9,ratingImage:'rottentomatoes://image.rating.ripe'
 });
 assert.deepEqual(ratings.map(x=>x.source),
   ['rottenTomatoesCritic','imdb','tmdb','rottenTomatoesAudience']);
});
test('Simkl community ratings expose its own and IMDb scores',()=>{
 const ratings=simklRatings({simkl:{rating:7.8,votes:100},IMDB:{rating:8.7,votes:500}});
 assert.deepEqual(ratings,[{source:'simkl',value:7.8},{source:'imdb',value:8.7}]);
 assert.deepEqual(mergeRatings([{source:'imdb',value:7.1}],ratings),[
   {source:'imdb',value:8.7},{source:'simkl',value:7.8}]);
});
test('upstream branded scores preserve their asset logos, thresholds and formats',()=>{
  assert.deepEqual(ratingBadgeInfo('imdb',8.3),{
    src:'assets/rating_icons/imdb.svg',aspect:575/289.83,value:'8.3',label:'IMDb'});
  assert.equal(ratingBadgeInfo('tmdb',7.7).value,'77%');
  assert.equal(ratingBadgeInfo('rottenTomatoesCritic',5.8).src,'assets/rating_icons/rt_rotten.svg');
  assert.equal(ratingBadgeInfo('rottenTomatoesCritic',6.5).src,'assets/rating_icons/rt_fresh.svg');
  assert.equal(ratingBadgeInfo('rottenTomatoesAudience',7.3).src,'assets/rating_icons/rt_upright.svg');
  assert.equal(ratingBadgeInfo('simkl',8.1).src,'assets/simkl_mark.svg');
});

test('upstream MDBList rating sources normalize all provider scales',async()=>{
 const {parseMdblistRatings}=await import('../src/ratings.js');
 const scores=parseMdblistRatings([
   {source:'imdb',value:8.2,votes:3000},
   {source:'tmdb',value:75,votes:2000},
   {source:'tomatoes',value:89,votes:120},
   {source:'popcorn',value:72,votes:400},
   {source:'metacritic',value:64,votes:20},
   {source:'letterboxd',value:3.9,votes:500},
   {source:'trakt',value:88,votes:500},
   {source:'myanimelist',value:7.9,votes:30},
   {source:'tomatoesaudience',value:0,votes:40},
   {source:'imdb',value:10.1,votes:100},
   {source:'metacritic',value:90,votes:0}
 ]);
 assert.deepEqual(scores.map(x=>x.source),[
   'imdb','tmdb','rottenTomatoesCritic','rottenTomatoesAudience',
   'metacritic','letterboxd','trakt','mal']);
 assert.equal(scores.find(x=>x.source==='letterboxd').value,7.8);
});
test('MDBList lookup uses Plex IMDb and the documented media endpoint',async()=>{
 const {fetchMdblistRatings}=await import('../src/ratings.js');
 let requested,headers;
 const results=await fetchMdblistRatings({Guid:[{id:'imdb://tt9876543'}]},'movie','testkey',
   async(url,opts)=>{
     requested=new URL(url);headers=opts.headers;
     return new Response(JSON.stringify({ratings:[
       {source:'tomatoes',value:90,votes:200},
       {source:'popcorn',value:81,votes:700}]}),{status:200});
   });
 assert.equal(requested.pathname,'/imdb/movie/tt9876543');
 assert.equal(requested.searchParams.get('apikey'),'testkey');
 assert.equal(headers.Accept,'application/json');
 assert.deepEqual(results,[
   {source:'rottenTomatoesCritic',value:9},
   {source:'rottenTomatoesAudience',value:8.1}
 ]);
});
test('MDBList wins aggregated IMDb but Simkl wins its own score, per Plezy',async()=>{
 const {mergeProviderRatings}=await import('../src/ratings.js');
 const ratings=mergeProviderRatings([
   {origin:'simkl',ratings:[{source:'imdb',value:7.2},{source:'simkl',value:8.4}]},
   {origin:'mdblist',ratings:[{source:'imdb',value:8.7},{source:'simkl',value:7.1},
     {source:'metacritic',value:6.7}]}
 ]);
 assert.deepEqual(ratings,[{source:'imdb',value:8.7},
   {source:'metacritic',value:6.7},{source:'simkl',value:8.4}]);
});

// Acceptance cases from simkl_catalog_source_test.dart; no fictitious public API.
test('Simkl uses authenticated redirect then anime detail and retains all three scores',async()=>{
 const calls=[];
 const ratings=await communityRatings({Guid:[{id:'imdb://tt0877057'},{id:'tmdb://13916'}]},'show',async(url,options)=>{
   calls.push({url:new URL(url),options});
   if(calls.length===1)return new Response('',{status:302,headers:{Location:'https://simkl.com/anime/40190/death-note'}});
   return new Response(JSON.stringify({ratings:{simkl:{rating:9,votes:4200},imdb:{rating:9,votes:410000},mal:{rating:8.6,votes:3700000}}}));
 },'simkl_at_test');
 assert.deepEqual(calls.map(x=>x.url.pathname),['/redirect','/anime/40190']);
 assert.equal(calls[0].url.searchParams.get('to'),'simkl');
 assert.equal(calls[0].url.searchParams.get('type'),'tv');
 for(const call of calls){
   assert.equal(call.options.headers.Authorization,'Bearer simkl_at_test');
   assert.equal(call.options.redirect,'manual');
 }
 assert.deepEqual(ratings,[{source:'simkl',value:9},{source:'imdb',value:9},{source:'mal',value:8.6}]);
});
test('Simkl movie lookup types TMDB IDs and caches a detail 404',async()=>{
 const raw={Guid:[{id:'tmdb://296'},{id:'tvdb://7'}]},calls=[];
 const request=async(url)=>{
   calls.push(new URL(url));
   return calls.length===1?new Response('',{status:302,headers:{Location:'https://simkl.com/movies/53536/title'}}):new Response('',{status:404});
 };
 assert.deepEqual(await communityRatings(raw,'movie',request,'token'),[]);
 assert.deepEqual(calls.map(x=>x.pathname),['/redirect','/movies/53536']);
 assert.equal(calls[0].searchParams.get('type'),'movie');
 await communityRatings(raw,'movie',request,'token');assert.equal(calls.length,2);
});
test('Simkl excludes unknown pages, missing IDs, disconnected accounts and episodes',async()=>{
 let calls=0;
 const request=async()=>{calls++;return new Response('',{status:302,headers:{Location:'https://simkl.com/search/?q=nothing'}});};
 const raw={Guid:[{id:'imdb://tt0000001'}]};
 assert.deepEqual(await communityRatings(raw,'movie',request,'token'),[]);
 await communityRatings(raw,'episode',request,'token');
 await communityRatings({},'show',request,'token');
 await communityRatings(raw,'movie',request);
 assert.equal(calls,1);
});
test('Simkl authentication and provider failures are not cached',async()=>{
 const raw={Guid:[{id:'imdb://tt1375666'}]};
 for(const status of [401,429,500]) {
   await assert.rejects(communityRatings(raw,'movie',async()=>new Response('',{status}),'token'),
     error=>error.status===status);
 }
 let calls=0;
 await communityRatings(raw,'movie',async()=>{calls++;return new Response('',{status:404});},'token');
 assert.equal(calls,1);
});
test('Simkl validates native 0-10 scores and excludes nonpositive votes',()=>{
 assert.deepEqual(simklRatings({simkl:{rating:80,votes:1},imdb:{rating:8,votes:-1},mal:{rating:7,votes:0}}),[]);
});
