// CS:APP cards: twelve classic C-on-x86-64 traps, grouped by book section.
// Each tile names the card, its section and what the C standard says about it.
import { h, href } from '../../lib/dom.js';
import { CARDS, build } from '../../learn/cards.js';
import { specById } from '../../learn/spec.js';
import { chip } from '../parts.js';
import { stdChip } from '../code.js';
import { load } from '../../lib/store.js';
import { setNav } from '../nav.js';

export const SECTION_ORDER = ['2.2', '2.3', '3.5', '3.6'];
const ASK_WORDS = { output: 'Predict the output', value: 'Predict a value', flags: 'Predict the flags', branch: 'Predict the branch' };

/** 'CS:APP 2.3.7' → '2.3' */
export const groupOf = (section) => String(section).replace(/^CS:APP\s*/, '').split('.').slice(0, 2).join('.');

/** the canonical card's C-standard status (cards are built once and cached by cards.js) */
function statusOf(card) {
  try { return build({ id: card.id, v: 0 }).card.std.status; } catch (e) { console.error(e); return null; }
}

export function render(el) {
  setNav('#/cards');
  const saved = load('cards.tried', []);
  const tried = new Set(Array.isArray(saved) ? saved : []);
  const groups = SECTION_ORDER.map((sec) => ({ sec, cards: CARDS.filter((c) => groupOf(c.section) === sec) }))
    .filter((g) => g.cards.length);

  const main = h('main', { class: 'page stack-lg cards-page', 'data-view': 'cards' },
    h('div', { class: 'stack' },
      h('p', { class: 'chip accent' }, 'C on x86-64 · CS:APP chapters 2–3'),
      h('h1', null, 'C on x86-64: twelve cards'),
      h('p', { class: 'lede' }, 'Each card is a few lines of C. Predict what it does, then see the line, the instruction, the registers, the flags and the bits that explain it.')),
    groups.map((g) => {
      const spec = specById(`CSAPP-${g.sec}`);
      const id = `sec-${g.sec.replace('.', '-')}`;
      return h('section', { class: 'card-group stack-sm', 'aria-labelledby': id },
        h('h2', { id }, `${g.sec} · ${spec ? spec.title : 'CS:APP'}`),
        h('ul', { class: 'card-grid', role: 'list' }, g.cards.map((c) => {
          const status = statusOf(c);
          return h('li', null, h('a', { class: 'panel card-tile', href: href(`/card/${c.id}`) },
            h('div', { class: 'row spread card-tile-top' }, chip(c.section), h('span', { class: 'small muted' }, ASK_WORDS[c.ask] || 'Predict')),
            h('h3', { class: 'card-tile-title' }, c.title),
            // showing "undefined" before the learner has predicted would give the answer away
            status && tried.has(c.id) ? h('div', { class: 'card-tile-std' }, stdChip(status))
              : h('div', { class: 'card-tile-std small muted' }, 'C standard status: shown after you try it')));
        })));
    }),
    h('section', { class: 'panel paste-promo stack-sm', 'aria-labelledby': 'paste-h' },
      h('h2', { id: 'paste-h' }, 'Paste your own C'),
      h('p', null, 'Write up to 30 lines, predict what it prints, and find the first line where your model and the machine part ways.'),
      h('p', null, h('a', { class: 'btn primary', href: href('/paste') }, 'Paste your own C'))),
    h('section', { class: 'honest small muted stack-sm', 'aria-label': 'Where the answers come from' },
      h('p', null, "Every answer here is computed by this lab's own C compiler and x86-64 emulator, and checked against gcc -O0 on x86-64. The assembly you see is this lab's compiler, written in gcc -O0 style; real gcc output can differ in small ways, such as the order of operands. Where the C standard leaves a result undefined or implementation-defined, the card says so and shows what gcc does."),
      h('p', null, 'Nothing you type leaves this device.')));
  el.append(main);
}
