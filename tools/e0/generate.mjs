#!/usr/bin/env node
// E0 desk study, step 1: "Do free LLMs already find where a student's working broke?"
//
//   node tools/e0/generate.mjs [--seed N] [--out dir] [--models a,b,c]
//
// Writes 200 student-style wrong attempts, deterministic from the seed:
//   e0-items.jsonl   one item per line: the question, the learner's answer, the
//                    key { correct answer, first wrong column/step in words, tag,
//                    tag label } and what score.mjs needs to mark a reply
//   e0-prompts.txt   one ready-to-paste student message per item, between markers
//   e0-scoring.csv   id, model, response, answer_ok, column_ok, misconception_ok,
//                    rater: one row per item per model, to fill in by hand
//
// Every attempt is made the same way: a targeted item (the item module's own
// generate(rng, { target })), a learner who holds exactly that misconception
// (the modules' misconceive / misconceptions helpers, or a card's classic wrong
// answer), then OUR mark() + diagnose(), with every checkpoint answered as that
// learner would. An attempt is kept only when our diagnosis returns the tag it
// was built for, so the key is the app's own verdict. No student data is
// involved: every attempt is synthetic.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as add from '../../machine/src/learn/items/add.js';
import * as shift from '../../machine/src/learn/items/shift.js';
import * as twos from '../../machine/src/learn/items/twos.js';
import * as sadd from '../../machine/src/learn/items/sadd.js';
import * as card from '../../machine/src/learn/cards.js';
import { tagLabel, TAG_IDS } from '../../machine/src/learn/catalogue.js';
import { toBits, fromBits } from '../../machine/src/engine/bits.js';
import { mulberry32, mixSeed, randInt, pick, shuffle, chance } from '../../machine/src/lib/rng.js';
import { toCsv } from './score.mjs';

const { binStr, colName, ordinal, aWidth } = add;

export const DEFAULT_SEED = 20260926;
export const MODELS = ['chatgpt-free', 'claude-free', 'gemini-free'];
const MODULES = { add, shift, twos, sadd, card };

// [family, tag, how many]. 70 + 20 + 30 + 25 + 25 + 30 = 200.
export const PLAN = [
  ...add.TARGETS.map((t) => ['add', t, 10]),
  ['add-result', 'add_or', 5], ['add-result', 'add_no_carry', 5], ['add-result', 'add_three_ones', 5],
  ['add-result', 'add_overflow_missed', 3], ['add-result', 'add_ninth_bit', 2],
  ...shift.TARGETS.map((t) => ['shift', t, 5]),
  ['twos', 'twos_sign_magnitude', 7], ['twos', 'twos_no_plus1', 7], ['twos', 'twos_msb_positive', 6], ['twos', 'twos_range', 5],
  ['flags', 'flags_carry_is_overflow', 9], ['flags', 'flags_signed_overflow_missed', 8], ['flags', 'flags_sub_carry', 8],
  ['c', 'c_signed_overflow', 4], ['c', 'c_usual_conversions', 3], ['c', 'c_promotion', 3], ['c', 'c_truncating_division', 3],
  ['c', 'c_shift_negative', 3], ['c', 'c_char_signedness', 3], ['c', 'c_unsigned_wrap', 4], ['c', 'c_narrowing', 4],
  ['c', 'c_jump_signedness', 3],
];

/** the tags E0 covers (every one practised by an item type) */
export const E0_TAGS = [...new Set(PLAN.map((p) => p[1]))];

// ---------------------------------------------------------------------------
// Learners: one misconception each, as an answer plus checkpoint replies
// ---------------------------------------------------------------------------

const COLUMN_TAGS = ['add_or', 'add_no_carry', 'add_three_ones'];

function addLearner(tag, k, rng, ask) {
  const params = add.generate(rng, { w: 8, level: 'gcse', ask, target: tag });
  const v = tag === 'add_no_carry' ? k % 2 : 0;        // never carries / writes the carry but never adds it
  const full = add.misconceive(params, tag, v);
  const w = params.w;
  const answer = ask === 'full' ? full : { carries: new Array(w + 1).fill(null), result: full.result, overflow: full.overflow };
  const item = add.build(params);
  const reply = COLUMN_TAGS.includes(tag) ? add.studentReplies(item.show.a, item.show.b, 0, add.columnStudent(tag, v)) : () => null;
  return { type: 'add', params, answer, reply };
}

