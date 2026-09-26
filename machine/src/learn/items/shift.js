// Binary shifts (GCSE 1.2.4; A-level logical vs arithmetic). The key comes
// from engine/bits.js. A wrong answer is diagnosed by recomputing the shift
// each misconception would produce (rotate, other direction, other kind,
// other fill, other amount) and naming the first one that matches exactly.
import { shiftBits, toBits, fromBits } from '../../engine/bits.js';
import { randInt, pick, chance } from '../../lib/rng.js';
import { withLevel, levelCode, levelFrom, clampW, popcount, sameBits, binStr, num, count, cap } from './add.js';

export const TYPE = 'shift';
export const TYPE_ID = 1;
export const TARGETS = ['shift_direction', 'shift_amount', 'shift_kept_bits', 'shift_fill', 'shift_value_myth', 'shift_arith_logical'];

const DIRS = ['L', 'R'];
const KINDS = ['logical', 'arithmetic'];
const dirWord = (d) => (d === 'L' ? 'left' : 'right');
const places = (k) => `${k} place${k === 1 ? '' : 's'}`;
const other = (d) => (d === 'L' ? 'R' : 'L');
const fmt = (v) => num(Number(v.toFixed(4)));

/** value of a bit pattern the way this item reads it */
const valueOf = (bits, kind) => fromBits(bits, { signed: kind === 'arithmetic' });
/** '8 bits', or '8-bit two's complement' when the item reads values as signed */
const fits = (w, kind) => (kind === 'arithmetic' ? `${w}-bit two's complement` : `${w} bits`);

function levelOf(params) {
  return params.level || (params.kind === 'arithmetic' ? 'alevel' : 'gcse');
}

/** bits wrap round instead of falling off: a rotate */
function rotate(X, w, dir, k) {
  const out = new Array(w);
  for (let i = 0; i < w; i++) out[i] = dir === 'L' ? X[(i - k + w * k) % w] : X[(i + k) % w];
  return out;
}

/** the correct shift with the gap filled with the other bit */
function wrongFill(X, w, dir, k, kind) {
  const s = shiftBits(X, w, dir, k, kind);
  const out = s.bits.slice();
  const gap = dir === 'L' ? [...Array(k).keys()] : [...Array(k).keys()].map((j) => w - 1 - j);
  for (const i of gap) if (i >= 0 && i < w) out[i] = 1 - s.fill;
  return out;
}

/** a right shift of a negative number is where arithmetic and logical differ */
function arithLogicalApplies(params) {
  const { w, x, dir, kind } = params;
  const msb = toBits(x, w)[w - 1];
  return dir === 'R' && msb === 1 && (kind === 'arithmetic' || levelOf(params) !== 'gcse');
}

/**
 * What each misconception gives for the bits, in diagnosis priority order.
 * Every entry is a full answer the learner could have written.
 */
function candidates(params) {
  const { w, x, dir, k, kind } = params;
  const X = toBits(x, w);
  const list = [];
  // Arithmetic vs logical first: when the lost bits all equal the other fill,
  // a rotate looks identical, and mixing up the two shifts is far likelier.
  if (arithLogicalApplies(params)) {
    list.push({ tag: 'shift_arith_logical', bits: shiftBits(X, w, dir, k, kind === 'arithmetic' ? 'logical' : 'arithmetic').bits });
  }
  list.push({ tag: 'shift_kept_bits', bits: rotate(X, w, dir, k) });
  list.push({ tag: 'shift_direction', bits: shiftBits(X, w, other(dir), k, kind).bits });
  list.push({ tag: 'shift_fill', bits: wrongFill(X, w, dir, k, kind) });
  // Nearest wrong amounts first: off by one is the usual slip. Beyond 2 places
  // out, an exact match is more likely chance than a miscount, so stop there.
  const ks = [...Array(w - 1).keys()].map((j) => j + 1).filter((j) => j !== k && Math.abs(j - k) <= 2).sort((p, q) => Math.abs(p - k) - Math.abs(q - k) || p - q);
  for (const k2 of ks) list.push({ tag: 'shift_amount', bits: shiftBits(X, w, dir, k2, kind).bits, k: k2 });
  return list;
}

/** values a learner gets by assuming ×2^k / ÷2^k always holds */
function mythValues(params) {
  const { w, x, dir, k, kind } = params;
  const v = valueOf(toBits(x, w), kind);
  const f = 2 ** k;
  return dir === 'L' ? [v * f] : [v / f, Math.trunc(v / f)];
}

