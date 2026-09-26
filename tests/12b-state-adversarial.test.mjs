// Adversarial checks on the state, codes and study layer: what a careless
// caller, damaged storage, a doctored link, a huge paste or a small class
// would do to it.
//   · codec: exact bit layouts, overflowing fields refused or clamped (never
//     silently changed), tampered codes refused, garbage decoded fast
//   · scheduler: month / year / DST boundaries, repeated misses, early and
//     late reviews, importing a link twice, states from older builds,
//     untrusted review links
//   · study: arms cannot be picked, recoverArm only trusts the linked set,
//     the crossover CI against hand calculations and simulation
//   · starter / sets: deterministic and crash-free on odd histories
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import * as codec from '../machine/src/lib/codec.js';
import * as sched from '../machine/src/learn/scheduler.js';
import * as study from '../machine/src/learn/study.js';
import * as sets from '../machine/src/learn/sets.js';
import * as starter from '../machine/src/learn/starter.js';
import * as board from '../machine/src/learn/board.js';
import { SPECS, specById } from '../machine/src/learn/spec.js';
import { TAG_IDS } from '../machine/src/learn/tagids.js';
import { mulberry32, randInt, pick, hashStr } from '../machine/src/lib/rng.js';
import { ITEM_TYPES, makeItem, itemForSpec } from '../machine/src/learn/items/index.js';

const { B32, BitWriter, BitReader } = codec;
const rngFor = (seed) => mulberry32(seed);
const ms = (f) => { const t = performance.now(); f(); return performance.now() - t; };

/** seal arbitrary field values the way codec.js does (for building tampered codes with a valid CRC) */
function seal(fields) {
  const w = new BitWriter();
  for (const [v, n] of fields) w.put(v, n);
  while ((w.length + 13) % 5) w.put(0, 1);
  w.put(codec.crcBits(w.bits), 13);
  return codec.toB32(w.bits);
}
const setFields = ({ v = 1, lv = 0, mask = 1, n = 10, md = 0, has = 0, link = 0, seed = 5 } = {}) =>
  [[v, 2], [lv, 2], [mask, 6], [n, 4], [md, 2], [has, 1], [link, 10], [seed, 30]];
const tokenFields = ({ v = 1, setId = 9, md = 0, g1r = 1, g1t = 2, g2r = 0, g2t = 1, arm = 3, tags = [0, 0, 0] } = {}) =>
  [[v, 2], [setId, 10], [md, 2], [g1r, 4], [g1t, 4], [g2r, 4], [g2t, 4], [arm, 2], ...tags.map((t) => [t, 5])];

// ---------------------------------------------------------------------------
// codec: layouts
// ---------------------------------------------------------------------------

test('codec: result token bit layout is exactly the contract (60 bits, CRC over the 47 data bits)', () => {
  const tok = codec.encodeToken({ setId: 0x2ab, mode: 'delayed', g1: { right: 3, total: 9 }, g2: { right: 7, total: 15 }, arm: 1, tags: [5, 'c_narrowing', 31] });
  const bits = codec.fromB32(tok);
  assert.equal(bits.length, 60);
  const r = new BitReader(bits);
  const got = [2, 10, 2, 4, 4, 4, 4, 2, 5, 5, 5].map((n) => r.take(n));
  assert.deepEqual(got, [1, 0x2ab, 2, 3, 9, 7, 15, 1, 5, TAG_IDS.indexOf('c_narrowing'), 31]);
  assert.equal(r.take(13), codec.crcBits(bits.slice(0, 47)));
  assert.equal(seal(tokenFields({ setId: 0x2ab, md: 2, g1r: 3, g1t: 9, g2r: 7, g2t: 15, arm: 1, tags: [5, 28, 31] })), codec.normB32(tok));
});

test('codec: set code bit layout is exactly the contract (70 bits = 14 chars) and setId = hash(code) & 0x3FF', () => {
  const code = codec.encodeSet({ level: 'csapp', topics: ['shift', 'c'], n: 13, seed: 0x2345678, mode: 'delayed', link: 777 });
  assert.equal(code.length, 14);
  const r = new BitReader(codec.fromB32(code));
  const got = [2, 2, 6, 4, 2, 1, 10, 30].map((n) => r.take(n));
  assert.deepEqual(got, [1, 2, 0b100010, 13, 2, 1, 777, 0x2345678]);
  assert.equal(r.take(13), codec.crcBits(codec.fromB32(code).slice(0, 57)));
  const d = codec.decodeSet(code.toLowerCase().replace(/(.{4})/g, '$1-'));
  assert.equal(d.setId, hashStr(code) & 0x3ff, 'setId hashes the canonical code, whatever the pasted form');
  assert.equal(d.code, code);
});

// ---------------------------------------------------------------------------
// codec: overflow and tampering
// ---------------------------------------------------------------------------

test('codec: overflowing token fields are refused or clamped, never silently changed', () => {
  const base = { setId: 1, mode: 'normal', g1: { right: 1, total: 2 }, g2: { right: 0, total: 1 } };
  for (const g1 of [{ right: 0, total: 16 }, { right: 3, total: 2 }, { right: -1, total: 2 }, { right: 1.5, total: 2 }, null]) {
    assert.throws(() => codec.encodeToken({ ...base, g1 }), RangeError);
  }
  assert.throws(() => codec.encodeToken({ ...base, g2: undefined }), RangeError);
  assert.throws(() => codec.encodeToken({ ...base, setId: 1024 }), RangeError);
  assert.throws(() => codec.encodeToken({ ...base, mode: 'exam' }), RangeError);
  assert.throws(() => codec.encodeToken({ ...base, tags: [32] }), RangeError);
  // more than three tags: the first three distinct ones; repeats written once
  const many = codec.decodeToken(codec.encodeToken({ ...base, tags: ['add_or', 'add_or', null, 'shift_fill', 'add_or', 'twos_range', 'c_narrowing'] }));
  assert.deepEqual(many.tags, ['add_or', 'shift_fill', 'twos_range']);
  // a misconception id this build does not know is reported as 'other', not dropped
  assert.deepEqual(codec.decodeToken(codec.encodeToken({ ...base, tags: ['not_a_tag', 'add_or'] })).tags, ['other', 'add_or']);
  // arm: study/delayed tokens without a real arm say "unknown"; normal tokens never carry one
  for (const arm of [undefined, null, 2, 3, 7, '1', 'A']) {
    assert.equal(codec.decodeToken(codec.encodeToken({ ...base, mode: 'study', arm })).arm, codec.ARM_UNKNOWN, String(arm));
  }
  assert.equal(codec.decodeToken(codec.encodeToken({ ...base, arm: 1 })).arm, codec.ARM_NONE);
});

test('codec: tokens with a valid CRC but impossible fields are refused', () => {
  assert.equal(codec.decodeToken(seal(tokenFields())).error, undefined, 'the helper builds valid tokens');
  const bad = {
    'version 0': { v: 0 }, 'version 2': { v: 2 }, 'mode 3': { md: 3 }, 'right > total': { g1r: 3, g1t: 2 },
    'normal with an arm': { arm: 0 }, 'study without arm field': { md: 1, arm: 3 },
    'tag after a gap': { tags: [0, 5, 0] }, 'repeated tag': { tags: [5, 5, 0] }, 'repeated later': { tags: [4, 6, 4] },
  };
  for (const [name, f] of Object.entries(bad)) assert.ok(codec.decodeToken(seal(tokenFields(f))).error, name);
});

