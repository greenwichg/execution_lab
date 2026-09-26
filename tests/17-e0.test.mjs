// E0 desk-study tooling (tools/e0/): "Do free LLMs already find where a
// student's working broke?" Node only, no browser.
//   · generate.mjs is deterministic from its seed, makes 200 items over the
//     planned families, covers every tag at least twice, and every item's own
//     diagnosis (mark + diagnose, checkpoints replayed) matches its tag
//   · the student messages carry the question and the working but no tag
//     names, labels or hint words
//   · score.mjs: hand-written fake replies score as expected (true and false
//     positives), Wilson intervals and Cohen's kappa match known values, the
//     E0 rule fires as pre-registered, and the command line writes its files
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as gen from '../tools/e0/generate.mjs';
import * as score from '../tools/e0/score.mjs';
import { ITEM_TYPES } from '../machine/src/learn/items/index.js';
import { TAG_IDS } from '../machine/src/learn/tagids.js';
import { TAGS } from '../machine/src/learn/catalogue.js';
import { binStr } from '../machine/src/learn/items/add.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GEN = path.join(HERE, '..', 'tools', 'e0', 'generate.mjs');
const SCORE = path.join(HERE, '..', 'tools', 'e0', 'score.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e0-'));
const ITEMS = gen.generateItems(gen.DEFAULT_SEED);
const node = (...args) => execFileSync(process.execPath, args, { encoding: 'utf8' });

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

test('generation is deterministic from the seed, and the seed matters', () => {
  assert.deepEqual(gen.generateItems(gen.DEFAULT_SEED), ITEMS);
  const a = path.join(tmp, 'gen-a');
  const b = path.join(tmp, 'gen-b');
  node(GEN, '--out', a);
  node(GEN, '--seed', String(gen.DEFAULT_SEED), '--out', b);
  for (const f of ['e0-items.jsonl', 'e0-prompts.txt', 'e0-scoring.csv']) {
    assert.ok(fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f))), `${f} is byte-identical`);
  }
  const other = gen.generateItems(7);
  assert.equal(other.length, 200);
  assert.notDeepEqual(other.map((it) => it.params), ITEMS.map((it) => it.params));
});

test('200 items in the planned families, every tag at least twice', () => {
  assert.equal(ITEMS.length, 200);
  assert.deepEqual(ITEMS.map((it) => it.id), Array.from({ length: 200 }, (_, i) => `E0-${String(i + 1).padStart(3, '0')}`));
  const fam = {};
  for (const it of ITEMS) fam[it.family] = (fam[it.family] || 0) + 1;
  assert.deepEqual(fam, { add: 70, 'add-result': 20, shift: 30, twos: 25, flags: 25, c: 30 });
  const count = {};
  for (const it of ITEMS) count[it.tag] = (count[it.tag] || 0) + 1;
  // every misconception an item type practises (all but the generic ones)
  const wanted = TAG_IDS.filter((t) => t && t !== 'trace_value' && t !== 'other');
  for (const t of wanted) assert.ok((count[t] || 0) >= 2, `${t} appears ${count[t] || 0} times`);
  const prefix = { add: 'add_', 'add-result': 'add_', shift: 'shift_', twos: 'twos_', flags: 'flags_', c: 'c_' };
  for (const it of ITEMS) {
    assert.ok(it.tag.startsWith(prefix[it.family]), `${it.id} ${it.family} has ${it.tag}`);
    assert.equal(it.tagLabel, TAGS[it.tag].label);
    assert.equal(it.route, it.family === 'c' || (it.family === 'flags' && it.level === 'csapp') ? 'university' : 'schools');
    for (const k of ['correct', 'step', 'tag', 'tagLabel', 'parts', 'locate']) assert.ok(it.key[k] !== undefined && it.key[k] !== '', `${it.id} key.${k}`);
    assert.ok(Object.keys(it.key.parts).length > 0 && it.key.locate.length > 0, `${it.id} has something to score`);
  }
  // A-level "overflow?" and CS:APP four-flag questions both appear; C items span the cards
  assert.ok(ITEMS.some((it) => it.family === 'flags' && it.route === 'schools'));
  assert.ok(ITEMS.some((it) => it.family === 'flags' && it.route === 'university'));
  assert.ok(new Set(ITEMS.filter((it) => it.family === 'c').map((it) => it.params.id)).size >= 9);
  // no two items are the same question with the same wrong answer
  assert.equal(new Set(ITEMS.map((it) => JSON.stringify([it.type, it.params, it.learner.answer]))).size, 200);
});

