// Signed w-bit addition and subtraction with flags (A-level 1.4.1: "overflow";
// CS:APP 3.6: CF ZF SF OF). The key is the ALU simulation in engine/bits.js:
// subtraction really is a + ~b + 1, so result-bit mistakes are analysed in
// that adder's columns, with the same column rules as unsigned addition.
import { addBits, subBits, toBits, range as bitRange } from '../../engine/bits.js';
import { randInt, chance } from '../../lib/rng.js';
import {
  withLevel, levelCode, levelFrom, clampW, binStr, num, colName,
  resultBitFlow, columnDetail, carryDetail, columnLayer, adderWires, columnStudent, studentReplies, studentWork,
} from './add.js';

export const TYPE = 'sadd';
export const TYPE_ID = 3;
export const TARGETS = ['flags_carry_is_overflow', 'flags_signed_overflow_missed', 'flags_sub_carry', 'add_or', 'add_no_carry', 'add_three_ones'];

const FLAGS = ['CF', 'ZF', 'SF', 'OF'];
const OPS = ['+', '-'];
const ADD_TAGS = ['add_or', 'add_no_carry', 'add_three_ones'];

/** column names for signed sums: the top column is the sign column */
const sName = (i, w) => (i === w - 1 ? 'the sign column' : colName(i));

/** the whole ALU computation, plus the adder's view of it (A + B + cin) */
function simulate({ w, a, b, op }) {
  const r = op === '-' ? subBits(a, b, w) : addBits(a, b, w);
  const A = toBits(a, w);
  const B = op === '-' ? r.binv : toBits(b, w);
  const truth = op === '-' ? a - b : a + b;
  // On paper (A-level) a − b is done as a + (−b): same result bits, but the
  // carries differ where b ends in 0s. Checkpoints accept either carry.
  const paperCarries = op === '-' ? addBits(a, -b, w).carries : r.carries;
  return { ...r, A, B, cin: op === '-' ? 1 : 0, truth, paperCarries, signedValue: r.result[w - 1] ? r.value - 2 ** w : r.value };
}

/** '45 − (−20)': a negative second operand gets brackets, as on paper */
const sumText = ({ a, b, op }) => `${num(a)} ${op === '-' ? '−' : '+'} ${b < 0 ? `(${num(b)})` : num(b)}`;

const onlyOverflow = (askFlags) => askFlags.length === 1 && askFlags[0] === 'OF';

export function build(params) {
  const { w, a, b, op } = params;
  const askFlags = FLAGS.filter((f) => (params.askFlags || ['OF']).includes(f));
  const sim = simulate(params);
  const level = params.level || (onlyOverflow(askFlags) ? 'alevel' : 'csapp');
  const flags = {};
  for (const f of askFlags) flags[f] = sim[f];
  const sum = sumText(params);
  const tail = onlyOverflow(askFlags)
    ? ' Then say whether there is an overflow.'
    : ` Then give the flag${askFlags.length === 1 ? '' : 's'} ${askFlags.join(', ')}.`;
  return {
    type: TYPE,
    params,
    level,
    spec: onlyOverflow(askFlags) ? 'H446-1.4.1-arith' : 'CSAPP-3.6',
    prompt: `Work out ${sum} using ${w}-bit two's complement.${tail}`,
    show: { w, a: toBits(a, w), b: toBits(b, w), aValue: a, bValue: b, op, signed: true, askFlags },
    fields: [
      { id: 'bits', kind: 'bits', label: 'Result', width: w },
      { id: 'flags', kind: 'flags', label: onlyOverflow(askFlags) ? 'Overflow?' : 'Flags', choices: askFlags },
    ],
    key: { bits: sim.result.slice(), flags },
    family: 'flags',
    sim,
  };
}

export function blank(item) {
  const flags = {};
  for (const f of item.show.askFlags) flags[f] = null;
  return { bits: new Array(item.params.w).fill(null), flags };
}

const st = (got, want) => (got === null || got === undefined ? 'missing' : got === want ? 'ok' : 'bad');