test('codec: set codes refuse every single-character change, every adjacent swap and impossible fields', () => {
  const rng = rngFor(21);
  for (let k = 0; k < 150; k++) {
    const code = codec.encodeSet({ level: pick(rng, codec.LEVELS), topics: ['add', 'twos'].filter(() => rng() < 0.7).concat('fa'),
      n: randInt(rng, 5, 15), seed: randInt(rng, 0, 2 ** 30 - 1), mode: pick(rng, codec.MODES), link: rng() < 0.5 ? randInt(rng, 0, 1023) : null });
    for (let i = 0; i < 14; i++) {
      for (const c of B32) {
        if (c !== code[i]) assert.throws(() => codec.decodeSet(code.slice(0, i) + c + code.slice(i + 1)), Error);
      }
      if (i < 13 && code[i] !== code[i + 1]) {
        assert.throws(() => codec.decodeSet(code.slice(0, i) + code[i + 1] + code[i] + code.slice(i + 2)), Error);
      }
    }
  }
  const bad = { 'level 3': { lv: 3 }, 'mode 3': { md: 3 }, 'n 4': { n: 4 }, 'n 0': { n: 0 }, 'no topics': { mask: 0 },
    'link bits without the flag': { link: 5 }, 'version 2': { v: 2 } };
  assert.doesNotThrow(() => codec.decodeSet(seal(setFields())));
  for (const [name, f] of Object.entries(bad)) {
    assert.throws(() => codec.decodeSet(seal(setFields(f))), (e) => e instanceof Error && e.message.length < 200, name);
  }
  assert.throws(() => codec.encodeSet({ level: 'gcse', topics: 'add', n: 5, seed: 1 }), RangeError, 'topics must be an array');
  assert.throws(() => codec.encodeSet({ level: 'gcse', topics: ['add'], n: 5, seed: 1, link: 1024 }), RangeError);
});

test('codec: garbage and huge input is refused quickly with a friendly message', () => {
  const huge = 'A'.repeat(5_000_000);
  const junk = Array.from({ length: 200_000 }, (_, i) => String.fromCharCode(33 + (i * 7919) % 90)).join('');
  let t = ms(() => assert.match(codec.decodeToken(huge).error, /12 characters/));
  assert.ok(t < 200, `token ${t} ms`);
  t = ms(() => assert.throws(() => codec.decodeSet(huge), /too long/));
  assert.ok(t < 200, `set ${t} ms`);
  t = ms(() => assert.throws(() => codec.decodeQueue(huge), /review link/));
  assert.ok(t < 200, `queue ${t} ms`);
  assert.throws(() => codec.decodeQueue(junk), /review link/);
  assert.ok(codec.decodeToken(junk).error);
  for (const v of [null, undefined, 42, {}, [], 'ÄÖÜ', '\u0000\u0000', '🙂'.repeat(12)]) {
    assert.ok(codec.decodeToken(v).error, String(v));
    assert.throws(() => codec.decodeSet(v), Error);
  }
  // random base32 of every plausible length never crashes the queue decoder (errors are friendly Errors)
  const rng = rngFor(22);
  for (let k = 0; k < 3000; k++) {
    const s = Array.from({ length: randInt(rng, 1, 80) }, () => pick(rng, [...B32])).join('');
    try { codec.decodeQueue(s); } catch (e) { assert.match(e.message, /review link/); }
  }
});

test('codec: a varuint past 2^53 is refused, not rounded', () => {
  const w = new BitWriter();
  for (let i = 0; i < 14; i++) w.put(i < 13 ? 1 : 0, 1).put(15, 4);   // 56 bits of ones
  assert.throws(() => new BitReader(w.bits).varuint(), /too long/);
  const ok = new BitWriter().varuint(Number.MAX_SAFE_INTEGER);
  assert.equal(new BitReader(ok.bits).varuint(), Number.MAX_SAFE_INTEGER);
});

test('codec: encodeQueue refuses what decodeQueue would refuse (a link that encodes always decodes)', () => {
  const e = { type: 0, params: [8, 1, 2, 0, 1], tag: 3, due: 20000, stage: 1, group: 'drill' };
  assert.deepEqual(codec.decodeQueue(codec.encodeQueue([e])), [e]);
  for (const bad of [{ type: 6 }, { type: -1 }, { type: 'add' }, { stage: 3 }, { stage: 1.5 }, { stage: -1 }, { tag: 32 },
    { due: -1 }, { due: 1.5 }, { due: undefined }, { params: [-1] }, { params: [0.5] }, { params: Array(17).fill(1) }]) {
    assert.throws(() => codec.encodeQueue([{ ...e, ...bad }]), RangeError, JSON.stringify(bad));
  }
  assert.throws(() => codec.encodeQueue(Array(201).fill(e)), RangeError);
  // stage defaults to 0 when absent; an unknown tag id becomes 'other' like in tokens
  assert.deepEqual(codec.decodeQueue(codec.encodeQueue([{ ...e, stage: undefined, tag: 'nope' }]))[0], { ...e, stage: 0, tag: 31 });
});

test('codec: review links survive URL round trips and stay short at the scheduler cap', () => {
  const rng = rngFor(23);
  const types = ['add', 'shift', 'twos', 'sadd', 'fa'];
  const entries = Array.from({ length: sched.MAX_QUEUE }, (_, i) => {
    const mod = ITEM_TYPES[types[i % 5]];
    const params = mod.generate(rng, { level: 'alevel', w: 16 });
    return { type: mod.TYPE_ID, params: mod.encodeParams(params), tag: randInt(rng, 0, 31), due: 20700 + randInt(rng, 0, 21), stage: randInt(rng, 0, 2), group: pick(rng, ['drill', 'holdout']) };
  });
  const q = codec.encodeQueue(entries);
  assert.ok(q.length < 1100, `${sched.MAX_QUEUE} 16-bit entries → ${q.length} characters`);
  assert.equal(encodeURIComponent(q), q);
  assert.equal(decodeURIComponent(encodeURIComponent(encodeURIComponent(q))), encodeURIComponent(q));
  const url = new URL(`https://example.org/machine/?t=x#/review/${q}`);
  assert.deepEqual(codec.decodeQueue(url.hash.slice('#/review/'.length)), entries);
  assert.deepEqual(codec.decodeQueue(decodeURIComponent(q.toLowerCase())), entries);
  assert.deepEqual(codec.decodeQueue(q.replace(/(.{5})/g, '$1-')), entries, 'separators are ignored');
});

// ---------------------------------------------------------------------------
// scheduler
// ---------------------------------------------------------------------------

const ITEM = { type: 0, params: [8, 200, 77, 0, 1] };
const miss = (s, today, o = {}) => sched.recordAttempt(s, { ...ITEM, correct: false, tag: 'add_no_carry', today, ...o });
const hit = (s, today, o = {}) => sched.recordAttempt(s, { ...ITEM, correct: true, today, ...o });

test('scheduler: month, year and leap-day boundaries are plain day arithmetic', () => {
  const dec30 = new Date(2026, 11, 30, 15);
  let s = miss(null, dec30);
  const due = sched.dayToDate(s.queue[0].due);
  assert.deepEqual([due.getFullYear(), due.getMonth(), due.getDate()], [2027, 0, 1]);
  assert.equal(sched.dueEntries(s, new Date(2026, 11, 31, 23, 59)).length, 0);
  assert.equal(sched.dueEntries(s, new Date(2027, 0, 1, 0, 1)).length, 1);
  s = hit(s, new Date(2027, 0, 1, 9));
  const d7 = sched.dayToDate(s.queue[0].due);
  assert.deepEqual([d7.getMonth(), d7.getDate()], [0, 8]);
  assert.equal(sched.dayNumber(new Date(2028, 1, 29)) - sched.dayNumber(new Date(2028, 1, 28)), 1);
  assert.equal(sched.dayNumber(new Date(2028, 2, 1)) - sched.dayNumber(new Date(2028, 1, 28)), 2);
  assert.equal(sched.dayNumber(new Date(2027, 2, 1)) - sched.dayNumber(new Date(2027, 1, 28)), 1);
  // day numbers and Dates can be mixed freely
  assert.deepEqual(miss(null, sched.dayNumber(dec30)).queue, s.queue.length && miss(null, dec30).queue);
});

