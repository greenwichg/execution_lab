// Predict the Machine's state, codes and study layer (no server, no pupil data):
//   · codec.js: Crockford base32, set codes, result tokens and review-queue
//     links round-trip; EVERY single-character typo and EVERY swap of two
//     neighbouring characters in 2,000 random result tokens is detected
//   · scheduler.js: the 2 / 7 / 21-day ladder, evidence ≥ 7 days after a miss
//     per group, fading, queue cap, link import, holdout rate 15% ± 2%
//   · study.js / sets.js: balanced arms, feedback per arm, deterministic set
//     plans (interleaving, holdout slots, study families, transfer items)
//   · starter.js: five-line plans from several class histories
//   · board.js: robust parsing of pasted codes, and the crossover estimate's
//     CI recovers a known effect (and has ~95% coverage in simulation)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import * as codec from '../machine/src/lib/codec.js';
import * as sched from '../machine/src/learn/scheduler.js';
import * as study from '../machine/src/learn/study.js';
import * as sets from '../machine/src/learn/sets.js';
import * as starter from '../machine/src/learn/starter.js';
import * as board from '../machine/src/learn/board.js';
import { TOPICS, SPECS, specById } from '../machine/src/learn/spec.js';
import { TAG_IDS } from '../machine/src/learn/tagids.js';
import { mulberry32, randInt, pick } from '../machine/src/lib/rng.js';
import { ITEM_TYPES, itemForSpec, makeItem } from '../machine/src/learn/items/index.js';

const B32 = codec.B32;
const rngFor = (seed) => mulberry32(seed);

function randomToken(rng) {
  const mode = pick(rng, codec.MODES);
  const g = () => { const total = randInt(rng, 0, 15); return { right: randInt(rng, 0, total), total }; };
  const tags = Array.from({ length: randInt(rng, 0, 3) }, () => randInt(rng, 1, TAG_IDS.length - 1));
  return { setId: randInt(rng, 0, 1023), mode, g1: g(), g2: g(), arm: mode === 'normal' ? undefined : randInt(rng, 0, 2), tags };
}

// ---------------------------------------------------------------------------
// codec
// ---------------------------------------------------------------------------

test('base32: round trip, case-insensitive, separators ignored, I/L → 1 and O → 0', () => {
  const rng = rngFor(1);
  for (let k = 0; k < 200; k++) {
    const bits = Array.from({ length: 5 * randInt(rng, 1, 20) }, () => (rng() < 0.5 ? 1 : 0));
    const s = codec.toB32(bits);
    assert.match(s, /^[0-9A-HJKMNP-TV-Z]+$/);
    assert.deepEqual(codec.fromB32(s), bits);
    assert.deepEqual(codec.fromB32(` ${s.toLowerCase().replace(/(.{3})/g, '$1-')} `), bits);
  }
  assert.equal(codec.normB32('il-o 0'), '1100');
  assert.equal(codec.fromB32('U'), null);
  assert.equal(B32.length, 32);
  assert.deepEqual(codec.TOPIC_ORDER, TOPICS, 'set-code topic bits follow spec.js TOPICS');
});

test('bit packer: fixed-width and variable-length integers round-trip', () => {
  const rng = rngFor(2);
  const w = new codec.BitWriter();
  const vals = [];
  for (let k = 0; k < 300; k++) {
    const n = randInt(rng, 1, 40);
    const v = Math.floor(rng() * 2 ** n);
    const u = Math.floor(rng() * 2 ** randInt(rng, 0, 40));
    vals.push([n, v, u]);
    w.put(v, n).varuint(u);
  }
  const r = new codec.BitReader(w.bits);
  for (const [n, v, u] of vals) {
    assert.equal(r.take(n), v);
    assert.equal(r.varuint(), u);
  }
  assert.equal(r.left, 0);
  assert.throws(() => r.take(1));
  assert.throws(() => new codec.BitWriter().put(8, 3));
});

test('set codes: ≤ 14 characters, round trip, setId from the code, friendly errors', () => {
  const rng = rngFor(3);
  for (let k = 0; k < 500; k++) {
    const topics = TOPICS.filter(() => rng() < 0.5);
    if (!topics.length) topics.push('add');
    const p = {
      level: pick(rng, ['gcse', 'alevel', 'csapp']), topics, n: randInt(rng, 5, 15),
      seed: randInt(rng, 0, 2 ** 30 - 1), mode: pick(rng, codec.MODES), link: rng() < 0.5 ? randInt(rng, 0, 1023) : null,
    };
    const code = codec.encodeSet(p);
    assert.ok(code.length <= 14, code);
    assert.match(code, /^[0-9A-Z]+$/);
    const d = codec.decodeSet(code.toLowerCase());
    assert.deepEqual({ level: d.level, topics: d.topics, n: d.n, seed: d.seed, mode: d.mode, link: d.link }, p);
    assert.equal(d.setId, codec.setIdOf(code));
    assert.ok(d.setId >= 0 && d.setId < 1024);
    // one mistyped character or a truncated link is always refused
    const i = randInt(rng, 0, code.length - 1);
    const typo = code.slice(0, i) + B32[(B32.indexOf(code[i]) + randInt(rng, 1, 31)) % 32] + code.slice(i + 1);
    assert.throws(() => codec.decodeSet(typo), /mistyped|does not make sense/);
    assert.throws(() => codec.decodeSet(code.slice(0, -1)), /too short/);
  }
});

test('set codes: bad input gives a clear, kind error (never a crash)', () => {
  for (const bad of ['', 'U'.repeat(14), '!!', 'A'.repeat(20), 'A'.repeat(14)]) {
    assert.throws(() => codec.decodeSet(bad), (e) => e instanceof Error && /teacher|version|code/i.test(e.message) && e.message.length < 200);
  }
  assert.throws(() => codec.encodeSet({ level: 'gcse', topics: [], n: 10, seed: 1 }), RangeError);
  assert.throws(() => codec.encodeSet({ level: 'gcse', topics: ['add'], n: 4, seed: 1 }), RangeError);
  const seedKept = codec.decodeSet(codec.encodeSet({ level: 'gcse', topics: ['add'], n: 10, seed: 0xffffffff })).seed;
  assert.equal(seedKept, 0xffffffff % 2 ** 30, 'seeds are kept to 30 bits');
});