function shiftLearner(tag, k, rng) {
  const kind = tag === 'shift_arith_logical' ? pick(rng, ['logical', 'arithmetic']) : pick(rng, ['logical', 'logical', 'arithmetic']);
  const level = kind === 'arithmetic' || tag === 'shift_arith_logical' ? 'alevel' : pick(rng, ['gcse', 'gcse', 'alevel']);
  const askValue = tag === 'shift_value_myth' ? true : chance(rng, 0.4);
  const params = shift.generate(rng, { w: 8, kind, level, askValue, target: tag });
  const list = shift.misconceptions(params, tag);
  return list.length ? { type: 'shift', params, answer: pick(rng, list), reply: () => null } : null;
}

function twosLearner(tag, k, rng) {
  const params = twos.generate(rng, { level: 'alevel', target: tag });
  const list = twos.misconceptions(params, tag);
  return list.length ? { type: 'twos', params, answer: pick(rng, list), reply: () => null } : null;
}

function flagsLearner(tag, k, rng) {
  // A-level asks "overflow?"; CS:APP asks for CF, ZF, SF and OF.
  const level = tag === 'flags_sub_carry' || k % 2 ? 'csapp' : 'alevel';
  const params = sadd.generate(rng, { w: 8, level, target: tag });
  const list = sadd.misconceptions(params, tag);
  if (!list.length) return null;
  const m = pick(rng, list);
  return { type: 'sadd', params, answer: m.answer, reply: m.reply };
}

// Classic wrong answers from cards.js (each card's `classic` list, same order),
// computed from the card's own run. diagnose() must still name the tag.
const C_OPTIONS = {
  c_signed_overflow: [
    { id: 'int-max-plus-one', wrong: (c) => String(c.sum) },
    { id: 'int-multiply-overflow', wrong: (c) => c.prod },
    { id: 'int-max-plus-one', wrong: () => '2147483647' },
    { id: 'int-multiply-overflow', wrong: () => 'overflow error', says: 'it gives an overflow error' },
  ],
  c_usual_conversions: [{ id: 'minus-one-vs-unsigned', wrong: (c) => String(c.signedAns) }],
  c_promotion: [
    { id: 'uchar-promotion', wrong: (c) => c.low },
    { id: 'uchar-promotion', wrong: () => 255 },
    { id: 'uchar-promotion', wrong: (c) => (c.sum - 256 >= 128 ? c.sum - 512 : c.sum - 256) },
  ],
  c_truncating_division: [
    { id: 'truncating-division', wrong: (c) => `${c.fq} ${c.fr}` },
    { id: 'truncating-division', wrong: (c) => `${c.fq} ${c.r}` },
    { id: 'truncating-division', wrong: (c) => `${c.q} ${c.fr}` },
  ],
  c_shift_negative: [{ id: 'negative-shift-right', wrong: (c) => String(c.logical) }],
  c_char_signedness: [{ id: 'char-200', wrong: (c) => String(c.vals.n) }],
  c_unsigned_wrap: [
    { id: 'unsigned-wrap', wrong: (c) => String(c.vals.k - c.vals.m) },
    { id: 'unsigned-wrap', wrong: () => '0' },
    { id: 'unsigned-wrap', wrong: () => 'error', says: 'it gives an error' },
  ],
  c_narrowing: [
    { id: 'short-truncation', wrong: (c) => c.vals.i },
    { id: 'short-truncation', wrong: () => 32767 },
    { id: 'char-200', wrong: () => '127' },
  ],
  // The learner expects a signed comparison, so picks the other message and,
  // asked which jump the compiler uses, the signed one.
  c_jump_signedness: [{
    id: 'signed-unsigned-branch',
    wrong: (c) => c.msgs.find((m) => m !== c.out),
    reply: (cp, c) => (cp.input.kind === 'choice' ? c.sj : cp.input.kind === 'number' ? -c.vals.k : null),
    note: (c) => `I think the if turns into cmp and then ${c.sj}`,
  }],
};

