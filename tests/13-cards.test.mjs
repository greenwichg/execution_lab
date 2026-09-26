// Predict the Machine's CS:APP cards and paste mode
// (machine/src/learn/cards.js, ctags.js, paste.js):
//   · every card, canonical and 100 variants each, gives exactly what gcc -O0
//     -fwrapv gives for the same snippet (flags checked through inline asm), and
//     every instruction a card's gcc text names is in gcc -O0 -S's real output
//   · labels are short, std.status is one of the allowed three, texts ≤ 2 sentences
//   · the classic wrong answers (written here, independently of the module)
//     get the intended misconception tag; checkpoint flows finish in ≤ 3
//   · Why layers are well-formed and their asm rows carry the engine's bytes
//   · paste bisection finds a planted divergence in ≤ 3 checkpoints
// (gcc checks are skipped automatically when gcc is missing)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import * as cards from '../machine/src/learn/cards.js';
import { C_TAGS } from '../machine/src/learn/ctags.js';
import { BINARY_TAGS } from '../machine/src/learn/tags.js';
import { TAG_IDS } from '../machine/src/learn/tagids.js';
import { TAGS, missingTags } from '../machine/src/learn/catalogue.js';
import { specById } from '../machine/src/learn/spec.js';
import * as registry from '../machine/src/learn/items/index.js';
import { analyzePaste, markOutput, diagnosePaste, whyPaste } from '../machine/src/learn/paste.js';
import { compile, CError } from '../machine/src/engine/minic.js';
import { addBits } from '../machine/src/engine/bits.js';
import { mulberry32 } from '../machine/src/lib/rng.js';

const VARIANTS = 100;
const have = (cmd) => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };
const HAVE_GCC = have('gcc');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cards-'));

/** sentences in a string: terminal punctuation followed by space or the end */
const sentences = (s) => (String(s).trim().match(/[.!?](?=\s|$)/g) || []).length || 1;
const norm = (s) => String(s).replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
const isBit = (b) => b === 0 || b === 1;
// template slips show up as NaN / null / undefined; "undefined behaviour" and friends are real words here
const ALLOWED_UNDEF = /undefined behaviour|calls this undefined|is undefined|SF and ZF undefined|are undefined|undefined after|undefined by|undefined, but/g;
const junk = (s) => /NaN|\bnull\b|\[object|undefined/.test(String(s).replace(ALLOWED_UNDEF, ''));
const KINDS = new Set(['line', 'asm', 'regs', 'flags', 'columns', 'column', 'adder', 'shift', 'twos', 'text']);
const ALLOWED_STATUS = new Set(['defined', 'implementation-defined', 'undefined']);

/** every instance the tests look at: v = 0 … VARIANTS for each card */
const INSTANCES = cards.CARDS.flatMap((c) => Array.from({ length: VARIANTS + 1 }, (_, v) => cards.build({ id: c.id, v })));

/** run diagnose the way the UI does, replying to checkpoints */
function runFlow(item, answer, reply = () => null) {
  const cps = [];
  for (let n = 0; n <= 3; n++) {
    const r = cards.diagnose(item, answer, cards.mark(item, answer), cps);
    if (!r.next) {
      assert.ok(r.diagnosis, 'diagnose must return a checkpoint or a diagnosis');
      return { ...r.diagnosis, steps: n };
    }
    assert.ok(n < 3, 'more than 3 checkpoints');
    for (const k of ['id', 'prompt', 'input']) assert.ok(r.next[k] !== undefined, `checkpoint missing ${k}`);
    assert.ok('answer' in r.next);
    cps.push(reply(r.next));
  }
  throw new Error('unreachable');
}

// ---------------------------------------------------------------------------
// Deck shape
// ---------------------------------------------------------------------------

test('CARDS: 12 cards, ordered by CS:APP section, short titles, unique ids', () => {
  assert.equal(cards.CARDS.length, 12);
  assert.equal(cards.TYPE, 'card');
  assert.equal(cards.TYPE_ID, 5);
  const key = (s) => s.replace('CS:APP ', '').split('.').map(Number);
  for (let i = 1; i < cards.CARDS.length; i++) {
    const a = key(cards.CARDS[i - 1].section), b = key(cards.CARDS[i].section);
    const cmp = a[0] - b[0] || a[1] - b[1] || (a[2] ?? 0) - (b[2] ?? 0);
    assert.ok(cmp <= 0, `${cards.CARDS[i - 1].id} before ${cards.CARDS[i].id}`);
  }
  assert.equal(new Set(cards.CARDS.map((c) => c.id)).size, 12);
  for (const c of cards.CARDS) {
    assert.match(c.section, /^CS:APP \d+\.\d+(\.\d+)?$/);
    assert.ok(c.title.length > 0 && c.title.length <= 40, c.title);
    assert.ok(specById(c.spec), `${c.id}: spec ${c.spec}`);
    assert.ok(c.tags.length > 0 && c.tags.every((t) => TAG_IDS.includes(t)), c.id);
  }
  // the concepts the deck promises
  const kinds = new Set(cards.CARDS.map((c) => c.ask));
  for (const k of ['output', 'value', 'flags', 'branch']) assert.ok(kinds.has(k), `a card asks for ${k}`);
});

test('every built card: fields, key, std/gcc labels and item shape', () => {
  for (const item of INSTANCES) {
    const c = item.card;
    const name = `${c.id} v${item.params.v}`;
    assert.equal(item.type, 'card');
    assert.equal(item.family, 'c');
    assert.equal(item.level, 'csapp');
    assert.ok(specById(item.spec), name);
    assert.ok(ALLOWED_STATUS.has(c.std.status), `${name}: ${c.std.status}`);
    for (const t of [c.std.text, c.gcc]) {
      assert.ok(t.length > 20 && sentences(t) <= 2, `${name}: ≤ 2 sentences: ${t}`);
      assert.ok(!junk(t), t);
    }
    assert.ok(['output', 'value', 'flags', 'branch'].includes(c.ask.kind));
    assert.equal(item.fields.length, 1);
    assert.ok(item.prompt.length > 0 && sentences(item.prompt) <= 2, item.prompt);
    assert.ok(c.src.split('\n').length <= 8, `${name}: ≤ 8 lines`);
    assert.doesNotThrow(() => compile(c.src), name);                 // within the 30-line / 72-column limits
    // the key is marked correct, and a blank answer is not
    assert.equal(cards.mark(item, item.key).correct, true, name);
    assert.equal(cards.mark(item, cards.blank(item)).correct, false, name);
    const d = cards.diagnose(item, item.key, cards.mark(item, item.key), []);
    assert.equal(d.diagnosis.tag, null);
    // params round-trip through the URL codes
    const ints = cards.encodeParams(item.params);
    assert.ok(ints.every((n) => Number.isInteger(n) && n >= 0));
    assert.deepEqual(cards.decodeParams(ints), item.params);
  }
});

test('the std status matches the concept of each canonical card', () => {
  const want = {
    'char-200': 'implementation-defined', 'minus-one-vs-unsigned': 'defined', 'uchar-promotion': 'defined',
    'short-truncation': 'implementation-defined', 'unsigned-wrap': 'defined', 'int-max-plus-one': 'undefined',
    'int-multiply-overflow': 'undefined', 'negative-shift-right': 'implementation-defined', 'truncating-division': 'defined',
    'unsigned-shift-right': 'defined', 'signed-unsigned-branch': 'defined', 'flags-after-cmp': 'defined',
  };
  for (const c of cards.CARDS) assert.equal(cards.build({ id: c.id, v: 0 }).card.std.status, want[c.id], c.id);
  // canonical answers from the brief (computed by the engine, checked here by hand)
  const key = (id) => cards.build({ id, v: 0 }).key;
  assert.equal(key('int-max-plus-one').output, '-2147483648');
  assert.equal(key('minus-one-vs-unsigned').output, '0');
  assert.equal(key('negative-shift-right').output, '-4');
  assert.equal(key('unsigned-shift-right').output, '2147483644');
  assert.equal(key('truncating-division').output, '-3 -1');
  assert.equal(key('char-200').output, '-56');
  assert.equal(key('uchar-promotion').value, 300);
  assert.equal(key('unsigned-wrap').output, '4294967295');
  assert.equal(key('short-truncation').value, 4464);
  assert.equal(key('int-multiply-overflow').output, '0');
  assert.equal(key('signed-unsigned-branch').branch, 'not less');
  assert.deepEqual(key('flags-after-cmp').flags, { CF: 0, ZF: 0, SF: 1, OF: 0 });
  // the compiler really uses the instructions the cards talk about
  const texts = (id) => cards.build({ id, v: 0 }).sim.prog.insts.map((i) => i.text.split(' ')[0]);
  assert.ok(texts('minus-one-vs-unsigned').includes('setb'));
  assert.ok(texts('signed-unsigned-branch').includes('jae'));
  assert.ok(texts('negative-shift-right').includes('sar'));
  assert.ok(texts('unsigned-shift-right').includes('shr'));
  assert.ok(texts('truncating-division').includes('idiv'));
  assert.ok(texts('char-200').includes('movsx'));
  assert.ok(texts('uchar-promotion').includes('movzx'));
  assert.ok(texts('int-multiply-overflow').includes('imul'));
});

// ---------------------------------------------------------------------------
// gcc agreement
// ---------------------------------------------------------------------------

/** compile a batch of snippets into one program; each block's output ends with a marker */
function gccBatch(name, snippets) {
  const body = snippets.map((s) => `{\n${s.split('\n').filter((l) => !l.startsWith('#')).join('\n')}\n}\nprintf("@@\\n");`);
  const src = ['#include <stdio.h>', '#include <limits.h>', 'int main(void) {', ...body, 'return 0;', '}', ''].join('\n');
  const c = path.join(tmp, `${name}.c`), exe = path.join(tmp, name);
  fs.writeFileSync(c, src);
  execFileSync('gcc', ['-O0', '-fwrapv', '-w', '-o', exe, c]);
  const out = execFileSync(exe, { encoding: 'utf8' });
  return out.split('@@\n').slice(0, snippets.length);
}

test('every card and variant: the engine\'s answer is what gcc -O0 -fwrapv prints', { skip: !HAVE_GCC && 'gcc not installed' }, () => {
  for (const c of cards.CARDS) {
    const items = INSTANCES.filter((it) => it.params.id === c.id);
    const outs = gccBatch(c.id.replace(/\W/g, '_'), items.map((it) => it.card.src));
    items.forEach((it, k) => {
      const name = `${c.id} v${it.params.v}`;
      const g = outs[k];
      assert.equal(it.sim.res.output, g, `${name}: engine stdout = gcc stdout`);
      switch (it.card.ask.kind) {
        case 'output': assert.equal(it.key.output, norm(g), name); break;
        case 'value': assert.equal(String(it.key.value), norm(g), name); break;
        case 'branch': assert.equal(it.key.branch, norm(g), name); assert.ok(it.card.ask.choices.includes(it.key.branch)); break;
        case 'flags': break;                                          // checked by the inline-asm test below
        default: assert.fail(it.card.ask.kind);
      }
    });
  }
});

test('flags cards: CF ZF SF OF after cmp match the real CPU (gcc inline asm)', { skip: !HAVE_GCC && 'gcc not installed' }, () => {
  const items = INSTANCES.filter((it) => it.card.ask.kind === 'flags');
  const blocks = items.map(({ sim: { vals: { a, b } } }) => [
    `int a = ${a}, b = ${b};`, 'unsigned long fl;',
    '__asm__ volatile("cmpl %2, %1\\n\\tpushfq\\n\\tpopq %0" : "=r"(fl) : "r"(a), "r"(b) : "cc");',
    'printf("%lu %lu %lu %lu\\n", fl & 1, (fl >> 6) & 1, (fl >> 7) & 1, (fl >> 11) & 1);',
  ].join('\n'));
  const outs = gccBatch('flags', blocks);
  items.forEach((it, k) => {
    const [CF, ZF, SF, OF] = outs[k].trim().split(' ').map(Number);
    assert.deepEqual(it.key.flags, { CF, ZF, SF, OF }, `a=${it.sim.vals.a} b=${it.sim.vals.b}`);
  });
  // the variants cover every flag in both states
  for (const f of ['CF', 'ZF', 'SF', 'OF']) {
    assert.ok(items.some((it) => it.key.flags[f] === 1) && items.some((it) => it.key.flags[f] === 0), `${f} varies`);
  }
});

/** gcc -O0 -S -masm=intel for a batch of snippets, one function each → the asm lines of each */
function gccAsm(name, snippets) {
  const fns = snippets.map((s, k) => `int f${k}(void) {\n${s.split('\n').filter((l) => !l.startsWith('#')).join('\n')}\nreturn 0;\n}`);
  const c = path.join(tmp, `${name}-asm.c`), out = path.join(tmp, `${name}.s`);
  fs.writeFileSync(c, ['#include <stdio.h>', '#include <limits.h>', ...fns, ''].join('\n'));
  execFileSync('gcc', ['-O0', '-S', '-masm=intel', '-w', '-fno-asynchronous-unwind-tables', '-o', out, c]);
  const parts = fs.readFileSync(out, 'utf8').split(/^f(\d+):$/m);
  const res = [];
  for (let k = 1; k < parts.length; k += 2) res[Number(parts[k])] = parts[k + 1].split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('.'));
  return res;
}
const MNEMONICS = ['add', 'sub', 'imul', 'idiv', 'cdq', 'sar', 'shr', 'movsx', 'movzx', 'cmp', 'setb', 'seta', 'setl', 'setg', 'jnb', 'jae', 'jbe', 'jb', 'ja', 'jge', 'jl', 'jle', 'jg'];
const ALIAS = { jae: 'jnb', setae: 'setnb' };            // gcc -S prints jae as jnb (same opcode)

