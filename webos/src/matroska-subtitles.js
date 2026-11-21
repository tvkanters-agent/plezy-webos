// SPDX-License-Identifier: GPL-3.0-only
import {unzlibSync} from 'fflate';
import {nativeWebOS} from './plex-direct-play.js';

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
const MAX_BLOCK = 64 * 1024;
const CUE_WINDOW = 256;
const SCAN_WINDOW = 4096;
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

function record(bytes, start = 0) {
  return {start, end:bytes.length};
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

function rangeReader(url, statedSize, signal, onRead, native, onTiming) {
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
    function checkHeaders(status, getHeader) {
      if (status !== 206) throw invalid('Plex did not serve a byte range (HTTP ' + status + ')');
      const header = getHeader('Content-Range');
      let verifiedRange = false;
      if (header) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header);
        if (!range || Number(range[1]) !== start || Number(range[2]) !== Math.min(start + length, Number(range[3])) - 1)
          throw invalid('Plex returned a different byte range');
        size = Number(range[3]);
        length = Number(range[2]) - start + 1;
        verifiedRange = true;
      }
      // Some Plex proxies advertise the file's full Content-Length even for
      // a valid 206 response. A verified Content-Range is authoritative;
      // onprogress and the final byte count still enforce the actual limit.
      if (!verifiedRange && Number(getHeader('Content-Length')) > length)
        throw invalid('Plex Content-Length exceeds the requested byte range');
      return length;
    }
    const range = 'bytes=' + start + '-' + (start + length - 1);
    const startedAt = onTiming ? Date.now() : 0;
    const bytes = native ? await xhrRange(url, range, signal, checkHeaders)
      : await fetchRange(url, range, signal, checkHeaders);
    if (signal.aborted) throw abortError();
    if (bytes.length !== length) throw invalid(bytes.length > length
      ? 'Plex body exceeded the requested byte range' : 'Plex returned a truncated byte range');
    if (start === 0) prefix = bytes;
    if (onTiming) onTiming('range', Date.now() - startedAt);
    onRead?.();
    return bytes;
  };
}

async function fetchRange(url, range, signal, checkHeaders) {
  const response = await fetch(url, {headers:{Range:range}, signal});
  let length;
  try {
    length = checkHeaders(response.status, name => response.headers.get(name));
  } catch (error) {
    response.body?.cancel?.().catch(() => {});
    throw error;
  }
  return readResponse(response, length, signal);
}

function xhrRange(url, range, signal, checkHeaders) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    let length;
    function finish(error) {
      signal.removeEventListener('abort', cancel);
      request.onreadystatechange = request.onprogress = request.onload = request.onerror = request.onabort = null;
      if (error) {
        request.abort();
        reject(error);
      } else resolve(new Uint8Array(request.response));
    }
    function cancel() { finish(abortError()); }
    request.open('GET', url);
    request.responseType = 'arraybuffer';
    request.setRequestHeader('Range', range);
    request.onreadystatechange = () => {
      if (request.readyState !== 2) return;
      try { length = checkHeaders(request.status, name => request.getResponseHeader(name)); }
      catch (error) { finish(error); }
    };
    request.onprogress = event => {
      if (event.loaded > length) finish(invalid('Plex transferred more bytes than requested'));
    };
    request.onload = () => finish();
    request.onerror = () => finish(invalid('the Plex byte range request failed'));
    request.onabort = cancel;
    signal.addEventListener('abort', cancel);
    try { request.send(); }
    catch (error) { finish(error); }
  });
}

async function readResponse(response, length, signal) {
  if (!response.body?.getReader) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel);
  try {
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return bytes.subarray(0, offset);
      if (offset + chunk.value.length > length) throw invalid('Plex returned an oversized byte range');
      bytes.set(chunk.value, offset);
      offset += chunk.value.length;
    }
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
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

