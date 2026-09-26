// The crossover study: does full diagnosis + Why beat seeing the answer?
// Each learner gets full feedback on one family (A = addition, B = shifts) and
// answer-only feedback on the other; which way round is decided by a random
// arm, never chosen. A week later a delayed set tests both families with
// answer-only transfer items. Every learner is their own control, so a class
// of 30 can give a usable answer. This module holds the arms and the
// statistics; board.js does the counting.
import { mulberry32, mixSeed } from '../lib/rng.js';
import { decodeToken, ARM_UNKNOWN, ARM_NONE } from '../lib/codec.js';
import { specsForLevel } from './spec.js';

export { ARM_UNKNOWN, ARM_NONE };
export const FAMILY_TOPIC = { A: 'add', B: 'shift' };
export const FAMILIES = ['A', 'B'];

// GCSE spec points are the defaults: every level can do them.
const DEFAULT_SPECS = { A: 'J277-1.2.4-add', B: 'J277-1.2.4-shift' };

/** 'A' for addition, 'B' for shifts, null for anything else */
export function familyOf(topicOrType) {
  if (topicOrType === 'add') return 'A';
  if (topicOrType === 'shift') return 'B';
  return null;
}

/** the spec point each family practises at a level (GCSE's when the level has none) */
export function studySpecs(level) {
  const specs = specsForLevel(level);
  const find = (topic, fallback) => specs.find((s) => s.topic === topic)?.id || fallback;
  return { A: find(FAMILY_TOPIC.A, DEFAULT_SPECS.A), B: find(FAMILY_TOPIC.B, DEFAULT_SPECS.B) };
}

/** arm from a per-learner random seed (the UI draws it with newSeed() and stores the arm) */
export function assignArm(seed) {
  return mulberry32(mixSeed('arm', seed >>> 0))() < 0.5 ? 0 : 1;
}

/** the family that gets full feedback in an arm */
export const drillFamily = (arm) => (arm === 0 ? 'A' : arm === 1 ? 'B' : null);

/**
 * Arm 0: full on A, answer-only on B. Arm 1: the reverse. Delayed sets are a
 * test, so everyone gets answer-only. Outside the study, full feedback.
 */
export function feedbackFor(arm, family, mode = 'study') {
  if (mode === 'delayed') return 'answerOnly';
  if (mode !== 'study' || (arm !== 0 && arm !== 1) || !FAMILIES.includes(family)) return 'full';
  return drillFamily(arm) === family ? 'full' : 'answerOnly';
}

/**
 * recover a learner's arm from last week's study-set result code. Only a code
 * from the linked study set counts: accepting any study code would let a
 * learner (or a friend's code) pick the group.
 */
export function recoverArm(tokenString, studySetId) {
  if (!(Number.isInteger(studySetId) && studySetId >= 0 && studySetId <= 0x3ff)) {
    return { arm: null, error: 'This set is not linked to a study set, so your group cannot be found from a code. Carry on without it.' };
  }
  const t = decodeToken(tokenString);
  if (t.error) return { arm: null, error: t.error };
  if (t.mode !== 'study') return { arm: null, error: 'That result code is not from a study set. Paste the code you got at the end of last week\'s set.' };
  if (t.setId !== studySetId) {
    return { arm: null, error: 'That result code is from a different set. Paste the code from the set this one follows.' };
  }
  if (t.arm !== 0 && t.arm !== 1) return { arm: null, error: 'That result code does not say which group you were in, so carry on without it.' };
  return { arm: t.arm };
}

// ---------------------------------------------------------------------------
// Statistics: paired differences with a t-based 95% confidence interval
// ---------------------------------------------------------------------------

/** log Γ(x) (Lanczos, g = 7) */
function lgamma(x) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  const z = x - 1;
  let a = c[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** continued fraction for the incomplete beta function (Numerical Recipes betacf) */
function betacf(a, b, x) {
  const TINY = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return h;
}

/** regularised incomplete beta I_x(a, b) */
function ibeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betacf(a, b, x)) / a : 1 - (front * betacf(b, a, 1 - x)) / b;
}