test("every instruction a card's gcc text names is in gcc -O0's real assembly", { skip: !HAVE_GCC && 'gcc not installed' }, () => {
  let checked = 0;
  for (const c of cards.CARDS) {
    const items = INSTANCES.filter((it) => it.params.id === c.id);
    const asm = gccAsm(c.id.replace(/\W/g, '_'), items.map((it) => it.card.src));
    items.forEach((it, k) => {
      const name = `${c.id} v${it.params.v}`;
      // the road not taken ("would have used setl", "rather than the signed jge") is not a claim about gcc's code
      const claims = it.card.gcc.replace(/(would have used|rather than the signed) \w+/g, '');
      const named = MNEMONICS.filter((m) => new RegExp(`\\b${m}\\b`).test(claims));
      const ops = new Set(asm[k].map((l) => l.split(/\s+/)[0]).map((m) => ALIAS[m] || m));
      assert.ok(named.length >= 1, `${name}: the gcc text names an instruction: ${it.card.gcc}`);
      for (const m of named) assert.ok(ops.has(ALIAS[m] || m), `${name}: gcc text names ${m}, but gcc emits ${[...ops].join(' ')}`);
      // the operand order the text states (gcc turns unsigned a > b into b < a)
      if (/cmp b, a/.test(claims)) assert.ok(asm[k].some((l) => /^cmp\s+DWORD PTR -?\d+\[rbp\], eax$/.test(l)), `${name}: cmp b, a`);
      if (/writes only ax/.test(claims)) assert.ok(asm[k].some((l) => /^mov\s+WORD PTR -?\d+\[rbp\], ax$/.test(l)), `${name}: a 16-bit store of ax`);
      if (/cmp a, b/.test(claims)) assert.ok(asm[k].some((l) => /^cmp\s+eax, DWORD PTR -?\d+\[rbp\]$/.test(l)), `${name}: cmp a, b`);
      // "the two printed values come straight from those registers": both / and % use idiv
      if (c.id === 'truncating-division') assert.equal(asm[k].filter((l) => l.startsWith('idiv')).length, 2, `${name}: two idivs`);
      checked += named.length;
    });
  }
  assert.ok(checked > 1500, `${checked} instruction claims checked`);
  // the "signed" alternatives the texts name are what gcc uses when both operands are int
  const alt = gccAsm('signed-alt', [
    'int a = -1; int b = 0; printf("%d\\n", a < b);', 'int a = -1; int b = 0; printf("%d\\n", a > b);',
    'int a = -1; int b = 0; if (a < b) printf("x\\n");', 'int a = -1; int b = 0; if (a > b) printf("x\\n");',
  ]);
  ['setl', 'setg', 'jge', 'jle'].forEach((m, k) => assert.ok(alt[k].some((l) => l.startsWith(`${m}\t`) || l.startsWith(`${m} `)), `${m} for signed ints`));
});