test('result tokens: XXXX-XXXX-XXXX, exact round trip of every field', () => {
  const rng = rngFor(4);
  for (let k = 0; k < 2000; k++) {
    const p = randomToken(rng);
    const tok = codec.encodeToken(p);
    assert.match(tok, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    const d = codec.decodeToken(` ${tok.toLowerCase()} `);
    assert.equal(d.error, undefined, tok);
    assert.equal(d.setId, p.setId);
    assert.equal(d.mode, p.mode);
    assert.deepEqual(d.g1, p.g1);
    assert.deepEqual(d.g2, p.g2);
    assert.equal(d.arm, p.mode === 'normal' ? codec.ARM_NONE : p.arm);
    assert.deepEqual(d.tags, [...new Set(p.tags)].map((i) => TAG_IDS[i]), 'repeats are written once');
    assert.equal(d.right, p.g1.right + p.g2.right);
    assert.equal(d.code, tok);
  }
  // tag ids work as well as indices, and only the first three are kept
  const d = codec.decodeToken(codec.encodeToken({ setId: 5, mode: 'normal', g1: { right: 1, total: 2 }, g2: { right: 0, total: 0 },
    tags: ['add_no_carry', 'other', 'shift_fill', 'add_or'] }));
  assert.deepEqual(d.tags, ['add_no_carry', 'other', 'shift_fill']);
  assert.equal(d.score, 0.5);
  assert.throws(() => codec.encodeToken({ setId: 1, mode: 'normal', g1: { right: 3, total: 2 }, g2: { right: 0, total: 0 } }), RangeError);
  assert.throws(() => codec.encodeToken({ setId: 1, mode: 'normal', g1: { right: 0, total: 16 }, g2: { right: 0, total: 0 } }), RangeError);
});

test('result tokens: EVERY single-character substitution and EVERY adjacent swap in 2,000 random tokens is detected', () => {
  const rng = rngFor(5);
  let substitutions = 0;
  let swaps = 0;
  for (let k = 0; k < 2000; k++) {
    const canon = codec.normB32(codec.encodeToken(randomToken(rng)));
    assert.equal(canon.length, 12);
    for (let i = 0; i < 12; i++) {
      for (const c of B32) {
        if (c === canon[i]) continue;
        const bad = canon.slice(0, i) + c + canon.slice(i + 1);
        assert.ok(codec.decodeToken(bad).error, `substitution at ${i} undetected: ${canon} → ${bad}`);
        substitutions++;
      }
      if (i < 11 && canon[i] !== canon[i + 1]) {
        const bad = canon.slice(0, i) + canon[i + 1] + canon[i] + canon.slice(i + 2);
        assert.ok(codec.decodeToken(bad).error, `swap at ${i} undetected: ${canon} → ${bad}`);
        swaps++;
      }
    }
  }
  assert.equal(substitutions, 2000 * 12 * 31);
  assert.ok(swaps > 2000 * 10, `${swaps} swaps checked`);
});

test('result tokens: friendly errors for wrong length, bad characters and junk', () => {
  const good = codec.encodeToken({ setId: 10, mode: 'study', g1: { right: 2, total: 5 }, g2: { right: 4, total: 5 }, arm: 1, tags: [] });
  assert.match(codec.decodeToken(good.slice(0, -2)).error, /12 characters/);
  assert.match(codec.decodeToken(`${good}7`).error, /12 characters/);
  assert.match(codec.decodeToken(good.replace(/.$/, 'U')).error, /"U"/);
  assert.match(codec.decodeToken('').error, /no result code/);
  assert.ok(codec.decodeToken('0000-0000-0000').error, 'all zeros is never valid');
  // Crockford aliases decode to the same token
  const canon = codec.normB32(good);
  const alias = canon.replace(/1/g, 'l').replace(/0/g, 'o');
  assert.equal(codec.decodeToken(alias).code, good);
});

/** a realistic review queue: real items from every binary type, some 16 bits wide */
function realisticEntries(count, rng) {
  const types = ['add', 'shift', 'twos', 'sadd', 'fa'];
  return Array.from({ length: count }, (_, i) => {
    const type = types[i % types.length];
    const mod = ITEM_TYPES[type];
    const params = mod.generate(rng, { level: 'alevel', w: i % 3 === 0 ? 16 : 8 });
    return {
      type: mod.TYPE_ID, params: mod.encodeParams(params), tag: randInt(rng, 0, TAG_IDS.length - 1),
      due: 20700 + randInt(rng, -3, 25), stage: randInt(rng, 0, 2), group: rng() < 0.15 ? 'holdout' : 'drill',
    };
  });
}

test('review queue links: round trip, URL-safe, < 1500 characters for 40 entries, damage detected', () => {
  const rng = rngFor(6);
  for (let k = 0; k < 50; k++) {
    const entries = realisticEntries(randInt(rng, 0, 45), rng);
    const q = codec.encodeQueue(entries);
    assert.equal(encodeURIComponent(q), q, 'URL-safe without escaping');
    assert.deepEqual(codec.decodeQueue(q), entries);
    assert.deepEqual(codec.decodeQueue(q.toLowerCase()), entries);
  }
  const forty = codec.encodeQueue(realisticEntries(40, rng));
  assert.ok(forty.length < 1500, `40 entries → ${forty.length} characters`);
  // every single-character change and truncation is refused
  const q = codec.encodeQueue(realisticEntries(12, rng));
  for (let i = 0; i < q.length; i++) {
    const bad = q.slice(0, i) + B32[(B32.indexOf(q[i]) + 7) % 32] + q.slice(i + 1);
    assert.throws(() => codec.decodeQueue(bad), /review link/);
  }
  for (const cut of [1, 5, Math.floor(q.length / 2)]) assert.throws(() => codec.decodeQueue(q.slice(0, -cut)), /review link/);
  assert.deepEqual(codec.decodeQueue(codec.encodeQueue([])), []);
  assert.deepEqual(codec.decodeQueue(''), []);
});

// ---------------------------------------------------------------------------
// scheduler
// ---------------------------------------------------------------------------

const ADD = { type: 0, params: [8, 200, 77, 0, 1] };
const SHIFT = { type: 'shift', params: [8, 13, 1, 2, 0, 1, 1] };

test('scheduler: a miss comes back after 2, then 7, then 21 days, then is done', () => {
  const D = 20000;
  let s = sched.recordAttempt(sched.emptyState(), { ...ADD, correct: false, tag: 'add_no_carry', today: D });
  assert.equal(s.queue.length, 1);
  assert.deepEqual([s.queue[0].stage, s.queue[0].due, s.queue[0].miss], [0, D + 2, D]);
  assert.equal(sched.dueEntries(s, D + 1).length, 0);
  assert.equal(sched.dueEntries(s, D + 2).length, 1);
  assert.deepEqual(sched.queueSummary(s, D), { due: 0, later: 1, next: D + 2 });

  s = sched.recordAttempt(s, { ...ADD, correct: true, today: D + 2 });           // auto-detected review
  assert.deepEqual([s.queue[0].stage, s.queue[0].due], [1, D + 9]);
  s = sched.recordAttempt(s, { ...ADD, correct: true, today: D + 9 });
  assert.deepEqual([s.queue[0].stage, s.queue[0].due], [2, D + 30]);
  s = sched.recordAttempt(s, { ...ADD, correct: true, today: D + 30 });
  assert.equal(s.queue[0].done, D + 30);
  assert.equal(sched.activeEntries(s).length, 0);
  assert.equal(sched.dueEntries(s, D + 100).length, 0);
});

test('scheduler: a wrong review goes back to 2 days; an early correct answer does not move it on', () => {
  const D = 20000;
  let s = sched.recordAttempt(sched.emptyState(), { ...ADD, correct: false, tag: 'add_or', today: D });
  s = sched.recordAttempt(s, { ...ADD, correct: true, today: D + 2 });
  assert.equal(s.queue[0].stage, 1);
  s = sched.recordAttempt(s, { ...ADD, correct: true, today: D + 4, review: true });   // 5 days early
  assert.deepEqual([s.queue[0].stage, s.queue[0].due], [1, D + 9]);
  s = sched.recordAttempt(s, { ...ADD, correct: false, tag: 'add_or', today: D + 9 });
  assert.deepEqual([s.queue[0].stage, s.queue[0].due, s.queue[0].lapses], [0, D + 11, 1]);
  // the same item missed again in practice stays ONE entry
  s = sched.recordAttempt(s, { ...ADD, correct: false, tag: 'add_or', today: D + 10, review: false });
  assert.equal(s.queue.length, 1);
  assert.equal(s.queue[0].due, D + 12);
  // a finished item missed again starts a fresh ladder
  s = sched.recordAttempt(s, { ...ADD, correct: true, today: D + 12 });
  s = sched.recordAttempt(s, { ...ADD, correct: true, today: D + 19 });
  s = sched.recordAttempt(s, { ...ADD, correct: true, today: D + 40 });
  assert.ok(s.queue[0].done);
  s = sched.recordAttempt(s, { ...ADD, correct: false, tag: 'add_or', today: D + 50 });
  assert.equal(s.queue.length, 1);
  assert.deepEqual([s.queue[0].stage, s.queue[0].due, s.queue[0].miss, s.queue[0].done], [0, D + 52, D + 50, null]);
});

test('scheduler: state is never mutated', () => {
  const s0 = sched.emptyState();
  const frozen = JSON.stringify(s0);
  const s1 = sched.recordAttempt(s0, { ...ADD, correct: false, tag: 'add_or', today: 1 });
  assert.equal(JSON.stringify(s0), frozen);
  const snap = JSON.stringify(s1);
  sched.recordAttempt(s1, { ...ADD, correct: true, today: 3 });
  sched.mergeQueue(s1, [{ ...SHIFT, type: 1, tag: 8, due: 5, stage: 0, group: 'drill' }], 1);
  sched.noteWorked(s1, 'add_or');
  sched.resetSession(s1, 9);
  assert.equal(JSON.stringify(s1), snap);
});

test('scheduler: first review ≥ 7 days after the miss is recorded once, per group', () => {
  const D = 20000;
  let s = sched.emptyState();
  s = sched.recordAttempt(s, { ...ADD, correct: false, tag: 'add_or', group: 'holdout', today: D });
  s = sched.recordAttempt(s, { ...SHIFT, correct: false, tag: 'shift_fill', group: 'drill', today: D });
  s = sched.recordAttempt(s, { ...ADD, correct: true, today: D + 2 });          // too soon: not evidence
  s = sched.recordAttempt(s, { ...SHIFT, correct: false, tag: 'shift_fill', today: D + 2 });
  assert.deepEqual(sched.reviewAccuracy(s), { drill: { right: 0, total: 0 }, holdout: { right: 0, total: 0 } });
  s = sched.recordAttempt(s, { ...ADD, correct: true, today: D + 9 });          // 9 days after the miss
  s = sched.recordAttempt(s, { ...SHIFT, correct: false, tag: 'shift_fill', today: D + 7 });   // 7 days: counts
  assert.deepEqual(sched.reviewAccuracy(s), { drill: { right: 0, total: 1 }, holdout: { right: 1, total: 1 } });
  s = sched.recordAttempt(s, { ...ADD, correct: true, today: D + 30 });
  s = sched.recordAttempt(s, { ...SHIFT, correct: true, today: D + 9 });
  assert.deepEqual(sched.reviewAccuracy(s), { drill: { right: 0, total: 1 }, holdout: { right: 1, total: 1 } }, 'measured once');
});

test('scheduler: fading — Why collapses after 2 correct in a row; worked example after 2 misses in a session', () => {
  let s = sched.resetSession(sched.emptyState(), 42);
  const tag = 'add_three_ones';
  assert.deepEqual(sched.fading(s, tag), { collapseWhy: false, showWorked: false });
  s = sched.recordAttempt(s, { type: 0, params: [8, 1, 1, 0, 1], correct: false, tag, today: 1 });
  assert.equal(sched.fading(s, tag).showWorked, false);
  s = sched.recordAttempt(s, { type: 0, params: [8, 3, 3, 0, 1], correct: false, tag, target: tag, today: 1 });
  assert.equal(sched.fading(s, tag).showWorked, true);
  s = sched.noteWorked(s, tag);
  assert.equal(sched.fading(s, tag).showWorked, false, 'shown once per two misses');
  s = sched.recordAttempt(s, { type: 0, params: [8, 7, 7, 0, 1], correct: true, target: tag, today: 1 });
  assert.equal(sched.fading(s, tag).collapseWhy, false);
  s = sched.recordAttempt(s, { type: 0, params: [8, 15, 15, 0, 1], correct: true, target: tag, today: 1 });
  assert.equal(sched.fading(s, tag).collapseWhy, true);
  assert.equal(sched.fading(s, TAG_IDS.indexOf(tag)).collapseWhy, true, 'tag index works too');
  // a miss breaks the streak; a new session forgets the misses but not the streak history
  s = sched.recordAttempt(s, { type: 0, params: [8, 31, 31, 0, 1], correct: false, tag, target: tag, today: 1 });
  assert.equal(sched.fading(s, tag).collapseWhy, false);
  // a miss diagnosed as something else is a miss on THAT tag, not this one
  s = sched.recordAttempt(s, { type: 0, params: [8, 63, 1, 0, 1], correct: false, tag: 'add_or', target: tag, today: 1 });
  assert.equal(sched.fading(s, tag).showWorked, false);
  assert.equal(sched.fading(s, tag).collapseWhy, false);
  s = sched.recordAttempt(s, { type: 0, params: [8, 127, 1, 0, 1], correct: false, tag, target: tag, today: 1 });
  assert.equal(sched.fading(s, tag).showWorked, true, 'two more misses on the tag since the worked example');
  s = sched.resetSession(s, 43);
  assert.deepEqual(sched.fading(s, tag), { collapseWhy: false, showWorked: false });
  assert.equal(s.session.seed, 43);
});

test('scheduler: the queue is capped at 60, oldest finished entries dropped first', () => {
  let s = sched.emptyState();
  for (let i = 0; i < 10; i++) {
    const it = { type: 0, params: [8, i, 1, 0, 1] };
    s = sched.recordAttempt(s, { ...it, correct: false, tag: 'add_or', today: i });
    s = sched.recordAttempt(s, { ...it, correct: true, today: i + 2 });
    s = sched.recordAttempt(s, { ...it, correct: true, today: i + 9 });
    s = sched.recordAttempt(s, { ...it, correct: true, today: i + 30 });
  }
  assert.equal(s.queue.filter((e) => e.done).length, 10);
  for (let i = 0; i < 55; i++) s = sched.recordAttempt(s, { type: 1, params: [8, i, 0, 1, 0, 0, 1], correct: false, tag: 'shift_fill', today: 100 + i });
  assert.equal(s.queue.length, sched.MAX_QUEUE);
  const done = s.queue.filter((e) => e.done);
  assert.equal(done.length, 5, 'the five oldest finished entries went first');
  assert.deepEqual(done.map((e) => e.params[1]), [5, 6, 7, 8, 9]);
  for (let i = 55; i < 70; i++) s = sched.recordAttempt(s, { type: 1, params: [8, i, 0, 1, 0, 0, 1], correct: false, tag: 'shift_fill', today: 100 + i });
  assert.equal(s.queue.length, sched.MAX_QUEUE);
  assert.equal(s.queue.filter((e) => e.done).length, 0);
  assert.equal(Math.min(...s.queue.map((e) => e.miss)), 110, 'then the oldest misses');
});

test('scheduler: review links import without duplicates and keep the furthest progress', () => {
  const D = 20000;
  let s = sched.emptyState();
  s = sched.recordAttempt(s, { ...ADD, correct: false, tag: 'add_or', today: D });
  s = sched.recordAttempt(s, { ...SHIFT, correct: false, tag: 'shift_fill', group: 'holdout', today: D });
  s = sched.recordAttempt(s, { ...SHIFT, correct: true, today: D + 2 });
  const q = codec.encodeQueue(sched.activeEntries(s));
  // a fresh device gets everything back
  const { state: fresh, added } = sched.mergeQueue(sched.emptyState(), codec.decodeQueue(q), D + 3);
  assert.equal(added, 2);
  const pick3 = (e) => ({ type: e.type, params: e.params, tag: e.tag, due: e.due, stage: e.stage, group: e.group });
  assert.deepEqual(sched.activeEntries(fresh).map(pick3), sched.activeEntries(s).map(pick3));
  assert.deepEqual(sched.dueEntries(fresh, D + 2).map((e) => e.params), [ADD.params]);
  // importing the same link again adds nothing
  const again = sched.mergeQueue(fresh, codec.decodeQueue(q), D + 3);
  assert.equal(again.added, 0);
  assert.equal(again.state.queue.length, 2);
  // the same device keeps its own further-along copy, and adopts a further-along one
  const older = sched.mergeQueue(s, [{ ...pick3(s.queue[1]), stage: 0, due: D + 2 }], D + 3);
  assert.equal(older.state.queue[1].stage, 1);
  const newer = sched.mergeQueue(s, [{ ...pick3(s.queue[0]), stage: 2, due: D + 20 }], D + 3);
  assert.deepEqual([newer.state.queue[0].stage, newer.state.queue[0].due], [2, D + 20]);
  // a due day further ahead than one interval from today cannot come from a real link: it is pulled in
  const doctored = sched.mergeQueue(s, [{ ...pick3(s.queue[0]), stage: 2, due: D + 4000 }], D + 3);
  assert.equal(doctored.state.queue[0].due, D + 3 + 21);
});

test('scheduler: dayNumber is the local calendar day (DST-safe) and round-trips', () => {
  assert.equal(sched.dayNumber(new Date(1970, 0, 1, 0, 0)), 0);
  assert.equal(sched.dayNumber(new Date(2026, 8, 26, 0, 1)), sched.dayNumber(new Date(2026, 8, 26, 23, 59)));
  for (const n of [0, 19000, 20722, 30000]) assert.equal(sched.dayNumber(sched.dayToDate(n)), n);
  // run in a zone with daylight saving: consecutive local days differ by exactly 1
  const script = `
    import { dayNumber } from ${JSON.stringify(new URL('../machine/src/learn/scheduler.js', import.meta.url).href)};
    const out = [];
    for (const [y, m, d] of [[2026, 2, 28], [2026, 2, 29], [2026, 2, 30], [2026, 9, 24], [2026, 9, 25], [2026, 9, 26]]) {
      out.push(dayNumber(new Date(y, m, d, 0, 30)), dayNumber(new Date(y, m, d, 23, 30)));
    }
    console.log(JSON.stringify(out));`;
  for (const TZ of ['Europe/London', 'America/New_York', 'Pacific/Auckland']) {
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ } }).toString());
    for (let i = 0; i < out.length; i += 2) assert.equal(out[i], out[i + 1], `${TZ}: same day at 00:30 and 23:30`);
    assert.deepEqual([out[2] - out[0], out[4] - out[2], out[8] - out[6], out[10] - out[8]], [1, 1, 1, 1], TZ);
  }
});