test('scheduler: a review comes due on the right local day across DST changes (several zones)', () => {
  const url = new URL('../machine/src/learn/scheduler.js', import.meta.url).href;
  const script = `
    import * as s from ${JSON.stringify(url)};
    // [year, month, day of the clock change]; the miss is at 23:30 the evening before
    const days = [[2026, 2, 29], [2026, 9, 25], [2026, 2, 8], [2026, 10, 1], [2026, 8, 6], [2026, 3, 5], [2026, 9, 4]];
    const out = days.map(([y, m, d]) => {
      const st = s.recordAttempt(null, { type: 0, params: [8, 1, 2, 0, 1], correct: false, tag: 'add_or', today: new Date(y, m, d - 1, 23, 30) });
      const due = s.dayToDate(st.queue[0].due);
      return [s.dueEntries(st, new Date(y, m, d, 23, 59)).length, s.dueEntries(st, new Date(y, m, d + 1, 0, 30)).length,
        due.getDate() === new Date(y, m, d + 1, 12).getDate(), s.dayNumber(due) === st.queue[0].due];
    });
    console.log(JSON.stringify(out));`;
  for (const TZ of ['Europe/London', 'America/New_York', 'America/Santiago', 'Australia/Lord_Howe', 'Pacific/Auckland']) {
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ } }).toString());
    for (const row of out) assert.deepEqual(row, [0, 1, true, true], `${TZ}: ${JSON.stringify(out)}`);
  }
});

test('scheduler: repeated misses keep one entry at stage 0; lapses count only failed reviews', () => {
  const D = 20000;
  let s = null;
  for (let i = 0; i < 5; i++) s = miss(s, D);
  assert.equal(s.queue.length, 1);
  assert.deepEqual([s.queue[0].stage, s.queue[0].due, s.queue[0].lapses], [0, D + 2, 0]);
  s = miss(s, D + 2);                    // failed review
  s = miss(s, D + 4);                    // and again
  assert.deepEqual([s.queue.length, s.queue[0].stage, s.queue[0].due, s.queue[0].lapses], [1, 0, D + 6, 2]);
  assert.equal(sched.fading(s, 'add_no_carry').showWorked, true);
});

test('scheduler: early and late reviews', () => {
  const D = 20000;
  let s = miss(null, D);
  // early wrong: straight back to 2 days from today
  let e = miss(s, D + 1, { review: true });
  assert.deepEqual([e.queue[0].stage, e.queue[0].due], [0, D + 3]);
  // early right: no promotion, due day unchanged
  e = hit(s, D + 1, { review: true });
  assert.deepEqual([e.queue[0].stage, e.queue[0].due, e.queue[0].reviews], [0, D + 2, 1]);
  // very late right: one step up, the next interval counted from today
  e = hit(s, D + 60);
  assert.deepEqual([e.queue[0].stage, e.queue[0].due], [1, D + 67]);
  assert.deepEqual(sched.reviewAccuracy(e).drill, { right: 1, total: 1 }, 'a late first review is evidence');
  // late at the last stage: done on the day it is answered
  e = hit(hit(e, D + 67), D + 200);
  assert.equal(e.queue[0].done, D + 200);
});

test('scheduler: a miss before the review restarts the evidence clock in its new group', () => {
  const D = 20000;
  let s = miss(null, D, { group: 'holdout' });
  s = miss(s, D + 1, { group: 'drill' });     // seen again (with full feedback) before it was due
  assert.deepEqual([s.queue[0].miss, s.queue[0].group], [D + 1, 'drill']);
  s = hit(s, D + 3);
  s = hit(s, D + 10);                          // 9 days after the latest miss
  assert.deepEqual(sched.reviewAccuracy(s), { drill: { right: 1, total: 1 }, holdout: { right: 0, total: 0 } });
});

test('scheduler: bad days are refused, fractional days floored, nothing unusable is saved', () => {
  for (const today of [new Date('nope'), '2026-01-01', NaN, Infinity, {}]) {
    assert.throws(() => miss(null, today), RangeError, String(today));
  }
  assert.equal(miss(null, 20000.9).queue[0].due, 20002);
  assert.throws(() => sched.recordAttempt(null, { type: 0, params: [8, -1], correct: false, today: 1 }), RangeError);
  assert.throws(() => sched.recordAttempt(null, { type: 0, params: undefined, correct: false, today: 1 }), RangeError);
  assert.throws(() => sched.recordAttempt(null, { type: 9, params: [1], correct: false, today: 1 }), RangeError);
  assert.throws(() => sched.recordAttempt(null, { type: 'essay', params: [1], correct: false, today: 1 }), RangeError);
  assert.throws(() => sched.dueEntries(null, 'tomorrow'), RangeError);
});

test('scheduler: states from older builds or damaged storage load without crashes or duplicates', () => {
  const old = {
    queue: [
      { type: 0, params: [8, 200, 77, 0, 1], tag: 2, due: 100, stage: 0 },                 // no key, no miss
      { type: 'add', params: [8, 200, 77, 0, 1], tag: 2, due: 102, stage: 1, key: 'stale' }, // same item, further on
      { type: 1, params: [8, 13, 1, 2, 0, 1, 1], due: 90, stage: 7, tag: 'shift_fill' },    // silly stage, tag id
      null, 7, 'x', { type: 0 }, { type: 0, params: [1, -2], due: 1 }, { type: 99, params: [1], due: 1 }, { type: 0, params: [1], due: 'soon' },
    ],
    tags: { add_or: {}, add_no_carry: { streak: 'many' }, shift_fill: 3, twos_range: null },
    evidence: { drill: { right: '3', total: 2 }, holdout: null },
    session: { misses: null, shown: [1], seed: 'x' },
  };
  const q = sched.activeEntries(old);
  assert.equal(q.length, 2, 'junk dropped, the twin merged');
  assert.deepEqual(q.map((e) => [e.key, e.stage]), [['1:8.13.1.2.0.1.1', 2], ['0:8.200.77.0.1', 1]]);
  assert.equal(q[0].tag, TAG_IDS.indexOf('shift_fill'));
  assert.doesNotThrow(() => codec.decodeQueue(codec.encodeQueue(q)));
  assert.deepEqual(sched.fading(old, 'add_or'), { collapseWhy: false, showWorked: false });
  assert.deepEqual(sched.reviewAccuracy(old), { drill: { right: 0, total: 2 }, holdout: { right: 0, total: 0 } });
  let s = miss(old, 101);
  s = miss(s, 101);
  assert.equal(s.queue.filter((e) => e.key === '0:8.200.77.0.1').length, 1);
  s = sched.recordAttempt(s, { type: 0, params: [8, 1, 1, 0, 1], correct: true, target: 'add_no_carry', today: 101 });
  assert.equal(s.tags.add_no_carry.streak, 1);
  const json = JSON.parse(JSON.stringify(s));
  assert.deepEqual(sched.activeEntries(json), sched.activeEntries(s), 'what is saved reloads the same');
  for (const junk of [undefined, null, 5, 'state', [], { queue: 'no' }]) {
    assert.deepEqual(sched.queueSummary(junk, 1), { due: 0, later: 0, next: null });
  }
});

test('scheduler: importing a review link twice, or a link with repeats, adds nothing twice', () => {
  const D = 20000;
  let s = miss(null, D);
  s = sched.recordAttempt(s, { type: 1, params: [8, 13, 1, 2, 0, 1, 1], correct: false, tag: 'shift_fill', today: D });
  const q = codec.encodeQueue(sched.activeEntries(s));
  const once = sched.mergeQueue(null, codec.decodeQueue(q), D + 1);
  const twice = sched.mergeQueue(once.state, codec.decodeQueue(q), D + 1);
  assert.deepEqual([once.added, twice.added, twice.state.queue.length], [2, 0, 2]);
  const dup = codec.decodeQueue(q);
  const withRepeats = sched.mergeQueue(null, [...dup, ...dup, { ...dup[0], type: 'add' }], D + 1);
  assert.deepEqual([withRepeats.added, withRepeats.state.queue.length], [2, 2]);
  // merging into the device the link came from changes nothing
  const home = sched.mergeQueue(s, codec.decodeQueue(q), D + 1);
  assert.equal(home.added, 0);
  assert.deepEqual(home.state.queue, s.queue);
});

