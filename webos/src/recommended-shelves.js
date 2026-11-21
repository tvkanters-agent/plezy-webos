// SPDX-License-Identifier: GPL-3.0-only
// Reconcile Plex Recommended hubs without remounting unaffected shelves,
// cards or decoded artwork. Hub identifiers are preferred over headings;
// cached hubs without identifiers are matched by title and occurrence.
function reconcileCards(row, items, makeCard) {
  const byId = new Map();
  Array.from(row.children).forEach(node => {
    const key = node.dataset.focus;
    if (!byId.has(key)) byId.set(key, []);
    byId.get(key).push(node);
  });
  const next = items.map(item => {
    const key = String(item.id), signature = JSON.stringify(item);
    const previous = byId.get(key)?.shift();
    if (previous && previous._catalogSignature === signature) return previous;
    const node = makeCard(item);
    node._catalogSignature = signature;
    return node;
  });
  const wanted = new Set(next);
  Array.from(row.children).forEach(node => {
    if (!wanted.has(node)) node.remove();
  });
  // Work backwards so already correctly ordered nodes never get detached.
  let following = null;
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].parentNode !== row || next[i].nextSibling !== following)
      row.insertBefore(next[i], following);
    following = next[i];
  }
}

export function reconcileRecommendedShelves(anchor, mounted, shelves, makeCard) {
  const parent = anchor.parentNode, doc = anchor.ownerDocument;
  const used = new Set(), next = [], scroll = new Map();
  mounted.forEach(section => {
    if (section.classList.contains('shelf'))
      scroll.set(section, section.querySelector('.cards').scrollLeft);
  });
  for (const shelf of shelves) {
    const id = shelf.id == null ? '' : String(shelf.id);
    let section = id && mounted.find(node => !used.has(node) &&
      node.classList.contains('shelf') && node._recommendedId === id);
    if (!section) section = mounted.find(node => !used.has(node) &&
      node.classList.contains('shelf') && node._recommendedTitle === shelf.title &&
      (!id || !node._recommendedId));
    if (!section) {
      section = doc.createElement('section');
      section.className = 'shelf';
      const title = doc.createElement('h2'), cards = doc.createElement('div');
      cards.className = 'cards';
      section.append(title, cards);
    }
    used.add(section);
    section._recommendedId = id;
    section._recommendedTitle = shelf.title;
    const heading = section.querySelector('h2');
    if (heading.textContent !== shelf.title) heading.textContent = shelf.title;
    reconcileCards(section.querySelector('.cards'), shelf.items, makeCard);
    next.push(section);
  }
  if (!next.length) {
    let empty = mounted.find(node => node.classList.contains('muted') &&
      !node.classList.contains('shelf'));
    if (!empty) {
      empty = doc.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No recommendations for this library.';
    }
    next.push(empty);
  }
  const wanted = new Set(next);
  mounted.forEach(node => { if (!wanted.has(node)) node.remove(); });
  let following = anchor;
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].parentNode !== parent || next[i].nextSibling !== following)
      parent.insertBefore(next[i], following);
    following = next[i];
  }
  // Moving an existing shelf can reset scrollLeft on webOS Chromium 53.
  scroll.forEach((left, section) => {
    if (wanted.has(section)) section.querySelector('.cards').scrollLeft = left;
  });
  return next;
}