test('holdout: 15% ± 2% over 10,000 indices, deterministic, and different per session', () => {
  for (const seed of [1, 2024, 0xdeadbeef]) {
    let n = 0;
    for (let i = 0; i < 10000; i++) n += sched.isHoldout(seed, i) ? 1 : 0;
    assert.ok(Math.abs(n / 10000 - 0.15) <= 0.02, `seed ${seed}: ${n / 100}%`);
  }
  const a = Array.from({ length: 200 }, (_, i) => sched.isHoldout(77, i));
  assert.deepEqual(a, Array.from({ length: 200 }, (_, i) => sched.isHoldout(77, i)));
  assert.notDeepEqual(a, Array.from({ length: 200 }, (_, i) => sched.isHoldout(78, i)));
});

// ---------------------------------------------------------------------------
// study and sets
// ---------------------------------------------------------------------------

test('study: arms are balanced over many seeds and feedback follows the arm', () => {
  let ones = 0;
  for (let s = 0; s < 10000; s++) ones += study.assignArm(s * 2654435761);
  assert.ok(Math.abs(ones / 10000 - 0.5) <= 0.02, `${ones} of 10000 in arm 1`);
  assert.equal(study.assignArm(123), study.assignArm(123));
  assert.equal(study.feedbackFor(0, 'A'), 'full');
  assert.equal(study.feedbackFor(0, 'B'), 'answerOnly');
  assert.equal(study.feedbackFor(1, 'A'), 'answerOnly');
  assert.equal(study.feedbackFor(1, 'B'), 'full');
  for (const arm of [0, 1, 2]) for (const f of ['A', 'B']) assert.equal(study.feedbackFor(arm, f, 'delayed'), 'answerOnly');
  assert.equal(study.feedbackFor(3, 'A', 'normal'), 'full');
  assert.deepEqual(study.studySpecs('gcse'), { A: 'J277-1.2.4-add', B: 'J277-1.2.4-shift' });
});

