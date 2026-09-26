// Everything that travels by copy-and-paste: set codes (teacher → class), result
// tokens (learner → teacher) and review queues (learner → their own bookmark).
// No server exists, so these codes ARE the data channel. They use Crockford
// base32 (no I L O U, case-insensitive) because people read them off
// projectors and retype them, and every one carries a CRC so a mistyped or
// truncated code is refused instead of silently becoming someone else's data.
import { hashStr } from './rng.js';
import { tagIndex, tagId } from '../learn/tagids.js';

export const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const B32_VALUE = new Map([...B32].map((c, i) => [c, i]));

// Fixed orders: codes store the index, so never reorder (only append).
export const LEVELS = ['gcse', 'alevel', 'csapp'];
export const TOPIC_ORDER = ['add', 'shift', 'twos', 'sadd', 'fa', 'c'];   // same as spec.js TOPICS
export const MODES = ['normal', 'study', 'delayed'];
export const ARM_UNKNOWN = 2;          // a study token whose arm could not be recovered
export const ARM_NONE = 3;             // not a study set

// ---------------------------------------------------------------------------
// Base32
// ---------------------------------------------------------------------------

/** canonical form: upper case, no separators, I/L → 1 and O → 0 (Crockford's aliases) */
export function normB32(str) {
  return String(str ?? '').toUpperCase().replace(/[\s-]+/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
}

/** the first character that is not a base32 digit (after normalising), or null */
export function badB32Char(canon) {
  for (const c of canon) if (!B32_VALUE.has(c)) return c;
  return null;
}

/**
 * Pasted text can be anything (a whole essay, a megabyte of junk). Anything
 * far longer than the longest real code is refused before it is normalised,
 * so decoding stays fast whatever arrives.
 */
const tooLong = (str, max) => String(str ?? '').length > max;

/** bits (MSB-first, length a multiple of 5) → base32 string */
export function toB32(bits) {
  if (bits.length % 5) throw new RangeError('toB32: bit count must be a multiple of 5');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    out += B32[bits[i] * 16 + bits[i + 1] * 8 + bits[i + 2] * 4 + bits[i + 3] * 2 + bits[i + 4]];
  }
  return out;
}

/** base32 (any case, separators allowed) → bits, or null when a character is not base32 */
export function fromB32(str) {
  const canon = normB32(str);
  const bits = new Array(canon.length * 5);
  for (let i = 0; i < canon.length; i++) {
    const v = B32_VALUE.get(canon[i]);
    if (v === undefined) return null;
    for (let k = 0; k < 5; k++) bits[i * 5 + k] = (v >> (4 - k)) & 1;
  }
  return bits;
}

/** 'ABCDEFGHJKMN' → 'ABCD-EFGH-JKMN' */
export const group4 = (canon) => canon.match(/.{1,4}/g)?.join('-') ?? '';

// ---------------------------------------------------------------------------
// Bit packing
// ---------------------------------------------------------------------------

/** Writes unsigned integers MSB-first into a plain bit array. */
export class BitWriter {
  constructor() { this.bits = []; }
  get length() { return this.bits.length; }
  /** n ≤ 53 bits; arithmetic (not bitwise) so values above 2^31 survive */
  put(value, n) {
    if (!Number.isInteger(value) || value < 0 || value >= 2 ** n) throw new RangeError(`BitWriter: ${value} does not fit in ${n} bits`);
    for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(value / 2 ** i) % 2);
    return this;
  }
  /** variable length: 4-bit chunks, low chunk first, each led by a "more follows" bit */
  varuint(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`BitWriter: ${value} is not a non-negative integer`);
    let v = value;
    do {
      const chunk = v % 16;
      v = Math.floor(v / 16);
      this.put(v > 0 ? 1 : 0, 1);
      this.put(chunk, 4);
    } while (v > 0);
    return this;
  }
}

/** Reads what BitWriter wrote; take() past the end throws (callers turn that into a friendly error). */
export class BitReader {
  constructor(bits) { this.bits = bits; this.pos = 0; }
  get left() { return this.bits.length - this.pos; }
  take(n) {
    if (n > this.left) throw new RangeError('BitReader: ran out of bits');
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bits[this.pos++];
    return v;
  }
  varuint() {
    let v = 0;
    let scale = 1;
    for (let guard = 0; guard < 14; guard++) {            // 14 chunks = 56 bits, beyond any value we write
      const more = this.take(1);
      v += this.take(4) * scale;
      scale *= 16;
      // past 2^53 the sum is no longer exact: refuse rather than return a nearby number
      if (!Number.isSafeInteger(v)) break;
      if (!more) return v;
    }
    throw new RangeError('BitReader: number too long');
  }
}

