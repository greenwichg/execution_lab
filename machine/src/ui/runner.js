// The item runner: one item through the whole loop —
// predict (+ confidence) → verify → locate the break (checkpoints) →
// diagnose → Why? ↓ → try one like it.
import { h, announce, focus } from '../lib/dom.js';
import { mulberry32, hashStr } from '../lib/rng.js';
import { ITEM_TYPES } from '../learn/items/index.js';
import { specById, specLabel } from '../learn/spec.js';
import { TAGS } from '../learn/catalogue.js';
import { button, chip, seg, confidence, callout, statusGlyph } from './parts.js';
import { bitRow, bitInput, addGrid } from './bitgrid.js';
import { renderWhy, renderLayer } from './why.js';

const FLAG_NAMES = ['CF', 'ZF', 'SF', 'OF'];
const LONG_FLAG = { CF: 'Carry flag (CF)', ZF: 'Zero flag (ZF)', SF: 'Sign flag (SF)', OF: 'Overflow flag (OF)' };
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
// only plain yes/no answers get a capital: C type names, instructions (jae) and printed
// messages ("not less") must appear exactly as the machine spells them
const choiceLabel = (c) => (c === 'yes' || c === 'no' ? cap(c) : String(c));
const firstSentence = (s) => { const m = String(s || '').match(/^.*?[.!?](\s|$)/); return m ? m[0].trim() : String(s || ''); };

export function moduleFor(item) {
  const mod = ITEM_TYPES[item.type];
  if (!mod) throw new Error(`Unknown item type ${item.type}`);
  return mod;
}

/**
 * mountItem(el, item, opts) — see CONTRACTS.md "UI contract".
 */
