// Unsigned w-bit binary addition (GCSE 1.2.4). The answer key comes from the
// ripple-carry simulation in engine/bits.js; diagnosis walks the learner's
// working in the order they wrote it (right to left) and names the first
// column whose rule broke. The column helpers are exported because signed
// addition (sadd.js) analyses its result bits with the same rules.
import { addBits, toBits } from '../../engine/bits.js';
import { randInt, chance } from '../../lib/rng.js';

export const TYPE = 'add';
export const TYPE_ID = 0;
export const TARGETS = [
  'add_or', 'add_no_carry', 'add_three_ones', 'add_carry_wrong_col',
  'add_ninth_bit', 'add_overflow_missed', 'add_overflow_false',
];

// ---------------------------------------------------------------------------
// Shared helpers for the binary item types
// ---------------------------------------------------------------------------

// Level travels inside params (as a small code) so a URL or queue entry
// rebuilds exactly the same item, including level-dependent diagnosis.
export const LEVEL_CODES = [null, 'gcse', 'alevel', 'csapp'];
export const levelCode = (level) => Math.max(0, LEVEL_CODES.indexOf(level ?? null));
export const levelFrom = (code) => LEVEL_CODES[code] || null;
export const withLevel = (params, level) => (level ? { ...params, level } : params);

/** MSB-first string of an LSB-first bit array (how the learner reads it) */
export const binStr = (bits) => bits.slice().reverse().map((b) => (b === null || b === undefined ? '_' : b)).join('');
export const clampW = (w, lo, hi, dflt) => (Number.isInteger(w) ? Math.min(hi, Math.max(lo, w)) : dflt);
export const popcount = (bits) => bits.reduce((n, b) => n + (b ? 1 : 0), 0);
export const sameBits = (x, y) => x.length === y.length && x.every((b, i) => b === y[i]);

/** numbers in sentences: a true minus sign for negatives */
export const num = (v) => (v < 0 ? `\u2212${-v}` : String(v));

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
/** 'two 1s', 'one 1' — small counts in words, as in written English */
export const count = (n, noun) => `${WORDS[n] ?? n} ${noun}${n === 1 ? '' : 's'}`;
export const cap = (s) => s[0].toUpperCase() + s.slice(1);

/** 'an 8-bit', 'a 16-bit' */
export const aWidth = (w) => `${[8, 11, 18].includes(w) ? 'an' : 'a'} ${w}-bit`;

export function ordinal(n) {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
}

/** 'the 8s column' — GCSE learners name columns by place value */
export const colName = (i) => `the ${2 ** i}s column`;

/** the column rule: a + b + carry-in → [sum bit, carry out] */
export const colRule = (a, b, c) => [(a + b + c) & 1, (a + b + c) >> 1];

/** '1 + 1 + carry 1' — the column's inputs as the learner would say them */
export const colTerms = (a, b, c) => (c ? `${a} + ${b} + carry ${c}` : `${a} + ${b}`);

/** full-adder wire values for one column (x1 = a⊕b, a1 = a·b, a2 = x1·cin) */
export function adderWires(a, b, cin) {
  const x1 = a ^ b;
  const a1 = a & b;
  const a2 = x1 & cin;
  return { a, b, cin, x1, a1, a2, sum: x1 ^ cin, cout: a1 | a2 };
}

/**
 * Name the misconception behind one wrong column. The carry-in `c` is the
 * correct one (every column to the right was right, or a checkpoint just
 * confirmed it); r and co are what the learner wrote (co null = no carry).
 */
export function classifyColumn(a, b, c, r, co) {
  const n = a + b + c;
  const co0 = co ?? 0;
  // 1 + 1 + 1 → "0 carry 1" first: it is also what ignoring the carry gives,
  // but the named misconception is the likelier (and more specific) one.
  if (n === 3 && r === 0 && co0 === 1) return 'add_three_ones';
  // Carry written (or known) but the column was added as if it were not there.
  if (c === 1) {
    const [s0, c0] = colRule(a, b, 0);
    if (r === s0 && co0 === c0) return 'add_no_carry';
  }
  if (n === 2 && r === 1 && co0 === 0) return 'add_or';
  if (n >= 2 && r === (n & 1) && co0 === 0) return 'add_no_carry';
  return 'other';
}

