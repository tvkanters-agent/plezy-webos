import {test} from 'node:test';
import {deepStrictEqual, equal} from 'node:assert/strict';
import {EpisodeTrackPreferences, findTrackForIntent} from '../src/episode-track-preferences.js';

const episode = (id, series = 'showA', season = 'season1') =>
  ({id, type:'episode', raw:{grandparentRatingKey:series, parentRatingKey:season}});
const tracks = (audio, subtitles) => ({audio, subtitles});
const audio = (id, language, extra = {}) => ({id, language, ...extra});
const subtitle = (id, language, extra = {}) => ({id, language, ...extra});

test('audio and subtitles carry by ISO language across episodes and seasons, never stream ID', () => {
  const preferences = new EpisodeTrackPreferences();
  preferences.record(episode('e1'), 0, 'audio', audio(7,'fra'));
  preferences.record(episode('e1'), 0, 'subtitle', subtitle(21,'spa'));
  const next = tracks([audio(7,'eng'),audio(8,'fr')], [subtitle(21,'eng'),subtitle(24,'es')]);
  deepStrictEqual(preferences.resolve(episode('e2','showA','season2'),0,next),{audio:8,subtitle:24});
  deepStrictEqual(preferences.resolve(episode('e3','showB'),0,next),{});
});

test('source IDs remain exact for the episode on which the choice was made', () => {
  const preferences = new EpisodeTrackPreferences(), item = episode('e1');
  preferences.record(item,1,'audio',audio(0,'eng', {title:'Stereo'}));
  deepStrictEqual(preferences.resolve(item,1,tracks([audio(0,'eng')],[])),{audio:0});
  deepStrictEqual(preferences.resolve(item,0,tracks([audio(0,'eng')],[])),{audio:0});
  // A different show's track cannot inherit this choice.
  deepStrictEqual(preferences.resolve(episode('e2','showB'),1,tracks([audio(0,'eng')],[])),{});
});

test('commentary title outranks codec when matching across episodes', () => {
  const preferences = new EpisodeTrackPreferences();
  preferences.record(episode('e1'),0,'audio',audio(99,'eng',{title:'Commentary',codec:'ac3'}));
  const next = tracks([audio(12,'eng',{title:'Main',codec:'ac3'}),
    audio(13,'eng',{title:'Commentary',codec:'aac'})],[]);
  equal(preferences.resolve(episode('e2'),0,next).audio,13);
});

test('ambiguous same-language tracks decline instead of picking arbitrary first stream', () => {
  const preferences = new EpisodeTrackPreferences();
  preferences.record(episode('e1'),0,'audio',audio(99,'eng',{codec:'aac',channels:2}));
  const next = tracks([audio(7,'eng',{codec:'aac',channels:2}),
    audio(8,'eng',{codec:'aac',channels:2})],[]);
  deepStrictEqual(preferences.resolve(episode('e2'),0,next),{});
});

test('declared contradictory language is never rescued by matching title', () => {
  equal(findTrackForIntent([audio(3,'eng',{title:'Commentary'})],
    {language:'swe',title:'Commentary'},'audio'),null);
});

test('subtitles carry the forced/non-forced distinction and Off survives missing tracks', () => {
  const preferences = new EpisodeTrackPreferences(), first = episode('e1');
  preferences.record(first,0,'subtitle',subtitle(9,'eng',{title:'Signs',forced:true}));
  deepStrictEqual(preferences.resolve(episode('e2'),0,tracks([], [
    subtitle(7,'eng',{title:'Signs'}),subtitle(8,'eng',{title:'Signs',forced:true})
  ])),{subtitle:8});
  deepStrictEqual(preferences.resolve(episode('e2'),0,tracks([], [subtitle(7,'eng')])),{});
  preferences.record(first,0,'subtitle',{id:-1});
  deepStrictEqual(preferences.resolve(episode('e3'),0,tracks([],[])),{subtitle:-1});
});

test('newest episode choice supersedes older sibling choices while kinds remain independent', () => {
  const preferences = new EpisodeTrackPreferences(), first=episode('e1'), second=episode('e2');
  preferences.record(first,0,'audio',audio(1,'eng'));
  preferences.record(first,0,'subtitle',subtitle(9,'spa'));
  preferences.record(second,0,'audio',audio(2,'fra'));
  const available=tracks([audio(1,'eng'),audio(3,'fra')],[subtitle(8,'spa')]);
  // The same-item subtitle ID 9 does not exist in this media version, so
  // its semantic Spanish preference resolves to stream 8.
  deepStrictEqual(preferences.resolve(first,0,available),{audio:3,subtitle:8});
  deepStrictEqual(preferences.resolve(episode('e3'),0,available),{audio:3,subtitle:8});
  preferences.clear();
  deepStrictEqual(preferences.resolve(episode('e3'),0,available),{});
});

test('untagged tracks need a unique meaningful title; codec alone is insufficient', () => {
  const preferences=new EpisodeTrackPreferences();
  preferences.record(episode('e1'),0,'subtitle',subtitle(8,null,{title:'Signs & Songs',codec:'srt'}));
  const available=tracks([], [subtitle(10,null,{title:'Signs & Songs',codec:'subrip'}),
    subtitle(11,null,{title:'Dialogue',codec:'subrip'})]);
  equal(preferences.resolve(episode('e2'),0,available).subtitle,10);
  const codecOnly=new EpisodeTrackPreferences();
  codecOnly.record(episode('e1'),0,'subtitle',subtitle(8,null,{codec:'srt'}));
  deepStrictEqual(codecOnly.resolve(episode('e2'),0,available),{});
});

test('MediaBrowser series IDs scope preferences without title guesses', () => {
  const preferences=new EpisodeTrackPreferences();
  preferences.record({id:'jf1',type:'Episode',raw:{SeriesId:'series-17'}},0,'audio',audio(1,'eng'));
  deepStrictEqual(preferences.resolve({id:'jf2',type:'Episode',raw:{SeriesId:'series-17'}},0,
    tracks([audio(5,'eng')],[])),{audio:5});
});
