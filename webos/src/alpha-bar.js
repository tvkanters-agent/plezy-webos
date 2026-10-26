// SPDX-License-Identifier: GPL-3.0-only
// Port of lib/screens/libraries/{alpha_jump_helper,alpha_jump_bar,library_alpha_bar_strategy}.dart.
// TV rail only: webOS has no Flutter FocusNode or SliverGrid.
export function alphaIndex(characters, descending = false) {
  const entries = (characters || []).map(c => ({
    letter: String(c.title || '').toUpperCase(), size: Number(c.size) || 0
  })).filter(c => c.letter && c.size > 0);
  // Plex's firstCharacter endpoint is codepoint-ordered, but its titleSort is
  // ICU-ordered. The webOS Intl collation is the browser's ICU equivalent of
  // Plezy's ducetCompare.
  const collator = typeof Intl !== 'undefined' && Intl.Collator ? new Intl.Collator() : null;
  entries.sort((a, b) => collator ? collator.compare(a.letter, b.letter) :
    (a.letter < b.letter ? -1 : a.letter > b.letter ? 1 : 0));
  if (descending) entries.reverse();
  const letters = [], offsets = {}, sizes = {};
  let total = 0;
  entries.forEach(entry => {
    letters.push(entry.letter);
    offsets[entry.letter] = total;
    sizes[entry.letter] = entry.size;
    total += entry.size;
  });
  const currentLetter = index => {
    let result = letters[0] || '#';
    for (const letter of letters) {
      if (offsets[letter] > index) break;
      result = letter;
    }
    return result;
  };
  const displayLetters = maxCount => {
    if (maxCount >= letters.length) return letters.slice();
    if (maxCount <= 0) return [];
    const indices = letters.map((_, i) => i);
    indices.sort((a, b) => sizes[letters[b]] - sizes[letters[a]]);
    return indices.slice(0, maxCount).sort((a, b) => a - b).map(i => letters[i]);
  };
  return {letters, offsets, sizes, total, currentLetter, displayLetters};
}

export function showPlexAlphaBar(total, characters, sort = 'title') {
  // PlexAlphaBarStrategy.shouldShow (TV): 80 items, six nonempty buckets,
  // titleSort, no folder grouping. Other sort orders must not show the rail.
  return sort === 'title' && total >= 80 && (characters || []).filter(c => Number(c.size) > 0).length >= 6;
}

// Align each sparse page to full rows so its top/bottom space is exact.
export function alphaPageStart(index, columns, total, pageSize = 60) {
  const cols = Math.max(1, columns);
  const row = Math.floor(Math.max(0, Math.min(index, Math.max(0, total - 1))) / cols);
  const pageRows = Math.max(1, Math.ceil(pageSize / cols));
  return Math.floor(row / pageRows) * pageRows * cols;
}

