// SPDX-License-Identifier: GPL-3.0-only
// Verify that the file shipped as a classic <script> is a real bundle, not
// src/app.js (whose "import { ... }" is invalid inside a classic script).
import {readFile} from 'node:fs/promises';
import {Script} from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = await readFile(path.join(root, 'dist/app.js'), 'utf8');
const html = await readFile(path.join(root, 'dist/index.html'), 'utf8');
const appinfo = JSON.parse(await readFile(path.join(root, 'dist/appinfo.json'), 'utf8'));

if (!html.includes('<script src="app.js" defer')) {
  throw new Error('TV HTML does not load the bundled classic script.');
}
if (!script.includes('(() => {') && !script.includes('(()=>{') && !script.includes('(function()')) {
  throw new Error('Expected an IIFE bundle; refusing to package possibly unbundled modules.');
}
if (/^(?:\\s*)(?:import\\s*[{*]|export\\s+(?:\\{|\\*|default|class|function|const))/m.test(script)) {
  throw new Error('ES module syntax found in classic TV bundle.');
}
try {
  new Script(script, {filename: 'dist/app.js'});
} catch (error) {
  throw new Error('Bundled classic script could not be parsed: ' + error.message);
}
console.log('Verified ' + appinfo.id + ' ' + appinfo.version + ': classic IIFE bundle (' + script.length + ' bytes).');