// ---------------------------------------------------------------------------
// CRC
// ---------------------------------------------------------------------------

// CRC-13 (x^13+x^12+x^11+x^10+x^7+x^6+x^5+x^4+x^2+1). Any degree-13 generator
// with a constant term catches every error burst of ≤ 13 bits. One mistyped
// base32 character flips ≤ 5 adjacent bits and one swap of neighbours ≤ 10,
// so both are always caught (tests/12-state.test.mjs checks it exhaustively).
export const CRC13_POLY = 0x1cf5;
const CRC_INIT = 0x1fff;      // non-zero start: an all-zero code is never valid

/** bitwise CRC over a bit array, MSB-first; returns an int of `width` bits */
export function crcBits(bits, width = 13, poly = CRC13_POLY, init = CRC_INIT) {
  const top = 2 ** (width - 1);
  const mask = 2 ** width - 1;
  let r = init & mask;
  for (const b of bits) {
    const feedback = (r & top ? 1 : 0) ^ b;
    r = (r * 2) & mask;
    if (feedback) r ^= poly;
  }
  return r;
}

/** append a CRC-13 so the total length is a whole number of base32 characters */
function sealBits(w) {
  while ((w.length + 13) % 5) w.put(0, 1);
  const crc = crcBits(w.bits);
  w.put(crc, 13);
  return toB32(w.bits);
}

/** split sealed bits → data bits, or null when the CRC does not match */
function openBits(bits) {
  if (!bits || bits.length < 13) return null;
  const data = bits.slice(0, bits.length - 13);
  const got = new BitReader(bits.slice(bits.length - 13)).take(13);
  return crcBits(data) === got ? data : null;
}

// ---------------------------------------------------------------------------
// Set codes (#/set/<code>): teacher → class
// ---------------------------------------------------------------------------
// 70 bits = 14 chars: version 2 · level 2 · topics 6 · n 4 · mode 2 ·
// has-link 1 · link 10 · seed 30 · CRC-13.
const SET_VERSION = 1;
const SET_CHARS = 14;
const SEED_BITS = 30;

export const setIdOf = (code) => hashStr(normB32(code)) & 0x3ff;

export function encodeSet({ level, topics, n, seed, mode = 'normal', link = null }) {
  const lv = LEVELS.indexOf(level);
  const md = MODES.indexOf(mode);
  if (topics !== undefined && topics !== null && !Array.isArray(topics)) throw new RangeError('encodeSet: topics must be an array of topic names');
  const mask = (topics || []).reduce((m, t) => {
    const i = TOPIC_ORDER.indexOf(t);
    if (i < 0) throw new RangeError(`encodeSet: unknown topic ${t}`);
    return m | (1 << i);
  }, 0);
  if (lv < 0) throw new RangeError(`encodeSet: unknown level ${level}`);
  if (md < 0) throw new RangeError(`encodeSet: unknown mode ${mode}`);
  if (!mask) throw new RangeError('encodeSet: choose at least one topic');
  if (!Number.isInteger(n) || n < 5 || n > 15) throw new RangeError('encodeSet: n must be 5–15');
  const hasLink = link !== null && link !== undefined;
  if (hasLink && !(Number.isInteger(link) && link >= 0 && link <= 0x3ff)) throw new RangeError('encodeSet: link must be a setId (0–1023)');
  const w = new BitWriter()
    .put(SET_VERSION, 2).put(lv, 2).put(mask, 6).put(n, 4).put(md, 2)
    .put(hasLink ? 1 : 0, 1).put(hasLink ? link : 0, 10)
    .put((seed >>> 0) % 2 ** SEED_BITS, SEED_BITS);
  return sealBits(w);
}

const SET_HELP = 'Ask your teacher for the link again, or copy the whole link in one go.';

export function decodeSet(code) {
  if (tooLong(code, 200)) throw new Error(`This set code is too long, so it is probably not a set code. ${SET_HELP}`);
  const canon = normB32(code);
  if (!canon) throw new Error(`This set link has no code in it. ${SET_HELP}`);
  const bad = badB32Char(canon);
  if (bad) throw new Error(`This set code contains "${bad}", which set codes never use. ${SET_HELP}`);
  if (canon.length !== SET_CHARS) throw new Error(`This set code is ${canon.length < SET_CHARS ? 'too short' : 'too long'}, so part of it may be missing. ${SET_HELP}`);
  const data = openBits(fromB32(canon));
  if (!data) throw new Error(`This set code has a mistyped character. ${SET_HELP}`);
  const r = new BitReader(data);
  const v = r.take(2);
  const lv = r.take(2), mask = r.take(6), n = r.take(4), md = r.take(2);
  const hasLink = r.take(1), link = r.take(10), seed = r.take(SEED_BITS);
  if (v !== SET_VERSION) throw new Error('This set was made by a different version of Predict the Machine. Ask your teacher for a new link.');
  if (!LEVELS[lv] || !MODES[md] || !mask || n < 5 || (!hasLink && link)) throw new Error(`This set code does not make sense. ${SET_HELP}`);
  return {
    v, level: LEVELS[lv], topics: TOPIC_ORDER.filter((_, i) => mask & (1 << i)), n, seed,
    mode: MODES[md], link: hasLink ? link : null, setId: setIdOf(canon), code: canon,
  };
}