/** '= 3, which is 11 in binary: write 1 and carry 1' — the rule for n ones */
export function ruleClause(n) {
  return n >= 2
    ? `= ${n}, which is ${n.toString(2)} in binary: write ${n & 1} and carry 1`
    : `= ${n}, so write ${n} with nothing to carry`;
}

/**
 * Specific, two-sentence explanation of a wrong column. r and co are what the
 * learner wrote, so "ignored the carry" and "dropped the carry" read differently.
 */
export function columnDetail(tag, i, a, b, c, r = null, co = null, name = colName(i)) {
  const n = a + b + c;
  const t = colTerms(a, b, c);
  if (tag === 'add_or') return `In ${name} you worked out ${t} as 1 with no carry. ${t} = 2, which is 10 in binary: write 0 and carry 1.`;
  if (tag === 'add_three_ones') return `In ${name} you wrote 0 carry 1 for 1 + 1 + 1. That is 3, which is 11 in binary: write 1 and carry 1.`;
  if (tag === 'add_no_carry') {
    const [s0, c0] = colRule(a, b, 0);
    if (c === 1 && r === s0 && (co ?? 0) === c0) return `A carry of 1 comes into ${name}, but you didn't add it. ${t} ${ruleClause(n)}.`;
    return `In ${name}, ${t} ${ruleClause(n)}. You didn't carry the 1 into the next column to the left.`;
  }
  return `Your working first differs from the machine in ${name}. There ${t} ${ruleClause(n)}.`;
}

/**
 * A learner who holds one column misconception, as a column rule plus whether
 * they feed their written carry into the next column. Used to find items that
 * exercise a misconception, and to answer checkpoints the way they would.
 */
export function columnStudent(tag, variantNo = 0) {
  if (tag === 'add_or') return { rule: (a, b, c) => [a | b | c, 0], addsCarry: true };
  if (tag === 'add_three_ones') return { rule: (a, b, c) => (a + b + c === 3 ? [0, 1] : colRule(a, b, c)), addsCarry: true };
  if (tag === 'add_no_carry') {
    return variantNo === 1
      ? { rule: (a, b) => colRule(a, b, 0), addsCarry: false }      // writes the carry, never adds it
      : { rule: (a, b, c) => [(a + b + c) & 1, 0], addsCarry: true }; // never carries at all
  }
  return { rule: colRule, addsCarry: true };
}

/** run a column student over a whole sum: { result, carries (as written) } */
export function studentWork(A, B, cin, student) {
  const w = A.length;
  const result = new Array(w);
  const carries = new Array(w + 1);
  carries[0] = cin;
  let c = cin;
  for (let i = 0; i < w; i++) {
    const [s, co] = student.rule(A[i], B[i], c);
    result[i] = s;
    carries[i + 1] = co;
    c = student.addsCarry ? co : 0;
  }
  return { result, carries };
}

/** a column student's replies to the checkpoints (carry-in, then the column) */
export function studentReplies(A, B, cin, student) {
  const work = studentWork(A, B, cin, student);
  return (cp) => {
    if (cp.id === 'carry-in') return work.carries[cp.column];
    return student.rule(cp.a, cp.b, cp.c);
  };
}

// ---------------------------------------------------------------------------
// Checkpoints shared with sadd.js: locate the break in a result-only answer
// ---------------------------------------------------------------------------

export function carryCheckpoint(i, c, name = colName(i)) {
  return {
    id: 'carry-in',
    prompt: `What is the carry into ${name}? Work through the columns to its right again.`,
    input: { kind: 'bit' },
    answer: c,
    column: i,
  };
}

export function columnCheckpoint(i, a, b, c, name = colName(i)) {
  const [s, co] = colRule(a, b, c);
  return {
    id: 'column',
    prompt: `${name[0].toUpperCase()}${name.slice(1)} adds ${colTerms(a, b, c)}. Write this column's total as a 2-bit binary number.`,
    input: { kind: 'bits', width: 2 },
    answer: [s, co],       // LSB-first: [sum bit, carry out]
    column: i, a, b, c,
  };
}

/**
 * Checkpoint flow for a wrong result bit at column i (≤ 2 questions):
 * the carry into i, then i's rule. Returns { next } or { tag, slip }.
 */
