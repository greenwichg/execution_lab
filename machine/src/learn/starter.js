// The five-question lesson starter a teacher projects: two things the class
// recently missed or split on, two spec points taught 1–6 weeks ago (spaced
// retrieval), and the most recently taught point. It works from a small local
// "class state" — dates taught and whole-class taps — never from pupil data.
import { SPECS, specById, specsForLevel } from './spec.js';
import { TAG_IDS } from './tagids.js';
import { tagLabel } from './catalogue.js';
import { toDay } from './scheduler.js';
import { mulberry32, mixSeed, shuffle } from '../lib/rng.js';

export const TAP_RESULTS = ['got', 'split', 'missed'];
const RECENT_DAYS = 42;                  // "recent" taps and the far edge of spacing
const SPACED_MIN = 7;
const MAX_TAPS = 300;
const SLOTS = ['missed', 'missed', 'spaced', 'spaced', 'new'];

// Which misconceptions a spec point's own item type can aim at (the same
// prefixes itemForTag uses to pick a type). Full adders and C cards have no
// general-purpose targeting, so they are never given a tag here.
const TAG_PREFIX = { add: 'add_', shift: 'shift_', twos: 'twos_', sadd: 'flags_' };

const specOrder = (id) => SPECS.findIndex((s) => s.id === id);

export function newClass({ id = '', name = '', level = 'gcse' } = {}) {
  return { v: 1, id, name, level, taught: {}, taps: [] };
}

/** a tap saved by an older build or damaged storage → a usable tap, or null */
function normTap(t) {
  if (!t || typeof t !== 'object' || !Number.isSafeInteger(t.day) || !TAP_RESULTS.includes(t.result)) return null;
  // an unknown tag cannot be aimed at, so the tap still counts for its spec point
  return { ...t, tag: TAG_IDS.includes(t.tag) ? t.tag : null };
}

function normClass(cls) {
  const c = cls && typeof cls === 'object' && !Array.isArray(cls) ? cls : {};
  const taught = c.taught && typeof c.taught === 'object' && !Array.isArray(c.taught) ? c.taught : {};
  return { ...newClass(), ...c, taught: { ...taught }, taps: Array.isArray(c.taps) ? c.taps.map(normTap).filter(Boolean) : [] };
}

/** mark a spec point taught on a day (null clears it) */
export function setTaught(cls, specId, day) {
  const c = normClass(cls);
  if (day === null || day === undefined) delete c.taught[specId];
  else c.taught[specId] = toDay(day);
  return c;
}