test('scheduler: the 60-entry cap holds when a link is merged into a full queue', () => {
  let s = null;
  for (let i = 0; i < 60; i++) s = sched.recordAttempt(s, { type: 0, params: [8, i, 1, 0, 1], correct: false, tag: 'add_or', today: 100 + i });
  const other = Array.from({ length: 30 }, (_, i) => ({ type: 0, params: [8, 100 + i, 3, 0, 1], tag: 1, due: 170, stage: 0, group: 'drill' }));
  const { state } = sched.mergeQueue(s, other, 168);
  assert.equal(state.queue.length, sched.MAX_QUEUE);
  assert.equal(new Set(state.queue.map((e) => e.key)).size, sched.MAX_QUEUE);
  assert.doesNotThrow(() => codec.encodeQueue(sched.activeEntries(state)));
});

test('scheduler: a doctored review link cannot plant an entry that breaks the review page', () => {
  const good = { type: 0, params: [8, 1, 2, 0, 1], tag: 2, due: 20000, stage: 0, group: 'drill' };
  const bad = [
    { ...good, params: [1e9, 1, 2, 0, 1] },               // w = 10^9 would hang the tab when built
    { ...good, params: [3, 1, 2, 0, 1] },                 // w below any generator
    { ...good, params: [8, 1, 2, 9, 1] },                 // ask 9 decodes to 'full', so it is not the same item
    { ...good, params: [8, 1, 2, 0, 1, 5] },              // extra ints
    { ...good, params: [8, -1, 2, 0, 1] },
    { ...good, params: 'x' }, { ...good, type: 9 }, { ...good, type: 5, params: [99, 0] },   // no such card
    { ...good, due: 1.5 }, null, 'entry',
  ];
  let t;
  const r = (t = performance.now(), sched.mergeQueue(null, [...bad, good, { ...good, params: [8, 3, 4, 0, 1], tag: 99 }], 20000));
  assert.ok(performance.now() - t < 500);
  assert.equal(r.added, 2);
  assert.deepEqual(r.state.queue.map((e) => e.params), [good.params, [8, 3, 4, 0, 1]]);
  assert.equal(r.state.queue[1].tag, 0, 'an impossible tag index is dropped');
  for (const e of sched.dueEntries(r.state, 20000)) {
    const mod = Object.values(ITEM_TYPES).find((m) => m.TYPE_ID === e.type);
    assert.ok(makeItem(mod.TYPE, mod.decodeParams(e.params)).key);
  }
  assert.equal(sched.mergeQueue(null, 'not a list', 1).added, 0);
});

test('scheduler: every item a generator (or a variant) can make survives a review link', () => {
  const rng = rngFor(24);
  const entries = [];
  for (const type of ['add', 'shift', 'twos', 'sadd', 'fa']) {
    const mod = ITEM_TYPES[type];
    for (let k = 0; k < 150; k++) {
      const opts = { level: pick(rng, ['gcse', 'alevel', 'csapp']), w: randInt(rng, 1, 20) };
      if (mod.TARGETS?.length && rng() < 0.5) opts.target = pick(rng, mod.TARGETS);
      let params = mod.generate(rng, opts);
      if (mod.TARGETS?.length && rng() < 0.3) params = mod.variant(makeItem(type, params), pick(rng, mod.TARGETS), rng);
      entries.push({ type: mod.TYPE_ID, params: mod.encodeParams(params), tag: 0, due: 20000 + (k % 30), stage: k % 3, group: 'drill' });
    }
  }
  const unique = new Set(entries.map((e) => sched.itemKey(e.type, e.params))).size;
  let added = 0;
  for (let i = 0; i < entries.length; i += 50) added += sched.mergeQueue(null, entries.slice(i, i + 50), 20030).added;
  assert.ok(added >= unique - 5 && added <= entries.length, `${added} of ${entries.length}`);
  const lost = entries.filter((e) => sched.mergeQueue(null, [e], 20030).added !== 1);
  assert.deepEqual(lost, []);
});

// ---------------------------------------------------------------------------
// study
// ---------------------------------------------------------------------------

test('study: the learner cannot choose an arm', () => {
  const s = codec.decodeSet(codec.encodeSet({ level: 'gcse', topics: ['add', 'shift'], n: 8, seed: 5, mode: 'study' }));
  for (const arm of [undefined, null, 2, 3, '0', 'A', 0.5, true]) assert.throws(() => sets.planSet(s, { arm }), /arm/, String(arm));
  // in a study set exactly one family gets full feedback, whichever arm
  for (const arm of [0, 1]) {
    const plan = sets.planSet(s, { arm });
    assert.equal(new Set(plan.filter((x) => x.feedback === 'full').map((x) => x.family)).size, 1);
    assert.equal(new Set(plan.filter((x) => x.feedback === 'answerOnly').map((x) => x.family)).size, 1);
  }
  // the arm depends only on the learner's random seed, not on anything in the set link
  assert.equal(study.assignArm(123), study.assignArm(123));
  assert.ok(study.assignArm.length === 1);
});

test('study: recoverArm trusts only a study code from the linked set', () => {
  const studySet = codec.decodeSet(codec.encodeSet({ level: 'gcse', topics: ['add'], n: 10, seed: 77, mode: 'study' }));
  const delayed = codec.decodeSet(codec.encodeSet({ level: 'gcse', topics: ['add'], n: 10, seed: 78, mode: 'delayed', link: studySet.setId }));
  const tok = (o) => codec.encodeToken({ setId: studySet.setId, mode: 'study', g1: { right: 3, total: 5 }, g2: { right: 2, total: 5 }, arm: 0, tags: [], ...o });
  assert.deepEqual(study.recoverArm(tok({ arm: 1 }), delayed.link), { arm: 1 });
  assert.deepEqual(study.recoverArm(` ${tok({ arm: 0 }).replace(/-/g, ' ')} `, delayed.link), { arm: 0 });
  for (const link of [null, undefined, -1, 1024, 3.5, '12']) {
    assert.match(study.recoverArm(tok({ arm: 1 }), link).error, /not linked/, String(link));
  }
  assert.match(study.recoverArm(tok({ setId: (studySet.setId + 1) % 1024 }), delayed.link).error, /different set/);
  assert.match(study.recoverArm(tok({ mode: 'delayed' }), delayed.link).error, /not from a study set/);
  assert.match(study.recoverArm(tok({ mode: 'normal' }), delayed.link).error, /not from a study set/);
  assert.match(study.recoverArm(tok({ arm: 2 }), delayed.link).error, /which group/);
  assert.ok(study.recoverArm('x'.repeat(10000), delayed.link).error);
});

test('study: paired statistics match hand calculations (n = 1, n = 2, small n)', () => {
  assert.equal(study.pairedStats([]), null);
  const one = study.pairedStats([0.4]);
  assert.deepEqual([one.n, one.mean, one.lo, one.hi, one.dz, one.reading, one.noInterval], [1, 0.4, null, null, null, null, 'tooFew']);
  // n = 2: mean 0.4, sd = √0.08, se = 0.2, t(0.975, 1) = 12.7062
  const two = study.pairedStats([0.2, 0.6]);
  assert.ok(Math.abs(two.sd - Math.sqrt(0.08)) < 1e-12);
  assert.ok(Math.abs(two.se - 0.2) < 1e-12);
  assert.ok(Math.abs(two.lo - (0.4 - 12.7062 * 0.2)) < 1e-3 && Math.abs(two.hi - (0.4 + 12.7062 * 0.2)) < 1e-3);
  assert.equal(two.reading, null, 'no reading from two learners');
  // n = 4: [0, 0.2, 0.2, 0.6] → mean 0.25, SS = 0.0625 + 0.0025 + 0.0025 + 0.1225 = 0.19, sd = √(0.19/3), t(0.975, 3) = 3.18245
  const four = study.pairedStats([0, 0.2, 0.2, 0.6]);
  const sd4 = Math.sqrt(0.19 / 3);
  assert.ok(Math.abs(four.sd - sd4) < 1e-12);
  assert.ok(Math.abs(four.hi - (0.25 + 3.18245 * sd4 / 2)) < 1e-4);
  assert.equal(four.df, 3);
  assert.ok(Math.abs(study.tQuantile(0.975, 3) - 3.18245) < 1e-4);
  assert.ok(Math.abs(study.tQuantile(0.5, 7)) < 1e-9);
  assert.ok(Math.abs(study.tCdf(1.3, 9) + study.tCdf(-1.3, 9) - 1) < 1e-12);
});