export function createAlphaJumpBar(characters, {onJump, onExit}) {
  const helper = alphaIndex(characters);
  const element = document.createElement('div');
  element.className = 'alpha-jump-bar';
  element.tabIndex = 0;
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', 'Alphabet navigation');
  let displayed = [], current = helper.letters[0] || '#', highlighted = 0;
  let focused = false, pressed = false, consumeClick = false, debounce = null;
  const nearest = letter => {
    if (!letter || !displayed.length) return '';
    if (displayed.indexOf(letter) >= 0) return letter;
    const pos = helper.letters.indexOf(letter);
    if (pos < 0) return displayed[0];
    let found = displayed[0];
    displayed.forEach(c => { if (helper.letters.indexOf(c) <= pos) found = c; });
    return found;
  };
  const jump = letter => {
    if (Object.prototype.hasOwnProperty.call(helper.offsets, letter))
      onJump(helper.offsets[letter]);
  };
  const mark = () => {
    const activeLetter = nearest(current);
    Array.from(element.children).forEach((slot, i) => {
      const selected = focused ? i === highlighted : displayed[i] === activeLetter;
      slot.className = 'alpha-letter-slot' +
        (focused && selected ? ' highlighted' : !focused && selected ? ' current' : '');
      slot.setAttribute('aria-selected', String(selected));
      slot.firstChild.style.fontWeight = selected ? 'bold' : 'normal';
    });
  };
  const draw = () => {
    const count = Math.floor(element.clientHeight / 20);
    const next = helper.letters.length <= 27 ? helper.letters : helper.displayLetters(count);
    if (next.join('\u0000') === displayed.join('\u0000')) { mark(); return; }
    displayed = next;
    element.textContent = '';
    displayed.forEach((letter, i) => {
      const slot = document.createElement('div');
      slot.className = 'alpha-letter-slot';
      slot.setAttribute('role', 'button');
      slot.setAttribute('aria-label', letter);
      const circle = document.createElement('span');
      circle.className = 'alpha-letter-marker';
      circle.textContent = letter;
      slot.append(circle);
      const height = element.clientHeight / displayed.length;
      const marker = Math.max(10, Math.min(18, height - 2));
      circle.style.width = circle.style.height = marker + 'px';
      circle.style.fontSize = Math.max(7, Math.min(10, height * .58)) + 'px';
      slot.addEventListener('click', () => {
        // A pointer gesture already jumped on down (like Flutter onTapDown).
        // Do not issue a second page request for its subsequent click.
        if (consumeClick) { consumeClick = false; return; }
        highlighted = i; element.focus(); mark(); jump(letter);
      });
      element.append(slot);
    });
    highlighted = Math.max(0, displayed.indexOf(nearest(current)));
    mark();
  };
  const atY = y => Math.max(0, Math.min(displayed.length - 1,
    Math.floor((y - element.getBoundingClientRect().top) /
      Math.max(1, element.clientHeight) * displayed.length)));
  const selectY = y => {
    if (!displayed.length) return;
    const idx = atY(y);
    if (highlighted !== idx) {
      highlighted = idx;
      mark();
    }
    jump(displayed[idx]);
  };
  // Flutter GestureDetector receives tap and vertical-drag updates.
  element.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    pressed = true;
    consumeClick = true;
    element.focus();
    selectY(e.clientY);
    e.preventDefault();
  });
  const move = e => { if (pressed) { selectY(e.clientY); e.preventDefault(); } };
  const release = () => { pressed = false; };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', release);
  element.addEventListener('touchstart', e => {
    pressed = true; consumeClick = true;
    element.focus(); selectY(e.touches[0].clientY); e.preventDefault();
  }, {passive:false});
  element.addEventListener('touchmove', e => {
    if (pressed) { selectY(e.touches[0].clientY); e.preventDefault(); }
  }, {passive:false});
  element.addEventListener('touchend', release);
  element.addEventListener('focus', () => {
    focused = true;
    highlighted = Math.max(0, displayed.indexOf(nearest(current)));
    mark();
  });
  element.addEventListener('blur', () => { focused = false; clearTimeout(debounce); mark(); });
  window.addEventListener('resize', draw);
  const handleKey = code => {
    if (!focused) return false;
    if (code === 37 || code === 461 || code === 27) {
      clearTimeout(debounce);
      onExit();
      return true;
    }
    if (code === 38 || code === 40) {
      highlighted = Math.max(0, Math.min(displayed.length - 1,
        highlighted + (code === 38 ? -1 : 1)));
      mark();
      clearTimeout(debounce);
      debounce = setTimeout(() => jump(displayed[highlighted]), 150);
      return true;
    }
    if (code === 13) { clearTimeout(debounce); jump(displayed[highlighted]); return true; }
    return code === 39;
  };
  return {
    element, helper, handleKey,
    update(letter) { current = letter; if (!focused) mark(); },
    draw, focus() { element.focus(); },
    isFocused() { return focused; },
    destroy() {
      clearTimeout(debounce);
      window.removeEventListener('resize', draw);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', release);
      element.remove();
    }
  };
}
