// Two's complement (A-level 1.4.1): encode a denary value, decode a bit
// pattern, or state the range. Wrong answers are compared with what each
// classic misconception produces (sign and magnitude, ones' complement, top
// bit read as +2^(w-1)), all computed from the same numbers.
import { addBits, toBits, range as bitRange } from '../../engine/bits.js';
import { randInt, pick, chance } from '../../lib/rng.js';
import { withLevel, levelCode, levelFrom, clampW, sameBits, binStr, num, aWidth } from './add.js';

export const TYPE = 'twos';
export const TYPE_ID = 2;
export const TARGETS = ['twos_sign_magnitude', 'twos_no_plus1', 'twos_msb_positive', 'twos_range'];

const TASKS = ['encode', 'decode', 'range'];
const invert = (bits) => bits.map((b) => 1 - b);

/** sign and magnitude: a 1 for the minus sign, then |n| in w − 1 bits */
function signMagBits(n, w) {
  return [...toBits(Math.abs(n), w - 1), n < 0 ? 1 : 0];
}

/** what the misconception reads the pattern of n as */
function readAs(tag, n, w) {
  const M = 2 ** (w - 1);
  const u = n < 0 ? n + 2 * M : n;
  if (tag === 'twos_msb_positive') return u;
  if (tag === 'twos_sign_magnitude') return -(u - M);
  if (tag === 'twos_no_plus1') return n + 1;
  return null;
}

/** the bits the misconception writes for n */
function writeAs(tag, n, w) {
  if (tag === 'twos_sign_magnitude') return Math.abs(n) < 2 ** (w - 1) ? signMagBits(n, w) : null;
  if (tag === 'twos_no_plus1') return invert(toBits(Math.abs(n), w));
  return null;
}

export function build(params) {
  const { w, task } = params;
  const n = task === 'range' ? 0 : params.n;
  const r = bitRange(w, true);
  const bits = toBits(n, w);
  let prompt;
  let fields;
  let key;
  if (task === 'encode') {
    prompt = `Write ${num(n)} as ${aWidth(w)} two's complement binary number.`;
    fields = [{ id: 'bits', kind: 'bits', label: `${num(n)} in ${w} bits`, width: w }];
    key = { bits };
  } else if (task === 'decode') {
    prompt = `This is ${aWidth(w)} two's complement number. What is its value in denary?`;
    fields = [{ id: 'value', kind: 'number', label: 'Value in denary' }];
    key = { value: n };
  } else {
    prompt = `What are the smallest and largest values ${aWidth(w)} two's complement number can hold?`;
    fields = [{ id: 'min', kind: 'number', label: 'Smallest' }, { id: 'max', kind: 'number', label: 'Largest' }];
    key = { min: r.min, max: r.max };
  }
  return {
    type: TYPE,
    params,
    level: params.level || 'alevel',
    spec: 'H446-1.4.1-twos',
    prompt,
    show: { w, task, n: task === 'range' ? null : n, bits: task === 'decode' ? bits : null, signed: true },
    fields,
    key,
    family: 'twos',
  };
}

export function blank(item) {
  const { w, task } = item.params;
  if (task === 'encode') return { bits: new Array(w).fill(null) };
  if (task === 'decode') return { value: null };
  return { min: null, max: null };
}

const st = (got, want) => (got === null || got === undefined || Number.isNaN(got) ? 'missing' : got === want ? 'ok' : 'bad');

export function mark(item, answer) {
  const { w, task } = item.params;
  const key = item.key;
  const cells = {};
  const order = [];
  if (task === 'encode') {
    cells.bits = key.bits.map((b, i) => st(answer.bits?.[i], b));
    for (let i = w - 1; i >= 0; i--) order.push(['bits', i]);
  } else if (task === 'decode') {
    cells.value = st(answer.value, key.value);
    order.push(['value', null]);
  } else {
    cells.min = st(answer.min, key.min);
    cells.max = st(answer.max, key.max);
    order.push(['min', null], ['max', null]);
  }
  let firstWrong = null;
  let right = 0;
  for (const [field, index] of order) {
    const s = index === null ? cells[field] : cells[field][index];
    if (s === 'ok') right++;
    else if (!firstWrong) firstWrong = { field, index };
  }
  return { correct: right === order.length, cells, firstWrong, score: { right, total: order.length } };
}

function finish(tag, headline, detail, focus) {
  return { next: null, diagnosis: { tag, headline, detail, focus } };
}

/** '−128 + 3' — the place-value reading of a negative pattern */
function placeSum(n, w) {
  const M = 2 ** (w - 1);
  return `${num(-M)} + ${n + M}`;
}

