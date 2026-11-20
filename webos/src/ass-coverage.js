// SPDX-License-Identifier: GPL-3.0-only
// Called on the worker's final composited RGBA buffer. A Bayer threshold
// anchored to screen coordinates keeps the coverage stable as the dirty
// rectangle changes. RGB and completely transparent/opaque pixels are intact.
export function applyAssCoverage(pixels, width, left, top) {
  const ranks = [0,8,2,10, 12,4,14,6, 3,11,1,9, 15,7,13,5];
  let i = 3;
  for (let y = top; i < pixels.length; y++) {
    const row = (y & 3) * 4;
    for (let x = left; x < left + width; x++, i += 4) {
      const alpha = pixels[i];
      if (alpha && alpha !== 255)
        pixels[i] = alpha > 8 + 16 * ranks[row + (x & 3)] ? 255 : 0;
    }
  }
}
