import {test} from 'node:test';
import {deepStrictEqual, equal} from 'node:assert/strict';
import {EpisodeTrackPreferences} from '../src/episode-track-preferences.js';
import {previewDetailTracks} from '../src/detail-track-status.js';

const streams = [
  {streamType:1,codec:'hevc'},
  {streamType:2,id:11,languageCode:'eng',codec:'truehd',channels:8,selected:1},
  {streamType:2,id:12,languageCode:'fra',codec:'aac',channels:2},
  {streamType:3,id:21,languageCode:'eng',codec:'srt'},
  {streamType:3,id:22,languageCode:'spa',codec:'ass',selected:0}
];
const item = {id:'ep1',type:'episode',raw:{grandparentRatingKey:'show',Media:[{
  videoResolution:'1080',videoCodec:'hevc',Part:[{Stream:streams}]
}]}};

test('matches native action-row preview: selected source audio, subtitles Off, codec and channel layout',()=>{
  const preview=previewDetailTracks(item,0,new EpisodeTrackPreferences());
  deepStrictEqual(preview.parts.map(part=>part.primary),['1080p','HEVC','English','Off']);
  equal(preview.label,'Audio & Subtitles: 1080p, HEVC, English · TrueHD · 7.1, Off');
  deepStrictEqual(preview.parts.map(part=>part.priority),[2,2,1,0]);
});

test('explicit pre-play choices override server selections for the preview',()=>{
  const choices=new EpisodeTrackPreferences();
  const tracks=[...streams];
  choices.record(item,0,'audio',{id:12,language:'fra',codec:'aac',channels:2});
  choices.record(item,0,'subtitle',{id:22,language:'spa',codec:'ass'});
  const preview=previewDetailTracks(item,0,choices);
  equal(preview.label,'Audio & Subtitles: 1080p, HEVC, French · AAC · Stereo, Spanish · ASS');
  choices.record(item,0,'subtitle',{id:-1});
  equal(previewDetailTracks(item,0,choices).parts.at(-1).primary,'Off');
});

test('selected subtitle stream zero is a real track, distinct from Off',()=>{
  const zero={id:'movie',type:'movie',raw:{Media:[{Part:[{Stream:[
    {streamType:2,id:3,languageCode:'jpn'},
    {streamType:3,id:0,languageCode:'eng',selected:1,codec:'subrip'}
  ]}]}]}};
  equal(previewDetailTracks(zero,0,new EpisodeTrackPreferences()).parts.at(-1).primary,'English');
});

test('chooses requested media version, without using tracks from another part',()=>{
  const movie={id:'movie',type:'movie',raw:{Media:[
    {videoResolution:'720',videoCodec:'h264',Part:[{Stream:[{streamType:2,id:1,languageCode:'eng'}]}]},
    {videoResolution:'2160',videoCodec:'hevc',Part:[{Stream:[
      {streamType:2,id:2,languageCode:'fra',selected:1},
      {streamType:3,id:3,languageCode:'spa',selected:1}
    ]}]}
  ]}};
  const prefs=new EpisodeTrackPreferences();
  equal(previewDetailTracks(movie,0,prefs).parts[0].primary,'720p');
  equal(previewDetailTracks(movie,1,prefs).label,'Audio & Subtitles: 2160p, HEVC, French, Spanish');
});

test('does not announce Off if media source has no stream rows',()=>{
  const missing={id:'empty',type:'episode',raw:{Media:[{Part:[{}]}]}};
  equal(previewDetailTracks(missing,0,new EpisodeTrackPreferences()),null);
  missing.raw.Media[0].videoResolution='1080';
  deepStrictEqual(previewDetailTracks(missing,0,new EpisodeTrackPreferences()).parts.map(x=>x.primary),['1080p']);
});

test('series intent applies to a sibling episode using its own stream identifiers',()=>{
  const preferences=new EpisodeTrackPreferences();
  preferences.record(item,0,'audio',{id:12,language:'fra',codec:'aac'});
  const sibling={id:'ep2',type:'episode',raw:{grandparentRatingKey:'show',Media:[{Part:[{Stream:[
    {streamType:2,id:101,languageCode:'eng',selected:1},
    {streamType:2,id:102,languageCode:'fr',codec:'aac'}
  ]}]}]}};
  equal(previewDetailTracks(sibling,0,preferences).parts[0].primary,'French');
});
