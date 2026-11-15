// SPDX-License-Identifier: GPL-3.0-only
// Plex's BIF frame index, ported from lib/services/bif_thumbnail_service.dart.
const MAGIC = [0x89, 0x42, 0x49, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];

export function parseBif(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 72 ||
      MAGIC.some((value, index) => bytes[index] !== value)) return null;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = data.getUint32(12, true);
  const multiplier = data.getUint32(16, true) || 1000;
  const tableEnd = 64 + (count + 1) * 8;
  if (!count || tableEnd > bytes.byteLength) return null;
  const frames = [];
  for (let i = 0; i < count; i++) {
    const offset = 64 + i * 8;
    const start = data.getUint32(offset + 4, true);
    const end = data.getUint32(offset + 12, true);
    if (start < tableEnd || end <= start || end > bytes.byteLength) continue;
    frames.push({timestampMs:data.getUint32(offset, true) * multiplier,
      bytes:bytes.subarray(start, end), index:i});
  }
  if (!frames.length) return null;
  frames.sort((a,b) => a.timestampMs - b.timestampMs);
  return frames;
}

export function bifFrameAt(frames, seconds) {
  if (!frames?.length || !Number.isFinite(seconds)) return null;
  const ms = Math.max(0, seconds * 1000);
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) {
    const middle = Math.ceil((lo + hi) / 2);
    if (frames[middle].timestampMs <= ms) lo = middle;
    else hi = middle - 1;
  }
  return frames[lo];
}