test('study: the arm can be recovered from last week\'s result code', () => {
  const tok = (o) => codec.encodeToken({ setId: 300, mode: 'study', g1: { right: 3, total: 5 }, g2: { right: 2, total: 5 }, tags: [], ...o });
  assert.deepEqual(study.recoverArm(tok({ arm: 1 }), 300), { arm: 1 });
  assert.deepEqual(study.recoverArm(tok({ arm: 0 }).toLowerCase(), 300), { arm: 0 });
  assert.match(study.recoverArm(tok({ arm: 1 }), 301).error, /different set/);
  assert.match(study.recoverArm(tok({ arm: 2 }), 300).error, /which group/);
  assert.match(study.recoverArm(tok({ mode: 'normal' }), 300).error, /not from a study set/);
  assert.match(study.recoverArm('hello', 300).error, /12 characters/);
});

test('study: t quantiles match published tables', () => {
  const table = { 1: 12.706, 2: 4.303, 5: 2.571, 10: 2.228, 20: 2.086, 30: 2.042, 120: 1.980 };
  for (const [df, t] of Object.entries(table)) assert.ok(Math.abs(study.tQuantile(0.975, +df) - t) < 0.0015, `df ${df}`);
  assert.ok(Math.abs(study.tQuantile(0.025, 10) + 2.228) < 0.0015);
  const p = study.pairedStats([0.2, 0.4, 0, 0.2, 0.6]);
  assert.ok(Math.abs(p.mean - 0.28) < 1e-12);
  assert.ok(Math.abs(p.sd - Math.sqrt(0.052)) < 1e-12);
  assert.ok(Math.abs(p.hi - (0.28 + 2.776445 * Math.sqrt(0.052 / 5))) < 1e-5);
  assert.equal(study.pairedStats([0.5]).lo, null);
  assert.equal(study.pairedStats([]), null);
});