test('variants keep the concept: new constants, same trap', () => {
  for (const c of cards.CARDS) {
    const items = INSTANCES.filter((it) => it.params.id === c.id);
    const srcs = new Set(items.map((it) => it.card.src));
    assert.ok(srcs.size >= 20, `${c.id}: ${srcs.size} distinct variants`);
    for (const it of items) {
      const v = it.sim.vals, name = `${c.id} v${it.params.v}`;
      const out = it.key.output, val = it.key.value;
      switch (c.id) {
        case 'char-200': assert.ok(v.n >= 128 && v.n <= 255 && Number(out) < 0, name); break;
        case 'minus-one-vs-unsigned': assert.notEqual(Number(out), v.op === '<' ? Number(-v.k < v.m) : Number(-v.k > v.m), name); break;
        case 'uchar-promotion': assert.ok(val > 255, name); break;
        case 'short-truncation': assert.notEqual(val, v.i, name); break;
        case 'unsigned-wrap': assert.ok(Number(out) > 4294967295 - 30, name); break;
        case 'int-max-plus-one': assert.ok(Number(out) < 0 && v.x + v.d > 2147483647, name); break;
        case 'int-multiply-overflow': assert.ok(BigInt(v.a) * BigInt(v.b ?? v.a) > 2147483647n && BigInt(out) !== BigInt(v.a) * BigInt(v.b ?? v.a), name); break;
        case 'negative-shift-right': assert.ok(v.x < 0 && Number(out) < 0, name); break;
        case 'truncating-division': {
          // signs differ and nothing divides exactly, so truncating and flooring always disagree
          assert.ok(v.a > 0 && v.b < 0 && v.c < 0 && v.d > 0 && v.a % v.b !== 0 && v.c % v.d !== 0, name);
          assert.notEqual(out, `${Math.floor(v.a / v.b)} ${((v.c % v.d) + v.d) % v.d}`, name);
          break;
        }
        case 'unsigned-shift-right': assert.ok(v.u >= 0x80000000 && Number(out) < 0x80000000, name); break;
        case 'signed-unsigned-branch': {
          assert.equal(it.key.branch, v.op === '<' ? 'not less' : 'greater', name);
          const signedTrue = v.op === '<' ? -v.k < v.m : -v.k > v.m;          // what a signed reading prints
          assert.notEqual(it.key.branch, signedTrue ? it.card.ask.choices[0] : it.card.ask.choices[1], name);
          break;
        }
        case 'flags-after-cmp': assert.ok(Number.isInteger(v.a) && Number.isInteger(v.b) && Math.abs(v.a) <= 2147483647 && Math.abs(v.b) <= 2147483647, name); break;
        default: assert.fail(c.id);
      }
      // the C standard's verdict is a property of the concept, so it never changes between variants
      assert.equal(it.card.std.status, cards.build({ id: c.id, v: 0 }).card.std.status, name);
    }
  }
  // the flags card reaches every interesting case: a borrow without overflow, overflow both ways, equality
  const fl = INSTANCES.filter((it) => it.params.id === 'flags-after-cmp').map((it) => it.key.flags);
  assert.ok(fl.some((f) => f.CF && !f.OF) && fl.some((f) => f.OF && f.SF) && fl.some((f) => f.OF && !f.SF) && fl.some((f) => f.ZF), 'flag cases covered');
});

// ---------------------------------------------------------------------------
// Diagnosis: independent "buggy students"
// ---------------------------------------------------------------------------

const TWO32 = 4294967296;
const wrap32 = (x) => { const u = ((x % TWO32) + TWO32) % TWO32; return u >= 2 ** 31 ? u - TWO32 : u; };

/** the answers a learner holding each misconception gives, with the tag we expect */
function classicStudents(item) {
  const v = item.sim.vals;
  const out = (s) => ({ output: String(s) });
  const S = [];
  switch (item.params.id) {
    case 'char-200': S.push([out(v.n), 'c_char_signedness'], [out(127), 'c_narrowing']); break;
    case 'minus-one-vs-unsigned': S.push([out(v.op === '<' ? 1 : 0), 'c_usual_conversions']); break;
    case 'uchar-promotion': S.push([{ value: (v.a + v.b) % 256 }, 'c_promotion']); break;
    case 'short-truncation': S.push([{ value: v.i }, 'c_narrowing'], [{ value: 32767 }, 'c_narrowing']); break;
    case 'unsigned-wrap': S.push([out(v.k - v.m), 'c_unsigned_wrap'], [out(0), 'c_unsigned_wrap']); break;
    case 'int-max-plus-one': S.push([out(v.x + v.d), 'c_signed_overflow'], [out('error'), 'c_signed_overflow'], [out('overflow'), 'c_signed_overflow']); break;
    case 'int-multiply-overflow': S.push([out(v.a * (v.b ?? v.a)), 'c_signed_overflow']); break;
    case 'negative-shift-right': {
      S.push([out(Number(BigInt.asUintN(32, BigInt(v.x)) >> BigInt(v.s))), 'c_shift_negative']);
      const t = Math.trunc(v.x / 2 ** v.s);
      if (t !== v.x >> v.s) S.push([out(t), 'shift_value_myth']);        // x / 2^s, the way C's / rounds
      break;
    }
    case 'truncating-division': {
      const fq = Math.floor(v.a / v.b), fr = ((v.c % v.d) + v.d) % v.d;
      S.push([out(`${fq} ${fr}`), 'c_truncating_division'], [out(`${fq} ${v.c % v.d}`), 'c_truncating_division']);
      break;
    }
    case 'unsigned-shift-right': S.push([out(wrap32(v.u) >> v.s), 'shift_arith_logical']); break;
    default: break;
  }
  return S;
}

test('classic wrong answers get the intended misconception tag (no checkpoints needed)', () => {
  let n = 0;
  for (const item of INSTANCES) {
    for (const [answer, tag] of classicStudents(item)) {
      const name = `${item.params.id} v${item.params.v}: ${JSON.stringify(answer)}`;
      assert.equal(cards.mark(item, answer).correct, false, name);
      const d = runFlow(item, answer);
      assert.equal(d.tag, tag, name);
      assert.equal(d.steps, 0, name);
      assert.ok(sentences(d.detail) <= 2, d.detail);
      assert.ok(!junk(d.headline + d.detail), d.detail);
      n++;
    }
  }
  assert.ok(n > 1500, `${n} classic answers checked`);
});

