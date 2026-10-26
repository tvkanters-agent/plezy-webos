// SPDX-License-Identifier: GPL-3.0-only
// Upstream Plezy's MediaRatingSource and SimklCatalogSource community score
// mappings. Simkl /ratings accepts IMDb, TMDB and TVDB IDs directly.
import {SIMKL_CLIENT_ID} from './simkl.js';
import {plexExternalIds} from './external-ids.js';
const cache = new Map();
const TTL = 6 * 60 * 60 * 1000;
export function plexRatings(raw) {
  if (!raw) return [];
  const results = new Map();
  function add(source, score) {
    const number = Number(score);
    if (source && Number.isFinite(number) && number > 0 && number <= 10 && !results.has(source))
      results.set(source, {source, value:number});
  }
  const sourceFor = (image, type) => {
    const key = String(image || '').toLowerCase();
    if (key.startsWith('imdb://')) return 'IMDb';
    if (key.startsWith('themoviedb://') || key.startsWith('tmdb://')) return 'TMDB';
    if (key.startsWith('rottentomatoes://')) return type === 'audience' ? 'RT Audience' : 'RT Critics';
    if (key.startsWith('metacritic://')) return 'Metacritic';
    return type === 'audience' ? 'Audience' : 'Critics';
  };
  for (const item of (Array.isArray(raw.Rating) ? raw.Rating : []))
    add(sourceFor(item.image, item.type), item.value);
  if (raw.rating != null) add(sourceFor(raw.ratingImage, 'critic'), raw.rating);
  if (raw.audienceRating != null) add(sourceFor(raw.audienceRatingImage,'audience'), raw.audienceRating);
  return Array.from(results.values());
}
export function simklRatings(data) {
  if (!data || typeof data !== 'object') return [];
  const result=[];
  for (const [source,key] of [['Simkl','simkl'],['IMDb','imdb'],['MAL','mal']]) {
    const rating = data[key] || data[key.toUpperCase()];
    const score = Number(rating?.rating);
    if (Number.isFinite(score) && score > 0 && score <= 10 && Number(rating?.votes) !== 0)
      result.push({source,value:score});
  }
  return result;
}
export async function communityRatings(raw, kind, fetchImpl = fetch) {
  if (!raw || !['movie','show'].includes(kind)) return [];
  const ids=plexExternalIds(raw), query=new URLSearchParams();
  if (ids.imdb) query.set('imdb',ids.imdb);
  else if (ids.tmdb) {query.set('tmdb',String(ids.tmdb));query.set('type',kind==='movie'?'movie':'tv');}
  else if (ids.tvdb) query.set('tvdb',String(ids.tvdb));
  else return [];
  query.set('client_id',SIMKL_CLIENT_ID);
  query.set('fields','simkl,ext');
  const key=kind+':'+query.toString(),stored=cache.get(key);
  if (stored && Date.now()-stored.at<TTL) return stored.ratings;
  try {
    const response=await fetchImpl('https://api.simkl.com/ratings?'+query.toString(),{
      headers:{Accept:'application/json'}});
    if (!response.ok) return [];
    const data=await response.json();
    const ratings=simklRatings(data);
    cache.set(key,{at:Date.now(),ratings});
    return ratings;
  } catch (_) { return []; } // Optional service must never interrupt Plex details.
}
export function mergeRatings(plex, community) {
  const merged=new Map();
  for (const rating of plex) merged.set(rating.source,rating);
  for (const rating of community) merged.set(rating.source,rating);
  return Array.from(merged.values());
}