/** −2^(w−1): the top bit alone. +2^(w−1) does not fit, so there is nothing to invert. */
function smallestSay(n, w) {
  return `${num(n)} is the smallest ${w}-bit value: the top bit alone, ${binStr(toBits(n, w))} = ${placeSum(n, w)}. +${-n} does not fit in ${w}-bit two's complement, so there is nothing to invert and add 1 to.`;
}

function encodeDiagnosis(item, answer, m) {
  const { w, n } = item.params;
  const bits = answer.bits || [];
  if (!m.cells.bits.includes('bad')) {
    if (m.cells.bits.every((s) => s === 'missing')) {
      return finish(null, "You didn't give any bits.",
        `Nothing was filled in. ${num(n)} in ${w}-bit two's complement is ${binStr(item.key.bits)}.`, { field: 'bits', index: w - 1 });
    }
    return finish(null, "You haven't filled in every bit.",
      `The bits you gave are right. ${num(n)} in ${w}-bit two's complement is ${binStr(item.key.bits)}.`, { field: 'bits', index: m.firstWrong?.index ?? w - 1 });
  }
  const full = bits.length === w && bits.every((b) => b === 0 || b === 1);
  const focus = { field: 'bits', index: w - 1 };
  const kb = binStr(item.key.bits);
  // −2^(w−1) has no positive twin in w bits, so invert-and-add-1 cannot start from it.
  if (n === -(2 ** (w - 1))) {
    return finish('other', `Your bits are not ${num(n)} in two's complement.`, smallestSay(n, w), focus);
  }
  if (full && n < 0) {
    const inv = invert(toBits(-n, w));
    const sm = writeAs('twos_sign_magnitude', n, w);
    if (sm && sameBits(bits, sm)) {
      return finish('twos_sign_magnitude', 'You used sign and magnitude.',
        `You wrote a 1 for the minus sign, then ${-n} in binary. In two's complement you invert the bits of +${-n} and add 1, which gives ${kb}.`, focus);
    }
    if (sameBits(bits, inv)) {
      return finish('twos_no_plus1', 'You inverted but did not add 1.',
        `Inverting the bits of +${-n} is only the first step. ${binStr(inv)} + 1 = ${kb}.`, { field: 'bits', index: 0 });
    }
  }
  return finish('other', `Your bits are not ${num(n)} in two's complement.`,
    `${num(n)} in ${w}-bit two's complement is ${kb}. ${n < 0 ? `Write +${-n} in binary, invert every bit, then add 1.` : 'A positive number is written in ordinary binary with a 0 in the top bit.'}`, focus);
}

function decodeDiagnosis(item, answer) {
  const { w, n } = item.params;
  const v = answer.value;
  const M = 2 ** (w - 1);
  const b = binStr(toBits(n, w));
  const focus = { field: 'value' };
  if (typeof v !== 'number' || Number.isNaN(v)) {
    return finish(null, "You didn't give a value.",
      n < 0
        ? `The top bit is 1, so the number is negative: ${b} = ${placeSum(n, w)} = ${num(n)}.`
        : `The top bit is 0, so ${b} is positive and reads like ordinary binary: ${n}.`, focus);
  }
  if (n < 0) {
    if (v === readAs('twos_msb_positive', n, w)) {
      return finish('twos_msb_positive', 'You read the top bit as a positive place value.',
        `You counted the top bit as +${M}, which reads the bits as an unsigned number. In two's complement it is worth ${num(-M)}, so ${b} = ${placeSum(n, w)} = ${num(n)}.`, focus);
    }
    if (v === readAs('twos_sign_magnitude', n, w)) {
      return finish('twos_sign_magnitude', 'You read it as sign and magnitude.',
        `You treated the top bit as just a minus sign and the other bits as the size. In two's complement the top bit is worth ${num(-M)}, so ${b} = ${placeSum(n, w)} = ${num(n)}.`, focus);
    }
    if (v === readAs('twos_no_plus1', n, w)) {
      const inv = invert(toBits(n, w));
      return finish('twos_no_plus1', 'You inverted but did not add 1.',
        `Inverting gives ${binStr(inv)} = ${-n - 1}, and you need to add 1 to get the size, ${-n}. So the value is ${num(n)}, not ${num(v)}.`, focus);
    }
  }
  return finish('other', `The value is ${num(n)}, not ${num(v)}.`,
    n < 0
      ? `The top bit is 1, so the number is negative and worth ${placeSum(n, w)} = ${num(n)}. ${n === -M ? `That is the smallest ${w}-bit value.` : 'Invert and add 1 to check its size.'}`
      : `The top bit is 0, so ${b} is positive and reads like ordinary binary: ${n}.`, focus);
}