export function mountItem(el, item, opts = {}) {
  const mod = moduleFor(item);
  const level = opts.level || item.level || 'gcse';
  const feedback = opts.feedback || 'full';
  const t0 = performance.now();
  const answer = mod.blank(item);
  const cps = [];
  let marking = null, diagnosis = null, depth = 0, finished = false, conf = null, doneResult = null;

  const spec = specById(item.spec);
  const head = h('div', { class: 'item-head row spread' },
    spec && opts.showSpec !== false ? chip(specLabel(spec)) : h('span'),
    opts.progress ? h('span', { class: 'item-progress muted small' }, opts.progress) : null);
  const prompt = h('h2', { class: 'item-prompt' }, item.prompt);
  const before = h('div', { class: 'item-before' });
  const answerArea = h('div', { class: 'item-answer' });
  const confBox = confidence((v) => { conf = v; checkHint.textContent = ''; }, null);
  const checkHint = h('p', { class: 'check-hint small muted', role: 'status' });
  const checkBtn = button('Check answer', { kind: 'primary', onClick: () => check() });
  const actions = h('div', { class: 'item-actions row' }, checkBtn, checkHint);
  const feedbackEl = h('div', { class: 'item-feedback stack' });
  const root = h('section', { class: ['item', `item-${item.type}`, opts.mode && `mode-${opts.mode}`], 'aria-label': 'Question' },
    head, prompt, before, answerArea, confBox.el, actions, feedbackEl);
  el.appendChild(root);
  opts.beforePrompt?.(before, item);

  const controls = renderFields(item, answer, answerArea, { projector: opts.mode === 'starter' });

  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || marking) return;
    const t = e.target;
    if (t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || t.tagName === 'A') return;
    e.preventDefault();
    check();
  });

  function check() {
    if (marking) return;
    const missing = controls.incomplete();
    if (missing) {
      checkHint.textContent = missing.message;
      missing.focus?.();
      return;
    }
    if (!conf) {
      checkHint.textContent = 'First choose how sure you are — it helps you see what you really know.';
      confBox.el.querySelector('button')?.focus();
      return;
    }
    marking = mod.mark(item, answer);
    controls.lock(marking, item.key);
    root.classList.add('locked-grid');
    confBox.setDisabled(true);
    checkBtn.remove();
    checkHint.remove();
    const ms = Math.round(performance.now() - t0);
    const { right, total } = marking.score || { right: 0, total: 0 };
    announce(marking.correct ? 'Correct.' : `Not quite. ${total - right} of ${total} ${total === 1 ? 'part is' : 'parts are'} wrong.`);
    // first diagnosis step (may be final already, e.g. when the working is shown)
    let first = { next: null, diagnosis: null };
    if (!marking.correct) { try { first = mod.diagnose(item, answer, marking, cps) || first; } catch (e) { console.error(e); } }
    doneResult = { correct: marking.correct, confidence: conf, tag: first.diagnosis?.tag ?? null, answer: structuredClone(answer), marking, ms };
    opts.onDone?.(doneResult);
    if (feedback === 'answerOnly') return showAnswerOnly();
    if (marking.correct) return showCorrect();
    step(first);
  }

  function showAnswerOnly() {
    feedbackEl.append(
      h('p', { class: 'neutral-line' }, marking.correct ? 'Correct.' : 'Here is the correct answer.'),
      nextButtons(false));
    opts.afterReveal?.(feedbackEl, { item, marking });
    focusFeedback();
  }

  function showCorrect() {
    const layers = safeWhy(null);
    const fact = layers[0]?.say?.[0] ? firstSentence(layers[0].say[0]) : '';
    feedbackEl.append(callout('ok', 'Correct.', fact));
    opts.afterReveal?.(feedbackEl, { item, marking });
    if (layers.length) mountWhy(layers, true);
    feedbackEl.append(nextButtons(false));
    focusFeedback();
  }

  // one checkpoint at a time, then the diagnosis
  function step(res) {
    if (res.next && cps.length < 3) return askCheckpoint(res.next);
    diagnosis = res.diagnosis || { tag: 'other', headline: 'Not quite.', detail: 'Compare your answer with the correct one, column by column.', focus: {} };
    const tagInfo = diagnosis.tag ? TAGS[diagnosis.tag] : null;
    feedbackEl.append(callout('bad', diagnosis.headline, diagnosis.detail || tagInfo?.student || ''));
    opts.afterReveal?.(feedbackEl, { item, marking });
    const layers = safeWhy(diagnosis);
    if (layers.length) mountWhy(layers, !!opts.collapsedWhy, opts.collapsedWhy ? 0 : 1);
    if (opts.showWorked && tagInfo?.worked) feedbackEl.append(workedExample(tagInfo, item));
    feedbackEl.append(nextButtons(true));
    focusFeedback();
  }

  function askCheckpoint(cp) {
    const box = h('div', { class: 'checkpoint panel tight stack-sm' },
      cps.length === 0 ? h('p', { class: 'checkpoint-intro' }, "Let's find where it went wrong.") : null,
      h('p', { class: 'checkpoint-q' }, cp.prompt));
    let value = null;
    const input = checkpointInput(cp, (v) => { value = v; });
    const go = button('Answer', { kind: 'primary', small: true });
    const skip = button('Not sure', { small: true, kind: 'ghost' });
    const row = h('div', { class: 'row' }, input.el, go, skip);
    const cpHint = h('p', { class: 'small muted cp-hint', role: 'status' });
    box.append(row, cpHint);
    feedbackEl.append(box);
    let answered = false;
    const submit = (v, fromAnswer) => {
      if (answered) return;
      // Answer with nothing readable is not "Not sure": say what is needed instead
      if (fromAnswer && v === null) {
        const typed = input.el.tagName === 'INPUT' && input.el.value.trim() !== '';
        cpHint.textContent = typed ? 'Type a whole number in denary, such as -56, or choose Not sure.' : 'Give an answer first, or choose Not sure.';
        return;
      }
      answered = true;
      cpHint.remove();
      if (v === null && input.el.tagName === 'INPUT') input.el.value = '';
      go.disabled = true; skip.disabled = true; input.disable();
      const right = sameValue(v, cp.answer) || (cp.accept || []).some((a) => sameValue(v, a));
      // "Not sure" is not a wrong answer: no ✗, just the value
      box.append(v === null
        ? h('p', { class: 'small muted cp-result' }, `The answer is ${showValue(cp.answer, cp.input)}.`)
        : h('p', { class: ['small', 'cp-result', right ? 'ok' : 'bad'] }, statusGlyph(right ? 'ok' : 'bad'), ' ',
          right ? 'Right.' : `Not quite — it's ${showValue(cp.answer, cp.input)}.`));
      cps.push(v);
      let res = { next: null, diagnosis: null };
      try { res = mod.diagnose(item, answer, marking, cps) || res; } catch (e) { console.error(e); }
      step(res);
    };
    go.addEventListener('click', () => submit(value, true));
    skip.addEventListener('click', () => submit(null));
    if (input.el.tagName === 'INPUT') input.el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(value, true); } });
    input.focus();
  }

  function mountWhy(layers, collapsed, startOpen = 0) {
    const holder = h('div', { class: 'item-why' });
    feedbackEl.append(holder);
    renderWhy(holder, layers, { level, startOpen, onDepth: (n) => { depth = n; }, firstLabel: collapsed ? 'Show why ↓' : 'Why? ↓' });
  }

  function safeWhy(diag) {
    try { return mod.why(item, diag, { level }) || []; } catch (e) { console.error(e); return []; }
  }

  function nextButtons(wrong) {
    const row = h('div', { class: 'item-next row' });
    const finish = (kind) => {
      if (finished) return;
      finished = true;
      opts.onFinal?.({ ...doneResult, depth, checkpoints: cps.length, cpAnswers: cps.slice(), diagnosis });
      opts.onNext?.(kind);
    };
    const aimable = !!diagnosis?.tag && (mod.TARGETS || []).includes(diagnosis.tag);
    if (wrong && feedback === 'full' && opts.variants !== false && aimable) {
      row.append(button('Try one like it', { kind: 'primary', onClick: () => finish('variant') }),
        button(opts.nextLabel || 'Next question', { onClick: () => finish('next') }));
    } else {
      row.append(button(opts.nextLabel || 'Next question', { kind: 'primary', onClick: () => finish('next') }));
    }
    return row;
  }

  function focusFeedback() {
    // the newest callout (the diagnosis comes after any answered checkpoints)
    const target = [...feedbackEl.querySelectorAll('.callout, .neutral-line')].pop()
      || feedbackEl.querySelector('.checkpoint input:not([readonly]), .checkpoint button:not(:disabled)');
    if (target && target.matches('.callout, .neutral-line')) { target.setAttribute('tabindex', '-1'); focus(target); }
    else focus(target);
  }

  return {
    root,
    destroy() { root.remove(); },
    focus() { controls.focusStart(); },
  };
}

