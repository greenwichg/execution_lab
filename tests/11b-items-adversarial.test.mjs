// Adversarial checks on the binary practice items, written from two chairs:
//   · a GCSE/A-level teacher: is every answer key right, would I agree with
//     each misconception tag on the answers it fires on, is every sentence
//     true, short and in exam wording?
//   · a computing-education researcher: are tags free of false positives
//     (random, empty or half-finished answers), are "Not sure" replies never
//     read as evidence, do targeted items really exercise their misconception?
// Every reference here is written independently of the modules under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as bits from '../machine/src/engine/bits.js';
import * as add from '../machine/src/learn/items/add.js';
import * as shift from '../machine/src/learn/items/shift.js';
import * as twos from '../machine/src/learn/items/twos.js';
import * as sadd from '../machine/src/learn/items/sadd.js';
import * as fa from '../machine/src/learn/items/fa.js';
import { BINARY_TAGS } from '../machine/src/learn/tags.js';
import { mulberry32, pick } from '../machine/src/lib/rng.js';

const MODS = { add, shift, twos, sadd, fa };
const LEVELS = ['gcse', 'alevel', 'csapp'];

// ---------------------------------------------------------------------------
// Independent reference arithmetic (plain integers, no bit arrays)
// ---------------------------------------------------------------------------

const wrapU = (v, w) => ((v % 2 ** w) + 2 ** w) % 2 ** w;
const wrapS = (v, w) => { const u = wrapU(v, w); return u >= 2 ** (w - 1) ? u - 2 ** w : u; };
const bitsOf = (v, w) => Array.from({ length: w }, (_, i) => Math.floor(wrapU(v, w) / 2 ** i) % 2);
const valOf = (bs) => bs.reduce((s, b, i) => s + b * 2 ** i, 0);
const neg = (u, w) => u >= 2 ** (w - 1);

/** x86 flags for a + b + cin and a − b, from the textbook definitions */
function refAdd(ua, ub, w, cin = 0) {
  const t = ua + ub + cin;
  const r = t % 2 ** w;
  return { r, CF: t >= 2 ** w ? 1 : 0, ZF: r === 0 ? 1 : 0, SF: neg(r, w) ? 1 : 0,
    // cin = 0: same-sign inputs with a different-sign result (the exam rule)
    OF: cin === 0 ? (neg(ua, w) === neg(ub, w) && neg(r, w) !== neg(ua, w) ? 1 : 0)
      : (wrapS(ua, w) + wrapS(ub, w) + cin > 2 ** (w - 1) - 1 || wrapS(ua, w) + wrapS(ub, w) + cin < -(2 ** (w - 1)) ? 1 : 0) };
}
function refSub(ua, ub, w) {
  const r = wrapU(ua - ub, w);
  return { r, CF: ua < ub ? 1 : 0, ZF: r === 0 ? 1 : 0, SF: neg(r, w) ? 1 : 0,
    OF: neg(ua, w) !== neg(ub, w) && neg(r, w) !== neg(ua, w) ? 1 : 0 };
}

/** sentences: terminal punctuation followed by a space or the end */
const sentences = (s) => (String(s).trim().match(/[.!?](?=\s|$)/g) || []).length || 1;

function runFlow(mod, item, answer, reply = () => null) {
  const cps = [];
  for (let n = 0; n <= 3; n++) {
    const r = mod.diagnose(item, answer, mod.mark(item, answer), cps);
    if (!r.next) return { ...r.diagnosis, steps: n };
    assert.ok(n < 3, 'more than 3 checkpoints');
    cps.push(reply(r.next));
  }
  throw new Error('flow did not finish');
}

// ---------------------------------------------------------------------------
// 1. bits.js against the reference
// ---------------------------------------------------------------------------

test('bits.js: every 4-bit and 8-bit add (both carry-ins) and sub matches the textbook flags', () => {
  for (const w of [4, 8]) {
    for (let a = 0; a < 2 ** w; a++) {
      for (let b = 0; b < 2 ** w; b++) {
        for (const cin of [0, 1]) {
          const got = bits.addBits(a, b, w, cin);
          const want = refAdd(a, b, w, cin);
          assert.equal(got.value, want.r);
          assert.deepEqual(got.result, bitsOf(want.r, w));
          assert.deepEqual([got.CF, got.ZF, got.SF, got.OF], [want.CF, want.ZF, want.SF, want.OF], `add ${w} ${a}+${b}+${cin}`);
          // carries[i] is the carry INTO column i, recomputed column by column
          let c = cin;
          for (let i = 0; i < w; i++) {
            assert.equal(got.carries[i], c);
            c = (Math.floor(a / 2 ** i) % 2) + (Math.floor(b / 2 ** i) % 2) + c >= 2 ? 1 : 0;
          }
          assert.equal(got.carries[w], c);
        }
        const s = bits.subBits(a, b, w);
        const ws = refSub(a, b, w);
        assert.deepEqual([s.value, s.CF, s.ZF, s.SF, s.OF], [ws.r, ws.CF, ws.ZF, ws.SF, ws.OF], `sub ${w} ${a}-${b}`);
        assert.deepEqual(s.binv, bitsOf(~b, w));
        assert.equal(s.carries[0], 1);
      }
    }
  }
});

test('bits.js: 16-bit sample and signed operands agree with the reference', () => {
  const rng = mulberry32(1616);
  for (let n = 0; n < 20000; n++) {
    const a = Math.floor(rng() * 65536);
    const b = Math.floor(rng() * 65536);
    const r = bits.addBits(wrapS(a, 16), wrapS(b, 16), 16);    // negatives in, two's complement out
    const want = refAdd(a, b, 16);
    assert.deepEqual([r.value, r.CF, r.OF, r.SF, r.ZF], [want.r, want.CF, want.OF, want.SF, want.ZF]);
    const s = bits.subBits(wrapS(a, 16), b, 16);
    const ws = refSub(a, b, 16);
    assert.deepEqual([s.value, s.CF, s.OF], [ws.r, ws.CF, ws.OF]);
  }
});

