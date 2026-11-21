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

test('version-bump and same-version follow-up have distinct eligibility; rerun is retryable', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'plezy-release-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(path.join(root, 'webos'));
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'});
  const run = () => execFileSync(process.execPath, [script], {cwd: root, encoding: 'utf8'}).trim();
  const writeVersion = version => writeFileSync(
    path.join(root, 'webos/package.json'), JSON.stringify({version}) + '\n');
  git('init', '-q');
  git('config', 'user.email', 'release-test@example.invalid');
  git('config', 'user.name', 'Release Test');
  writeVersion('1.22.28');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  writeVersion('1.22.29');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'version bump');
  const bump = git('rev-parse', 'HEAD').trim();
  assert.equal(run(), 'publish', 'only version-bump revision publishes');
  writeFileSync(path.join(root, 'webos/other.txt'), 'same version follow-up\n');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'follow-up');
  assert.equal(run(), 'skip', 'same-version follow-up must not race version bump');
  git('checkout', '-q', '--detach', bump);
  assert.equal(run(), 'publish', 'a failed version-bump publisher can be rerun');
});

test('missing parent history fails instead of silently permitting publication', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'plezy-release-empty-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(path.join(root, 'webos'));
  writeFileSync(path.join(root, 'webos/package.json'), '{"version":"1.22.29"}');
  const result = spawnSync(process.execPath, [script], {cwd: root, encoding: 'utf8'});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unable to verify release eligibility/);
});
