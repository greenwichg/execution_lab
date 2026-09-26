// Projector reveals for the lesson starter. An addition is laid out like the
// exam (carries above, a rule, the result) and the answer ripples in: carries
// appear right to left, then the result bits, then the lost carry is struck
// through. Other item types show the key answer in big type. Everything here
// is computed from the item's simulation, never typed by hand.
import { h, prefersReducedMotion } from '../lib/dom.js';
import { range as bitRange } from '../engine/bits.js';

const STEP_MS = 120;            // one column of the carry ripple
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const num = (v) => (Number(v) < 0 ? `−${-Number(v)}` : String(v));
const msb = (bits) => bits.slice().reverse().join('');

/** true for items that reveal as a column addition */
export const isAddition = (item) => (item.type === 'add' || item.type === 'sadd') && Array.isArray(item.show?.a);

/** what the adder really adds: operands, carries (carries[0] = carry in), result */
function additionData(item) {
  const s = item.sim;
  const w = item.show.w;
  if (item.type === 'sadd') {
    const { min, max } = bitRange(w, true);
    return {
      w, A: s.A, B: s.B, carries: s.carries, result: s.result, cout: s.cout, sub: item.show.op === '-',
      labels: { a: num(item.show.aValue), b: item.show.op === '-' ? `${num(item.show.bValue)} inverted` : num(item.show.bValue), r: num(s.signedValue) },
      overflow: s.OF === 1,
      lostIsOverflow: false,
      message: s.OF
        ? `Overflow: the true answer ${num(s.truth)} is outside ${num(min)} to ${max}, so it wraps round to ${num(s.signedValue)}.`
        : `No overflow: ${num(s.truth)} fits in ${w}-bit two's complement.${s.cout ? ' The carry out of the top column is simply ignored.' : ''}`,
      flags: item.key.flags,
    };
  }
  return {
    w, A: item.show.a, B: item.show.b, carries: s.carries, result: s.result, cout: s.cout, sub: false,
    labels: { a: String(item.show.aValue), b: String(item.show.bValue), r: String(s.value) },
    overflow: s.cout === 1,
    lostIsOverflow: true,
    message: s.cout
      ? `Overflow error: the answer needs ${w + 1} bits.`
      : `No overflow: the answer fits in ${w} bits.`,
    flags: null,
  };
}

/**
 * mountAddition(el, item) → { el, reveal({ animate }) → Promise, finish(), destroy(), get revealed }
 * Shows the question (operands, empty answer row) until reveal() runs the ripple.
 */
export function mountAddition(el, item) {
  const d = additionData(item);
  const { w } = d;
  const cols = w + 1;
  const grid = h('div', { class: 'rv-grid', style: { '--cols': String(cols) }, 'aria-hidden': 'true' });
  const cell = (text, cls) => h('span', { class: ['rv-c', cls] }, text);
  const put = (label, cells, right, cls) => {
    grid.append(h('span', { class: ['rv-label', cls] }, label), ...cells, right || h('span', { class: 'rv-right' }));
  };
  // bit numbers (small), then carries, operands, result
  put('', [cell('', 'rv-idx'), ...order(w).map((i) => cell(String(i), 'rv-idx'))], null, 'rv-idx-label');
  const carryCells = [];
  // the carry out of the top column is only drawn as lost (orange, struck through) when it is an overflow;
  // in a signed sum without overflow it is simply ignored, so it stays grey
  const lostOut = d.cout === 1 && d.overflow;
  for (let i = w; i >= 0; i--) carryCells[i] = cell('', ['rv-carry', i === w && 'rv-carry-out', i === w && lostOut && 'rv-carry-lost']);
  put('carry', order(w + 1).map((i) => carryCells[i]), null, 'rv-carry-label');
  const aRight = h('span', { class: 'rv-right' });
  const bRight = h('span', { class: 'rv-right' });
  const rRight = h('span', { class: 'rv-right' });
  put('', [cell('', 'rv-blank'), ...order(w).map((i) => cell(String(d.A[i]), 'rv-bit'))], aRight);
  put(d.sub ? '+¬' : '+', [cell('', 'rv-blank'), ...order(w).map((i) => cell(String(d.B[i]), 'rv-bit'))], bRight, 'rv-op');
  const resCells = [];
  for (let i = w; i >= 0; i--) resCells[i] = cell('', ['rv-res', i === w && 'rv-res-extra']);
  put('', order(w + 1).map((i) => resCells[i]), rRight);

  const note = h('p', { class: 'rv-note', role: 'status' });
  const summary = h('p', { class: 'visually-hidden' },
    `${d.sub ? 'Subtract' : 'Add'} ${msb(item.show.a)} ${d.sub ? 'minus' : 'plus'} ${msb(item.show.b)} in ${w} bits.`);
  const root = h('div', { class: 'rv rv-add' }, summary, h('div', { class: 'rv-scroll' }, grid), note);
  el.appendChild(root);

  let timers = [];
  let revealed = false;
  let done = false;
  let resolveDone = null;

  const showCarry = (i) => {
    const c = carryCells[i];
    c.textContent = d.carries[i] === 1 ? '1' : '';
    c.classList.add('on');
  };
  const showResults = () => {
    for (let i = 0; i < w; i++) { resCells[i].textContent = String(d.result[i]); resCells[i].classList.add('on'); }
  };
  const showEnd = () => {
    if (lostOut) {
      resCells[w].textContent = '1';
      resCells[w].classList.add('on', 'rv-lost');
    }
    aRight.textContent = d.labels.a;
    bRight.textContent = d.labels.b;
    rRight.textContent = d.labels.r;
    root.classList.add('rv-done');
    note.replaceChildren(...[
      h('span', { class: ['rv-verdict', d.overflow ? 'rv-over' : 'rv-fits'] },
        h('span', { class: 'rv-glyph', 'aria-hidden': 'true' }, d.overflow ? '⚠' : '✓'), ' ', d.message),
      d.flags && Object.keys(d.flags).length > 1
        ? h('span', { class: 'rv-flags' }, Object.entries(d.flags).map(([k, v]) => `${k} = ${v}`).join(' · '))
        : null,
      d.cout === 1 && d.lostIsOverflow
        ? h('span', { class: 'rv-lostnote' }, h('span', { class: 'lost-mark', 'aria-hidden': 'true' }, '1'), ` is lost — there is no bit ${w} to keep it.`)
        : null].filter(Boolean));
    summary.textContent = `${d.labels.a} ${d.sub ? 'minus' : 'plus'} ${d.sub ? num(item.show.bValue) : d.labels.b}: result ${msb(d.result)}, which is ${d.labels.r}. ${d.message}`;
  };
  const finishNow = () => {
    timers.forEach(clearTimeout);
    timers = [];
    for (let i = 0; i <= w; i++) showCarry(i);
    showResults();
    showEnd();
    done = true;
    resolveDone?.();
  };

  return {
    el: root,
    get revealed() { return revealed; },
    get done() { return done; },
    /** run the ripple (instant under reduced motion or animate: false) */
    reveal({ animate = true } = {}) {
      if (revealed) { if (!done) finishNow(); return Promise.resolve(); }
      revealed = true;
      root.classList.add('rv-revealing');
      if (!animate || prefersReducedMotion()) { finishNow(); return Promise.resolve(); }
      return new Promise((resolve) => {
        resolveDone = resolve;
        // carries right to left: the carry into column i + 1 is made by column i
        let t = 0;
        if (d.carries[0] === 1) { showCarry(0); t += STEP_MS; }
        else showCarry(0);
        for (let i = 1; i <= w; i++) { const k = i; timers.push(setTimeout(() => showCarry(k), t)); t += STEP_MS; }
        timers.push(setTimeout(showResults, t + 80));
        timers.push(setTimeout(() => { showEnd(); done = true; resolve(); }, t + 80 + 360));
      });
    },
    finish() { if (revealed && !done) finishNow(); },
    destroy() { timers.forEach(clearTimeout); timers = []; root.remove(); },
  };
}