export function mark(item, answer) {
  const { w } = item.params;
  const askFlags = item.show.askFlags;
  const bits = item.key.bits.map((b, i) => st(answer.bits?.[i], b));
  const flags = askFlags.map((f) => st(answer.flags?.[f], item.key.flags[f]));
  let firstWrong = null;
  let right = 0;
  // Working order: the result right to left (it is an addition), then flags.
  for (let i = 0; i < w; i++) {
    if (bits[i] === 'ok') right++;
    else if (!firstWrong) firstWrong = { field: 'bits', index: i };
  }
  flags.forEach((s, j) => {
    if (s === 'ok') right++;
    else if (!firstWrong) firstWrong = { field: 'flags', index: j };
  });
  const total = w + askFlags.length;
  return { correct: right === total, cells: { bits, flags }, firstWrong, score: { right, total } };
}

function finish(tag, headline, detail, focus) {
  return { next: null, diagnosis: { tag, headline, detail, focus } };
}

/** one-sentence reasons for each flag, used by diagnosis and the flags layer */
function flagReasons(item) {
  const { w, a, b, op } = item.params;
  const s = item.sim;
  const plain = onlyOverflow(item.show.askFlags);
  const of = (v) => (plain ? (v ? 'there is an overflow' : 'there is no overflow') : `OF = ${v}`);
  const { min, max } = bitRange(w, true);
  const ua = a < 0 ? a + 2 ** w : a;
  const ub = b < 0 ? b + 2 ** w : b;
  const sign = (v) => (v < 0 ? 'negative' : 'positive');
  let OF;
  if (op === '+') {
    if ((a < 0) !== (b < 0)) OF = `The inputs have different signs, so the sum always fits and ${of(0)}.`;
    else if (s.OF) OF = `Both inputs are ${sign(a)} but the result is ${sign(s.signedValue)}, so ${of(1)}.`;
    else OF = `Both inputs are ${sign(a)} and so is the result, so ${of(0)}.`;
  } else {
    OF = s.OF
      ? `The true answer ${num(s.truth)} is outside ${num(min)} to ${max}, so ${of(1)}.`
      : `The true answer ${num(s.truth)} fits in ${w}-bit two's complement, so ${of(0)}.`;
  }
  const CF = op === '+'
    ? (s.CF ? 'There is a carry out of the top column, so CF = 1.' : 'There is no carry out of the top column, so CF = 0.')
    : `As unsigned numbers, ${ua} − ${ub} ${s.CF ? 'needs' : 'does not need'} a borrow, so CF = ${s.CF}.`;
  return {
    CF, OF,
    SF: `SF copies the top bit of the result, which is ${s.SF}.`,
    ZF: s.ZF ? 'Every result bit is 0, so ZF = 1.' : 'The result is not all 0s, so ZF = 0.',
  };
}

