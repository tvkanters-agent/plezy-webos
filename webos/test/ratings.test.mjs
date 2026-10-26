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
test('Community ratings lookup uses Plex GUID and handles provider failures silently',async()=>{
 let url,requestCount=0;
 const call=async request=>{url=new URL(request);requestCount++;return new Response(JSON.stringify({
   simkl:{rating:8.4,votes:1700},imdb:{rating:9,votes:19000}}),{status:200});};
 const item={Guid:[{id:'imdb://tt1234567'}]};
 const result=await communityRatings(item,'movie',call);
 assert.deepEqual(result.map(r=>r.source),['simkl','imdb']);
 assert.equal(url.pathname,'/ratings');
 assert.equal(url.searchParams.get('imdb'),'tt1234567');
 assert.equal(url.searchParams.get('fields'),'simkl,ext');
 await communityRatings(item,'movie',call);
 assert.equal(requestCount,1,'Ratings by ID should avoid redirect preflight');
 const fallback=await communityRatings({Guid:[{id:'tvdb://456789'}]},'show',async()=>{throw Error('offline');});
 assert.deepEqual(fallback,[]);
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

test('public Simkl ratings are a simple ID request and return multiple providers',async()=>{
 let requested;
 const result=await communityRatings({Guid:[{id:'tvdb://151113'}]},'show',async(url,options)=>{
   requested={url,options};
   return new Response(JSON.stringify({simkl:{rating:8.2,votes:980},
     IMDB:{rating:8.7,votes:12000}}),{status:200});
 });
 assert.deepEqual(result,[{source:'simkl',value:8.2},{source:'imdb',value:8.7}]);
 assert.match(requested.url,/\/ratings\?/);
 assert.equal(new URL(requested.url).searchParams.get('tvdb'),'151113');
 assert.equal(requested.options.headers['simkl-api-key'],undefined);
});

test('Simkl series TMDB IDs use upstream type=tv, not the unsupported show value',async()=>{
 let requested;
 const ratings=await communityRatings({Guid:[{id:'tmdb://1402'}]},'show',async(url)=>{
   requested=new URL(url);
   return new Response(JSON.stringify({simkl:{rating:8.6,votes:232},IMDB:{rating:8.9,votes:9000}}),{status:200});
 });
 assert.equal(requested.searchParams.get('tmdb'),'1402');
 assert.equal(requested.searchParams.get('type'),'tv');
 assert.deepEqual(ratings.map(x=>x.source),['simkl','imdb']);
});