export function build(params) {
  const { w, x, dir, k, kind } = params;
  const askValue = !!params.askValue;
  const X = toBits(x, w);
  const s = shiftBits(X, w, dir, k, kind);
  const level = levelOf(params);
  const key = { bits: s.bits, value: askValue ? valueOf(s.bits, kind) : null };
  const how = level === 'gcse' && kind === 'logical'
    ? `Shift this ${w}-bit binary number ${places(k)} to the ${dirWord(dir)}.`
    : `Do ${kind === 'logical' ? 'a logical' : 'an arithmetic'} shift ${dirWord(dir)} by ${places(k)} on this ${w}-bit number.`;
  const valueAsk = kind === 'arithmetic' ? " Then give its value in denary (read it as two's complement)." : ' Then give its value in denary.';
  const fields = [{ id: 'bits', kind: 'bits', label: 'After the shift', width: w }];
  // decimal: the ÷2^k myth gives values like 11.25, and the learner must be able to write them.
  if (askValue) fields.push({ id: 'value', kind: 'number', label: 'Value in denary', decimal: true });
  return {
    type: TYPE,
    params,
    level,
    spec: level === 'gcse' ? 'J277-1.2.4-shift' : 'H446-1.4.1-shift',
    prompt: how + (askValue ? valueAsk : ''),
    show: { w, x: X, xValue: valueOf(X, kind), dir, k, kind, signed: kind === 'arithmetic' },
    fields,
    key,
    family: 'shift',
    sim: s,
  };
}

export function blank(item) {
  return { bits: new Array(item.params.w).fill(null), value: null };
}

const st = (got, ok) => (got === null || got === undefined || Number.isNaN(got) ? 'missing' : ok ? 'ok' : 'bad');
const sameValue = (a, b) => typeof a === 'number' && Number.isFinite(a) && Math.abs(a - b) < 1e-9;

export function mark(item, answer) {
  const { w } = item.params;
  const key = item.key;
  const bits = key.bits.map((b, i) => st(answer.bits?.[i], answer.bits?.[i] === b));
  const cells = { bits };
  if (item.params.askValue) cells.value = st(answer.value, sameValue(answer.value, key.value));
  let firstWrong = null;
  let right = 0;
  let total = 0;
  // Reading order, the way the learner writes a shifted pattern: left to right.
  for (let i = w - 1; i >= 0; i--) {
    total++;
    if (bits[i] === 'ok') right++;
    else if (!firstWrong) firstWrong = { field: 'bits', index: i };
  }
  if ('value' in cells) {
    total++;
    if (cells.value === 'ok') right++;
    else if (!firstWrong) firstWrong = { field: 'value', index: null };
  }
  return { correct: right === total, cells, firstWrong, score: { right, total } };
}

function finish(tag, headline, detail, focus) {
  return { next: null, diagnosis: { tag, headline, detail, focus } };
}

function bitsDetail(tag, params, cand, item) {
  const { dir, k, kind } = params;
  const end = dirWord(dir);
  const fill = item.sim.fill;
  switch (tag) {
    case 'shift_kept_bits':
      return `You moved the bits that fall off the ${end} end round to the other end, which is a rotate. In a shift they are lost, and ${fill}s fill the gap.`;
    case 'shift_direction':
      return `You shifted ${dirWord(other(dir))} instead of ${end}. A left shift moves every bit towards the bigger place values; a right shift moves them towards the 1s column.`;
    case 'shift_amount':
      return `Your answer is a shift of ${places(cand.k)}, but the question asks for ${places(k)}. Move every bit exactly ${places(k)}, so the gap is ${k} bit${k === 1 ? '' : 's'} wide.`;
    case 'shift_arith_logical':
      return kind === 'arithmetic'
        ? 'An arithmetic right shift copies the sign bit (1) into the gap, so a negative number stays negative. You filled with 0s, which is a logical shift.'
        : 'A logical right shift always fills the gap with 0s, even when the top bit is 1. You copied the sign bit, which is an arithmetic shift.';
    case 'shift_fill':
      if (dir === 'L') return 'A left shift always fills the gap on the right with 0s. You filled it with 1s.';
      if (kind === 'logical') return 'A logical right shift always fills the gap on the left with 0s. You filled it with 1s.';
      return `An arithmetic right shift copies the sign bit into the gap, and here the sign bit is ${fill}. So the gap fills with ${fill}s, not ${1 - fill}s.`;
    default:
      return `Your bits don't match the shift or a common shift mistake. Move every bit ${places(k)} ${end}, let the end bits fall off, and fill the gap with ${fill}s.`;
  }
}