test('the branch card: a signed reading is located by checkpoints and tagged c_jump_signedness', () => {
  for (const item of INSTANCES.filter((it) => it.params.id === 'signed-unsigned-branch')) {
    const wrong = item.card.ask.choices.find((c) => c !== item.key.branch);
    const signedJump = (cp) => (cp.input.kind === 'choice' ? cp.input.choices.find((c) => c !== cp.answer) : cp.answer);
    const d = runFlow(item, { branch: wrong }, signedJump);
    assert.equal(d.tag, 'c_jump_signedness');
    assert.equal(d.steps, 1);
    // knows the jump but not the conversion → c_usual_conversions
    const d2 = runFlow(item, { branch: wrong }, (cp) => (cp.input.kind === 'number' ? -item.sim.vals.k : cp.answer));
    assert.equal(d2.tag, 'c_usual_conversions');
    assert.equal(d2.steps, 2);
    // "Not sure" to everything is not evidence: no "you know the pieces", no misconception tag
    const d3 = runFlow(item, { branch: wrong }, () => null);
    assert.ok(d3.steps <= 3);
    assert.equal(d3.tag, 'other');
    assert.equal(d3.headline, 'Not quite.');
    // one right answer and the rest "Not sure": now the fallback has evidence
    let q = 0;
    const d4 = runFlow(item, { branch: wrong }, (cp) => (q++ === 0 ? cp.answer : null));
    assert.equal(d4.tag, 'c_jump_signedness');
    assert.match(d4.headline, /know the pieces/);
  }
});

test('every card: "Not sure" to every checkpoint never names a misconception', () => {
  let flows = 0;
  for (const item of INSTANCES) {
    const f = item.fields[0];
    if (f.kind === 'flags') continue;                     // the flags card asks no checkpoints
    const right = item.key[f.id];
    const odd = f.kind === 'choice' ? f.choices.find((c) => c !== right) : f.kind === 'number' ? 987654 : 'no idea at all';
    const d = runFlow(item, { [f.id]: odd }, () => null);
    if (d.steps === 0) continue;                           // a classic wrong answer, recognised without checkpoints
    assert.equal(d.tag, 'other', `${item.params.id} v${item.params.v}: ${d.headline}`);
    assert.ok(!/know the pieces/.test(d.headline));
    flows++;
  }
  assert.ok(flows > 300, `${flows} flows`);
});

test("comparison cards: the lab's cmp / set / jump match gcc -O0's operand order and condition", { skip: !HAVE_GCC && 'gcc not installed' }, () => {
  let checked = 0;
  for (const id of ['minus-one-vs-unsigned', 'signed-unsigned-branch']) {
    const items = INSTANCES.filter((it) => it.params.id === id);
    const asm = gccAsm(`order_${id.replace(/\W/g, '_')}`, items.map((it) => it.card.src));
    items.forEach((it, k) => {
      // memory operands as M, gcc's aliases as the lab spells them, jump targets dropped
      const shape = (l) => l.replace(/\s+/g, ' ').replace(/DWORD PTR (\[rbp-\d+\]|-?\d+\[rbp\])/, 'M').replace(/^setnb/, 'setae').replace(/^jnb/, 'jae').replace(/^(j\w+) .*/, '$1');
      const pick = (lines) => lines.map(shape).filter((l) => /^(cmp|set|j(?!mp))/.test(l));
      const ours = pick(it.sim.prog.insts.filter((x) => x.line === 3).map((x) => x.asText));
      assert.deepEqual(ours, pick(asm[k]), `${id} v${it.params.v}`);
      // what the Why layers say about CF is what the gcc text says
      const flags = cards.why(it, null, {}).find((l) => l.kind === 'flags');
      const cf = it.sim.cmp.flagsAfter.CF;
      assert.match(flags.say[0], new RegExp(`^CF = ${cf}`));
      if (/cmp b, a/.test(it.card.gcc)) assert.equal(cf, 1, `${id} v${it.params.v}: gcc's cmp b, a borrows`);
      checked++;
    });
  }
  assert.ok(checked > 150);
});

test('the flags card: CF from the signed reading → flags_sub_carry; a missed OF → flags_signed_overflow_missed', () => {
  let sub = 0, of = 0, swap = 0;
  for (const item of INSTANCES.filter((it) => it.params.id === 'flags-after-cmp')) {
    const { a, b } = item.sim.vals;
    const key = item.key.flags;
    // a learner who sets CF to "a < b as signed ints"
    const signedLess = Number(a < b);
    if (signedLess !== key.CF) {
      const d = runFlow(item, { flags: { ...key, CF: signedLess } });
      assert.equal(d.tag, 'flags_sub_carry', `a=${a} b=${b}`);
      sub++;
    }
    if (key.OF === 1) {
      assert.equal(runFlow(item, { flags: { ...key, OF: 0 } }).tag, 'flags_signed_overflow_missed');
      of++;
    }
    if (key.CF !== key.OF) {
      assert.equal(runFlow(item, { flags: { ...key, CF: key.OF, OF: key.CF } }).tag, 'flags_carry_is_overflow');
      swap++;
    }
    const d0 = runFlow(item, { flags: { ...key, SF: null } });
    assert.equal(d0.tag, null, 'an empty flag is not classified');
  }
  assert.ok(sub > 0 && of > 0 && swap > 0, `${sub} ${of} ${swap}`);
});

test('unrecognised answers: ≤ 3 checkpoints; a wrong checkpoint gives its tag; all right gives a diagnosis', () => {
  for (const item of INSTANCES) {
    if (item.card.ask.kind === 'flags') continue;
    const odd = item.card.ask.kind === 'branch' ? { branch: item.card.ask.choices.find((c) => c !== item.key.branch) }
      : item.card.ask.kind === 'value' ? { value: 123457 } : { output: '123457' };
    const right = runFlow(item, odd, (cp) => cp.answer);
    assert.ok(right.steps <= 3 && typeof right.tag === 'string', item.params.id);
    const wrongFirst = runFlow(item, odd, (cp) => (cp.input.kind === 'choice' ? cp.input.choices.find((c) => c !== cp.answer) : cp.input.kind === 'bit' ? 1 - cp.answer : 99999));
    const first = cards.diagnose(item, odd, cards.mark(item, odd), []);
    if (first.next) assert.equal(wrongFirst.steps, 1, `${item.params.id}: a wrong checkpoint answer ends the flow`);
    assert.ok(TAG_IDS.includes(wrongFirst.tag), `${item.params.id}: ${wrongFirst.tag}`);
    for (const d of [right, wrongFirst]) assert.ok(sentences(d.detail) <= 2, d.detail);
  }
});

test('diagnose never crashes: odd and random answers, odd checkpoint replies; wrong answers always get a tag', () => {
  const rng = mulberry32(2026);
  const odd = [undefined, '', ' ', 'abc', '1e3', '−5', '  42  ', 'NaN', 1e300, NaN, -0, 2 ** 60, {}, [], true, '12\n13', 'error', 99999999999999999999];
  const replies = [(cp) => cp.answer, () => null, () => 'junk', () => 7, (cp) => String(cp.answer)];
  let flows = 0;
  for (const item of INSTANCES.filter((it) => it.params.v % 10 === 0)) {
    const f = item.fields[0];
    const answers = f.kind === 'flags'
      ? Array.from({ length: 30 }, () => ({ flags: Object.fromEntries(['CF', 'ZF', 'SF', 'OF'].map((x) => [x, [0, 1, null, '1', '0', true][Math.floor(rng() * 6)]])) })).concat([{}, null, { flags: null }, { flags: 'x' }])
      : odd.map((x) => ({ [f.id]: x })).concat(Array.from({ length: 10 }, () => ({ [f.id]: f.kind === 'number' ? Math.floor(rng() * 2e6) - 1e6 : String(Math.floor(rng() * 2e9) - 1e9) })), [{}, null]);
    for (const answer of answers) {
      const m = cards.mark(item, answer);
      for (const reply of replies) {
        const d = runFlow(item, answer, reply);
        flows++;
        assert.ok(d.steps <= 3);
        assert.ok(d.tag === null || TAG_IDS.includes(d.tag), d.tag);
        if (m.correct) assert.equal(d.tag, null);
        const cells = [].concat(m.cells[f.id]);
        // a wrong answer with nothing left empty is always classified (a known tag or 'other')
        if (!m.correct && !cells.includes('missing')) assert.ok(d.tag, `${item.params.id}: ${JSON.stringify(answer)} → ${d.headline}`);
        assert.ok(!junk(d.headline + d.detail), d.detail);
      }
    }
  }
  assert.ok(flows > 5000, `${flows} flows`);
  // bits as text mean the same as numbers; checkpoint numbers typed as text are read as numbers
  const fc = cards.build({ id: 'flags-after-cmp', v: 0 });
  const k = fc.key.flags;
  assert.equal(cards.mark(fc, { flags: Object.fromEntries(Object.entries(k).map(([n, b]) => [n, String(b)])) }).correct, true);
  assert.equal(runFlow(fc, { flags: { ...k, CF: String(1 - k.CF) } }).tag, 'flags_sub_carry');
  const ch = cards.build({ id: 'char-200', v: 0 });
  assert.equal(runFlow(ch, { output: '12' }, (cp) => String(cp.answer)).tag, 'other');
  assert.equal(runFlow(ch, { output: '12' }, (cp) => (cp.answer === 127 ? '255' : cp.answer)).tag, 'c_char_signedness');
});