export function resultBitFlow(i, a, b, c, cps, name = colName(i)) {
  let j = 0;
  if (i > 0) {
    if (cps.length <= j) return { next: carryCheckpoint(i, c, name) };
    if (cps[j] !== c) return { tag: c === 1 ? 'add_no_carry' : 'other', carryWrong: true };
    j++;
  }
  if (cps.length <= j) return { next: columnCheckpoint(i, a, b, c, name) };
  const got = Array.isArray(cps[j]) ? cps[j] : [null, null];
  const [s, co] = colRule(a, b, c);
  if (got[0] === s && (got[1] ?? 0) === co) return { tag: 'other', slip: true };
  return { tag: classifyColumn(a, b, c, got[0] ?? null, got[1] ?? null), got };
}

// ---------------------------------------------------------------------------
// Item interface
// ---------------------------------------------------------------------------

const ASKS = ['full', 'result'];

export function build(params) {
  const { w, a, b } = params;
  const ask = params.ask === 'result' ? 'result' : 'full';
  const r = addBits(a, b, w);
  const key = {
    carries: ask === 'full' ? [null, ...r.carries.slice(1)] : new Array(w + 1).fill(null),
    result: [...r.result, null],
    overflow: r.cout ? 'yes' : 'no',
  };
  const fields = [];
  if (ask === 'full') fields.push({ id: 'carries', kind: 'bits', label: 'Carries', width: w + 1 });
  fields.push({ id: 'result', kind: 'bits', label: 'Result', width: w + 1, optionalIndex: w });
  fields.push({ id: 'overflow', kind: 'choice', label: 'Overflow?', choices: ['yes', 'no'] });
  return {
    type: TYPE,
    params,
    level: params.level || 'gcse',
    spec: 'J277-1.2.4-add',
    prompt: ask === 'full'
      ? `Add these ${w}-bit binary numbers. Fill in every carry, then say whether there is an overflow.`
      : `Add these ${w}-bit binary numbers, then say whether there is an overflow.`,
    show: { w, a: toBits(a, w), b: toBits(b, w), aValue: a, bValue: b, ask, op: '+' },
    fields,
    key,
    family: 'add',
    sim: r,              // the full simulation (carries, flags) for Why layers
  };
}

export function blank(item) {
  const { w } = item.params;
  return { carries: new Array(w + 1).fill(null), result: new Array(w + 1).fill(null), overflow: null };
}

const st = (got, want) => (got === null || got === undefined ? 'missing' : got === want ? 'ok' : 'bad');

export function mark(item, answer) {
  const { w } = item.params;
  const full = item.show.ask === 'full';
  const key = item.key;
  const carries = new Array(w + 1).fill(null);
  const result = new Array(w + 1).fill(null);
  // An empty carry box means "no carry", exactly as on paper.
  if (full) for (let i = 1; i <= w; i++) carries[i] = st(answer.carries?.[i] ?? 0, key.carries[i]);
  for (let i = 0; i < w; i++) result[i] = st(answer.result?.[i], key.result[i]);
  const extra = answer.result?.[w];
  result[w] = extra === null || extra === undefined ? null : 'extra';
  const overflow = st(answer.overflow, key.overflow);

  // Working order: each column's sum bit, then the carry it produces.
  const order = [];
  for (let i = 0; i < w; i++) {
    order.push(['result', i]);
    if (full) order.push(['carries', i + 1]);
  }
  order.push(['result', w], ['overflow', null]);
  const cells = { carries, result, overflow };
  let firstWrong = null;
  let right = 0;
  let total = 0;
  for (const [field, index] of order) {
    const s = index === null ? cells[field] : cells[field][index];
    if (s === null) continue;
    total++;
    if (s === 'ok') right++;
    else if (!firstWrong) firstWrong = { field, index };
  }
  return { correct: right === total, cells, firstWrong, score: { right, total } };
}

/** carry row (indices 1..w) as 0/1 — blanks are no carry */
const carryRow = (carries, w) => Array.from({ length: w }, (_, j) => carries?.[j + 1] ?? 0);

/** 'right' | 'left' when the learner's carry row is the key's moved one column */
export function shiftedCarries(keyCarries, ansCarries, w) {
  const k = carryRow(keyCarries, w);
  const s = carryRow(ansCarries, w);
  if (sameBits(k, s)) return null;
  const right = [...k.slice(1), 0];      // each carry written under the column that made it
  const left = [0, ...k.slice(0, -1)];   // each carry written two columns along
  if (right.includes(1) && sameBits(s, right)) return 'right';
  if (left.includes(1) && sameBits(s, left)) return 'left';
  return null;
}

