// SPDX-License-Identifier: GPL-3.0-only
// Ports PlexMappers.plexRatingSources, CommunityRatings and
// SimklCatalogSource.fetchCommunityRatings from upstream Plezy.
// The original source logos are installed under public/assets/.
import {SIMKL_CLIENT_ID} from './simkl.js';
import {simklCatalogRequest} from './simkl-transport.js';
import {VERSION} from './core.js';
import {plexExternalIds} from './external-ids.js';
const cache=new Map(),TTL=12*60*60*1000;
export const displayOrder=['rottenTomatoesCritic','rottenTomatoesAudience','imdb','tmdb',
 'metacritic','letterboxd','trakt','simkl','mal','anilist'];
const assets={
 imdb:['rating_icons/imdb.svg',575/289.83],tmdb:['rating_icons/tmdb.svg',185.04/133.4],
 rottenTomatoesCriticFresh:['rating_icons/rt_fresh.svg',138.75/141.25],
 rottenTomatoesCriticRotten:['rating_icons/rt_rotten.svg',145/140],
 rottenTomatoesAudienceFresh:['rating_icons/rt_upright.svg',106.25/140],
 rottenTomatoesAudienceRotten:['rating_icons/rt_spilled.svg',143.75/108.75],
 metacritic:['rating_icons/metacritic.svg',1],letterboxd:['rating_icons/letterboxd.svg',262/97],
 simkl:['simkl_mark.svg',1],mal:['mal_mark.svg',1],
 trakt:['trakt_circlemark.svg',1],anilist:['anilist_mark.svg',1]
};
export function ratingBadgeInfo(source,value) {
 const key=source==='rottenTomatoes'?'rottenTomatoesCritic':source;
 const file=key==='rottenTomatoesCritic'?assets[value>=6?'rottenTomatoesCriticFresh':'rottenTomatoesCriticRotten']:
  key==='rottenTomatoesAudience'?assets[value>=6?'rottenTomatoesAudienceFresh':'rottenTomatoesAudienceRotten']:assets[key];
 const numeric=key==='tmdb'||key.startsWith('rottenTomatoes')||key==='trakt'||key==='anilist'?
   (value*10).toFixed(0)+'%':
   key==='metacritic'?(value*10).toFixed(0):
   key==='letterboxd'?(value/2).toFixed(1):
   key==='mal'?value.toFixed(2):value.toFixed(1);
 return {src:file?'assets/'+file[0]:null,aspect:file?file[1]:1,value:numeric,
   label:({imdb:'IMDb',tmdb:'TMDB',simkl:'Simkl',mal:'MyAnimeList',critic:'Critics',
    audience:'Audience',rottenTomatoesCritic:'Rotten Tomatoes critics',
    rottenTomatoesAudience:'Rotten Tomatoes audience'})[key]||key};
}
function clean(value) {
 const n=Number(value);
 if(!Number.isFinite(n)||n<=0||n>100)return null;
 return n>10?n/10:n;
}
export function plexRatings(raw){
 if(!raw)return [];
 const result=[];
 function add(value,image,type='critic'){
   const score=clean(value);if(score===null)return;
   const scheme=String(image||'').split(':')[0].toLowerCase();
   const source=scheme==='imdb'?'imdb':
    scheme==='themoviedb'||scheme==='tmdb'?'tmdb':
    scheme==='rottentomatoes'?(type==='critic'?'rottenTomatoesCritic':'rottenTomatoesAudience'):
    type==='audience'?'audience':'critic';
   if(!result.some(x=>x.source===source&&x.value===score))result.push({source,value:score});
 }
 add(raw.rating,raw.ratingImage,'critic');
 add(raw.audienceRating,raw.audienceRatingImage,'audience');
 for(const entry of (Array.isArray(raw.Rating)?raw.Rating:[]))
  add(entry.value,entry.image,entry.type||'audience');
 return result;
}
export function simklRatings(data){
 if(!data||typeof data!=='object')return [];
 const result=[];
 for(const [key,possible] of [['simkl',['simkl']],['imdb',['imdb','IMDB']],['mal',['mal','MAL']]]){
  const obj=possible.map(k=>data[k]).find(Boolean),n=Number(obj?.rating);
  const value=Number.isFinite(n)&&n>0&&n<=10?n:null;
  if(value!==null && (obj?.votes==null || Number(obj.votes)>0))
    result.push({source:key,value});
 }
 return result;
}
export function mergeRatings(own,community){
 if(!community.length)return own;
 const covered=new Set(community.map(x=>x.source));
 return [...community,...own.filter(x=>!covered.has(x.source))].sort((a,b)=>{
  const rank=v=>{let n=displayOrder.indexOf(v);return n<0?displayOrder.length:n;};
  return rank(a.source)-rank(b.source);
 });
}
function paramsForIds(raw,kind){
 const ids=plexExternalIds(raw||{}),q=new URLSearchParams();
 if(ids.imdb)q.set('imdb',ids.imdb);
 if(ids.tmdb){q.set('tmdb',String(ids.tmdb));q.set('type',kind==='movie'?'movie':'tv');}
 if(ids.tvdb)q.set('tvdb',String(ids.tvdb));
 if(ids.mal)q.set('mal',String(ids.mal));
 return q;
}
export async function communityRatings(raw,kind,request=simklCatalogRequest,token) {
 if(!raw||!token||!['movie','show'].includes(kind))return [];
 const ids=paramsForIds(raw,kind);if(!Array.from(ids.keys()).length)return [];
 const cacheKey=kind+':'+ids.toString(),old=cache.get(cacheKey);
 if(old&&Date.now()-old.at<TTL)return old.ratings;
 const headers={Accept:'application/json',Authorization:'Bearer '+token};
 const query=new URLSearchParams();query.set('to','simkl');
 ids.forEach((value,key)=>query.set(key,value));
 function url(path,q=new URLSearchParams()) {
   q.set('client_id',SIMKL_CLIENT_ID);
   q.set('app-name','plezy');q.set('app-version',VERSION);
   return 'https://api.simkl.com'+path+'?'+q.toString();
 }
 function check(response) {
   if(response.status<200 || response.status>=400) {
     const error=new Error('Simkl community lookup failed (HTTP '+response.status+').');
     error.status=response.status;throw error;
   }
 }
 let ratings=[];
 const response=await request(url('/redirect',query),{headers,redirect:'manual'});
 if(response.status!==404) {
   check(response);
   const location=[301,302,303,307,308].includes(response.status)?response.headers.get('Location'):null;
   const page=location && /^\/(movies|tv|anime)\/([1-9]\d*)(?:\/|$)/.exec(new URL(location,'https://simkl.com').pathname);
   if(page) {
     const detail=await request(url('/'+page[1]+'/'+page[2]),{headers,redirect:'manual'});
     if(detail.status!==404) {
       check(detail);
       if(!detail.ok)throw new Error('Unexpected Simkl detail redirect.');
       ratings=simklRatings((await detail.json())?.ratings);
     }
   }
 }
 // Successful empty answers are cached; HTTP, transport and JSON errors aren't.
 cache.delete(cacheKey);cache.set(cacheKey,{at:Date.now(),ratings});
 while(cache.size>300)cache.delete(cache.keys().next().value);
 return ratings;
}

