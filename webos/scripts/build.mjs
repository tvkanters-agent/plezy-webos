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
// Load PixiJS 4 only on first local SRT/VTT cue, never in compatibility mode.
// Its prebuilt browser bundle also avoids pulling browser-only globals into
// Node's subtitle/unit-test import graph.
await cp(path.join(root, 'node_modules/pixi.js/dist/pixi.min.js'),path.join(root,'dist/pixi.min.js'));
await cp(path.join(root, 'node_modules/pixi.js/LICENSE'),path.join(root,'dist/pixi-LICENSE.txt'));
// Pack workers as load-on-demand classic scripts. A packaged file:// page
// can load sibling scripts but Chromium may refuse a sibling Worker URL.
const vendor = path.join(root, 'node_modules/libass-wasm/dist/js');
const libass = path.join(root, 'dist/libass');
await cp(path.join(vendor, 'COPYRIGHT'),path.join(libass,'COPYRIGHT'));
// Version the runtime filenames: webOS can retain the *old* classic script
// cache across IPK upgrades, and stale chunks must never enter a new worker.
const versionedLibass = path.join(libass, 'v' + VERSION);
await mkdir(versionedLibass, {recursive:true});
// Preserve the full libass runtime across playback without leaving an idle
// worker subscribed to subsequent videos. The upstream wrapper's handlers
// are closures, so expose narrowly scoped suspend/resume hooks at build time.
let octopus = await readFile(path.join(vendor,'subtitles-octopus.js'),'utf8');
const disposeAnchor = '    self.dispose = function () {';
if (!octopus.includes(disposeAnchor)) throw new Error('SubtitlesOctopus video lifecycle changed');
// Upstream compares CSS lengths ('0px') to numbers (0), causing needless
// canvas.width assignments on every resize. Assigning width clears the
// rendered ASS frame even when geometry is unchanged (visible flicker).
const geometryAnchor = 'self.canvas.style.top != top ||\n          self.canvas.style.left != left';
if (!octopus.includes(geometryAnchor)) throw new Error('SubtitlesOctopus resize API changed');
octopus = octopus.replace(geometryAnchor,
  'parseFloat(self.canvas.style.top) != top ||\\n          parseFloat(self.canvas.style.left) != left'.replace('\\n','\n'));
const canvasSizeAnchor = 'self.canvas.width = width;\n            self.canvas.height = height;';
if (!octopus.includes(canvasSizeAnchor)) throw new Error('SubtitlesOctopus canvas sizing changed');
octopus = octopus.replace(canvasSizeAnchor,
  'if (self.canvas.width !== width) self.canvas.width = width;\n' +
  '            if (self.canvas.height !== height) self.canvas.height = height;');
// Two valid canvas updates may have the same Date.now() millisecond value.
// Upstream's strict < check drops the latter, including the only empty frame
// that should clear a paused-seek subtitle. Worker messages already arrive
// in order for the non-lossy render mode; accept equal timestamps.
const canvasFrameAnchor = "case 'renderCanvas': {\\n                        if (self.lastRenderTime < data.time) {".replace('\\n','\n');
if (!octopus.includes(canvasFrameAnchor)) throw new Error('SubtitlesOctopus frame dispatch changed');
octopus = octopus.replace(canvasFrameAnchor,
  canvasFrameAnchor.replace('self.lastRenderTime < data.time','self.lastRenderTime <= data.time'));
