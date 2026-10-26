import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {SimklTracker} from '../src/simkl.js';
const require=createRequire(import.meta.url);
const {request}=require('../service/transport.js');

test('TV transport returns unfollowed Location and sends auth only to api.simkl.com',async()=>{
 let calls=0;
 const result=await new Promise(resolve=>request({path:'/redirect?to=simkl&imdb=tt123',authorization:'Bearer simkl_at_test'},resolve,{
   get(options,callback){
     calls++;assert.equal(options.hostname,'api.simkl.com');
     assert.equal(options.headers.Authorization,'Bearer simkl_at_test');
     const req=new EventEmitter();req.abort=()=>{};
     queueMicrotask(()=>{
       const res=new EventEmitter();res.setEncoding=()=>{};res.statusCode=302;
       res.headers={location:'https://simkl.com/anime/40190/death-note'};
       callback(res);res.emit('end');
     });return req;
   }
 }));
 assert.equal(calls,1);assert.equal(result.status,302);
 assert.equal(result.headers.location,'https://simkl.com/anime/40190/death-note');
});
test('TV transport rejects arbitrary hosts, writes, path injection and missing tokens',async()=>{
 for(const path of ['https://evil.test/redirect','//evil.test/redirect','/sync/ratings','/redirect\r\nx:y','/movies/0']){
   const result=await new Promise(resolve=>request({path,authorization:'Bearer token'},resolve));
   assert.equal(result.returnValue,false);
 }
 assert.equal((await new Promise(resolve=>request({path:'/redirect'},resolve))).returnValue,false);
});
test('community requests share tracker refresh and retry once with a fresh token on 401',async()=>{
 let session={accessToken:'simkl_at_old',refreshToken:'simkl_rt_test',expiresAt:Date.now()+3600000,scope:'media:read media:write'};
 const tracker=new SimklTracker(()=>session,s=>session=s);
 let refreshes=0,calls=[];
 tracker.refresh=async()=>{refreshes++;return session={...session,accessToken:'simkl_at_new'};};
 const ratings=await tracker.getCommunityRatings({Guid:[{id:'imdb://tt9991234'}]},'movie',async(url,options)=>{
   calls.push(options.headers.Authorization);
   if(calls.length===1)return new Response('',{status:401});
   if(calls.length===2)return new Response('',{status:302,headers:{Location:'https://simkl.com/movies/123/title'}});
   return new Response(JSON.stringify({ratings:{imdb:{rating:8,votes:1},simkl:{rating:9,votes:2}}}));
 });
 assert.equal(refreshes,1);
 assert.deepEqual(calls,['Bearer simkl_at_old','Bearer simkl_at_new','Bearer simkl_at_new']);
 assert.deepEqual(ratings,[{source:'simkl',value:9},{source:'imdb',value:8}]);
});
