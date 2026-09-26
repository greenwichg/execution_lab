// Full adder (A-level 1.4.3): trace a, b and carry-in through the gates.
// The key comes from the gate equations (x1 = a⊕b, a1 = a·b, a2 = x1·cin,
// sum = x1⊕cin, cout = a1 + a2) and is cross-checked against the adder in
// engine/bits.js, so the circuit and the column arithmetic always agree.
import { addBits } from '../../engine/bits.js';
import { pick, chance } from '../../lib/rng.js';
import { withLevel, levelCode, levelFrom, adderWires, columnLayer, classifyColumn, colRule } from './add.js';

export const TYPE = 'fa';
export const TYPE_ID = 4;
export const TARGETS = ['add_or', 'add_three_ones'];

const WIRES = [
  { id: 'x1', label: 'x1 = a XOR b' },
  { id: 'a1', label: 'a1 = a AND b' },
  { id: 'a2', label: 'a2 = x1 AND carry-in' },
];
const OUTS = [
  { id: 'sum', label: 'sum = x1 XOR carry-in' },
  { id: 'cout', label: 'carry out = a1 OR a2' },
];

function circuit({ a, b, cin }) {
  const d = adderWires(a, b, cin);
  const r = addBits([a], [b], 1, cin);
  // The gate model and the ripple adder must agree; if not, the key is wrong.
  if (r.result[0] !== d.sum || r.cout !== d.cout) throw new Error('full adder model disagrees with addBits');
  return d;
}

export function build(params) {
  const { a, b, cin } = params;
  const wires = !!params.wires;
  const d = circuit(params);
  // Without the wires, the output labels must not name wires the learner never sees.
  const outs = wires ? OUTS : [{ id: 'sum', label: 'sum' }, { id: 'cout', label: 'carry out' }];
  const fields = [...(wires ? WIRES : []), ...outs].map((f) => ({ id: f.id, kind: 'bit', label: f.label }));
  const key = { sum: d.sum, cout: d.cout };
  if (wires) Object.assign(key, { x1: d.x1, a1: d.a1, a2: d.a2 });
  return {
    type: TYPE,
    params,
    level: params.level || 'alevel',
    spec: 'H446-1.4.3-adders',
    prompt: wires
      ? `A full adder has inputs a = ${a}, b = ${b} and carry-in = ${cin}. Give the value on every wire, then the sum and carry out.`
      : `A full adder has inputs a = ${a}, b = ${b} and carry-in = ${cin}. What are the sum and carry out?`,
    show: { a, b, cin, wires },
    fields,
    key,
    family: 'add',
    sim: d,
  };
}

export function blank(item) {
  const ans = { sum: null, cout: null };
  if (item.params.wires) Object.assign(ans, { x1: null, a1: null, a2: null });
  return ans;
}

const st = (got, want) => (got === null || got === undefined ? 'missing' : got === want ? 'ok' : 'bad');

export function mark(item, answer) {
  const cells = {};
  let firstWrong = null;
  let right = 0;
  // Working order follows the signal through the circuit: wires, then outputs.
  for (const f of item.fields) {
    cells[f.id] = st(answer[f.id], item.key[f.id]);
    if (cells[f.id] === 'ok') right++;
    else if (!firstWrong) firstWrong = { field: f.id, index: null };
  }
  return { correct: right === item.fields.length, cells, firstWrong, score: { right, total: item.fields.length } };
}

function finish(tag, headline, detail, focus) {
  return { next: null, diagnosis: { tag, headline, detail, focus } };
}

const FORMULA = {
  x1: (d) => `x1 = a XOR b = ${d.a} XOR ${d.b} = ${d.x1}`,
  a1: (d) => `a1 = a AND b = ${d.a} AND ${d.b} = ${d.a1}`,
  a2: (d) => `a2 = x1 AND carry-in = ${d.x1} AND ${d.cin} = ${d.a2}`,
  sum: (d) => `sum = x1 XOR carry-in = ${d.x1} XOR ${d.cin} = ${d.sum}`,
  cout: (d) => `carry out = a1 OR a2 = ${d.a1} OR ${d.a2} = ${d.cout}`,
};

const NAMES = { x1: 'x1', a1: 'a1', a2: 'a2', sum: 'sum', cout: 'carry out' };

