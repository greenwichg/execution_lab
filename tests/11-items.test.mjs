// Predict the Machine's binary practice items (machine/src/learn/items/*.js,
// machine/src/engine/bits.js, machine/src/learn/tags.js):
//   · bits.js agrees with the real x86-64 ALU (addb/subb/shlb/shrb/sarb flags,
//     checked through gcc inline asm; skipped when gcc is missing)
//   · every item type marks its own key correct and diagnoses it as tag-free
//   · for EVERY binary misconception tag, a simulated "buggy student" who holds
//     exactly that misconception (written here, independently of the modules)
//     is diagnosed with that tag on ≥ 200 targeted items
//   · checkpoint flows finish in ≤ 3 questions; variants trip the same student;
//     params round-trip through encode/decode; Why layers and BINARY_TAGS are
//     well-formed at every level
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import * as bits from '../machine/src/engine/bits.js';
import * as add from '../machine/src/learn/items/add.js';
import * as shift from '../machine/src/learn/items/shift.js';
import * as twos from '../machine/src/learn/items/twos.js';
import * as sadd from '../machine/src/learn/items/sadd.js';
import * as fa from '../machine/src/learn/items/fa.js';
import * as registry from '../machine/src/learn/items/index.js';
import { BINARY_TAGS } from '../machine/src/learn/tags.js';
import { TAG_IDS } from '../machine/src/learn/tagids.js';
import { SPECS } from '../machine/src/learn/spec.js';
import { mulberry32, pick } from '../machine/src/lib/rng.js';

const MODS = { add, shift, twos, sadd, fa };
const LEVELS = ['gcse', 'alevel', 'csapp'];
const N = 200;

// ---------------------------------------------------------------------------
// Independent helpers (deliberately not imported from the modules under test)
// ---------------------------------------------------------------------------

const U = (v, w) => ((v % 2 ** w) + 2 ** w) % 2 ** w;
const S = (v, w) => { const u = U(v, w); return u >= 2 ** (w - 1) ? u - 2 ** w : u; };
const B = (v, w) => Array.from({ length: w }, (_, i) => Math.floor(U(v, w) / 2 ** i) % 2);
const V = (bs) => bs.reduce((s, b, i) => s + b * 2 ** i, 0);

/** sentences in a string: terminal punctuation followed by space or the end */
const sentences = (s) => (String(s).trim().match(/[.!?](?=\s|$)/g) || []).length || 1;

/** run diagnose the way the UI does: ask checkpoints until a diagnosis */
function runFlow(mod, item, answer, reply = () => null) {
  const cps = [];
  for (let n = 0; n <= 3; n++) {
    const r = mod.diagnose(item, answer, mod.mark(item, answer), cps);
    if (!r.next) {
      assert.ok(r.diagnosis, 'diagnose must return a checkpoint or a diagnosis');
      return { ...r.diagnosis, steps: n };
    }
    assert.ok(n < 3, 'more than 3 checkpoints');
    for (const k of ['id', 'prompt', 'input']) assert.ok(r.next[k] !== undefined, `checkpoint missing ${k}`);
    assert.ok('answer' in r.next);
    cps.push(reply(r.next, item));
  }
  throw new Error('checkpoint flow did not finish');
}

// ---------------------------------------------------------------------------
// Buggy students: each applies exactly one misconception
// ---------------------------------------------------------------------------

/** unsigned addition students: { answer(item), reply(cp, item) } */
function addStudent(tag, rng) {
  const variantNo = rng() < 0.5 ? 0 : 1;
  const dirRight = rng() < 0.5;
  return (A, Bb, cin, w) => {
    const key = { r: [], c: [cin] };
    for (let i = 0; i < w; i++) { const n = A[i] + Bb[i] + key.c[i]; key.r.push(n % 2); key.c.push(n >> 1); }
    const r = [];
    const c = [cin];
    let reply;
    if (tag === 'add_or') {
      for (let i = 0; i < w; i++) { r.push(A[i] | Bb[i]); c.push(0); }
      reply = (cp) => (cp.id === 'carry-in' ? 0 : [cp.a | cp.b | cp.c, 0]);
    } else if (tag === 'add_no_carry' && variantNo === 0) {
      for (let i = 0; i < w; i++) { r.push(A[i] ^ Bb[i]); c.push(0); }
      reply = (cp) => (cp.id === 'carry-in' ? 0 : [(cp.a + cp.b + cp.c) % 2, 0]);
    } else if (tag === 'add_no_carry') {
      for (let i = 0; i < w; i++) { const s = A[i] + Bb[i] + (i === 0 ? cin : 0); r.push(s % 2); c.push(s >> 1); }
      reply = (cp) => (cp.id === 'carry-in' ? c[cp.column] : [(cp.a + cp.b) % 2, (cp.a + cp.b) >> 1]);
    } else if (tag === 'add_three_ones') {
      for (let i = 0; i < w; i++) { const n = A[i] + Bb[i] + c[i]; r.push(n === 3 ? 0 : n % 2); c.push(n >> 1); }
      reply = (cp) => (cp.id === 'carry-in' ? c[cp.column] : (cp.a + cp.b + cp.c === 3 ? [0, 1] : [(cp.a + cp.b + cp.c) % 2, (cp.a + cp.b + cp.c) >> 1]));
    } else {
      r.push(...key.r); c.push(...key.c.slice(1));
      reply = (cp) => (cp.id === 'carry-in' ? key.c[cp.column] : [(cp.a + cp.b + cp.c) % 2, (cp.a + cp.b + cp.c) >> 1]);
    }
    let carries = [null, ...c.slice(1)];
    if (tag === 'add_carry_wrong_col') {
      carries = dirRight ? [null, ...key.c.slice(2), 0] : [null, 0, ...key.c.slice(1, w)];
    }
    return { r, carries, cout: c[w], keyCout: key.c[w], reply };
  };
}

