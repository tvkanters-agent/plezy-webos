// SPDX-License-Identifier: GPL-3.0-only
// Read indexed text blocks from the Plex part. Element IDs and timestamps:
// https://www.matroska.org/technical/elements.html
const SEGMENT = 0x18538067;
const SEEK_HEAD = 0x114d9b74;
const INFO = 0x1549a966;
const TRACKS = 0x1654ae6b;
const CUES = 0x1c53bb6b;
const CLUSTER = 0x1f43b675;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;
const SIMPLE_BLOCK = 0xa3;
const MAX_METADATA = 8 * 1024 * 1024;
const MAX_TOTAL_READ = 24 * 1024 * 1024;
const MAX_CUES = 6000;
const CUE_WINDOW = 2048;
let decoder;

function decodeText(bytes) {
  if (!decoder) decoder = new TextDecoder('utf-8');
  return bytes ? decoder.decode(bytes) : '';
}

function invalid(message) {
  return new Error('MKV subtitles: ' + message);
}

function vint(bytes, offset, stripMarker, limit = 8) {
  const first = bytes[offset];
  let marker = 128;
  let width = 1;
  while (marker && !(first & marker)) {
    marker >>= 1;
    width++;
  }
  if (!marker || width > limit || offset + width > bytes.length)
    throw invalid('invalid element header');
  let value = stripMarker ? first & (marker - 1) : first;
  let unknown = stripMarker && value === marker - 1;
  for (let i = 1; i < width; i++) {
    const byte = bytes[offset + i];
    value = value * 256 + byte;
    unknown = unknown && byte === 255;
  }
  if (unknown) value = Infinity;
  else if (!Number.isSafeInteger(value)) throw invalid('element value exceeds the supported range');
  return {value, width};
}

function element(bytes, offset) {
  const tag = vint(bytes, offset, false, 4);
  const size = vint(bytes, offset + tag.width, true);
  const start = offset + tag.width + size.width;
  return {id:tag.value, start, end:start + size.value};
}

function* children(bytes, start = 0, end = bytes.length) {
  for (let offset = start; offset < end;) {
    const entry = element(bytes, offset);
    if (entry.end > end) throw invalid('truncated element');
    yield entry;
    offset = entry.end;
  }
}

function field(bytes, entry, id) {
  for (const child of children(bytes, entry.start, entry.end)) {
    if (child.id === id) return bytes.subarray(child.start, child.end);
  }
  return null;
}

function integer(bytes) {
  if (!bytes) return undefined;
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  if (!Number.isSafeInteger(value)) throw invalid('integer exceeds the supported range');
  return value;
}

function uint(bytes, entry, id) {
  return integer(field(bytes, entry, id));
}

function rangeReader(url, statedSize, signal) {
  let size = Number(statedSize) || 0;
  let read = 0;
  let prefix;
  return async (start, length) => {
    if (signal.aborted) throw abortError();
    if (size) length = Math.min(length, size - start);
    if (!Number.isSafeInteger(start) || start < 0 || length <= 0)
      throw invalid('invalid byte offset');
    if (prefix && start + length <= prefix.length) return prefix.subarray(start, start + length);
    read += length;
    if (read > MAX_TOTAL_READ) throw invalid('byte budget exceeded');
    const response = await fetch(url, {headers:{Range:'bytes=' + start + '-' + (start + length - 1)}, signal});
    // Never consume a full movie if the server ignores Range.
    if (response.status !== 206) {
      response.body?.cancel?.().catch(() => {});
      throw invalid('Plex did not serve a byte range (HTTP ' + response.status + ')');
    }
    const header = response.headers.get('Content-Range');
    if (header) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header);
      if (!range || Number(range[1]) !== start || Number(range[2]) !== Math.min(start + length, Number(range[3])) - 1)
        throw invalid('Plex returned a different byte range');
      size = Number(range[3]);
      length = Number(range[2]) - start + 1;
    }
    const advertised = Number(response.headers.get('Content-Length'));
    if (advertised > length) throw invalid('Plex returned an oversized byte range');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (signal.aborted) throw abortError();
    if (bytes.length !== length) throw invalid('Plex returned a truncated byte range');
    if (start === 0) prefix = bytes;
    return bytes;
  };
}

function abortError() {
  const error = new Error('Subtitle request was aborted.');
  error.name = 'AbortError';
  return error;
}

async function readMetadata(read, offset, expectedId) {
  const header = element(await read(offset, 12), 0);
  const size = header.end - header.start;
  if (header.id !== expectedId || header.end > MAX_METADATA || !size)
    throw invalid('missing or oversized index element');
  return read(offset + header.start, size);
}