/** mount the layout and reveal it at once (see mountAddition) */
export function revealAddition(el, item, { animate = true } = {}) {
  const ctl = mountAddition(el, item);
  ctl.reveal({ animate });
  return ctl;
}

/** a row of big static bits, MSB on the left */
export function bigBits(bits, { label, note } = {}) {
  return h('div', { class: 'rv-bitsrow' },
    label ? h('span', { class: 'rv-bitslabel' }, label) : null,
    h('span', { class: 'rv-bits', role: 'img', 'aria-label': `${label ? `${label}: ` : ''}${msb(bits)}` },
      bits.slice().reverse().map((b) => h('span', { class: 'rv-bitbox', 'aria-hidden': 'true' }, String(b)))),
    note ? h('span', { class: 'rv-bitsnote' }, note) : null);
}

/** what the class sees before the reveal (operands, the circuit inputs, the C snippet) */
export function questionVisual(item) {
  const s = item.show || {};
  if (item.type === 'shift') {
    return bigBits(s.x, { note: `${s.kind === 'arithmetic' ? 'arithmetic' : 'logical'} shift ${s.dir === 'L' ? 'left' : 'right'} ${s.k}` });
  }
  if (item.type === 'twos') return s.bits ? bigBits(s.bits) : null;
  if (item.type === 'fa') {
    return h('div', { class: 'rv-inputs' }, [['a', s.a], ['b', s.b], ['carry-in', s.cin]].map(([k, v]) =>
      h('span', { class: 'rv-input' }, h('span', { class: 'rv-input-k' }, k), h('span', { class: 'rv-bitbox' }, String(v)))));
  }
  if (item.type === 'card' && s.src) {
    return h('pre', { class: 'code rv-code' }, String(s.src).split('\n').map((t, i) => h('span', { class: ['src-line', i + 1 === s.focusLine && 'focus'] },
      h('span', { class: 'ln', 'aria-hidden': 'true' }, String(i + 1).padStart(2, ' ')), ' ', t || ' ', '\n')));
  }
  return null;
}

/** the key answer as [label, text, isBits] rows (every asked field) */
export function keyRows(item) {
  const rows = [];
  for (const f of item.fields || []) {
    let v = item.key?.[f.id];
    if (v === null || v === undefined) continue;
    if (f.kind === 'bits' && Array.isArray(v)) {
      const bits = v.filter((b, i) => !(i === f.optionalIndex && (b === null || b === undefined)));
      rows.push([f.label, msb(bits.map((b) => (b === null || b === undefined ? 0 : b))), true]);
    } else if (f.kind === 'flags' && typeof v === 'object') {
      rows.push([f.label, Object.entries(v).map(([k, x]) => `${k} = ${x}`).join(' · '), false]);
    } else if (typeof v === 'string' && f.kind !== 'text') rows.push([f.label, cap(v), false]);
    else rows.push([f.label, typeof v === 'number' ? num(v) : String(v), false]);
  }
  return rows;
}

/** the answer for a non-addition item, in big type */
export function revealKey(el, item) {
  const rows = keyRows(item);
  const root = h('dl', { class: 'rv rv-key' }, rows.map(([label, text, isBits]) => h('div', { class: 'rv-keyrow' },
    h('dt', null, label),
    h('dd', { class: [isBits && 'rv-keybits', text.includes('\n') && 'rv-keypre'] }, text))));
  el.appendChild(root);
  return root;
}

function order(n) { const a = []; for (let i = n - 1; i >= 0; i--) a.push(i); return a; }
