import {test} from 'node:test';
import assert from 'node:assert/strict';
import {plexRatings, simklRatings, communityRatings, mergeRatings} from '../src/ratings.js';

test('Plex multi-provider ratings retain IMDb, TMDB and Rotten Tomatoes panels',()=>{
 const ratings=plexRatings({
   Rating:[{image:'imdb://image.rating',type:'audience',value:8.1},
     {image:'themoviedb://image.rating',type:'audience',value:7.6},
     {image:'rottentomatoes://image.rating.ripe',type:'critic',value:8.9},
     {image:'rottentomatoes://image.rating.upright',type:'audience',value:7.4}],
   rating:8.9,ratingImage:'rottentomatoes://image.rating.ripe'
 });
 assert.deepEqual(ratings.map(x=>x.source),
   ['IMDb','TMDB','RT Critics','RT Audience']);
});
test('Simkl community ratings expose its own and IMDb scores',()=>{
 const ratings=simklRatings({simkl:{rating:7.8,votes:100},IMDB:{rating:8.7,votes:500}});
 assert.deepEqual(ratings,[{source:'Simkl',value:7.8},{source:'IMDb',value:8.7}]);
 assert.deepEqual(mergeRatings([{source:'IMDb',value:7.1}],ratings),[
   {source:'IMDb',value:8.7},{source:'Simkl',value:7.8}]);
});
test('Community ratings lookup uses Plex GUID and handles provider failures silently',async()=>{
 let url,requestCount=0;
 const call=async request=>{url=new URL(request);requestCount++;return new Response(JSON.stringify({
   simkl:{rating:8.4,votes:1700},imdb:{rating:9,votes:19000}}),{status:200});};
 const item={Guid:[{id:'imdb://tt1234567'}]};
 const result=await communityRatings(item,'movie',call);
 assert.deepEqual(result.map(r=>r.source),['Simkl','IMDb']);
 assert.equal(url.pathname,'/ratings');
 assert.equal(url.searchParams.get('imdb'),'tt1234567');
 assert.equal(url.searchParams.get('fields'),'simkl,ext');
 await communityRatings(item,'movie',call);
 assert.equal(requestCount,1);
 const fallback=await communityRatings({Guid:[{id:'tvdb://456789'}]},'show',async()=>{throw Error('offline');});
 assert.deepEqual(fallback,[]);
});