const normalSet = (o = {}) => codec.decodeSet(codec.encodeSet({ level: 'gcse', topics: ['add', 'shift'], n: 10, seed: 99, mode: 'normal', ...o }));

test('sets: plans are deterministic and differ between sets', () => {
  for (const mode of ['normal', 'study', 'delayed']) {
    const set = normalSet({ mode });
    assert.deepEqual(sets.planSet(set, { arm: 0 }), sets.planSet(set, { arm: 0 }));
    assert.notDeepEqual(sets.planSet(set, { arm: 0 }).map((s) => s.seed), sets.planSet(normalSet({ mode, seed: 100 }), { arm: 0 }).map((s) => s.seed));
  }
});

test('sets: normal plans interleave the chosen spec points and hold out ~15%', () => {
  const rng = rngFor(8);
  for (let k = 0; k < 300; k++) {
    const level = pick(rng, ['gcse', 'alevel']);
    const topics = level === 'gcse' ? pick(rng, [['add'], ['shift'], ['add', 'shift']]) : pick(rng, [['twos', 'sadd'], ['shift', 'fa', 'twos'], ['sadd']]);
    const set = codec.decodeSet(codec.encodeSet({ level, topics, n: randInt(rng, 5, 15), seed: randInt(rng, 0, 2 ** 30 - 1), mode: 'normal' }));
    const plan = sets.planSet(set);
    assert.equal(plan.length, set.n);
    for (const slot of plan) {
      const spec = specById(slot.spec);
      assert.equal(spec.level, level);
      assert.ok(topics.includes(spec.topic));
      assert.equal(slot.group === 'holdout', slot.feedback === 'answerOnly');
      assert.equal(slot.family, null);
    }
    const specsUsed = new Set(plan.map((s) => s.spec));
    assert.equal(specsUsed.size, Math.min(set.n, SPECS.filter((s) => s.level === level && topics.includes(s.topic)).length), 'every chosen point appears');
    if (specsUsed.size > 1) for (let i = 1; i < plan.length; i++) assert.notEqual(plan[i].spec, plan[i - 1].spec, 'interleaved');
    const held = plan.filter((s) => s.group === 'holdout');
    assert.equal(held.length, sets.holdoutCount(set.n));
    assert.equal(plan[0].group, 'drill', 'the first question always gets full feedback');
    assert.equal(new Set(plan.map((s) => s.seed)).size, plan.length);
  }
  assert.deepEqual([5, 7, 10, 13, 15].map(sets.holdoutCount), [1, 1, 2, 2, 2]);
});