/** sum and carry out given as plain addition (no wires asked, or every wire right) */
function outputsDiagnosis(item, answer) {
  const d = item.sim;
  const { a, b, cin } = d;
  const n = a + b + cin;
  const focus = { field: answer.sum === d.sum ? 'cout' : 'sum', column: 0 };
  // Same column rules as binary addition, so the same answer gets the same tag.
  const tag = classifyColumn(a, b, cin, answer.sum, answer.cout);
  if (tag === 'add_three_ones') {
    return finish(tag, 'You wrote 0 carry 1 for 1 + 1 + 1.',
      'All three inputs are 1, and 1 + 1 + 1 = 3, which is 11 in binary. So sum = 1 and carry out = 1.', { field: 'sum', column: 0 });
  }
  if (tag === 'add_or') {
    return finish(tag, 'You added 1 + 1 and got 1.',
      'a and b are both 1, and 1 + 1 = 2, which is 10 in binary. So sum = 0 and carry out = 1, not sum 1 with no carry.', { field: 'sum', column: 0 });
  }
  if (tag === 'add_no_carry') {
    const [s0] = colRule(a, b, 0);
    if (cin === 1 && answer.sum === s0) {
      return finish(tag, 'You left out the carry-in.',
        `The carry-in is an input too, so add all three: ${a} + ${b} + ${cin} = ${n}${n >= 2 ? `, which is ${n.toString(2)} in binary` : ''}. So sum = ${d.sum} and carry out = ${d.cout}.`, focus);
    }
    return finish(tag, 'Your sum is right, but you lost the carry.',
      `${a} + ${b} + ${cin} = ${n}, which is ${n.toString(2)} in binary. So carry out = 1, not 0.`, { field: 'cout', column: 0 });
  }
  return null;
}

export function diagnose(item, answer, marking) {
  const m = marking || mark(item, answer);
  const d = item.sim;
  if (m.correct) return finish(null, 'All correct.', 'Every wire matches the circuit.', { field: 'sum' });
  const n = d.a + d.b + d.cin;
  const f = m.firstWrong.field;
  const focus = { field: f, column: 0 };
  // Working order follows the signal: stop at the first wire that differs.
  if (m.cells[f] === 'missing') {
    return finish(null, `You didn't give ${f === 'cout' ? 'the carry out' : `the value of ${NAMES[f]}`}.`,
      item.params.wires ? `Follow the gates in order: ${FORMULA[f](d)}.` : plainRule(d), focus);
  }
  // An XOR gate with two 1s worked out as OR: the gate-level form of "1 + 1 = 1".
  if (item.params.wires && f === 'x1' && d.a === 1 && d.b === 1 && answer.x1 === 1) {
    return finish('add_or', 'You treated the XOR gate as OR.',
      'x1 is an XOR gate, so it gives 1 only when exactly one input is 1. With a = 1 and b = 1 it gives 0, because 1 + 1 = 10 in binary puts the 1 in the carry.', { field: 'x1', column: 0 });
  }
  if (item.params.wires && f === 'sum' && d.x1 === 1 && d.cin === 1 && answer.sum === 1) {
    return finish('add_or', 'You treated the sum XOR gate as OR.',
      'sum = x1 XOR carry-in, and XOR gives 1 only when exactly one input is 1. Here x1 = 1 and carry-in = 1, so sum = 0.', { field: 'sum', column: 0 });
  }
  if (f === 'sum' || f === 'cout') {
    // With every wire right, "1 + 1 = 1" is contradicted by the learner's own
    // x1 = 0; only the very specific 0-carry-1 for three 1s still stands.
    const r = outputsDiagnosis(item, answer);
    if (r && (!item.params.wires || r.diagnosis.tag === 'add_three_ones')) return r;
  }
  return finish('other', `Your ${NAMES[f]} is not right.`,
    item.params.wires
      ? `Follow the gates in order: ${FORMULA[f](d)}. The inputs add up to ${n}${n >= 2 ? `, which is ${n.toString(2)} in binary` : ''}.`
      : plainRule(d), focus);
}