octopus = octopus.replace(disposeAnchor, `    // Plezy supplies its own authoritative timestamp, buffering and seek
    // state. The vendor's video listeners send *additional*, uncorrected
    // timestamps that can rewind libass and flash subtitle frames.
    // Keep resize/metadata handlers active; only remove clock listeners.
    self.plezyUseExternalClock = function () {
        if (self._plezySuspended || !self.video) return;
        for (var pair of [['timeupdate',onTimeUpdate],['playing',onPlaying],['pause',onPause],
            ['seeking',onSeeking],['seeked',onSeeked],['ratechange',onRateChange],
            ['waiting',onWaiting]])
            self.video.removeEventListener(pair[0],pair[1],false);
    };
    self.plezySuspendVideo = function () {
        if (self._plezySuspended || !self.video) return;
        self._plezySuspended = true;
        for (var pair of [['timeupdate',onTimeUpdate],['playing',onPlaying],['pause',onPause],
            ['seeking',onSeeking],['seeked',onSeeked],['ratechange',onRateChange],
            ['waiting',onWaiting],['loadedmetadata',onLoadedMetadata]])
            self.video.removeEventListener(pair[0],pair[1],false);
        for (var event of ['fullscreenchange','mozfullscreenchange','webkitfullscreenchange','msfullscreenchange'])
            document.removeEventListener(event,self.resizeWithTimeout,false);
        window.removeEventListener('resize',self.resizeWithTimeout,false);
        if (self.ro) self.ro.disconnect();
    };
    self.plezyResumeVideo = function () {
        if (!self._plezySuspended || !self.video) return;
        self._plezySuspended = false;
        for (var pair of [['timeupdate',onTimeUpdate],['playing',onPlaying],['pause',onPause],
            ['seeking',onSeeking],['seeked',onSeeked],['ratechange',onRateChange],
            ['waiting',onWaiting]])
            self.video.addEventListener(pair[0],pair[1],false);
        for (var event of ['fullscreenchange','mozfullscreenchange','webkitfullscreenchange','msfullscreenchange'])
            document.addEventListener(event,self.resizeWithTimeout,false);
        window.addEventListener('resize',self.resizeWithTimeout,false);
        if (self.ro) self.ro.observe(self.video);
        self.resize();
    };
` + disposeAnchor);
await writeFile(path.join(versionedLibass,'subtitles-octopus.js'),octopus);
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
  // Handle Plezy's authoritative media clock in the narrow existing worker
  // adapter below. Do not patch vendor source formatting: different compiled
  // legacy/wasm worker variants may place these operations differently.
  // Workers launched by file-origin apps cannot reliably XHR even sibling
  // blob URLs. Install the bundled default font into libass's own filesystem.
  source += '\nvar loadExtraFont = self.loadFontFile;\n' +
    'self.loadFontFile = function(id, path) {\n' +
    '  if (path && path.bytes instanceof Uint8Array) {\n' +
    '    Module.FS_createDataFile("/fonts", id + path.name, path.bytes, true, false); return;\n  }\n' +
    '  if (path !== "default.woff2") return loadExtraFont(id, path);\n' +
    '  Module.FS_createDataFile("/fonts", id + path, ' + binaryExpression(fallbackFont) + ', true, false);\n};';
  // libass-wasm 4.x exposes createEvent, but its public wrapper posts one
  // message per event. Append a batch to the existing track instead of
  // reparsing an ever-growing ASS script on every extracted MKV cluster.
  source += '\nvar originalAssWorkerMessage = self.onmessage;\n' +
    'self.onmessage = function(message) {\n' +
    '  if (message.data.target === "video") {\n' +
    '    // Apply state before the timestamp so seek frames never use an old rate/pause flag.\n' +
    '    if (message.data.rate) self.rate = message.data.rate;\n' +
    '    if (message.data.isPaused !== undefined) self.setIsPaused(message.data.isPaused);\n' +
    '    if (message.data.currentTime !== undefined) {\n' +
    '      var position = message.data.currentTime;\n' +
    '      if (message.data.senderTime && message.data.isPaused === false)\n' +
    '        position += Math.max(0, Date.now() - message.data.senderTime) / 1000 * (message.data.rate || self.rate);\n' +
    '      self.setCurrentTime(position);\n' +
    '    }\n' +
    '    return;\n' +
    '  }\n' +
    '  if (message.data.target === "plezy-force-frame") { self.getRenderMethod()(true); return; }\n' +
    '  if (message.data.target !== "create-events") return originalAssWorkerMessage(message);\n' +
    '  var events = message.data.events;\n' +
    '  for (var i = 0; i < events.length; i++) {\n' +
    '    var index = self.octObj.allocEvent(), target = self.octObj.track.get_events(index);\n' +
    '    var event = events[i];\n' +
    '    for (var key in event) if (Object.prototype.hasOwnProperty.call(event, key)) target[key] = event[key];\n' +
    '  }\n' +
    '};\n';
  // A single multi-megabyte script literal blocks input while a C8 parses it
  // and encodes it into a Blob. Yield between bounded classic-script loads.
  let count = 0;
  for (let start = 0; start < source.length;) {
    let end = Math.min(start + 256 * 1024, source.length);
    if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1])) end--;
    const piece = JSON.stringify(source.slice(start, end));
    await writeFile(path.join(versionedLibass, worker + '-' + count + '.js'),
      'window.plezyAssParts[' + count + '] = new Blob([' + piece + ']);\n');
    count++;
    start = end;
  }
  await writeFile(path.join(versionedLibass, worker + '-assets.js'), 'window.plezyAssPartCount = ' + count + ';\n');
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