const HEADLINES = {
  shift_kept_bits: 'Your bits wrapped round the end.',
  shift_direction: 'You shifted the wrong way.',
  shift_amount: 'You shifted by the wrong number of places.',
  shift_arith_logical: 'You mixed up arithmetic and logical shifts.',
  shift_fill: 'You filled the gap with the wrong bit.',
  other: 'Your bits are not the shifted pattern.',
};

function valueDetail(params, item) {
  const { w, dir, k, kind } = params;
  const f = 2 ** k;
  const v = item.show.xValue;
  const kv = item.key.value;
  const lostOnes = item.sim.lost.filter((i) => item.show.x[i] === 1).length;
  if (dir === 'L') {
    return `Shifting left multiplies by ${f} only while the answer still fits in ${fits(w, kind)}. Here ${num(v)} × ${f} = ${num(v * f)} does not fit, so read the value from your bits instead: ${num(kv)}.`;
  }
  return `Shifting right divides by ${f} exactly only when the bits that fall off are all 0. Here ${lostOnes === 1 ? 'a 1 fell' : `${count(lostOnes, '1')} fell`} off, so read the value from your bits instead: ${num(kv)}.`;
}

export function diagnose(item, answer, marking) {
  const m = marking || mark(item, answer);
  const p = item.params;
  if (m.correct) return finish(null, 'All correct.', 'Your shifted bits match the machine.', { field: 'bits' });
  const bits = answer.bits || [];
  const firstBad = m.firstWrong?.index ?? null;
  if (!m.cells.bits.every((s) => s === 'ok')) {
    // Every bit given is right: the answer is unfinished, not a misconception.
    if (!m.cells.bits.includes('bad')) {
      if (m.cells.bits.every((s) => s === 'missing')) {
        return finish(null, "You didn't give the shifted bits.",
          `Nothing was filled in. The answer is ${binStr(item.key.bits)}.`, { field: 'bits', index: firstBad });
      }
      return finish(null, "You haven't filled in every bit.",
        `The bits you gave are right. The full answer is ${binStr(item.key.bits)}.`, { field: 'bits', index: firstBad });
    }
    const full = bits.length === p.w && bits.every((b) => b === 0 || b === 1);
    const cand = full ? candidates(p).find((c) => !sameBits(c.bits, item.key.bits) && sameBits(c.bits, bits)) : null;
    const tag = cand ? cand.tag : 'other';
    const detail = bitsDetail(tag, p, cand, item);
    return finish(tag, HEADLINES[tag], detail, { field: 'bits', index: firstBad });
  }
  // Bits right, value wrong.
  if (m.cells.value === 'missing') {
    return finish(null, "You didn't give the value.",
      `Read it from your shifted bits: ${binStr(item.key.bits)} is ${num(item.key.value)}.`, { field: 'value' });
  }
  const myth = mythValues(p).some((v) => sameValue(answer.value, v) && !sameValue(v, item.key.value));
  if (myth) return finish('shift_value_myth', 'Your bits are right, but the value is not.', valueDetail(p, item), { field: 'value' });
  // A signed pattern read as unsigned: the top bit counted as +2^(w−1).
  // (After the myth check: 64 × 2 = 128 is also the unsigned reading of 10000000.)
  const unsigned = fromBits(item.key.bits);
  if (p.kind === 'arithmetic' && answer.value === unsigned && unsigned !== item.key.value) {
    return finish('twos_msb_positive', 'Your bits are right, but you read the top bit as positive.',
      `In two's complement the top bit is worth ${num(-(2 ** (p.w - 1)))}, not +${2 ** (p.w - 1)}. So ${binStr(item.key.bits)} is ${num(item.key.value)}, not ${unsigned}.`, { field: 'value' });
  }
  return finish('other', 'Your bits are right, but the value is not.',
    `Read the value straight from your shifted bits: ${binStr(item.key.bits)} is ${num(item.key.value)}. Add up the place values of the 1s${p.kind === 'arithmetic' ? ', with the top bit counting as negative' : ''}.`, { field: 'value' });
}

// ---------------------------------------------------------------------------
// Why layers
// ---------------------------------------------------------------------------