function seekPositions(bytes, segmentStart, positions) {
  for (const seek of children(bytes)) {
    if (seek.id !== 0x4dbb) continue;
    const id = uint(bytes, seek, 0x53ab);
    const offset = uint(bytes, seek, 0x53ac);
    if (id !== undefined && offset !== undefined) positions.set(id, segmentStart + offset);
  }
}

function selectedTrack(bytes, streamIndex, format) {
  const tracks = Array.from(children(bytes)).filter(entry => entry.id === 0xae);
  const codecs = format === 'ass' ? ['S_TEXT/ASS', 'S_TEXT/SSA'] : ['S_TEXT/UTF8', 'S_TEXT/ASCII'];
  const matching = entry => uint(bytes, entry, 0x83) === 17 &&
    codecs.includes(decodeText(field(bytes, entry, 0x86)));
  const byCodec = tracks.filter(matching);
  const hasIndex = streamIndex !== undefined && streamIndex !== null && streamIndex !== '';
  const track = hasIndex ? tracks[Number(streamIndex)] : byCodec.length === 1 ? byCodec[0] : null;
  if (!track || !matching(track)) throw invalid('the selected Plex stream did not match an MKV track');
  if (field(bytes, track, 0x6d80) || field(bytes, track, 0x23314f) || uint(bytes, track, 0x56aa))
    throw invalid('the selected track uses unsupported encoding or timing');
  const number = uint(bytes, track, 0xd7);
  if (!number) throw invalid('the selected track has no track number');
  const privateData = field(bytes, track, 0x63a2);
  return {number, header:privateData ? decodeText(privateData) : '',
    ssa:decodeText(field(bytes, track, 0x86)) === 'S_TEXT/SSA'};
}

function subtitleCues(bytes, track, segmentStart) {
  const cues = [];
  for (const point of children(bytes)) {
    if (point.id !== 0xbb) continue;
    const time = uint(bytes, point, 0xb3);
    for (const entry of children(bytes, point.start, point.end)) {
      if (entry.id !== 0xb7 || uint(bytes, entry, 0xf7) !== track) continue;
      const cluster = uint(bytes, entry, 0xf1);
      const relative = uint(bytes, entry, 0xf0);
      if (time === undefined || cluster === undefined) throw invalid('incomplete subtitle index');
      cues.push({time, cluster:segmentStart + cluster, relative,
        duration:uint(bytes, entry, 0xb2)});
      if (cues.length > MAX_CUES) throw invalid('too many subtitle cues');
    }
  }
  if (!cues.length) throw invalid('the selected track has no cue index');
  return cues;
}

function decodeBlock(bytes, entry, track) {
  const block = entry.id === BLOCK_GROUP ? field(bytes, entry, BLOCK)
    : entry.id === SIMPLE_BLOCK ? bytes.subarray(entry.start, entry.end) : null;
  if (!block?.length) return null;
  const number = vint(block, 0, true);
  if (number.value !== track) return null;
  const pos = number.width;
  if (block.length < pos + 4 || block[pos + 2] & 6) throw invalid('unsupported subtitle block layout');
  const time = (block[pos] << 24 >> 16) | block[pos + 1];
  return {time, text:decodeText(block.subarray(pos + 3)),
    duration:entry.id === BLOCK_GROUP ? uint(bytes, entry, 0x9b) : undefined};
}

async function clusterStarts(read, cues) {
  // Obtain cluster header widths with bounded concurrency. Multiple cues in
  // one cluster use the same header.
  const clusters = Array.from(new Set(cues.map(cue => cue.cluster)));
  const starts = new Map();
  await parallel(clusters, async offset => {
    const cluster = element(await read(offset, 12), 0);
    if (cluster.id !== CLUSTER) throw invalid('cue points outside a cluster');
    starts.set(offset, offset + cluster.start);
  });
  return starts;
}

async function parallel(items, run) {
  let next = 0;
  let failure;
  async function consume() {
    while (next < items.length && !failure) {
      try { await run(items[next++]); }
      catch (error) { failure = error; }
    }
  }
  await Promise.all(Array.from({length:Math.min(6, items.length)}, consume));
  if (failure) throw failure;
}