function rangeDiagnosis(item, answer) {
  const { w } = item.params;
  const M = 2 ** (w - 1);
  const given = (x) => typeof x === 'number' && !Number.isNaN(x);
  // Only a value the learner actually gave can show a wrong idea of the range.
  const bad = (given(answer.min) && answer.min !== -M) || (given(answer.max) && answer.max !== M - 1);
  const focus = { field: item.key.min === answer.min ? 'max' : 'min' };
  const detail = `The top bit is worth ${num(-M)}, so the smallest value is ${binStr(toBits(-M, w))} = ${num(-M)}. The largest is ${binStr(toBits(M - 1, w))} = ${M - 1}, one less than ${M} because zero takes one of the patterns with a 0 on top.`;
  if (!bad) return finish(null, `You didn't give both ends of the range: it is ${num(-M)} to ${M - 1}.`, detail, focus);
  return finish('twos_range', `The ${w}-bit range is ${num(-M)} to ${M - 1}.`, detail, focus);
}

export function diagnose(item, answer, marking) {
  const m = marking || mark(item, answer);
  if (m.correct) return finish(null, 'All correct.', 'Your answer matches the machine.', { field: item.fields[0].id });
  const { task } = item.params;
  if (task === 'encode') return encodeDiagnosis(item, answer, m);
  if (task === 'decode') return decodeDiagnosis(item, answer);
  return rangeDiagnosis(item, answer);
}

// ---------------------------------------------------------------------------
// Why layers
// ---------------------------------------------------------------------------

/** the "+1" of invert-and-add-1, laid out as a real addition */
function plusOneColumns(inv, w, rLabel) {
  const r = addBits(inv, toBits(1, w), w);
  const stop = inv.indexOf(0);
  const say = inv[0] === 0
    ? ['Add 1 in columns: the right-hand bit is 0, so it becomes 1 and nothing carries.']
    : ['Add 1 in columns: each 1 on the right becomes 0 and carries 1, until a 0 takes the carry and becomes 1.'];
  return {
    id: 'columns', kind: 'columns', title: 'Adding 1',
    say,
    data: {
      w, a: inv.slice(), b: toBits(1, w), op: '+',
      carries: [null, ...r.carries.slice(1)], result: r.result.slice(),
      highlight: stop < 0 ? w - 1 : stop, dropped: r.cout === 1, signed: true,
      labels: { a: 'inverted', b: '1', r: rLabel },
    },
  };
}

export function why(item) {
  const { w, task } = item.params;
  const M = 2 ** (w - 1);
  if (task === 'range') {
    return [
      {
        id: 'twos', kind: 'twos', title: 'The two ends',
        say: [`The smallest ${w}-bit value is ${binStr(toBits(-M, w))} = ${num(-M)}, and the largest is ${binStr(toBits(M - 1, w))} = ${M - 1}.`],
        data: { w, steps: [{ label: `smallest: ${num(-M)}`, bits: toBits(-M, w) }, { label: `largest: ${M - 1}`, bits: toBits(M - 1, w) }] },
      },
      {
        id: 'count', kind: 'text', title: 'Counting the patterns',
        say: [`There are ${2 * M} patterns: ${M} negative ones, zero and ${M - 1} positive ones.`, `So the range is ${num(-M)} to ${M - 1}, not ${num(-M)} to ${M}.`],
        data: {},
      },
    ];
  }
  const n = item.params.n;
  const bits = toBits(n, w);
  const b = binStr(bits);
  if (n >= 0) {
    return [
      {
        id: 'twos', kind: 'twos', title: 'A positive number',
        say: [`${n} is positive, so it is written in ordinary binary with a 0 in the top bit: ${b}.`],
        data: { w, steps: [{ label: `+${n}`, bits }] },
      },
      {
        id: 'place', kind: 'text', title: 'Place values',
        say: [`Only the top bit is negative (worth ${num(-M)}), and here it is 0.`, `So the value is just the sum of the other place values: ${n}.`],
        data: {},
      },
    ];
  }
  const layers = [];
  if (n === -M) {
    layers.push({
      id: 'twos', kind: 'twos', title: 'The smallest value',
      say: [`${num(n)} is the smallest ${w}-bit value: the top bit alone, ${b}.`, `+${M} does not fit in ${w}-bit two's complement, so invert-and-add-1 has nothing to start from.`],
      data: { w, steps: [{ label: num(n), bits }] },
    });
  } else {
    const pos = toBits(-n, w);
    const inv = invert(task === 'encode' ? pos : bits);
    twosLayers(layers, { w, n, task, b, bits, pos, inv });
  }
  layers.push({
    id: 'place', kind: 'text', title: 'Check with place values',
    say: [`The top bit is worth ${num(-M)}, not +${M}.`, `So ${b} = ${placeSum(n, w)} = ${num(n)}.`],
    data: {},
  });
  return layers;
}

