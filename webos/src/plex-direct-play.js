// SPDX-License-Identifier: GPL-3.0-only
// The HTML decoder is not mpv. Bound native opens to LG's webOS 4.0 matrix:
// https://webostv.developer.lge.com/develop/specifications/video-audio-40
export function nativeWebOS() {
  return typeof window !== 'undefined' && (typeof window.PalmSystem !== 'undefined' ||
    /web0s|webos|netcast/i.test(typeof navigator === 'undefined' ? '' : navigator.userAgent));
}
const selected = stream => stream.selected === true || stream.selected === 1 || stream.selected === '1';
const clean = value => String(value || '').toLowerCase().replace(/[\s_-]/g, '');
const FORMATS = {mp4:'video/mp4', m4v:'video/mp4', mov:'video/mp4',
  mkv:'video/x-matroska', matroska:'video/x-matroska'};

/** Return a MIME only when the file can preserve the requested tracks unchanged.
 * localSubtitle means the selected external SRT/ASS is rendered independently.
 * Thin legacy MP4 metadata keeps the existing path; expanded formats require
 * stream detail and positive dimensions/bitrate. Unknown capabilities use HLS.
 */
export function plexDirectPlayMime(media, options = {}, native = nativeWebOS()) {
  const part = media?.Part?.[0];
  if (!part?.key || media.Part.length !== 1 || options.transcode || options.burnSubtitles) return null;
  const container = clean(part.container || media.container), mime = FORMATS[container];
  if (!mime) return null;
  const streams = part.Stream || [];
  const video = streams.find(s => Number(s.streamType) === 1);
  const audio = streams.filter(s => Number(s.streamType) === 2);
  // Multiple/default container tracks cannot be selected reliably through
  // HTML5 on LG 4.x. Even "first" need not be the file's default track.
  if (audio.length > 1) return null;
  if (options.audio !== undefined && String(audio[0]?.id) !== String(options.audio)) return null;
  const hasSubtitle = options.subtitle === undefined
    ? streams.some(s => Number(s.streamType) === 3 && selected(s))
    : String(options.subtitle) !== '-1';
  if (hasSubtitle && !options.localSubtitle) return null;

  const vc = clean(video?.codec || media.videoCodec);
  const ac = clean(audio[0]?.codec || media.audioCodec);
  const legacy = ['mp4','m4v','mov'].includes(container) && vc === 'h264' && ['aac','mp3'].includes(ac);
  if (!legacy && !native) return null;
  if (!['h264','hevc'].includes(vc)) return null;
  const mkv = ['mkv','matroska'].includes(container);
  if (!(mkv ? ['aac','mp3','ac3','eac3','dca','dts','pcm','pcms16le','pcms24le']
    : ['aac','mp3','ac3','eac3']).includes(ac)) return null;

  const depth = Number(video?.bitDepth || media.videoBitDepth || 0);
  const profile = clean(video?.profile || media.videoProfile);
  const chroma = String(video?.chromaSubsampling || '').replace(/:/g, '');
  if (chroma && chroma !== '420') return null;
  if (vc === 'h264' && (depth > 8 || profile && !['baseline','constrainedbaseline','main','high'].includes(profile))) return null;
  if (vc === 'hevc' && (depth > 10 || profile && !['main','main10'].includes(profile))) return null;
  // Dolby Vision profiles are model/container-specific; don't infer them from
  // the generic HEVC entry in the decode table.
  if (video?.DOVIPresent === true || Number(video?.DOVIPresent) === 1 || Number(video?.DOVIProfile) > 0) return null;

  const width = Number(video?.width || media.width || 0);
  const height = Number(video?.height || media.height || 0);
  const bitrate = Number(media.bitrate || 0);
  if (!legacy && (!video || audio.length !== 1 || !(width > 0) || !(height > 0) ||
      !(bitrate > 0) || !(depth > 0) || !profile)) return null;
  if (![width,height,bitrate,depth].every(Number.isFinite) || width > 3840 || height > 2160) return null;
  const uhd = width > 1920 || height > 1080;
  if (uhd && (!['mp4','mkv','matroska'].includes(container) || !['aac','ac3','eac3'].includes(ac))) return null;
  if (bitrate > (uhd ? vc === 'hevc' ? 60000 : 50000 : 40000)) return null;
  const fps = Number(video?.frameRate || parseFloat(media.videoFrameRate) || 0);
  const rawLevel = Number(video?.level || media.videoLevel || 0);
  // Plex stores AVC levels as 41/42/51, HEVC as 123/153.
  const level = rawLevel > 10 ? rawLevel / (vc === 'hevc' ? 30 : 10) : rawLevel;
  if (!legacy && (!(fps > 0) || !(level > 0))) return null;
  if (!Number.isFinite(fps) || !Number.isFinite(level) || fps > 60 ||
      level > (uhd ? 5.1 : vc === 'hevc' ? 4.1 : 4.2)) return null;
  const track = audio[0] || {};
  const channels = Number(track.channels || media.audioChannels || 0);
  const sampleRate = Number(track.samplingRate || 0);
  if (!legacy && (!(channels > 0) || !(sampleRate > 0))) return null;
  if (!Number.isFinite(channels) || !Number.isFinite(sampleRate) || sampleRate > 48000 ||
      channels > (ac === 'eac3' ? 8 : ac === 'mp3' || ac.startsWith('pcm') ? 2 : 6)) return null;
  const ap = clean(track.profile || media.audioProfile);
  if (ac === 'aac' && ap && !['lc','lcaac','aaclc','he','heaac','hev2','heaacv2'].includes(ap)) return null;
  if (['dca','dts'].includes(ac) && !['dts','core'].includes(ap)) return null;
  if (ac.startsWith('pcm') && (!Number(track.channels) || Number(track.channels) > 2 ||
      !Number(track.samplingRate) || Number(track.samplingRate) > 48000 || Number(track.bitDepth || 16) > 24)) return null;
  return mime;
}