// ---------------------------------------------------------------------------
// Result tokens: learner → teacher
// ---------------------------------------------------------------------------
// 60 bits = 12 chars: version 2 · setId 10 · mode 2 · g1 right 4 · g1 total 4 ·
// g2 right 4 · g2 total 4 · arm 2 · 3 tag indices × 5 · CRC-13 over the 47 data bits.
const TOKEN_VERSION = 1;
const TOKEN_CHARS = 12;

const OTHER = tagIndex('other');

/**
 * tag id or index → index. A misconception id this build does not know is
 * still a misconception, so it is counted as 'other' rather than dropped
 * (dropping it would under-report on the teacher's board).
 */
function toTagIndex(t) {
  if (typeof t === 'number') return t;
  if (t === null || t === undefined || t === '') return 0;
  return tagIndex(t) || OTHER;
}

function checkGroup(g, name) {
  const { right, total } = g || {};
  if (!Number.isInteger(total) || total < 0 || total > 15) throw new RangeError(`encodeToken: ${name}.total must be 0–15`);
  if (!Number.isInteger(right) || right < 0 || right > total) throw new RangeError(`encodeToken: ${name}.right must be 0–${name}.total`);
  return g;
}

export function encodeToken({ setId, mode = 'normal', g1, g2, arm, tags = [] }) {
  const md = MODES.indexOf(mode);
  if (md < 0) throw new RangeError(`encodeToken: unknown mode ${mode}`);
  if (!Number.isInteger(setId) || setId < 0 || setId > 0x3ff) throw new RangeError('encodeToken: setId must be 0–1023');
  checkGroup(g1, 'g1');
  checkGroup(g2, 'g2');
  const a = mode === 'normal' ? ARM_NONE : (arm === 0 || arm === 1 ? arm : ARM_UNKNOWN);
  const idx = [...new Set((tags || []).map(toTagIndex).filter((i) => i > 0))].slice(0, 3);
  if (idx.some((i) => !Number.isInteger(i) || i > 31)) throw new RangeError('encodeToken: tag index out of range');
  while (idx.length < 3) idx.push(0);
  const w = new BitWriter()
    .put(TOKEN_VERSION, 2).put(setId, 10).put(md, 2)
    .put(g1.right, 4).put(g1.total, 4).put(g2.right, 4).put(g2.total, 4)
    .put(a, 2);
  for (const i of idx) w.put(i, 5);
  return group4(sealBits(w));
}

export function decodeToken(str) {
  if (tooLong(str, 200)) return { error: 'A result code has 12 characters; this is much longer.' };
  const canon = normB32(str);
  if (!canon) return { error: 'This line has no result code in it.' };
  const bad = badB32Char(canon);
  if (bad) return { error: `"${bad}" is never used in result codes.` };
  if (canon.length !== TOKEN_CHARS) return { error: `A result code has 12 characters; this one has ${canon.length}.` };
  const data = openBits(fromB32(canon));
  if (!data) return { error: 'This code has a mistyped or swapped character.' };
  const r = new BitReader(data);
  const v = r.take(2), setId = r.take(10), md = r.take(2);
  const g1 = { right: r.take(4), total: r.take(4) };
  const g2 = { right: r.take(4), total: r.take(4) };
  const arm = r.take(2);
  const idx = [r.take(5), r.take(5), r.take(5)];
  if (v !== TOKEN_VERSION) return { error: 'This code comes from a different version of Predict the Machine.' };
  const mode = MODES[md];
  const armOk = mode === 'normal' ? arm === ARM_NONE : arm !== ARM_NONE;
  // encodeToken writes distinct tags first and zeros after; anything else was not made by it
  const tagsOk = idx.every((t, k) => (t ? !idx.slice(0, k).includes(t) : idx.slice(k).every((u) => !u)));
  if (!mode || g1.right > g1.total || g2.right > g2.total || !armOk || !tagsOk) return { error: 'This code does not make sense.' };
  const right = g1.right + g2.right;
  const total = g1.total + g2.total;
  return {
    v, setId, mode, g1, g2, arm,
    tags: idx.map(tagId).filter(Boolean),
    right, total, score: total ? right / total : null,
    code: group4(canon),
  };
}

