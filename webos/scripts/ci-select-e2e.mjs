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


// Version-only release metadata must not force full E2E for an isolated fix.
// Compare whole JSON objects after masking ONLY the package/app version fields;
// any dependency, manifest, or other content change requires full coverage.
export function isVersionOnlyContent(file, before, after) {
  if (before === after) return false;
  if (file === 'webos/src/core.js') {
    const re = /(export const VERSION\s*=\s*')\d+\.\d+\.\d+(';)/;
    if (!re.test(before) || !re.test(after)) return false;
    return before.replace(re, '$1VERSION_ONLY$2') ===
      after.replace(re, '$1VERSION_ONLY$2');
  }
  if (!['webos/package.json', 'webos/package-lock.json',
    'webos/public/appinfo.json'].includes(file)) return false;
  try {
    const a = JSON.parse(before), b = JSON.parse(after);
    const semver = /^\d+\.\d+\.\d+$/;
    if (!semver.test(a.version) || !semver.test(b.version) ||
        a.version === b.version) return false;
    if (file === 'webos/package-lock.json') {
      if (!a.packages || !b.packages || !a.packages[''] || !b.packages[''] ||
          a.packages[''].version !== a.version ||
          b.packages[''].version !== b.version) return false;
      a.packages[''].version = b.packages[''].version = 'VERSION_ONLY';
    }
    a.version = b.version = 'VERSION_ONLY';
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (_) {
    return false;
  }
}
const releaseVersionFiles = [
  'webos/package.json', 'webos/package-lock.json',
  'webos/src/core.js', 'webos/public/appinfo.json'
];

const full = () => ({mode: 'full', specs: []});
export function selectE2E(files, versionOnlyPaths = new Set()) {
  if (!Array.isArray(files) || !files.length) return full();
  const specs = new Set();
  for (const name of files) {
    if (versionOnlyPaths.has(name)) continue;
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
      const paths = changed.split('\n').filter(Boolean);
      const versionOnly = new Set();
      for (const file of paths) {
        if (!releaseVersionFiles.includes(file)) continue;
        try {
          const oldContent = execFileSync('git', ['show', 'HEAD^1:' + file],
            {encoding: 'utf8', maxBuffer: 1024 * 1024});
          const newContent = execFileSync('git', ['show', 'HEAD:' + file],
            {encoding: 'utf8', maxBuffer: 1024 * 1024});
          if (isVersionOnlyContent(file, oldContent, newContent))
            versionOnly.add(file);
        } catch (_) { /* Deleted/renamed files must force full coverage. */ }
      }
      selected = selectE2E(paths, versionOnly);
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