test("every item's own diagnosis matches its tag, and the key is the machine's", () => {
  for (const it of ITEMS) {
    const mod = ITEM_TYPES[it.type];
    const item = mod.build(it.params);
    const answer = it.learner.answer;
    assert.equal(mod.mark(item, answer).correct, false, `${it.id}: the learner's answer is wrong`);
    const replies = it.learner.checkpoints.map((c) => c.reply);
    assert.ok(replies.length <= 3, `${it.id}: at most 3 checkpoints`);
    let r;
    let n = 0;
    for (;; n++) {
      r = mod.diagnose(item, answer, null, replies.slice(0, n));
      if (!r.next) break;
      assert.ok(n < replies.length, `${it.id}: a checkpoint the learner did not answer`);
      assert.equal(r.next.prompt, it.learner.checkpoints[n].prompt);
    }
    assert.equal(n, replies.length, `${it.id}: every recorded checkpoint was asked`);
    assert.equal(r.diagnosis.tag, it.tag, `${it.id}: ${r.diagnosis.headline}`);
    assert.equal(r.diagnosis.headline, it.key.ourDiagnosis.headline);

    // the parts the reply must give come from the item's own key
    const p = it.key.parts;
    const w = item.params.w;
    if (it.type === 'add') {
      if (p.bits) assert.equal(p.bits, binStr(item.key.result.slice(0, w)));
      if (p.overflow) assert.equal(p.overflow, item.key.overflow);
    }
    if (it.type === 'shift') {
      if (p.bits) assert.equal(p.bits, binStr(item.key.bits));
      if (p.number !== undefined) assert.equal(p.number, item.key.value);
    }
    if (it.type === 'twos') {
      if (p.bits) assert.equal(p.bits, binStr(item.key.bits));
      if (p.number !== undefined) assert.equal(p.number, item.key.value);
      if (p.numbers) assert.deepEqual(p.numbers, [item.key.min, item.key.max]);
    }
    if (it.type === 'sadd') {
      if (p.overflow) assert.equal(p.overflow, item.key.flags.OF ? 'yes' : 'no');
      if (p.flags) for (const [f, v] of Object.entries(p.flags)) assert.equal(v, item.key.flags[f]);
    }
    if (it.type === 'card') {
      const k = item.key;
      assert.deepEqual(p, 'value' in k ? { number: k.value } : 'branch' in k ? { message: k.branch } : { output: k.output });
      assert.match(it.key.step, new RegExp(`^line ${item.sim.line}: `));
    }
  }
});

// ---------------------------------------------------------------------------
// Student messages
// ---------------------------------------------------------------------------

// Words that would give the misconception away (none of them is in any question)
const HINTS = ['misconception', 'mistake', 'forgot', 'forget', 'rotat', 'wrap', 'magnitude', 'ones complement', "ones' complement",
  "one's complement", 'invert', 'flip', 'truncat', 'promot', 'usual arithmetic', 'borrow', 'sign exten', 'sign-exten', 'logical or',
  'bitwise', 'wrong column', 'ninth', '9th', 'extra bit', 'direction', 'fill', 'fell off', 'fall off', 'lost', 'undefined',
  'implementation-defined', 'clamp', 'toward zero', 'towards zero', 'round', 'place value', 'signed jump', 'unsigned jump', 'overflowed'];

test('prompts: the question and working, no tag names, labels or hint words', () => {
  const labels = Object.values(TAGS).map((t) => t.label.toLowerCase());
  const ids = TAG_IDS.filter(Boolean);
  for (const it of ITEMS) {
    const m = it.message;
    const low = m.toLowerCase();
    assert.ok(m.includes(it.question), `${it.id} carries the question`);
    assert.match(low, /where (?:did i go|i went|have i gone) wrong\?/, `${it.id} asks where it went wrong`);
    for (const id of ids) assert.ok(!low.includes(id), `${it.id} names ${id}`);
    for (const l of labels) assert.ok(!low.includes(l), `${it.id} contains the label "${l}"`);
    // the student's own words: everything but the question and a C snippet
    let own = low.replace(it.question.toLowerCase(), ' ');
    if (it.type === 'card') own = own.replace(ITEM_TYPES.card.build(it.params).show.src.toLowerCase(), ' ');
    for (const h of HINTS) assert.ok(!own.includes(h), `${it.id} hints with "${h}":\n${m}`);
    assert.ok(!/!/.test(own), `${it.id} has no exclamation marks`);
    // the working shows the learner's actual answer
    const a = it.learner.answer;
    if (it.type === 'add') assert.ok(m.includes(a.result.slice().reverse().filter((b) => b !== null).join('')), `${it.id} shows the answer`);
    if (it.type === 'shift' || (it.type === 'twos' && a.bits)) assert.ok(m.includes(a.bits.slice().reverse().join('')), `${it.id} shows the bits`);
    if (it.type === 'twos' && a.value !== undefined) assert.ok(m.includes(String(a.value)), `${it.id} shows the value`);
    if (it.type === 'sadd') assert.ok(m.includes(a.bits.slice().reverse().join('')), `${it.id} shows the result`);
    if (it.type === 'card') assert.ok(Object.values(a).some((v) => v === 'overflow error' || v === 'error' || m.includes(String(v))), `${it.id} shows the answer`);
  }
});