function finish(tag, headline, detail, focus) {
  return { next: null, diagnosis: { tag, headline, detail, focus } };
}

function defaultFocus(item) {
  const { w } = item.params;
  const { a, b } = item.show;
  const c = item.sim.carries;
  if (item.sim.cout) return w - 1;
  for (let i = 0; i < w; i++) if (a[i] + b[i] + c[i] === 3) return i;
  for (let i = 0; i < w; i++) if (a[i] + b[i] + c[i] === 2) return i;
  return 0;
}

// Once every column is right, only the 9th box and the overflow answer remain.
function diagnoseTop(item, answer) {
  const { w, a, b } = item.params;
  const key = item.key;
  const focus = { column: w - 1, field: 'overflow' };
  const extra = answer.result?.[w];
  if (extra !== null && extra !== undefined) {
    return finish('add_ninth_bit', `Every column is right, but you wrote a ${ordinal(w + 1)} bit.`,
      `This is ${aWidth(w)} sum, so the carry out of the top column has nowhere to go. Leave the ${ordinal(w + 1)} box empty: that lost carry is the overflow.`,
      { column: w - 1, field: 'result', index: w });
  }
  if (answer.overflow !== key.overflow) {
    if (key.overflow === 'yes') {
      return finish('add_overflow_missed', 'Every column is right, but you missed the overflow.',
        `There is a carry out of the top column, so the true answer ${a + b} needs ${w + 1} bits. That is an overflow: the ${w}-bit result is only ${item.sim.value}.`, focus);
    }
    if (answer.overflow === 'yes') {
      return finish('add_overflow_false', 'Every column is right, but there is no overflow.',
        `There is no carry out of the top column, so the answer ${a + b} fits in ${w} bits. Overflow only happens when the answer is bigger than ${2 ** w - 1}.`, focus);
    }
  }
  return finish(null, 'All correct.', 'Every column, carry and the overflow answer match the machine.', { column: defaultFocus(item) });
}

export function diagnose(item, answer, marking, cpAnswers = []) {
  const m = marking || mark(item, answer);
  if (m.correct) return finish(null, 'All correct.', 'Every answer matches the machine.', { column: defaultFocus(item) });
  const { w } = item.params;
  const { a: A, b: B } = item.show;
  const key = item.key;
  const c = item.sim.carries;
  const res = answer.result || [];

  if (item.show.ask === 'full') {
    const dir = shiftedCarries(key.carries, answer.carries, w);
    if (dir) {
      const k = carryRow(key.carries, w);
      const j = k.findIndex((bit, idx) => bit !== (answer.carries?.[idx + 1] ?? 0));
      return finish('add_carry_wrong_col', 'Your carry row is shifted by one column.',
        `Each of your carries is one column to the ${dir} of where it belongs. Write each carry above the next column to the left, because that is the column it is added into.`,
        { column: Math.max(0, j), field: 'carries', index: j + 1 });
    }
    for (let i = 0; i < w; i++) {
      const rOk = res[i] === key.result[i];
      const cOk = (answer.carries?.[i + 1] ?? 0) === key.carries[i + 1];
      if (rOk && cOk) continue;
      const tag = classifyColumn(A[i], B[i], c[i], res[i] ?? null, answer.carries?.[i + 1] ?? null);
      return finish(tag, `Your working first goes wrong in ${colName(i)}.`, columnDetail(tag, i, A[i], B[i], c[i], res[i] ?? null, answer.carries?.[i + 1] ?? null),
        { column: i, field: rOk ? 'carries' : 'result', index: rOk ? i + 1 : i });
    }
    return diagnoseTop(item, answer);
  }

  // Result only: no working to read, so ask about the first wrong column.
  const i = Array.from({ length: w }, (_, j) => j).find((j) => res[j] !== key.result[j]);
  if (i === undefined) return diagnoseTop(item, answer);
  const flow = resultBitFlow(i, A[i], B[i], c[i], cpAnswers);
  if (flow.next) return { next: flow.next, diagnosis: null };
  const focus = { column: i, field: 'result', index: i };
  const headline = `Your answer first goes wrong in ${colName(i)}.`;
  if (flow.carryWrong) {
    const detail = c[i] === 1
      ? `A carry of 1 comes into ${colName(i)} from the column to its right, but you didn't carry it. When a column adds up to 2 or 3, write the last bit and carry 1 left.`
      : `No carry comes into ${colName(i)}: the column to its right adds up to less than 2. Only carry when a column adds up to 2 or 3.`;
    return finish(flow.tag, headline, detail, focus);
  }
  if (flow.slip) {
    return finish('other', headline, `You can do ${colName(i)} when asked, so this was probably a slip when writing the answer. Check each column as you write it.`, focus);
  }
  return finish(flow.tag, headline, columnDetail(flow.tag, i, A[i], B[i], c[i], flow.got?.[0] ?? null, flow.got?.[1] ?? null), focus);
}

