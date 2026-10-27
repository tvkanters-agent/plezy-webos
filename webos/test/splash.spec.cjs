const {test, expect} = require('@playwright/test');
const {readFileSync} = require('node:fs');
const path = require('node:path');

test('LG splash is a dark 1920x1080 native PNG with the Plezy mark', async ({page}) => {
  const root = path.resolve(__dirname, '../dist');
  const manifest = JSON.parse(readFileSync(path.join(root, 'appinfo.json'), 'utf8'));
  expect(manifest.splashBackground).toBe('splash.png');
  const png = readFileSync(path.join(root, manifest.splashBackground));
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(png.readUInt32BE(16)).toBe(1920);
  expect(png.readUInt32BE(20)).toBe(1080);
  const sample = await page.evaluate(async base64 => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + base64;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixel = (x, y) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3);
    let colored = false;
    for (let y = 330; y < 750 && !colored; y += 15) {
      for (let x = 770; x < 1150; x += 15) {
        if (pixel(x, y)[0] > 100) { colored = true; break; }
      }
    }
    return {corner: pixel(0, 0), bottom: pixel(1919, 1079), colored};
  }, png.toString('base64'));
  expect(sample.corner).toEqual([14, 15, 18]);
  expect(sample.bottom).toEqual(sample.corner);
  expect(sample.colored).toBe(true);
});
