// SPDX-License-Identifier: GPL-3.0-only
// Ports PlexMappers.plexRatingSources, CommunityRatings and
// SimklCatalogSource.fetchCommunityRatings from upstream Plezy.
// The original source logos are installed under public/assets/.
import {SIMKL_CLIENT_ID} from './simkl.js';
import {plexExternalIds} from './external-ids.js';
const cache=new Map(),TTL=6*60*60*1000;
export const displayOrder=['rottenTomatoesCritic','rottenTomatoesAudience','imdb','tmdb',
 'metacritic','letterboxd','trakt','simkl','mal','anilist'];
const assets={
 imdb:['rating_icons/imdb.svg',575/289.83],tmdb:['rating_icons/tmdb.svg',185.04/133.4],
 rottenTomatoesCriticFresh:['rating_icons/rt_fresh.svg',138.75/141.25],
 rottenTomatoesCriticRotten:['rating_icons/rt_rotten.svg',145/140],
 rottenTomatoesAudienceFresh:['rating_icons/rt_upright.svg',106.25/140],
 rottenTomatoesAudienceRotten:['rating_icons/rt_spilled.svg',143.75/108.75],
 metacritic:['rating_icons/metacritic.svg',1],letterboxd:['rating_icons/letterboxd.svg',262/97],
 simkl:['simkl_mark.svg',1],mal:['mal_mark.svg',1]
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
  const obj=possible.map(k=>data[k]).find(Boolean),value=clean(obj?.rating);
  if(value!==null && (obj?.votes==null || Number(obj.votes)!==0))
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
export async function communityRatings(raw,kind,fetchImpl=fetch){
 if(!raw||!['movie','show'].includes(kind))return [];
 const q=paramsForIds(raw,kind);if(!Array.from(q.keys()).length)return [];
 const cacheKey=kind+':'+q.toString(),old=cache.get(cacheKey);
 if(old&&Date.now()-old.at<TTL)return old.ratings;
 // Simkl's documented /ratings API accepts native IMDb, TVDB, TMDB IDs.
 // A custom API-key header would force CORS preflight on old LG Chromium.
 const headers={Accept:'application/json'};
 const base='https://api.simkl.com';
 q.set('client_id',SIMKL_CLIENT_ID);
 q.set('fields','simkl,ext');
 let result=[],confirmed=false;
 try {
   const response=await fetchImpl(base+'/ratings?'+q.toString(),{headers});
   if(response.ok) {
     confirmed=true;
     result=simklRatings(await response.json());
   }
 }catch(error){
   // Mirrors CommunityRatingsLoader._answer: failed requests never enter the
   // cache, otherwise one transient CORS/server failure hides ratings for hours.
   console.warn('Simkl community ratings temporarily unavailable',error);
 }
 if(!result.length){
   // Native Plezy's /redirect -> detail flow, as a fallback only when the
   // public ratings endpoint has no matching result.
   try {
     const redirect=new URLSearchParams(q);
     redirect.delete('fields');
     redirect.set('to','simkl');
     const response=await fetchImpl(base+'/redirect?'+redirect.toString(),
       {headers,redirect:'manual'});
     const location=response.headers?.get('Location');
     const match=location && /\/(movies|tv|anime)\/(\d+)(?:\/|$)/.exec(location);
     if(match){
       const detail=await fetchImpl(base+'/'+match[1]+'/'+match[2]+
         '?client_id='+SIMKL_CLIENT_ID,{headers});
       if(detail.ok) {
         confirmed=true;
         result=simklRatings((await detail.json())?.ratings);
       }
     }
   }catch(_){/* An opaque redirect cannot expose Location in some webOS. */}
 }
 // Plezy caches real provider replies, but not offline/error results.
 if(confirmed) cache.set(cacheKey,{at:Date.now(),ratings:result});
 return result;
}
