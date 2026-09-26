// Spaced review, fading and the holdout, as pure functions over one plain
// state object (store.js persists it under 'sched'). Every function returns a
// new state, so the UI can save whatever comes back and tests can replay a
// learner's history day by day.
//
// A miss comes back after 2 days; a correct review pushes it to 7, then 21
// days, then it is done; a wrong review starts again at 2 days (spacing and
// retrieval practice are the two best-evidenced ways to make learning stick).
import { mulberry32, mixSeed } from '../lib/rng.js';
import { tagIndex, tagId } from './tagids.js';
import { typeById } from './items/index.js';

export const REVIEW_DAYS = [2, 7, 21];      // wait after a miss, then after each correct review
export const MAX_QUEUE = 60;
export const HOLDOUT_RATE = 0.15;
export const MEASURE_AFTER = 7;             // days after the miss before a review counts as evidence
const TYPE_NAMES = ['add', 'shift', 'twos', 'sadd', 'fa', 'card'];   // index = TYPE_ID
const DAY_MS = 86400000;
const MAX_TAG = 31;
const W_RANGE = [4, 16];                    // every binary generator's width range (CONTRACTS.md: add w 4–16)

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/** the learner's LOCAL calendar day as a whole number (1970-01-01 = 0); a review due "in 2 days" means two midnights */
export function dayNumber(date = new Date()) {
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

/** local midnight at the start of a day number */
export function dayToDate(day) {
  const u = new Date(day * DAY_MS);
  return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate());
}

/**
 * a day number or a Date → a whole day number. Anything else is refused: a
 * NaN or fractional day saved into the queue would never come due and would
 * break every review link made from it afterwards.
 */