// ---------------------------------------------------------------------------
// Review queues (#/review/<q>): a learner's reviews, so a bookmark can bring
// them back when the device forgets (shared Chromebooks, private windows).
// ---------------------------------------------------------------------------
// varuint stream: version · count · base day, then per entry: type ·
// (stage·2 + holdout) · tag · due − base · param count · params…; CRC-13 at the end.
const QUEUE_VERSION = 1;
const QUEUE_MAX = 200;
const MAX_PARAMS = 16;
const MAX_TYPE_ID = 5;
const MAX_STAGE = 2;
// Far above any real queue (60 entries ≈ 1,000 characters), and small enough
// that a pasted megabyte is refused before any work is done on it.
export const QUEUE_MAX_CHARS = 20000;

const QUEUE_HELP = 'Copy the whole review link again.';

/** refuse (loudly) anything decodeQueue would refuse, so a link that encodes always decodes */
function checkEntry(e) {
  const { type, due } = e;
  const stage = e.stage ?? 0;
  const tag = toTagIndex(e.tag ?? 0);
  if (!Number.isInteger(type) || type < 0 || type > MAX_TYPE_ID) throw new RangeError(`encodeQueue: type must be a TYPE_ID 0–${MAX_TYPE_ID}`);
  if (!Number.isInteger(stage) || stage < 0 || stage > MAX_STAGE) throw new RangeError(`encodeQueue: stage must be 0–${MAX_STAGE}`);
  if (!Number.isInteger(tag) || tag < 0 || tag > 31) throw new RangeError('encodeQueue: tag index must be 0–31');
  if (!Number.isSafeInteger(due) || due < 0) throw new RangeError('encodeQueue: due must be a day number');
  if ((e.params || []).length > MAX_PARAMS) throw new RangeError('encodeQueue: too many params');
  return tag;
}

export function encodeQueue(entries) {
  const list = entries || [];
  if (list.length > QUEUE_MAX) throw new RangeError(`encodeQueue: at most ${QUEUE_MAX} entries`);
  const tags = list.map(checkEntry);
  const base = list.length ? Math.min(...list.map((e) => e.due)) : 0;
  const w = new BitWriter().varuint(QUEUE_VERSION).varuint(list.length).varuint(base);
  list.forEach((e, i) => {
    const params = e.params || [];
    w.varuint(e.type).varuint((e.stage ?? 0) * 2 + (e.group === 'holdout' ? 1 : 0))
      .varuint(tags[i]).varuint(e.due - base).varuint(params.length);
    for (const p of params) w.varuint(p);
  });
  const out = sealBits(w);
  if (out.length > QUEUE_MAX_CHARS) throw new RangeError('encodeQueue: the queue is too long for a link');
  return out;
}

export function decodeQueue(q) {
  if (tooLong(q, 2 * QUEUE_MAX_CHARS)) throw new Error(`This review link is far too long to be one of ours. ${QUEUE_HELP}`);
  const canon = normB32(q);
  if (canon.length > QUEUE_MAX_CHARS) throw new Error(`This review link is far too long to be one of ours. ${QUEUE_HELP}`);
  if (!canon) return [];
  if (badB32Char(canon)) throw new Error(`This review link has been changed or cut short. ${QUEUE_HELP}`);
  const data = openBits(fromB32(canon));
  if (!data) throw new Error(`This review link has been changed or cut short. ${QUEUE_HELP}`);
  try {
    const r = new BitReader(data);
    if (r.varuint() !== QUEUE_VERSION) throw new Error('version');
    const count = r.varuint();
    const base = r.varuint();
    if (count > QUEUE_MAX) throw new Error('count');
    const out = [];
    for (let i = 0; i < count; i++) {
      const type = r.varuint();
      const flags = r.varuint();
      const tag = r.varuint();
      const due = base + r.varuint();
      const np = r.varuint();
      if (type > MAX_TYPE_ID || flags > MAX_STAGE * 2 + 1 || tag > 31 || np > MAX_PARAMS || !Number.isSafeInteger(due)) throw new Error('range');
      const params = [];
      for (let k = 0; k < np; k++) params.push(r.varuint());
      out.push({ type, params, tag, due, stage: flags >> 1, group: flags & 1 ? 'holdout' : 'drill' });
    }
    // only zero padding (< 1 char) may follow the entries
    if (r.left >= 5 || r.take(r.left) !== 0) throw new Error('trailing');
    return out;
  } catch {
    throw new Error(`This review link was made by a different version or has been damaged. ${QUEUE_HELP}`);
  }
}