function subtitleDecoder(bytes, track) {
  const encodings = field(bytes, track, 0x6d80);
  if (!encodings) return (_, data) => decodeText(data);
  const entries = Array.from(children(encodings)).filter(entry => entry.id === 0x6240);
  const encoding = entries[0];
  if (entries.length !== 1 || (uint(encodings, encoding, 0x5033) ?? 0) !== 0)
    throw invalid('the selected track uses unsupported encoding');
  const scope = uint(encodings, encoding, 0x5032) ?? 1;
  const compression = field(encodings, encoding, 0x5034);
  if (!compression || scope < 1 || scope > 3) throw invalid('unsupported compression scope');
  const algorithm = uint(compression, record(compression), 0x4254) ?? 0;
  const settings = field(compression, record(compression), 0x4255);
  if (algorithm !== 0 && (algorithm !== 3 || !settings)) throw invalid('unsupported subtitle compression');
  // Decoding is synchronous. Reuse the bounded scratch space across packets
  // so a track with thousands of sign events does not churn the TV heap.
  const inflateBuffer = algorithm === 0 ? new Uint8Array(MAX_BLOCK + 1) : null;
  return (kind, data) => {
    if (!data || !(kind & scope)) return decodeText(data);
    if (algorithm === 0) {
      const output = unzlibSync(data, {out:inflateBuffer});
      if (output.length > MAX_BLOCK) throw invalid('decompressed subtitle exceeds the size limit');
      return decodeText(output);
    }
    if (data.length + settings.length > MAX_BLOCK) throw invalid('subtitle exceeds the size limit');
    const restored = new Uint8Array(settings.length + data.length);
    restored.set(settings);
    restored.set(data, settings.length);
    return decodeText(restored);
  };
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
  if (field(bytes, track, 0x23314f) || uint(bytes, track, 0x56aa))
    throw invalid('the selected track uses unsupported timing');
  const number = uint(bytes, track, 0xd7);
  if (!number) throw invalid('the selected track has no track number');
  const privateData = field(bytes, track, 0x63a2);
  const decode = subtitleDecoder(bytes, track);
  return {number, decode, header:decode(2, privateData),
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
  if (number.value !== track.number) return null;
  const pos = number.width;
  if (block.length < pos + 4 || block[pos + 2] & 6) throw invalid('unsupported subtitle block layout');
  const time = (block[pos] << 24 >> 16) | block[pos + 1];
  return {time, text:track.decode(1, block.subarray(pos + 3)),
    duration:entry.id === BLOCK_GROUP ? uint(bytes, entry, 0x9b) : undefined};
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

async function scanCluster(read, cluster, cues, track) {
  // CueRelativePosition is optional. Walk the element headers once per
  // cluster and skip large audio/video payloads with byte ranges.
  const matches = new Map();
  const pending = new Map();
  for (const cue of cues) {
    if (!pending.has(cue.time)) pending.set(cue.time, []);
    pending.get(cue.time).push(cue);
  }
  let timestamp;
  let window = new Uint8Array();
  let windowStart = cluster.start;
  async function bytesAt(offset, minimum) {
    if (offset < windowStart || windowStart + window.length < offset + Math.min(minimum, cluster.end - offset)) {
      windowStart = offset;
      window = await read(offset, Math.min(SCAN_WINDOW, cluster.end - offset));
    }
    return window.subarray(offset - windowStart);
  }
  for (let offset = cluster.start, count = 0; offset < cluster.end && matches.size < cues.length; count++) {
    if (count === 8192) throw invalid('subtitle search exceeded the cluster block limit');
    const prefix = await bytesAt(offset, 24);
    const entry = element(prefix, 0);
    if (entry.id === CLUSTER || offset + entry.end > cluster.end)
      throw invalid('indexed frame could not be found in its cluster');
    if (entry.id === 0xe7) timestamp = integer(prefix.subarray(entry.start, entry.end));
    if ([BLOCK_GROUP, SIMPLE_BLOCK].includes(entry.id) && entry.end - entry.start <= MAX_BLOCK) {
      let trackOffset = offset + entry.start;
      if (entry.id === BLOCK_GROUP) {
        while (trackOffset < offset + entry.end) {
          const child = element(await bytesAt(trackOffset, 12), 0);
          if (child.id === BLOCK) { trackOffset += child.start; break; }
          trackOffset += child.end;
        }
      }
      if (trackOffset < offset + entry.end) {
        const header = await bytesAt(trackOffset, 10);
        const number = vint(header, 0, true);
        const pos = number.width;
        const time = timestamp + ((header[pos] << 24 >> 16) | header[pos + 1]);
        const needed = number.value === track.number && pending.get(time);
        if (needed?.length) {
          const bytes = entry.end <= prefix.length ? prefix : await read(offset, entry.end);
          matches.set(needed.shift(), decodeBlock(bytes, entry, track));
        }
      }
    }
    offset += entry.end;
  }
  return matches;
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
  const eventFields = track.ssa ? 'Marked' : 'Layer';
  let header = track.header.replace(/\s+$/, '');
  if (!/^\s*\[Events\]/mi.test(header)) header += '\n\n[Events]';
  if (!/^\[Events\]\s*\r?\n[ \t]*Format:/mi.test(header)) {
    header = header.replace(/^(\s*\[Events\][ \t]*)\r?$/mi, '$1\nFormat: ' + eventFields +
      ', Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');
  }
  const events = frames.map(frame => {
    const packet = /^(\d+),(-?\d*),([\s\S]*)$/.exec(frame.text);
    if (!packet) throw invalid('invalid ASS event packet');
    return {order:Number(packet[1]), line:'Dialogue: ' + (track.ssa ? 'Marked=0' : packet[2] || '0') +
      ',' + timestamp(frame.start, true) + ',' + timestamp(frame.end, true) + ',' + packet[3]};
  });
  return header + '\n' + events.sort((a,b) => a.order - b.order).map(event => event.line).join('\n') + '\n';
}

export async function extractMatroskaSubtitle(asset, signal, {position = 0, preview, onRead, onTiming} = {}) {
  if (asset.format !== 'srt') throw invalid('only embedded SRT is supported');
  const startedAt = onTiming ? Date.now() : 0;
  const native = nativeWebOS();
  const request = rangeReader(asset.partUrl, asset.partSize, signal, onRead, native, onTiming);
  // The TV shares its connection with the video decoder. Serialize SRT
  // range reads so a subtitle request cannot contend with video startup.
  let pending = Promise.resolve();
  const serialize = source => (offset, length) => {
    const next = pending.then(() => source(offset, length));
    pending = next.catch(() => {});
    return next;
  };
  const read = native ? serialize(request) : request;
  const prefix = await read(0, 32 * 1024);
  const ebml = element(prefix, 0);
  if (ebml.id !== 0x1a45dfa3) throw invalid('the Plex part is not an MKV file');
  const segment = element(prefix, ebml.end);
  if (segment.id !== SEGMENT) throw invalid('the Plex part has no Matroska segment');
  const positions = new Map();
  const heads = new Set();
  const complete = () => [INFO, TRACKS, CUES].every(id => positions.has(id));
  const readSeekHead = async offset => {
    heads.add(offset);
    seekPositions(await readMetadata(read, offset, SEEK_HEAD), segment.start, positions);
  };
  for (let offset = segment.start, count = 0; offset < segment.end && count < 128; count++) {
    const entry = element(offset + 12 <= prefix.length ? prefix.subarray(offset) : await read(offset, 12), 0);
    if (entry.id === CLUSTER) break;
    if ([INFO, TRACKS, CUES].includes(entry.id)) positions.set(entry.id, offset);
    if (entry.id === SEEK_HEAD) await readSeekHead(offset);
    offset += entry.end;
    if (complete()) break;
  }
  while (!complete() && heads.size < 16) {
    const offset = positions.get(SEEK_HEAD);
    if (offset === undefined || heads.has(offset)) break;
    await readSeekHead(offset);
  }
  if (!complete()) throw invalid('the file has no usable seek index');
  const [info, tracks, index] = await Promise.all([INFO, TRACKS, CUES].map(id => readMetadata(read, positions.get(id), id)));
  const scale = uint(info, record(info), 0x2ad7b1) ?? 1000000;
  if (!scale) throw invalid('invalid timestamp scale');
  const track = selectedTrack(tracks, asset.streamIndex, asset.format);
  const cues = subtitleCues(index, track.number, segment.start);
  if (onTiming) onTiming('index', Date.now() - startedAt);
  const groups = new Map();
  for (const cue of cues) {
    if (!groups.has(cue.cluster)) groups.set(cue.cluster, []);
    groups.get(cue.cluster).push(cue);
  }
  const frames = [];
  const target = position * 1000000000 / scale;
  const ordered = Array.from(groups.values()).map(group => ({group,
    distance:Math.min(...group.map(cue => Math.abs(cue.time - target)))}))
    .sort((a,b) => a.distance - b.distance);
  async function readGroup({group}) {
    const offset = group[0].cluster;
    const head = element(await read(offset, 12), 0);
    if (head.id !== CLUSTER) throw invalid('cue points outside a cluster');
    const cluster = {start:offset + head.start, end:Math.min(offset + head.end, segment.end)};
    const unpositioned = group.filter(cue => cue.relative === undefined);
    const blocks = unpositioned.length ? await scanCluster(read, cluster, unpositioned, track) : null;
    for (const cue of group) {
      let block = blocks?.get(cue);
      if (cue.relative !== undefined) {
        const location = cluster.start + cue.relative;
        const prefix = await read(location, Math.min(CUE_WINDOW, cluster.end - location));
        const entry = element(prefix, 0);
        if (entry.end > MAX_BLOCK || location + entry.end > cluster.end) throw invalid('invalid indexed subtitle block');
        const bytes = entry.end <= prefix.length ? prefix : await read(location, entry.end);
        block = decodeBlock(bytes, entry, track);
      }
      if (!block) throw invalid('indexed frame did not match the selected track');
      const duration = block.duration ?? cue.duration;
      if (!(duration > 0)) throw invalid('subtitle cue has no duration');
      frames.push({start:cue.time * scale / 1000000, end:(cue.time + duration) * scale / 1000000, text:block.text});
    }
  }
  const initialBatch = 1;
  for (let start = 0, batch = initialBatch; start < ordered.length;) {
    await parallel(ordered.slice(start, start + batch), readGroup);
    start += batch;
    if (preview && start < ordered.length) {
      await preview(formatCaptions(frames, track, false));
    }
    batch = start === initialBatch ? Math.max(12, initialBatch) : Math.max(48, batch * 2);
  }
  if (onTiming) onTiming('complete', Date.now() - startedAt);
  return formatCaptions(frames, track, false);
}
