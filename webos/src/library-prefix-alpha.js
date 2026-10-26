// SPDX-License-Identifier: GPL-3.0-only
// Port of MediaBrowserAlphaBarStrategy: unlike Plex, Jellyfin/Emby have no
// firstCharacter counts. Each letter changes NameStartsWith on the server.
import {createAlphaJumpBar} from './alpha-bar.js';

export const MEDIA_BROWSER_ALPHABET = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

export function mountMediaBrowserAlphabet({main,selected,focusWithoutJump,onPrefixChange}) {
  const characters = MEDIA_BROWSER_ALPHABET.map(letter=>({
    key:letter,title:letter,size:1
  }));
  const rail = createAlphaJumpBar(characters,{
    onJump(index) {
      const letter = MEDIA_BROWSER_ALPHABET[index];
      if (letter) onPrefixChange(selected === letter ? null : letter);
    },
    onExit() {
      // LibraryBrowseTab._navigateToGridNearScroll returns to the last
      // column of the first visible row, not the old (possibly hidden) card.
      const pane = main.getBoundingClientRect();
      const visible = Array.from(main.querySelectorAll('.grid .card')).filter(card=>{
        const r=card.getBoundingClientRect();
        return r.bottom>pane.top && r.top<pane.bottom;
      });
      const firstY = visible.length ? visible[0].getBoundingClientRect().top : null;
      const firstRow = visible.filter(card=>
        Math.abs(card.getBoundingClientRect().top - firstY)<4);
      const target = firstRow[firstRow.length-1] || visible[0];
      if(target) focusWithoutJump(target,false);
    }
  });
  document.querySelector('#shell').append(rail.element);
  rail.draw();
  rail.update(selected || '');
  return {
    element:rail.element, handleKey:rail.handleKey, focus:rail.focus,
    suspend() {rail.element.hidden=true;},
    resume() {rail.element.hidden=false;rail.draw();},
    destroy:rail.destroy
  };
}
