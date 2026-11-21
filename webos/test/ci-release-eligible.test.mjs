import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {decideRelease, isVersionBump} from '../scripts/ci-release-eligible.mjs';

const script = fileURLToPath(new URL('../scripts/ci-release-eligible.mjs', import.meta.url));

test('only an increasing version is eligible for publication', () => {
  assert.equal(decideRelease({version: '1.22.28'}, {version: '1.22.29'}), 'publish');
  assert.equal(isVersionBump('1.22.29', '1.23.0'), true);
  assert.equal(isVersionBump('1.99.99', '2.0.0'), true);
  assert.equal(decideRelease({version: '1.22.29'}, {version: '1.22.29'}), 'skip');
  assert.equal(decideRelease({version: '1.22.29'}, {version: '1.22.28'}), 'skip');
  assert.equal(decideRelease({version: '1.23.0'}, {version: '1.22.99'}), 'skip');
  assert.throws(() => isVersionBump('1.22.28', 'bad'), /Invalid webOS version/);
});

test('release eligibility follows each push boundary in a shallow checkout, including retries', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'plezy-release-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const source = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  mkdirSync(path.join(source, 'webos', 'releases'), {recursive: true});
  const gitAt = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8'}).trim();
  const git = (...args) => gitAt(source, ...args);
  const commit = message => {
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', message);
  };
  const bump = version => {
    writeFileSync(path.join(source, 'webos/package.json'), JSON.stringify({version}) + '\n');
    commit(`version ${version}`);
  };
  const push = () => {
    const before = gitAt(remote, 'rev-parse', 'refs/heads/master');
    git('push', '-q', remote, 'HEAD:refs/heads/master');
    const after = gitAt(remote, 'rev-parse', 'refs/heads/master');
    return [before, after];
  };
  const decidePush = ([before, after]) => {
    const checkout = mkdtempSync(path.join(root, 'checkout-'));
    gitAt(checkout, 'init', '-q');
    gitAt(checkout, 'remote', 'add', 'origin', remote);
    gitAt(checkout, 'fetch', '-q', '--no-tags', '--depth=1', 'origin', after);
    gitAt(checkout, 'checkout', '-q', '--detach', 'FETCH_HEAD');
    gitAt(checkout, 'fetch', '-q', '--no-tags', '--depth=1', 'origin', before);
    return execFileSync(process.execPath, [script, before, after], {
      cwd: checkout, encoding: 'utf8'
    }).trim();
  };
  git('init', '-q', '-b', 'master');
  git('config', 'user.email', 'release-test@example.invalid');
  git('config', 'user.name', 'Release Test');
  bump('1.22.28');
  gitAt(root, 'clone', '-q', '--bare', source, remote);

  bump('1.22.29');
  const singleCommitPush = push();
  commit('same-version follow-up');
  assert.equal(decidePush(push()), 'skip', 'a separate push cannot claim the prior push’s version');
  assert.equal(decidePush(singleCommitPush), 'publish', 'a single-commit bump can publish');

  bump('1.22.30');
  writeFileSync(path.join(source, 'webos/releases/v1.22.30.md'), 'Release notes\n');
  commit('release notes');
  const multiCommitPush = push();
  assert.equal(decidePush(multiCommitPush), 'publish', 'the push includes both a bump and its notes');

  commit('same-version follow-up after multi-commit push');
  assert.equal(decidePush(push()), 'skip', 'the newer same-version push cannot claim the release');
  assert.equal(decidePush(multiCommitPush), 'publish', 'the original push can retry after master moves');
});

test('an unavailable pre-push revision fails release eligibility', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'plezy-release-empty-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  execFileSync('git', ['init', '-q'], {cwd: root});
  for (const before of ['a'.repeat(40), '0'.repeat(40)]) {
    const result = spawnSync(process.execPath, [script, before, 'b'.repeat(40)], {
      cwd: root, encoding: 'utf8'
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Unable to verify release eligibility/);
  }
});