test("bits.js: two's complement edge cases", () => {
  const cases = [[-128, 8, 128, -128], [127, 8, 127, 127], [0, 8, 0, 0], [-1, 8, 255, -1], [128, 8, 128, -128],
    [-129, 8, 127, 127], [256, 8, 0, 0], [255, 8, 255, -1], [-8, 4, 8, -8], [7, 4, 7, 7], [-32768, 16, 32768, -32768]];
  for (const [v, w, u, s] of cases) {
    assert.equal(bits.toUnsigned(v, w), u, `toUnsigned(${v}, ${w})`);
    assert.equal(bits.toSigned(v, w), s, `toSigned(${v}, ${w})`);
    assert.deepEqual(bits.toBits(v, w), bitsOf(u, w));
    assert.equal(bits.fromBits(bits.toBits(v, w), { signed: true }), s);
    assert.equal(bits.fromBits(bits.toBits(v, w)), u);
  }
  assert.deepEqual(bits.toBits(-128, 8), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(bits.toBits(-1, 8), [1, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(bits.fromBits([], { signed: true }), 0);
  for (let w = 1; w <= 16; w++) {
    assert.deepEqual(bits.range(w, true), { min: -(2 ** (w - 1)), max: 2 ** (w - 1) - 1 });
    assert.deepEqual(bits.range(w, false), { min: 0, max: 2 ** w - 1 });
  }
  // the classic overflow pairs
  assert.equal(bits.addBits(127, 1, 8).OF, 1);
  assert.equal(bits.addBits(-128, -1, 8).OF, 1);
  assert.equal(bits.subBits(-128, 1, 8).OF, 1);
  assert.equal(bits.subBits(0, -128, 8).OF, 1, '0 − (−128) = 128 does not fit');
  assert.equal(bits.subBits(-1, -128, 8).OF, 0, '−1 − (−128) = 127 fits');
  assert.equal(bits.addBits(-1, 1, 8).CF, 1);
  assert.equal(bits.addBits(-1, 1, 8).OF, 0);
});

test('bits.js: shifts by 0, by 1..w−1 and by ≥ w for every 4-bit and 8-bit pattern', () => {
  for (const w of [4, 8]) {
    for (let x = 0; x < 2 ** w; x++) {
      const sx = wrapS(x, w);
      for (let k = 0; k <= w + 2; k++) {
        const L = bits.shiftBits(x, w, 'L', k, 'logical');
        const R = bits.shiftBits(x, w, 'R', k, 'logical');
        const A = bits.shiftBits(x, w, 'R', k, 'arithmetic');
        assert.equal(valOf(L.bits), wrapU(x * 2 ** k, w), `shl ${x} ${k}`);
        assert.equal(valOf(R.bits), Math.floor(x / 2 ** k), `shr ${x} ${k}`);
        assert.equal(valOf(A.bits), wrapU(Math.floor(sx / 2 ** k), w), `sar ${x} ${k}`);
        assert.deepEqual(bits.shiftBits(x, w, 'L', k, 'arithmetic').bits, L.bits, 'arithmetic left = logical left');
        const lostL = Array.from({ length: Math.min(k, w) }, (_, j) => w - Math.min(k, w) + j);
        const lostR = Array.from({ length: Math.min(k, w) }, (_, j) => j);
        assert.deepEqual(L.lost, lostL);
        assert.deepEqual(R.lost, lostR);
        assert.equal(A.fill, k >= 0 && neg(x, w) ? 1 : 0);
        assert.equal(R.fill, 0);
        if (k === 0) assert.deepEqual(L.bits, bitsOf(x, w), 'a shift by 0 changes nothing');
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Diagnosis honesty: false positives
// ---------------------------------------------------------------------------

test('classifyColumn: every tag only fires on the column it describes', () => {
  for (const a of [0, 1]) for (const b of [0, 1]) for (const c of [0, 1]) {
    for (const r of [0, 1, null]) for (const co of [0, 1, null]) {
      const n = a + b + c;
      if (r === (n & 1) && (co ?? 0) === n >> 1) continue;   // a right column is never classified
      const tag = add.classifyColumn(a, b, c, r, co);
      if (tag === 'add_or') assert.ok(n === 2 && c === 0 && r === 1 && !co, `add_or on ${a}+${b}+${c} → ${r},${co}`);
      if (tag === 'add_three_ones') assert.ok(n === 3 && r === 0 && co === 1);
      if (tag === 'add_no_carry') assert.ok(n >= 1 && (c === 1 || n >= 2), `no_carry on ${a}+${b}+${c}`);
      if (r === null) assert.equal(tag, 'other', 'an empty sum bit is never a named misconception');
    }
  }
});

test('add: right result bits with an empty carry row is not "dropped a carry"', () => {
  for (const w of [4, 6]) {
    for (let a = 1; a < 2 ** w; a++) for (let b = 1; b < 2 ** w; b++) {
      const item = add.build({ w, a, b, ask: 'full' });
      const ans = { carries: new Array(w + 1).fill(null), result: item.key.result.slice(), overflow: item.key.overflow };
      const m = add.mark(item, ans);
      if (m.correct) continue;
      const d = add.diagnose(item, ans, m).diagnosis;
      assert.equal(d.tag, 'other', `${a}+${b}: ${d.tag} — ${d.detail}`);
      assert.match(d.headline, /didn't write the carry/);
    }
  }
});

test('add: a missing carry out of the top column is judged by the overflow answer', () => {
  const item = add.build({ w: 8, a: 200, b: 57, ask: 'full' });
  const ans = { carries: item.key.carries.slice(), result: item.key.result.slice(), overflow: 'no' };
  ans.carries[8] = null;
  assert.equal(add.diagnose(item, ans).diagnosis.tag, 'add_overflow_missed');
  ans.overflow = 'yes';
  const d = add.diagnose(item, ans).diagnosis;
  assert.equal(d.tag, 'other');
  assert.doesNotMatch(d.detail, /next column to the left/, 'the top column has no column to its left');
});

test('every type: blank and half-finished answers get tag null, no checkpoints and a helpful line', () => {
  const rng = mulberry32(404);
  for (const [type, mod] of Object.entries(MODS)) {
    for (let n = 0; n < 200; n++) {
      const item = mod.build(mod.generate(rng, { level: pick(rng, LEVELS), ask: pick(rng, ['full', 'result']), kind: 'mixed' }));
      // blank
      const blank = mod.blank(item);
      const r0 = mod.diagnose(item, blank, mod.mark(item, blank), []);
      assert.equal(r0.next, null, `${type}: no checkpoints for a blank answer`);
      assert.equal(r0.diagnosis.tag, null, `${type} blank: ${JSON.stringify(r0.diagnosis)}`);
      assert.notEqual(r0.diagnosis.headline, 'All correct.');
      assert.ok(r0.diagnosis.detail.length > 10);
      // the key with its last cell (in working order) emptied
      const partial = structuredClone(item.key);
      if (type === 'add') partial.overflow = null;
      else if (type === 'shift') { partial.bits[0] = null; }
      else if (type === 'twos') { for (const k of Object.keys(partial)) { if (Array.isArray(partial[k])) partial[k][0] = null; else if (k === 'max' || k === 'value') partial[k] = null; } }
      else if (type === 'sadd') partial.flags[item.show.askFlags.at(-1)] = null;
      else if (type === 'fa') partial.cout = null;
      const m = mod.mark(item, partial);
      assert.equal(m.correct, false);
      const d = runFlow(mod, item, partial);
      assert.equal(d.tag, null, `${type} partial: ${JSON.stringify(d)}`);
      assert.equal(d.steps, 0);
      assert.notEqual(d.headline, 'All correct.');
    }
  }
});

test('add: a missing overflow answer is never reported as "All correct."', () => {
  for (const [a, b] of [[3, 4], [200, 100]]) {
    for (const ask of ['full', 'result']) {
      const item = add.build({ w: 8, a, b, ask });
      const d = add.diagnose(item, { ...structuredClone(item.key), overflow: null }).diagnosis;
      assert.equal(d.tag, null);
      assert.match(d.headline, /overflow/);
    }
  }
});

test('add: carry-in-column rules — add_or never blamed on a column that had a carry in', () => {
  const rng = mulberry32(77);
  for (let n = 0; n < 4000; n++) {
    const item = add.build(add.generate(rng, { w: pick(rng, [4, 8]), ask: 'full' }));
    const w = item.params.w;
    const ans = { carries: [null, ...Array.from({ length: w }, () => (rng() < 0.5 ? 1 : 0))], result: [...Array.from({ length: w }, () => (rng() < 0.5 ? 1 : 0)), null], overflow: pick(rng, ['yes', 'no']) };
    const d = add.diagnose(item, ans).diagnosis;
    const col = d.focus.column;
    if (d.tag === 'add_or') assert.equal(item.sim.carries[col], 0, 'add_or on a column with a carry-in');
    if (d.tag === 'add_three_ones') assert.equal(item.show.a[col] + item.show.b[col] + item.sim.carries[col], 3);
  }
});

test('add: "carry in the wrong column" needs the misplaced carry to be the first slip, and points at the column that made it', () => {
  const rng = mulberry32(12);
  let fired = 0;
  for (let n = 0; n < 20000; n++) {
    const item = add.build(add.generate(rng, { w: 8, ask: 'full' }));
    const ans = { carries: [null, ...Array.from({ length: 8 }, () => (rng() < 0.5 ? 1 : 0))], result: [...Array.from({ length: 8 }, () => (rng() < 0.5 ? 1 : 0)), null], overflow: 'no' };
    const m = add.mark(item, ans);
    const d = add.diagnose(item, ans, m).diagnosis;
    if (d.tag !== 'add_carry_wrong_col') continue;
    fired++;
    assert.equal(m.firstWrong.field, 'carries');
  }
  assert.ok(fired / 20000 < 0.005, `wrong-column tag on random grids: ${fired}/20000`);
  // a real shifted carry row: focus is the column that produced the lowest carry
  for (let n = 0; n < 300; n++) {
    const item = add.build(add.generate(rng, { w: 8, ask: 'full', target: 'add_carry_wrong_col' }));
    const k = item.key.carries;
    for (const ans of [
      { carries: [null, ...k.slice(2), 0], result: item.key.result.slice(), overflow: item.key.overflow },
      { carries: [null, 0, ...k.slice(1, 8)], result: item.key.result.slice(), overflow: item.key.overflow },
    ]) {
      const m = add.mark(item, ans);
      if (m.correct) continue;
      const d = add.diagnose(item, ans, m).diagnosis;
      if (d.tag !== 'add_carry_wrong_col') continue;
      const c = d.focus.column;
      assert.equal(add.colRule(item.show.a[c], item.show.b[c], item.sim.carries[c])[1], 1, 'focus column makes a carry');
      assert.ok(item.sim.carries.slice(1, c + 1).every((x) => x === 0), 'and it is the lowest carry');
      const layers = add.why(item, d, { level: 'gcse' });
      assert.equal(layers[0].data.highlight, c);
      assert.equal(layers[1].data.k, c);
    }
  }
});

test('add: mixed misconceptions are tagged by the first error in working order', () => {
  // 0b0011 + 0b0001: the 1s column is 1 + 1 (OR learner writes 1); give a
  // later three-ones slip too — the OR mistake comes first.
  const item = add.build({ w: 8, a: 0b01110011, b: 0b01100001, ask: 'full' });
  const ans = structuredClone(item.key);
  ans.result[0] = 1; ans.carries[1] = 0;                       // 1 + 1 → 1, no carry
  const col = [...Array(8).keys()].find((i) => i > 1 && item.show.a[i] + item.show.b[i] + item.sim.carries[i] === 3);
  ans.result[col] = 0;                                        // 1 + 1 + 1 → 0 carry 1
  const d = add.diagnose(item, ans).diagnosis;
  assert.equal(d.tag, 'add_or');
  assert.equal(d.focus.column, 0);
  // shifted carry row after a result slip in an earlier column: the slip is first
  const it2 = add.build({ w: 8, a: 0b00001100, b: 0b00000100, ask: 'full' });
  const a2 = structuredClone(it2.key);
  a2.result[0] = 1;
  a2.carries = [null, ...it2.key.carries.slice(2), 0];
  const d2 = add.diagnose(it2, a2).diagnosis;
  assert.notEqual(d2.tag, 'add_carry_wrong_col');
  assert.equal(d2.focus.column, 0);
});

test('checkpoints: "Not sure" never produces a named misconception, and flows end within 3 questions', () => {
  const rng = mulberry32(31);
  for (let n = 0; n < 1500; n++) {
    const type = pick(rng, ['add', 'sadd']);
    const mod = MODS[type];
    const item = mod.build(mod.generate(rng, { ask: 'result', level: pick(rng, LEVELS), w: 8 }));
    const w = item.params.w;
    const noise = Array.from({ length: w }, () => (rng() < 0.5 ? 1 : 0));
    const ans = type === 'add' ? { carries: new Array(w + 1).fill(null), result: [...noise, null], overflow: 'no' } : { bits: noise, flags: { ...item.key.flags } };
    const r = mod.diagnose(item, ans, mod.mark(item, ans), []);
    if (!r.next || r.next.id !== 'carry-in') continue;
    const d = runFlow(mod, item, ans, () => null);
    assert.ok(!/^add_/.test(d.tag), `"Not sure" tagged ${d.tag}`);
    assert.ok(d.steps <= 3);
  }
});

test('sadd: a learner who subtracts by adding −b (the A-level method) is not told they dropped a carry', () => {
  // Their carries differ from the ALU's a + ~b + 1 wherever b ends in 0s. They
  // answer the carry question from their own working and the column rule
  // correctly; the wrong bit was a slip, so no carry tag is fair.
  const rng = mulberry32(2024);
  let asked = 0;
  for (let n = 0; n < 3000; n++) {
    const p = sadd.generate(rng, { w: 8, level: 'alevel', op: '-' });
    const item = sadd.build(p);
    const paper = bits.addBits(p.a, -p.b, 8);
    const i = pick(rng, [1, 2, 3, 4, 5, 6, 7]);
    const ans = { bits: item.key.bits.slice(), flags: { ...item.key.flags } };
    ans.bits[i] = 1 - ans.bits[i];
    const reply = (cp) => (cp.id === 'carry-in' ? paper.carries[cp.column] : add.colRule(cp.a, cp.b, cp.c));
    if (paper.carries[i] !== item.sim.carries[i]) asked++;
    const d = runFlow(sadd, item, ans, reply);
    assert.equal(d.tag, 'other', `${p.a} − ${p.b}, bit ${i}: ${d.tag}`);
  }
  assert.ok(asked > 100, `the two methods' carries should often differ (${asked})`);
});

test('shift: arithmetic/logical confusion is preferred over "rotated" when both fit, and wrong amounts stay near k', () => {
  for (let x = 128; x < 256; x++) {
    for (let k = 1; k <= 3; k++) {
      const item = shift.build({ w: 8, x, dir: 'R', k, kind: 'arithmetic', askValue: false });
      const logical = bits.shiftBits(x, 8, 'R', k, 'logical').bits;
      const d = shift.diagnose(item, { bits: logical, value: null }).diagnosis;
      assert.equal(d.tag, 'shift_arith_logical', `sar ${x} ${k}`);
    }
  }
  const rng = mulberry32(3);
  for (let n = 0; n < 3000; n++) {
    const p = shift.generate(rng, { w: 8, kind: 'mixed', level: 'alevel' });
    const item = shift.build(p);
    const ans = { bits: bitsOf(Math.floor(rng() * 256), 8), value: null };
    const d = shift.diagnose(item, ans).diagnosis;
    if (d.tag === 'shift_amount') {
      const k2 = Number(d.detail.match(/shift of (\d+)/)[1]);
      assert.ok(Math.abs(k2 - p.k) <= 2 && k2 !== p.k);
    }
    if (d.tag === 'shift_kept_bits') {
      const lost = item.sim.lost.map((j) => item.show.x[j]);
      assert.ok(!lost.every((b) => b === item.sim.fill), 'a rotate must differ from the right answer');
    }
  }
});

test('shift: reading an arithmetic result as unsigned is a two\'s complement slip; the ×2 myth still wins ties', () => {
  const item = shift.build({ w: 8, x: 0b11110010, dir: 'L', k: 1, kind: 'arithmetic', askValue: true });
  const unsigned = valOf(item.key.bits);
  assert.equal(shift.diagnose(item, { bits: item.key.bits.slice(), value: unsigned }).diagnosis.tag, 'twos_msb_positive');
  const tie = shift.build({ w: 8, x: 64, dir: 'L', k: 1, kind: 'arithmetic', askValue: true });
  assert.equal(tie.key.value, -128);
  assert.equal(shift.diagnose(tie, { bits: tie.key.bits.slice(), value: 128 }).diagnosis.tag, 'shift_value_myth');
});

test('twos: a range answer is only "wrong range" when a value given is wrong', () => {
  const item = twos.build({ w: 8, n: 0, task: 'range' });
  assert.equal(twos.diagnose(item, { min: -128, max: null }).diagnosis.tag, null);
  assert.equal(twos.diagnose(item, { min: -127, max: null }).diagnosis.tag, 'twos_range');
  assert.equal(twos.diagnose(item, { min: -128, max: 128 }).diagnosis.tag, 'twos_range');
});

test('fa: every input pattern × every answer — gate-level tags only where a teacher would give them', () => {
  for (const [a, b, cin] of [[0, 0, 1], [0, 1, 0], [1, 0, 0], [0, 1, 1], [1, 0, 1], [1, 1, 0], [1, 1, 1]]) {
    for (const wires of [false, true]) {
      const item = fa.build({ a, b, cin, wires });
      const ids = item.fields.map((f) => f.id);
      const combos = 3 ** ids.length;
      for (let c = 0; c < combos; c++) {
        const ans = {};
        ids.forEach((id, j) => { ans[id] = [0, 1, null][Math.floor(c / 3 ** j) % 3]; });
        const m = fa.mark(item, ans);
        if (m.correct) continue;
        const d = fa.diagnose(item, ans, m).diagnosis;
        const first = m.firstWrong.field;
        if (m.cells[first] === 'missing') { assert.equal(d.tag, null); continue; }
        if (d.tag === 'add_or') {
          if (first === 'x1') assert.ok(a && b && ans.x1 === 1);
          else if (first === 'sum' && wires) assert.ok(item.sim.x1 === 1 && cin === 1 && ans.sum === 1);
          else assert.ok(!wires || first !== 'x1');
          if (!wires) assert.ok(a === 1 && b === 1 && cin === 0, 'no-wires OR needs 1 + 1 with no carry-in');
        }
        if (d.tag === 'add_three_ones') assert.ok(a && b && cin && ans.sum === 0 && ans.cout === 1);
        if (d.tag === 'add_no_carry') assert.ok(a + b + cin >= 1);
        assert.ok(sentences(d.detail) <= 2, d.detail);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 3. Language
// ---------------------------------------------------------------------------

const AMERICAN = /\b(color|center|behavior|favor|analyze|recognize|realize|organize|gray|toward)\b/i;

/** every learner-facing string the items can produce, from many answers */
function harvest(rng, count) {
  const out = [];
  const say = (where, text, level) => out.push({ where, text, level });
  for (const [type, mod] of Object.entries(MODS)) {
    for (let n = 0; n < count; n++) {
      const level = pick(rng, LEVELS);
      const target = rng() < 0.5 ? pick(rng, mod.TARGETS) : undefined;
      const item = mod.build(mod.generate(rng, { level, target, ask: pick(rng, ['full', 'result']), kind: 'mixed', askFlags: level === 'csapp' ? ['CF', 'ZF', 'SF', 'OF'] : ['OF'] }));
      say(`${type} prompt`, item.prompt, level);
      const ans = structuredClone(item.key);
      const walk = (o) => { for (const k of Object.keys(o)) { if (o[k] && typeof o[k] === 'object') walk(o[k]); else if (rng() < 0.3) o[k] = o[k] === null ? null : pick(rng, [0, 1, null, 'yes', 'no', -5, 7].filter((v) => typeof v === typeof o[k] || v === null)); } };
      walk(ans);
      const cps = [];
      let r;
      for (let s = 0; s < 4; s++) {
        r = mod.diagnose(item, ans, mod.mark(item, ans), cps);
        if (!r.next) break;
        say(`${type} checkpoint`, r.next.prompt, level);
        cps.push(r.next.input.kind === 'bit' ? pick(rng, [0, 1, null]) : pick(rng, [[0, 1], [1, 0], [1, 1], null]));
      }
      say(`${type} headline`, r.diagnosis.headline, level);
      say(`${type} detail`, r.diagnosis.detail, level);
      for (const l of mod.why(item, r.diagnosis, { level })) {
        say(`${type} why ${l.kind}`, l.say.join(' '), level);
        for (const t of Object.values(l.data.why || {})) say(`${type} flag why`, t, level);
      }
    }
  }
  return out;
}

test('language: every learner-facing string is short, well formed and British', () => {
  const all = harvest(mulberry32(2718), 600);
  for (const { where, text } of all) {
    assert.ok(typeof text === 'string' && text.length > 0, where);
    assert.ok(!/undefined|NaN|null|\[object/.test(text), `${where}: ${text}`);
    assert.ok(!/ {2}|\s[.,]|\.\./.test(text), `${where} spacing: ${text}`);
    assert.ok(!/\bYour the\b|\bthe the\b|\ba an?\b/i.test(text), `${where} grammar: ${text}`);
    assert.ok(!/which is [01] in binary/.test(text), `${where}: "${text}" (a single bit needs no conversion)`);
    assert.ok(!AMERICAN.test(text), `${where} spelling: ${text}`);
    // a capital, or a wire name written as in the circuit (a, x1, sum …)
    assert.match(text, /^([A-Z0-9−(]|(a|b|x1|a1|a2|sum)\b)/, `${where} starts with a capital: ${text}`);
    if (!/prompt|checkpoint/.test(where)) assert.ok(sentences(text) <= 2, `${where} ≤ 2 sentences: ${text}`);
    if (/flag why/.test(where)) assert.equal(sentences(text), 1);
  }
});

test('language: A-level overflow items talk about "overflow", never undefined flag names', () => {
  const rng = mulberry32(5);
  for (let n = 0; n < 400; n++) {
    const item = sadd.build(sadd.generate(rng, { level: 'alevel', askFlags: ['OF'] }));
    const ans = { bits: item.key.bits.slice(), flags: { OF: 1 - item.key.flags.OF } };
    const d = sadd.diagnose(item, ans).diagnosis;
    assert.ok(!/\b(OF|CF|SF|ZF)\b/.test(d.detail + d.headline), `${d.headline} ${d.detail}`);
    const flagsLayer = sadd.why(item, d, { level: 'alevel' }).find((l) => l.kind === 'flags');
    assert.ok(!/\b(OF|CF)\b/.test(flagsLayer.say.join(' ')), flagsLayer.say.join(' '));
  }
});

test('language: tag texts define flag names and use exam wording', () => {
  assert.match(BINARY_TAGS.flags_carry_is_overflow.student, /carry flag \(CF\)/);
  assert.match(BINARY_TAGS.flags_carry_is_overflow.student, /overflow flag \(OF\)/);
  assert.match(BINARY_TAGS.flags_sub_carry.student, /carry flag \(CF\)/);
  assert.match(BINARY_TAGS.add_overflow_missed.student, /overflow error/);
  for (const [id, t] of Object.entries(BINARY_TAGS)) {
    for (const s of [t.student, t.fix, t.label]) assert.ok(!AMERICAN.test(s), `${id}: ${s}`);
  }
});

// ---------------------------------------------------------------------------
// 4. Why layers: data consistent with the item, levels respected
// ---------------------------------------------------------------------------

test('why: layer data matches the simulation, and GCSE never sees gates', () => {
  const rng = mulberry32(99);
  for (const [type, mod] of Object.entries(MODS)) {
    for (let n = 0; n < 300; n++) {
      const level = pick(rng, LEVELS);
      const item = mod.build(mod.generate(rng, { level, target: rng() < 0.5 ? pick(rng, mod.TARGETS) : undefined, kind: 'mixed' }));
      const d = mod.diagnose(item, mod.blank(item)).diagnosis;
      const layers = mod.why(item, d, { level });
      if (level === 'gcse') {
        assert.ok(layers.every((l) => l.kind !== 'adder'), `${type}: adder at GCSE`);
        if (type === 'add') assert.ok(layers.every((l) => !/XOR|AND|full adder/.test(l.say.join(' '))));
      }
      for (const l of layers) {
        if (l.kind === 'columns' && (type === 'add' || type === 'sadd')) {
          assert.deepEqual(l.data.result, item.sim.result);
          assert.deepEqual(l.data.carries.slice(1), item.sim.carries.slice(1));
          assert.equal(l.data.dropped, item.sim.cout === 1);
          if (type === 'sadd' && item.params.op === '-') {
            assert.equal(l.data.carries[0], 1);
            assert.deepEqual(l.data.b, bitsOf(~item.params.b, item.params.w), 'b shown inverted');
          }
        }
        if (l.kind === 'column') {
          const [s, c] = add.colRule(l.data.a, l.data.b, l.data.cin);
          assert.deepEqual([l.data.sum, l.data.cout], [s, c]);
          if (type !== 'fa') assert.equal(l.data.cin, item.sim.carries[l.data.k]);
        }
        if (l.kind === 'shift') {
          assert.deepEqual(l.data.after, item.key.bits);
          assert.deepEqual(l.data.lost, item.sim.lost);
          assert.equal(l.data.fill, item.params.dir === 'R' && item.params.kind === 'arithmetic' ? item.show.x[item.params.w - 1] : 0);
        }
        if (l.kind === 'twos' && item.params.task !== 'range') {
          const last = l.data.steps.at(-1).bits;
          assert.ok(valOf(last) === wrapU(item.params.n, item.params.w) || valOf(last) === Math.abs(item.params.n));
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 5. Generators: variety, realism, targeting, robustness
// ---------------------------------------------------------------------------

test('generators: varied, never degenerate, with a realistic overflow rate', () => {
  const rng = mulberry32(8);
  for (const [type, mod] of Object.entries(MODS)) {
    for (const level of LEVELS) {
      const seen = new Set();
      let overflow = 0;
      const N = 500;
      for (let n = 0; n < N; n++) {
        const p = mod.generate(rng, { level, kind: 'mixed' });
        seen.add(JSON.stringify(p));
        const item = mod.build(p);
        if (type === 'add') {
          assert.ok(p.a >= 1 && p.b >= 1);
          assert.ok(item.sim.carries.slice(1).filter(Boolean).length >= 2, 'real carries');
          overflow += item.sim.cout;
        }
        if (type === 'shift') {
          const ones = bitsOf(p.x, p.w).filter(Boolean).length;
          assert.ok(ones >= 2 && ones <= p.w - 2, 'a mix of 0s and 1s');
          assert.ok(p.k >= 1 && p.k < p.w);
          if (level === 'gcse' && !p.level) assert.equal(p.kind, 'logical');
        }
        if (type === 'twos' && p.task !== 'range') assert.ok(Math.abs(p.n) >= 2);
        if (type === 'sadd') assert.ok(Math.abs(p.a) >= 2 && Math.abs(p.b) >= 2);
        if (type === 'fa') assert.ok(p.a + p.b + p.cin >= 1);
      }
      const minDistinct = type === 'fa' ? 7 : type === 'twos' ? N * 0.5 : N * 0.9;
      assert.ok(seen.size >= minDistinct, `${type} ${level}: ${seen.size} distinct of ${N}`);
      if (type === 'add') assert.ok(overflow / N > 0.15 && overflow / N < 0.5, `overflow rate ${overflow / N}`);
    }
  }
});

test('generators: shift and sadd items cover both directions, kinds, operators and overflow', () => {
  const rng = mulberry32(10);
  const shifts = Array.from({ length: 400 }, () => shift.generate(rng, { level: 'alevel', kind: 'mixed' }));
  for (const [key, vals] of [['dir', ['L', 'R']], ['kind', ['logical', 'arithmetic']], ['k', [1, 2, 3]]]) {
    for (const v of vals) assert.ok(shifts.some((p) => p[key] === v), `shift ${key}=${v}`);
  }
  assert.ok(shifts.some((p) => p.kind === 'arithmetic' && p.dir === 'R' && p.x >= 128), 'arithmetic shift of a negative');
  const sums = Array.from({ length: 400 }, () => sadd.build(sadd.generate(rng, { level: 'alevel' })));
  assert.ok(sums.some((s) => s.params.op === '-') && sums.some((s) => s.params.op === '+'));
  const of = sums.filter((s) => s.sim.OF).length / sums.length;
  assert.ok(of > 0.2 && of < 0.6, `sadd overflow rate ${of}`);
  assert.ok(sums.some((s) => s.sim.cout && !s.sim.OF), 'carry out without overflow (the CF/OF trap) appears');
});

test('decodeParams: damaged links still build a valid item', () => {
  const rng = mulberry32(6);
  const junk = () => pick(rng, [0, 1, 2, 3, 7, 8, 16, 17, 99, 255, 65535, 100000, -1]);
  for (const mod of Object.values(MODS)) {
    for (let n = 0; n < 300; n++) {
      const ints = Array.from({ length: 7 }, junk);
      const p = mod.decodeParams(ints);
      const item = mod.build(p);
      assert.equal(mod.mark(item, item.key).correct, true);
      assert.ok(item.prompt.length > 10 && !/undefined|NaN/.test(item.prompt), item.prompt);
      if ('w' in p) assert.ok(p.w >= 4 && p.w <= 16);
    }
  }
});

// ---------------------------------------------------------------------------
// Review regressions (requirements #2, #3; bugs #6, #9, #11, #17)
// ---------------------------------------------------------------------------

test('shift: the value field takes decimals, so the ÷2^k myth on a right shift is diagnosable', () => {
  const item = shift.build({ w: 8, x: 45, dir: 'R', k: 2, kind: 'logical', askValue: true, level: 'gcse' });
  const field = item.fields.find((f) => f.id === 'value');
  assert.equal(field.decimal, true);
  const ans = { bits: item.key.bits.slice(), value: 11.25 };
  const m = shift.mark(item, ans);
  assert.equal(m.cells.value, 'bad');
  assert.equal(shift.diagnose(item, ans, m).diagnosis.tag, 'shift_value_myth');
  // a negative arithmetic right shift: −45 ÷ 4 = −11.25, cut to −11; the shift gives −12
  const neg = shift.build({ w: 8, x: 256 - 45, dir: 'R', k: 2, kind: 'arithmetic', askValue: true, level: 'alevel' });
  assert.equal(neg.key.value, -12);
  for (const v of [-11.25, -11]) assert.equal(shift.diagnose(neg, { bits: neg.key.bits.slice(), value: v }).diagnosis.tag, 'shift_value_myth', String(v));
  // a value that is neither right nor the myth is not tagged as the myth
  assert.notEqual(shift.diagnose(item, { bits: item.key.bits.slice(), value: 11.5 }).diagnosis.tag, 'shift_value_myth');
});

test('shift: targeted value-myth items prefer a whole-number myth answer', () => {
  for (const [level, kind] of [['gcse', 'logical'], ['alevel', 'mixed'], ['alevel', 'arithmetic']]) {
    const rng = mulberry32(77);
    let whole = 0;
    const N = 150;
    for (let n = 0; n < N; n++) {
      const p = shift.generate(rng, { level, kind, target: 'shift_value_myth' });
      const item = shift.build(p);
      const [myth] = shift.misconceptions(p, 'shift_value_myth');
      assert.equal(shift.diagnose(item, myth).diagnosis.tag, 'shift_value_myth');
      if (Number.isInteger(myth.value)) whole++;
    }
    assert.ok(whole / N >= 0.95, `${level}/${kind}: ${whole}/${N} whole-number myths`);
  }
});

test('shift and twos: an empty answer is called empty, never "the bits you gave are right"', () => {
  const s = shift.build({ w: 8, x: 45, dir: 'L', k: 1, kind: 'logical', askValue: false });
  const ds = shift.diagnose(s, shift.blank(s)).diagnosis;
  assert.equal(ds.tag, null);
  assert.match(ds.headline, /didn't give/);
  assert.doesNotMatch(ds.detail, /you gave are right/);
  assert.match(ds.detail, new RegExp(s.key.bits.slice().reverse().join('')));
  const t = twos.build({ w: 8, n: -42, task: 'encode' });
  const dt = twos.diagnose(t, twos.blank(t)).diagnosis;
  assert.equal(dt.tag, null);
  assert.match(dt.headline, /didn't give/);
  assert.doesNotMatch(dt.detail, /you gave are right/);
  // a partly filled, all-right answer still says so
  const part = { bits: t.key.bits.map((b, i) => (i < 4 ? b : null)) };
  assert.match(twos.diagnose(t, part).diagnosis.detail, /you gave are right/);
});

test('twos: −2^(w−1) is never explained from +2^(w−1)', () => {
  for (const w of [4, 8, 16]) {
    const M = 2 ** (w - 1);
    for (const task of ['encode', 'decode']) {
      const item = twos.build({ w, n: -M, task });
      const texts = [];
      for (const l of twos.why(item, null, { level: 'alevel' })) texts.push(...l.say);
      const wrongs = task === 'encode'
        ? [{ bits: bitsOf(M - 1, w) }, { bits: bitsOf(0, w) }, { bits: new Array(w).fill(1) }]
        : [{ value: M }, { value: 0 }, { value: -(M - 1) }, { value: 5 }];
      for (const a of wrongs) {
        const d = twos.diagnose(item, a).diagnosis;
        texts.push(d.detail);
        assert.ok(sentenceCount(d.detail) <= 2, d.detail);
      }
      for (const t of texts) {
        assert.doesNotMatch(t, new RegExp(`\\+${M} = `), t);
        assert.doesNotMatch(t, /start from \+/, t);
      }
      assert.ok(texts.some((t) => /smallest/.test(t)));
    }
  }
});
const sentenceCount = (s) => (s.match(/[.!?](\s|$)/g) || []).length;

test('full adder without wires: feedback never names a wire the learner did not see', () => {
  for (const [a, b, cin] of [[0, 0, 0], [0, 0, 1], [0, 1, 0], [1, 0, 0], [0, 1, 1], [1, 0, 1], [1, 1, 0], [1, 1, 1]]) {
    const item = fa.build({ a, b, cin, wires: false, level: 'alevel' });
    for (const f of item.fields) assert.doesNotMatch(f.label, /\b(x1|a1|a2)\b/, f.label);
    for (const sum of [null, 0, 1]) {
      for (const cout of [null, 0, 1]) {
        const ans = { sum, cout };
        const m = fa.mark(item, ans);
        if (m.correct) continue;
        const d = fa.diagnose(item, ans, m).diagnosis;
        assert.doesNotMatch(`${d.headline} ${d.detail}`, /\b(x1|a1|a2)\b/, `${a}${b}${cin} ${sum}/${cout}: ${d.detail}`);
        assert.ok(sentenceCount(d.detail) <= 2, d.detail);
      }
    }
  }
});

// A learner who writes each carry d columns along (above column i + d, not
// i + 1) and adds it there — written here independently of add.js.
function displacedLearner(item, d) {
  const { w } = item.params;
  const A = item.show.a;
  const B = item.show.b;
  const result = [];
  const carries = new Array(w + 1).fill(null);
  const pend = new Array(w + d + 1).fill(0);
  for (let i = 0; i < w; i++) {
    const s = A[i] + B[i] + pend[i];
    result.push(s % 2);
    if (s >= 2) { pend[i + d] = 1; if (i + d <= w) carries[i + d] = 1; }
  }
  return { carries, result: [...result, null], overflow: pend[w] ? 'yes' : 'no' };
}

test('add: a carry written (and added) one or two columns too far left is "carry in the wrong column"', () => {
  // The reviewer's case: 150 + 102, each carry two columns along.
  const item = add.build({ w: 8, a: 150, b: 102, ask: 'full', level: 'gcse' });
  const ans = displacedLearner(item, 2);
  assert.deepEqual(ans.carries, [null, null, null, 1, 1, null, 1, null, 1]);
  const d = add.diagnose(item, ans).diagnosis;
  assert.equal(d.tag, 'add_carry_wrong_col');
  assert.equal(d.focus.column, 1);
  assert.match(d.detail, /2s column/);
  assert.match(d.detail, /8s column/);
  assert.ok(sentenceCount(d.detail) <= 2);
  assert.equal(add.why(item, d, { level: 'gcse' })[1].data.k, 1);

  // simulated students over many items
  const rng = mulberry32(2024);
  const hits = { 2: 0, 3: 0 };
  const tried = { 2: 0, 3: 0 };
  for (let n = 0; n < 1500; n++) {
    const it = add.build(add.generate(rng, { w: pick(rng, [6, 8, 8, 12, 16]), ask: 'full' }));
    for (const dd of [2, 3]) {
      const a = displacedLearner(it, dd);
      const m = add.mark(it, a);
      if (m.correct) continue;
      tried[dd]++;
      const dg = add.diagnose(it, a, m).diagnosis;
      if (dg.tag === 'add_carry_wrong_col') {
        hits[dd]++;
        // focus: the lowest column that makes a carry
        const c = dg.focus.column;
        assert.equal(add.colRule(it.show.a[c], it.show.b[c], it.sim.carries[c])[1], 1);
        assert.ok(it.sim.carries.slice(1, c + 1).every((x) => x === 0));
      } else assert.equal(dg.tag, 'add_no_carry', 'the only other reading is a dropped carry');
    }
  }
  assert.ok(hits[2] / tried[2] >= 0.9, `one column too far: ${hits[2]}/${tried[2]}`);
  assert.ok(hits[3] / tried[3] >= 0.8, `two columns too far: ${hits[3]}/${tried[3]}`);
});

test('add: dropped-carry, OR and 1+1+1 learners are never told "carry in the wrong column"', () => {
  const rng = mulberry32(99);
  let fired = 0;
  let total = 0;
  for (let n = 0; n < 1500; n++) {
    const it = add.build(add.generate(rng, { w: pick(rng, [4, 6, 8, 12, 16]), ask: 'full' }));
    const { w } = it.params;
    const A = it.show.a;
    const B = it.show.b;
    const answers = [
      add.misconceive(it.params, 'add_no_carry', 0), add.misconceive(it.params, 'add_no_carry', 1),
      add.misconceive(it.params, 'add_or'), add.misconceive(it.params, 'add_three_ones'),
    ];
    // one carry dropped (neither written nor added), everything else right
    const made = it.sim.carries.map((c, j) => (j > 0 && c ? j : 0)).filter(Boolean);
    const j0 = pick(rng, made);
    const result = [];
    const carries = new Array(w + 1).fill(null);
    let c = 0;
    for (let i = 0; i < w; i++) {
      const s = A[i] + B[i] + c;
      result.push(s % 2);
      c = i + 1 === j0 ? 0 : s >> 1;
      carries[i + 1] = c || null;
    }
    answers.push({ carries, result: [...result, null], overflow: c ? 'yes' : 'no' });
    for (const a of answers) {
      const m = add.mark(it, a);
      if (m.correct) continue;
      total++;
      if (add.diagnose(it, a, m).diagnosis.tag === 'add_carry_wrong_col') fired++;
    }
  }
  assert.ok(fired / total < 0.002, `false alarms ${fired}/${total}`);
});

test('add: targeted wrong-column items show both the moved carry row and the carried-and-added form', () => {
  const rng = mulberry32(5);
  for (let n = 0; n < 60; n++) {
    const p = add.generate(rng, { w: 8, target: 'add_carry_wrong_col' });
    const it = add.build(p);
    for (const v of [0, 1]) assert.equal(add.diagnose(it, add.misconceive(p, 'add_carry_wrong_col', v)).diagnosis.tag, 'add_carry_wrong_col');
  }
});

test('carry checkpoints list every carry that counts as right (paper-method subtraction)', () => {
  const rng = mulberry32(31);
  let seen = 0;
  for (let n = 0; n < 400 && seen < 20; n++) {
    const item = sadd.build(sadd.generate(rng, { level: 'alevel', op: '-' }));
    const s = item.sim;
    const { w } = item.params;
    const i = [...Array(w).keys()].find((j) => j > 0 && s.carries[j] !== s.paperCarries[j]);
    if (i === undefined) continue;
    seen++;
    const bitsAns = s.result.slice();
    bitsAns[i] = 1 - bitsAns[i];
    const ans = { bits: bitsAns, flags: {} };
    const { next } = sadd.diagnose(item, ans, sadd.mark(item, ans), []);
    assert.equal(next.id, 'carry-in');
    assert.deepEqual([...next.accept].sort(), [0, 1]);
    assert.ok(next.accept.includes(next.answer));
    // either accepted carry moves on to the column question; it is not a dropped carry
    for (const c of next.accept) {
      const r = sadd.diagnose(item, ans, sadd.mark(item, ans), [c]);
      assert.equal(r.next?.id, 'column', `carry ${c}`);
    }
  }
  assert.ok(seen >= 5, `found ${seen} paper-method cases`);
  // ordinary addition has one right carry: no accept list
  const it = add.build({ w: 8, a: 150, b: 102, ask: 'result' });
  const ans = { carries: new Array(9).fill(null), result: [...it.key.result], overflow: it.key.overflow };
  ans.result[3] = 1 - ans.result[3];
  const { next } = add.diagnose(it, ans, add.mark(it, ans), []);
  assert.equal(next.id, 'carry-in');
  assert.equal('accept' in next, false);
});
