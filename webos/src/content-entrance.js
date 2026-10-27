// SPDX-License-Identifier: GPL-3.0-only
// Avoid fading pages whose data arrived before the first noticeable loading gap.
// Artwork has its own independent ready-from-cache / async-fade lifecycle.
export const CONTENT_FADE_DELAY_MS = 120;
export function fadeDelayedContent(node, startedAt, now = Date.now()) {
  if (now - startedAt >= CONTENT_FADE_DELAY_MS) node.classList.add('content-enter');
  return node;
}