test('study: all-equal differences give no interval and no reading (even with floating-point noise)', () => {
  for (const diffs of [[0.2, 0.2, 0.2], [3 / 5 - 1 / 5, 4 / 5 - 2 / 5], Array(40).fill(0), Array(30).fill(1 / 3 - 1 / 6)]) {
    const p = study.pairedStats(diffs);
    assert.deepEqual([p.sd, p.lo, p.hi, p.dz, p.reading, p.noInterval], [0, null, null, null, null, 'noSpread'], JSON.stringify(diffs));
  }
  assert.deepEqual([study.crossoverStats([0.2, 0.2], [0.4, 0.4]).noInterval, study.crossoverStats([0.2, 0.2], [0.4, 0.4]).mean], ['noSpread', 0.30000000000000004]);
});

test('study: the crossover estimate matches a hand calculation and handles thin data', () => {
  // arm 0 [0.2, 0.4, 0], arm 1 [0.2, 0.6]: means 0.2 and 0.4 → 0.3; SS = 0.08 + 0.08; df 3;
  // sd = √(0.16/3); se = sd·√(1/3 + 1/2)/2; t(0.975, 3) = 3.18245
  const c = study.crossoverStats([0.2, 0.4, 0], [0.2, 0.6]);
  const sd = Math.sqrt(0.16 / 3);
  const se = (sd * Math.sqrt(1 / 3 + 1 / 2)) / 2;
  assert.ok(Math.abs(c.mean - 0.3) < 1e-12);
  assert.ok(Math.abs(c.sd - sd) < 1e-12 && Math.abs(c.se - se) < 1e-12);
  assert.equal(c.df, 3);
  assert.ok(Math.abs(c.lo - (0.3 - 3.18245 * se)) < 1e-4 && Math.abs(c.hi - (0.3 + 3.18245 * se)) < 1e-4);
  assert.ok(Math.abs(c.dz - 0.3 / sd) < 1e-12);
  assert.equal(c.reading, null, 'n = 5 is too few to act on');
  assert.equal(study.crossoverStats([], []), null);
  assert.equal(study.crossoverStats([0.1, 0.3], []).noInterval, 'oneArm');
  assert.equal(study.crossoverStats([], [0.1]).noInterval, 'oneArm');
  assert.equal(study.crossoverStats([0.1], [0.3]).noInterval, 'tooFew');
  assert.equal(study.crossoverStats([0.1], [0.3, 0.5]).noInterval, null, 'df = 1 is enough for an interval');
  // balanced arms with no family gap: the same as the plain paired mean
  const d0 = [0.2, 0, 0.4, 0.2];
  const d1 = [0.4, 0.2, 0, 0.2];
  assert.ok(Math.abs(study.crossoverStats(d0, d1).mean - study.pairedStats([...d0, ...d1]).mean) < 1e-12);
});

/** one class: an easier family A (gap), an effect of full feedback, fixed arm sizes */
function crossoverClass(rng, { n0, n1, effect, gap, items = 6 }) {
  const d = [[], []];
  const tokens = [];
  for (const [arm, n] of [[0, n0], [1, n1]]) {
    for (let i = 0; i < n; i++) {
      const ability = 0.35 + 0.3 * rng();
      const pA = ability + gap / 2 + (arm === 0 ? effect : 0);
      const pB = ability - gap / 2 + (arm === 1 ? effect : 0);
      const right = (p) => Array.from({ length: items }, () => (rng() < p ? 1 : 0)).reduce((x, y) => x + y, 0);
      const g1 = { right: right(pA), total: items };
      const g2 = { right: right(pB), total: items };
      d[arm].push(arm === 0 ? (g1.right - g2.right) / items : (g2.right - g1.right) / items);
      tokens.push(codec.encodeToken({ setId: 40, mode: 'delayed', g1, g2, arm, tags: [] }));
    }
  }
  return { d, tokens };
}

test('study: with an easier family and unequal arms the crossover CI stays unbiased with ~95% coverage', () => {
  const rng = rngFor(25);
  const effect = 0.1;
  for (const [n0, n1] of [[20, 10], [8, 22], [15, 15]]) {
    let covered = 0;
    let sum = 0;
    let naive = 0;
    const runs = 1500;
    for (let k = 0; k < runs; k++) {
      const { d } = crossoverClass(rng, { n0, n1, effect, gap: 0.3 });
      const c = study.crossoverStats(d[0], d[1]);
      sum += c.mean;
      naive += study.pairedStats([...d[0], ...d[1]]).mean;
      if (c.lo <= effect && effect <= c.hi) covered++;
    }
    assert.ok(Math.abs(sum / runs - effect) < 0.008, `${n0}/${n1}: mean estimate ${(sum / runs).toFixed(3)}`);
    assert.ok(covered / runs > 0.925 && covered / runs < 0.975, `${n0}/${n1}: coverage ${(100 * covered / runs).toFixed(1)}%`);
    if (n0 !== n1) assert.ok(Math.abs(naive / runs - effect) > 0.05, 'pooling every difference would have been biased');
  }
});

test('board: the study block uses the crossover estimate, and says why an interval is missing', () => {
  const rng = rngFor(26);
  const { tokens } = crossoverClass(rng, { n0: 200, n1: 60, effect: 0.1, gap: 0.3 });
  const d = board.analyzeTokens(tokens.join('\n')).study.delayed;
  assert.equal(d.diff.n, 260);
  assert.ok(d.diff.lo < 0.1 && 0.1 < d.diff.hi, `${d.diff.lo}–${d.diff.hi}`);
  assert.ok(Math.abs(d.diff.mean - 0.1) < 0.04);
  assert.ok(d.arms[0].A.acc - d.arms[0].B.acc > d.arms[1].B.acc - d.arms[1].A.acc, 'the family gap shows in the per-arm table');
  const oneArm = board.analyzeTokens(tokens.slice(0, 12).join(' ')).study.delayed;
  assert.deepEqual([oneArm.diff.noInterval, oneArm.diff.lo, oneArm.diff.reading], ['oneArm', null, null]);
  const lone = board.analyzeTokens(tokens[0]).study.delayed;
  assert.equal(lone.diff.noInterval, 'oneArm');
});

test('board: a four-character word before a code does not swallow it', () => {
  const mk = (right) => codec.encodeToken({ setId: 3, mode: 'normal', g1: { right, total: 8 }, g2: { right: 1, total: 2 }, tags: [2] });
  const tok = mk(4);
  const other = mk(5);
  const typo = other.slice(0, 13) + (other[13] === '7' ? '8' : '7');
  const lines = [`Aisha Khan ${tok}`, `Sam 10X1 ${tok}`, `Jack Ross ${tok.replace(/-/g, ' ')}`, `my code ${tok}`, `Pupil 17, form 10X1 ${tok.toLowerCase()}`];
  const r = board.analyzeTokens(lines.join('\n'));
  assert.deepEqual(r.rows.map((x) => x.line), [1, 2, 3, 4, 5]);
  assert.deepEqual(r.invalid, []);
  // three 4-character groups with a digit look exactly like a mistyped code: still reported, but the real code counts
  const amb = board.analyzeTokens(`Year 10X1 KHAN ${tok}`);
  assert.deepEqual([amb.rows.length, amb.invalid.map((x) => x.text)], [1, ['Year 10X1 KHAN']]);
  // a genuinely mistyped code next to a good one is still reported, on either side
  for (const line of [`${typo} ${tok}`, `${tok} ${typo}`, `Khan ${typo} ${tok}`, `${typo} Khan ${tok}`, `Aisha Khan ${typo}`]) {
    const x = board.analyzeTokens(line);
    assert.equal(x.rows.length, line.includes(tok) ? 1 : 0, line);
    assert.equal(x.invalid.length, 1, line);
    assert.equal(x.invalid[0].text, typo, line);
    assert.match(x.invalid[0].error, /mistyped/);
  }
});

