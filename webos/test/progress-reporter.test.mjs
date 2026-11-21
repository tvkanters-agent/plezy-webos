import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ProgressReporter} from '../src/progress-reporter.js';
import {Player} from '../src/player.js';

const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
};

test('slow progress requests coalesce to one latest unsent heartbeat', async () => {
  const first = deferred();
  const calls = [];
  const session = {sessionId: 'one'};
  const reporter = new ProgressReporter({
    report(target, state, position) {
      assert.equal(target, session);
      calls.push([state, position]);
      return calls.length === 1 ? first.promise : Promise.resolve();
    }
  }, session);
  reporter.report('start', 10, 100);
  await tick();
  for (let position = 20; position <= 200; position += 10)
    reporter.report('playing', position, 300);
  assert.deepEqual(calls, [['start', 10]]);
  first.resolve();
  await tick();
  assert.deepEqual(calls, [['start', 10], ['playing', 200]]);
});

test('healthy server sends final stopped position after in-flight start and drops obsolete progress', async () => {
  const first = deferred(), calls = [];
  const reporter = new ProgressReporter({report(session, state, position) {
    calls.push([state, position]);
    return calls.length === 1 ? first.promise : Promise.resolve();
  }}, {});
  reporter.report('start', 0, 500);
  await tick();
  reporter.report('playing', 10, 500);
  reporter.report('paused', 20, 500);
  reporter.stop(23.5, 500);
  assert.deepEqual(calls, [['start', 0]]);
  first.resolve();
  await tick();
  assert.deepEqual(calls, [['start', 0], ['stopped', 23.5]]);
  reporter.report('playing', 99, 500);
  await tick();
  assert.equal(calls.length, 2, 'closed sessions cannot report after stop');
});

test('unreachable server cannot hold the stop report behind a hung request', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const calls = [], first = deferred();
  let oldSignal;
  const reporter = new ProgressReporter({report(session, state, position, duration, signal) {
    calls.push([state, position]);
    if (state === 'start') { oldSignal = signal; return first.promise; }
    return Promise.resolve();
  }}, {});
  reporter.report('start', 0, 100);
  await tick();
  reporter.report('playing', 10, 100);
  reporter.stop(15, 100);
  t.mock.timers.tick(249);
  await tick();
  assert.deepEqual(calls, [['start', 0]]);
  t.mock.timers.tick(1);
  await tick();
  assert.equal(oldSignal.aborted, true);
  assert.deepEqual(calls, [['start', 0], ['stopped', 15]]);
  first.resolve();
  await tick();
  assert.equal(calls.length, 2, 'late requests do not recreate retired progress');
});

test('release never awaits reporting or transcode stop and keeps Simkl stop semantics', async () => {
  const pending = deferred();
  const calls = [];
  const api = {report() {calls.push('report'); return pending.promise;},
    stop() {calls.push('transcode stop'); return pending.promise;}};
  const session = {sessionId: 'old', item: {duration: 100}, transcode: true};
  const player = Object.assign(Object.create(Player.prototype), {
    api, session, generation: 1, reporter: null, video: {
      style: {}, currentTime: 12, pause() {calls.push('pause');},
      removeAttribute() {}, querySelectorAll() {return [];}, load() {calls.push('load');}
    }, item: {duration: 100}, lastPosition: 0,
    root: {classList: {remove() {}}, querySelector() {return null;}},
    showBuffering() {}, hideSeekPreview() {}, track(action) {calls.push(action);}
  });
  player.report('start');
  await tick();
  await player.release(false);
  assert.equal(player.session, null);
  assert.equal(player.generation, 2);
  assert.ok(calls.includes('transcode stop'), 'server teardown must begin immediately');
  assert.ok(calls.includes('stop'), 'Simkl tracking is not tied to reporting');
  assert.ok(calls.includes('load'), 'hardware decoder teardown is not delayed');
  pending.resolve();
});