function cLearner(tag, k, rng) {
  const options = C_OPTIONS[tag];
  const o = options[k % options.length];
  const v = chance(rng, 0.2) ? 0 : randInt(rng, 1, card.V_MAX);
  const params = { id: o.id, v };
  const item = card.build(params);
  const f = item.fields[0];
  const wrong = o.wrong(item.sim);
  const answer = { [f.id]: f.kind === 'number' ? Number(wrong) : String(wrong) };
  return { type: 'card', params, answer, reply: o.reply ? (cp) => o.reply(cp, item.sim) : () => null, option: o };
}

function learnerFor(family, tag, k, rng) {
  switch (family) {
    case 'add': return addLearner(tag, k, rng, 'full');
    case 'add-result': return addLearner(tag, k, rng, 'result');
    case 'shift': return shiftLearner(tag, k, rng);
    case 'twos': return twosLearner(tag, k, rng);
    case 'flags': return flagsLearner(tag, k, rng);
    case 'c': return cLearner(tag, k, rng);
    default: throw new Error(`unknown family ${family}`);
  }
}

/** the diagnosis loop the UI runs: ask checkpoints until a diagnosis (≤ 3) */
export function runDiagnosis(mod, item, answer, reply) {
  const cps = [];
  const asked = [];
  for (let n = 0; n <= 3; n++) {
    const r = mod.diagnose(item, answer, null, cps);
    if (!r.next) return { diagnosis: r.diagnosis, checkpoints: asked };
    const a = reply(r.next);
    asked.push({ id: r.next.id, prompt: r.next.prompt, reply: a ?? null, expected: r.next.answer });
    cps.push(a ?? null);
  }
  return { diagnosis: null, checkpoints: asked };
}

// ---------------------------------------------------------------------------
// The key: correct answer, first wrong column/step, and what score.mjs checks
// ---------------------------------------------------------------------------

const spaced = (s) => (s.length === 8 ? `${s.slice(0, 4)} ${s.slice(4)}` : s);
const msb = (bits) => binStr(bits);
const signed = (v) => (v < 0 ? `-${-v}` : String(v));
const colWords = (i) => `${colName(i)} (bit ${i}, the ${ordinal(i + 1)} column from the right)`;
const bitWords = (i, w) => `bit ${i}, the ${ordinal(w - i)} from the left`;

function addKey(item, answer, diag, cps) {
  const { w } = item.params;
  const key = item.key;
  const tag = diag.tag;
  const bitsWrong = key.result.slice(0, w).some((b, i) => answer.result[i] !== b) || (answer.result[w] ?? null) !== null;
  const parts = {};
  if (bitsWrong) parts.bits = msb(item.sim.result);
  if (answer.overflow !== key.overflow) parts.overflow = key.overflow;
  const i = diag.focus.column;
  let step;
  let locate;
  if (tag === 'add_or' || tag === 'add_three_ones') {
    step = colWords(i);
    locate = [{ kind: 'col', cols: [i], w }];
  } else if (tag === 'add_no_carry') {
    if (diag.focus.field === 'carries') {
      step = `the carry out of ${colWords(i)}, into ${colName(i + 1)}`;
      locate = [{ kind: 'col', cols: [i, i + 1], w }];
    } else {
      const carryWrong = cps.some((c) => c.id === 'carry-in' && c.reply !== c.expected);
      step = carryWrong
        ? `the carry into ${colWords(i)}, from ${colName(i - 1)}`
        : `${colWords(i)}: the carry coming into it was not added`;
      locate = [{ kind: 'col', cols: [i - 1, i].filter((x) => x >= 0), w }];
    }
  } else if (tag === 'add_carry_wrong_col') {
    step = `the carry row: each carry is one column away from where it belongs, first at the carry out of ${colWords(i)}`;
    locate = [{ kind: 'col', cols: [i, i + 1], w }];
  } else if (tag === 'add_ninth_bit') {
    step = `the ${ordinal(w + 1)} bit written on the left of the result (${aWidth(w)} answer has only ${w} bits)`;
    locate = [{ kind: 'col', cols: [w], w }, { kind: 'phrase', set: 'ninth' }];
  } else {
    step = `the overflow answer: every column is right, and there ${key.overflow === 'yes' ? 'is a' : 'is no'} carry out of the top column`;
    locate = [{ kind: 'overflow', want: key.overflow }, { kind: 'errPhrase', set: 'overflow' }];
  }
  // Only the working was wrong (a misplaced carry row): the reply should confirm the answer.
  if (!Object.keys(parts).length) parts.bits = msb(item.sim.result);
  return {
    correct: `${spaced(msb(item.sim.result))}, ${key.overflow === 'yes' ? 'overflow' : 'no overflow'}`,
    step, parts, locate,
  };
}