// ---------------------------------------------------------------------------
// Why layers
// ---------------------------------------------------------------------------

/** the one-column rule layer, shared with sadd.js and twos.js */
export function columnLayer(k, a, b, cin, name = colName(k), topNote = '') {
  const [sum, cout] = colRule(a, b, cin);
  const n = a + b + cin;
  const t = colTerms(a, b, cin);
  const say = n >= 2
    ? [`In ${name}, ${t} = ${n}, which is ${n.toString(2)} in binary.`,
      topNote || `Write ${sum} and carry 1 into the next column to the left.`]
    : [`In ${name}, ${t} = ${n}.`, `Write ${sum}; there is nothing to carry.`];
  return { id: 'column', kind: 'column', title: 'One column', say, data: { k, a, b, cin, sum, cout } };
}

export function adderLayer(a, b, cin, name) {
  const d = adderWires(a, b, cin);
  return {
    id: 'adder', kind: 'adder', title: 'Full adder',
    say: [
      `A full adder does ${name} with gates: x1 = a XOR b = ${d.x1}, and sum = x1 XOR carry-in = ${d.sum}.`,
      `The carry out is (a AND b) OR (x1 AND carry-in) = ${d.a1} OR ${d.a2} = ${d.cout}.`,
    ],
    data: d,
  };
}