function flagsDiagnosis(item, answer) {
  const { w, b, op } = item.params;
  const s = item.sim;
  const askFlags = item.show.askFlags;
  const got = answer.flags || {};
  const given = (f) => got[f] === 0 || got[f] === 1;
  const wrong = (f) => askFlags.includes(f) && given(f) && got[f] !== s[f];
  const reasons = flagReasons(item);
  const { min, max } = bitRange(w, true);
  const focus = (f) => ({ field: 'flags', flag: f, index: askFlags.indexOf(f), column: w - 1 });
  const ofName = onlyOverflow(askFlags) ? 'overflow' : 'OF';

  // CF and OF swapped outright.
  if (wrong('CF') && wrong('OF') && got.CF === s.OF && got.OF === s.CF && op === '+') {
    return finish('flags_carry_is_overflow', 'You swapped the carry and overflow flags.',
      `CF is the carry out of the top column (${s.CF}), which matters for unsigned numbers. OF says whether the signed answer fits (${s.OF}).`, focus('OF'));
  }
  if (wrong('OF') && (got.OF === 0 || got.OF === 1)) {
    if (s.OF === 1) {
      return finish('flags_signed_overflow_missed', `You missed the signed overflow.`,
        `The true answer ${num(s.truth)} does not fit in ${w}-bit two's complement (${num(min)} to ${max}), so the result wrapped round to ${num(s.signedValue)}. That is a signed overflow${ofName === 'OF' ? ', so OF = 1' : ''}.`, focus('OF'));
    }
    if (s.cout === 1) {
      return finish('flags_carry_is_overflow', 'You treated the carry out as an overflow.',
        `${op === '-' ? `Adding the two's complement of ${num(b)} gives a carry out of the top column` : 'A 1 carries out of the top column'}, but for signed numbers that is not an overflow. The true answer ${num(s.truth)} fits in ${w} bits, so ${ofName === 'OF' ? 'OF = 0' : 'there is no overflow'}.`, focus('OF'));
    }
  }
  if (wrong('CF') && (got.CF === 0 || got.CF === 1)) {
    if (op === '-') {
      return finish('flags_sub_carry', 'You misread CF after a subtraction.',
        `${reasons.CF} After a subtraction CF means a borrow, the opposite of the adder's carry out (${s.cout}).`, focus('CF'));
    }
    if (got.CF === s.OF) {
      return finish('flags_carry_is_overflow', 'You used overflow for the carry flag.',
        `CF is just the carry out of the top column, which is ${s.CF} here. Whether the signed answer fits is OF's job, not CF's.`, focus('CF'));
    }
  }
  const f = FLAGS.find((x) => wrong(x));
  if (!f) {
    // Every flag given is right, so the first problem is one left empty.
    const e = askFlags.find((x) => !given(x));
    const what = e === 'OF' && ofName === 'overflow' ? 'whether there is an overflow' : e;
    return finish(null, `You didn't give ${what}.`, reasons[e], focus(e));
  }
  return finish('other', f === 'OF' && ofName === 'overflow' ? 'Your overflow answer is not right.' : `Your ${f} is not right.`, reasons[f], focus(f));
}

export function diagnose(item, answer, marking, cpAnswers = []) {
  const m = marking || mark(item, answer);
  const { w, op } = item.params;
  if (m.correct) return finish(null, 'All correct.', 'Your result and flags match the machine.', { column: w - 1 });
  const s = item.sim;
  const bits = answer.bits || [];
  const i = [...Array(w).keys()].find((j) => bits[j] !== s.result[j]);
  if (i === undefined) return flagsDiagnosis(item, answer);
  if (bits[i] === null || bits[i] === undefined) {
    return finish(null, `You left ${sName(i, w)} of the result empty.`,
      `${i === 0 ? 'Start there' : 'Everything to its right is correct'}. Work right to left, adding each column and its carry.`, { column: i, field: 'bits', index: i });
  }

  // Result bits wrong: find the broken column of the adder a + b (or a + ~b + 1).
  const name = sName(i, w);
  const flow = resultBitFlow(i, s.A[i], s.B[i], s.carries[i], cpAnswers, name, s.paperCarries[i]);
  if (flow.next) {
    const next = { ...flow.next };
    if (op === '-') next.prompt = `The machine works out a − b as a + (b inverted) + 1. ${next.prompt}`;
    return { next, diagnosis: null };
  }
  const focus = { column: i, field: 'bits', index: i };
  const headline = `Your result first goes wrong in ${name}.`;
  if (flow.carryWrong) return finish(flow.tag, headline, carryDetail(s.carries[i], name, flow.unsure), focus);
  if (flow.slip) return finish('other', headline, `You can do ${name} when asked, so this was probably a slip. Check each column as you write it.`, focus);
  return finish(flow.tag, headline, columnDetail(flow.tag, i, s.A[i], s.B[i], s.carries[i], flow.got?.[0] ?? null, flow.got?.[1] ?? null, name, i === w - 1), focus);
}

// ---------------------------------------------------------------------------
// Why layers
// ---------------------------------------------------------------------------

function flagsSay(item, tag, reasons) {
  const s = item.sim;
  if (tag === 'flags_carry_is_overflow') {
    if (onlyOverflow(item.show.askFlags)) return [`The carry out of the top column is ${s.cout}, but signed overflow means the true answer does not fit, whatever the carry.`, reasons.OF];
    // After a subtraction CF is the borrow, not the adder's carry out, so name the carry out plainly.
    return item.params.op === '-'
      ? [`The adder's carry out is ${s.cout} but OF is ${s.OF}: a carry out says nothing about whether the signed answer fits.`, reasons.OF]
      : [`The carry out is ${s.cout} but OF is ${s.OF}: CF is about unsigned numbers, OF about signed ones.`, reasons.OF];
  }
  if (tag === 'flags_signed_overflow_missed') return [reasons.OF, s.cout ? 'Overflow is about whether the answer fits, not the carry out.' : 'A signed overflow can happen with no carry out at all.'];
  if (tag === 'flags_sub_carry') return [reasons.CF, `The adder's carry out is ${s.cout}; after a subtraction CF is its opposite.`];
  const say = [reasons.OF];
  if (item.show.askFlags.includes('CF')) say.push(reasons.CF);
  return say;
}

export function why(item, diagnosis, { level } = {}) {
  const lv = level || item.level || 'alevel';
  const { w, a, b, op } = item.params;
  const s = item.sim;
  const tag = diagnosis?.tag ?? null;
  // Highlight the learner's column for column mistakes, slips and empty boxes alike.
  const columnTag = ADD_TAGS.includes(tag) || ((tag === 'other' || (tag === null && diagnosis)) && diagnosis?.focus?.field === 'bits' && Number.isInteger(diagnosis.focus.column));
  const f = columnTag ? diagnosis.focus.column : w - 1;
  const { min, max } = bitRange(w, true);
  const sum = sumText(item.params);
  const first = op === '-'
    ? `The ALU works out ${sum} as ${num(a)} + (${num(b)} with every bit inverted) + 1, so a carry of 1 goes into the 1s column.`
    : `${sum} gives ${binStr(s.result)}, which is ${num(s.signedValue)} in ${w}-bit two's complement.`;
  let second;
  if (s.OF) second = `The true answer ${num(s.truth)} is outside ${num(min)} to ${max}, so the result wraps round to ${num(s.signedValue)}.`;
  else if (op === '-') second = `The result is ${binStr(s.result)} = ${num(s.signedValue)}.`;
  else second = `Look at ${sName(f, w)}, which is highlighted.`;
  const layers = [{
    id: 'columns', kind: 'columns', title: 'The whole sum',
    say: [first, second],
    data: {
      w, a: s.A.slice(), b: s.B.slice(), op,
      carries: [op === '-' ? 1 : null, ...s.carries.slice(1)], result: s.result.slice(),
      highlight: f, dropped: s.cout === 1, signed: true,
      labels: { a: num(a), b: op === '-' ? `${num(b)} inverted` : num(b), r: num(s.signedValue) },
    },
  }];
  if (columnTag) layers.push(columnLayer(f, s.A[f], s.B[f], s.carries[f], sName(f, w)));
  const reasons = flagReasons(item);
  layers.push({
    id: 'flags', kind: 'flags', title: 'The flags',
    say: flagsSay(item, tag, reasons),
    data: { CF: s.CF, ZF: s.ZF, SF: s.SF, OF: s.OF, why: reasons },
  });
  if (lv !== 'gcse') {
    const d = adderWires(s.A[f], s.B[f], s.carries[f]);
    const say = f === w - 1
      ? [`In the sign column the full adder gets a = ${d.a}, b = ${d.b} and carry-in ${d.cin}, so sum = ${d.sum} and carry out = ${d.cout}.`,
        `OF = carry-in XOR carry out = ${d.cin} XOR ${d.cout} = ${s.OF}.`]
      : [`A full adder does ${sName(f, w)} with gates: x1 = a XOR b = ${d.x1}, and sum = x1 XOR carry-in = ${d.sum}.`,
        `The carry out is (a AND b) OR (x1 AND carry-in) = ${d.a1} OR ${d.a2} = ${d.cout}.`];
    layers.push({ id: 'adder', kind: 'adder', title: 'Full adder', say, data: d });
  }
  return layers;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Answers (with checkpoint replies) that a learner holding `tag` gives.
 * Returns [{ answer, reply(cp) }].
 */
export function misconceptions(params, tag) {
  const item = build(params);
  const s = item.sim;
  const key = item.key;
  const same = () => ({ bits: key.bits.slice(), flags: { ...key.flags } });
  const out = [];
  if (ADD_TAGS.includes(tag)) {
    for (const v of tag === 'add_no_carry' ? [0, 1] : [0]) {
      const student = columnStudent(tag, v);
      const work = studentWork(s.A, s.B, s.cin, student);
      out.push({ answer: { bits: work.result, flags: { ...key.flags } }, reply: studentReplies(s.A, s.B, s.cin, student) });
    }
    return out;
  }
  const ans = same();
  if (tag === 'flags_carry_is_overflow') ans.flags.OF = s.cout;
  else if (tag === 'flags_signed_overflow_missed') ans.flags.OF = 0;
  else if (tag === 'flags_sub_carry') ans.flags.CF = s.cout;
  else return [];
  return [{ answer: ans, reply: () => null }];
}

/** run the diagnosis loop the way the UI does, answering checkpoints */
export function runDiagnosis(item, answer, reply) {
  const cps = [];
  for (let n = 0; n <= 3; n++) {
    const r = diagnose(item, answer, null, cps);
    if (!r.next) return { ...r, steps: n };
    cps.push(reply(r.next));
  }
  return { next: null, diagnosis: null, steps: 4 };
}

function exercises(params, tag) {
  const item = build(params);
  const list = misconceptions(params, tag);
  return list.length > 0 && list.every(({ answer, reply }) => {
    if (mark(item, answer).correct) return false;
    return runDiagnosis(item, answer, reply).diagnosis?.tag === tag;
  });
}

// Exam-realistic signed operands: never 0 or ±1, a mix of signs.
function operand(rng, w, sign) {
  const M = 2 ** (w - 1);
  const lo = Math.max(2, M >> 4);
  const mag = randInt(rng, lo, M - 1);
  return sign < 0 ? -mag : mag;
}

function candidate(rng, w, op, target, wantOverflow) {
  const M = 2 ** (w - 1);
  for (;;) {
    const a = operand(rng, w, chance(rng, 0.5) ? 1 : -1);
    const b = operand(rng, w, chance(rng, 0.5) ? 1 : -1);
    const t = op === '-' ? a - b : a + b;
    const of = t < -M || t > M - 1;
    if (target === 'flags_signed_overflow_missed' && !of) continue;
    if (target === 'flags_carry_is_overflow' && of) continue;
    if (wantOverflow !== null && of !== wantOverflow) continue;
    return [a, b];
  }
}

export function generate(rng, opts = {}) {
  const w = clampW(opts.w ?? opts.width, 4, 16, 8);
  const target = TARGETS.includes(opts.target) ? opts.target : null;
  const level = opts.level || null;
  let askFlags = FLAGS.filter((f) => (opts.askFlags || (level === 'csapp' ? FLAGS : ['OF'])).includes(f));
  if (!askFlags.length) askFlags = ['OF'];
  if (target === 'flags_sub_carry' && !askFlags.includes('CF')) askFlags = FLAGS.slice();
  if ((target === 'flags_carry_is_overflow' || target === 'flags_signed_overflow_missed') && !askFlags.includes('OF')) askFlags = FLAGS.filter((f) => askFlags.includes(f) || f === 'OF');
  const avoid = opts.avoid || null;
  let fallback = null;
  for (let tries = 0; tries < 600; tries++) {
    let op = OPS.includes(opts.op) ? opts.op : chance(rng, 0.6) ? '+' : '-';
    if (target === 'flags_sub_carry') op = '-';
    if (target === 'flags_carry_is_overflow' || ADD_TAGS.includes(target)) op = '+';
    const wantOverflow = target ? null : chance(rng, 0.4);
    const [a, b] = candidate(rng, w, op, target, wantOverflow);
    const params = withLevel({ w, a, b, op, askFlags: askFlags.slice() }, level);
    if (avoid && avoid.a === a && avoid.b === b && avoid.op === op) continue;
    fallback = fallback || params;
    if (target && !exercises(params, target)) continue;
    return params;
  }
  return fallback;
}

export function variant(item, tagId, rng) {
  const p = item.params;
  return generate(rng, { level: p.level, w: p.w, askFlags: p.askFlags, target: tagId, avoid: p });
}

export function encodeParams(p) {
  const M = 2 ** (p.w - 1);
  const mask = FLAGS.reduce((m, f, i) => m | ((p.askFlags || []).includes(f) ? 1 << i : 0), 0);
  return [p.w, p.a + M, p.b + M, OPS.indexOf(p.op), mask, levelCode(p.level)];
}

export function decodeParams(ints) {
  const [w0, a, b, op, mask, lv] = ints;
  const w = clampW(w0, 4, 16, 8);   // untrusted links: keep every number in range
  const M = 2 ** (w - 1);
  const askFlags = FLAGS.filter((_, i) => mask & (1 << i));
  return withLevel({ w, a: clampW(a, 0, 2 * M - 1, M) - M, b: clampW(b, 0, 2 * M - 1, M) - M, op: OPS[op] || '+', askFlags: askFlags.length ? askFlags : ['OF'] }, levelFrom(lv));
}