const SHIFT_STEP = {
  shift_direction: ['the direction of the shift', 'direction'],
  shift_amount: ['the number of places moved', 'amount'],
  shift_kept_bits: ['the bits that fall off the end', 'fallOff'],
  shift_fill: ['the bits that fill the gap', 'gap'],
  shift_arith_logical: ['the bits that fill the gap on the left', 'gap'],
};

function shiftKey(item, answer, diag, marking) {
  const { w, askValue } = item.params;
  const key = item.key;
  const correct = `${spaced(msb(key.bits))}${askValue ? `, value ${signed(key.value)}` : ''}`;
  if (diag.tag === 'shift_value_myth') {
    return { correct, step: 'the denary value: the shifted bits are right', parts: { number: key.value }, locate: [{ kind: 'phrase', set: 'value' }] };
  }
  const wrong = key.bits.map((b, i) => (answer.bits[i] !== b ? i : -1)).filter((i) => i >= 0);
  const [words, set] = SHIFT_STEP[diag.tag];
  return {
    correct,
    step: `${words} (first wrong bit: ${bitWords(marking.firstWrong.index, w)})`,
    parts: { bits: msb(key.bits) },
    locate: [{ kind: 'col', cols: wrong, w }, { kind: 'phrase', set }],
  };
}

function twosKey(item, answer, diag, marking) {
  const { w, n, task } = item.params;
  const M = 2 ** (w - 1);
  const tag = diag.tag;
  if (task === 'range') {
    const minWrong = answer.min !== -M;
    const maxWrong = answer.max !== M - 1;
    const step = minWrong && maxWrong ? 'both ends of the range' : minWrong ? `the smallest value (${-M})` : `the largest value (${M - 1})`;
    return {
      correct: `${-M} to ${M - 1}`, step, parts: { numbers: [-M, M - 1] },
      locate: [
        ...(minWrong ? [{ kind: 'phrase', set: 'rangeMin' }, { kind: 'number', n: -M }] : []),
        ...(maxWrong ? [{ kind: 'phrase', set: 'rangeMax' }, { kind: 'number', n: M - 1 }] : []),
        ...(minWrong && maxWrong ? [{ kind: 'phrase', set: 'rangeEnds' }] : []),
      ],
    };
  }
  if (task === 'encode') {
    const kb = msb(item.key.bits);
    const wrong = item.key.bits.map((b, i) => (answer.bits[i] !== b ? i : -1)).filter((i) => i >= 0);
    const first = bitWords(marking.firstWrong.index, w);
    return tag === 'twos_no_plus1'
      ? { correct: spaced(kb), step: `the +1 after inverting (first wrong bit: ${first})`, parts: { bits: kb }, locate: [{ kind: 'col', cols: wrong, w }, { kind: 'phrase', set: 'plusOne' }] }
      : { correct: spaced(kb), step: `turning +${-n} into ${n}: invert every bit, then add 1 (first wrong bit: ${first})`, parts: { bits: kb },
        locate: [{ kind: 'col', cols: wrong, w }, { kind: 'phrase', set: 'invert' }, { kind: 'phrase', set: 'plusOne' }] };
  }
  const correct = signed(n);
  if (tag === 'twos_msb_positive') {
    return { correct, step: `the value of the top bit (${-M}, not +${M})`, parts: { number: n }, locate: [{ kind: 'col', cols: [w - 1], w }, { kind: 'phrase', set: 'topBit' }] };
  }
  if (tag === 'twos_sign_magnitude') {
    return { correct, step: `reading a negative number: the top bit is worth ${-M} (or invert and add 1), it is not just a minus sign`, parts: { number: n },
      locate: [{ kind: 'col', cols: [w - 1], w }, { kind: 'phrase', set: 'topBit' }, { kind: 'phrase', set: 'invert' }, { kind: 'phrase', set: 'rest' }] };
  }
  return { correct, step: 'the +1 after inverting', parts: { number: n }, locate: [{ kind: 'phrase', set: 'plusOne' }] };
}