// ------------------------------------------------------------------ fields
function renderFields(item, answer, area, { projector }) {
  const locks = [];
  const checks = [];            // () => { message, focus } | null, in page order
  let focusStart = null;
  const gridFields = new Set();
  const isAddition = Array.isArray(item.show?.a) && Array.isArray(item.show?.b) && (item.type === 'add' || item.type === 'sadd');
  let grid = null;
  if (isAddition) {
    const resultField = item.fields.find((f) => f.kind === 'bits' && f.id !== 'carries');
    const carriesField = item.fields.find((f) => f.id === 'carries');
    grid = addGrid(item, answer, { carriesField: carriesField ? 'carries' : '__none', resultField: resultField.id, projector });
    gridFields.add(resultField.id); if (carriesField) gridFields.add('carries');
    area.append(grid.el);
    focusStart = () => grid.focusStart();
    locks.push((m, key) => grid.lock(m, key));
    const rf = resultField;
    checks.push(() => {
      const bits = answer[rf.id] || [];
      const empty = bits.findIndex((b, i) => i !== rf.optionalIndex && (b === null || b === undefined));
      return empty < 0 ? null : { message: 'Fill in every bit of the result (0 or 1) — an empty carry box just means no carry.', focus: () => grid.focusResult(empty) };
    });
  } else if (item.show && (item.show.bits || item.show.x !== undefined)) {
    area.append(showOperand(item));
  }
  for (const f of item.fields) {
    if (gridFields.has(f.id)) continue;
    const ctl = fieldControl(f, item, answer);
    area.append(ctl.el);
    if (!focusStart) focusStart = ctl.focus;
    locks.push((m, key) => ctl.lock(m.cells?.[f.id], key?.[f.id]));
    if (!f.optional) checks.push(() => (ctl.isEmpty() ? { message: ctl.emptyMessage, focus: ctl.focus } : null));
  }
  return {
    focusStart: () => focusStart?.(),
    incomplete() { for (const c of checks) { const r = c(); if (r) return r; } return null; },
    lock(m, key) {
      locks.forEach((fn) => fn(m, key));
      if (grid && item.show.aValue !== undefined) grid.showValues(valueLabels(item));
    },
  };
}

const signedText = (v) => (v === '' || v === undefined || v === null ? '' : Number(v) < 0 ? `−${-Number(v)}` : String(v));
function valueLabels(item) {
  const s = item.show;
  if (s.labels) return s.labels;
  // a signed sum is read in two's complement: −20 + −30 = −50, not 206
  const signed = item.type === 'sadd' || s.signed;
  const r = signed && item.sim && item.sim.signedValue !== undefined ? item.sim.signedValue
    : item.sim && typeof item.sim.value === 'number' ? item.sim.value : '';
  return { a: signedText(s.aValue ?? ''), b: signedText(s.bValue ?? ''), r: signedText(r) };
}