test('sets: study plans alternate families with feedback from the arm; delayed sets are answer-only transfer', () => {
  const s = normalSet({ mode: 'study', n: 11 });
  const p0 = sets.planSet(s, { arm: 0 });
  const p1 = sets.planSet(s, { arm: 1 });
  for (let i = 1; i < p0.length; i++) assert.notEqual(p0[i].family, p0[i - 1].family);
  for (const [slot, other] of p0.map((x, i) => [x, p1[i]])) {
    assert.equal(slot.spec, slot.family === 'A' ? 'J277-1.2.4-add' : 'J277-1.2.4-shift');
    assert.equal(slot.feedback, slot.family === 'A' ? 'full' : 'answerOnly');
    assert.equal(other.feedback, slot.family === 'A' ? 'answerOnly' : 'full', 'arm 1 is the mirror image');
    assert.equal(slot.seed, other.seed, 'same questions in both arms');
  }
  assert.throws(() => sets.planSet(s, {}), /arm/);
  const d = codec.decodeSet(codec.encodeSet({ level: 'gcse', topics: ['add', 'shift'], n: 10, seed: 99, mode: 'delayed', link: s.setId }));
  const pd = sets.planSet(d, {});
  assert.ok(pd.every((x) => x.feedback === 'answerOnly'));
  assert.deepEqual(new Set(pd.map((x) => x.family)), new Set(['A', 'B']));
  assert.equal(pd.filter((x) => x.family === 'A').length, 5);
  const studySeeds = new Set(sets.planSet(normalSet({ mode: 'study', n: 10 }), { arm: 0 }).map((x) => x.seed));
  assert.ok(pd.every((x) => !studySeeds.has(x.seed)), 'transfer items use different seeds');
});

test('sets: every slot builds a real item of the right family', () => {
  for (const [level, topics] of [['gcse', ['add', 'shift']], ['alevel', ['twos', 'sadd', 'shift', 'fa']]]) {
    for (const mode of ['normal', 'study', 'delayed']) {
      const set = codec.decodeSet(codec.encodeSet({ level, topics, n: 15, seed: 4242, mode }));
      for (const slot of sets.planSet(set, { arm: 1 })) {
        const { type, params } = itemForSpec(slot.spec, mulberry32(slot.seed), { level });
        const item = makeItem(type, params);
        if (slot.family) assert.equal(item.family, study.FAMILY_TOPIC[slot.family]);
      }
    }
  }
});

test('sets: summarizeSet counts first attempts per group and the three commonest misconceptions', () => {
  const set = normalSet({ n: 10 });
  const plan = sets.planSet(set);
  // wrong at 1 2 4 5 7 8; slot 9 not answered
  const wrong = { 1: 'add_or', 2: 'add_no_carry', 4: 'add_no_carry', 5: 'shift_fill', 7: 'add_no_carry', 8: 'other' };
  const results = plan.map((slot, i) => (i === 9 ? null : { correct: !wrong[i], tag: wrong[i] || null }));
  const sum = sets.summarizeSet(results, plan, { setId: set.setId, mode: 'normal' });
  const answered = plan.filter((_, i) => i !== 9);
  assert.equal(sum.g1.total + sum.g2.total, 9);
  assert.equal(sum.g2.total, answered.filter((s) => s.group === 'holdout').length);
  assert.equal(sum.g1.right + sum.g2.right, 3);
  assert.equal(sum.arm, codec.ARM_NONE);
  const wrongTags = results.filter((r) => r && !r.correct).map((r) => r.tag);
  const freq = (t) => wrongTags.filter((x) => x === t).length;
  assert.equal(sum.tags.length, 3);
  for (let i = 1; i < 3; i++) assert.ok(freq(sum.tags[i - 1]) >= freq(sum.tags[i]));
  assert.deepEqual(sum.tags, ['add_no_carry', 'add_or', 'shift_fill'], 'ties go to the one met first');
  const back = codec.decodeToken(codec.encodeToken(sum));
  assert.deepEqual([back.g1, back.g2, back.tags, back.setId], [sum.g1, sum.g2, sum.tags, set.setId]);
  // study sets: g1 = family A, g2 = family B, arm carried (unknown → 2)
  const ss = normalSet({ mode: 'study', n: 6 });
  const sp = sets.planSet(ss, { arm: 1 });
  const all = sp.map((slot) => ({ correct: slot.family === 'B', tag: slot.family === 'A' ? 'add_or' : null }));
  const st = sets.summarizeSet(all, sp, { setId: ss.setId, mode: 'study', arm: 1 });
  assert.deepEqual([st.g1, st.g2, st.arm, st.tags], [{ right: 0, total: 3 }, { right: 3, total: 3 }, 1, ['add_or']]);
  assert.equal(sets.summarizeSet(all, sp, { setId: ss.setId, mode: 'delayed' }).arm, codec.ARM_UNKNOWN);
});

// ---------------------------------------------------------------------------
// starter
// ---------------------------------------------------------------------------

const keyOf = (e) => `${e.spec}|${e.tag || ''}`;
const T = 20000;

test('starter: an empty class still gets five different questions, honestly labelled', () => {
  for (const level of ['gcse', 'alevel', 'csapp']) {
    const plan = starter.buildStarter(starter.newClass({ id: 'c', name: '10X', level }), T, rngFor(1));
    assert.equal(plan.length, 5, level);
    assert.equal(new Set(plan.map(keyOf)).size, 5, `${level}: no duplicates`);
    assert.ok(plan.every((e) => e.source === 'new' && specById(e.spec).level === level && e.note), level);
  }
});

test('starter: 2 missed/split, 2 taught 1–6 weeks ago, 1 most recently taught', () => {
  let c = starter.newClass({ level: 'alevel' });
  const taught = { 'H446-1.4.1-twos': 40, 'H446-1.4.1-arith': 25, 'H446-1.4.1-shift': 12, 'H446-1.4.3-adders': 3, 'J277-1.2.4-add': 60 };
  for (const [id, ago] of Object.entries(taught)) c = starter.setTaught(c, id, T - ago);
  c = starter.recordTap(c, { spec: 'H446-1.4.1-twos', tag: 'twos_no_plus1', result: 'missed', date: T - 6 });
  c = starter.recordTap(c, { spec: 'H446-1.4.1-arith', tag: 'flags_carry_is_overflow', result: 'split', date: T - 2 });
  c = starter.recordTap(c, { spec: 'H446-1.4.1-shift', tag: 'shift_fill', result: 'missed', date: T - 20 });
  c = starter.recordTap(c, { spec: 'H446-1.4.1-shift', tag: 'shift_fill', result: 'got', date: T - 10 });   // since fixed
  c = starter.recordTap(c, { spec: 'J277-1.2.4-add', tag: 'add_or', result: 'split', date: T - 30 });
  const plan = starter.buildStarter(c, T, rngFor(3));
  assert.deepEqual(plan.map((e) => e.source), ['missed', 'missed', 'spaced', 'spaced', 'new']);
  assert.deepEqual(plan.slice(0, 2).map((e) => e.tag), ['twos_no_plus1', 'flags_carry_is_overflow'], 'a recent miss outranks a split');
  assert.ok(plan.slice(2, 4).every((e) => { const d = T - c.taught[e.spec]; return d >= 7 && d <= 42; }));
  assert.equal(plan[4].spec, 'H446-1.4.3-adders');
  assert.equal(new Set(plan.map(keyOf)).size, 5);
  assert.ok(!plan.some((e) => e.tag === 'shift_fill'), 'a miss the class later got right does not come back');
  assert.deepEqual(plan, starter.buildStarter(c, T, rngFor(3)), 'deterministic for a given rng');
  assert.match(plan[0].note, /missed this 6 days ago/);
});