const FLAG_WORDS = { CF: 'CF, the carry flag', ZF: 'ZF, the zero flag', SF: 'SF, the sign flag', OF: 'OF, the overflow flag' };

function flagsKey(item, answer) {
  const s = item.sim;
  const ask = item.show.askFlags;
  const bits = msb(item.key.bits);
  if (ask.length === 1 && ask[0] === 'OF') {
    const want = s.OF ? 'yes' : 'no';
    return { correct: `${spaced(bits)}, ${want === 'yes' ? 'overflow' : 'no overflow'}`, step: 'the overflow answer (the result bits are right)', parts: { overflow: want },
      locate: [{ kind: 'overflow', want }, { kind: 'errPhrase', set: 'overflow' }] };
  }
  const wrong = ask.filter((f) => answer.flags[f] !== item.key.flags[f]);
  return {
    correct: `${spaced(bits)}, ${ask.map((f) => `${f} = ${item.key.flags[f]}`).join(', ')}`,
    step: `${wrong.map((f) => FLAG_WORDS[f]).join(' and ')} (the result bits are right)`,
    parts: { flags: Object.fromEntries(wrong.map((f) => [f, item.key.flags[f]])) },
    locate: [{ kind: 'flag', flags: wrong }],
  };
}

// The operation on the card's focus line, as a reply might name or quote it
// (matched ignoring case and spaces). Each snippet has one such operation, so
// for C "the first wrong step" is close to "talks about the right operation".
const C_FRAGS = {
  'char-200': (c) => [`char c = ${c.vals.n}`, 'char c', 'a char', 'plain char', 'signed char', 'stor', 'assign'],
  'minus-one-vs-unsigned': (c) => [`a ${c.vals.op} b`, `-${c.vals.k} ${c.vals.op} ${c.vals.m}`, 'compar', 'convert', 'conversion'],
  'uchar-promotion': (c) => ['a + b', `${c.vals.a} + ${c.vals.b}`, 'addition', 'adding', 'sum', 'promot'],
  'short-truncation': () => ['short s', 's = i', 'a short', 'stor', 'assign', 'convert'],
  'unsigned-wrap': (c) => [`u - ${c.vals.m}`, `${c.vals.k} - ${c.vals.m}`, 'subtract'],
  'int-max-plus-one': (c) => [`x + ${c.vals.d}`, `+ ${c.vals.d}`, 'addition', 'adding', 'the add'],
  'int-multiply-overflow': (c) => [c.vals.b === null ? 'a * a' : `a * ${c.vals.b}`, 'multipl', 'product', 'imul'],
  'negative-shift-right': (c) => [`x >> ${c.vals.s}`, '>>', 'shift', 'sar'],
  'truncating-division': (c) => ['a / b', 'c % d', `${c.vals.a} / ${c.vals.b}`, `${c.vals.c} % ${c.vals.d}`, 'divis', 'divid', 'remainder', 'modulo', 'idiv'],
  'signed-unsigned-branch': (c) => [`a ${c.vals.op} b`, `-${c.vals.k} ${c.vals.op} ${c.vals.m}`, 'compar', 'jump', 'cmp', 'branch', c.j, c.sj],
};

function cKey(item) {
  const c = item.sim;
  const f = item.fields[0];
  const code = item.show.lines[c.line - 1].trim();
  const parts = f.kind === 'number' ? { number: item.key.value } : f.kind === 'choice' ? { message: item.key.branch } : { output: item.key.output };
  const correct = f.kind === 'number' ? `${item.card.ask.var} = ${item.key.value}` : f.kind === 'choice' ? `it prints "${item.key.branch}"` : `it prints ${item.key.output}`;
  return { correct, step: `line ${c.line}: ${code}`, parts, locate: [{ kind: 'line', line: c.line, frags: C_FRAGS[item.params.id](c) }] };
}

// ---------------------------------------------------------------------------
// The student's message, typed the way a 15–19 year old would
// ---------------------------------------------------------------------------

