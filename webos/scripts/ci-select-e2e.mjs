import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// Only isolated feature modules may omit unrelated browser suites.
// Everything shared, unknown, or involved in building the app runs full E2E.
const scoped = new Map([
  ['webos/src/alpha-bar.js', ['alpha-bar', 'collection']],
  ['webos/src/library-alpha.js', ['alpha-bar', 'collection']],
  ['webos/src/library-prefix-alpha.js', ['alpha-bar', 'collection']],
  ['webos/src/chapters.js', ['playback', 'episode-menus']],
  ['webos/src/skip-markers.js', ['playback', 'episode-menus']],
  ['webos/src/scrub-preview.js', ['playback']],
  ['webos/src/shuffle.js', ['shuffle', 'detail-back-restore']],
  ['webos/src/collection-merge.js', ['collection', 'alpha-bar']],
  ['webos/src/subtitle-style.js', ['playback', 'settings', 'episode-menus']],
  ['webos/src/pixi-subtitles.js', ['playback', 'settings', 'episode-menus']]
]);

const full = () => ({mode: 'full', specs: []});
export function selectE2E(files) {
  if (!Array.isArray(files) || !files.length) return full();
  const specs = new Set();
  for (const name of files) {
    if (/^webos\/[^/]+\.md$/.test(name) ||
        /^webos\/releases\/[^/]+\.md$/.test(name) ||
        name === 'webos/.gitignore' || name === 'AGENTS.md') continue;
    if (/^webos\/test\/[^/]+\.test\.mjs$/.test(name)) continue;
    if (/^webos\/test\/[a-z0-9-]+\.spec\.cjs$/.test(name)) {
      specs.add('test/' + path.basename(name));
      continue;
    }
    if (scoped.has(name)) {
      for (const suite of scoped.get(name)) specs.add('test/' + suite + '.spec.cjs');
      continue;
    }
    return full();
  }
  if (!specs.size) return {mode: 'skip', specs: []};
  specs.add('test/app.spec.cjs');
  return {mode: 'targeted', specs: [...specs].sort()};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let selected = full();
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    try {
      // GitHub's PR checkout is a merge commit; HEAD^1 is the base.
      // --no-renames prevents hiding a changed source through a rename.
      const changed = execFileSync('git',
        ['diff', '--no-renames', '--name-only', 'HEAD^1', 'HEAD'],
        {encoding: 'utf8', maxBuffer: 1024 * 1024});
      selected = selectE2E(changed.split('\n').filter(Boolean));
      if (selected.specs.some(file => !existsSync(file))) selected = full();
    } catch (err) {
      console.error('PR diff unavailable: using full E2E (' + err.message + ')');
    }
  }
  process.stdout.write('mode=' + selected.mode + '\n');
  process.stdout.write('specs=' + selected.specs.join(' ') + '\n');
  console.error('Browser E2E selection: ' + selected.mode +
    (selected.specs.length ? ' ' + selected.specs.join(', ') : ''));
}