test('starter: thin histories fall back sensibly and never repeat when avoidable', () => {
  // only one thing taught, yesterday
  let c = starter.setTaught(starter.newClass({ level: 'gcse' }), 'J277-1.2.4-add', T - 1);
  let plan = starter.buildStarter(c, T, rngFor(4));
  assert.equal(plan.length, 5);
  assert.equal(plan[4].spec, 'J277-1.2.4-add');
  assert.equal(plan[4].source, 'new');
  assert.equal(new Set(plan.map(keyOf)).size, 5);
  // taught long ago only: labelled spaced, not missed
  c = starter.setTaught(starter.setTaught(starter.newClass({ level: 'gcse' }), 'J277-1.2.4-add', T - 90), 'J277-1.2.4-shift', T - 80);
  plan = starter.buildStarter(c, T, rngFor(5));
  assert.equal(plan.length, 5);
  assert.ok(!plan.some((e) => e.source === 'missed'));
  assert.equal(plan[4].spec, 'J277-1.2.4-shift');
  // random histories: always five, never a duplicate (GCSE always has enough variety)
  const rng = rngFor(6);
  for (let k = 0; k < 300; k++) {
    let h = starter.newClass({ level: pick(rng, ['gcse', 'alevel']) });
    for (const s of SPECS) if (rng() < 0.5) h = starter.setTaught(h, s.id, T - randInt(rng, 0, 70));
    for (let i = randInt(rng, 0, 12); i > 0; i--) {
      const s = pick(rng, SPECS.filter((x) => x.topic !== 'c'));
      const tags = TAG_IDS.filter((t) => t && t.startsWith({ add: 'add_', shift: 'shift_', twos: 'twos_', sadd: 'flags_', fa: 'add_' }[s.topic]));
      h = starter.recordTap(h, { spec: s.id, tag: rng() < 0.7 ? pick(rng, tags) : null, result: pick(rng, starter.TAP_RESULTS), date: T - randInt(rng, 0, 60) });
    }
    plan = starter.buildStarter(h, T, rngFor(k));
    assert.equal(plan.length, 5);
    assert.equal(new Set(plan.map(keyOf)).size, 5, JSON.stringify(plan));
    for (const e of plan) {
      assert.ok(specById(e.spec));
      assert.ok(['missed', 'spaced', 'new'].includes(e.source));
      if (e.tag) assert.ok(TAG_IDS.includes(e.tag));
    }
  }
});

test('starter: taps are validated, dated and capped', () => {
  assert.throws(() => starter.recordTap(starter.newClass(), { spec: 'J277-1.2.4-add', result: 'maybe', date: T }), RangeError);
  let c = starter.newClass();
  c = starter.recordTap(c, { spec: 'J277-1.2.4-add', result: 'got', date: new Date(2026, 8, 26, 10) });
  assert.equal(c.taps[0].day, sched.dayNumber(new Date(2026, 8, 26)));
  for (let i = 0; i < 400; i++) c = starter.recordTap(c, { spec: 'J277-1.2.4-add', result: 'split', date: T });
  assert.equal(c.taps.length, 300);
  assert.equal(starter.setTaught(starter.setTaught(c, 'J277-1.2.4-add', T), 'J277-1.2.4-add', null).taught['J277-1.2.4-add'], undefined);
});

// ---------------------------------------------------------------------------
// board
// ---------------------------------------------------------------------------

test('board: pasted text in any shape — lines, columns, case, spaces, several per line — duplicates flagged', () => {
  const set = normalSet({ n: 10 });
  const mk = (r1, t1, r2, t2, tags = [], setId = set.setId) => codec.encodeToken({ setId, mode: 'normal', g1: { right: r1, total: t1 }, g2: { right: r2, total: t2 }, tags });
  const a = mk(6, 8, 1, 2, ['add_no_carry']);
  const b = mk(8, 8, 2, 2);
  const c = mk(3, 8, 0, 2, ['add_or', 'add_no_carry']);
  const other = mk(5, 8, 1, 2, [], (set.setId + 1) % 1024);
  const text = [
    'Name,Result code',
    `Emma,${a.toLowerCase()}`,
    `Sam\t${b.replace(/-/g, ' ')}`,
    `  ${c.replace(/-/g, '')}   ${a}  `,
    '"Jo-Anne Smith", year 10',
    'Kit, 7K2M-9QXA-40T',
    `Lee | ${b.slice(0, 5)}${b[5] === 'X' ? 'Y' : 'X'}${b.slice(6)}`,
    `Ola; ${other}`,
    `Pat ${a.replace(/-/g, '–')}`,
    '',
  ].join('\r\n');
  const r = board.analyzeTokens(text);
  assert.deepEqual(r.rows.map((x) => x.line), [2, 3, 4, 4, 8, 9]);
  assert.deepEqual(r.rows.map((x) => x.dupOf), [null, null, null, 2, null, 2]);
  assert.deepEqual(r.invalid.map((x) => x.line), [6, 7]);
  assert.match(r.invalid[0].error, /12 characters/);
  assert.match(r.invalid[1].error, /mistyped/);
  assert.equal(r.completion.codes, 6);
  assert.equal(r.completion.unique, 4);
  assert.equal(r.completion.duplicates, 2);
  assert.deepEqual(r.completion.sets, [{ setId: set.setId, count: 5 }, { setId: (set.setId + 1) % 1024, count: 1 }]);
  assert.deepEqual(r.tagCounts.map((t) => [t.tag, t.count, t.of]), [['add_no_carry', 4, 6], ['add_or', 1, 6]]);
  assert.equal(r.tagCounts[0].label, 'Dropped a carry');
  assert.ok(Math.abs(r.meanScore - (0.7 + 1 + 0.3 + 0.7 + 0.6 + 0.7) / 6) < 1e-12);
  assert.equal(r.study, null);
  // with the set code: codes from other sets are reported, completion is known
  const rs = board.analyzeTokens(text, { setCode: set.code });
  assert.equal(rs.rows.length, 5);
  assert.ok(rs.invalid.some((x) => x.line === 8 && /different set/.test(x.error)));
  assert.equal(rs.completion.expected, 10);
  assert.equal(rs.completion.finished, 5);
  assert.ok(board.analyzeTokens(text, { setCode: 'nonsense' }).setError);
  assert.deepEqual(board.analyzeTokens('').rows, []);
});

