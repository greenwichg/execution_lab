// Home: what this is, in one breath, and the three ways in.
import { h, href } from '../../lib/dom.js';
import { load } from '../../lib/store.js';
import { specsForLevel } from '../../learn/spec.js';
import { setNav } from '../nav.js';
import { forgetControl } from '../forget.js';

const LEVEL_PANELS = [
  { id: 'gcse', title: 'GCSE', sub: 'Binary addition, overflow and shifts' },
  { id: 'alevel', title: 'A-level', sub: "Two's complement, signed overflow, shifts and adders" },
  { id: 'csapp', title: 'C on x86-64', sub: 'CS:APP chapters 2–3: what your C really does' },
];

export async function render(el) {
  // count due reviews straight from storage: importing the scheduler would pull in
  // every item type, the C compiler and the cards just to show one number
  let due = 0;
  try {
    const state = load('sched', null);
    const d = new Date();
    const today = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
    if (state && Array.isArray(state.queue)) due = state.queue.filter((e) => e && !e.done && Number.isFinite(e.due) && e.due <= today).length;
  } catch { /* no count */ }

  const panels = LEVEL_PANELS.map((p) => {
    const links = p.id === 'csapp'
      ? [['12 cards: conversions, overflow, shifts, jumps', '/cards'], ['Paste your own C', '/paste'], ['Condition codes (CF ZF SF OF)', '/practice/sadd?level=csapp']]
      : specsForLevel(p.id).map((s) => [s.title, `/practice/${s.topic}?level=${p.id}`]);
    return h('section', { class: 'panel level-panel', 'aria-labelledby': `lvl-${p.id}` },
      h('h2', { id: `lvl-${p.id}` }, p.title),
      h('p', { class: 'muted small' }, p.sub),
      h('ul', null, links.map(([t, path]) => h('li', null, h('a', { href: href(path) }, t)))));
  });

  const main = h('main', { class: 'page stack-lg', 'data-view': 'home' },
    h('div', { class: 'home-hero stack' },
      h('h1', null, 'Predict the Machine'),
      h('p', { class: 'lede' }, 'Predict what the computer will do. Check it against a real simulation. Find exactly where your thinking broke — then go one layer deeper.'),
      h('div', { class: 'row' },
        h('a', { class: 'btn primary', href: href('/practice/add?level=gcse') }, 'Start with binary addition'),
        h('a', { class: 'btn', href: href('/review') }, due ? `Review due (${due})` : 'Review'),
        h('a', { class: 'btn', href: href('/check') }, 'Check my working'))),
    h('div', { class: 'grid-auto' }, panels),
    h('section', { class: 'panel stack-sm', 'aria-labelledby': 'how' },
      h('h2', { id: 'how' }, 'How it works'),
      h('ol', { class: 'how-list' },
        h('li', null, h('strong', null, 'Predict. '), 'Fill in your working and say how sure you are.'),
        h('li', null, h('strong', null, 'Check. '), 'Every answer is worked out by a simulation of the hardware — never typed in by hand.'),
        h('li', null, h('strong', null, 'Find the break. '), 'We point to the first column or line where your thinking and the machine part ways.'),
        h('li', null, h('strong', null, 'Why? ↓ '), 'Go one layer deeper at a time — from the line of code to the instruction, the flags, the bit columns and the gates.'),
        h('li', null, h('strong', null, 'Practise and return. '), 'Try one like it now; what you missed comes back in 2, 7 and 21 days.'))),
    h('div', { class: 'row spread small muted' },
      h('p', null, 'Nothing you type leaves this device. No accounts, no tracking.'),
      h('p', null, h('a', { href: href('/teacher') }, 'For teachers'), ' · ',
        h('a', { href: '../index.html', rel: 'noreferrer' }, 'The film: Code Execution Lab'),
        h('span', { class: 'small' }, ' (a separate page that loads fonts and three.js from Google and jsDelivr)'))),
    h('div', { class: 'small muted' }, forgetControl()));
  el.append(main);
  setNav(null);
}
