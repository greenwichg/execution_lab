// "Forget everything on this device": for shared Chromebooks, so the next
// pupil never sees the last one's reviews, result codes or saved programs.
import { h, announce } from '../lib/dom.js';
import { clearAll } from '../lib/store.js';
import { button } from './parts.js';

export function forgetControl({ onDone } = {}) {
  const holder = h('div', { class: 'forget row' });
  const ask = button('Forget everything on this device', { small: true, kind: 'ghost' });
  ask.addEventListener('click', () => {
    const yes = button('Yes, forget it all', { small: true, kind: 'primary' });
    const no = button('Keep it', { small: true });
    holder.replaceChildren(h('span', { class: 'small' }, 'This removes your reviews, sets, classes and saved programs from this browser.'), yes, no);
    yes.addEventListener('click', () => {
      clearAll();
      holder.replaceChildren(h('span', { class: 'small', tabindex: '-1' }, 'Done — nothing from Predict the Machine is stored on this device now.'));
      holder.firstChild.focus();
      announce('Everything has been forgotten on this device.');
      onDone?.();
    });
    no.addEventListener('click', () => { holder.replaceChildren(ask); ask.focus(); });
    yes.focus();
  });
  holder.append(ask);
  return holder;
}