// ---------------------------------------------------------------------------
// Why layers
// ---------------------------------------------------------------------------

function checkLayer(layer, prog, name) {
  assert.ok(KINDS.has(layer.kind), `${name}: kind ${layer.kind}`);
  assert.equal(typeof layer.id, 'string');
  assert.equal(typeof layer.title, 'string');
  assert.ok(Array.isArray(layer.say) && layer.say.length >= 1 && layer.say.length <= 2);
  const said = layer.say.join(' ');
  assert.ok(sentences(said) <= 2, `${name} ${layer.kind}: say ≤ 2 sentences: ${said}`);
  assert.ok(!junk(said), said);
  const d = layer.data;
  switch (layer.kind) {
    case 'line':
      assert.equal(typeof d.src, 'string');
      assert.ok(Number.isInteger(d.line) && d.line >= 1 && d.line <= d.src.split('\n').length);
      break;
    case 'asm': {
      assert.ok(d.rows.length >= 1 && d.rows.filter((r) => r.hot).length === 1, `${name}: one hot row`);
      const byAddr = new Map(prog.insts.map((i) => [i.addr, i]));
      for (const r of d.rows) {
        const ins = byAddr.get(r.addr);
        assert.ok(ins, `${name}: row at ${r.addr}`);
        assert.equal(r.text, ins.text);
        assert.equal(r.bytes, ins.bytes.map((b) => b.toString(16).padStart(2, '0')).join(' '), `${name}: bytes of ${r.text}`);
      }
      assert.match(d.note, /gcc -O0 style/);
      break;
    }
    case 'regs':
      assert.ok([8, 16, 32, 64].includes(d.width));
      assert.deepEqual(Object.keys(d.before), Object.keys(d.after));
      assert.ok(d.changed.every((r) => r in d.after));
      break;
    case 'flags':
      for (const f of ['CF', 'ZF', 'SF', 'OF']) assert.ok(isBit(d[f]) || d[f] === null, `${f}=${d[f]}`);
      for (const [f, t] of Object.entries(d.why)) {
        assert.ok(sentences(t) === 1, `flag why is one sentence: ${t}`);
        if (isBit(d[f])) assert.ok(t.startsWith(`${f} = ${d[f]}`) || t.startsWith('CF = OF'), t);
      }
      break;
    case 'columns': {
      const r = addBits(d.a, d.b, d.w, d.carries[0] ?? 0);
      assert.deepEqual(r.result, d.result, `${name}: columns are a real addition`);
      assert.deepEqual(r.carries.slice(1), d.carries.slice(1));
      assert.ok(d.highlight >= 0 && d.highlight < d.w);
      assert.equal(typeof d.dropped, 'boolean');
      if (d.dropped) assert.equal(r.cout, 1);
      for (const k of ['a', 'b', 'r']) assert.equal(typeof d.labels[k], 'string');
      assert.ok(['+', '-'].includes(d.op));
      break;
    }
    case 'adder':
      assert.equal(d.x1, d.a ^ d.b); assert.equal(d.a1, d.a & d.b); assert.equal(d.a2, d.x1 & d.cin);
      assert.equal(d.sum, d.x1 ^ d.cin); assert.equal(d.cout, d.a1 | d.a2);
      break;
    case 'shift':
      assert.equal(d.before.length, d.w); assert.equal(d.after.length, d.w);
      for (let i = 0; i < d.w; i++) {
        const src = d.dir === 'R' ? i + d.k : i - d.k;
        assert.equal(d.after[i], src >= 0 && src < d.w ? d.before[src] : d.fill, `${name}: shift bit ${i}`);
      }
      break;
    default: break;
  }
}

test('Why layers: well-formed, shallow → deep, real bytes, honest columns', () => {
  const ORDER = ['line', 'asm', 'regs', 'flags', 'shift', 'columns', 'adder'];
  for (const item of INSTANCES) {
    const name = `${item.params.id} v${item.params.v}`;
    const layers = cards.why(item, null, { level: 'csapp' });
    assert.ok(layers.length >= 3, name);
    assert.equal(layers[0].kind, 'line');
    assert.equal(layers[1].kind, 'asm');
    const ranks = layers.map((l) => ORDER.indexOf(l.kind));
    assert.ok(ranks.every((r, i) => i === 0 || r >= ranks[i - 1]), `${name}: ${layers.map((l) => l.kind)}`);
    assert.equal(new Set(layers.map((l) => l.id)).size, layers.length, `${name}: unique ids`);
    for (const l of layers) checkLayer(l, compile(item.card.src), name);
    // only the layers that explain the card
    const kinds = new Set(layers.map((l) => l.kind));
    if (['truncating-division', 'char-200', 'short-truncation', 'int-multiply-overflow'].includes(item.params.id)) assert.ok(!kinds.has('columns'), name);
    if (['negative-shift-right', 'unsigned-shift-right'].includes(item.params.id)) assert.ok(kinds.has('shift') && !kinds.has('flags'), name);
    if (['int-max-plus-one', 'unsigned-wrap', 'flags-after-cmp', 'signed-unsigned-branch', 'minus-one-vs-unsigned'].includes(item.params.id)) {
      assert.ok(kinds.has('flags') && kinds.has('columns') && kinds.has('adder'), name);
      // the top-byte window ends at the sign column, and the sign adder agrees with the flags
      const cols = layers.find((l) => l.kind === 'columns').data;
      assert.equal(cols.base, 24);
      const ad = layers.find((l) => l.kind === 'adder').data;
      const fl = layers.find((l) => l.kind === 'flags').data;
      assert.equal(ad.cin ^ ad.cout, fl.OF, `${name}: OF = carry in XOR carry out`);
      assert.equal(cols.op === '-' ? 1 - ad.cout : ad.cout, fl.CF, `${name}: CF from the carry out`);
      assert.equal(cols.result[7], fl.SF, `${name}: SF = bit 31`);
      // the window's own carries into and out of the sign column are the adder's, and give the flags
      assert.equal(cols.carries[7], ad.cin, `${name}: carry into bit 31`);
      assert.equal(cols.carries[8], ad.cout, `${name}: carry out of bit 31`);
      assert.equal(cols.carries[7] ^ cols.carries[8], fl.OF, `${name}: OF from the window`);
      assert.equal(cols.op === '-' ? 1 - cols.carries[8] : cols.carries[8], fl.CF, `${name}: CF from the window`);
      assert.deepEqual([cols.a[7], cols.b[7], cols.result[7]], [ad.a, ad.b, ad.sum], `${name}: bit 31 in both layers`);
      assert.equal(cols.dropped, cols.carries[8] === 1);
      assert.equal(cols.signed, true);
    }
    if (item.params.id === 'uchar-promotion') {
      // bits 7–0 of a 32-bit add: the carry out of bit 7 moves on to bit 8, it is not lost, and bit 7 is no sign bit
      const cols = layers.find((l) => l.kind === 'columns').data;
      assert.deepEqual([cols.base, cols.carries[8], cols.dropped, cols.signed], [0, 1, false, false], name);
    }
    // the GCSE view never shows the adder
    assert.ok(cards.why(item, null, { level: 'gcse' }).every((l) => l.kind !== 'adder'));
  }
});

