// The projected lesson starter: five questions, one at a time, huge. The class
// answers on whiteboards; Space reveals (an addition ripples in column by
// column); the teacher taps how the class did (1 · 2 · 3) and the misses come
// back in the next starter. Everything works from the keyboard.
import { h, href, announce, focus } from '../../lib/dom.js';
import { mulberry32, mixSeed } from '../../lib/rng.js';
import { specById } from '../../learn/spec.js';
import { tagLabel } from '../../learn/catalogue.js';
import { itemForSpec, itemForTag, makeItem } from '../../learn/items/index.js';
import { recordTap } from '../../learn/starter.js';
import { renderWhy, renderLayer } from '../why.js';
import { moduleFor } from '../runner.js';
import { mountAddition, isAddition, questionVisual, revealKey } from '../reveal.js';
import { setNav } from '../nav.js';
import { findClass, saveClass, sourceLabel, starterPlan, startOfDay, today } from './teacher.js';

const TAPS = [
  { result: 'got', key: '1', label: 'Most got it' },
  { result: 'split', key: '2', label: 'Split' },
  { result: 'missed', key: '3', label: 'Most missed' },
];
const TAP_TEXT = { got: 'Most got it', split: 'Split', missed: 'Most missed' };

let cleanup = null;

/** the misconception a fresh question for this spec most likely meets: the class's most common tapped tag */
function inferTag(cls, spec) {
  const counts = new Map();
  for (const t of cls.taps || []) if (t.spec === spec && t.tag && t.result !== 'got') counts.set(t.tag, (counts.get(t.tag) || 0) + 1);
  let best = null;
  for (const [tag, n] of counts) if (!best || n > best[1]) best = [tag, n];
  return best ? best[0] : null;
}

function itemFor(entry, cls, i, day) {
  const rng = mulberry32(mixSeed('starter-item', cls.id, day, i, entry.spec, entry.tag || ''));
  const spec = specById(entry.spec);
  const level = spec?.level || cls.level;
  let made = null;
  if (entry.tag) {
    const opts = spec ? { ...spec.make.opts, type: spec.make.type } : {};
    try { made = itemForTag(entry.tag, rng, { ...opts, level, ask: 'result' }); } catch (e) { console.error(e); }
  }
  if (!made) made = itemForSpec(entry.spec, rng, { level, ask: 'result' });
  return makeItem(made.type, made.params);
}

