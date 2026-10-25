import {build} from 'esbuild';
import {cp, mkdir, rm, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await rm(path.join(root, 'dist'), {recursive: true, force: true});
await mkdir(path.join(root, 'dist'), {recursive: true});
await cp(path.join(root, 'public'), path.join(root, 'dist'), {recursive: true});
await cp(path.join(root, '../LICENSE'), path.join(root, 'dist/LICENSE.txt'));
await build({entryPoints: [path.join(root, 'src/app.js')], bundle: true, target: ['chrome79'], format: 'iife',
  outfile: path.join(root, 'dist/app.js'), minify: true, sourcemap: true, legalComments: 'eof'});
const manifest = JSON.parse(await readFile(path.join(root, 'dist/appinfo.json')));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json')));
if (manifest.version !== pkg.version) throw new Error('Manifest and package version differ.');
console.log('Built Plezy webOS ' + manifest.version + ' for Chromium 79+');
