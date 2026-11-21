import test from 'node:test';
import assert from 'node:assert/strict';
import {selectE2E} from '../scripts/ci-select-e2e.mjs';

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
