// SPDX-License-Identifier: GPL-3.0-only
// LG's splash appears before web app HTML; render Plezy's original SVG at build time.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '@playwright/test';

export const SPLASH_WIDTH = 1920;
export const SPLASH_HEIGHT = 1080;

export function splashBackgroundColor(css) {
  const match = css.match(/html,\s*body\s*\{[^}]*\bbackground:\s*(#[0-9a-fA-F]{6})/);
  if (!match) throw new Error('Cannot find the app background in app.css');
  return match[1];
}

export function splashDocument(logoSvg, background) {
  if (!logoSvg.includes('<svg') || !logoSvg.includes('</svg>'))
    throw new Error('The original Plezy logo SVG is missing');
  if (!/^#[0-9a-fA-F]{6}$/.test(background))
    throw new Error('Invalid splash background');
  // Original viewBox is 358.32×399.86; keep its proportions at 430px high.
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
html, body { margin:0; width:100%; height:100%; overflow:hidden; background:${background}; }
body { display:flex; justify-content:center; align-items:center; }
svg { display:block; width:385.35px; height:430px; flex:none; }
</style></head><body>${logoSvg}</body></html>`;
}

export async function generateSplash(root, destination) {
  const [logo, css] = await Promise.all([
    readFile(path.join(root, '../assets/plezy.svg'), 'utf8'),
    readFile(path.join(root, 'public/app.css'), 'utf8')
  ]);
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage({
      viewport: {width: SPLASH_WIDTH, height: SPLASH_HEIGHT},
      deviceScaleFactor: 1
    });
    await page.setContent(splashDocument(logo, splashBackgroundColor(css)), {waitUntil: 'load'});
    await page.screenshot({path: destination, type: 'png', animations: 'disabled'});
    await page.close();
  } finally {
    await browser.close();
  }
}