const OPENERS = ['', 'hi, can you help me with this question?', 'doing revision and got this one wrong.', 'got this wrong on a practice question.',
  'homework question:', 'hey, stuck on this one.', 'can you check my working?'];
const CLOSERS = ['where did I go wrong?', 'can you tell me where I went wrong?', 'my teacher marked it wrong. where did I go wrong?',
  "the answers say it's wrong but I don't get why. where did I go wrong?", 'where have I gone wrong?'];

function voice(rng) {
  const casual = chance(rng, 0.5);
  // casual: all lower case "i"; otherwise every sentence starts with a capital
  const say = (s) => (casual
    ? s.replace(/\bI\b/g, 'i').replace(/^([A-Z])/, (m) => m.toLowerCase())
    : s.replace(/^([a-z])/, (m) => m.toUpperCase()).replace(/([.?]\s+)([a-z])/g, (m, p, c) => p + c.toUpperCase()));
  return { say, opener: pick(rng, OPENERS), closer: pick(rng, CLOSERS), rng };
}

const cellsOf = (arr) => arr.join(' ').replace(/\s+$/, '');

/** the written sum: carries on top (the carry into a column sits above it), then a, b and the result */
function additionBlock(A, B, ans) {
  const w = A.length;
  const bit = (x) => (x === null || x === undefined ? '0' : String(x));
  const carry = [bit(ans.carries[w])];
  for (let i = w - 1; i >= 1; i--) carry.push(bit(ans.carries[i]));
  const res = ans.result;
  return [
    `carries  ${cellsOf(carry)}`,
    `         ${cellsOf([' ', ...msb(A).split('')])}`,
    `       + ${cellsOf([' ', ...msb(B).split('')])}`,
    `         ${'-'.repeat(2 * w + 1)}`,
    `         ${cellsOf([res[w] === null || res[w] === undefined ? ' ' : String(res[w]), ...msb(res.slice(0, w)).split('')])}`,
  ].join('\n');
}

const studentBits = (bits) => bits.slice().reverse().map((b) => (b === null || b === undefined ? '_' : b)).join('');

function addMessage(item, answer, v) {
  const { w } = item.params;
  const A = item.show.a;
  const B = item.show.b;
  const res = studentBits(answer.result.slice(0, w + ((answer.result[w] ?? null) === null ? 0 : 1)));
  if (item.show.ask === 'full') {
    return [
      item.prompt,
      `${v.say(pick(v.rng, ['my working (carries on the top row):', "here's my working, carries on top:", 'this is what I wrote (top row is my carries):']))}\n\n${additionBlock(A, B, answer)}`,
      `${v.say('answer:')} ${res}\n${v.say('overflow:')} ${answer.overflow}`,
    ];
  }
  const said = pick(v.rng, [`I got ${res} and ${answer.overflow === 'yes' ? 'said there is an overflow' : 'no overflow'}`, `answer: ${res}, overflow: ${answer.overflow}`]);
  return [item.prompt, `  ${msb(A)}\n+ ${msb(B)}`, v.say(said)];
}

function shiftMessage(item, answer, v) {
  const lines = [v.say(`I got ${studentBits(answer.bits)}`)];
  if (item.params.askValue) lines.push(v.say(`value: ${signed(answer.value)}`));
  return [item.prompt, msb(item.show.x), lines.join('\n')];
}

function twosMessage(item, answer, tag, v) {
  const { w, n, task } = item.params;
  if (task === 'range') return [item.prompt, v.say(pick(v.rng, [`I put ${signed(answer.min)} to ${signed(answer.max)}`, `smallest: ${signed(answer.min)}, largest: ${signed(answer.max)}`]))];
  if (task === 'encode') {
    return [item.prompt, v.say(`+${-n} = ${msb(toBits(-n, w))}\nso ${n} = ${studentBits(answer.bits)}`)];
  }
  const bits = toBits(n, w);
  let working;
  if (tag === 'twos_msb_positive') {
    const ones = bits.map((b, i) => (b ? 2 ** i : 0)).filter(Boolean).reverse();
    working = `${ones.join(' + ')} = ${answer.value}`;
  } else if (tag === 'twos_sign_magnitude') {
    const rest = bits.slice(0, w - 1);
    working = `the first bit is 1 so it's negative, and ${msb(rest)} = ${fromBits(rest)}`;
  } else {
    const inv = bits.map((b) => 1 - b);
    working = `${msb(bits)} -> ${msb(inv)} = ${fromBits(inv)}, and it's negative`;
  }
  return [item.prompt, msb(bits), v.say(`${working}\n${pick(v.rng, ['so my answer is', 'answer:', 'so I said'])} ${signed(answer.value)}`)];
}

