// A set (homework or study) is a plan of n slots derived only from the set
// code, so every learner who opens the same link gets the same questions and
// the teacher's board compares like with like. The learner's arm is the one
// per-learner input (study sets only).
import { mulberry32, mixSeed, shuffle } from '../lib/rng.js';
import { ARM_NONE, ARM_UNKNOWN } from '../lib/codec.js';
import { SPECS, specsForLevel } from './spec.js';
import { studySpecs, feedbackFor } from './study.js';
import { HOLDOUT_RATE } from './scheduler.js';

/** how many answer-only slots a normal set of n gets: about 15%, at least one */
export const holdoutCount = (n) => Math.max(1, Math.round(n * HOLDOUT_RATE));

/**
 * spec points for the chosen topics at the level; falls back so a set is
 * never empty (an empty list would make interleave() loop for ever)
 */
function setSpecs(level, topics) {
  const want = (s) => topics.includes(s.topic);
  const atLevel = specsForLevel(level).filter(want);
  if (atLevel.length) return atLevel;
  const anyLevel = SPECS.filter(want);
  if (anyLevel.length) return anyLevel;
  const all = specsForLevel(level);
  return all.length ? all : specsForLevel('gcse');
}

/**
 * Interleave spec points: each round visits every point once in a fresh
 * order, and a round never starts with the point the last one ended on
 * (mixing topics makes learners choose the method, which helps it stick).
 */
function interleave(rng, specs, n) {
  const out = [];
  while (out.length < n) {
    const round = shuffle(rng, specs);
    if (out.length && round.length > 1 && round[0] === out[out.length - 1]) round.push(round.shift());
    out.push(...round);
  }
  return out.slice(0, n);
}

const groupOf = (feedback) => (feedback === 'full' ? 'drill' : 'holdout');

function planNormal(set, rng) {
  const specs = setSpecs(set.level, Array.isArray(set.topics) ? set.topics : []);
  const order = interleave(rng, specs, set.n);
  // Holdout slots never come first: the opening question should show the full loop.
  const holdouts = new Set(shuffle(rng, [...Array(set.n - 1).keys()].map((i) => i + 1)).slice(0, holdoutCount(set.n)));
  return order.map((spec, i) => {
    const feedback = holdouts.has(i) ? 'answerOnly' : 'full';
    return { i, spec: spec.id, family: null, group: groupOf(feedback), feedback, seed: mixSeed('item', set.seed, i) };
  });
}

function planStudy(set, rng, arm) {
  const ids = studySpecs(set.level);
  const delayed = set.mode === 'delayed';
  if (!delayed && arm !== 0 && arm !== 1) throw new TypeError('planSet: a study set needs the learner\'s arm (0 or 1)');
  const first = rng() < 0.5 ? 'A' : 'B';
  const second = first === 'A' ? 'B' : 'A';
  return Array.from({ length: set.n }, (_, i) => {
    const family = i % 2 ? second : first;
    const feedback = feedbackFor(arm, family, set.mode);
    // Delayed sets test transfer: same spec points, new values (a different seed stream).
    const seed = mixSeed(delayed ? 'transfer' : 'item', set.seed, i);
    return { i, spec: ids[family], family, group: groupOf(feedback), feedback, seed };
  });
}

/** set = decodeSet(code); arm is needed for study sets only */
export function planSet(set, { arm } = {}) {
  // decodeSet guarantees 5–15; a hand-made set must still fit a result token (≤ 15 per group)
  if (!set || !Number.isInteger(set.n) || set.n < 1 || set.n > 15) throw new RangeError('planSet: a set has 1–15 questions');
  const rng = mulberry32(mixSeed('plan', set.seed, set.mode, set.level, set.n));
  return set.mode === 'study' || set.mode === 'delayed' ? planStudy(set, rng, arm) : planNormal(set, rng);
}

/**
 * the three most frequent misconceptions among first-attempt misses (ties: the
 * one met first). 'other' (wrong, but no named misconception) is left out, so it
 * never takes a slot a real misconception could use.
 */
function topTags(results) {
  const counts = new Map();
  results.forEach((r) => {
    if (r && !r.correct && r.tag && r.tag !== 'other') counts.set(r.tag, (counts.get(r.tag) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
}

/**
 * First-attempt results → the fields of a result token. g1/g2 are family A/B
 * in study and delayed sets, drill/holdout slots in normal sets.
 * results[i] = { correct, tag } for slot i, or null if it was not answered.
 */
export function summarizeSet(results, plan, { setId, mode, arm }) {
  const g1 = { right: 0, total: 0 };
  const g2 = { right: 0, total: 0 };
  const res = Array.isArray(results) ? results : [];
  plan.forEach((slot, i) => {
    const r = res[i];
    if (!r) return;
    const inSecond = mode === 'normal' ? slot.group === 'holdout' : slot.family === 'B';
    const g = inSecond ? g2 : g1;
    g.total++;
    if (r.correct) g.right++;
  });
  const a = mode === 'normal' ? ARM_NONE : (arm === 0 || arm === 1 ? arm : ARM_UNKNOWN);
  return { setId, mode, g1, g2, arm: a, tags: topTags(res.slice(0, plan.length)) };
}
