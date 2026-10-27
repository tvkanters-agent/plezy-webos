// SPDX-License-Identifier: GPL-3.0-only
// Evict based on actual stored bytes, protecting landing-page snapshots before
// deep-scroll pages. Neither title count nor age alone makes an entry expire.
export function evictionsForBudget(entries, maxBytes) {
  let size = entries.reduce((sum, entry) => sum + Math.max(0, Number(entry.bytes) || 0), 0);
  if (size <= maxBytes) return [];
  const victims = [];
  for (const entry of entries.slice().sort((a, b) =>
    Number(!!a.priority) - Number(!!b.priority) ||
    (Number(a.used) || 0) - (Number(b.used) || 0))) {
    if (size <= maxBytes) break;
    victims.push(entry.key);
    size -= Math.max(0, Number(entry.bytes) || 0);
  }
  return victims;
}