const NOTES = {
  shift_kept_bits: ['Bits that go past the end of the register are lost, not wrapped round.', 'Wrapping round is a different operation, called a rotate.'],
  shift_direction: ['Left means towards the bigger place values, so a left shift usually makes a number bigger.', 'Right means towards the 1s column.'],
  shift_arith_logical: ['An arithmetic right shift copies the sign bit into the gap, so a negative number stays negative.', 'A logical shift always fills with 0s.'],
  shift_fill: ['A logical shift always fills the gap with 0s.', 'Only an arithmetic right shift copies the sign bit instead.'],
  shift_amount: ['Count the gap: after a shift of k places it is exactly k bits wide.', 'Every bit moves the same number of places.'],
};

function valueLayer(item) {
  const { w, dir, k, kind } = item.params;
  const f = 2 ** k;
  const v = item.show.xValue;
  const kv = valueOf(item.key.bits, kind);
  const say = [];
  if (dir === 'L') {
    const lostOnes = item.sim.lost.filter((i) => item.show.x[i] === 1).length;
    if (kv === v * f) {
      say.push(`Shifting left ${places(k)} multiplies by ${f}: ${num(v)} × ${f} = ${num(kv)}.`,
        lostOnes ? 'The 1s that fell off were copies of the sign bit, so the answer still fits.' : 'This works here because no 1s fell off the end.');
    } else {
      say.push(`Shifting left usually multiplies by ${f}, but ${num(v)} × ${f} = ${num(v * f)} does not fit in ${fits(w, kind)}.`, `The bits that are left give ${num(kv)}.`);
    }
  } else {
    const exact = v / f;
    if (Number.isInteger(exact) && exact === kv) say.push(`Shifting right ${places(k)} divides by ${f}: ${num(v)} ÷ ${f} = ${num(kv)}.`, 'This is exact because only 0s fell off the end.');
    else if (v < 0) say.push(`${num(v)} ÷ ${f} = ${fmt(exact)}, and an arithmetic shift rounds down (towards minus infinity).`, `So the result is ${num(kv)}.`);
    else say.push(`${num(v)} ÷ ${f} = ${fmt(exact)}, but the bits that fell off the end held the remainder.`, `So the shift rounds down and gives ${num(kv)}.`);
  }
  return { id: 'value', kind: 'text', title: 'What happens to the value', say, data: {} };
}