function flagsMessage(item, answer, v) {
  const { w, a, b, op } = item.params;
  const s = item.sim;
  const row = (bits, label) => `${msb(bits)}   (${label})`;
  const lines = [];
  if (op === '-') lines.push(v.say(`${signed(-b)} = ${msb(toBits(-b, w))}, so I did ${signed(a)} + ${-b < 0 ? `(${signed(-b)})` : signed(-b)}`));
  lines.push(`  ${row(s.A, signed(a))}\n+ ${row(op === '-' ? toBits(-b, w) : s.B, signed(op === '-' ? -b : b))}\n= ${msb(answer.bits)}`);
  const ask = item.show.askFlags;
  const flags = ask.length === 1 && ask[0] === 'OF'
    ? v.say(`overflow: ${answer.flags.OF ? 'yes' : 'no'}`)
    : ask.map((f) => `${f} = ${answer.flags[f]}`).join(', ');
  return [item.prompt, lines.join('\n'), flags];
}

function cMessage(item, answer, option, v) {
  const f = item.fields[0];
  const got = answer[f.id];
  let said;
  if (option.says) said = `I said ${option.says}`;
  else if (f.kind === 'number') said = pick(v.rng, [`I said ${got}`, `I put ${got}`]);
  else if (f.kind === 'choice') said = `I said it prints "${got}"`;
  else said = pick(v.rng, [`I said it prints ${got}`, `my answer was ${got}`]);
  if (option.note) said += `. ${option.note(item.sim)}`;
  return [item.prompt, item.show.src, v.say(said)];
}

function messageFor(rec, item, answer, option, rng) {
  const v = voice(rng);
  let body;
  if (rec.type === 'add') body = addMessage(item, answer, v);
  else if (rec.type === 'shift') body = shiftMessage(item, answer, v);
  else if (rec.type === 'twos') body = twosMessage(item, answer, rec.tag, v);
  else if (rec.type === 'sadd') body = flagsMessage(item, answer, v);
  else body = cMessage(item, answer, option, v);
  return [v.opener ? v.say(v.opener) : '', ...body, v.say(v.closer)].filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------------------
// Building the set
// ---------------------------------------------------------------------------

const json = (x) => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));

function tryAttempt(family, tag, k, rng) {
  const l = learnerFor(family, tag, k, rng);
  if (!l) return null;
  const mod = MODULES[l.type];
  const item = mod.build(l.params);
  const marking = mod.mark(item, l.answer);
  if (marking.correct) return null;
  const { diagnosis, checkpoints } = runDiagnosis(mod, item, l.answer, l.reply);
  if (!diagnosis || diagnosis.tag !== tag) return null;
  let key;
  if (l.type === 'add') key = addKey(item, l.answer, diagnosis, checkpoints);
  else if (l.type === 'shift') key = shiftKey(item, l.answer, diagnosis, marking);
  else if (l.type === 'twos') key = twosKey(item, l.answer, diagnosis, marking);
  else if (l.type === 'sadd') key = flagsKey(item, l.answer);
  else key = cKey(item);
  const route = family === 'c' || (family === 'flags' && item.level === 'csapp') ? 'university' : 'schools';
  return { l, item, diagnosis, checkpoints, key, route };
}