function addAnswer(item, tag, rng) {
  const { w } = item.params;
  const run = addStudent(tag, rng)(item.show.a, item.show.b, 0, w);
  const full = item.params.ask !== 'result';
  const ans = {
    carries: full ? run.carries.map((x, i) => (i === 0 ? null : x)) : new Array(w + 1).fill(null),
    result: [...run.r, null],
    overflow: run.cout ? 'yes' : 'no',
  };
  if (tag === 'add_ninth_bit') ans.result[w] = run.keyCout;
  if (tag === 'add_overflow_missed') ans.overflow = 'no';
  if (tag === 'add_overflow_false') ans.overflow = run.r[w - 1] === 1 || run.cout ? 'yes' : 'no';
  if (tag === 'add_or' || (tag === 'add_no_carry' && ans.carries.every((x) => x === null || x === 0))) {
    // a learner who never carries has nothing to write in the carry row
    if (full) ans.carries = ans.carries.map(() => null);
  }
  return { answer: ans, reply: run.reply };
}

function shiftAnswer(item, tag, rng) {
  const { w, x, dir, k, kind, askValue } = item.params;
  const mask = 2 ** w - 1;
  const sx = S(x, w);
  const sh = (d, kk, kd) => {
    if (d === 'L') return U(x * 2 ** kk, w);
    if (kd === 'arithmetic') return U(Math.floor(sx / 2 ** kk), w);
    return Math.floor(x / 2 ** kk);
  };
  const keyV = sh(dir, k, kind);
  const read = (v) => (kind === 'arithmetic' ? S(v, w) : v);
  let v = keyV;
  let value = askValue ? read(keyV) : null;
  if (tag === 'shift_direction') v = sh(dir === 'L' ? 'R' : 'L', k, kind);
  if (tag === 'shift_amount') v = sh(dir, k + (rng() < 0.5 && k > 1 ? -1 : 1), kind);
  if (tag === 'shift_kept_bits') v = dir === 'L' ? U(x * 2 ** k + Math.floor(x / 2 ** (w - k)), w) : U(Math.floor(x / 2 ** k) + (x % 2 ** k) * 2 ** (w - k), w);
  if (tag === 'shift_fill') {
    const gapMask = dir === 'L' ? 2 ** k - 1 : mask - (mask >>> k);
    const fillOne = dir === 'R' && kind === 'arithmetic' && sx < 0;
    v = fillOne ? keyV & ~gapMask & mask : keyV | gapMask;
  }
  if (tag === 'shift_arith_logical') v = sh(dir, k, kind === 'arithmetic' ? 'logical' : 'arithmetic');
  if (tag !== 'shift_value_myth' && askValue) value = read(v);
  if (tag === 'shift_value_myth') value = dir === 'L' ? read(x) * 2 ** k : read(x) / 2 ** k;
  return { answer: { bits: B(v, w), value }, reply: () => null };
}

function twosAnswer(item, tag, rng) {
  const { w, n, task } = item.params;
  const M = 2 ** (w - 1);
  const u = U(n, w);
  if (task === 'range') {
    const wrong = [[-(M - 1), M - 1], [-M, M], [0, 2 * M - 1], [-(M - 1), M]];
    const [min, max] = tag === 'twos_range' ? pick(rng, wrong) : [-M, M - 1];
    return { answer: { min, max }, reply: () => null };
  }
  if (task === 'encode') {
    let v = u;
    if (tag === 'twos_sign_magnitude') v = M + Math.abs(n);
    if (tag === 'twos_no_plus1') v = U(~Math.abs(n), w);
    return { answer: { bits: B(v, w) }, reply: () => null };
  }
  let value = n;
  if (tag === 'twos_msb_positive') value = u;
  if (tag === 'twos_sign_magnitude') value = -(u % M);
  if (tag === 'twos_no_plus1') value = -U(~u, w);
  return { answer: { value }, reply: () => null };
}

