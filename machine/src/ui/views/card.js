// One CS:APP card: the C snippet, the question, the answer, then what the
// machine did, what the C standard says and what gcc -O0 on x86-64 does,
// the diagnosis and the Why rail (line → instruction → registers → flags →
// columns → adder). Misses go into the spaced review queue.
import { h, href, focus, announce } from '../../lib/dom.js';
import { mulberry32, newSeed, randInt } from '../../lib/rng.js';
import { CARDS, TYPE_ID, V_MAX, encodeParams } from '../../learn/cards.js';
import { makeItem } from '../../learn/items/index.js';
import * as sched from '../../learn/scheduler.js';
import { TAGS } from '../../learn/catalogue.js';
import { button, chip } from '../parts.js';
import { mountItem, workedExample } from '../runner.js';
import { loadSched, saveSched } from '../session.js';
import { beforePrompt, afterReveal } from '../cardhooks.js';
import { load, save } from '../../lib/store.js';
import { setNav } from '../nav.js';

let runner = null;
let pending = null;          // a first attempt not yet written to the scheduler
// "Try one like it" opens the variant as a new page; the per-tag miss count
// (two misses → a worked example) must carry over to it. Any other way in
// starts a new session.
let keepSession = false;

function commit(tag) {
  if (!pending) return;
  const p = pending;
  pending = null;
  try {
    const state = sched.recordAttempt(loadSched(), {
      type: TYPE_ID, params: encodeParams(p.params), correct: p.correct,
      tag: (tag !== undefined ? tag : p.tag) || undefined, group: 'drill', today: sched.dayNumber(new Date()),
    });
    saveSched(state);
    // the card list reveals a card's C-standard status only once it has been tried
    const tried = load('cards.tried', []);
    if (Array.isArray(tried) && !tried.includes(p.params.id)) save('cards.tried', [...tried, p.params.id].slice(-50));
  } catch (e) { console.error(e); }
}

// Card titles name the canonical numbers ("Storing 70000 in a short"); a variant
// uses new numbers, so its heading must not promise the old ones.
const VARIANT_TITLES = {
  'char-200': 'A char that holds a big number',
  'minus-one-vs-unsigned': 'Comparing a negative int with an unsigned',
  'uchar-promotion': 'Adding two unsigned chars',
  'short-truncation': 'Storing a big int in a short',
  'unsigned-wrap': 'An unsigned value that goes below zero',
  'int-max-plus-one': 'An int that goes past INT_MAX',
  'int-multiply-overflow': 'A product too big for an int',
  'negative-shift-right': 'Shifting a negative int right',
  'truncating-division': 'Dividing with negative numbers',
  'unsigned-shift-right': 'Shifting an unsigned value right',
  'signed-unsigned-branch': 'Which branch runs?',
  'flags-after-cmp': 'The flags after cmp',
};
/** the heading for a card instance: the canonical title, or a number-free one for a variant */
export const titleFor = (card, v) => (v ? VARIANT_TITLES[card.id] || `A variant of “${card.title}”` : card.title);

/** '?v=' → 0 … V_MAX (anything else is the canonical card) */
function variantOf(query) {
  const raw = query.get('v');
  if (raw === null || !/^\d{1,4}$/.test(raw)) return 0;
  const v = Number(raw);
  return v >= 0 && v <= V_MAX ? v : 0;
}

export function render(el, ctx) {
  setNav('#/cards');
  const idx = CARDS.findIndex((c) => c.id === ctx.params.id);
  if (idx < 0) {
    el.append(h('main', { class: 'page page-narrow stack', 'data-view': 'card' },
      h('h1', null, 'Card not found'),
      h('p', { class: 'lede' }, `There is no card called “${ctx.params.id}”.`),
      h('p', null, h('a', { class: 'btn primary', href: href('/cards') }, 'See all twelve cards'))));
    return;
  }
  const card = CARDS[idx];
  const v = variantOf(ctx.query);
  if (!keepSession) {
    try { saveSched(sched.resetSession(loadSched(), newSeed())); } catch (e) { console.error(e); }
  }
  keepSession = false;
  let lastTag = null;
  const item = makeItem('card', { id: card.id, v });
  const prev = CARDS[idx - 1] || null;
  const next = CARDS[idx + 1] || null;
  const newV = () => { const rng = mulberry32(newSeed()); let n; do n = randInt(rng, 1, V_MAX); while (n === v); return n; };

  const holder = h('div', { class: 'card-item' });
  const main = h('main', { class: 'page page-narrow stack card-page', 'data-view': 'card' },
    h('nav', { class: 'card-nav row spread small', 'aria-label': 'Cards' },
      h('a', { href: href('/cards') }, '← All cards'),
      h('span', { class: 'row card-nav-links' },
        prev ? h('a', { href: href(`/card/${prev.id}`), rel: 'prev', 'aria-label': `Previous card: ${prev.title}` }, '‹ Previous') : null,
        h('span', { class: 'muted card-count' }, `Card ${idx + 1} of ${CARDS.length}`),
        next ? h('a', { href: href(`/card/${next.id}`), rel: 'next', 'aria-label': `Next card: ${next.title}` }, 'Next ›') : null)),
    h('div', { class: 'stack-sm' },
      h('div', { class: 'row' }, chip(card.section, 'accent'), v ? chip(`Variant ${v}`) : null),
      h('h1', null, titleFor(card, v)),
      v ? h('p', { class: 'small muted card-variant-note' }, 'New numbers, same idea as ', h('a', { href: href(`/card/${card.id}`) }, `“${card.title}”`), '.') : null),
    holder,
    h('p', { class: 'small muted' }, "Computed by this lab's C compiler and x86-64 emulator. Nothing you type leaves this device."));
  el.append(main);

  runner = mountItem(holder, item, {
    mode: 'practice', feedback: 'full', level: 'csapp', showSpec: false,
    nextLabel: 'Next card',
    beforePrompt,
    afterReveal,
    onDone(r) {
      pending = { params: item.params, correct: r.correct, tag: r.tag };
      if (r.correct) commit();
    },
    onFinal(r) {
      lastTag = r.diagnosis?.tag || null;
      commit(r.diagnosis?.tag ?? undefined);
    },
    onNext(kind) {
      if (kind !== 'variant') { ctx.nav(next ? `/card/${next.id}` : '/cards'); return; }
      const path = `/card/${card.id}?v=${newV()}`;
      // two misses on the same misconception in this session: study a worked example first
      if (lastTag && TAGS[lastTag]?.worked) {
        let state = null;
        try { state = loadSched(); } catch (e) { console.error(e); }
        if (state && sched.fading(state, lastTag).showWorked) {
          try { saveSched(sched.noteWorked(state, lastTag)); } catch (e) { console.error(e); }
          showWorked(lastTag, path);
          return;
        }
      }
      keepSession = true;
      ctx.nav(path);
    },
  });

  function showWorked(tag, path) {
    const info = TAGS[tag];
    runner?.destroy();
    runner = null;
    const heading = h('h2', { id: 'card-worked-h', tabindex: '-1' }, 'A worked example first');
    const go = button('Now try one like it', { kind: 'primary', onClick: () => { keepSession = true; ctx.nav(path); } });
    holder.replaceChildren(h('section', { class: 'card-worked stack', 'aria-labelledby': 'card-worked-h' },
      heading,
      h('p', null, `This mistake has caught you twice, so study one step by step. ${info.fix || ''}`.trim()),
      workedExample(info, item),
      h('div', { class: 'row' }, go)));
    focus(heading);
    announce('A worked example first.');
  }
}

export function dispose() {
  commit();
  runner?.destroy();
  runner = null;
}