/** 200 items, deterministic from the seed */
export function generateItems(seed = DEFAULT_SEED) {
  const out = [];
  const seen = new Set();
  for (const [family, tag, count] of PLAN) {
    for (let k = 0; k < count; k++) {
      let made = null;
      for (let attempt = 0; attempt < 300 && !made; attempt++) {
        const rng = mulberry32(mixSeed(seed, 'e0', family, tag, k, attempt));
        const t = tryAttempt(family, tag, k, rng);
        if (!t) continue;
        const ident = JSON.stringify(json([t.l.type, t.l.params, t.l.answer]));
        if (seen.has(ident)) continue;
        seen.add(ident);
        made = t;
      }
      if (!made) throw new Error(`E0: could not make item ${k + 1} for ${family}/${tag}`);
      const { l, item, diagnosis, checkpoints, key, route } = made;
      out.push({
        family, route, type: l.type, params: json(l.params), level: item.level, tag, tagLabel: tagLabel(tag),
        question: item.prompt,
        learner: { answer: json(l.answer), checkpoints: json(checkpoints) },
        key: { ...key, tag, tagLabel: tagLabel(tag), w: item.params.w ?? null, ourDiagnosis: { headline: diagnosis.headline, detail: diagnosis.detail, focus: json(diagnosis.focus) } },
        _item: item, _option: l.option,
      });
    }
  }
  // Paste order: families interleaved, so no model sees 70 additions in a row.
  const order = shuffle(mulberry32(mixSeed(seed, 'e0-order')), out.map((_, i) => i));
  return order.map((i, n) => {
    const rec = out[i];
    const id = `E0-${String(n + 1).padStart(3, '0')}`;
    const message = messageFor(rec, rec._item, rec.learner.answer, rec._option, mulberry32(mixSeed(seed, 'e0-msg', id)));
    // eslint-disable-next-line no-unused-vars -- dropping the in-memory fields from the record
    const { _item, _option, ...plain } = rec;
    return { id, seed, ...plain, message };
  });
}

export function promptsText(items, seed) {
  const head = [
    `E0 prompts: ${items.length} student messages (seed ${seed}).`,
    'Paste each message into a NEW chat on the free tier of each model, with default settings.',
    'Copy only the text between the two marker lines. Record the full reply against the id in e0-scoring.csv.',
    '',
  ];
  const body = items.map((it) => [`======== ${it.id} · copy from the next line ========`, it.message, `======== ${it.id} · end ========`, ''].join('\n'));
  return `${head.join('\n')}\n${body.join('\n')}`;
}

export function scoringCsv(items, models = MODELS) {
  const rows = [['id', 'model', 'response', 'answer_ok', 'column_ok', 'misconception_ok', 'rater']];
  for (const m of models) for (const it of items) rows.push([it.id, m, '', '', '', '', '']);
  return toCsv(rows);
}

export function writeAll(items, outDir, { seed = DEFAULT_SEED, models = MODELS } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'e0-items.jsonl'), `${items.map((it) => JSON.stringify(it)).join('\n')}\n`);
  fs.writeFileSync(path.join(outDir, 'e0-prompts.txt'), promptsText(items, seed));
  fs.writeFileSync(path.join(outDir, 'e0-scoring.csv'), scoringCsv(items, models));
}

function parseArgs(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const a = { seed: DEFAULT_SEED, out: path.join(here, 'out'), models: MODELS };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--seed') a.seed = Number(argv[++i]);
    else if (v === '--out') a.out = path.resolve(argv[++i]);
    else if (v === '--models') a.models = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (v === '-h' || v === '--help') a.help = true;
    else throw new Error(`Unexpected argument: ${v}`);
  }
  if (!Number.isInteger(a.seed) || a.seed < 0 || a.seed > 0xFFFFFFFF) throw new Error('--seed must be a whole number from 0 to 4294967295.');
  if (!a.models.length) throw new Error('--models needs at least one name.');
  return a;
}

export function main(argv = process.argv.slice(2), log = console.log) {
  const a = parseArgs(argv);
  if (a.help) { log('Usage: node tools/e0/generate.mjs [--seed N] [--out dir] [--models a,b,c]'); return 0; }
  const items = generateItems(a.seed);
  writeAll(items, a.out, a);
  const byFamily = {};
  for (const it of items) byFamily[it.family] = (byFamily[it.family] || 0) + 1;
  log(`Wrote ${items.length} items (seed ${a.seed}) to ${a.out}`);
  log(`  ${Object.entries(byFamily).map(([f, n]) => `${f} ${n}`).join(', ')}`);
  log(`  tags covered: ${new Set(items.map((it) => it.tag)).size} of ${TAG_IDS.filter((t) => t && E0_TAGS.includes(t)).length}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