// ---------------------------------------------------------------------------
// Generation, variants and codes
// ---------------------------------------------------------------------------

test('generate, variant and decodeParams', () => {
  const rng = mulberry32(99);
  for (const section of ['2.2', '2.3', '3.5']) {
    for (let k = 0; k < 20; k++) {
      const p = cards.generate(rng, { section });
      const item = cards.build(p);
      assert.ok(item.card.section.startsWith(`CS:APP ${section}`), `${section} → ${item.card.section}`);
    }
  }
  for (const tag of cards.TARGETS) {
    const p = cards.generate(rng, { target: tag });
    assert.ok(cards.CARDS.find((c) => c.id === p.id).tags.includes(tag), tag);
    const item = cards.build(p);
    const q = cards.variant(item, tag, rng);
    assert.ok(cards.CARDS.find((c) => c.id === q.id).tags.includes(tag));
    assert.ok(q.id !== p.id || q.v !== p.v, 'a variant is a new instance');
  }
  // registry: spec points and tags reach the cards
  for (const spec of ['CSAPP-2.2', 'CSAPP-2.3', 'CSAPP-3.5']) {
    const r = registry.itemForSpec(spec, rng);
    assert.equal(r.type, 'card');
    assert.equal(registry.makeItem('card', r.params).type, 'card');
  }
  assert.equal(registry.itemForTag('c_promotion', rng).type, 'card');
  assert.equal(registry.typeById(5), cards);
  for (const bad of [[12, 0], [-1, 0], [0, -1], [0, cards.V_MAX + 1], [0.5, 0], [0], 'x', [0, 1, 2]]) {
    assert.throws(() => cards.decodeParams(bad), `${JSON.stringify(bad)} rejected`);
  }
});

// ---------------------------------------------------------------------------
// C_TAGS
// ---------------------------------------------------------------------------

