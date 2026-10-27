// SPDX-License-Identifier: GPL-3.0-only
// Favor first-screen snapshots, then evict deep-scroll entries by last use.
// Disk cache is byte bounded, never title-count or page-count bounded.
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

// navigator.storage.estimate() is not available on all supported LG TVs.
// Use a generous fallback, then rely on the IndexedDB quota-exceeded retry.
// Reserve quota for unrelated app data and the other catalog/artwork store.
export async function preferredDiskBudget(fallbackBytes, quotaFraction) {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage &&
        typeof navigator.storage.estimate === 'function') {
      const estimate = await navigator.storage.estimate();
      const quota = Number(estimate && estimate.quota);
      if (Number.isFinite(quota) && quota > 0)
        return Math.max(0, Math.min(fallbackBytes, Math.floor(quota * quotaFraction)));
    }
  } catch (_) { /* Older webOS may not expose quota estimates. */ }
  return fallbackBytes;
}

// On real quota failure, evict a meaningful portion of actual stored bytes
// regardless of the optional estimate: the reported quota can be inaccurate.
export function quotaRecoveryTarget(totalBytes, regularBudget, minimumReclaim) {
  return Math.max(0, Math.min(regularBudget,
    totalBytes - Math.max(minimumReclaim, Math.ceil(totalBytes / 4))));
}