async function readCue(read, cue, start, track) {
  const position = start + (cue.relative || 0);
  const prefix = await read(position, CUE_WINDOW);
  if (cue.relative !== undefined) {
    const entry = element(prefix, 0);
    if (entry.end > 64 * 1024) throw invalid('subtitle block exceeds the size limit');
    const bytes = entry.end <= prefix.length ? prefix : await read(position, entry.end);
    const block = decodeBlock(bytes, entry, track);
    if (block) return block;
  } else {
    // With no relative position the spec recommends putting the cue's block
    // at the start of the cluster. Match both track and timestamp.
    let clusterTime;
    for (let offset = 0; offset < prefix.length;) {
      const entry = element(prefix, offset);
      if (entry.end > prefix.length) break;
      if (entry.id === 0xe7) clusterTime = integer(prefix.subarray(entry.start, entry.end));
      const block = decodeBlock(prefix, entry, track);
      if (block && clusterTime !== undefined && clusterTime + block.time === cue.time) return block;
      offset = entry.end;
    }
  }
  throw invalid('indexed frame did not match the selected track');
}

function timestamp(milliseconds, ass) {
  const precision = ass ? 100 : 1000;
  let time = Math.max(0, Math.round(milliseconds * precision / 1000));
  const fraction = String(time % precision).padStart(ass ? 2 : 3, '0');
  time = Math.floor(time / precision);
  const seconds = String(time % 60).padStart(2, '0');
  const minutes = String(Math.floor(time / 60) % 60).padStart(2, '0');
  const hours = String(Math.floor(time / 3600)).padStart(ass ? 1 : 2, '0');
  return hours + ':' + minutes + ':' + seconds + (ass ? '.' : ',') + fraction;
}

function formatCaptions(frames, track, ass) {
  if (!ass) return frames.sort((a,b) => a.start - b.start)
    .map((frame, index) => (index + 1) + '\n' + timestamp(frame.start, false) + ' --> ' +
      timestamp(frame.end, false) + '\n' + frame.text).join('\n\n') + '\n';
  // Container packet headers replace the event timestamps with ReadOrder.
  // The original ASS/SSA script header retains styles and PlayRes.
  if (!/^\[Events\]/mi.test(track.header)) throw invalid('ASS track has no event header');
  const events = frames.map(frame => {
    const packet = /^(\d+),(-?\d*),([\s\S]*)$/.exec(frame.text);
    if (!packet) throw invalid('invalid ASS event packet');
    return {order:Number(packet[1]), line:'Dialogue: ' + (track.ssa ? 'Marked=0' : packet[2] || '0') +
      ',' + timestamp(frame.start, true) + ',' + timestamp(frame.end, true) + ',' + packet[3]};
  });
  return track.header.replace(/\s+$/, '') + '\n' + events.sort((a,b) => a.order - b.order).map(event => event.line).join('\n') + '\n';
}

export async function extractMatroskaSubtitle(asset, signal) {
  const read = rangeReader(asset.partUrl, asset.partSize, signal);
  const prefix = await read(0, 32 * 1024);
  const ebml = element(prefix, 0);
  if (ebml.id !== 0x1a45dfa3) throw invalid('the Plex part is not an MKV file');
  const segment = element(prefix, ebml.end);
  if (segment.id !== SEGMENT) throw invalid('the Plex part has no Matroska segment');
  const positions = new Map();
  for (let offset = segment.start; offset < Math.min(prefix.length, segment.end);) {
    const entry = element(prefix, offset);
    if (entry.id === CLUSTER) break;
    if ([INFO, TRACKS, CUES].includes(entry.id)) positions.set(entry.id, offset);
    if (entry.end > prefix.length) break;
    if (entry.id === SEEK_HEAD) seekPositions(prefix.subarray(entry.start, entry.end), segment.start, positions);
    offset = entry.end;
  }
  if (![INFO, TRACKS, CUES].every(id => positions.has(id))) throw invalid('the file has no usable seek index');
  const [info, tracks, index] = await Promise.all([INFO, TRACKS, CUES].map(id => readMetadata(read, positions.get(id), id)));
  const scale = uint(info, {start:0, end:info.length}, 0x2ad7b1) ?? 1000000;
  if (!scale) throw invalid('invalid timestamp scale');
  const track = selectedTrack(tracks, asset.streamIndex, asset.format);
  const cues = subtitleCues(index, track.number, segment.start);
  const starts = await clusterStarts(read, cues);
  const frames = [];
  await parallel(cues, async cue => {
    const block = await readCue(read, cue, starts.get(cue.cluster), track.number);
    const duration = block.duration ?? cue.duration;
    if (!(duration > 0)) throw invalid('subtitle cue has no duration');
    frames.push({start:cue.time * scale / 1000000, end:(cue.time + duration) * scale / 1000000, text:block.text});
  });
  return formatCaptions(frames, track, asset.format === 'ass');
}