test('the prompts file and the scoring sheet match the items', () => {
  const dir = path.join(tmp, 'files');
  gen.writeAll(ITEMS, dir);
  const text = fs.readFileSync(path.join(dir, 'e0-prompts.txt'), 'utf8');
  const blocks = [...text.matchAll(/^======== (E0-\d{3}) · copy from the next line ========\n([\s\S]*?)\n======== \1 · end ========$/gm)];
  assert.equal(blocks.length, 200);
  blocks.forEach((b, i) => { assert.equal(b[1], ITEMS[i].id); assert.equal(b[2], ITEMS[i].message); });
  const jsonl = fs.readFileSync(path.join(dir, 'e0-items.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(jsonl, ITEMS);
  const sheet = score.parseCsv(fs.readFileSync(path.join(dir, 'e0-scoring.csv'), 'utf8'));
  assert.deepEqual(sheet[0], ['id', 'model', 'response', 'answer_ok', 'column_ok', 'misconception_ok', 'rater']);
  assert.equal(sheet.length, 1 + 200 * gen.MODELS.length);
  assert.ok(sheet.slice(1).every((r) => r.length === 7 && r.slice(2).every((c) => c === '')));
});

// ---------------------------------------------------------------------------
// Scoring: hand-written items and fake replies
// ---------------------------------------------------------------------------

const T = (tag, w, parts, locate) => ({ id: 'T', tag, key: { w, parts, locate } });
const CASES = [
  {
    item: T('add_or', 8, { bits: '10001101', overflow: 'yes' }, [{ kind: 'col', cols: [6], w: 8 }]),
    replies: [
      [`Let's go column by column.
- 1s column: 1 + 0 = 1 ✓
- 2s column: 0 + 0 = 0 ✓
- 64s column: 1 + 1 = 10, so write 0 and carry 1. You wrote 1 here, which is the mistake: you treated 1 + 1 as 1.
So the answer is **1000 1101** and there is an overflow, because a 1 carries out of the top column.`, [true, true, true]],
      ['Your answer looks right to me: 11001101 is correct and there is no overflow.', [false, false, false]],
      ['The first mistake is in bit 3, where you forgot to carry. The answer is 10001101 with overflow.', [true, false, false]],
      ["The mistake is in the 7th column from the right: you wrote 1 for 1 + 1. It should be 1000 1101, and there's no overflow.", [false, true, true]],
      ['In the 64s column 1 OR 1 gives 1, but binary addition gives 10. Answer: 0b10001101 (overflow).', [true, false, true]],
      ['Everything is fine until column 7 (counting from the right): you added 1 + 1 and wrote 1. It should be 0 with a carry. Answer 10001101, overflow: yes.', [true, true, true]],
      ['Starting from the rightmost bit, all is fine until the 8s column, where 1 + 1 + 1 = 11, so write 1 and carry 1.', [false, false, false]],
    ],
  },
  {
    item: T('add_no_carry', 8, { bits: '01000010' }, [{ kind: 'col', cols: [2, 3], w: 8 }]),
    replies: [
      ["In the 4s column, 1 + 1 = 10, so write 0 and carry 1 into the 8s column, but you didn't carry the 1. Correct answer: 0100 0010.", [true, true, true]],
      ['1s column: 0 + 0 = 0. 2s column: 1 + 1 = 10. 4s column: 1 + 1 + 1 = 11. 8s column: 1 + 0 + 1 = 10. Something is off somewhere.', [false, false, false]],
      ['Your 1s, 2s and 4s columns are fine, but the 16s column is wrong. The answer is 1 0100 0010.', [false, false, false]],
    ],
  },
  {
    item: T('add_overflow_false', 8, { overflow: 'no' }, [{ kind: 'overflow', want: 'no' }]),
    replies: [
      ['Your sum is right, but there is no overflow: nothing carries out of the top column, so 204 fits in 8 bits.', [true, true, true]],
      ['Yes, there is an overflow, because 204 is a big number.', [false, false, false]],
    ],
  },
  {
    item: T('add_ninth_bit', 8, { bits: '01000010' }, [{ kind: 'col', cols: [8], w: 8 }, { kind: 'phrase', set: 'ninth' }]),
    replies: [
      ['Every column is right, but an 8-bit answer has only 8 bits: the 9th bit is lost, and that is the overflow. So the answer is 0100 0010.', [true, true, true]],
      ['Looks good: 1 0100 0010 with an overflow.', [false, false, false]],
    ],
  },
  {
    item: T('shift_value_myth', 8, { number: 8 }, [{ kind: 'phrase', set: 'value' }]),
    replies: [
      ["Your bits are right, but 66 × 4 = 264 doesn't fit in 8 bits, so read the value from the bits: 8.", [true, true, true]],
      ['The answer is 264.', [false, false, false]],
    ],
  },
  {
    item: T('shift_kept_bits', 8, { bits: '01000000' }, [{ kind: 'col', cols: [0, 1], w: 8 }, { kind: 'phrase', set: 'fallOff' }]),
    replies: [
      ["When you shift left, the bits that fall off the left end are lost; they don't wrap around. So it's 0100 0000.", [true, true, true]],
      ['Shifting left by 3 multiplies by 8, so the answer is 01000010.', [false, false, false]],
    ],
  },
  {
    item: T('shift_fill', 8, { bits: '01100010' }, [{ kind: 'col', cols: [0], w: 8 }, { kind: 'phrase', set: 'gap' }]),
    replies: [
      ['You filled the gap on the right with a 1, but a left shift always fills it with 0s. So the rightmost bit is 0: 0110 0010.', [true, true, true]],
      // a general explanation that never says what the student did wrong
      ['A left shift moves every bit one place left and fills the gap with 0s. So the answer is 01100010.', [true, false, true]],
    ],
  },
  {
    item: T('twos_no_plus1', 8, { number: -95 }, [{ kind: 'phrase', set: 'plusOne' }]),
    replies: [
      ['You inverted the bits but forgot to add 1: 01011110 + 1 = 01011111 = 95, so the value is -95.', [true, true, true]],
      ['To read a negative number, invert and add 1: 01011110 + 1 = 01011111 = 95, so it is -95.', [true, false, false]],
    ],
  },
  {
    item: T('twos_msb_positive', 8, { number: -41 }, [{ kind: 'col', cols: [7], w: 8 }, { kind: 'phrase', set: 'topBit' }]),
    replies: [
      ['The leftmost bit is worth -128, not +128, so the value is −41.', [true, true, true]],
      ['You got 215, which is 11010111 read as unsigned. The answer is 41.', [false, false, true]],
    ],
  },
  {
    item: T('twos_range', 8, { numbers: [-128, 127] }, [{ kind: 'phrase', set: 'rangeMin' }, { kind: 'number', n: -128 }]),
    replies: [
      ['The smallest value is -128, not -127, so the range is -128 to 127: zero takes one of the non-negative patterns.', [true, true, true]],
      ['The range is -127 to 127, the same as you said.', [false, false, false]],
    ],
  },
  {
    item: T('flags_carry_is_overflow', 8, { flags: { OF: 0 } }, [{ kind: 'flag', flags: ['OF'] }]),
    replies: [
      ["CF = 1 is right, but OF should be 0: a carry out doesn't mean a signed overflow, and -94 + 125 = 31 fits.", [true, true, true]],
      ['Everything is correct: CF = 1 and OF = 1.', [false, false, false]],
    ],
  },
  {
    item: T('flags_sub_carry', 8, { flags: { CF: 0 } }, [{ kind: 'flag', flags: ['CF'] }]),
    replies: [
      ["The problem is CF: after a subtraction CF means a borrow, the opposite of the adder's carry out. 70 − 22 needs no borrow, so the carry flag is clear.", [true, true, true]],
      ['Your flags look right to me.', [false, false, false]],
    ],
  },
  {
    item: { id: 'T', tag: 'c_truncating_division', key: { parts: { output: '-3 -6' }, locate: [{ kind: 'line', line: 5, frags: ['a / b', 'c % d', '29 / -8', 'divis', 'remainder'] }] } },
    replies: [
      ['C division truncates toward zero, so 29 / -8 is -3, not -4. It prints -3 -6.', [true, true, true]],
      ['It prints -4 -6, the same as maths gives.', [false, false, false]],
    ],
  },
  {
    item: { id: 'T', tag: 'c_jump_signedness', key: { parts: { message: 'not less' }, locate: [{ kind: 'line', line: 3, frags: ['a < b', 'compar', 'jump', 'cmp', 'jae', 'jge'] }] } },
    replies: [
      ['b is unsigned, so the comparison is unsigned: -11 becomes 4294967285. The compiler uses jae, an unsigned jump, so it prints "not less".', [true, true, true]],
      ['-11 is smaller than 24, so it prints "less". You are right.', [false, false, false]],
    ],
  },
  {
    item: { id: 'T', tag: 'c_usual_conversions', key: { parts: { output: '1' }, locate: [{ kind: 'line', line: 3, frags: ['a > b', 'compar'] }] } },
    replies: [
      ['In a > b the int is converted to unsigned, so -4 becomes 4294967292, which is bigger than 0. The program prints 1.', [true, true, true]],
      ['-4 is not bigger than 0, so it prints 0. The carry is 1 though.', [false, false, false]],
    ],
  },
];

test('score.mjs: hand-written replies, true and false positives', () => {
  for (const { item, replies } of CASES) {
    for (const [text, [a, c, m]] of replies) {
      const got = score.scoreResponse(item, text);
      assert.deepEqual([got.answer_ok, got.column_ok, got.misconception_ok], [a, c, m], `${item.tag}: ${text}`);
    }
  }
});

// For every tag: a reply that names the misconception, and one that does not.
const NAMES = {
  add_or: ['You treated 1 + 1 as 1, as if it were OR.', 'You forgot to carry the 1.'],
  add_no_carry: ["You didn't carry the 1 into the next column.", 'You treated 1 + 1 as 1.'],
  add_three_ones: ['In the 8s column 1 + 1 + 1 = 11, so write 1 and carry 1, not 0.', 'In the 8s column 1 + 1 = 10.'],
  add_carry_wrong_col: ['Your carries are written one column to the right of where they belong.', 'You forgot a carry.'],
  add_ninth_bit: ["The 9th bit doesn't fit in an 8-bit answer, so leave it out.", 'Your answer is too big.'],
  add_overflow_missed: ['There is an overflow, because a 1 carries out of the top column.', 'There is no overflow here.'],
  add_overflow_false: ['There is no overflow, since nothing carries out of the top column.', 'There is an overflow.'],
  shift_direction: ['You shifted left instead of right.', 'You shifted by 2 places instead of 1.'],
  shift_amount: ['You shifted 2 places instead of 1.', 'You shifted left instead of right.'],
  shift_kept_bits: ['The bits that fall off the end are lost; you rotated them round.', 'You filled the gap with 1s.'],
  shift_fill: ['The gap should be filled with 0s, not 1s.', 'You shifted the wrong way.'],
  shift_value_myth: ['Multiplying by 4 only works when no 1s fall off; here a 1 was lost.', 'The value is 8.'],
  shift_arith_logical: ['An arithmetic right shift copies the sign bit into the gap.', 'You moved the right number of places, but the gap is wrong.'],
  twos_sign_magnitude: ["You used sign and magnitude, not two's complement.", 'You forgot to add 1.'],
  twos_no_plus1: ['You inverted the bits but forgot to add 1.', 'You used sign and magnitude.'],
  twos_msb_positive: ['The top bit is worth -128, not +128.', 'You forgot to add 1.'],
  twos_range: ['The range is -128 to 127, because zero takes one of the patterns.', 'The range is -127 to 127.'],
  flags_carry_is_overflow: ['A carry out is not the same as an overflow for signed numbers.', 'OF should be 0.'],
  flags_signed_overflow_missed: ['Two positive numbers gave a negative result, so there is an overflow.', 'There is no overflow.'],
  flags_sub_carry: ['After a subtraction, CF means a borrow.', 'CF should be 0.'],
  c_signed_overflow: ['Signed overflow is undefined behaviour; at -O0 the add just wraps round.', 'It prints a big number.'],
  c_usual_conversions: ['a is converted to unsigned, so -1 becomes 4294967295.', '-1 is less than 0.'],
  c_promotion: ['Both unsigned chars are promoted to int before the addition.', 'The sum is 300.'],
  c_truncating_division: ['C division truncates toward zero.', 'The answer is -4.'],
  c_shift_negative: ['gcc uses an arithmetic shift (sar), which copies the sign bit.', 'Shifting right divides by 2.'],
  c_char_signedness: ['A plain char is signed on x86-64, so it holds -128 to 127.', 'It prints 200.'],
  c_unsigned_wrap: ["An unsigned int can't go negative, so it wraps round to 4294967295.", 'It prints -1.'],
  c_narrowing: ['A short only keeps the low 16 bits, so the value is truncated.', 'It prints 70000.'],
  c_jump_signedness: ['The compiler uses jae, an unsigned jump, not jge.', 'It prints less.'],
};

test('score.mjs: a rule for every tag, each with a true and a false case', () => {
  assert.deepEqual(Object.keys(NAMES).sort(), [...gen.E0_TAGS].sort());
  for (const [tag, [yes, no]] of Object.entries(NAMES)) {
    const item = { tag, key: { w: 8 } };
    assert.equal(score.misconceptionOk(item, yes), true, `${tag} named: ${yes}`);
    assert.equal(score.misconceptionOk(item, no), false, `${tag} not named: ${no}`);
  }
});

test("score.mjs: the app's own explanation of each misconception is recognised", () => {
  for (const tag of gen.E0_TAGS) assert.equal(score.misconceptionOk({ tag, key: { w: 8 } }, TAGS[tag].student), true, `${tag}: ${TAGS[tag].student}`);
});

test("score.mjs: a reply that points at each key's own step gets column_ok", () => {
  for (const it of ITEMS) {
    const reply = `The mistake is here: ${it.key.step}.`;
    assert.equal(score.columnOk(it, reply), true, `${it.id} ${it.tag}: ${reply}`);
  }
});

test('score.mjs: the building blocks', () => {
  assert.deepEqual([...score.locations('the 4th column from the right', 8)], [3]);
  assert.deepEqual([...score.locations('column 2 from the left', 8)], [6]);
  assert.deepEqual([...score.locations('the 2³ place', 8)], [3]);
  assert.deepEqual([...score.locations("the eight's column", 8)], [3]);
  assert.deepEqual([...score.locations('bits 5 and 6', 8)].sort(), [5, 6]);
  assert.deepEqual([...score.locations('the sign bit', 8)], [7]);
  assert.deepEqual([...score.locations('the 9th bit', 8)], [8]);
  assert.deepEqual([...score.locations('an 8-bit number, the 3rd bit, column 3', 8)], [], 'ambiguous positions are not counted');
  assert.equal(score.hasBits('answer: 0110 1010', '01101010'), true);
  assert.equal(score.hasBits('0 1 1 0 1 0 1 0', '01101010'), true);
  assert.equal(score.hasBits('`01101010`₂', '01101010'), true);
  assert.equal(score.hasBits('1 0110 1010', '01101010'), false, 'a 9-bit answer does not contain the 8-bit one');
  assert.equal(score.hasBits('101101010', '01101010'), false);
  assert.equal(score.hasNumber('It prints −56.', -56), true);
  assert.equal(score.hasNumber('56', -56), false);
  assert.equal(score.hasNumber('prints 0', 0), true);
  assert.equal(score.hasNumber('bits 3-4', -4), false);
  assert.equal(score.hasNumber('4,294,967,295', 4294967295), true);
  assert.deepEqual(score.overflowVerdicts('You said no overflow, but there is an overflow.'), { yes: true, no: true });
  assert.deepEqual(score.overflowVerdicts("you don't get an overflow"), { yes: false, no: true });
  assert.deepEqual(score.overflowVerdicts('It never overflows.'), { yes: false, no: true });
  assert.deepEqual([...score.flagValues('the overflow flag (OF) is set', 'OF')], [1]);
  assert.deepEqual([...score.flagValues('OF is not set, and of course CF = 1', 'OF')], [0]);
  assert.equal(score.hasMessage('it prints "not less"', 'less'), false);
  assert.equal(score.hasMessage('it prints "less", not "not less"', 'less'), true);
});

// Replies built from each generated item's key: one that states the right
// answer gets answer_ok; one that only repeats the student's answer never does.
function statesKey(it) {
  const p = it.key.parts;
  const s = [];
  if (p.bits) s.push(`The correct answer is ${p.bits}.`);
  if (p.number !== undefined) s.push(`The answer is ${p.number}.`);
  if (p.numbers) s.push(`The range is ${p.numbers[0]} to ${p.numbers[1]}.`);
  if (p.overflow) s.push(p.overflow === 'yes' ? 'There is an overflow.' : 'There is no overflow.');
  if (p.flags) s.push(Object.entries(p.flags).map(([f, v]) => `${f} should be ${v}.`).join(' '));
  if (p.output !== undefined) s.push(`It prints ${p.output}.`);
  if (p.message !== undefined) s.push(`It prints "${p.message}".`);
  return s.join(' ');
}
function repeatsStudent(it) {
  const a = it.learner.answer;
  const bits = (b) => b.slice().reverse().filter((x) => x !== null).join('');
  if (it.type === 'add') return `Your answer ${bits(a.result)} is right, and ${a.overflow === 'yes' ? 'there is an overflow' : 'there is no overflow'}.`;
  if (it.type === 'shift') return `You got ${bits(a.bits)}${a.value !== null && a.value !== undefined ? `, which is ${a.value}` : ''}.`;
  if (it.type === 'twos') return a.bits ? `It is ${bits(a.bits)}.` : a.value !== undefined ? `It is ${a.value}.` : `The range is ${a.min} to ${a.max}.`;
  if (it.type === 'sadd') return `${bits(a.bits)}, ${Object.entries(a.flags).map(([f, v]) => (f === 'OF' && it.route === 'schools' ? (v ? 'there is an overflow' : 'there is no overflow') : `${f} = ${v}`)).join(', ')}.`;
  const v = Object.values(a)[0];
  return typeof v === 'string' && !/^-?\d/.test(v) && !['less', 'not less', 'greater', 'not greater'].includes(v) ? `It gives ${v}.` : `It prints ${typeof v === 'string' && /[a-z]/.test(v) ? `"${v}"` : v}.`;
}

test('score.mjs on every generated item: the key scores, the student\'s own answer does not', () => {
  for (const it of ITEMS) {
    assert.equal(score.answerOk(it, statesKey(it)), true, `${it.id} ${it.tag}: ${statesKey(it)}`);
    if (it.tag === 'add_carry_wrong_col') continue;   // only the working was wrong, the answer was right
    assert.equal(score.answerOk(it, repeatsStudent(it)), false, `${it.id} ${it.tag}: ${repeatsStudent(it)}`);
    assert.equal(score.scoreResponse(it, 'I am not sure, sorry. Can you share more details?').column_ok, false, `${it.id} empty reply`);
    assert.equal(score.scoreResponse(it, 'I am not sure, sorry. Can you share more details?').misconception_ok, false, `${it.id} empty reply`);
  }
});

// ---------------------------------------------------------------------------
// Statistics and the rule
// ---------------------------------------------------------------------------

test('Wilson intervals match known values', () => {
  const near = (x, y) => assert.ok(Math.abs(x - y) < 5e-5, `${x} ≈ ${y}`);
  const known = [[5, 10, 0.2366, 0.7634], [0, 10, 0, 0.2775], [10, 10, 0.7225, 1], [190, 200, 0.9104, 0.9726]];
  for (const [k, n, lo, hi] of known) { const w = score.wilson(k, n); near(w.lo, lo); near(w.hi, hi); near(w.p, k / n); }
  assert.equal(score.wilson(0, 0).p, null);
});

test("Cohen's kappa matches a hand calculation", () => {
  // 50 items: both yes 20, A yes / B no 5, A no / B yes 10, both no 15.
  // po = 35/50 = 0.7; pe = 0.5 × 0.6 + 0.5 × 0.4 = 0.5; κ = (0.7 − 0.5) / (1 − 0.5) = 0.4
  const pairs = [...Array(20).fill([true, true]), ...Array(5).fill([true, false]), ...Array(10).fill([false, true]), ...Array(15).fill([false, false])];
  const k = score.cohenKappa(pairs);
  assert.equal(k.n, 50);
  assert.ok(Math.abs(k.po - 0.7) < 1e-12 && Math.abs(k.pe - 0.5) < 1e-12 && Math.abs(k.kappa - 0.4) < 1e-12);
  assert.equal(score.cohenKappa([[true, true], [false, false]]).kappa, 1);
  assert.equal(score.cohenKappa([[true, true], [true, true]]).kappa, null, 'undefined when both raters never vary');
});

test('the pre-registered E0 rule', () => {
  const rows = (model, route, k, n) => Array.from({ length: n }, (_, i) => ({ model, route, family: route === 'university' ? 'c' : 'add', final: { column_ok: i < k } }));
  const r1 = score.applyRule([...rows('a', 'schools', 150, 150), ...rows('a', 'university', 42, 50), ...rows('b', 'schools', 140, 150), ...rows('b', 'university', 40, 50)], 200);
  assert.equal(r1.all.find((r) => r.model === 'a').p, 0.96);
  assert.deepEqual(r1.reached, ['a']);
  assert.equal(r1.schools, 'drop');
  assert.equal(r1.university, 'keep', 'the gap holds on the x86 items');
  const r2 = score.applyRule([...rows('a', 'schools', 150, 150), ...rows('a', 'university', 49, 50)], 200);
  assert.equal(r2.schools, 'drop');
  assert.equal(r2.university, 'drop');
  const r3 = score.applyRule([...rows('a', 'schools', 140, 150), ...rows('a', 'university', 50, 50)], 200);
  assert.equal(r3.all[0].p, 0.95);
  assert.equal(r3.schools, 'drop', 'exactly 95% counts');
  const r4 = score.applyRule([...rows('a', 'schools', 139, 150), ...rows('a', 'university', 50, 50)], 200);
  assert.equal(r4.schools, 'keep');
  assert.deepEqual(score.applyRule(rows('a', 'schools', 10, 10), 200).incomplete, ['a (10 of 200)']);
});

test('CSV round trip with quotes, commas and line breaks', () => {
  const rows = [['id', 'response'], ['E0-001', 'He said "no",\nthen 1,0'], ['E0-002', '']];
  assert.deepEqual(score.parseCsv(score.toCsv(rows)), [rows[0], rows[1], ['E0-002', '']]);
  assert.deepEqual(score.parseCsv('﻿a,b\r\n1,"x\r\ny"\r\n'), [['a', 'b'], ['1', 'x\r\ny']]);
  assert.equal(score.safeCell('=SUM(A1)'), "'=SUM(A1)");
});

test('score.mjs command line: report, scored sheet, 20% sample, kappa with a rater file', () => {
  const dir = path.join(tmp, 'cli');
  node(GEN, '--out', dir);
  const pickTag = (tag) => ITEMS.find((it) => it.tag === tag);
  const good = { add_overflow_missed: 'All your columns are right, but there is a carry out of the top column, so there is an overflow: the sum does not fit in 8 bits.' };
  const it = pickTag('add_overflow_missed');
  const rows = [['id', 'model', 'response']];
  for (const model of ['m1', 'm2']) {
    ITEMS.slice(0, 10).forEach((x, i) => rows.push([x.id, model, i % 2 ? statesKey(x) : 'Looks right to me.']));
    rows.push([it.id, model, good.add_overflow_missed]);
  }
  rows.push(['E0-999', 'm1', 'unknown id'], [ITEMS[20].id, 'm1', '']);
  const resp = path.join(dir, 'responses.csv');
  fs.writeFileSync(resp, score.toCsv(rows));
  const out1 = node(SCORE, resp);
  assert.match(out1, /≥ 95% column_ok → drop "verified" from the schools pitch/);
  assert.match(out1, /Not every item has a reply yet/);
  assert.match(out1, /Unknown ids skipped: E0-999/);
  assert.match(out1, /1 row without a reply were skipped|1 row without a reply was skipped/);
  const scored = score.readTable(fs.readFileSync(path.join(dir, 'e0-scored.csv'), 'utf8'));
  assert.equal(scored.length, 22);
  const row = scored.find((r) => r.id === it.id && r.model === 'm1');
  assert.deepEqual([row.answer_ok, row.column_ok, row.misconception_ok], ['1', '1', '1']);
  const sample = score.readTable(fs.readFileSync(path.join(dir, 'e0-rater-sample.csv'), 'utf8'));
  assert.equal(sample.length, 2 * Math.ceil(11 * 0.2));
  assert.ok(sample.every((r) => r.answer_ok === '' && r.correct_answer && r.first_wrong_step && r.misconception && r.student_message));

  // A second rater fills in the sample; the file is not overwritten on the next run.
  const rated = sample.map((r) => ({ ...r, answer_ok: '1', column_ok: '0', misconception_ok: 'yes', rater: 'rater2' }));
  const head = Object.keys(rated[0]);
  fs.writeFileSync(path.join(dir, 'e0-rater-sample.csv'), score.toCsv([head, ...rated.map((r) => head.map((h) => r[h]))]));
  const out2 = node(SCORE, resp, '--rater', path.join(dir, 'e0-rater-sample.csv'));
  assert.match(out2, /automatic vs rater2\s+answer_ok\s+κ =/);
  assert.match(out2, /already exists, so it was left alone/);
  assert.match(out2, /Human scores used on \d+ rows?/);
  assert.equal(score.readTable(fs.readFileSync(path.join(dir, 'e0-rater-sample.csv'), 'utf8'))[0].rater, 'rater2');
  const dis = score.readTable(fs.readFileSync(path.join(dir, 'e0-disagreements.csv'), 'utf8'));
  assert.ok(dis.length > 0 && dis.every((d) => d.rater === 'rater2'));
  const scored2 = score.readTable(fs.readFileSync(path.join(dir, 'e0-scored.csv'), 'utf8'));
  for (const r of sample) {
    const s = scored2.find((x) => x.id === r.id && x.model === r.model);
    assert.deepEqual([s.answer_ok, s.column_ok, s.misconception_ok, s.source], ['1', '0', '1', 'human'], 'the human decides');
  }
});
