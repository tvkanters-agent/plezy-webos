import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {extractMatroskaSubtitle} from '../src/matroska-subtitles.js';

const movie = await readFile(new URL('./fixtures/embedded-subtitles.mkv', import.meta.url));
const asset = {partUrl:'http://plex.test/library/parts/27/file.mkv', partSize:movie.length};

function serveRanges(t) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, asset.partUrl);
    const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
    assert.ok(match, 'download a range of the original media, without starting any transcode');
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]) + 1, movie.length);
    requests.push({start, end});
    return new Response(movie.subarray(start, end), {status:206,
      headers:{'Content-Range':'bytes ' + start + '-' + (end - 1) + '/' + movie.length}});
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
