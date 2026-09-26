// A homework or study set from a teacher's link. The code fixes the questions,
// so everyone gets the same set; the learner's answers stay on this device.
// At the end a short result code carries the first-attempt scores (and, for
// study sets, the randomly assigned group) back to the teacher by paste.
import { h, href, announce, focus, replace } from '../../lib/dom.js';
import { load, save } from '../../lib/store.js';
import { mulberry32, newSeed } from '../../lib/rng.js';
import { decodeSet, encodeToken, ARM_UNKNOWN } from '../../lib/codec.js';
import { itemForSpec, makeItem, ITEM_TYPES } from '../../learn/items/index.js';
import { planSet, summarizeSet } from '../../learn/sets.js';
import { assignArm, recoverArm } from '../../learn/study.js';
import * as sched from '../../learn/scheduler.js';
import { button, callout, copyBox, tile } from '../parts.js';
import { mountItem } from '../runner.js';
import { loadSched, saveSched, reviewLink } from '../session.js';
import { setNav } from '../nav.js';

let runner = null;
let flush = null;
let onHide = null;

const validArm = (a) => a === 0 || a === 1;

export function render(el, ctx) {
  setNav(null);
  let set;
  try { set = decodeSet(ctx.params.code); } catch (e) {
    el.append(h('main', { class: 'page page-narrow stack', 'data-view': 'set' },
      h('h1', null, "This link doesn't work"),
      h('p', { class: 'lede' }, 'This link looks incomplete. Ask your teacher to send it again.'),
      h('p', { class: 'small muted' }, e.message),
      h('p', null, h('a', { class: 'btn', href: href('/') }, 'Go to the start'))));
    return;
  }
  const { setId, mode, n, level } = set;
  const progKey = `setprog.${setId}`;

  // ---------------------------------------------------------------- the arm (study sets only; never shown)
  let arm;
  if (mode === 'study') {
    arm = load(`arm.${setId}`, null);
    if (!validArm(arm)) { arm = assignArm(newSeed()); save(`arm.${setId}`, arm); }
  } else if (mode === 'delayed') {
    const stored = set.link !== null ? load(`arm.${set.link}`, null) : null;
    arm = validArm(stored) ? stored : ARM_UNKNOWN;
  }
  const plan = planSet(set, { arm: mode === 'study' ? arm : undefined });

  // ---------------------------------------------------------------- progress (survives a reload)
  let prog = load(progKey, null);
  if (!prog || prog.code !== set.code || !Array.isArray(prog.results)) prog = { code: set.code, results: [], token: null };
  prog.results = plan.map((_, i) => {
    const r = prog.results[i];
    return r && typeof r.correct === 'boolean' ? { correct: r.correct, tag: typeof r.tag === 'string' ? r.tag : null } : null;
  });
  const saveProg = () => save(progKey, prog);
  const firstOpen = () => { const k = prog.results.findIndex((r) => !r); return k < 0 ? plan.length : k; };

  const stage = h('div', { class: 'hs-stage stack' });
  const main = h('main', { class: 'page page-narrow stack hs', 'data-view': 'set' },
    h('h1', null, mode === 'normal' ? 'Homework set' : 'Practice set'),
    stage);
  el.append(main);

  // ---------------------------------------------------------------- intro
  function intro() {
    const done = firstOpen();
    const minutes = Math.max(5, Math.round(n * 1.5));
    const recover = mode === 'delayed' && arm === ARM_UNKNOWN && set.link !== null && done === 0 ? recoverBox() : null;
    const start = button(done > 0 ? `Carry on from question ${done + 1}` : 'Start', { kind: 'primary', onClick: () => ask(done) });
    replace(stage,
      h('div', { class: 'row' }, tile(n, n === 1 ? 'question' : 'questions'), tile(`~${minutes}`, 'minutes')),
      h('p', { class: 'lede' }, 'When you finish you\'ll get a result code to paste into your assignment. Your answers stay on this device.'),
      done > 0 ? h('p', null, `You've answered ${done} of ${n}. You can carry on where you left off.`) : null,
      recover,
      h('div', { class: 'row' }, start),
      h('p', { class: 'small muted' }, 'Answer each question once, as well as you can. It is the first try that counts.'));
  }

  function recoverBox() {
    const input = h('input', { type: 'text', id: 'hs-recover', autocomplete: 'off', spellcheck: 'false', class: 'mono', placeholder: 'XXXX-XXXX-XXXX' });
    const msg = h('div', { role: 'status' });
    const use = button('Use this code', { small: true, onClick: () => {
      const r = recoverArm(input.value, set.link);
      if (validArm(r.arm)) {
        arm = r.arm;
        save(`arm.${set.link}`, arm);
        box.replaceChildren(callout('ok', null, "Thanks, that's all we need."));
        announce('Code accepted.');
      } else {
        msg.replaceChildren(callout('bad', null, r.error || 'That code did not work. You can carry on without it.'));
      }
    } });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); use.click(); } });
    const box = h('section', { class: 'panel tight stack-sm hs-recover', 'aria-labelledby': 'hs-recover-h' },
      h('h2', { id: 'hs-recover-h', class: 'hs-small-h' }, 'Did last week\'s set on another device?'),
      h('div', { class: 'field' },
        h('label', { class: 'hint', for: 'hs-recover' }, 'Paste its result code (optional). You can skip this.'),
        h('div', { class: 'row' }, input, use)),
      msg);
    return box;
  }

  // ---------------------------------------------------------------- questions
  let pending = null;
  function commit(tagOverride) {
    if (!pending) return;
    const p = pending;
    pending = null;
    try {
      const state = sched.recordAttempt(loadSched(), {
        type: p.item.type, params: ITEM_TYPES[p.item.type].encodeParams(p.item.params),
        correct: p.correct, tag: (tagOverride !== undefined ? tagOverride : p.tag) || undefined,
        group: p.group, today: sched.dayNumber(new Date()),
      });
      saveSched(state);
    } catch (e) { console.error(e); }
  }
  flush = () => commit();
  // a reload or a closed tab after Check (before Next) must still send the miss to the review queue
  if (onHide) removeEventListener('pagehide', onHide);
  onHide = () => commit();
  addEventListener('pagehide', onHide);

  function ask(i) {
    runner?.destroy();
    runner = null;
    if (i >= plan.length) return finish();
    const slot = plan[i];
    let item;
    try {
      const made = itemForSpec(slot.spec, mulberry32(slot.seed), { level });
      item = makeItem(made.type, made.params);
    } catch (e) {
      console.error(e);
      prog.results[i] = { correct: false, tag: null };
      saveProg();
      return ask(i + 1);
    }
    stage.replaceChildren();
    runner = mountItem(stage, item, {
      mode: 'set', feedback: slot.feedback, level: item.level || level, variants: false,
      progress: `Question ${i + 1} of ${plan.length}`,
      nextLabel: i === plan.length - 1 ? 'Finish' : 'Next question',
      onDone(r) {
        prog.results[i] = { correct: r.correct, tag: r.tag || null };
        saveProg();
        pending = { item, correct: r.correct, tag: r.tag, group: slot.group };
        if (r.correct || slot.feedback === 'answerOnly') commit();
      },
      onFinal(r) {
        if (r.diagnosis?.tag && prog.results[i] && !prog.results[i].correct) { prog.results[i].tag = r.diagnosis.tag; saveProg(); }
        commit(r.diagnosis?.tag ?? undefined);
      },
      onNext() { ask(firstOpen()); },
    });
    runner.focus();
  }

  // ---------------------------------------------------------------- the result code
  function finish() {
    commit();
    let token = prog.token;
    const summary = summarizeSet(prog.results, plan, { setId, mode, arm });
    try { token = encodeToken(summary); } catch (e) { console.error(e); }
    prog.token = token;
    saveProg();
    const right = summary.g1.right + summary.g2.right;
    const total = summary.g1.total + summary.g2.total;
    const link = reviewLink(loadSched());
    const heading = h('h2', { tabindex: '-1' }, 'Your result code');
    stage.replaceChildren(h('section', { class: 'hs-end stack', 'aria-labelledby': 'hs-end-h' },
      Object.assign(heading, { id: 'hs-end-h' }),
      token ? copyBox(token, { big: true, what: 'Result code copied' }) : callout('bad', null, 'Something went wrong making your code. Ask your teacher.'),
      h('p', { class: 'hs-hand-in' }, 'Paste this code into your assignment.'),
      h('p', { class: 'small muted' }, 'It holds only your scores and which kinds of mistake came up: no name.'),
      h('div', { class: 'row' }, tile(`${right}/${total}`, 'right first time')),
      link ? h('div', { class: 'stack-sm' },
        h('h3', null, 'Your review link'),
        h('p', { class: 'small' }, 'What you missed comes back for review in 2, 7 and 21 days. Bookmark this link to keep your reviews, even if this device forgets.'),
        copyBox(link, { what: 'Review link copied' })) : null,
      h('div', { class: 'row' },
        h('a', { class: 'btn', href: href('/review') }, 'Review'),
        h('a', { class: 'btn ghost', href: href('/') }, 'Home'))));
    focus(heading);
    announce(`Set complete. ${right} of ${total} right first time. Your result code is on the screen.`);
  }

  // every question answered (even if the page closed before the code was shown): straight to the code
  if (firstOpen() >= plan.length) finish();
  else intro();
}

export function dispose() {
  flush?.(); flush = null;
  if (onHide) { removeEventListener('pagehide', onHide); onHide = null; }
  runner?.destroy(); runner = null;
}