test('C_TAGS: every c_* id, short labels, ≤ 2-sentence texts, worked examples with subgoals', () => {
  const cIds = TAG_IDS.filter((id) => id && id.startsWith('c_'));
  assert.deepEqual(Object.keys(C_TAGS).sort(), cIds.slice().sort());
  for (const id of Object.keys(C_TAGS)) assert.ok(!(id in BINARY_TAGS), `${id} not duplicated`);
  assert.deepEqual(missingTags(), []);
  for (const [id, t] of Object.entries(C_TAGS)) {
    assert.equal(TAGS[id], t);
    assert.ok(t.label.length > 0 && t.label.length <= 40, `${id}: label ${t.label.length} chars`);
    assert.ok(sentences(t.student) <= 2, `${id}: student`);
    assert.match(t.student, /\byou\b/i, `${id}: second person`);
    assert.equal(sentences(t.fix), 1, `${id}: fix is one sentence`);
    for (let seed = 1; seed <= 25; seed++) {
      const ex = t.worked(mulberry32(seed));
      assert.ok(ex.title.length > 0);
      assert.ok(ex.steps.length >= 3 && ex.steps.length <= 5, `${id}: ${ex.steps.length} steps`);
      for (const s of ex.steps) {
        assert.ok(s.subgoal.length > 0 && s.text.length > 0);
        assert.ok(!junk(s.subgoal + s.text), s.text);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Paste mode
// ---------------------------------------------------------------------------

const PROGRAMS = {
  short: 'int a = 5;\nint b = a * 3;\nunsigned u = 2;\nu = u - b;\nprintf("%u\\n", u);',
  byteLoop: 'unsigned char c = 250;\nint n = 0;\nfor (int i = 0; i < 8; i++) {\n  c = c + 1;\n  n = n + c;\n}\nprintf("%d %d\\n", c, n);',
  overflowLoop: 'int x = 2147483600;\nfor (int i = 0; i < 5; i++)\n  x = x + 20;\nprintf("%d\\n", x);',
  charStore: 'int t = 100;\nint k = t + 60;\nchar c = k;\nint d = c / 2;\nprintf("%d\\n", d);',
  division: 'int s = 0;\nfor (int i = 1; i <= 6; i++) {\n  s = s + i;\n}\nint q = -s / 4;\nint r = q * 2;\nprintf("%d %d\\n", q, r);',
  shiftSum: 'int total = 0;\nfor (int i = 0; i < 6; i++) {\n  total = total + i * i;\n}\nint h = (total - 100) >> 2;\nprintf("%d\\n", h);',
  compare: 'int a = -5;\nunsigned b = 3;\nint lt = a < b;\nint m = lt + 10;\nprintf("%d\\n", m);',
};

/** a learner whose model matches the machine until write j, then is off by 7 */
function plantedReply(analysis, j) {
  return (cp) => {
    const w = analysis.events[cp.event];
    return w.k < j ? cp.answer : cp.answer + 7;
  };
}
// "after line 3 (the 6th time it runs)" is never used for a for-loop header: a learner counts passes
const PROMPT = new RegExp('^(What is \\w+ after line \\d+( \\(the \\d+(st|nd|rd|th) time it runs\\))?\\?'
  + '|What is \\w+ (at the start of pass \\d+ of|when) the loop on line \\d+( finishes)?( \\(the \\d+(st|nd|rd|th) time that loop runs\\))?\\?'
  + '|What value does \\w+ end up with\\?)$');
function runPaste(analysis, predicted, reply) {
  const cps = [];
  for (let n = 0; n <= 3; n++) {
    const r = diagnosePaste(analysis, predicted, cps);
    if (!r.next) return { ...r.diagnosis, steps: n };
    assert.ok(n < 3, 'more than 3 checkpoints');
    assert.equal(r.next.input.kind, 'number');
    assert.match(r.next.prompt, PROMPT);
    cps.push(reply(r.next));
  }
  throw new Error('unreachable');
}

test('paste: analyzePaste, markOutput and compile errors', () => {
  const a = analyzePaste(PROGRAMS.short);
  assert.equal(a.res.output, '4294967283\n');
  assert.deepEqual(a.events.map((w) => [w.name, w.val]), [['a', 5], ['b', 15], ['u', 2], ['u', 4294967283]]);
  assert.equal(a.events[3].surprise.tag, 'c_unsigned_wrap');
  assert.equal(markOutput(a.res, '4294967283').correct, true);
  assert.equal(markOutput(a.res, '4294967283\r\n\n').correct, true);
  const m = markOutput(a.res, '-13');
  assert.equal(m.correct, false);
  assert.deepEqual(m.cells.lines, ['bad']);
  assert.equal(markOutput(a.res, '').cells.output, 'missing');
  assert.throws(() => analyzePaste('int x = 5\nreturn x;'), (e) => e instanceof CError && e.line === 2 && e.col > 0);
  assert.throws(() => analyzePaste('int x = 0;\nint y = 5 / x;'), (e) => e instanceof CError && e.kind === 'runtime' && e.line === 2);
  const ok = diagnosePaste(a, '4294967283', []);
  assert.equal(ok.diagnosis.tag, null);
});

test('paste: the traps are recognised at the write where they happen', () => {
  const tagAt = (src, name, nth = 1) => analyzePaste(src).events.filter((w) => w.name === name)[nth - 1].surprise?.tag ?? null;
  assert.equal(tagAt(PROGRAMS.byteLoop, 'c', 7), 'c_narrowing');       // 255 + 1 stored in an unsigned char
  assert.equal(tagAt(PROGRAMS.byteLoop, 'c', 2), null);
  assert.equal(tagAt(PROGRAMS.overflowLoop, 'x', 4), 'c_signed_overflow');
  assert.equal(tagAt(PROGRAMS.overflowLoop, 'x', 3), null);
  assert.equal(tagAt(PROGRAMS.charStore, 'c'), 'c_char_signedness');
  assert.equal(tagAt(PROGRAMS.division, 'q'), 'c_truncating_division');
  assert.equal(tagAt(PROGRAMS.shiftSum, 'h'), 'c_shift_negative');
  assert.equal(tagAt(PROGRAMS.compare, 'lt'), 'c_usual_conversions');
  assert.equal(tagAt('short s = 70000;\nreturn 0;', 's'), 'c_narrowing');
  assert.equal(tagAt('int i = -1;\nunsigned u = i;\nreturn 0;', 'u'), 'c_unsigned_wrap');
  assert.equal(tagAt('int i = 5;\nlong l = i;\nint j = l;\nreturn 0;', 'j'), null);
});

test('paste: bisection finds a planted divergence in ≤ 3 checkpoints', () => {
  let cases = 0;
  // short programs: every write can be the planted one, and it is found exactly
  for (const name of ['short', 'charStore', 'compare']) {
    const a = analyzePaste(PROGRAMS[name]);
    assert.ok(a.events.length <= 7, `${name}: ${a.events.length} writes`);
    for (let j = 0; j < a.events.length; j++) {
      const d = runPaste(a, 'something else', plantedReply(a, j));
      assert.ok(d.steps <= 3);
      assert.equal(d.focus.event, j, `${name}: planted at ${j}, found ${d.focus.event}`);
      assert.equal(d.focus.line, a.events[j].line);
      assert.equal(d.tag, a.events[j].surprise?.tag ?? 'trace_value');
      cases++;
    }
  }
  // longer programs: the model breaks at the trap (the realistic case), found exactly
  for (const name of ['byteLoop', 'overflowLoop', 'division', 'shiftSum']) {
    const a = analyzePaste(PROGRAMS[name]);
    assert.ok(a.events.length > 7, `${name}: ${a.events.length} writes`);
    const j = a.events.findIndex((w) => w.surprise);
    const d = runPaste(a, 'something else', plantedReply(a, j));
    assert.ok(d.steps <= 3);
    assert.equal(d.focus.event, j, `${name}: planted at ${j}, found ${d.focus.event}`);
    assert.equal(d.tag, a.events[j].surprise.tag);
    assert.match(d.headline, /line \d+/);
    assert.ok(sentences(d.detail) <= 2, d.detail);
    cases++;
  }
  assert.ok(cases >= 15, `${cases} planted divergences`);
});

test('paste: for-loop headers are asked about as loop passes, and only when nothing else will do', () => {
  // the review's learner: counts loop passes correctly but forgets that unsigned char wraps
  const a = analyzePaste(PROGRAMS.byteLoop);
  const model = analyzePaste(PROGRAMS.byteLoop.replace('unsigned char c', 'int c'));
  assert.equal(model.events.length, a.events.length);
  const asked = [];
  const d = runPaste(a, '258 2036', (cp) => { asked.push(cp); return model.events[cp.event].val; });
  assert.ok(!/after line 3\b/.test(asked.map((cp) => cp.prompt).join(' | ')), asked.map((cp) => cp.prompt).join(' | '));
  assert.notEqual(a.events[asked[0].event].name, 'i', 'the first question is not about the loop counter');
  assert.equal(d.focus.line, 4);
  assert.equal(d.tag, a.events[d.focus.event].surprise.tag);
  assert.equal(a.events[d.focus.event].val, 0);
  // any loop-counter question is phrased as a pass of the loop, and the value is the one a pass-counter gives
  for (const cp of asked) {
    const w = a.events[cp.event];
    if (w.name !== 'i') continue;
    assert.match(cp.prompt, /^What is i (at the start of pass (\d+) of|when) the loop on line 3/);
    const pass = Number((cp.prompt.match(/pass (\d+)/) || [])[1]);
    assert.equal(cp.answer, pass - 1);
  }
  // header writes: init starts pass 1, the last step finishes the loop
  const hs = a.events.filter((w) => w.header);
  assert.deepEqual(hs.map((w) => w.pass), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(hs.map((w) => !!w.finishes), [false, false, false, false, false, false, false, false, true]);
  // "Not sure" to everything still finds the wrapping line
  const unsure = runPaste(a, '258 2036', () => null);
  assert.equal(unsure.focus.line, 4);
  // a printed counter may be asked about, but never as "the 4th time line 1 runs"
  const printedLoop = analyzePaste('for (char c = 125; c > 0; c++)\n  printf("%d\\n", c);');
  const prompts = [];
  runPaste(printedLoop, '125\n126\n127\n128', (cp) => { prompts.push(cp.prompt); return null; });
  assert.ok(prompts.length && prompts.every((p) => /(at the start of pass \d+ of|when) the loop on line 1/.test(p)), prompts.join(' | '));
  // a break: the pass that starts still runs, so it is not "when the loop finishes"
  const brk = analyzePaste('int s = 0;\nfor (int i = 0; i < 10; i++) {\n  if (i == 3) break;\n  s = s + i;\n}\nprintf("%d\\n", s);');
  const last = brk.events.filter((w) => w.header).pop();
  assert.equal(last.pass, 4);
  assert.ok(!last.finishes);
  // nested loops: the inner loop's passes restart each time it runs
  const nest = analyzePaste('int n = 0;\nfor (int i = 0; i < 2; i++)\n  for (int j = 0; j < 3; j++)\n    n = n + j;\nprintf("%d\\n", n);');
  const inner = nest.events.filter((w) => w.name === 'j');
  assert.deepEqual(inner.map((w) => [w.entry, w.pass]), [[1, 1], [1, 2], [1, 3], [1, 4], [2, 1], [2, 2], [2, 3], [2, 4]]);
});

test('paste: an unsigned > or <= (compiled as cmp b, a) still names the converted signed value', () => {
  for (const [src, v] of [['int a = -5;\nunsigned b = 3;\nint gt = a > b;\nprintf("%d\\n", gt);', 'gt'], ['unsigned b = 3;\nint a = -5;\nint le = b <= a;\nprintf("%d\\n", le);', 'le']]) {
    const a = analyzePaste(src);
    const w = a.events.find((x) => x.name === v);
    assert.equal(w.surprise?.tag, 'c_usual_conversions', src);
    const d = runPaste(a, '0', (cp) => (a.events[cp.event].surprise ? cp.answer + 1 : cp.answer));
    assert.equal(d.tag, 'c_usual_conversions');
    assert.match(d.detail, /-5 is compared as 4294967291/);
  }
});

test('paste: values all right → the output line; "Not sure" is not evidence', () => {
  const a = analyzePaste(PROGRAMS.short);
  const d = runPaste(a, '-13', (cp) => cp.answer);
  assert.equal(d.focus.line, 5);
  assert.equal(d.tag, 'other');
  const unsure = runPaste(a, '-13', () => null);
  assert.ok(unsure.steps <= 3 && unsure.focus.line);
  const noWrites = analyzePaste('printf("%d\\n", -7 / 2);');
  const d2 = runPaste(noWrites, '-4', () => null);
  assert.equal(d2.steps, 0);
  assert.equal(d2.focus.line, 1);
});

test('paste: Why layers for the statement in focus', () => {
  for (const [name, src] of Object.entries(PROGRAMS)) {
    const a = analyzePaste(src);
    for (let j = 0; j < a.events.length; j++) {
      const diag = { tag: 'trace_value', headline: '', detail: '', focus: { line: a.events[j].line, event: j } };
      const layers = whyPaste(a, diag);
      assert.ok(layers.length >= 2, `${name} #${j}`);
      assert.equal(layers[0].kind, 'line');
      assert.equal(layers[1].kind, 'asm');
      for (const l of layers) checkLayer(l, a.prog, `${name} #${j}`);
      const w = a.events[j];
      if (w.surprise && ['c_signed_overflow', 'c_unsigned_wrap'].includes(w.surprise.tag) && w.surprise.n !== w.n) {
        const kinds = layers.map((l) => l.kind);
        assert.ok(kinds.includes('flags') && kinds.includes('columns') && kinds.includes('adder'), `${name} #${j}: ${kinds}`);
      }
    }
  }
  assert.deepEqual(whyPaste(analyzePaste(PROGRAMS.short), { tag: null, focus: {} }), []);
});

test('paste: i++ and x += k (one instruction that computes and stores) are checked; loop counters are not traps', () => {
  const tags = (src) => analyzePaste(src).events.map((w) => w.surprise?.tag ?? null);
  assert.deepEqual(tags('int x = 2147483647;\nx++;\nreturn 0;'), [null, 'c_signed_overflow']);
  assert.deepEqual(tags('int x = 2147483000;\nx += 1000;\nreturn 0;'), [null, 'c_signed_overflow']);
  assert.deepEqual(tags('unsigned u = 0;\nu--;\nreturn 0;'), [null, 'c_unsigned_wrap']);
  // the loop's cmp (i - 5) is never mistaken for the value stored by i++
  const loops = analyzePaste('int n = 0;\nfor (int i = 0; i < 4; i++)\n  n += i;\nfor (unsigned k = 3; k > 0; k--)\n  n -= 1;\nfor (int j = -3; j < 0; j++)\n  n = n - j;\nprintf("%d\\n", n);');
  assert.ok(loops.events.every((w) => !w.surprise), loops.events.filter((w) => w.surprise).map((w) => `${w.name}@${w.line}`).join(' '));
  const times = Object.fromEntries(loops.events.map((w) => [`${w.name}@${w.line}`, w.times]));
  assert.deepEqual([times['i@2'], times['n@3'], times['k@4'], times['n@5']], [5, 4, 4, 3]);
});

const AWKWARD = {
  empty: '',
  onlyReturn: 'return 0;',
  printfOnly: 'printf("hello\\n");',
  printfNoNewline: 'printf("%d", 5);',
  printfExpr: 'printf("%d %u\\n", -7 / 2, -1);',
  noOutput: 'int x = 5;\nx = x * 2;',
  manyPrints: 'for (int i = 0; i < 5; i++)\n  printf("%d\\n", i - 2);',
  whileWrap: 'unsigned u = 3;\nwhile (u < 10)\n  u = u - 1;\nprintf("%u\\n", u);',
  longs: 'long a = 9223372036854775807L;\nlong b = a + 1;\nunsigned long c = b;\nprintf("%ld %lu\\n", b, c);',
  chars: 'char c = 127;\nc++;\nunsigned char u = 0;\nu--;\nprintf("%d %d\\n", c, u);',
  compound: 'short s = 32767;\ns += 1;\nint k = 7;\nk %= -3;\nk <<= 30;\nprintf("%d %d\\n", s, k);',
  deepLoop: 'int s = 0;\nfor (int i = 0; i < 20000; i++)\n  s = s + i;\nprintf("%d\\n", s);',
  nested: 'int n = 0;\nfor (int i = 0; i < 50; i++)\n  for (int j = 0; j < 50; j++)\n    n = n + i * j;\nprintf("%d\\n", n);',
  lateOverflow: 'int s = 0;\nfor (int i = 0; i < 5000; i++)\n  s = s + 1;\nint t = s * 1000000;\nprintf("%d\\n", t);',
  lateWrap: 'unsigned u = 0;\nfor (int i = 0; i < 3000; i++)\n  u = u + 1000;\nunsigned v = u - 4000000;\nprintf("%u\\n", v);',
};

test('paste: awkward programs never crash, whatever the prediction and the replies', () => {
  const preds = ['', 'x', '0', '-1', '1\n2\n3\n4\n5\n6', '99999999999999999999', '\n\n', '−5'];
  const replies = [(cp) => cp.answer, () => null, (cp) => (typeof cp.answer === 'bigint' ? cp.answer + 7n : cp.answer + 7), () => 'abc', () => NaN, () => -1e30, (cp) => String(cp.answer)];
  let flows = 0;
  for (const [name, src] of Object.entries(AWKWARD)) {
    const a = analyzePaste(src);
    for (const p of [...preds, a.res.output, `${a.res.output}x`]) {
      for (const reply of replies) {
        const d = runPaste(a, p, reply);
        flows++;
        assert.ok(d.tag === null || TAG_IDS.includes(d.tag), `${name}: ${d.tag}`);
        assert.ok(sentences(d.detail) <= 2, d.detail);
        assert.ok(!junk(d.headline + d.detail), d.headline + d.detail);
        if (d.focus.line) assert.ok(d.focus.line >= 1 && d.focus.line <= Math.max(1, src.split('\n').length), `${name}: line ${d.focus.line}`);
        for (const l of whyPaste(a, d)) checkLayer(l, a.prog, `${name} ${l.kind}`);
      }
    }
  }
  assert.ok(flows > 1000, `${flows} flows`);
  // runtime errors and limits are CErrors with a line, never a crash
  for (const [src, kind, line] of [
    ['int z = 0;\nint y = 5 / z;', 'runtime', 2], ['int x;\nprintf("%d\\n", x);', 'runtime', 2],
    ['int m = -2147483647 - 1;\nint d = -1;\nint q = m / d;', 'runtime', 3], ['int x = 0;\nwhile (1)\n  x = x + 1;', 'limit', 3],
    ['int x = ;', 'syntax', 1], ['#$%^&*', 'syntax', 1],
  ]) assert.throws(() => analyzePaste(src), (e) => e instanceof CError && e.kind === kind && e.line === line, src);
});

test('paste: past the trace limit, the run still ends in answerable checkpoints and the real trap', () => {
  const late = analyzePaste(AWKWARD.lateOverflow);
  assert.equal(late.res.eventsTruncated, true);
  const t = late.events.find((w) => w.name === 't');
  assert.ok(t && t.final && t.line === 4 && t.val === 705032704 && t.surprise.tag === 'c_signed_overflow');
  // a learner who follows the loop but expects 5000 × 1000000 to fit
  const d = runPaste(late, '5000000000', (cp) => (late.events[cp.event].name === 't' ? 5000000000 : cp.answer));
  assert.equal(d.tag, 'c_signed_overflow');
  assert.equal(d.focus.line, 4);
  assert.ok(d.steps <= 3);
  const layers = whyPaste(late, d);
  assert.deepEqual(layers.map((l) => l.kind), ['line', 'asm', 'flags']);
  assert.equal(layers[2].data.OF, 1);
  // every question is about a value you can work out without replaying 5000 iterations by hand
  const asked = [];
  runPaste(late, '1', (cp) => { asked.push(cp.prompt); return cp.answer; });
  assert.ok(asked.every((q) => /end up with|after line \d+\?$/.test(q)), asked.join(' | '));
  // values all right → the printf line, even though it ran after the recorded steps
  assert.equal(runPaste(late, '1', (cp) => cp.answer).focus.line, 5);
  const wrap = analyzePaste(AWKWARD.lateWrap);
  const dw = runPaste(wrap, '-1000000', (cp) => (wrap.events[cp.event].name === 'v' ? -1000000 : cp.answer));
  assert.equal(dw.tag, 'c_unsigned_wrap');
  assert.equal(dw.focus.line, 4);
  for (const l of whyPaste(wrap, dw)) checkLayer(l, wrap.prog, `lateWrap ${l.kind}`);
});

