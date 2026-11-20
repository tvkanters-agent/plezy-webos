import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {assFixture} from './fixtures/matroska.cjs';
import {extractMatroskaSubtitle} from '../src/matroska-subtitles.js';

const movie = await readFile(new URL('./fixtures/embedded-subtitles.mkv', import.meta.url));
const asset = {partUrl:'http://plex.test/library/parts/27/file.mkv', partSize:movie.length};

function serveRanges(t, source = movie, beforeRead = () => {}) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, asset.partUrl);
    const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
    assert.ok(match, 'download a range of the original media, without starting any transcode');
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]) + 1, source.length);
    requests.push({start, end});
    await beforeRead(start);
    return new Response(source.subarray(start, end), {status:206,
      headers:{'Content-Range':'bytes ' + start + '-' + (end - 1) + '/' + source.length}});
  });
  return requests;
}

test('extracts actual indexed SRT and ASS blocks with full-title times and style intact', async t => {
  const requests = serveRanges(t);
  const signal = new AbortController().signal;
  const srt = await extractMatroskaSubtitle({...asset,streamIndex:2,format:'srt'}, signal);
  assert.match(srt, /00:00:02,000 --> 00:00:04,000\nEmbedded SRT/);
  assert.match(srt, /00:00:08,000 --> 00:00:10,000\nSecond SRT/);
  assert.doesNotMatch(srt, /Embedded ASS/);
  assert.ok(requests.some(range => range.start > movie.length * 0.9), 'read the tail index');
  assert.ok(requests.reduce((sum,range) => sum + range.end - range.start, 0) < movie.length,
    'do not fetch all the audio and video blocks');
  const ass = await extractMatroskaSubtitle({...asset,streamIndex:3,format:'ass'}, signal);
  assert.match(ass, /^\[V4\+ Styles\]/m);
  assert.match(ass, /Dialogue: 0,0:00:03\.00,0:00:05\.00,Default,,0,0,0,,\{\\pos\(300,75\)\}Embedded ASS/);
  assert.doesNotMatch(ass, /Embedded SRT/);
});

test('reads compressed MKV ASS without relative cue offsets or a stored Events section', async t => {
  const {source, firstCluster} = assFixture();
  let release;
  let sawPreview;
  const pending = new Promise(resolve => { release = resolve; });
  const preview = new Promise(resolve => { sawPreview = resolve; });
  serveRanges(t, source, start => start === firstCluster ? pending : undefined);
  const reading = extractMatroskaSubtitle({...asset,partSize:source.length,streamIndex:0,format:'ass'},
    new AbortController().signal, {position:160, preview:sawPreview});
  // Playback can already present the resumed cue while early distant clusters
  // are still waiting on the server.
  try {
    const firstCaptions = await Promise.race([preview, reading.then(() => '')]);
    assert.match(firstCaptions, /\[Events\]\nFormat: Layer, Start, End/);
    assert.match(firstCaptions, /0:02:40\.01,0:02:41\.01,Default,,0,0,0,,Subtitle 16/);
    assert.doesNotMatch(firstCaptions, /Subtitle 0\b/);
  } finally {
    release();
  }
  assert.match(await reading, /0:00:00\.01,0:00:01\.01,Default,,0,0,0,,Subtitle 0/);
});

test('refuses mismatched track IDs, ignored ranges and cancellation', async t => {
  serveRanges(t);
  const controller = new AbortController();
  await assert.rejects(extractMatroskaSubtitle({...asset,streamIndex:3,format:'srt'},controller.signal),
    /did not match an MKV track/);
  controller.abort();
  await assert.rejects(extractMatroskaSubtitle({...asset,streamIndex:2,format:'srt'},controller.signal),
    {name:'AbortError'});
  t.mock.restoreAll();
  let bodyRead = false;
  t.mock.method(globalThis, 'fetch', async () => ({status:200,
    arrayBuffer() { bodyRead = true; }}));
  await assert.rejects(extractMatroskaSubtitle({...asset,streamIndex:2,format:'srt'},new AbortController().signal),
    /did not serve a byte range/);
  assert.equal(bodyRead,false,'never try to buffer the whole video on the TV');
});

test('webOS requests one MKV range at a time and cancels the network transfer', async t => {
  const oldWindow = globalThis.window;
  const oldXHR = globalThis.XMLHttpRequest;
  t.after(() => {
    globalThis.window = oldWindow;
    globalThis.XMLHttpRequest = oldXHR;
  });
  globalThis.window = {PalmSystem:{}};
  let active = 0;
  let maximum = 0;
  let aborted = 0;
  let mode = 'partial';
  globalThis.XMLHttpRequest = class {
    open(method, url) {
      assert.equal(method,'GET');
      assert.equal(url,asset.partUrl);
    }
    setRequestHeader(name, value) {
      assert.equal(name,'Range');
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(value);
      this.start = Number(start);
      this.end = Math.min(Number(end), movie.length - 1);
    }
    getResponseHeader(name) {
      return name === 'Content-Range' ? `bytes ${this.start}-${this.end}/${movie.length}` : null;
    }
    send() {
      maximum = Math.max(maximum, ++active);
      if (mode === 'pending') return;
      queueMicrotask(() => {
        this.readyState = 2;
        this.status = mode === 'partial' ? 206 : 200;
        this.onreadystatechange();
        if (!this.onload) return;
        assert.equal(this.responseType,'arraybuffer');
        this.response = Uint8Array.from(movie.subarray(this.start,this.end + 1)).buffer;
        --active;
        this.onload();
      });
    }
    abort() { --active; ++aborted; }
  };
  const track = {...asset, streamIndex:2, format:'srt'};
  const controller = new AbortController();
  assert.match(await extractMatroskaSubtitle(track,controller.signal), /Embedded SRT/);
  assert.equal(maximum,1);
  mode = 'whole file';
  await assert.rejects(extractMatroskaSubtitle(track,controller.signal), /HTTP 200/);
  assert.equal(aborted,1,'abort an ignored Range as soon as response headers arrive');
  mode = 'pending';
  const reading = extractMatroskaSubtitle(track,controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(reading,{name:'AbortError'});
  assert.equal(aborted,2);
  assert.equal(active,0);
});