/** no wires asked: explain with plain addition, never with a wire the learner has not seen */
function plainRule(d) {
  const n = d.a + d.b + d.cin;
  return `Add all three inputs: a + b + carry-in = ${d.a} + ${d.b} + ${d.cin} = ${n}${n >= 2 ? `, which is ${n.toString(2)} in binary` : ''}. So sum = ${d.sum} and carry out = ${d.cout}.`;
}

export function why(item, diagnosis, { level } = {}) {
  const lv = level || item.level || 'alevel';
  const d = item.sim;
  const n = d.a + d.b + d.cin;
  const col = columnLayer(0, d.a, d.b, d.cin, 'this column');
  col.say = n >= 2
    ? [`a + b + carry-in = ${d.a} + ${d.b} + ${d.cin} = ${n}, which is ${n.toString(2)} in binary.`, `So sum = ${d.sum} and carry out = ${d.cout}.`]
    : [`a + b + carry-in = ${d.a} + ${d.b} + ${d.cin} = ${n}.`, `So sum = ${d.sum} and carry out = 0.`];
  const layers = [col];
  if (lv !== 'gcse') {
    layers.push({
      id: 'adder', kind: 'adder', title: 'Through the gates',
      say: [`${FORMULA.x1(d)}, then ${FORMULA.sum(d)}.`, `For the carry, ${FORMULA.a1(d)} and ${FORMULA.a2(d)}, so ${FORMULA.cout(d)}.`],
      data: { ...d },
    });
  }
  return layers;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const COMBOS = [[0, 0, 1], [0, 1, 0], [1, 0, 0], [0, 1, 1], [1, 0, 1], [1, 1, 0], [1, 1, 1]];

/** what a learner with one misconception writes */
export function misconceptions(params, tag) {
  const { a, b, cin } = params;
  const d = adderWires(a, b, cin);
  const ans = { sum: d.sum, cout: d.cout };
  if (params.wires) Object.assign(ans, { x1: d.x1, a1: d.a1, a2: d.a2 });
  if (tag === 'add_or') {
    if (params.wires) {
      // Reads every XOR gate as OR; the AND and OR gates are right.
      ans.x1 = a | b;
      ans.a2 = ans.x1 & cin;
      ans.sum = ans.x1 | cin;
      ans.cout = ans.a1 | ans.a2;
    } else {
      ans.sum = a | b | cin;
      ans.cout = 0;
    }
  } else if (tag === 'add_three_ones') {
    if (a + b + cin === 3) [ans.sum, ans.cout] = [0, 1];
  } else return [];
  return [ans];
}

function exercises(params, tag) {
  const item = build(params);
  return misconceptions(params, tag).every((ans) => {
    const m = mark(item, ans);
    return !m.correct && diagnose(item, ans, m).diagnosis.tag === tag;
  });
}

export function generate(rng, opts = {}) {
  const target = TARGETS.includes(opts.target) ? opts.target : null;
  const avoid = opts.avoid || null;
  const wires = typeof opts.wires === 'boolean' ? opts.wires : chance(rng, 0.6);
  // Only 7 input patterns exist (0 0 0 is too trivial to ask), so filter them.
  let pool = COMBOS.map(([a, b, cin]) => withLevel({ a, b, cin, wires }, opts.level));
  if (target) pool = pool.filter((p) => exercises(p, target));
  const fresh = avoid ? pool.filter((p) => p.a !== avoid.a || p.b !== avoid.b || p.cin !== avoid.cin || p.wires !== avoid.wires) : pool;
  if (fresh.length) return pick(rng, fresh);
  // 1 + 1 + 1 has one pattern only; flip the wires question to keep it fresh.
  if (pool.length) return { ...pick(rng, pool), wires: !wires };
  return pick(rng, COMBOS.map(([a, b, cin]) => withLevel({ a, b, cin, wires }, opts.level)));
}

export function variant(item, tagId, rng) {
  const p = item.params;
  return generate(rng, { level: p.level, target: tagId, avoid: p });
}

export function encodeParams(p) {
  return [p.a, p.b, p.cin, p.wires ? 1 : 0, levelCode(p.level)];
}

export function decodeParams(ints) {
  const [a, b, cin, wires, lv] = ints;
  return withLevel({ a: a ? 1 : 0, b: b ? 1 : 0, cin: cin ? 1 : 0, wires: !!wires }, levelFrom(lv));
}

