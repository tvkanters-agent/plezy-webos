import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {splashDocument, splashBackgroundColor, SPLASH_WIDTH, SPLASH_HEIGHT} from '../scripts/splash.mjs';

test('native splash uses the upstream logo and real app theme', async () => {
  const css = await readFile(new URL('../public/app.css', import.meta.url), 'utf8');
  const logo = await readFile(new URL('../../assets/plezy.svg', import.meta.url), 'utf8');
  const color = splashBackgroundColor(css);
  assert.equal(color, '#0e0f12');
  const html = splashDocument(logo, color);
  assert.ok(html.includes(logo));
  assert.match(html, /linearGradient/);
  assert.match(html, /background:#0e0f12/);
  assert.equal(SPLASH_WIDTH, 1920);
  assert.equal(SPLASH_HEIGHT, 1080);
  assert.throws(() => splashDocument('<p>not a logo</p>', color), /missing/);
});