/** P(T ≤ t) for Student's t with df degrees of freedom */
export function tCdf(t, df) {
  const tail = 0.5 * ibeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

/** the t value with P(T ≤ t) = p (bisection: slow but exact enough, and called rarely) */
export function tQuantile(p, df) {
  if (!(p > 0 && p < 1) || !(df > 0)) return NaN;
  if (p < 0.5) return -tQuantile(1 - p, df);
  let lo = 0;
  let hi = 1;
  while (tCdf(hi, df) < p) hi *= 2;
  for (let i = 0; i < 200 && hi - lo > 1e-12; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** the pre-registered reading of a standardised paired effect */
export function readingFor(dz) {
  if (dz === null || !Number.isFinite(dz)) return null;
  if (dz >= 0.3) return 'invest';
  if (dz < 0.1) return 'stop';
  return 'replicate';
}

// Below this many learners dz is too noisy to act on (its standard error is
// about 1/√n), so no reading is given, only the numbers.
export const MIN_READING_N = 10;
// Scores are fractions of at most 15 questions, so real spread is never
// below ~0.002; anything under this is rounding noise in "equal" values
// (0.6 − 0.2 ≠ 0.8 − 0.4 in floating point), not information.
const SD_EPS = 1e-9;

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const sumSq = (xs, m) => xs.reduce((s, x) => s + (x - m) ** 2, 0);

/** the common result shape; noInterval says why lo/hi are missing ('tooFew' | 'noSpread' | 'oneArm') */
function statsOut(n, m, rawSd, se, df) {
  const base = { n, mean: m, sd: null, se: null, df, lo: null, hi: null, dz: null, reading: null };
  if (df < 1 || rawSd === null) return { ...base, df: Math.max(0, df), noInterval: 'tooFew' };
  const sd = rawSd < SD_EPS ? 0 : rawSd;
  // Everyone's difference was identical: a zero-width interval would claim
  // certainty that a handful of learners cannot give, so none is shown.
  if (!sd) return { ...base, sd: 0, se: 0, noInterval: 'noSpread' };
  const t = tQuantile(0.975, df);
  const dz = m / sd;
  return {
    n, mean: m, sd, se, df, lo: m - t * se, hi: m + t * se, dz,
    reading: n >= MIN_READING_N ? readingFor(dz) : null, noInterval: null,
  };
}

/**
 * Mean of paired differences with a 95% t interval. dz = mean / sd is the
 * standardised effect for paired designs; the interval needs n ≥ 2.
 */
export function pairedStats(diffs) {
  const n = diffs.length;
  if (!n) return null;
  const m = mean(diffs);
  if (n < 2) return statsOut(n, m, null, null, 0);
  const sd = Math.sqrt(sumSq(diffs, m) / (n - 1));
  return statsOut(n, m, sd, (sd < SD_EPS ? 0 : sd) / Math.sqrt(n), n - 1);
}

/**
 * The AB/BA crossover estimate from each arm's (drill − answer-only)
 * differences. Arm 0 drills addition, arm 1 shifts, so a family that is
 * simply easier pushes the two arms' differences in opposite directions;
 * averaging the two arm means cancels it, whatever the arm sizes. (Pooling
 * all differences instead is biased whenever the arms are unequal, and its
 * spread and dz are inflated by the family gap.) sd is the pooled within-arm
 * SD, df = n − 2, se = sd·√(1/n₀ + 1/n₁)/2. With one arm empty, feedback and
 * family cannot be told apart: the plain mean is returned with no interval.
 */
export function crossoverStats(d0, d1) {
  const n0 = d0.length;
  const n1 = d1.length;
  const n = n0 + n1;
  if (!n) return null;
  if (!n0 || !n1) {
    const all = [...d0, ...d1];
    return { ...statsOut(n, mean(all), null, null, 0), noInterval: 'oneArm' };
  }
  const m0 = mean(d0);
  const m1 = mean(d1);
  const est = (m0 + m1) / 2;
  const df = n - 2;
  if (df < 1) return statsOut(n, est, null, null, df);
  const sd = Math.sqrt((sumSq(d0, m0) + sumSq(d1, m1)) / df);
  return statsOut(n, est, sd, ((sd < SD_EPS ? 0 : sd) * Math.sqrt(1 / n0 + 1 / n1)) / 2, df);
}