test('board: a pathological paste is scanned in linear time', () => {
  let t = ms(() => board.analyzeTokens('AB12-'.repeat(200_000)));
  assert.ok(t < 2000, `${t} ms`);
  t = ms(() => board.analyzeTokens('7K2M '.repeat(200_000)));
  assert.ok(t < 2000, `${t} ms`);
  t = ms(() => board.analyzeTokens(`${'A'.repeat(4)}${' '.repeat(500_000)}${'B'.repeat(4)}${'-'.repeat(500_000)}!`));
  assert.ok(t < 2000, `${t} ms`);
  const good = codec.encodeToken({ setId: 3, mode: 'normal', g1: { right: 1, total: 1 }, g2: { right: 0, total: 0 }, tags: [] });
  const r = board.analyzeTokens(`${'AB12-'.repeat(1000)} ${good} ${'x'.repeat(1000)}`);
  assert.equal(r.rows.length, 1);
});

// ---------------------------------------------------------------------------
// starter and sets
// ---------------------------------------------------------------------------

const T = 20000;

test('starter: damaged or odd class states give five valid entries, deterministically', () => {
  const odd = [
    null, undefined, 'class', 7, [], {},
    { level: 'phd', taught: 'x', taps: 'y' },
    { level: 'gcse', taught: ['J277-1.2.4-add'], taps: [null, 5, 'tap', {}] },
    { level: 'alevel', taught: { 'H446-1.4.1-twos': 'monday', 'H446-1.4.1-shift': T + 5, nope: T - 3, 'H446-1.4.1-arith': T - 10.5 },
      taps: [{ spec: 'H446-1.4.1-twos', tag: 'bogus', result: 'missed', day: T - 1 }, { spec: 'H446-1.4.1-twos', result: 'maybe', day: T - 1 },
        { spec: 'nope', result: 'missed', day: T - 1 }, { spec: 'H446-1.4.1-shift', result: 'missed', day: T + 3 }, { spec: 'H446-1.4.1-shift', result: 'split', day: 'x' }] },
    { level: 'csapp', taught: { 'CSAPP-2.2': T - 400, 'CSAPP-3.6': T }, taps: Array(50).fill({ spec: 'CSAPP-3.6', tag: 'flags_sub_carry', result: 'split', day: T - 2 }) },
  ];
  for (const cls of odd) {
    const plan = starter.buildStarter(cls, T, rngFor(1));
    assert.equal(plan.length, 5, JSON.stringify(cls));
    assert.equal(new Set(plan.map((e) => `${e.spec}|${e.tag || ''}`)).size, 5, JSON.stringify(plan));
    for (const e of plan) {
      assert.ok(specById(e.spec), e.spec);
      assert.ok(['missed', 'spaced', 'new'].includes(e.source));
      assert.ok(e.tag === undefined || TAG_IDS.includes(e.tag), e.tag);
      assert.ok(typeof e.note === 'string' && e.note.length > 3 && e.note.length <= 120, e.note);
      assert.ok(!/undefined|NaN|null|—/.test(e.note), e.note);
    }
    assert.deepEqual(starter.buildStarter(cls, T, rngFor(1)), plan, 'deterministic');
    assert.deepEqual(starter.buildStarter(cls, T), starter.buildStarter(cls, T), 'deterministic without an rng too');
  }
  // a tap with an unknown misconception still counts for its spec point, without the tag
  const c = starter.recordTap(starter.newClass({ level: 'gcse' }), { spec: 'J277-1.2.4-add', tag: 'bogus', result: 'missed', date: T - 1 });
  assert.equal(c.taps[0].tag, null);
  const plan = starter.buildStarter(c, T, rngFor(2));
  assert.equal(plan[0].source, 'missed');
  assert.equal(plan[0].spec, 'J277-1.2.4-add');
  assert.throws(() => starter.recordTap(starter.newClass(), { spec: 'J277-1.2.4-add', result: 'got', date: new Date('x') }), RangeError);
  assert.throws(() => starter.setTaught(starter.newClass(), 'J277-1.2.4-add', 'last week'), RangeError);
});

test('starter: with nothing marked as taught, a point the class just missed is shown as missed', () => {
  let c = starter.newClass({ level: 'gcse' });
  c = starter.recordTap(c, { spec: 'J277-1.2.4-add', result: 'missed', date: T - 1 });
  c = starter.recordTap(c, { spec: 'J277-1.2.4-shift', tag: 'shift_fill', result: 'split', date: T - 3 });
  const plan = starter.buildStarter(c, T, rngFor(5));
  assert.deepEqual(plan.slice(0, 2).map((e) => [e.source, e.spec, e.tag]), [['missed', 'J277-1.2.4-add', undefined], ['missed', 'J277-1.2.4-shift', 'shift_fill']]);
  assert.match(plan[0].note, /missed this yesterday/);
  assert.ok(!plan.some((e) => e.spec === 'J277-1.2.4-add' && !e.tag && /not marked/i.test(e.note)));
  assert.equal(new Set(plan.map((e) => `${e.spec}|${e.tag || ''}`)).size, 5);
});

test('starter: only the future is ignored; a class taught long ago is still served', () => {
  let c = starter.newClass({ level: 'gcse' });
  c = starter.setTaught(c, 'J277-1.2.4-add', T + 10);
  c = starter.recordTap(c, { spec: 'J277-1.2.4-add', tag: 'add_or', result: 'missed', date: T + 2 });
  const plan = starter.buildStarter(c, T, rngFor(3));
  assert.ok(plan.every((e) => e.source === 'new' && !/missed/.test(e.note)), 'future taps and teaching dates are ignored');
  c = starter.setTaught(starter.newClass({ level: 'gcse' }), 'J277-1.2.4-add', T - 3000);
  const old = starter.buildStarter(c, T, rngFor(4));
  assert.equal(old[4].spec, 'J277-1.2.4-add');
  assert.match(old[4].note, /months ago/);
});

test('sets: hand-made or odd sets never hang or crash; plans stay deterministic', () => {
  const rng = rngFor(27);
  const levels = ['gcse', 'alevel', 'csapp', 'phd', undefined];
  const topicSets = [[], ['add'], ['nope'], ['c'], ['fa', 'fa'], 'add', null, ['twos', 'sadd', 'shift', 'fa', 'add', 'c']];
  for (let k = 0; k < 200; k++) {
    const set = { level: pick(rng, levels), topics: pick(rng, topicSets), n: randInt(rng, 1, 15), seed: randInt(rng, 0, 2 ** 30), mode: pick(rng, ['normal', 'study', 'delayed', 'weird']) };
    const plan = sets.planSet(set, { arm: randInt(rng, 0, 1) });
    assert.equal(plan.length, set.n);
    assert.deepEqual(sets.planSet(set, { arm: plan.length ? 0 : 1 }).map((s) => s.spec), sets.planSet(set, { arm: plan.length ? 0 : 1 }).map((s) => s.spec));
    for (const slot of plan) {
      assert.ok(specById(slot.spec), slot.spec);
      assert.ok(['full', 'answerOnly'].includes(slot.feedback));
    }
  }
  for (const n of [0, 16, -1, 2.5, NaN, undefined]) {
    assert.throws(() => sets.planSet({ level: 'gcse', topics: ['add'], n, seed: 1, mode: 'normal' }), RangeError, String(n));
  }
  assert.throws(() => sets.planSet(null), RangeError);
  // one-question sets are possible (and their only slot gets full feedback)
  assert.deepEqual(sets.planSet({ level: 'gcse', topics: ['add'], n: 1, seed: 3, mode: 'normal' }).map((s) => s.feedback), ['full']);
});

