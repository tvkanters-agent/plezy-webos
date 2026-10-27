import {build} from 'esbuild';
import {VERSION} from '../src/core.js';
import {generateSplash} from './splash.mjs';
import {cp, mkdir, rm, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await rm(path.join(root, 'dist'), {recursive: true, force: true});
await mkdir(path.join(root, 'dist'), {recursive: true});
await cp(path.join(root, 'public'), path.join(root, 'dist'), {recursive: true});
await cp(path.join(root, '../LICENSE'), path.join(root, 'dist/LICENSE.txt'));
// Prepare LG's native loading image before packaging, not at TV startup.
await generateSplash(root, path.join(root, 'dist/splash.png'));

// The primary hardware target is webOS 4.4.3 (Chromium 53). Modern desktop
// Playwright does not expose its missing APIs, so bundle syntax must be
// downlevelled and runtime polyfills are loaded from src/compat.js.
// Actual TV media decoding and network behavior still require device tests.
await build({entryPoints: [path.join(root, 'src/app.js')], bundle: true, target: ['chrome53'], format: 'iife',
  outfile: path.join(root, 'dist/app.js'), minify: true, sourcemap: true, legalComments: 'eof'});
const manifest = JSON.parse(await readFile(path.join(root, 'dist/appinfo.json')));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json')));
if (manifest.version !== pkg.version || VERSION !== pkg.version) throw new Error('Manifest, runtime and package versions must match.');
console.log('Built Plezy webOS ' + manifest.version + ' with Chromium 53-compatible JavaScript syntax (webOS 4.x+ target)');
