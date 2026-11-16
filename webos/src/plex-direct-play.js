// SPDX-License-Identifier: GPL-3.0-only
// LG webOS TV 4.x codec/container capabilities (the target C8 generation).
// Unlike mpv, the browser media pipeline cannot decode arbitrary Plex files.
// A failed native open falls back to the existing HLS transcode in Player.failed().
const FORMATS = {
  mp4: {mime: 'video/mp4', audio: ['aac', 'mp3', 'ac3', 'eac3']},
  m4v: {mime: 'video/mp4', audio: ['aac', 'mp3', 'ac3', 'eac3']},
  mov: {mime: 'video/mp4', audio: ['aac', 'mp3', 'ac3', 'eac3']},
  mkv: {mime: 'video/x-matroska', audio: ['aac', 'mp3', 'ac3', 'eac3', 'dca', 'dts', 'pcm', 'pcm_s16le', 'pcm_s24le']},
  matroska: {mime: 'video/x-matroska', audio: ['aac', 'mp3', 'ac3', 'eac3', 'dca', 'dts', 'pcm', 'pcm_s16le', 'pcm_s24le']}
};

const VIDEO_CODECS = ['h264', 'hevc'];

// Plex supplies external subtitle files through Stream.key. Embedded tracks
// have no independently downloadable file and must stay on the burn-in path.
export function plexSubtitleAsset(media, options = {}) {
  const streams = media?.Part?.[0]?.Stream || [];
  const subtitles = streams.filter(stream => Number(stream.streamType) === 3);
  const stream = options.subtitle === undefined ? subtitles.find(selected)
    : String(options.subtitle) === '-1' ? null
    : subtitles.find(entry => String(entry.id) === String(options.subtitle));
  if (!stream?.key) return null;
  const codec = String(stream.codec || '').toLowerCase();
  const format = ['srt', 'subrip'].includes(codec) ? 'srt'
    : ['ass', 'ssa'].includes(codec) ? 'ass' : null;
  return format ? {id:stream.id, key:stream.key, format} : null;
}

function selected(stream) {
  return stream.selected === true || stream.selected === 1 || stream.selected === '1';
}

/**
 * Select the native URI media pipeline only when the source matches the
 * published webOS 4.0 decode matrix. Keep non-default track changes on Plex's
 * existing HLS path: HTML5 on webOS 4.x cannot reliably select internal tracks.
 *
 * Returns the source MIME for mediaOption, or null for the transcode fallback.
 */
export function plexDirectPlayMime(media, options = {}) {
  const part = media?.Part?.[0];
  const container = String(part?.container || media?.container || '').toLowerCase();
  const format = FORMATS[container];
  const videoCodec = String(media?.videoCodec || '').toLowerCase();
  const audioCodec = String(media?.audioCodec || '').toLowerCase();
  if (!format || !VIDEO_CODECS.includes(videoCodec) || !format.audio.includes(audioCodec)) return null;
  if (options.transcode || options.burnSubtitles) return null;

  const tracks = part?.Stream || [];
  // Native video + a separately downloaded text subtitle is safe. The HTML5
  // decoder cannot select embedded tracks, so those still need Plex HLS.
  const selectedSubtitle = options.subtitle === undefined
    ? tracks.some(stream => Number(stream.streamType) === 3 && selected(stream))
    : String(options.subtitle) !== '-1';
  if (selectedSubtitle && !plexSubtitleAsset(media, options)) return null;

  // The native decoder normally starts with the first audio stream. Server
  // preferences apply to transcoding, not to the bytes of a direct part URL.
  const audio = tracks.filter(stream => Number(stream.streamType) === 2);
  const chosen = audio.find(selected);
  if (chosen && audio.length && String(chosen.id) !== String(audio[0].id)) return null;
  if (options.audio !== undefined && String(audio[0]?.id) !== String(options.audio)) return null;

  const videoStream = (part?.Stream || []).find(stream => Number(stream.streamType) === 1);
  const bitDepth = Number(videoStream?.bitDepth || media?.videoBitDepth || 0);
  const profile = String(videoStream?.profile || media?.videoProfile || '').toLowerCase();
  if (videoCodec === 'h264' && (bitDepth > 8 || /high\s*10|high\s*4:2:2|high\s*4:4:4/.test(profile))) return null;
  if (videoCodec === 'hevc' && (bitDepth > 10 || /main\s*12/.test(profile))) return null;

  const width = Number(media?.width || videoStream?.width || 0);
  const height = Number(media?.height || videoStream?.height || 0);
  if (width > 4096 || height > 2160) return null;
  const isUhd = width > 1920 || height > 1080;
  // LG lists only DD/DD+/AAC audio for UHD files, and a 50/60 Mbps ceiling.
  if (isUhd && !['aac', 'ac3', 'eac3'].includes(audioCodec)) return null;
  const maxBitrateKbps = isUhd ? (videoCodec === 'hevc' ? 60000 : 50000) : 40000;
  const bitrateKbps = Number(media?.bitrate || 0);
  if (bitrateKbps > maxBitrateKbps) return null;
  return format.mime;
}