test('sets: summarizeSet tolerates missing, short, long and odd result lists; its output always encodes', () => {
  const set = codec.decodeSet(codec.encodeSet({ level: 'gcse', topics: ['add', 'shift'], n: 15, seed: 11, mode: 'normal' }));
  const plan = sets.planSet(set);
  for (const results of [null, undefined, [], [null], Array(40).fill({ correct: false, tag: 'add_or' }),
    plan.map((_, i) => ({ correct: i % 2 === 0, tag: i % 2 ? 'mystery_tag' : null })), plan.map(() => ({ correct: false, tag: null }))]) {
    const sum = sets.summarizeSet(results, plan, { setId: set.setId, mode: 'normal' });
    assert.ok(sum.g1.total + sum.g2.total <= plan.length);
    const back = codec.decodeToken(codec.encodeToken(sum));
    assert.equal(back.error, undefined);
    assert.equal(back.total, sum.g1.total + sum.g2.total);
  }
  const odd = sets.summarizeSet(plan.map((_, i) => ({ correct: i % 2 === 0, tag: i % 2 ? 'mystery_tag' : null })), plan, { setId: set.setId, mode: 'normal' });
  assert.deepEqual(codec.decodeToken(codec.encodeToken(odd)).tags, ['other']);
  // study summaries: g1 = A, g2 = B; every slot built from the plan is a real item
  const ss = codec.decodeSet(codec.encodeSet({ level: 'alevel', topics: ['add'], n: 7, seed: 12, mode: 'study' }));
  const sp = sets.planSet(ss, { arm: 0 });
  const st = sets.summarizeSet(sp.map(() => ({ correct: true })), sp, { setId: ss.setId, mode: 'study', arm: 0 });
  assert.equal(st.g1.total, sp.filter((x) => x.family === 'A').length);
  assert.equal(st.g2.total, sp.filter((x) => x.family === 'B').length);
  for (const slot of sp) {
    const { type, params } = itemForSpec(slot.spec, mulberry32(slot.seed), { level: ss.level });
    assert.ok(makeItem(type, params).key);
  }
  assert.ok(SPECS.length > 0);
});

// ---------------------------------------------------------------------------
// Review regressions (security #1, #7; bugs #7, #12; requirements #11, #13)
// ---------------------------------------------------------------------------

const RD = 20000;
/** n distinct add misses on day `day` */
function missesOn(state, n, day, a0 = 20) {
  let s = state;
  for (let k = 0; k < n; k++) {
    s = sched.recordAttempt(s, { type: 'add', params: ITEM_TYPES.add.encodeParams({ w: 8, a: a0 + k, b: 100, ask: 'full' }), correct: false, tag: 'add_no_carry', today: day });
  }
  return s;
}
const linkEntries = (n, a0) => Array.from({ length: n }, (_, k) => ({
  type: 0, params: ITEM_TYPES.add.encodeParams({ w: 12, a: a0 + k, b: 100, ask: 'full' }), tag: 2, due: RD + 2, stage: 0, group: 'drill',
}));

test('mergeQueue never evicts what is already on the device, and reports what it really kept', () => {
  const mine = missesOn(sched.emptyState(), 5, RD - 3);
  const ownKeys = mine.queue.map((e) => e.key);
  for (const [n, added, skipped] of [[60, 55, 5], [200, 55, 145], [3, 3, 0]]) {
    const r = sched.mergeQueue(mine, linkEntries(n, 120), RD);
    assert.equal(r.added, added, `link of ${n}`);
    assert.equal(r.skipped, skipped, `link of ${n}`);
    assert.equal(r.state.queue.length, 5 + added);
    for (const k of ownKeys) assert.ok(r.state.queue.some((e) => e.key === k), `own entry ${k} kept`);
  }
  // a full queue takes nothing, and loses nothing
  const full = missesOn(sched.emptyState(), sched.MAX_QUEUE, RD - 3);
  const r = sched.mergeQueue(full, linkEntries(10, 120), RD);
  assert.deepEqual([r.added, r.skipped], [0, 10]);
  assert.deepEqual(r.state.queue.map((e) => e.key), full.queue.map((e) => e.key));
  // entries already here are updated, not counted as skipped
  const again = sched.mergeQueue(full, full.queue.map((e) => ({ ...e })), RD);
  assert.deepEqual([again.added, again.skipped], [0, 0]);
});

test('damaged storage: entries that cannot be rebuilt, or have a negative day, are dropped; nothing throws', () => {
  const good = missesOn(sched.emptyState(), 2, RD).queue;
  const state = { ...sched.emptyState(), queue: [
    ...good,
    { type: 5, params: [999, 1], due: 1 },           // no such card
    { type: 0, params: [8, 10, 20, 0, 1], due: -5 },  // negative day
    { type: 1, params: [99999, 1, 0, 1, 0, 0, 0], due: RD },  // decodes to other ints
  ] };
  const due = sched.dueEntries(state, RD + 5);
  assert.deepEqual(due.map((e) => e.key).sort(), good.map((e) => e.key).sort());
  for (const e of due) makeItem(ITEM_TYPES[['add', 'shift', 'twos', 'sadd', 'fa', 'card'][e.type]].TYPE, ITEM_TYPES[['add', 'shift', 'twos', 'sadd', 'fa', 'card'][e.type]].decodeParams(e.params));
  assert.equal(typeof codec.encodeQueue(sched.activeEntries(state)), 'string');
  // odd shapes everywhere
  const junk = [null, 7, 'x', [], { queue: {} }, { queue: [null, 1, 'a', [], { type: {}, params: 'no' }] },
    { tags: [], session: 5, evidence: 'x' }, { tags: { a: null, b: 3 }, session: { misses: [], shown: null, seed: {} } },
    { queue: [{ type: 0, params: [8, 1, 1, 0, 0], due: 1e300 }, { type: 0, params: [8, 1, 1, 0, 0], due: RD, tag: {}, stage: 'x', group: 9, miss: -4 }] }];
  for (const s of junk) {
    assert.doesNotThrow(() => {
      sched.dueEntries(s, RD); sched.activeEntries(s); sched.queueSummary(s, RD); sched.reviewAccuracy(s);
      sched.fading(s, 'add_or'); sched.noteWorked(s, 'add_or'); sched.resetSession(s, 1);
      sched.mergeQueue(s, [{ type: 0, params: [8, 1, 1, 0, 0], due: RD }], RD);
      sched.recordAttempt(s, { type: 'add', params: [8, 3, 4, 0, 0], correct: false, tag: 'add_or', today: RD });
      codec.encodeQueue(sched.activeEntries(s));
    }, JSON.stringify(s));
  }
  // the one usable entry in the last junk state survives, with a sane miss day
  const kept = sched.activeEntries(junk[junk.length - 1]);
  assert.equal(kept.length, 1);
  assert.ok(kept[0].miss >= 0);
});

test('an empty or unclassified answer on a targeted variant is not a second miss of that tag', () => {
  const p = ITEM_TYPES.twos.encodeParams({ w: 8, n: -42, task: 'encode' });
  let s = sched.recordAttempt(sched.emptyState(), { type: 'twos', params: p, correct: false, tag: 'twos_sign_magnitude', today: RD });
  const v = ITEM_TYPES.twos.encodeParams({ w: 8, n: -37, task: 'encode' });
  for (const tag of [undefined, null, 'other']) {
    const t = sched.recordAttempt(s, { type: 'twos', params: v, correct: false, tag, target: 'twos_sign_magnitude', today: RD });
    assert.equal(t.session.misses.twos_sign_magnitude, 1, String(tag));
    assert.equal(sched.fading(t, 'twos_sign_magnitude').showWorked, false, String(tag));
  }
  s = sched.recordAttempt(s, { type: 'twos', params: v, correct: false, tag: 'twos_sign_magnitude', target: 'twos_sign_magnitude', today: RD });
  assert.equal(sched.fading(s, 'twos_sign_magnitude').showWorked, true);
});

