// SPDX-License-Identifier: GPL-3.0-only
// Port of media_detail/playback_tracks_status.dart, playback_track_preview.dart
// and media_quality_labels.dart. The preview describes the *source* Play will
// open; it does not start playback or issue a transcode.
import {mediaSourceTracks} from './api.js';

const text = value => typeof value === 'string' ? value.trim() : '';
const audioCodecs = {aac:'AAC',ac3:'AC3',eac3:'E-AC3',ec3:'E-AC3',
  truehd:'TrueHD',dts:'DTS',dca:'DTS',dtshd:'DTS-HD',flac:'FLAC',opus:'Opus'};
const subtitleCodecs = {subrip:'SRT',webvtt:'VTT',mov_text:'MOV',
  hdmv_pgs_subtitle:'PGS',dvd_subtitle:'DVD'};
const videoCodecs = {h264:'H.264',avc1:'H.264',hevc:'HEVC',h265:'HEVC',
  hev1:'HEVC',mpeg2video:'MPEG-2',mpeg4:'MPEG-4',vc1:'VC-1'};

function formattedCodec(codec, labels) {
  const value = text(codec);
  return value ? labels[value.toLowerCase()] || value.toUpperCase() : '';
}
function channelLabel(value) {
  const channels = Number(value);
  if (!channels) return '';
  return ({1:'Mono',2:'Stereo',3:'3.0',4:'4.0',5:'4.1',6:'5.1',7:'6.1',8:'7.1'})[channels] || channels + 'ch';
}
function trackLabel(track, kind) {
  if (!track) return null;
  const primary = track.primary;
  const title = text(track.title);
  const descriptiveTitle = title && title.toLowerCase() !== primary.toLowerCase() &&
    title.toLowerCase() !== text(track.language).toLowerCase() &&
    !(kind === 'subtitle' && /^forced$/i.test(title)) ? title : '';
  const codec = formattedCodec(track.codec, kind === 'audio' ? audioCodecs : subtitleCodecs);
  const channels = kind === 'audio' ? channelLabel(track.channels) : '';
  return {primary, detail:[descriptiveTitle,codec,channels].filter(Boolean).join(' · ')};
}
function videoLabels(item, mediaIndex) {
  const raw = item.raw || {};
  const version = (raw.Media || raw.MediaSources || [])[mediaIndex];
  if (!version) return [];
  const labels = [];
  const resolution = text(version.videoResolution || version.VideoResolution);
  if (resolution) labels.push(/^\d+$/.test(resolution) ? resolution + 'p' : resolution.toUpperCase());
  const stream = (version.Part?.[0]?.Stream || version.MediaStreams || [])
    .find(s => Number(s.streamType) === 1 || s.Type === 'Video');
  const codec = formattedCodec(stream?.codec || stream?.Codec || version.videoCodec || version.VideoCodec, videoCodecs);
  if (codec) labels.push(codec);
  const dvProfile = stream?.DOVIProfile ?? stream?.DoviProfile;
  if (dvProfile != null) labels.push(Number(dvProfile) > 0 ? 'DV P' + dvProfile : 'DV');
  else if (stream?.hdr === true || stream?.HDR === true) labels.push('HDR');
  return labels;
}

export function previewDetailTracks(item, mediaIndex, preferences) {
  const tracks = mediaSourceTracks(item, mediaIndex);
  const hasTracks = tracks.audio.length || tracks.subtitles.length;
  const labels = videoLabels(item, mediaIndex);
  if (!hasTracks && !labels.length) return null;
  const prior = hasTracks ? preferences.resolve(item, mediaIndex, tracks) : {};
  const pick = (kind, rows) => prior[kind] !== undefined
    ? rows.find(row => String(row.id) === String(prior[kind])) : null;
  const audio = hasTracks ? (pick('audio', tracks.audio) ||
    tracks.audio.find(row => row.selected) || tracks.audio[0]) : null;
  const subtitle = hasTracks ? (pick('subtitle', tracks.subtitles) ||
    (prior.subtitle === -1 ? null : tracks.subtitles.find(row => row.selected)) || null) : null;
  const parts = labels.map(primary => ({primary, priority:2}));
  if (audio) parts.push({...trackLabel(audio, 'audio'), kind:'audio', priority:1});
  if (hasTracks) parts.push({...(subtitle ? trackLabel(subtitle, 'subtitle') : {primary:'Off',detail:''}),
    kind:'subtitle', priority:0});
  return {parts, label:'Audio & Subtitles: ' + parts.map(part =>
    part.primary + (part.detail ? ' · ' + part.detail : '')).join(', ')};
}