test('board: CSV is RFC 4180 and safe to open in a spreadsheet', () => {
  const r = board.analyzeTokens(codec.encodeToken({ setId: 1, mode: 'normal', g1: { right: 1, total: 2 }, g2: { right: 0, total: 1 }, tags: ['add_or'] }));
  r.invalid.push({ line: 2, text: '=HYPERLINK("http://x")', error: 'Bad, "quoted"\ntext' });
  const csv = board.toCsv(r);
  const lines = csv.split('\r\n');
  assert.equal(lines.at(-1), '');
  assert.match(lines[0], /^line,code,set,mode,score %,/);
  assert.match(lines[1], /,33,1,2,0,1,,Treated 1 \+ 1 as 1,,,,$/);
  assert.ok(csv.includes('"\'=HYPERLINK(""http://x"")"'), 'formula neutralised and quotes doubled');
  assert.ok(csv.includes('"Bad, ""quoted""\ntext"'));
});

/**
 * A synthetic crossover class. Each learner has an ability; full feedback on a
 * family adds `effect` to their chance of a right answer on it a week later.
 * Returns the tokens and the true per-learner differences (with each arm).
 */
function syntheticClass(rng, { n, effect, items = 5, setId = 77, mode = 'delayed' }) {
  const tokens = [];
  const diffs = [];
  const arms = [];
  for (let s = 0; s < n; s++) {
    const arm = study.assignArm(Math.floor(rng() * 2 ** 32));
    const ability = 0.35 + 0.3 * rng();
    const pA = Math.min(1, ability + (arm === 0 ? effect : 0));
    const pB = Math.min(1, ability + (arm === 1 ? effect : 0));
    const count = (p) => Array.from({ length: items }, () => (rng() < p ? 1 : 0)).reduce((x, y) => x + y, 0);
    const g1 = { right: count(pA), total: items };
    const g2 = { right: count(pB), total: items };
    diffs.push(arm === 0 ? (g1.right - g2.right) / items : (g2.right - g1.right) / items);
    arms.push(arm);
    tokens.push(codec.encodeToken({ setId, mode, g1, g2, arm, tags: [] }));
  }
  return { tokens, diffs, arms };
}

test('board: study analysis — per-arm accuracy, paired difference and its CI recover a known effect', () => {
  const rng = rngFor(11);
  const { tokens, diffs, arms } = syntheticClass(rng, { n: 400, effect: 0.2 });
  // an unknown-arm learner and a normal-set code are left out of the paired analysis
  tokens.push(codec.encodeToken({ setId: 77, mode: 'delayed', g1: { right: 5, total: 5 }, g2: { right: 0, total: 5 }, arm: 2, tags: [] }));
  tokens.push(codec.encodeToken({ setId: 12, mode: 'normal', g1: { right: 5, total: 5 }, g2: { right: 0, total: 5 }, tags: [] }));
  const r = board.analyzeTokens(tokens.join('\n'));
  const d = r.study.delayed;
  assert.equal(r.study.study, null);
  assert.equal(d.unknownArm, 1);
  assert.equal(d.n, 400);
  assert.equal(d.arms[0].n + d.arms[1].n, 400);
  const decoded = tokens.slice(0, 400).map((t) => codec.decodeToken(t));
  for (const arm of [0, 1]) {
    const mine = decoded.filter((t) => t.arm === arm);
    assert.equal(d.arms[arm].A.right, mine.reduce((s, t) => s + t.g1.right, 0));
    assert.equal(d.arms[arm].B.total, mine.length * 5);
  }
  // the board's numbers equal an independent crossover computation from the
  // true data: the mean of the two arm means, pooled within-arm SD
  const inArm = (a) => diffs.filter((_, i) => arms[i] === a);
  const [d0, d1] = [inArm(0), inArm(1)];
  const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ss = (xs) => xs.reduce((s, x) => s + (x - avg(xs)) ** 2, 0);
  const mean = (avg(d0) + avg(d1)) / 2;
  const sd = Math.sqrt((ss(d0) + ss(d1)) / (diffs.length - 2));
  assert.equal(d.diff.n, 400);
  assert.equal(d.diff.df, 398);
  assert.ok(Math.abs(d.diff.mean - mean) < 1e-12);
  assert.ok(Math.abs(d.diff.sd - sd) < 1e-12);
  assert.ok(Math.abs(d.diff.se - (sd * Math.sqrt(1 / d0.length + 1 / d1.length)) / 2) < 1e-12);
  assert.ok(d.diff.lo < 0.2 && 0.2 < d.diff.hi, `CI ${d.diff.lo.toFixed(3)}–${d.diff.hi.toFixed(3)} covers the true 0.2`);
  assert.ok(d.diff.lo > 0, 'and excludes zero at this sample size');
  assert.ok(d.diff.hi - d.diff.lo < 0.12);
  assert.equal(d.diff.reading, d.diff.dz >= 0.3 ? 'invest' : d.diff.dz < 0.1 ? 'stop' : 'replicate');
  // arm 0 drilled A: A beats B; arm 1 drilled B: B beats A
  assert.ok(d.arms[0].A.acc > d.arms[0].B.acc && d.arms[1].B.acc > d.arms[1].A.acc);
});

test('board: the 95% CI covers the true effect in about 95% of simulated classes of 30', () => {
  const rng = rngFor(12);
  let covered = 0;
  const runs = 400;
  for (let k = 0; k < runs; k++) {
    const { tokens } = syntheticClass(rng, { n: 30, effect: 0.15, items: 6, mode: 'study' });
    const { diff } = board.analyzeTokens(tokens.join(' ')).study.study;
    // the expected difference is exactly the effect unless the capped probability bites (it cannot: p ≤ 0.8)
    if (diff.lo <= 0.15 && 0.15 <= diff.hi) covered++;
  }
  assert.ok(covered / runs >= 0.91 && covered / runs <= 0.99, `coverage ${(100 * covered / runs).toFixed(1)}%`);
});