export function why(item, diagnosis) {
  const { w, dir, k, kind } = item.params;
  const s = item.sim;
  const X = item.show.x;
  const lostOnes = s.lost.filter((i) => X[i] === 1).length;
  const end = dirWord(dir);
  const fillWords = dir === 'R' && kind === 'arithmetic' ? `copies of the sign bit (${s.fill})` : `${s.fill}s`;
  const lostSay = k === 0 ? 'No bits are pushed off the end.' : lostOnes === 0
    ? `The bit${k === 1 ? '' : 's'} pushed off the ${end} end ${k === 1 ? 'is a 0' : 'are all 0s'}, so nothing is lost.`
    : `${lostOnes === 1 ? 'A 1 is' : `${cap(count(lostOnes, '1'))} are`} pushed off the ${end} end and lost for good.`;
  const layers = [{
    id: 'shift', kind: 'shift', title: 'The shift',
    say: [`Every bit moves ${places(k)} to the ${end}, and ${fillWords} fill the gap.`, lostSay],
    data: { w, before: X.slice(), after: s.bits.slice(), dir, k, fill: s.fill, lost: s.lost.slice() },
  }];
  const tag = diagnosis?.tag;
  if (NOTES[tag]) layers.push({ id: 'note', kind: 'text', title: 'The rule', say: NOTES[tag].slice(), data: {} });
  layers.push(valueLayer(item));
  return layers;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** what a learner with one misconception writes (all the ways they might) */
export function misconceptions(params, tag) {
  const { w, x, dir, k, kind } = params;
  const X = toBits(x, w);
  const key = shiftBits(X, w, dir, k, kind).bits;
  const v = valueOf(key, kind);
  const withValue = (bits, value = params.askValue ? valueOf(bits, kind) : null) => ({ bits, value });
  switch (tag) {
    case 'shift_kept_bits': return [withValue(rotate(X, w, dir, k))];
    case 'shift_direction': return [withValue(shiftBits(X, w, other(dir), k, kind).bits)];
    case 'shift_amount': return [k + 1, k - 1].filter((j) => j >= 1 && j < w).map((j) => withValue(shiftBits(X, w, dir, j, kind).bits));
    case 'shift_fill': return [withValue(wrongFill(X, w, dir, k, kind))];
    case 'shift_arith_logical': return [withValue(shiftBits(X, w, dir, k, kind === 'arithmetic' ? 'logical' : 'arithmetic').bits)];
    // A whole-number myth value first: it is the one a learner is most likely to write.
    case 'shift_value_myth': return mythValues(params).filter((m) => m !== v)
      .sort((p, q) => Number.isInteger(q) - Number.isInteger(p)).slice(0, 1).map((m) => ({ bits: key.slice(), value: m }));
    default: return [];
  }
}

function exercises(params, tag) {
  const item = build(params);
  const answers = misconceptions(params, tag);
  return answers.length > 0 && answers.every((ans) => {
    const m = mark(item, ans);
    return !m.correct && diagnose(item, ans, m).diagnosis.tag === tag;
  });
}

// Patterns that look like exam questions: a mix of 1s and 0s, never 0 or all 1s.
function pattern(rng, w) {
  for (;;) {
    const x = randInt(rng, 1, 2 ** w - 2);
    const n = popcount(toBits(x, w));
    if (n >= 2 && n <= w - 2) return x;
  }
}

export function generate(rng, opts = {}) {
  const w = clampW(opts.w ?? opts.width, 4, 16, 8);
  const target = TARGETS.includes(opts.target) ? opts.target : null;
  const level = opts.level || null;
  const avoid = opts.avoid || null;
  let fallback = null;
  let mythFallback = null;
  for (let tries = 0; tries < 600; tries++) {
    let kind = opts.kind === 'mixed' ? pick(rng, KINDS) : KINDS.includes(opts.kind) ? opts.kind : 'logical';
    let dir = DIRS.includes(opts.dir) ? opts.dir : pick(rng, DIRS);
    if (target === 'shift_arith_logical') {
      dir = 'R';
      if (level === 'gcse' || (!level && kind === 'logical')) kind = 'arithmetic';
    }
    const k = randInt(rng, 1, Math.min(3, w - 2));
    let x = pattern(rng, w);
    // Arithmetic right shifts are only interesting on negative numbers half the time.
    if (target === 'shift_arith_logical' || (kind === 'arithmetic' && dir === 'R' && chance(rng, 0.6))) x |= 2 ** (w - 1);
    // Setting the sign bit can leave almost all 1s, which shifts to a dull all-1s answer.
    if (popcount(toBits(x, w)) > w - 2) continue;
    const askValue = target === 'shift_value_myth' ? true : typeof opts.askValue === 'boolean' ? opts.askValue : chance(rng, 0.5);
    const params = withLevel({ w, x, dir, k, kind, askValue }, level);
    if (avoid && avoid.x === x && avoid.dir === dir && avoid.k === k) continue;
    fallback = fallback || params;
    if (target && !exercises(params, target)) continue;
    // Prefer a whole-number myth answer (left shifts, or arithmetic right shifts of
    // negatives): the learner can then show the myth without writing a decimal.
    if (target === 'shift_value_myth' && tries < 300 && !Number.isInteger(misconceptions(params, target)[0].value)) {
      mythFallback = mythFallback || params;
      continue;
    }
    return params;
  }
  return mythFallback || fallback;
}

export function variant(item, tagId, rng) {
  const p = item.params;
  const opts = { level: p.level, w: p.w, kind: p.kind, askValue: tagId === 'shift_value_myth' ? true : p.askValue, target: tagId, avoid: p };
  // A misconception about right-shift fills needs a right shift of a negative.
  if (tagId === 'shift_arith_logical' && p.kind === 'logical' && levelOf(p) === 'gcse') opts.kind = 'arithmetic';
  return generate(rng, opts);
}

export function encodeParams(p) {
  return [p.w, p.x, DIRS.indexOf(p.dir), p.k, KINDS.indexOf(p.kind), p.askValue ? 1 : 0, levelCode(p.level)];
}

export function decodeParams(ints) {
  const [w0, x, dir, k, kind, askValue, lv] = ints;
  const w = clampW(w0, 4, 16, 8);   // untrusted links: keep every number in range
  return withLevel({ w, x: clampW(x, 0, 2 ** w - 1, 1), dir: DIRS[dir] || 'L', k: clampW(k, 1, w, 1), kind: KINDS[kind] || 'logical', askValue: !!askValue }, levelFrom(lv));
}