// Literal port of MdblistCatalogSource.fetchCommunityRatings and
// CommunityRatings.mergeCommunityRatings from upstream Plezy. Only one
// MDBList account lookup is made per title; failed requests are not cached.
const mdblistSources={
 imdb:['imdb',10],tmdb:['tmdb',100],tomatoes:['rottenTomatoesCritic',100],
 popcorn:['rottenTomatoesAudience',100],
 tomatoesaudience:['rottenTomatoesAudience',100],
 metacritic:['metacritic',100],letterboxd:['letterboxd',5],
 trakt:['trakt',100],myanimelist:['mal',10]
};
const mdblistCache=new Map(),MDBLIST_TTL=12*60*60*1000;
export function parseMdblistRatings(data) {
 const result=[];
 for(const row of Array.isArray(data)?data:[]) {
   const source=mdblistSources[row?.source];
   if(!source)continue;
   const amount=Number(row.value),votes=row.votes==null?null:Number(row.votes);
   if(!Number.isFinite(amount)||amount<=0||amount>source[1]||
      (votes!==null&&(!Number.isFinite(votes)||votes<=0)))continue;
   result.push({source:source[0],value:amount*10/source[1]});
 }
 return result;
}
export async function fetchMdblistRatings(raw,kind,apiKey,fetchImpl=fetch) {
 if(!apiKey||!['movie','show'].includes(kind))return [];
 const ids=plexExternalIds(raw||{});
 // Upstream prefers IMDb, then TMDB, TVDB for series, then MAL.
 const chosen=ids.imdb?['imdb',kind,ids.imdb]:
   ids.tmdb?['tmdb',kind,String(ids.tmdb)]:
   kind==='show'&&ids.tvdb?['tvdb','show',String(ids.tvdb)]:
   ids.mal?['mal','any',String(ids.mal)]:null;
 if(!chosen)return [];
 const key=chosen.join('/')+'|'+apiKey;
 const cached=mdblistCache.get(key);
 if(cached&&Date.now()-cached.at<MDBLIST_TTL)return cached.ratings;
 const url=new URL('https://api.mdblist.com/'+chosen.map(encodeURIComponent).join('/'));
 url.searchParams.set('apikey',apiKey);
 try {
   const response=await fetchImpl(url.href,{headers:{Accept:'application/json'}});
   if(response.status===404){
     mdblistCache.set(key,{ratings:[],at:Date.now()});return [];
   }
   if(!response.ok)return []; // Error, not an empty answer: retry on next visit.
   const data=await response.json();
   const ratings=parseMdblistRatings(data?.ratings);
   mdblistCache.set(key,{ratings,at:Date.now()});
   return ratings;
 }catch(_){return [];}
}
export function mergeProviderRatings(answers) {
 const best=new Map();
 for(const answer of answers)for(const rating of answer.ratings||[]) {
   const priority=rating.source===answer.origin?0:
     answer.origin==='mdblist'?1:answer.origin==='simkl'?2:3;
   const previous=best.get(rating.source);
   if(!previous||priority<previous.priority)
     best.set(rating.source,{priority,rating});
 }
 return Array.from(best.values()).map(x=>x.rating).sort((a,b)=>{
   const rank=v=>{const n=displayOrder.indexOf(v.source);return n<0?displayOrder.length:n;};
   return rank(a)-rank(b);
 });
}