function saddAnswer(item, tag, rng) {
  const { w, a, b, op, askFlags } = item.params;
  const ua = U(a, w);
  const ub = U(b, w);
  const trueV = op === '+' ? a + b : a - b;
  const r = U(trueV, w);
  const rawCarry = op === '+' ? (ua + ub >= 2 ** w ? 1 : 0) : (ua >= ub ? 1 : 0);
  const flags = {
    CF: op === '+' ? rawCarry : ua < ub ? 1 : 0,
    ZF: r === 0 ? 1 : 0,
    SF: r >= 2 ** (w - 1) ? 1 : 0,
    OF: trueV < -(2 ** (w - 1)) || trueV > 2 ** (w - 1) - 1 ? 1 : 0,
  };
  let resultBits = B(r, w);
  let reply = () => null;
  if (tag.startsWith('add_')) {
    // Result-bit mistakes are made in the adder's columns: a + b, or a + ~b + 1.
    const Bb = op === '+' ? B(ub, w) : B(ub, w).map((x) => 1 - x);
    const run = addStudent(tag, rng)(B(ua, w), Bb, op === '+' ? 0 : 1, w);
    resultBits = run.r;
    reply = run.reply;
  }
  const f = { ...flags };
  if (tag === 'flags_carry_is_overflow') f.OF = rawCarry;
  if (tag === 'flags_signed_overflow_missed') f.OF = 0;
  if (tag === 'flags_sub_carry') f.CF = rawCarry;
  const asked = {};
  for (const k of askFlags) asked[k] = f[k];
  return { answer: { bits: resultBits, flags: asked }, reply };
}

function faAnswer(item, tag) {
  const { a, b, cin, wires } = item.params;
  const n = a + b + cin;
  const ans = { sum: n % 2, cout: n >> 1 };
  if (wires) Object.assign(ans, { x1: a ^ b, a1: a & b, a2: (a ^ b) & cin });
  if (tag === 'add_or') { ans.sum = a | b | cin; ans.cout = 0; if (wires) ans.x1 = a | b; }
  if (tag === 'add_three_ones' && n === 3) { ans.sum = 0; ans.cout = 1; }
  return { answer: ans, reply: () => null };
}

const STUDENTS = { add: addAnswer, shift: shiftAnswer, twos: twosAnswer, sadd: saddAnswer, fa: faAnswer };

// ---------------------------------------------------------------------------
// bits.js
// ---------------------------------------------------------------------------

test('bits.js: exhaustive 8-bit and 5-bit arithmetic matches the definitions', () => {
  for (const w of [5, 8]) {
    const M = 2 ** w;
    for (let a = 0; a < M; a++) {
      assert.deepEqual(bits.toBits(a, w), B(a, w));
      assert.equal(bits.fromBits(B(a, w)), a);
      assert.equal(bits.fromBits(B(a, w), { signed: true }), S(a, w));
      assert.equal(bits.toSigned(a, w), S(a, w));
      assert.equal(bits.toUnsigned(S(a, w), w), a);
      for (let b = 0; b < M; b++) {
        for (const cin of [0, 1]) {
          const r = bits.addBits(a, b, w, cin);
          const t = a + b + cin;
          assert.equal(r.carries[0], cin);
          assert.equal(r.carries.length, w + 1);
          assert.equal(r.value, t % M);
          assert.equal(r.cout, t >= M ? 1 : 0);
          assert.equal(r.CF, r.cout);
          const st = S(a, w) + S(b, w) + cin;
          assert.equal(r.OF, st < -M / 2 || st >= M / 2 ? 1 : 0, `OF ${a}+${b}+${cin}`);
          assert.equal(r.OF, r.carries[w - 1] ^ r.carries[w]);
          assert.equal(r.SF, t % M >= M / 2 ? 1 : 0);
          assert.equal(r.ZF, t % M === 0 ? 1 : 0);
        }
        const s = bits.subBits(a, b, w);
        assert.equal(s.value, U(a - b, w));
        assert.equal(s.CF, a < b ? 1 : 0, 'CF after sub is the borrow');
        assert.equal(s.cout, a < b ? 0 : 1);
        assert.equal(s.carries[0], 1);
        const sd = S(a, w) - S(b, w);
        assert.equal(s.OF, sd < -M / 2 || sd >= M / 2 ? 1 : 0);
      }
    }
  }
  assert.deepEqual(bits.range(8, true), { min: -128, max: 127 });
  assert.deepEqual(bits.range(8, false), { min: 0, max: 255 });
  assert.deepEqual(bits.addBits([1, 1, 0, 0], [1, 0, 0, 0], 4).result, [0, 0, 1, 0], 'bit-array operands');
});

