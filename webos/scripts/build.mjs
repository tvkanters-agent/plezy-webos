import {build} from 'esbuild';
import {VERSION} from '../src/core.js';
import {cp, mkdir, rm, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await rm(path.join(root, 'dist'), {recursive: true, force: true});
await mkdir(path.join(root, 'dist'), {recursive: true});
await cp(path.join(root, 'public'), path.join(root, 'dist'), {recursive: true});
await cp(path.join(root, '../LICENSE'), path.join(root, 'dist/LICENSE.txt'));
// Lower syntax further than the nominal webOS 6 (Chromium 79) engine. Older
// LG webOS WebAppManager engines reject newer constructs while Chromium 134
// Playwright tests pass. This does not promise support below webOS 6: browser
// APIs and native codec support are separate from JavaScript syntax.
await build({entryPoints: [path.join(root, 'src/app.js')], bundle: true, target: ['chrome53'], format: 'iife',
  outfile: path.join(root, 'dist/app.js'), minify: true, sourcemap: true, legalComments: 'eof'});
const manifest = JSON.parse(await readFile(path.join(root, 'dist/appinfo.json')));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json')));
if (manifest.version !== pkg.version || VERSION !== pkg.version) throw new Error('Manifest, runtime and package versions must match.');
console.log('Built Plezy webOS ' + manifest.version + ' with Chromium 53-compatible JavaScript syntax (webOS 6+ target)');