/** operand display for non-addition items (shift source, two's complement bits…) */
function showOperand(item) {
  const s = item.show;
  const bits = s.bits || s.x;
  if (!Array.isArray(bits)) return h('span');
  return h('div', { class: 'operand row' },
    s.operandLabel ? h('span', { class: 'muted' }, s.operandLabel) : null,
    h('span', { class: 'bits-static', 'aria-label': `Bits ${bits.slice().reverse().join('')}` },
      bits.slice().reverse().map((b) => h('span', { class: 'bit-static', 'aria-hidden': 'true' }, String(b)))),
    s.operandNote ? h('span', { class: 'muted small' }, s.operandNote) : null);
}

function fieldControl(f, item, answer) {
  const label = h('span', { class: 'field-label' }, f.label);
  if (f.kind === 'bits') {
    const w = f.width || (answer[f.id] || []).length;
    if (!Array.isArray(answer[f.id])) answer[f.id] = new Array(w).fill(null);
    const row = bitRow(w, { values: answer[f.id], label: f.label, dir: f.dir || 'right', optionalIndex: f.optionalIndex, cellLabel: (i) => `${f.label}, bit ${i}` });
    const el = h('div', { class: 'field field-bits' }, label, row.el);
    const isEmpty = () => answer[f.id].some((b, i) => i !== f.optionalIndex && (b === null || b === undefined));
    return { el, focus: () => row.focusStart(), lock: (st, key) => row.lock(Array.isArray(st) ? st : [], key || []), isEmpty, emptyMessage: `Fill in every bit of “${f.label}” (0 or 1).` };
  }
  if (f.kind === 'choice' || f.kind === 'bit') {
    const choices = f.kind === 'bit' ? [0, 1] : f.choices;
    const s = seg(choices.map((c) => ({ value: c, label: choiceLabel(c) })), { label: f.label, value: answer[f.id], onChange: (v) => { answer[f.id] = v; } });
    const note = h('span', { class: 'field-note' });
    const el = h('div', { class: 'field field-choice row' }, label, s.el, note);
    return {
      el, focus: () => s.el.querySelector('button')?.focus(),
      lock(st, key) { s.setDisabled(true); markNote(note, st, key, choiceLabel); },
      isEmpty: () => answer[f.id] === null || answer[f.id] === undefined, emptyMessage: `Choose an answer for “${f.label}”.`,
    };
  }
  if (f.kind === 'flags') {
    const names = f.flags || item.params?.askFlags || FLAG_NAMES;
    if (!answer[f.id] || typeof answer[f.id] !== 'object') answer[f.id] = {};
    const segs = {};
    const notes = {};
    const rows = names.map((n) => {
      segs[n] = seg([{ value: 0, label: '0' }, { value: 1, label: '1' }], { label: LONG_FLAG[n] || n, value: answer[f.id][n] ?? null, onChange: (v) => { answer[f.id][n] = v; } });
      notes[n] = h('span', { class: 'field-note' });
      return h('div', { class: 'flag-row row' }, h('abbr', { class: 'flag-name', title: LONG_FLAG[n] }, n), segs[n].el, notes[n]);
    });
    const el = h('div', { class: 'field field-flags' }, label, h('div', { class: 'flag-grid' }, rows));
    return {
      el, focus: () => segs[names.find((n) => answer[f.id][n] === null || answer[f.id][n] === undefined) || names[0]].el.querySelector('button')?.focus(),
      isEmpty: () => names.some((n) => answer[f.id][n] === null || answer[f.id][n] === undefined), emptyMessage: 'Set every flag to 0 or 1.',
      lock(st, key) {
        names.forEach((n, idx) => {
          segs[n].setDisabled(true);
          // items report flag statuses as an array in the field's flag order
          const s1 = Array.isArray(st) ? st[idx] : st && typeof st === 'object' ? st[n] : st;
          markNote(notes[n], s1, key?.[n], String);
        });
      },
    };
  }
  // number / text
  const multiline = f.kind === 'text' && f.multiline !== false;
  const input = multiline
    ? h('textarea', { class: 'mono', rows: String(f.rows || 3), 'aria-label': f.label, spellcheck: 'false' })
    : h('input', { type: 'text', inputmode: f.kind === 'number' ? 'numeric' : 'text', 'aria-label': f.label, class: f.kind === 'number' ? 'num-in' : 'mono', autocomplete: 'off', spellcheck: 'false' });
  input.addEventListener('input', () => { answer[f.id] = f.kind === 'number' ? (f.decimal ? parseDecimal(input.value) : parseWhole(input.value)) : input.value; });
  const note = h('span', { class: 'field-note' });
  const el = h('div', { class: ['field', `field-${f.kind}`] }, h('label', { class: 'field-label' }, f.label, input), note);
  const isEmpty = () => (f.kind === 'number' ? answer[f.id] === null || answer[f.id] === undefined : !String(answer[f.id] ?? '').trim());
  return {
    el, focus: () => input.focus(),
    lock(st, key) { input.readOnly = true; markNote(note, st, key, (k) => String(k)); },
    isEmpty,
    get emptyMessage() {
      if (f.kind !== 'number') return `Type your answer for “${f.label}”.`;
      return input.value.trim() ? (f.decimal ? 'Type a number in denary, such as 11 or 11.25.' : 'Type a whole number in denary, such as -56.') : `Type a number for “${f.label}”.`;
    },
  };
}