function twosLayers(layers, { w, n, task, b, bits, pos, inv }) {
  if (task === 'encode') {
    layers.push({
      id: 'twos', kind: 'twos', title: 'Invert and add 1',
      say: [`To write ${num(n)}, start from +${-n} = ${binStr(pos)} and invert every bit to get ${binStr(inv)}.`, `Then add 1: the ${w}-bit two's complement of ${num(n)} is ${b}.`],
      data: { w, steps: [{ label: `+${-n}`, bits: pos }, { label: 'invert every bit', bits: inv }, { label: 'add 1', bits }] },
    });
    layers.push(plusOneColumns(inv, w, num(n)));
  } else {
    layers.push({
      id: 'twos', kind: 'twos', title: 'Invert and add 1',
      say: ['The top bit is 1, so the number is negative.', `Invert and add 1 to find its size: ${binStr(inv)} + 1 = ${binStr(pos)} = ${-n}, so the value is ${num(n)}.`],
      data: { w, steps: [{ label: 'the bits', bits }, { label: 'invert every bit', bits: inv }, { label: `add 1: size ${-n}`, bits: pos }] },
    });
    layers.push(plusOneColumns(inv, w, String(-n)));
  }
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** what a learner with one misconception answers */
export function misconceptions(params, tag) {
  const { w, n, task } = params;
  const M = 2 ** (w - 1);
  if (task === 'encode') {
    const bits = writeAs(tag, n, w);
    return bits ? [{ bits }] : [];
  }
  if (task === 'decode') {
    const v = readAs(tag, n, w);
    return v === null ? [] : [{ value: v }];
  }
  if (tag !== 'twos_range') return [];
  return [{ min: -(M - 1), max: M - 1 }, { min: -M, max: M }, { min: 0, max: 2 * M - 1 }, { min: -(M - 1), max: M }];
}

function exercises(params, tag) {
  const item = build(params);
  const answers = misconceptions(params, tag);
  return answers.length > 0 && answers.every((ans) => {
    const m = mark(item, ans);
    return !m.correct && diagnose(item, ans, m).diagnosis.tag === tag;
  });
}

const TARGET_TASKS = {
  twos_sign_magnitude: ['encode', 'decode'],
  twos_no_plus1: ['encode', 'decode'],
  twos_msb_positive: ['decode'],
  twos_range: ['range'],
};

export function generate(rng, opts = {}) {
  const target = TARGETS.includes(opts.target) ? opts.target : null;
  const fixedW = Number.isInteger(opts.w ?? opts.width);
  const avoid = opts.avoid || null;
  let fallback = null;
  for (let tries = 0; tries < 400; tries++) {
    const tasks = target ? TARGET_TASKS[target] : TASKS.includes(opts.task) ? [opts.task] : TASKS;
    // Encoding and decoding are the bread and butter; range comes up less.
    const task = tasks.length === 3 ? pick(rng, ['encode', 'encode', 'decode', 'decode', 'range']) : pick(rng, tasks);
    // A range question has one answer per width, so a fresh one needs a new width.
    const w = task === 'range' && (!fixedW || (avoid && avoid.task === 'range'))
      ? pick(rng, [4, 6, 8, 8, 10, 12, 16])
      : clampW(opts.w ?? opts.width, 4, 16, 8);
    const M = 2 ** (w - 1);
    // Mostly negatives (the interesting case), never −2^(w−1) or tiny values.
    const negative = target || chance(rng, 0.75);
    const n = task === 'range' ? 0 : negative ? -randInt(rng, 2, M - 1) : randInt(rng, 2, M - 1);
    const params = withLevel({ w, n, task }, opts.level);
    if (avoid && avoid.w === w && avoid.n === n && avoid.task === task) continue;
    fallback = fallback || params;
    if (target && !exercises(params, target)) continue;
    return params;
  }
  return fallback;
}

export function variant(item, tagId, rng) {
  const p = item.params;
  const target = TARGETS.includes(tagId) ? tagId : null;
  return generate(rng, { level: p.level, w: p.w, task: target ? undefined : p.task, target, avoid: p });
}

export function encodeParams(p) {
  const n = p.task === 'range' ? 0 : p.n;
  return [p.w, n + 2 ** (p.w - 1), TASKS.indexOf(p.task), levelCode(p.level)];
}

export function decodeParams(ints) {
  const [w0, n, task, lv] = ints;
  const w = clampW(w0, 4, 16, 8);   // untrusted links: keep every number in range
  const M = 2 ** (w - 1);
  return withLevel({ w, n: clampW(n, 0, 2 * M - 1, M) - M, task: TASKS[task] || 'encode' }, levelFrom(lv));
}

