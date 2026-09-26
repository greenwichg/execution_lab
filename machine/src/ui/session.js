// A practice or review session: a run of items through the runner, with the
// scheduler recording every first attempt (spaced review + holdout evidence),
// fading support, worked examples after repeated misses, and an end summary.
import { h, announce, shareUrl, href } from '../lib/dom.js';
import { load, save, persistent } from '../lib/store.js';
import { mulberry32 } from '../lib/rng.js';
import { ITEM_TYPES, makeItem } from '../learn/items/index.js';
import * as sched from '../learn/scheduler.js';
import { encodeQueue } from '../lib/codec.js';
import { TAGS } from '../learn/catalogue.js';
import { mountItem } from './runner.js';
import { button, copyBox, tile, CONFIDENCE } from './parts.js';
import { renderLayer } from './why.js';

export const loadSched = () => {
  const s = load('sched', null);
  try { return s ? sched.mergeQueue(s, [], sched.dayNumber()).state : sched.emptyState(); } catch { return sched.emptyState(); }
};
export const saveSched = (s) => save('sched', s);
const modOf = (type) => ITEM_TYPES[type];
const today = () => sched.dayNumber(new Date());

export function formatDay(day) {
  const d = sched.dayToDate(day);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

/** the bookmarkable review link for everything still in the queue ('' when empty) */
export function reviewLink(state) {
  const active = sched.activeEntries(state);
  if (!active.length) return '';
  try { return shareUrl(`/review/${encodeQueue(active)}`); } catch { return ''; }
}

/**
 * runSession(holder, {
 *   total, seed, level,
 *   next(i) → { item, review?, group?, target? } | null,   // the next item to ask
 *   title, again: () => void, summaryNote?,
 * })
 */
export function runSession(holder, cfg) {
  let state = sched.resetSession(loadSched(), cfg.seed);
  saveSched(state);
  const rng = mulberry32(cfg.seed ^ 0x5bd1e995);
  const results = [];
  let i = 0;
  let runner = null;
  let pending = null;             // a first attempt not yet written to the scheduler
  let variant = null;             // the next item when the learner asked for "one like it"

  const bar = h('div', { class: 'session-bar' });
  const stage = h('div', { class: 'session-stage' });
  holder.replaceChildren(bar, stage);

  function drawBar() {
    const dots = h('span', { class: 'progress-dots', 'aria-hidden': 'true' });
    for (let k = 0; k < cfg.total; k++) {
      const r = results[k];
      dots.append(h('span', { class: [r && (r.correct ? 'done-ok' : 'done-bad'), k === i && !r && 'now'] }));
    }
    const right = results.filter((r) => r.correct).length;
    bar.replaceChildren(dots, h('span', { class: 'small muted' }, `${right} of ${results.length} right first time`));
  }

  function commit(extraTag) {
    if (!pending) return;
    const p = pending;
    pending = null;
    const tag = extraTag !== undefined ? extraTag : p.tag;
    try {
      state = sched.recordAttempt(state, {
        type: p.item.type, params: modOf(p.item.type).encodeParams(p.item.params),
        correct: p.correct, tag: tag || undefined, target: p.target || undefined,
        group: p.group, today: today(), review: !!p.review,
      });
      saveSched(state);
    } catch (e) { console.error(e); }
  }

  function ask() {
    if (i >= cfg.total) return finish();
    let next = variant;
    variant = null;
    if (!next) next = cfg.next(i, state);
    if (!next) return finish();
    const { item } = next;
    const group = next.group || 'drill';
    const feedback = group === 'holdout' ? 'answerOnly' : 'full';
    const fade = next.target ? sched.fading(state, next.target) : { collapseWhy: false };
    drawBar();
    stage.replaceChildren();
    runner = mountItem(stage, item, {
      mode: 'practice', feedback, level: item.level || cfg.level, showSpec: cfg.showSpec,
      progress: `Question ${i + 1} of ${cfg.total}`,
      collapsedWhy: !!fade.collapseWhy,
      onDone(r) {
        results[i] = { correct: r.correct, confidence: r.confidence, tag: r.tag, review: !!next.review, group };
        pending = { item, correct: r.correct, tag: r.tag, target: next.target, group, review: next.review };
        if (r.correct || feedback === 'answerOnly') commit();
        drawBar();
      },
      onFinal(r) {
        if (results[i] && r.diagnosis?.tag) results[i].tag = r.diagnosis.tag;
        commit(r.diagnosis?.tag ?? undefined);
      },
      onNext(kind) {
        const last = results[i];
        i++;
        if (kind === 'variant' && last?.tag && i < cfg.total) {
          const mod = modOf(item.type);
          let params = null;
          try { params = mod.variant(item, last.tag, rng); } catch (e) { console.error(e); }
          if (params) {
            variant = { item: makeItem(item.type, params), target: last.tag, group: 'drill' };
            const f = sched.fading(state, last.tag);
            if (f.showWorked && TAGS[last.tag]?.worked) return showWorked(last.tag);
          }
        }
        ask();
      },
    });
    runner.focus();
  }

  function showWorked(tag) {
    state = sched.noteWorked(state, tag);
    saveSched(state);
    const info = TAGS[tag];
    let ex = null;
    try { ex = info.worked(mulberry32(cfg.seed + i)); } catch (e) { console.error(e); }
    stage.replaceChildren();
    if (!ex) return ask();
    const go = button('Now try one like it', { kind: 'primary', onClick: () => ask() });
    stage.append(h('section', { class: 'worked panel stack', 'aria-labelledby': 'worked-h' },
      h('p', { class: 'chip accent' }, 'Worked example'),
      h('h2', { id: 'worked-h', tabindex: '-1' }, ex.title),
      h('p', { class: 'muted' }, `This one has caught you twice, so here it is step by step. ${info.fix || ''}`),
      h('ol', { class: 'worked-steps' }, ex.steps.map((s) => h('li', null, h('strong', null, s.subgoal), ' — ', s.text,
        s.layer ? h('div', { class: 'worked-layer' }, renderLayer(s.layer)) : null))),
      go));
    stage.querySelector('#worked-h').focus();
  }

  function finish() {
    commit();
    drawBar();
    const done = results.filter(Boolean);
    const right = done.filter((r) => r.correct).length;
    const byConf = CONFIDENCE.map((c) => {
      const rs = done.filter((r) => r.confidence === c.value);
      return { ...c, n: rs.length, right: rs.filter((r) => r.correct).length };
    }).filter((c) => c.n);
    const sure = byConf.find((c) => c.value === 'sure');
    const guess = byConf.find((c) => c.value === 'guess');
    const calibLine = sure
      ? `You were certain ${times(sure.n)} and right ${times(sure.right)}.${sure.right < sure.n ? ' Those are worth a second look — confident mistakes are the ones that stick.' : ''}`
      : guess ? `You were guessing ${times(guess.n)} and right ${times(guess.right)}.` : '';
    const tags = [...new Set(done.filter((r) => !r.correct && r.tag && TAGS[r.tag]).map((r) => r.tag))];
    const summary = sched.queueSummary(state, today());
    const link = reviewLink(state);
    stage.replaceChildren(h('section', { class: 'session-end stack', 'aria-labelledby': 'end-h' },
      h('h2', { id: 'end-h', tabindex: '-1' }, cfg.endTitle || 'Session complete'),
      h('div', { class: 'row' }, tile(`${right}/${done.length}`, 'right first time'), summary.due ? tile(summary.due, 'due for review now') : null, summary.later ? tile(summary.later, 'coming back later') : null),
      byConf.length ? h('div', { class: 'stack-sm' },
        h('h3', null, 'How sure were you?'),
        h('table', { class: 'calib' },
          h('thead', null, h('tr', null, h('th', null, 'You said'), h('th', null, 'Right'), h('th', null, 'Wrong'))),
          h('tbody', null, byConf.map((c) => h('tr', null, h('td', null, c.label), h('td', null, String(c.right)), h('td', null, String(c.n - c.right)))))),
        calibLine ? h('p', null, calibLine) : null) : null,
      tags.length ? h('div', { class: 'stack-sm' },
        h('h3', null, 'What to remember'),
        h('ul', { class: 'remember' }, tags.map((t) => h('li', null, h('strong', null, `${TAGS[t].label}. `), TAGS[t].fix || '')))) : null,
      summary.next !== null && summary.next !== undefined
        ? h('p', null, `What you missed comes back on ${formatDay(summary.next)}${summary.later > 1 ? ` (${summary.later} questions waiting)` : ''}.`)
        : h('p', null, 'Nothing is waiting for review.'),
      link ? h('div', { class: 'stack-sm' },
        h('p', { class: 'small' }, persistent() ? 'Your reviews are saved on this device. To take them to another device, or in case this one forgets, bookmark this link:' : "This browser won't remember your reviews, so bookmark this link to bring them back:"),
        copyBox(link, { what: 'Review link copied' })) : null,
      cfg.summaryNote ? h('p', { class: 'small muted' }, cfg.summaryNote) : null,
      h('div', { class: 'row' },
        button(cfg.againLabel || 'Another 10', { kind: 'primary', onClick: () => cfg.again() }),
        h('a', { class: 'btn', href: href('/') }, 'Home'))));
    stage.querySelector('#end-h').focus();
    announce(`Session complete. ${right} of ${done.length} right first time.`);
  }

  ask();
  return {
    dispose() { commit(); runner?.destroy(); },
    get state() { return state; },
  };
}

const times = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
