import {build} from 'esbuild';
import {VERSION} from '../src/core.js';
import {generateSplash} from './splash.mjs';
import {cp, mkdir, rm, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await rm(path.join(root, 'dist'), {recursive: true, force: true});
await mkdir(path.join(root, 'dist'), {recursive: true});
await cp(path.join(root, 'public'), path.join(root, 'dist'), {recursive: true});
// Pack workers as load-on-demand classic scripts. A packaged file:// page
// can load sibling scripts but Chromium may refuse a sibling Worker URL.
const vendor = path.join(root, 'node_modules/libass-wasm/dist/js');
const libass = path.join(root, 'dist/libass');
for (const name of ['subtitles-octopus.js', 'COPYRIGHT'])
  await cp(path.join(vendor, name), path.join(libass, name));
const fallbackFont = await readFile(path.join(libass, 'default.woff2'));
if (fallbackFont.toString('ascii', 0, 4) !== 'wOF2')
  throw new Error('The bundled libass fallback font is missing or invalid.');
function binaryExpression(bytes) {
  return 'Uint8Array.from(atob(' + JSON.stringify(bytes.toString('base64')) +
    '), function(c) { return c.charCodeAt(0); })';
}
for (const legacy of [false, true]) {
  const worker = 'subtitles-octopus-worker' + (legacy ? '-legacy' : '');
  let source = await readFile(path.join(vendor, worker + '.js'), 'utf8');
  if (!legacy) {
    const wasm = await readFile(path.join(vendor, worker + '.wasm'));
    source = 'var Module = {wasmBinary:' + binaryExpression(wasm) + '};\n' + source;
  }
  // Workers launched by file-origin apps cannot reliably XHR even sibling
  // blob URLs. Install the bundled default font into libass's own filesystem.
  source += '\nvar loadExtraFont = self.loadFontFile;\n' +
    'self.loadFontFile = function(id, path) {\n' +
    '  if (path !== "default.woff2") return loadExtraFont(id, path);\n' +
    '  Module.FS_createDataFile("/fonts", id + path, ' + binaryExpression(fallbackFont) + ', true, false);\n};';
  const script = 'window.plezyAssAssets = {workerUrl: URL.createObjectURL(new Blob([' +
    JSON.stringify(source) + '], {type:"text/javascript"}))};\n';
  await writeFile(path.join(libass, worker + '-assets.js'), script);
}
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
