import test from 'node:test';
import assert from 'node:assert/strict';
import {selectE2E, isVersionOnlyContent} from '../scripts/ci-select-e2e.mjs';

test('missing diffs and shared/unknown files require full browser tests', () => {
  assert.equal(selectE2E([]).mode, 'full');
  for (const file of ['webos/src/app.js', 'webos/src/player.js',
    'webos/src/api.js', 'webos/src/core.js', 'webos/src/catalog-cache.js',
    'webos/public/index.html', 'webos/package.json', 'webos/scripts/build.mjs',
    '.github/workflows/webos.yml', 'webos/test/fixtures/test.webm']) {
    assert.equal(selectE2E([file]).mode, 'full', file);
  }
});

test('documentation and isolated unit test edits can skip browser E2E', () => {
  assert.deepEqual(selectE2E(['AGENTS.md', 'webos/CHANGELOG.md',
    'webos/releases/v1.23.0.md', 'webos/test/shuffle.test.mjs']),
    {mode: 'skip', specs: []});
});

test('scoped modules select related suites plus the application smoke test', () => {
  assert.deepEqual(selectE2E(['webos/src/shuffle.js']), {
    mode: 'targeted', specs: ['test/app.spec.cjs',
      'test/detail-back-restore.spec.cjs', 'test/shuffle.spec.cjs']
  });
  assert.deepEqual(selectE2E(['webos/src/chapters.js', 'webos/src/subtitle-style.js']), {
    mode: 'targeted', specs: ['test/app.spec.cjs', 'test/episode-menus.spec.cjs',
      'test/playback.spec.cjs', 'test/settings.spec.cjs']
  });
});

test('edited E2E specs are tested, while mixed shared changes force full coverage', () => {
  assert.deepEqual(selectE2E(['webos/test/playback.spec.cjs',
    'webos/test/player-buffering.test.mjs']), {
    mode: 'targeted', specs: ['test/app.spec.cjs', 'test/playback.spec.cjs']
  });
  assert.equal(selectE2E(['webos/src/shuffle.js', 'webos/src/app.js']).mode, 'full');
  assert.equal(selectE2E(['webos/test/playback.spec.cjs',
    'webos/src/core.js']).mode, 'full');
});

test('version-only release metadata does not override isolated changes', () => {
  const files = ['webos/src/shuffle.js', 'webos/package.json',
    'webos/package-lock.json', 'webos/src/core.js',
    'webos/public/appinfo.json', 'webos/CHANGELOG.md'];
  const versions = new Set(files.slice(1, 5));
  assert.deepEqual(selectE2E(files, versions), {
    mode: 'targeted', specs: ['test/app.spec.cjs',
      'test/detail-back-restore.spec.cjs', 'test/shuffle.spec.cjs']
  });
  assert.equal(selectE2E(files).mode, 'full');
});

test('only actual version changes in whole metadata objects are exempt', () => {
  const pkgOld = '{"version":"1.22.17","dependencies":{"fflate":"0.8.2"}}';
  const pkgNew = '{"version":"1.22.18","dependencies":{"fflate":"0.8.2"}}';
  assert.equal(isVersionOnlyContent('webos/package.json', pkgOld, pkgNew), true);
  assert.equal(isVersionOnlyContent('webos/package.json', pkgOld,
    '{"version":"1.22.18","dependencies":{"fflate":"0.9.0"}}'), false);
  const lockOld = '{"version":"1.22.17","packages":{"":{"version":"1.22.17"},"node_modules/foo":{"version":"1.0.0"}}}';
  const lockNew = '{"version":"1.22.18","packages":{"":{"version":"1.22.18"},"node_modules/foo":{"version":"1.0.0"}}}';
  assert.equal(isVersionOnlyContent('webos/package-lock.json', lockOld, lockNew), true);
  assert.equal(isVersionOnlyContent('webos/package-lock.json', lockOld,
    lockNew.replace('"1.0.0"', '"2.0.0"')), false);
  assert.equal(isVersionOnlyContent('webos/public/appinfo.json',
    '{"version":"1.22.17","id":"plezy"}',
    '{"version":"1.22.18","id":"plezy"}'), true);
  assert.equal(isVersionOnlyContent('webos/public/appinfo.json',
    '{"version":"1.22.17","id":"plezy"}',
    '{"version":"1.22.18","id":"other"}'), false);
});

test('only the core version constant can change in version-only core diffs', () => {
  const before = "export const VERSION = '1.22.17';\nexport function play() { return 1; }\n";
  const after = "export const VERSION = '1.22.18';\nexport function play() { return 1; }\n";
  assert.equal(isVersionOnlyContent('webos/src/core.js', before, after), true);
  assert.equal(isVersionOnlyContent('webos/src/core.js', before,
    after.replace('return 1', 'return 2')), false);
  assert.equal(isVersionOnlyContent('webos/src/core.js', before, before), false);
});