/** one tap from the projector: how the class did on a starter question */
export function recordTap(cls, { spec, tag = null, result, date = new Date() }) {
  if (!TAP_RESULTS.includes(result)) throw new RangeError(`recordTap: result must be one of ${TAP_RESULTS.join(', ')}`);
  const c = normClass(cls);
  c.taps.push({ day: toDay(date), spec, tag: TAG_IDS.includes(tag) ? tag : null, result });
  if (c.taps.length > MAX_TAPS) c.taps = c.taps.slice(-MAX_TAPS);
  return c;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

function ago(days) {
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 61) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

/** taught spec points up to today, most recent first (same day: later in the course first) */
function taughtList(c, day) {
  return Object.entries(c.taught)
    .filter(([id, d]) => specById(id) && Number.isInteger(d) && d <= day)
    .map(([spec, d]) => ({ spec, day: d }))
    .sort((a, b) => (b.day - a.day) || (specOrder(b.spec) - specOrder(a.spec)));
}

/**
 * (spec, tag) pairs the class most recently missed or split on and has not
 * since got right, ranked by a recency-weighted count (missed 2, split 1,
 * halving every fortnight). Older ones follow, newest first.
 */
function missedCandidates(c, day) {
  const byKey = new Map();
  for (const t of c.taps) {
    if (!specById(t.spec) || !(t.day <= day)) continue;
    const key = `${t.spec}|${t.tag || ''}`;
    const k = byKey.get(key) || { spec: t.spec, tag: t.tag || null, last: null, score: 0 };
    if (!k.last || t.day >= k.last.day) k.last = t;
    if (t.result !== 'got' && day - t.day <= RECENT_DAYS) k.score += (t.result === 'missed' ? 2 : 1) * 0.5 ** ((day - t.day) / 14);
    byKey.set(key, k);
  }
  const open = [...byKey.values()].filter((k) => k.last.result !== 'got');
  const recent = open.filter((k) => day - k.last.day <= RECENT_DAYS).sort((a, b) => (b.score - a.score) || (b.last.day - a.last.day));
  const older = open.filter((k) => day - k.last.day > RECENT_DAYS).sort((a, b) => b.last.day - a.last.day);
  return [...recent, ...older].map((k) => {
    const what = k.last.result === 'missed' ? 'Most of the class missed this' : 'The class was split on this';
    const why = k.tag ? ` (${tagLabel(k.tag)})` : '';
    return { source: 'missed', spec: k.spec, tag: k.tag, note: `${what} ${ago(day - k.last.day)}${why}.` };
  });
}

function lastSeen(c, spec, taughtDay) {
  return c.taps.reduce((m, t) => (t.spec === spec && t.day > m ? t.day : m), taughtDay);
}

function taughtEntry(t, day, source) {
  return { source, spec: t.spec, tag: null, note: `Taught ${ago(day - t.day)}.` };
}

/** questions aimed at one misconception each: a last resort when history is too thin for five different questions */
function variantCandidates(specIds, sourceOf, rng) {
  const perSpec = [];
  for (const id of new Set(specIds)) {
    const prefix = TAG_PREFIX[specById(id)?.topic];
    if (!prefix) continue;
    const tags = shuffle(rng, TAG_IDS.filter((t) => t && t.startsWith(prefix)));
    perSpec.push(tags.map((tag) => ({ source: sourceOf(id), spec: id, tag, note: `Aimed at: ${tagLabel(tag)}.` })));
  }
  // round-robin across spec points, so a thin history still gets variety
  const out = [];
  for (let i = 0; perSpec.some((l) => i < l.length); i++) for (const l of perSpec) if (i < l.length) out.push(l[i]);
  return out;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

const keyOf = (e) => `${e.spec}|${e.tag || ''}`;

/**
 * Take the first candidate in the first pool that can supply one. Missed
 * pools keep their ranking; other pools prefer a spec point not yet in the
 * plan, so five questions cover as much ground as the history allows.
 */
function takeFrom(pools, plan) {
  const keys = new Set(plan.map(keyOf));
  const specs = new Set(plan.map((e) => e.spec));
  for (const { list, diverse } of pools) {
    const fresh = list.filter((e) => !keys.has(keyOf(e)));
    const pick = (diverse && fresh.find((e) => !specs.has(e.spec))) || fresh[0];
    if (pick) return pick;
  }
  // Nothing new left (a tiny course): repeating a question beats a short starter.
  return pools.find((p) => p.list.length)?.list[0] || null;
}

/**
 * buildStarter(classState, today, rng) → 5 × { source: 'missed'|'spaced'|'new', spec, tag?, note }
 * Each entry's `source` says what it really is: when the class has little
 * history, empty slots are filled from what exists, and labelled as such.
 */
export function buildStarter(classState, today, rng) {
  const c = normClass(classState);
  const day = toDay(today ?? new Date());
  const r = rng || mulberry32(mixSeed('starter', c.id, day));     // same plan all day when no rng is given
  const level = specsForLevel(c.level).length ? c.level : 'gcse';
  const taught = taughtList(c, day);
  const newest = taught[0] || null;

  const missed = missedCandidates(c, day);
  const inWindow = (t) => day - t.day >= SPACED_MIN && day - t.day <= RECENT_DAYS;
  // shuffle first so equally-stale points are chosen at random, then least recently practised first
  const spaced = shuffle(r, taught.filter(inWindow))
    .sort((a, b) => lastSeen(c, a.spec, a.day) - lastSeen(c, b.spec, b.day))
    .map((t) => taughtEntry(t, day, 'spaced'));
  const olderTaught = taught.filter((t) => day - t.day > RECENT_DAYS).map((t) => taughtEntry(t, day, 'spaced'));
  const recentTaught = taught.filter((t) => day - t.day < SPACED_MIN).map((t) => taughtEntry(t, day, 'new'));
  const taughtDay = new Map(taught.map((t) => [t.spec, t.day]));
  const untaught = specsForLevel(level).filter((s) => !taughtDay.has(s.id))
    .map((s) => ({ source: 'new', spec: s.id, tag: null, note: 'Not marked as taught yet.' }));
  const newEntry = newest ? [{ source: 'new', spec: newest.spec, tag: null, note: `Taught most recently (${ago(day - newest.day)}).` }] : [];
  const sourceOf = (id) => (taughtDay.has(id) && day - taughtDay.get(id) >= SPACED_MIN ? 'spaced' : 'new');
  const variants = variantCandidates([...taught.map((t) => t.spec), ...specsForLevel(level).map((s) => s.id)], sourceOf, r);

  const pool = (list, diverse = true) => ({ list, diverse });
  const POOLS = {
    new: [pool(newEntry), pool(recentTaught), pool(untaught), pool(spaced), pool(olderTaught), pool(missed, false), pool(variants)],
    missed: [pool(missed, false), pool(spaced), pool(olderTaught), pool(recentTaught), pool(untaught), pool(variants)],
    spaced: [pool(spaced), pool(olderTaught), pool(missed, false), pool(recentTaught), pool(untaught), pool(variants)],
  };

  // Fill 'new' first when it is a fixed choice (the newest taught point), then
  // the missed and spaced slots. With nothing taught, 'new' is only a filler,
  // so it goes last: filled first it would take a point the class just missed
  // and label it "not taught yet".
  const plan = [];
  const filled = new Array(SLOTS.length).fill(null);
  const fillOrder = newest ? [4, 0, 1, 2, 3] : [0, 1, 2, 3, 4];
  for (const i of fillOrder) {
    const e = takeFrom(POOLS[SLOTS[i]], plan);
    if (e) { plan.push(e); filled[i] = e; }
  }
  return filled.filter(Boolean).map(({ source, spec, tag, note }) => (tag ? { source, spec, tag, note } : { source, spec, note }));
}