export function toDay(d) {
  if (typeof d === 'number' && Number.isFinite(d)) return Math.floor(d);
  if (d instanceof Date && Number.isFinite(d.getTime())) return dayNumber(d);
  throw new RangeError(`not a day: ${String(d)}`);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export function emptyState() {
  return {
    v: 1,
    queue: [],
    tags: {},                                          // tagId → { streak } (correct in a row)
    evidence: { drill: { right: 0, total: 0 }, holdout: { right: 0, total: 0 } },
    session: { seed: 0, misses: {}, shown: {} },
  };
}

const typeId = (type) => (Number.isInteger(type) ? type : TYPE_NAMES.indexOf(type));
const toTagIdx = (t) => (typeof t === 'number' ? t : tagIndex(t ?? null));
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isDay = (v) => Number.isSafeInteger(v);
const okParams = (p) => Array.isArray(p) && p.length <= 16 && p.every((v) => Number.isSafeInteger(v) && v >= 0);

/** one identity per question: the same item missed twice is one queue entry */
export const itemKey = (type, params) => `${typeId(type)}:${(params || []).join('.')}`;

/** further along the ladder wins; finished beats unfinished */
const ahead = (a, b) => (!!a.done - !!b.done) || (a.stage - b.stage) || (a.due - b.due);

/** 'drill' | 'holdout' | 'set' (set questions: spaced like drill, never evidence) */
const GROUPS = ['drill', 'holdout', 'set'];
const groupOf = (g) => (GROUPS.includes(g) ? g : 'drill');

/**
 * A queue entry saved by an older build (or damaged storage) → the current
 * shape, or null when it cannot be used (including one that no longer builds
 * into a question, or has a day a review link cannot carry). The key is always
 * recomputed, so an entry saved without one cannot sneak in beside its twin.
 */
function normEntry(raw) {
  if (!isObj(raw)) return null;
  const type = typeId(raw.type);
  if (type < 0 || type >= TYPE_NAMES.length || !okParams(raw.params) || !isDay(raw.due) || raw.due < 0) return null;
  const key = itemKey(type, raw.params);
  if (!buildableKey(key, type, raw.params)) return null;
  const stage = Math.min(REVIEW_DAYS.length - 1, Math.max(0, Number.isInteger(raw.stage) ? raw.stage : 0));
  const tag = toTagIdx(raw.tag ?? 0);
  return {
    ...raw,
    key, type, params: raw.params.slice(),
    tag: Number.isInteger(tag) && tag >= 0 && tag <= MAX_TAG ? tag : 0,
    group: groupOf(raw.group),
    stage, due: raw.due,
    miss: isDay(raw.miss) && raw.miss >= 0 ? raw.miss : Math.max(0, raw.due - REVIEW_DAYS[0]),
    done: isDay(raw.done) ? raw.done : null,
    measured: !!raw.measured, reviews: count(raw.reviews), lapses: count(raw.lapses),
  };
}

/** usable entries, one per key (the copy furthest along the ladder), in their original order */
function normQueue(queue) {
  if (!Array.isArray(queue)) return [];
  const out = [];
  const at = new Map();
  for (const raw of queue) {
    const e = normEntry(raw);
    if (!e) continue;
    const i = at.get(e.key);
    if (i === undefined) {
      at.set(e.key, out.length);
      out.push(e);
    } else if (ahead(e, out[i]) > 0) out[i] = e;
  }
  return out;
}

const tally = (g) => {
  const total = count(g?.total);
  return { right: Math.min(count(g?.right), total), total };
};

/** numbers only: { tagId: n } */
function counts(obj) {
  const out = {};
  if (isObj(obj)) for (const [k, v] of Object.entries(obj)) if (count(v)) out[k] = v;
  return out;
}

/** tolerate states saved by older builds or damaged storage */
function norm(state) {
  const e = emptyState();
  if (!isObj(state)) return e;
  const tags = {};
  if (isObj(state.tags)) for (const [id, t] of Object.entries(state.tags)) tags[id] = { ...(isObj(t) ? t : {}), streak: count(t?.streak) };
  const session = isObj(state.session) ? state.session : {};
  return {
    ...e,
    ...state,
    queue: normQueue(state.queue),
    tags,
    evidence: { drill: tally(state.evidence?.drill), holdout: tally(state.evidence?.holdout) },
    session: { seed: (session.seed >>> 0) || 0, misses: counts(session.misses), shown: counts(session.shown) },
  };
}

// ---------------------------------------------------------------------------
// Recording attempts
// ---------------------------------------------------------------------------

function bumpTag(tags, id, correct) {
  if (!id) return;
  const t = tags[id] || { streak: 0 };
  tags[id] = { ...t, streak: correct ? count(t.streak) + 1 : 0 };
}

/** a review's outcome moves the entry along the 2 / 7 / 21-day ladder */
function reviewed(entry, correct, today) {
  const e = { ...entry, reviews: (entry.reviews || 0) + 1, last: today };
  if (!correct) return { ...e, stage: 0, due: today + REVIEW_DAYS[0], lapses: (entry.lapses || 0) + 1 };
  // Answering before the due day proves less (the memory had less time to
  // fade), so an early correct answer does not move the item on.
  if (today < entry.due) return e;
  if (entry.stage >= REVIEW_DAYS.length - 1) return { ...e, done: today };
  const stage = entry.stage + 1;
  return { ...e, stage, due: today + REVIEW_DAYS[stage] };
}

function newEntry({ key, type, params, tag, group, today }) {
  return {
    key, type, params: params.slice(), tag, group, stage: 0,
    due: today + REVIEW_DAYS[0], miss: today, done: null, measured: false, reviews: 0, lapses: 0,
  };
}

/**
 * Record the FIRST attempt at an item (call once, at Check).
 * `tag` is the diagnosis (when wrong); `target` the misconception the item
 * aimed at (a variant or a review), so a correct answer can count towards it.
 * An item is treated as a review when `review` is true, or when omitted and
 * the item is in the queue and due.
 */
export function recordAttempt(state, { type, params, correct, tag = null, target = null, group = 'drill', today, review }) {
  const s = norm(state);
  const day = toDay(today ?? new Date());
  const key = itemKey(type, params);
  const queue = s.queue.slice();
  const at = queue.findIndex((e) => e.key === key);
  const entry = at >= 0 ? queue[at] : null;
  const isReview = review ?? !!(entry && !entry.done && entry.due <= day);
  const tags = { ...s.tags };
  const misses = { ...s.session.misses };
  const evidence = { drill: { ...s.evidence.drill }, holdout: { ...s.evidence.holdout } };

  const aimed = target || (entry ? tagId(entry.tag) : null);
  if (correct) bumpTag(tags, aimed, true);
  else {
    bumpTag(tags, tag, false);
    if (aimed !== tag) bumpTag(tags, aimed, false);
    // Only a diagnosis is evidence of a misconception: an empty or unclassified
    // answer on an item aimed at a tag is not a second miss of that tag.
    if (tag) misses[tag] = (misses[tag] || 0) + 1;
  }

  if (isReview && entry && !entry.done) {
    let next = reviewed(entry, correct, day);
    // The first review at least a week after the miss is the evidence for
    // drill vs holdout: did full feedback at the time make it stick?
    // Set questions are spaced like drill but never count: their feedback was
    // chosen by the set, not by the practice holdout.
    if (!entry.measured && day - entry.miss >= MEASURE_AFTER) {
      if (entry.group === 'drill' || entry.group === 'holdout') {
        const g = entry.group;
        evidence[g] = { right: evidence[g].right + (correct ? 1 : 0), total: evidence[g].total + 1 };
      }
      next = { ...next, measured: true };
    }
    queue[at] = next;
  } else if (!correct) {
    const tIdx = toTagIdx(tag || aimed);
    const t = typeId(type);
    if (t < 0 || t >= TYPE_NAMES.length) throw new RangeError(`recordAttempt: unknown item type ${type}`);
    // refuse here rather than save something that breaks every later review link
    if (!okParams(params)) throw new RangeError('recordAttempt: params must be encodeParams ints (0 or more)');
    const g = groupOf(group);
    if (entry && !entry.done) {
      // Missed again before it was due: this miss (and the feedback it got
      // now) is what a later review measures, so restart the evidence clock
      // and file it under the group it was just seen in.
      const clock = entry.measured ? {} : { miss: day, group: g };
      queue[at] = { ...entry, ...clock, stage: 0, due: day + REVIEW_DAYS[0], tag: tIdx || entry.tag };
    } else {
      const fresh = newEntry({ key, type: t, params: params || [], tag: tIdx, group: g, today: day });
      if (entry) queue.splice(at, 1);
      queue.push(fresh);
    }
  }
  return { ...s, queue: capQueue(queue), tags, evidence, session: { ...s.session, misses } };
}

/** keep the queue small: drop the oldest finished entries first, then the oldest misses */
function capQueue(queue) {
  if (queue.length <= MAX_QUEUE) return queue;
  const order = queue
    .map((e, i) => ({ e, i }))
    .sort((x, y) => (!!y.e.done - !!x.e.done) || ((x.e.done ?? x.e.miss) - (y.e.done ?? y.e.miss)) || (x.i - y.i));
  const drop = new Set(order.slice(0, queue.length - MAX_QUEUE).map((o) => o.i));
  return queue.filter((_, i) => !drop.has(i));
}

// ---------------------------------------------------------------------------
// Reading the queue
// ---------------------------------------------------------------------------

/** entries due today or earlier, most overdue first */
export function dueEntries(state, today) {
  const day = toDay(today ?? new Date());
  return norm(state).queue
    .filter((e) => !e.done && e.due <= day)
    .sort((a, b) => (a.due - b.due) || (a.miss - b.miss));
}

/** every entry still on the ladder (what a review link carries) */
export function activeEntries(state) {
  return norm(state).queue.filter((e) => !e.done).sort((a, b) => a.due - b.due);
}

export function queueSummary(state, today) {
  const day = toDay(today ?? new Date());
  const active = activeEntries(state);
  const later = active.filter((e) => e.due > day);
  return { due: active.length - later.length, later: later.length, next: later.length ? later[0].due : null };
}

/** stage-based guess at the original miss day, for entries arriving from a link */
function guessMiss(stage, due) {
  let back = REVIEW_DAYS[0];
  for (let s = 1; s <= stage; s++) back += REVIEW_DAYS[s];
  return due - back;
}

/**
 * A review link is untrusted (anyone can send one), and whatever is merged is
 * saved and rebuilt on every visit, so a bad entry would break the review page
 * for good. Keep only params that decode to the very same ints, have a sane
 * width (w drives array sizes: w = 10^9 would hang the tab) and build.
 */
function buildable(type, params) {
  return buildableKey(itemKey(type, params), type, params);
}

// normEntry runs on every read of the state, so remember each key's answer.
const BUILDABLE = new Map();
function buildableKey(key, type, params) {
  if (BUILDABLE.has(key)) return BUILDABLE.get(key);
  const ok = tryBuild(type, params);
  if (BUILDABLE.size >= 2000) BUILDABLE.clear();
  BUILDABLE.set(key, ok);
  return ok;
}

function tryBuild(type, params) {
  const mod = typeById(type);
  if (!mod) return false;
  try {
    const p = mod.decodeParams(params);
    if (p && 'w' in p && !(Number.isInteger(p.w) && p.w >= W_RANGE[0] && p.w <= W_RANGE[1])) return false;
    const again = mod.encodeParams(p);
    if (again.length !== params.length || again.some((v, i) => v !== params[i])) return false;
    mod.build(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Import entries from a review link. An entry already on this device keeps
 * whichever copy is further along the ladder; finished entries stay finished.
 * Entries that cannot be rebuilt into a question are dropped. Importing never
 * removes anything already on the device: once the queue holds MAX_QUEUE
 * entries, the rest are not added and are counted in `skipped`.
 * → { state, added (entries actually kept), skipped (new entries left out because the queue is full) }
 */
export function mergeQueue(state, entries, today) {
  const s = norm(state);
  const queue = s.queue.slice();
  const day = toDay(today ?? new Date());
  let added = 0;
  let skipped = 0;
  for (const raw of Array.isArray(entries) ? entries : []) {
    if (!isObj(raw)) continue;
    const type = typeId(raw.type);
    if (type < 0 || type >= TYPE_NAMES.length || !okParams(raw.params) || !isDay(raw.due) || raw.due < 0) continue;
    const key = itemKey(type, raw.params);
    const stage = Math.min(REVIEW_DAYS.length - 1, Math.max(0, Number.isInteger(raw.stage) ? raw.stage : 0));
    // A real link is made on or before today, when the entry was due at most
    // one interval ahead; a later day is a damaged or doctored link.
    const due = Math.min(raw.due, day + REVIEW_DAYS[stage]);
    const at = queue.findIndex((e) => e.key === key);
    if (at >= 0) {
      const mine = queue[at];
      if (!mine.done && stage > mine.stage) queue[at] = { ...mine, stage, due };
      continue;
    }
    if (!buildable(type, raw.params)) continue;
    if (queue.length >= MAX_QUEUE) { skipped++; continue; }
    const tag = toTagIdx(raw.tag ?? 0);
    const miss = Math.max(0, Math.min(day, guessMiss(stage, due)));
    queue.push({
      key, type, params: raw.params.slice(), tag: Number.isInteger(tag) && tag >= 0 && tag <= MAX_TAG ? tag : 0,
      group: groupOf(raw.group), stage, due, miss,
      done: null, measured: stage >= 2, reviews: 0, lapses: 0,
    });
    added++;
  }
  return { state: { ...s, queue }, added, skipped };
}

// ---------------------------------------------------------------------------
// Fading, sessions and the holdout
// ---------------------------------------------------------------------------

/**
 * Two correct in a row on a misconception: Why starts collapsed (the learner
 * no longer needs it pushed at them). Two misses on it this session: show a
 * worked example before the next variant (more of the same practice is not
 * helping; studying a solution is).
 */
export function fading(state, tag) {
  const s = norm(state);
  const id = typeof tag === 'number' ? tagId(tag) : tag;
  if (!id) return { collapseWhy: false, showWorked: false };
  const misses = s.session.misses[id] || 0;
  return {
    collapseWhy: (s.tags[id]?.streak || 0) >= 2,
    showWorked: misses - (s.session.shown[id] || 0) >= 2,
  };
}

/** call after showing the worked example, so it comes back only after two more misses */
export function noteWorked(state, tag) {
  const s = norm(state);
  const id = typeof tag === 'number' ? tagId(tag) : tag;
  if (!id) return s;
  return { ...s, session: { ...s.session, shown: { ...s.session.shown, [id]: s.session.misses[id] || 0 } } };
}

export function resetSession(state, seed = 0) {
  return { ...norm(state), session: { seed: seed >>> 0, misses: {}, shown: {} } };
}

/**
 * About 15% of practice items get answer-only feedback, decided by the session
 * seed and the item's index so a reload shows the same thing. A hash per item
 * (not a quota per session) keeps every item's chance equal.
 */
export function isHoldout(seed, index) {
  return mulberry32(mixSeed('holdout', seed >>> 0, index))() < HOLDOUT_RATE;
}

/** first-attempt accuracy on reviews ≥ 7 days after the miss, per group */
export function reviewAccuracy(state) {
  const { drill, holdout } = norm(state).evidence;
  return { drill: { ...drill }, holdout: { ...holdout } };
}