export function render(el, ctx) {
  setNav(null);
  const id = ctx.query.get('class');
  let cls = id ? findClass(id) : null;
  if (!cls) {
    el.append(h('main', { class: 'page page-narrow stack', 'data-view': 'starter' },
      h('h1', null, 'No class to project'),
      h('p', { class: 'lede' }, 'This starter link names a class that is not saved on this device.'),
      h('p', null, h('a', { class: 'btn primary', href: href('/teacher') }, 'Choose a class'))));
    return;
  }
  document.body.classList.add('projector');
  const day = today();
  // today's plan ignores today's taps, so a reload (or Esc and back) shows the same questions
  const plan = starterPlan(cls, day);
  const morning = startOfDay(cls, day);
  const qs = plan.map((entry, i) => {
    let item = null;
    try { item = itemFor(entry, cls, i, day); } catch (e) { console.error(e); }
    return { entry, item, slot: i, tag: entry.tag || inferTag(morning, entry.spec), revealed: false, tap: null, why: null };
  }).filter((q) => q.item);
  // taps already made today (before a reload) are shown, and a new tap replaces them
  for (const q of qs) {
    const t = (cls.taps || []).filter((x) => x && x.day === day && x.slot === q.slot && x.spec === q.entry.spec).pop();
    if (t && TAP_TEXT[t.result]) { q.tap = t.result; q.revealed = true; }
  }
  let at = 0;
  let ctl = null;          // the addition layout's controller

  const counter = h('span', { class: 'sr-count', 'aria-live': 'polite' });
  const stage = h('div', { class: 'sr-stage' });
  const main = h('main', { class: 'page page-wide sr', 'data-view': 'starter' },
    h('div', { class: 'sr-top' },
      h('h1', { class: 'sr-title' }, `Starter · ${cls.name}`),
      counter,
      h('a', { class: 'btn ghost small sr-leave', href: href(`/teacher?class=${encodeURIComponent(cls.id)}`) }, h('kbd', { class: 'kbd' }, 'Esc'), ' Leave')),
    stage);
  el.append(main);

  function show(i, { focusIt = true } = {}) {
    ctl?.destroy?.();
    ctl = null;
    at = Math.max(0, Math.min(i, qs.length));
    if (at >= qs.length) return end();
    const q = qs[at];
    counter.textContent = `${at + 1} of ${qs.length}`;
    const spec = specById(q.entry.spec);
    const heading = h('h2', { class: 'sr-prompt', tabindex: '-1' }, q.item.prompt);
    const visual = h('div', { class: 'sr-visual' });
    const answer = h('div', { class: 'sr-answer' });
    const actions = h('div', { class: 'sr-actions' });
    const whyHolder = h('div', { class: 'sr-why' });
    stage.replaceChildren(h('section', { class: 'sr-q', 'aria-labelledby': 'sr-prompt' },
      h('p', { class: 'sr-source' },
        h('span', { class: ['chip', q.entry.source === 'missed' ? 'tc-src-missed' : q.entry.source === 'spaced' ? 'tc-src-spaced' : 'accent'] }, sourceLabel(q.entry, cls, day)),
        ' ', h('span', { class: 'sr-note' }, [spec?.title, q.entry.note].filter(Boolean).join(' — '))),
      heading, visual, answer, actions, whyHolder));
    heading.id = 'sr-prompt';
    if (isAddition(q.item)) ctl = mountAddition(visual, q.item);
    else {
      const v = questionVisual(q.item);
      if (v) visual.append(v);
    }
    q.els = { answer, actions, whyHolder, visual };
    q.whyCtl = null;
    if (q.revealed) doReveal(false); else drawActions();
    if (focusIt) focus(heading);
  }

  function drawActions() {
    const q = qs[at];
    const { actions } = q.els;
    const nav = h('div', { class: 'sr-nav' },
      at > 0 ? bigBtn('Previous', '←', () => show(at - 1), 'sr-prev') : null,
      bigBtn(at === qs.length - 1 ? 'Finish' : 'Next', '→', () => show(at + 1), 'sr-next'));
    if (!q.revealed) {
      actions.replaceChildren(
        h('p', { class: 'sr-board' }, 'Answer on your whiteboards.'),
        h('div', { class: 'sr-row' }, bigBtn('Reveal', 'Space', () => doReveal(true), 'sr-reveal primary'), nav));
      return;
    }
    const taps = h('div', { class: 'sr-taps', role: 'group', 'aria-label': 'How did the class do?' },
      TAPS.map((t) => {
        const b = bigBtn(t.label, t.key, () => tap(t.result), `sr-tap sr-tap-${t.result}`);
        b.setAttribute('aria-pressed', String(q.tap === t.result));
        if (q.tap === t.result) b.prepend(h('span', { class: 'sr-tick', 'aria-hidden': 'true' }, '✓ '));
        return b;
      }));
    const deepest = q.whyCtl && q.whyCtl.depth >= q.whyCount;
    const whyBtn = deepest ? null : bigBtn(q.whyCtl ? 'Deeper ↓' : 'Why ↓', 'W', () => why(), 'sr-whybtn');
    actions.replaceChildren(
      h('p', { class: 'sr-ask' }, q.tap ? `Recorded: ${TAP_TEXT[q.tap]}. Press another number to change it.` : 'How did the class do?'),
      h('div', { class: 'sr-row' }, taps, whyBtn, nav));
  }

  function doReveal(animate) {
    const q = qs[at];
    if (!q) return;
    if (q.revealed && q.els.answer.childNodes.length) { ctl?.finish(); return; }
    q.revealed = true;
    if (ctl) {
      ctl.reveal({ animate });
    } else {
      revealKey(q.els.answer, q.item);
      let layers = [];
      try { layers = moduleFor(q.item).why(q.item, null, { level: q.item.level }) || []; } catch (e) { console.error(e); }
      const first = layers.find((L) => L.kind !== 'text');
      if (first && first.kind !== 'line') q.els.answer.append(h('div', { class: 'sr-layer' }, renderLayer(first)));
    }
    q.els.answer.dataset.revealed = 'true';
    announce('Answer revealed.');
    drawActions();
  }

  function tap(result) {
    const q = qs[at];
    if (!q || !q.revealed) { announce('Reveal the answer first (Space).'); return; }
    const fresh = findClass(cls.id) || cls;
    // one tap per question: a new tap for this question replaces the one recorded before
    const taps = (fresh.taps || []).filter((t) => !(t && t.day === day && t.slot === q.slot && t.spec === q.entry.spec));
    const next = recordTap({ ...fresh, taps }, { spec: q.entry.spec, tag: q.tag || null, result, date: day });
    next.taps[next.taps.length - 1] = { ...next.taps[next.taps.length - 1], slot: q.slot };
    cls = saveClass(next);
    q.tap = result;
    announce(`Recorded: ${TAP_TEXT[result]}.`);
    drawActions();
    focus(q.els.actions.querySelector(`.sr-tap-${result}`));
  }

  function why() {
    const q = qs[at];
    if (!q || !q.revealed) { announce('Reveal the answer first (Space).'); return; }
    if (q.whyCtl) {
      if (q.whyCtl.depth >= q.whyCount) { announce("That's the deepest layer."); return; }
      q.whyCtl.openNext(); drawActions(); return;
    }
    let layers = [];
    try { layers = moduleFor(q.item).why(q.item, null, { level: q.item.level }) || []; } catch (e) { console.error(e); }
    if (!layers.length) { announce('There is no explanation for this question.'); return; }
    q.whyCount = layers.length;
    q.whyCtl = renderWhy(q.els.whyHolder, layers, { level: q.item.level, startOpen: 0, firstLabel: 'Why? ↓' });
    q.whyCtl.openNext();
    drawActions();
  }

  function end() {
    counter.textContent = 'Done';
    const next = (() => {
      try { return starterPlan(findClass(cls.id) || cls, day + 1).filter((e) => e.source === 'missed'); } catch { return []; }
    })();
    const heading = h('h2', { class: 'sr-prompt', tabindex: '-1' }, 'Starter done');
    stage.replaceChildren(h('section', { class: 'sr-end stack' },
      heading,
      h('ol', { class: 'sr-summary' }, qs.map((q) => h('li', null,
        h('span', { class: 'sr-sum-title' }, specById(q.entry.spec)?.title || q.entry.spec),
        h('span', { class: ['sr-sum-tap', q.tap && `sr-sum-${q.tap}`] }, q.tap ? TAP_TEXT[q.tap] : 'Not recorded')))),
      h('p', { class: 'sr-nexttime' }, next.length
        ? ['Next time these come back: ', next.map((e) => `${specById(e.spec)?.title || e.spec}${e.tag ? ` (${tagLabel(e.tag)})` : ''}`).join('; '), '.']
        : 'Nothing was marked as split or missed, so next time starts with spaced practice.'),
      h('div', { class: 'sr-row' },
        bigBtn('Previous', '←', () => show(qs.length - 1), 'sr-prev'),
        h('a', { class: 'btn sr-btn primary', href: href(`/teacher?class=${encodeURIComponent(cls.id)}`) }, h('kbd', { class: 'kbd' }, 'Esc'), ' Back to the teacher page'))));
    focus(heading);
    announce('Starter done.');
  }

  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const onButton = t && (t.tagName === 'BUTTON' || t.tagName === 'A');
    const k = e.key;
    if (k === 'Escape') { e.preventDefault(); ctx.nav(`/teacher?class=${encodeURIComponent(cls.id)}`); return; }
    if (k === 'ArrowRight' || k === 'n' || k === 'N' || k === 'PageDown') { e.preventDefault(); if (at < qs.length) show(at + 1); return; }
    if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); if (at > 0) show(at - 1); return; }
    if (at >= qs.length) return;
    if ((k === ' ' || k === 'Enter') && !onButton) { e.preventDefault(); doReveal(true); return; }
    if (k === '1' || k === '2' || k === '3') { e.preventDefault(); tap(TAPS[+k - 1].result); return; }
    if (k === 'w' || k === 'W') { e.preventDefault(); why(); }
  }
  document.addEventListener('keydown', onKey);
  cleanup = () => { document.removeEventListener('keydown', onKey); ctl?.destroy?.(); ctl = null; };

  if (!qs.length) {
    stage.replaceChildren(h('p', { class: 'lede' }, 'There is nothing to project yet. Mark what the class has been taught first.'));
    return;
  }
  show(0, { focusIt: false });
}

function bigBtn(label, key, onClick, cls) {
  const b = h('button', { type: 'button', class: ['btn', 'sr-btn', ...String(cls || '').split(' ')], 'aria-keyshortcuts': key === 'Space' ? 'Space' : key === '←' ? 'ArrowLeft' : key === '→' ? 'ArrowRight' : key },
    h('span', null, label), ' ', h('kbd', { class: 'kbd' }, key));
  b.addEventListener('click', onClick);
  return b;
}

export function dispose() { cleanup?.(); cleanup = null; }