function markNote(note, status, key, fmt) {
  if (!status) return;
  note.replaceChildren(statusGlyph(status === 'extra' ? 'bad' : status));
  if (status !== 'ok' && key !== undefined && key !== null) note.append(' ', h('span', { class: 'correct-was' }, `Answer: ${fmt(key)}`));
  note.classList.add(`st-${status}`);
}

// ------------------------------------------------------------------ checkpoints
export function checkpointInput(cp, onChange) {
  const kind = cp.input?.kind;
  if (kind === 'bit' || kind === 'choice') {
    const choices = kind === 'bit' ? [0, 1] : cp.input.choices;
    const s = seg(choices.map((c) => ({ value: c, label: choiceLabel(c) })), { label: cp.prompt, onChange });
    return { el: s.el, focus: () => s.el.querySelector('button')?.focus(), disable: () => s.setDisabled(true) };
  }
  if (kind === 'bits') {
    const w = cp.input.width || 2;
    const values = new Array(w).fill(null);
    const row = bitRow(w, { values, label: 'Your answer', dir: 'right', onChange: () => onChange(values.slice()) });
    return { el: row.el, focus: () => row.focusStart(), disable: () => row.lock([], []) };
  }
  const input = h('input', { type: 'text', inputmode: 'numeric', class: 'num-in', 'aria-label': cp.prompt, autocomplete: 'off' });
  input.addEventListener('input', () => onChange(parseWhole(input.value)));
  return { el: input, focus: () => input.focus(), disable: () => { input.readOnly = true; } };
}

/** '−37' → -37; beyond ±2^53 a BigInt so 64-bit values stay exact; otherwise null */
export function parseWhole(text) {
  const t = String(text).trim().replace(/[−–]/g, '-').replace(/[\s,_]/g, '');
  if (!/^-?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : BigInt(t);
}

/** decimals allowed (e.g. a shift "value" answer of 11.25); otherwise null */
export function parseDecimal(text) {
  const t = String(text).trim().replace(/[−–]/g, '-').replace(/[\s_]/g, '');
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, i < b.length ? b[i] : undefined));
  const num = (x) => typeof x === 'number' || typeof x === 'bigint';
  if (num(a) && num(b)) return String(a) === String(b);
  return a === b;
}
function showValue(v, input) {
  if (Array.isArray(v)) return v.slice().reverse().join('');
  if (input?.kind === 'choice' && typeof v === 'string') return choiceLabel(v);
  return String(v);
}

// ------------------------------------------------------------------ worked example
function workedExample(tagInfo, item) {
  let ex = null;
  try { ex = tagInfo.worked(seededRng(item)); } catch (e) { console.error(e); }
  if (!ex) return h('span');
  return h('section', { class: 'worked panel stack-sm', 'aria-label': 'Worked example' },
    h('h3', null, `Worked example: ${ex.title}`),
    h('ol', { class: 'worked-steps' }, ex.steps.map((s) => h('li', null,
      h('strong', null, s.subgoal), ' — ', s.text,
      s.layer ? h('div', { class: 'worked-layer' }, renderLayer(s.layer)) : null))));
}

const seededRng = (item) => mulberry32(hashStr(`${item.type}|${JSON.stringify(item.params)}`));

export { bitInput, workedExample };