export function why(item, diagnosis, { level } = {}) {
  const lv = level || item.level || 'gcse';
  const { w, a, b } = item.params;
  const r = item.sim;
  const tag = diagnosis?.tag ?? null;
  const f = diagnosis?.focus?.column ?? defaultFocus(item);
  const A = item.show.a;
  const B = item.show.b;
  const dropped = r.cout === 1;
  const topTag = tag === 'add_ninth_bit' || tag === 'add_overflow_missed' || tag === 'add_overflow_false';

  const first = dropped
    ? `In ${w} bits, ${a} + ${b} gives ${r.value} because the carry worth ${2 ** w} is dropped.`
    : `${a} + ${b} = ${r.value}, worked right to left with every carry shown.`;
  let second = `Look at ${colName(f)}, which is highlighted.`;
  if (topTag) second = dropped ? 'Losing that carry is what overflow means.' : 'No carry leaves the top column, so there is no overflow.';
  const layers = [{
    id: 'columns', kind: 'columns', title: 'The whole sum',
    say: [first, second],
    data: {
      w, a: A.slice(), b: B.slice(), op: '+',
      carries: [null, ...r.carries.slice(1)], result: r.result.slice(),
      highlight: f, dropped, signed: false,
      labels: { a: String(a), b: String(b), r: String(r.value) },
    },
  }];
  const topNote = f === w - 1 && r.carries[w] === 1
    ? `Write ${r.result[f]} and carry 1 out of the top column, where there is no room for it.`
    : '';
  layers.push(columnLayer(f, A[f], B[f], r.carries[f], colName(f), topNote));
  if (lv !== 'gcse') layers.push(adderLayer(A[f], B[f], r.carries[f], colName(f)));
  return layers;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * What a learner holding one misconception writes for a full grid. Used to
 * pick items where that misconception visibly changes the answer.
 */
export function misconceive(params, tag, variantNo = 0) {
  const item = build({ ...params, ask: 'full' });
  const { w } = params;
  const { a: A, b: B } = item.show;
  const key = item.key;
  const ans = { carries: key.carries.slice(), result: key.result.slice(), overflow: key.overflow };
  if (tag === 'add_or' || tag === 'add_no_carry') {
    // Never carrying makes 1 + 1 either "1" (OR) or "0, carry nothing" (XOR).
    ans.carries = new Array(w + 1).fill(null);
    ans.result = [...A.map((x, i) => (tag === 'add_or' ? x | B[i] : x ^ B[i])), null];
    ans.overflow = 'no';
    if (tag === 'add_no_carry' && variantNo === 1) {
      // The other way to lose a carry: write it down, then forget to add it.
      ans.carries = new Array(w + 1).fill(null);
      for (let i = 0; i < w; i++) [ans.result[i], ans.carries[i + 1]] = colRule(A[i], B[i], 0);
      ans.overflow = ans.carries[w] ? 'yes' : 'no';
    }
  } else if (tag === 'add_three_ones') {
    const c = item.sim.carries;
    for (let i = 0; i < w; i++) if (A[i] + B[i] + c[i] === 3) ans.result[i] = 0;
  } else if (tag === 'add_carry_wrong_col') {
    ans.carries = [null, ...key.carries.slice(2), null];
  } else if (tag === 'add_ninth_bit') {
    ans.result[w] = item.sim.cout;
  } else if (tag === 'add_overflow_missed') {
    ans.overflow = 'no';
  } else if (tag === 'add_overflow_false') {
    ans.overflow = 'yes';
  }
  return ans;
}

function exercises(params, tag) {
  const item = build({ ...params, ask: 'full' });
  const variants = tag === 'add_no_carry' ? [0, 1] : [0];
  return variants.every((v) => {
    const ans = misconceive(params, tag, v);
    const m = mark(item, ans);
    return !m.correct && diagnose(item, ans, m).diagnosis.tag === tag;
  });
}

// Exam-style operands: not tiny, at least two 1s, so the sum has real carries.
function operand(rng, w) {
  for (;;) {
    const x = randInt(rng, 2 ** (w - 3), 2 ** w - 1);
    if (popcount(toBits(x, w)) >= 2) return x;
  }
}

function carriesOf(a, b, w) { return popcount(addBits(a, b, w).carries.slice(1)); }

function candidate(rng, w, target, wantOverflow) {
  const M = 2 ** w;
  if (target === 'add_overflow_missed' || target === 'add_ninth_bit' || wantOverflow === true) {
    const a = randInt(rng, M / 2, M - 1);
    return [a, randInt(rng, M - a, M - 1)];
  }
  if (target === 'add_overflow_false') {
    const lo = 2 ** (w - 3);
    const s = randInt(rng, 3 * 2 ** (w - 2), M - 1);
    const a = randInt(rng, lo, s - lo);
    return [a, s - a];
  }
  const a = operand(rng, w);
  const b = operand(rng, w);
  if (wantOverflow === false && a + b >= M) return [a, M - 1 - a > 0 ? randInt(rng, 1, M - 1 - a) : 1];
  return [a, b];
}

export function generate(rng, opts = {}) {
  const w = clampW(opts.w ?? opts.width, 4, 16, 8);
  const ask = opts.target === 'add_carry_wrong_col' ? 'full' : ASKS.includes(opts.ask) ? opts.ask : 'full';
  const target = TARGETS.includes(opts.target) ? opts.target : null;
  const wantOverflow = target ? null : chance(rng, 0.3);
  const avoid = opts.avoid || null;
  let fallback = null;
  for (let tries = 0; tries < 400; tries++) {
    const [a, b] = candidate(rng, w, target, wantOverflow);
    if (a < 1 || b < 1 || a >= 2 ** w || b >= 2 ** w) continue;
    const params = withLevel({ w, a, b, ask }, opts.level);
    if (avoid && avoid.a === a && avoid.b === b) continue;
    fallback = fallback || params;
    if (carriesOf(a, b, w) < 2) continue;
    if (target && !exercises(params, target)) continue;
    if (!target && wantOverflow === false && a + b >= 2 ** w) continue;
    return params;
  }
  return fallback || withLevel({ w, a: 2 ** w - 3, b: 7, ask }, opts.level);
}

export function variant(item, tagId, rng) {
  const p = item.params;
  return generate(rng, { level: p.level, w: p.w, ask: p.ask, target: tagId, avoid: p });
}

export function encodeParams(p) {
  return [p.w, p.a, p.b, ASKS.indexOf(p.ask === 'result' ? 'result' : 'full'), levelCode(p.level)];
}

export function decodeParams(ints) {
  const [w, a, b, ask, lv] = ints;
  return withLevel({ w, a, b, ask: ASKS[ask] || 'full' }, levelFrom(lv));
}