test('bits.js: shifts match JS operators, with lost bits and fill', () => {
  const w = 8;
  for (let x = 0; x < 256; x++) {
    for (let k = 1; k < 8; k++) {
      const L = bits.shiftBits(x, w, 'L', k, 'logical');
      assert.equal(V(L.bits), (x << k) & 255);
      assert.deepEqual(L.lost, Array.from({ length: k }, (_, j) => w - k + j));
      assert.equal(L.fill, 0);
      const R = bits.shiftBits(x, w, 'R', k, 'logical');
      assert.equal(V(R.bits), x >>> k);
      assert.deepEqual(R.lost, Array.from({ length: k }, (_, j) => j));
      const A = bits.shiftBits(x, w, 'R', k, 'arithmetic');
      assert.equal(V(A.bits), U(S(x, 8) >> k, 8));
      assert.equal(A.fill, x >= 128 ? 1 : 0);
      assert.deepEqual(bits.shiftBits(x, w, 'L', k, 'arithmetic').bits, L.bits);
    }
  }
});

const HAVE_GCC = (() => { try { execFileSync('which', ['gcc'], { stdio: 'ignore' }); return os.arch() === 'x64'; } catch { return false; } })();

test('bits.js: agrees with the x86-64 ALU for every 8-bit add, sub and shift', { skip: !HAVE_GCC && 'needs gcc on x86-64' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alu-'));
  const src = path.join(dir, 'alu.c');
  const exe = path.join(dir, 'alu');
  fs.writeFileSync(src, `#include <stdio.h>
int main(void) {
  for (int a = 0; a < 256; a++) for (int b = 0; b < 256; b++) {
    unsigned char r1 = a, r2 = a, bb = b; unsigned long f1, f2;
    __asm__ volatile("addb %2, %0\\n\\tpushfq\\n\\tpopq %1" : "+q"(r1), "=r"(f1) : "q"(bb) : "cc");
    __asm__ volatile("subb %2, %0\\n\\tpushfq\\n\\tpopq %1" : "+q"(r2), "=r"(f2) : "q"(bb) : "cc");
    printf("%d %lu %d %lu\\n", r1, f1 & 0x8C1UL, r2, f2 & 0x8C1UL);
  }
  for (int x = 0; x < 256; x++) for (int k = 1; k < 8; k++) {
    unsigned char s1 = x, s2 = x, s3 = x;
    __asm__("shlb %%cl, %0" : "+q"(s1) : "c"(k) : "cc");
    __asm__("shrb %%cl, %0" : "+q"(s2) : "c"(k) : "cc");
    __asm__("sarb %%cl, %0" : "+q"(s3) : "c"(k) : "cc");
    printf("%d %d %d\\n", s1, s2, s3);
  }
  return 0;
}
`);
  execFileSync('gcc', ['-O0', '-o', exe, src]);
  const lines = execFileSync(exe, { maxBuffer: 1 << 24 }).toString().trim().split('\n');
  const flagsOf = (f) => ({ CF: f & 1, ZF: (f >> 6) & 1, SF: (f >> 7) & 1, OF: (f >> 11) & 1 });
  let n = 0;
  for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) {
    const [r1, f1, r2, f2] = lines[n++].split(' ').map(Number);
    const ad = bits.addBits(a, b, 8);
    const sb = bits.subBits(a, b, 8);
    assert.equal(ad.value, r1);
    assert.deepEqual({ CF: ad.CF, ZF: ad.ZF, SF: ad.SF, OF: ad.OF }, flagsOf(f1), `addb ${a},${b}`);
    assert.equal(sb.value, r2);
    assert.deepEqual({ CF: sb.CF, ZF: sb.ZF, SF: sb.SF, OF: sb.OF }, flagsOf(f2), `subb ${a},${b}`);
  }
  for (let x = 0; x < 256; x++) for (let k = 1; k < 8; k++) {
    const [s1, s2, s3] = lines[n++].split(' ').map(Number);
    assert.equal(V(bits.shiftBits(x, 8, 'L', k).bits), s1);
    assert.equal(V(bits.shiftBits(x, 8, 'R', k, 'logical').bits), s2);
    assert.equal(V(bits.shiftBits(x, 8, 'R', k, 'arithmetic').bits), s3);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Every type: keys, marking, blanks
// ---------------------------------------------------------------------------

/** a spread of generator options per type (levels, widths, asks) */
function optionsFor(type, rng) {
  const level = pick(rng, LEVELS);
  switch (type) {
    case 'add': return { level, w: pick(rng, [4, 6, 8, 8, 8, 12, 16]), ask: pick(rng, ['full', 'result']) };
    case 'shift': return { level, w: pick(rng, [6, 8, 8, 12]), kind: pick(rng, ['logical', 'arithmetic', 'mixed']) };
    case 'twos': return { level, w: pick(rng, [4, 8, 8, 16]) };
    case 'sadd': return { level, w: pick(rng, [4, 8, 8, 16]), askFlags: level === 'csapp' ? ['CF', 'ZF', 'SF', 'OF'] : ['OF'] };
    default: return { level };
  }
}

test('every type: the key marks correct, diagnoses with no tag, blanks are empty', () => {
  const rng = mulberry32(11);
  for (const [type, mod] of Object.entries(MODS)) {
    assert.equal(mod.TYPE, type);
    for (let i = 0; i < 150; i++) {
      const params = mod.generate(rng, optionsFor(type, rng));
      const item = mod.build(params);
      assert.equal(item.type, type);
      assert.ok(LEVELS.includes(item.level));
      assert.ok(SPECS.some((s) => s.id === item.spec), `spec ${item.spec}`);
      assert.ok(['add', 'shift', 'twos', 'flags', 'c'].includes(item.family));
      assert.ok(item.prompt.length > 10);
      assert.ok(item.fields.length >= 1);
      const m = mod.mark(item, item.key);
      assert.equal(m.correct, true, `${type} key must mark correct: ${JSON.stringify(params)}`);
      assert.equal(m.firstWrong, null);
      assert.equal(m.score.right, m.score.total);
      const d = runFlow(mod, item, item.key);
      assert.equal(d.tag, null);
      assert.equal(d.steps, 0);
      const blank = mod.blank(item);
      const leaves = (x) => (x && typeof x === 'object' ? Object.values(x).flatMap(leaves) : [x]);
      assert.ok(leaves(blank).every((x) => x === null), `blank must be all null: ${JSON.stringify(blank)}`);
      for (const f of item.fields) assert.ok(f.id in blank, `blank has field ${f.id}`);
      assert.equal(mod.mark(item, blank).correct, false);
      assert.deepEqual(mod.build(params).key, item.key, 'build is deterministic');
    }
  }
});

test('golden examples', () => {
  const it = add.build({ w: 8, a: 200, b: 65, ask: 'full' });
  assert.equal(it.key.overflow, 'yes');
  const layers = add.why(it, null, { level: 'gcse' });
  assert.equal(layers[0].say[0], 'In 8 bits, 200 + 65 gives 9 because the carry worth 256 is dropped.');
  assert.deepEqual(layers.map((l) => l.kind), ['columns', 'column']);
  const three = add.columnLayer(3, 1, 1, 1);
  assert.match(three.say.join(' '), /1 \+ 1 \+ carry 1 = 3, which is 11 in binary\. Write 1 and carry 1/);
  assert.deepEqual(twos.build({ w: 8, n: -5, task: 'encode' }).key.bits, B(0b11111011, 8));
  assert.deepEqual(shift.build({ w: 8, x: 0b10110100, dir: 'L', k: 2, kind: 'logical', askValue: true }).key, { bits: B(0b11010000, 8), value: 208 });
  const s = sadd.build({ w: 8, a: 127, b: 1, op: '+', askFlags: ['CF', 'ZF', 'SF', 'OF'] });
  assert.deepEqual(s.key.flags, { CF: 0, ZF: 0, SF: 1, OF: 1 });
  assert.deepEqual(sadd.build({ w: 8, a: 3, b: 5, op: '-', askFlags: ['CF'] }).key.flags, { CF: 1 });
  assert.deepEqual(fa.build({ a: 1, b: 1, cin: 1, wires: true }).key, { sum: 1, cout: 1, x1: 0, a1: 1, a2: 0 });
});

// ---------------------------------------------------------------------------
// Misconception diagnosis: every tag, ≥ 200 targeted items each
// ---------------------------------------------------------------------------

const TAG_CASES = [
  ...add.TARGETS.flatMap((tag) => [['add', tag, { ask: 'full' }], ...(tag === 'add_carry_wrong_col' ? [] : [['add', tag, { ask: 'result' }]])]),
  ...shift.TARGETS.flatMap((tag) => [['shift', tag, { level: 'gcse', kind: 'logical' }], ['shift', tag, { level: 'alevel', kind: 'mixed' }]]),
  ...twos.TARGETS.map((tag) => ['twos', tag, { level: 'alevel' }]),
  ...sadd.TARGETS.flatMap((tag) => [['sadd', tag, { level: 'alevel', askFlags: ['OF'] }], ['sadd', tag, { level: 'csapp' }]]),
  ...fa.TARGETS.map((tag) => ['fa', tag, { level: 'alevel' }]),
];

for (const [type, tag, opts] of TAG_CASES) {
  test(`diagnosis: ${type} ${tag} ${JSON.stringify(opts)}`, (t) => {
    const mod = MODS[type];
    const rng = mulberry32(0x5eed ^ TAG_IDS.indexOf(tag) ^ (type.length << 8) ^ JSON.stringify(opts).length);
    let differs = 0;
    let hits = 0;
    const misses = [];
    for (let i = 0; i < N; i++) {
      const params = mod.generate(rng, { ...opts, target: tag });
      const item = mod.build(params);
      const { answer, reply } = STUDENTS[type](item, tag, rng);
      if (mod.mark(item, answer).correct) continue;
      differs++;
      const d = runFlow(mod, item, answer, reply);
      assert.ok(d.steps <= 3);
      assert.ok(sentences(d.detail) <= 2, `detail ≤ 2 sentences: ${d.detail}`);
      assert.equal(typeof d.headline, 'string');
      if (d.tag === tag) hits++;
      else if (misses.length < 3) misses.push({ params, answer, got: d.tag });
    }
    t.diagnostic(`${hits}/${differs} diagnosed as ${tag}`);
    assert.ok(differs >= N * 0.9, `the misconception should change most targeted answers (${differs}/${N})`);
    assert.ok(hits / differs >= 0.95, `${tag}: ${hits}/${differs}; e.g. ${JSON.stringify(misses)}`);
  });
}

test('every binary tag is targetable by some item type', () => {
  const targetable = new Set(Object.values(MODS).flatMap((m) => m.TARGETS));
  for (const id of TAG_IDS) {
    if (id && /^(add|shift|twos|flags)_/.test(id)) assert.ok(targetable.has(id), id);
  }
});

// ---------------------------------------------------------------------------
// Checkpoint flows on arbitrary wrong answers
// ---------------------------------------------------------------------------

test('checkpoint flows: ≤ 3 questions and a classification, whatever the learner says', () => {
  const rng = mulberry32(99);
  const known = new Set([null, 'other', ...TAG_IDS.filter((x) => x && /^(add|flags)_/.test(x))]);
  for (let i = 0; i < 600; i++) {
    const type = pick(rng, ['add', 'sadd']);
    const mod = MODS[type];
    const params = mod.generate(rng, { ...optionsFor(type, rng), ask: 'result' });
    const item = mod.build(params);
    const w = item.params.w;
    const noise = () => Array.from({ length: w }, () => (rng() < 0.5 ? 1 : 0));
    const answer = type === 'add'
      ? { carries: new Array(w + 1).fill(null), result: [...noise(), null], overflow: pick(rng, ['yes', 'no']) }
      : { bits: noise(), flags: Object.fromEntries(item.show.askFlags.map((f) => [f, rng() < 0.5 ? 1 : 0])) };
    const reply = (cp) => (cp.input.kind === 'bit' ? (rng() < 0.5 ? 1 : 0) : [rng() < 0.5 ? 1 : 0, rng() < 0.5 ? 1 : 0]);
    const d = runFlow(mod, item, answer, reply);
    assert.ok(d.steps <= 3);
    assert.ok(known.has(d.tag), `unexpected tag ${d.tag}`);
    if (!mod.mark(item, answer).correct) assert.notEqual(d.tag, null, 'a wrong answer always gets a tag (other when unclassified)');
  }
});

test('full addition grids are diagnosed with no checkpoints', () => {
  const rng = mulberry32(5);
  for (let i = 0; i < 200; i++) {
    const tag = pick(rng, add.TARGETS);
    const item = add.build(add.generate(rng, { target: tag, ask: 'full' }));
    const { answer } = addAnswer(item, tag, rng);
    const r = add.diagnose(item, answer, add.mark(item, answer), []);
    assert.equal(r.next, null);
    assert.ok(r.diagnosis);
  }
});

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

test('variant(item, tag) gives new numbers that the same buggy student gets wrong', () => {
  const rng = mulberry32(21);
  for (const [type, tag, opts] of TAG_CASES) {
    const mod = MODS[type];
    let wrong = 0;
    for (let i = 0; i < 30; i++) {
      const base = mod.build(mod.generate(rng, opts));
      const params = mod.variant(base, tag, rng);
      const item = mod.build(params);
      assert.notDeepEqual(params, base.params, `${type} ${tag}: variant must change the item`);
      const { answer } = STUDENTS[type](item, tag, rng);
      if (!mod.mark(item, answer).correct) wrong++;
    }
    assert.ok(wrong >= 29, `${type} ${tag}: buggy student wrong on ${wrong}/30 variants`);
  }
});

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

test('encodeParams / decodeParams round-trip with small non-negative ints', () => {
  const rng = mulberry32(3);
  for (const [type, mod] of Object.entries(MODS)) {
    for (let i = 0; i < 300; i++) {
      const opts = optionsFor(type, rng);
      if (rng() < 0.3) delete opts.level;
      const tag = rng() < 0.5 ? pick(rng, mod.TARGETS) : undefined;
      const params = mod.generate(rng, { ...opts, target: tag });
      const ints = mod.encodeParams(params);
      for (const n of ints) assert.ok(Number.isInteger(n) && n >= 0 && n < 2 ** 17, `${type}: ${ints}`);
      assert.deepEqual(mod.decodeParams(ints), params);
      assert.deepEqual(mod.build(mod.decodeParams(ints)).key, mod.build(params).key);
    }
  }
});

// ---------------------------------------------------------------------------
// Why layers
// ---------------------------------------------------------------------------

const KINDS = new Set(['line', 'asm', 'regs', 'flags', 'columns', 'column', 'adder', 'shift', 'twos', 'text']);
const isBit = (x) => x === 0 || x === 1;
const isBits = (a, n) => Array.isArray(a) && a.length === n && a.every(isBit);

function checkLayer(layer, level) {
  assert.ok(KINDS.has(layer.kind), `kind ${layer.kind}`);
  assert.equal(typeof layer.id, 'string');
  assert.equal(typeof layer.title, 'string');
  assert.ok(Array.isArray(layer.say) && layer.say.length >= 1);
  const said = layer.say.join(' ');
  assert.ok(sentences(said) <= 2, `say ≤ 2 sentences: ${said}`);
  assert.ok(!/undefined|NaN|null/.test(said), said);
  const d = layer.data;
  assert.equal(typeof d, 'object');
  if (level === 'gcse') assert.notEqual(layer.kind, 'adder', 'GCSE layers stop at column');
  switch (layer.kind) {
    case 'columns': {
      const { w } = d;
      assert.ok(isBits(d.a, w) && isBits(d.b, w) && isBits(d.result, w));
      assert.equal(d.carries.length, w + 1);
      assert.ok(d.carries.slice(1).every(isBit));
      assert.ok(d.carries[0] === null || isBit(d.carries[0]));
      assert.ok(Number.isInteger(d.highlight) && d.highlight >= 0 && d.highlight < w);
      assert.equal(typeof d.dropped, 'boolean');
      assert.equal(typeof d.signed, 'boolean');
      assert.ok(['+', '-'].includes(d.op));
      for (const k of ['a', 'b', 'r']) assert.equal(typeof d.labels[k], 'string');
      // the columns must be a real addition: check it
      const r = bits.addBits(d.a, d.b, w, d.carries[0] ?? 0);
      assert.deepEqual(r.result, d.result);
      assert.deepEqual(r.carries.slice(1), d.carries.slice(1));
      assert.equal(d.dropped, r.cout === 1);
      break;
    }
    case 'column': {
      for (const k of ['a', 'b', 'cin', 'sum', 'cout']) assert.ok(isBit(d[k]), k);
      assert.equal(d.sum + 2 * d.cout, d.a + d.b + d.cin);
      assert.ok(Number.isInteger(d.k));
      break;
    }
    case 'adder': {
      for (const k of ['a', 'b', 'cin', 'x1', 'a1', 'a2', 'sum', 'cout']) assert.ok(isBit(d[k]), k);
      assert.equal(d.x1, d.a ^ d.b);
      assert.equal(d.a1, d.a & d.b);
      assert.equal(d.a2, d.x1 & d.cin);
      assert.equal(d.sum, d.x1 ^ d.cin);
      assert.equal(d.cout, d.a1 | d.a2);
      break;
    }
    case 'shift': {
      assert.ok(isBits(d.before, d.w) && isBits(d.after, d.w));
      assert.ok(['L', 'R'].includes(d.dir) && Number.isInteger(d.k) && isBit(d.fill));
      assert.ok(Array.isArray(d.lost) && d.lost.length === d.k);
      break;
    }
    case 'twos': {
      assert.ok(Array.isArray(d.steps) && d.steps.length >= 1);
      for (const s of d.steps) { assert.equal(typeof s.label, 'string'); assert.ok(isBits(s.bits, d.w)); }
      break;
    }
    case 'flags': {
      for (const k of ['CF', 'ZF', 'SF', 'OF']) assert.ok(isBit(d[k]), k);
      for (const [k, s] of Object.entries(d.why)) {
        assert.ok(['CF', 'ZF', 'SF', 'OF'].includes(k));
        assert.equal(sentences(s), 1, `flag why is one sentence: ${s}`);
      }
      break;
    }
    default: break;
  }
}

test('why layers are valid at every level, for right and wrong answers', () => {
  const rng = mulberry32(8);
  for (const [type, mod] of Object.entries(MODS)) {
    for (let i = 0; i < 120; i++) {
      const tag = rng() < 0.7 ? pick(rng, mod.TARGETS) : null;
      const params = mod.generate(rng, { ...optionsFor(type, rng), target: tag });
      const item = mod.build(params);
      const answers = [{ answer: item.key, reply: () => null }];
      if (tag) answers.push(STUDENTS[type](item, tag, rng));
      for (const { answer, reply } of answers) {
        const diagnosis = runFlow(mod, item, answer, reply);
        for (const level of LEVELS) {
          const layers = mod.why(item, diagnosis, { level });
          assert.ok(Array.isArray(layers) && layers.length >= 1);
          const ids = new Set();
          for (const l of layers) { checkLayer(l, level); assert.ok(!ids.has(l.id), `duplicate layer id ${l.id}`); ids.add(l.id); }
        }
        // the null diagnosis (not yet diagnosed) must also work
        for (const l of mod.why(item, null, { level: item.level })) checkLayer(l, item.level);
      }
    }
  }
});

test('why layers follow the contract order for each topic', () => {
  const rng = mulberry32(4);
  const kinds = (mod, item, level, d = null) => mod.why(item, d, { level }).map((l) => l.kind);
  const a = add.build(add.generate(rng, {}));
  assert.deepEqual(kinds(add, a, 'gcse'), ['columns', 'column']);
  assert.deepEqual(kinds(add, a, 'alevel'), ['columns', 'column', 'adder']);
  const s = shift.build(shift.generate(rng, {}));
  assert.equal(kinds(shift, s, 'gcse')[0], 'shift');
  assert.ok(kinds(shift, s, 'gcse').includes('text'));
  const t = twos.build({ w: 8, n: -37, task: 'encode' });
  assert.deepEqual(kinds(twos, t, 'alevel').slice(0, 2), ['twos', 'columns']);
  const sa = sadd.build(sadd.generate(rng, { level: 'csapp' }));
  assert.deepEqual(kinds(sadd, sa, 'csapp'), ['columns', 'flags', 'adder']);
  const f = fa.build({ a: 1, b: 0, cin: 1, wires: true });
  assert.deepEqual(kinds(fa, f, 'alevel'), ['column', 'adder']);
});

// ---------------------------------------------------------------------------
// BINARY_TAGS
// ---------------------------------------------------------------------------

test('BINARY_TAGS: every binary tag is complete, short and generates worked examples', () => {
  const ids = TAG_IDS.filter((x) => x && /^(add|shift|twos|flags)_/.test(x));
  assert.equal(ids.length, 20);
  assert.deepEqual(Object.keys(BINARY_TAGS).sort(), ids.slice().sort());
  for (const id of ids) {
    const t = BINARY_TAGS[id];
    assert.ok(t.label.length > 0 && t.label.length <= 40, `${id} label: ${t.label}`);
    assert.ok(sentences(t.student) <= 2, `${id} student: ${t.student}`);
    assert.match(t.student, /\b[Yy]ou/, `${id} student text is second person`);
    assert.equal(sentences(t.fix), 1, `${id} fix: ${t.fix}`);
    for (let seed = 1; seed <= 12; seed++) {
      const ex = t.worked(mulberry32(seed * 7919));
      assert.equal(typeof ex.title, 'string');
      assert.ok(ex.steps.length >= 3 && ex.steps.length <= 6, `${id}: ${ex.steps.length} steps`);
      for (const s of ex.steps) {
        assert.ok(typeof s.subgoal === 'string' && s.subgoal.length > 0);
        assert.ok(typeof s.text === 'string' && s.text.length > 0);
        assert.ok(!/undefined|NaN|null/.test(s.text + s.subgoal), s.text);
        if (s.layer) checkLayer(s.layer, 'alevel');
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test('items/index.js: registry, spec points and tag targeting', async () => {
  const card = await import('../machine/src/learn/cards.js');
  assert.deepEqual(Object.keys(registry.ITEM_TYPES).sort(), ['add', 'card', 'fa', 'sadd', 'shift', 'twos']);
  for (const [type, mod] of Object.entries(registry.ITEM_TYPES)) {
    assert.equal(registry.typeById(mod.TYPE_ID), mod);
    assert.equal(mod.TYPE, type);
  }
  assert.equal(registry.typeById(99), null);
  const rng = mulberry32(17);
  for (const spec of SPECS) {
    if (spec.make.type === 'card' && !(card.CARDS && card.CARDS.length)) continue;  // cards not built yet
    const { type, params } = registry.itemForSpec(spec.id, rng);
    assert.equal(type, spec.make.type);
    const item = registry.makeItem(type, params);
    assert.equal(item.type, type);
    if (type !== 'card') assert.equal(item.level, spec.level, spec.id);
    if (type !== 'card') assert.equal(item.spec, spec.id, spec.id);
  }
  for (const id of Object.keys(BINARY_TAGS)) {
    const r = registry.itemForTag(id, rng, { level: 'alevel' });
    assert.ok(r, id);
    assert.ok(registry.ITEM_TYPES[r.type].TARGETS.includes(id));
    const item = registry.makeItem(r.type, r.params);
    const { answer } = STUDENTS[r.type](item, id, rng);
    assert.equal(registry.ITEM_TYPES[r.type].mark(item, answer).correct, false, `${id} item must trip the student`);
  }
  assert.equal(registry.itemForTag('add_three_ones', rng, { type: 'fa' }).type, 'fa');
  assert.equal(registry.itemForTag('add_or', rng, { type: 'sadd' }).type, 'sadd');
  assert.equal(registry.itemForTag('twos_range', rng, { type: 'fa' }).type, 'twos', 'falls back to the owning type');
  assert.equal(registry.itemForTag(null, rng), null);
  assert.equal(registry.itemForTag('trace_value', rng), null);
});
