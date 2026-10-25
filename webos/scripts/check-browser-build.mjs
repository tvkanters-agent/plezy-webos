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
try {
  // Parse the packaged bundle and EVERY inline bootstrap script in the exact
  // HTML we ship; a malformed diagnostic script is still a boot failure.
  new Script(script, {filename: 'dist/app.js'});
  // The shipped boot diagnostics live in an untyped inline classic script.
  // Inspect the exact HTML bytes, too: a syntax failure there is fatal.
  var open = '<script>', close = '</script>', pos = 0, count = 0;
  while ((pos = html.indexOf(open, pos)) !== -1) {
    var from = pos + open.length, to = html.indexOf(close, from);
    if (to === -1) throw new Error('Unterminated inline script');
    new Script(html.substring(from, to), {filename: 'dist/index.html:inline:' + (++count)});
    pos = to + close.length;
  }
  if (!count) throw new Error('No inline startup diagnostic script found.');
} catch (error) {
  throw new Error('Packaged JavaScript could not be parsed: ' + error.message);
}
console.log('Verified ' + appinfo.id + ' ' + appinfo.version + ': classic IIFE bundle (' + script.length + ' bytes).');