test("set questions ('set' group) are spaced like drill but never count as drill/holdout evidence", () => {
  const p = ITEM_TYPES.add.encodeParams({ w: 8, a: 77, b: 99, ask: 'full' });
  let s = sched.recordAttempt(sched.emptyState(), { type: 'add', params: p, correct: false, tag: 'add_or', group: 'set', today: RD });
  assert.equal(s.queue[0].group, 'set');
  assert.equal(s.queue[0].due, RD + 2);
  s = sched.recordAttempt(s, { type: 'add', params: p, correct: true, today: RD + 2 });
  assert.equal(s.queue[0].due, RD + 2 + 7);
  s = sched.recordAttempt(s, { type: 'add', params: p, correct: true, today: RD + 9 });
  assert.deepEqual(sched.reviewAccuracy(s), { drill: { right: 0, total: 0 }, holdout: { right: 0, total: 0 } });
  assert.equal(s.queue[0].measured, true);
  // drill still counts; the group survives a save and reload
  const d = ITEM_TYPES.add.encodeParams({ w: 8, a: 70, b: 99, ask: 'full' });
  let t = sched.recordAttempt(s, { type: 'add', params: d, correct: false, tag: 'add_or', group: 'drill', today: RD });
  t = sched.recordAttempt(t, { type: 'add', params: d, correct: true, today: RD + 8 });
  assert.deepEqual(sched.reviewAccuracy(t).drill, { right: 1, total: 1 });
  assert.equal(sched.activeEntries(JSON.parse(JSON.stringify(t))).find((e) => e.key.endsWith(p.join('.'))).group, 'set');
  assert.deepEqual(Object.keys(sched.reviewAccuracy(t)), ['drill', 'holdout']);
});

test('starter: missed slots come first; the newest point is never "new" while the class has an open miss on it', () => {
  const D = 20000;
  let c = starter.newClass({ id: 'x', level: 'gcse' });
  c = starter.setTaught(c, 'J277-1.2.4-add', D - 20);
  c = starter.setTaught(c, 'J277-1.2.4-shift', D - 10);
  c = starter.recordTap(c, { spec: 'J277-1.2.4-add', tag: 'add_no_carry', result: 'missed', date: D - 3 });
  c = starter.recordTap(c, { spec: 'J277-1.2.4-shift', result: 'split', date: D - 2 });
  const plan = starter.buildStarter(c, D, mulberry32(1));
  assert.equal(plan.length, 5);
  const missed = plan.filter((e) => e.source === 'missed');
  assert.deepEqual(missed.map((e) => e.spec).sort(), ['J277-1.2.4-add', 'J277-1.2.4-shift']);
  assert.ok(!plan.some((e) => e.source === 'new' && e.spec === 'J277-1.2.4-shift'));

  // A-level: the newest point (adders) was missed; 'new' moves to the next-newest
  let a = starter.newClass({ id: 'y', level: 'alevel' });
  for (const [s, d] of [['H446-1.4.1-twos', 30], ['H446-1.4.1-arith', 21], ['H446-1.4.1-shift', 14], ['H446-1.4.3-adders', 2]]) a = starter.setTaught(a, s, D - d);
  a = starter.recordTap(a, { spec: 'H446-1.4.1-twos', tag: 'twos_no_plus1', result: 'missed', date: D - 1 });
  a = starter.recordTap(a, { spec: 'H446-1.4.1-arith', tag: 'flags_carry_is_overflow', result: 'split', date: D - 1 });
  a = starter.recordTap(a, { spec: 'H446-1.4.3-adders', result: 'missed', date: D - 1 });
  const pa = starter.buildStarter(a, D, mulberry32(2));
  assert.ok(pa.some((e) => e.source === 'missed' && e.spec === 'H446-1.4.3-adders'));
  assert.ok(!pa.some((e) => e.source === 'new' && e.spec === 'H446-1.4.3-adders'));
  const nw = pa.find((e) => e.source === 'new');
  assert.equal(nw.spec, 'H446-1.4.1-shift');
  assert.ok(nw.note.length <= 80);

  // no taps: the newest point still gets the 'new' slot
  let b = starter.newClass({ id: 'z', level: 'gcse' });
  b = starter.setTaught(b, 'J277-1.2.4-add', D - 20);
  b = starter.setTaught(b, 'J277-1.2.4-shift', D - 10);
  const pb = starter.buildStarter(b, D, mulberry32(3));
  assert.equal(pb[4].source, 'new');
  assert.equal(pb[4].spec, 'J277-1.2.4-shift');
});

test("result codes and the board never rank 'other' as a misconception", () => {
  const plan = sets.planSet({ v: 1, level: 'gcse', topics: ['add'], n: 6, seed: 5, mode: 'normal' });
  const results = [
    { correct: false, tag: 'other' }, { correct: false, tag: 'other' }, { correct: false, tag: 'other' },
    { correct: false, tag: 'add_or' }, { correct: false, tag: null }, { correct: true, tag: null },
  ];
  const sum = sets.summarizeSet(results, plan, { setId: 5, mode: 'normal' });
  assert.deepEqual(sum.tags, ['add_or']);
  // older codes may still carry 'other': it sorts last and is marked
  const t1 = codec.encodeToken({ setId: 5, mode: 'normal', g1: { right: 1, total: 5 }, g2: { right: 0, total: 1 }, tags: ['other', 'add_or'] });
  const t2 = codec.encodeToken({ setId: 5, mode: 'normal', g1: { right: 2, total: 5 }, g2: { right: 0, total: 1 }, tags: ['other'] });
  const t3 = codec.encodeToken({ setId: 5, mode: 'normal', g1: { right: 2, total: 5 }, g2: { right: 1, total: 1 }, tags: ['other', 'add_no_carry'] });
  const r = board.analyzeTokens([t1, t2, t3].join('\n'));
  assert.deepEqual(r.tagCounts.map((t) => t.tag), ['add_or', 'add_no_carry', 'other']);   // ties: tag list order
  assert.equal(r.tagCounts[2].unclassified, true);
  assert.equal(r.tagCounts[2].count, 3);
  assert.ok(r.tagCounts.slice(0, 2).every((t) => !t.unclassified));
});

test('review links keep the group: a set question stays a set question on another device, and never becomes evidence', async () => {
  const add = await import('../machine/src/learn/items/add.js');
  const day = 20000;
  let s = sched.emptyState();
  const groups = ['drill', 'holdout', 'set'];
  groups.forEach((group, k) => {
    s = sched.recordAttempt(s, { type: add.TYPE_ID, params: add.encodeParams({ w: 8, a: 150 + k, b: 120, ask: 'full', level: 'gcse' }), correct: false, tag: 'add_no_carry', group, today: day });
  });
  // every stage and group survives the link exactly
  for (const group of groups) {
    for (let stage = 0; stage <= 2; stage++) {
      const [e] = codec.decodeQueue(codec.encodeQueue([{ type: 0, params: [8, 1, 2], tag: 3, due: day, stage, group }]));
      assert.equal(e.group, group);
      assert.equal(e.stage, stage);
    }
  }
  // links made before 'set' existed read the same: flags 0–5 are unchanged
  const legacy = codec.decodeQueue(codec.encodeQueue([{ type: 0, params: [1], tag: 0, due: day, stage: 2, group: 'holdout' }]));
  assert.deepEqual([legacy[0].stage, legacy[0].group], [2, 'holdout']);
  // on the other device, a correct review a week later counts only for drill and holdout
  const link = codec.encodeQueue(sched.activeEntries(s));
  let other = sched.mergeQueue(sched.emptyState(), codec.decodeQueue(link), day).state;
  assert.deepEqual(other.queue.map((e) => e.group).sort(), ['drill', 'holdout', 'set']);
  for (const e of other.queue) other = sched.recordAttempt(other, { type: e.type, params: e.params, correct: true, review: true, group: e.group, today: day + 7 });
  const acc = sched.reviewAccuracy(other);
  assert.equal(acc.drill.total + acc.holdout.total, 2, 'the set entry is not evidence');
});
