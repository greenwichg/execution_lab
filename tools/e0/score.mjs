#!/usr/bin/env node
// E0 desk study, step 2: a FIRST-PASS automatic score for free-tier LLM replies.
//
//   node tools/e0/score.mjs responses.csv [--items e0-items.jsonl] [--out dir]
//                           [--rater rater.csv]... [--seed N] [--force-sample]
//
// responses.csv needs the columns id, model, response (e0-scoring.csv from
// generate.mjs, filled in, works as it is). Each reply is scored against the
// item's key in e0-items.jsonl:
//   answer_ok        the reply gives the right value of every part the student
//                    got wrong (bit pattern, number, overflow yes/no, flags)
//   column_ok        the reply puts the first error in the right column / bit /
//                    step (for C: the line or its operation)
//   misconception_ok the reply names the misconception (keyword rules per tag)
// These are keyword and pattern rules, so they are a first pass only: a second
// human rater scores a random 20% (e0-rater-sample.csv), we report Cohen's kappa
// between the rules and the rater, and where they disagree a human decides.
// Human scores (from --rater files) replace the automatic ones row by row.
//
// Output: a report (stdout + e0-report.txt) with per-model rates, Wilson 95%
// intervals and the pre-registered E0 rule applied; e0-scored.csv; and, when a
// rater file is given, e0-disagreements.csv. This file has no dependencies and
// never touches the network.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const E0_THRESHOLD = 0.95;
export const SAMPLE_FRACTION = 0.2;
export const CRITERIA = ['answer_ok', 'column_ok', 'misconception_ok'];

// ---------------------------------------------------------------------------
// CSV (RFC 4180: quotes, doubled quotes, embedded newlines, CRLF, BOM)
// ---------------------------------------------------------------------------

export function parseCsv(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === '') { quoted = true; i++; continue; }
    if (ch === ',') { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(cell); rows.push(row); row = []; cell = '';
      i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    cell += ch; i++;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

/** rows (arrays) → CSV text with CRLF line ends, quoting only when needed */
export function toCsv(rows) {
  const q = (v) => {
    const t = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
}

/** a free-text cell that a spreadsheet must not run as a formula */
export const safeCell = (t) => (/^[=+\-@]/.test(String(t ?? '')) ? `'${t}` : String(t ?? ''));

/** CSV text → [{ header: value }], headers trimmed and lower-cased */
export function readTable(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, j) => [h, r[j] ?? ''])));
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** Wilson score interval for k successes in n trials (z = 1.96 → 95%) */
export function wilson(k, n, z = 1.96) {
  if (!n) return { k, n, p: null, lo: null, hi: null };
  const p = k / n;
  const z2 = z * z;
  const den = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return { k, n, p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/** Cohen's kappa for two raters' yes/no calls: pairs = [[a, b], …] */
export function cohenKappa(pairs) {
  const n = pairs.length;
  if (!n) return { n, po: null, pe: null, kappa: null };
  let agree = 0;
  let aYes = 0;
  let bYes = 0;
  for (const [a, b] of pairs) {
    if (!!a === !!b) agree++;
    if (a) aYes++;
    if (b) bYes++;
  }
  const po = agree / n;
  const pe = (aYes / n) * (bYes / n) + (1 - aYes / n) * (1 - bYes / n);
  // Both raters gave one constant answer: agreement is total but kappa is undefined.
  const kappa = pe === 1 ? null : (po - pe) / (1 - pe);
  return { n, po, pe, kappa };
}

/** seeded PRNG (mulberry32), so the rater sample is reproducible */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** a random 20% (rounded up) of each model's rows, models interleaved so a rater can work blind */
export function raterSample(rows, { fraction = SAMPLE_FRACTION, seed = 1 } = {}) {
  const rng = mulberry32(seed);
  const byModel = new Map();
  for (const r of rows) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push(r);
  }
  const chosen = new Set();
  for (const list of byModel.values()) {
    const idx = list.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    for (const i of idx.slice(0, Math.ceil(list.length * fraction))) chosen.add(list[i]);
  }
  const picked = rows.filter((r) => chosen.has(r));
  for (let i = picked.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [picked[i], picked[j]] = [picked[j], picked[i]]; }
  return picked;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** plain text: one minus sign, no markdown/LaTeX decoration, no base subscripts */
export function normalise(s) {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[−‒–‐‑﹣－]/g, '-')
    .replace(/[‘’ʼ′]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[    ]/g, ' ')
    .replace(/\\(?:text|mathrm|mathbf|texttt|textbf|operatorname)\{([^}]*)\}/g, '$1')
    .replace(/\\times/g, '×').replace(/\\(?:rightarrow|to|Rightarrow)\b/g, '→')
    .replace(/\\oplus/g, ' XOR ').replace(/\\lor/g, ' OR ').replace(/\\div/g, '÷')
    .replace(/\\[()[\]]/g, ' ')
    .replace(/(\d)\s*_\{?(?:2|10)\}?(?![\d{])/g, '$1')            // 1010_2, 1010_{2}
    .replace(/(\d)\s*\((?:2|10|base 2|base 10)\)/g, '$1')           // 1010(2)
    .replace(/[₀-₉]+/g, '')                               // 1010₂
    .replace(/\^\{([^}]*)\}/g, '^$1')
    .replace(/[⁰¹²³⁴-⁹]+/g, (m) => `^${[...m].map((c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(c)).join('')}`)
    .replace(/\*\*|__/g, '')
    .replace(/[`$]/g, ' ')
    .replace(/\*/g, ' * ')
    .replace(/[ \t]+/g, ' ');
}

/** sentences with the line (paragraph) each came from */
export function sentences(text) {
  const out = [];
  normalise(text).split('\n').forEach((line, li) => {
    for (const part of line.split(/(?<=[.!?;])\s+/)) if (part.trim()) out.push({ text: part.trim(), line: li });
  });
  return out;
}

// A sentence that says something is wrong ("should be", "you wrote … but",
// "✗"). Location mentions only count inside such sentences, so a reply that
// walks through every column is not credited for naming them all.
const ERR = /\b(?:wrong|mistakes?|errors?|incorrect(?:ly)?|should(?:n'?t| not)?|instead|rather than|forg[eo]t(?:ten)?|forgetting|missed|missing|dropped|slip(?:ped)?|problems?|issues?|actually|oops|off by|culprit|went wrong|goes wrong|needs? to be|ought to|careful|you (?:wrote|put|have|had|got|gave|said|used|treated|did|made|added|placed|kept|filled|shifted|moved|read|counted|took|left|ignored|assumed|thought|expected|compared|rounded|predicted|answered|claimed|stopped|skipped|flipped|inverted|forgot|missed|dropped|didn'?t|did not|never|haven'?t|have not)|isn'?t (?:right|correct)|is not (?:right|correct)|not (?:right|correct|quite))\b|[✗✘❌⚠]/i;
// A plain statement that something is wrong (not just "you said …").
const STRONG_ERR = /\b(?:wrong|mistakes?|errors?|incorrect(?:ly)?|should(?:n'?t| not)?|instead|forg[eo]t|missed|problems?|issues?|not (?:right|correct|quite)|isn'?t (?:right|correct))\b|[\u2717\u2718\u274C]/i;
// A correction by contrast: "not +128", "they don't wrap round", "instead of 0s".
const CONTRASTS = /\b(?:not|no|never|instead|rather|only|cannot)\b|n't\b/i;
const POSITIVE = /\b(?:right|correct(?:ly)?|fine|good|ok(?:ay)?|perfect|spot on|well done|nice)\b|[✓✔✅]/i;
const CONTRAST = /\bbut\b|\bhowever\b|\bwhereas\b|\bexcept\b|\buntil\b/i;

/** drop the "…is right" half of "the 1s column is right, but the 8s column is wrong" */
function errorPart(text) {
  return text.split(CONTRAST).filter((p) => !(POSITIVE.test(p) && !ERR.test(p))).join(' ');
}

// ---------------------------------------------------------------------------
// Locations: which bit / column a piece of text points at (0 = the 1s column)
// ---------------------------------------------------------------------------

const ORDINALS = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth'];
const ORD_RE = `(\\d{1,2})(?:st|nd|rd|th)?|${ORDINALS.slice(1).join('|')}`;
const ordValue = (s) => (/^\d/.test(s) ? parseInt(s, 10) : ORDINALS.indexOf(s.toLowerCase()));
const PLACE_WORDS = { unit: 0, units: 0, ones: 0, "one's": 0, twos: 1, "two's": 1, fours: 2, "four's": 2, eights: 3, "eight's": 3,
  sixteens: 4, "sixteen's": 4, 'thirty-twos': 5, 'sixty-fours': 6 };
const log2 = (n) => (n >= 1 && Number.isInteger(Math.log2(n)) ? Math.log2(n) : null);

/**
 * Bit indices a text names, for a w-bit number: "bit 3", "the 8s column",
 * "2^3 place", "the 4th column from the right", "second bit from the left",
 * "the leftmost bit", "the sign bit", "the 9th bit". Plain "column 3" or "the
 * 3rd bit" are ambiguous (from which end? from 0 or 1?) and are not counted.
 */
export function locations(text, w) {
  const found = new Set();
  let t = ` ${normalise(text)} `;
  const add = (v) => { for (const x of [].concat(v)) if (Number.isInteger(x) && x >= 0 && x <= w) found.add(x); };
  const take = (re, fn) => { t = t.replace(re, (...m) => { add(fn(...m)); return ' '; }); };
  const fromEnd = (n, side) => (side.toLowerCase() === 'right' ? n - 1 : w - n);
  // "the 4th column from the right", "second bit from the left"
  take(new RegExp(`\\b(${ORD_RE})\\s+(?:bit|column|digit|place|position|col)s?[\\s(,]+(?:in\\s+|counting\\s+|starting\\s+)?(?:from|on)\\s+the\\s+(right|left)`, 'gi'),
    (m, o, _d, side) => fromEnd(ordValue(o), side));
  // "column 4 from the right", "column 6 (counting from the right)" (1-based)
  take(/\b(?:bit|column|digit|position|col)\s+(\d{1,2})[\s(,]+(?:counting\s+|starting\s+|numbered\s+)?from\s+the\s+(right|left)/gi, (m, n, side) => fromEnd(+n, side));
  // "the 9th bit" can only be the extra one
  take(new RegExp(`\\b(${ORD_RE})\\s+(?:bit|digit)\\b`, 'gi'), (m, o) => (ordValue(o) === w + 1 ? w : null));
  // place values: "the 8s column", "8's place", "2^3 column", "the 128 column"
  take(/\b2\s*\^\s*(\d{1,2})(?:'s|s)?\s*(?:column|place(?:\s*value)?|position|col|digit|bit)\b/gi, (m, e) => +e);
  take(/\b(\d{1,5})(?:'s|s)\s*(?:column|place(?:\s*value)?|position|col|digit|bit)\b/gi, (m, n) => log2(+n));
  take(/\b(\d{1,5})\s*(?:column|place(?:\s*value)?|position|col)\b/gi, (m, n) => (+n >= 2 ? log2(+n) : null));
  take(/\bthe\s+(\d{1,5})(?:'s|s)(?![\w'])/gi, (m, n) => (+n >= 2 ? log2(+n) : null));
  take(/\b(units?|ones|one's|twos|two's|fours|four's|eights|eight's|sixteens|sixteen's|thirty[- ]twos|sixty[- ]fours)\s+(?:column|place|position|digit|bit)\b/gi,
    (m, word) => PLACE_WORDS[word.toLowerCase().replace(/\s+/, '-')]);
  // "bit 3", "bits 5 and 6", "bit position 0"
  take(/\bbits?\s*(?:#|no\.?|number|position|index)?\s*(\d{1,2})\b(?:\s*(and|&|,|or|to|-)\s*(\d{1,2})\b)?/gi, (m, a, sep, b) => {
    if (b === undefined) return +a;
    if (sep === 'to' || sep === '-') { const out = []; for (let i = Math.min(+a, +b); i <= Math.max(+a, +b); i++) out.push(i); return out; }
    return [+a, +b];
  });
  // ends
  take(/\b(?:right-?most|least[- ]significant|lowest)\s+(?:bit|column|digit|position)\b|\b(?:right-?most|LSB)\b/gi, () => 0);
  take(/\b(?:left-?most|most[- ]significant|highest|top|sign)\s+(?:bit|column|digit|position)\b|\b(?:left-?most|MSB)\b/gi, () => w - 1);
  return found;
}

/** the locations named by the first sentence that says something is wrong and names any location */
export function firstErrorLocations(text, w) {
  const ss = sentences(text);
  for (let k = 0; k < ss.length; k++) {
    if (!ERR.test(ss[k].text)) continue;
    let locs = locations(errorPart(ss[k].text), w);
    // "Column 3 (8s): 1 + 1 + 1 = 11. You wrote 0 ✗" — the location is one sentence back
    if (!locs.size && k > 0 && ss[k - 1].line === ss[k].line) locs = locations(errorPart(ss[k - 1].text), w);
    if (locs.size) return locs;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Answers: bit patterns, numbers, overflow verdicts, flag values
// ---------------------------------------------------------------------------

/**
 * Does the text write the bit pattern `target` (MSB first)? Groups may be
 * split by single spaces or underscores ("0110 1010", "0110_1010", "0b01101010",
 * "0 1 1 0 1 0 1 0"). A pattern inside a longer one ("1 0110 1010", a 9-bit
 * answer) does not count.
 */
export function hasBits(text, target) {
  const t = normalise(text);
  const re = /(?<![0-9A-Za-z.])(?:0b)?[01]+(?:[ _\t][01]+)*(?![0-9A-Za-z])/g;
  for (const m of t.matchAll(re)) {
    const groups = m[0].replace(/^0b/, '').split(/[ _\t]+/);
    if (groups.join('') === target) return true;
    if (groups.every((g) => g.length === 1)) continue;
    for (let a = 0; a < groups.length; a++) {
      if (a > 0 && groups[a - 1].length < 2) continue;
      let s = '';
      for (let b = a; b < groups.length; b++) {
        s += groups[b];
        if (s.length > target.length) break;
        if (s === target) return true;
      }
    }
  }
  return false;
}

const CUE = /(?:print(?:s|ed)?|outputs?|answer|result|value|evaluates? to|gives?|get|gets|shows?|displays?|returns?|becomes?|holds?|stores?|equals?|is|are|was|be|=|:|→|->|from|to|and|of|range)\s*["'(]?\s*$/i;

/** whole numbers in a text with their sign: "-74", "minus 74", "4,294,967,295" */
export function numbersIn(text) {
  const t = normalise(text).replace(/(\d)[,](?=\d{3}(?!\d))/g, '$1');
  const out = [];
  const re = /(?<![\w.])(?:(minus|negative)\s+|(-)\s?)?(\d+)(?![\d]|\.\d)/gi;
  for (const m of t.matchAll(re)) {
    const v = Number(m[3]) * (m[1] || m[2] ? -1 : 1);
    out.push({ v, digits: m[3], before: t.slice(Math.max(0, m.index - 30), m.index) });
  }
  return out;
}

// For a program's output a bare "is" is not enough ("the carry is 1" is not "it prints 1").
const OUTPUT_CUE = /(?:print(?:s|ed)?|outputs?|output is|answer(?: is| should be)?|result(?: is)?|evaluates? to|gives?|shows?|displays?|returns?|=|:|→|->)\s*["'(]?\s*$/i;

/**
 * Does the text state the number n? Small or binary-looking numbers need a cue
 * just before them ("value: 8", "= 10"); with `output`, a cue that means printing.
 */
export function hasNumber(text, n, { output = false } = {}) {
  const needsCue = Math.abs(n) < 10 || /^[01]+$/.test(String(Math.abs(n)));
  const cue = output ? OUTPUT_CUE : CUE;
  return numbersIn(text).some((x) => x.v === n && (!needsCue || cue.test(x.before)));
}

const NEG_BEFORE = /\b(?:no|not|never|nothing|without|isn'?t|aren'?t|wasn'?t|doesn'?t|don'?t|won'?t|didn'?t|wouldn'?t|haven'?t|hasn'?t|cannot|can'?t)\b[\w\s']{0,12}$/i;
const YES_OVERFLOW = [
  /there\s+(?:is|was|will be|would be|'s)\s+(?:indeed\s+|actually\s+|definitely\s+)?(?:an?\s+)?overflow(?!\s*flag)/gi,
  /there'?s\s+(?:indeed\s+|actually\s+)?(?:an?\s+)?overflow(?!\s*flag)/gi,
  /overflow\s*(?:[:=]|should\s+be|should\s+have\s+been|is|answer\s+(?:is|should\s+be))\s*["']?yes\b/gi,
  /\b(?:does|did|will|would)\s+overflow\b/gi,
  /\bis\s+an\s+overflow\b/gi,
  /\b(?:causes?|caused|results?\s+in|resulted\s+in|produces?|produced|gives?|gave|get|have|has|had|creates?)\s+(?:an?\s+)?overflow(?!\s*flag)/gi,
  /\boverflow\s+(?:occurs|occurred|happens|happened|does\s+occur|did\s+occur|has\s+occurred)/gi,
  /\boverflows\b/gi,
  /\boverflow(?:\s+error)?\s*[:=]\s*(?:1|true)\b/gi,
  /\bwith\s+(?:an?\s+)?overflow(?!\s*flag)\b/gi,
  /\(\s*overflow\s*\)|,\s*overflow\s*(?=[.)\n]|$)/gi,
];
const NO_OVERFLOW = [
  /\bno\s+overflow\b/gi,
  /\bnot\s+(?:an?\s+)?overflow\b/gi,
  /\b(?:does\s*n[o']t|did\s*n[o']t|doesn'?t|didn'?t|won'?t|will\s+not|would\s+not|wouldn'?t|does\s+not|did\s+not|never)\s+overflow/gi,
  /overflow\s*(?:[:=]|should\s+be|should\s+have\s+been|is|answer\s+(?:is|should\s+be))\s*["']?no\b/gi,
  /\bisn'?t\s+(?:an?\s+)?overflow\b/gi,
  /\boverflow\s+(?:does\s*n[o']t|doesn'?t|did\s*n[o']t|didn'?t|does\s+not|did\s+not)\s+(?:occur|happen)/gi,
  /(?:don'?t|do not|doesn'?t|does not|didn'?t|did not|won'?t|will not|wouldn'?t|would not|can'?t|cannot)\s+(?:get|have|cause|produce|give|create|result in)\s+(?:an?\s+|any\s+)?overflow/gi,
  /\bwithout\s+(?:an?\s+|any\s+)?overflow/gi,
];

/** which overflow verdicts ("yes" / "no") the text states anywhere */
export function overflowVerdicts(text) {
  const t = normalise(text);
  let yes = false;
  for (const re of YES_OVERFLOW) for (const m of t.matchAll(re)) if (!NEG_BEFORE.test(t.slice(Math.max(0, m.index - 30), m.index))) yes = true;
  const no = NO_OVERFLOW.some((re) => { re.lastIndex = 0; return re.test(t); });
  return { yes, no };
}

const FLAG_NAME = { CF: '(?:\\bCF\\b|[Cc]arry [Ff]lag)', ZF: '(?:\\bZF\\b|[Zz]ero [Ff]lag)', SF: '(?:\\bSF\\b|[Ss]ign [Ff]lag)', OF: '(?:\\bOF\\b|[Oo]verflow [Ff]lag)' };
const FLAG_VALUE = { 1: 1, set: 1, on: 1, true: 1, 0: 0, clear: 0, cleared: 0, 'not set': 0, unset: 0, off: 0, false: 0 };

/** the values the text gives a flag: "OF = 1", "CF is 0", "OF should be set", "the carry flag is clear" */
export function flagValues(text, flag) {
  const t = normalise(text);
  const re = new RegExp(`${FLAG_NAME[flag]}(?:\\s*\\((?:CF|ZF|SF|OF)\\))?\\s*(?:[|:=]\\s*|(?:is|should be|should have been|would be|will be|becomes|became|equals|gets|stays|remains|was)\\s+)(?:(?:set\\s+to|equal\\s+to|actually)\\s+)?([01]|[Ss]et|[Cc]lear(?:ed)?|[Nn]ot set|[Uu]nset|[Oo]n|[Oo]ff|[Tt]rue|[Ff]alse)\\b`, 'g');
  const out = new Set();
  for (const m of t.matchAll(re)) out.add(FLAG_VALUE[m[1].toLowerCase()]);
  return out;
}

/** the output of a C card: every number in it, or the message for a branch card */
function hasOutput(text, want) {
  const nums = String(want).trim().split(/\s+/);
  if (!nums.every((x) => /^-?\d+$/.test(x))) return hasMessage(text, want);
  if (nums.length > 1) {
    // "prints -3 -6", "-3 and -6", "-3, -6": the printed line as a sequence
    const seq = new RegExp(`(?<![\\w.-])${nums.map((x) => x.replace('-', '-\\s?')).join('\\s*(?:,|and|then)?\\s*')}(?![\\d]|\\.\\d)`);
    if (seq.test(normalise(text))) return true;
  }
  return nums.every((x) => hasNumber(text, Number(x), { output: true }));
}

/** a printed message such as "less" / "not less": "less" must not be the tail of "not less" */
export function hasMessage(text, msg) {
  const t = normalise(text).toLowerCase();
  const m = msg.toLowerCase();
  const re = new RegExp(`(?<![\\w-])${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g');
  for (const hit of t.matchAll(re)) {
    if (!m.startsWith('not ') && /\bnot\s*$/.test(t.slice(Math.max(0, hit.index - 6), hit.index))) continue;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Step phrases: naming the step that broke, where a bit or column is not the point
// ---------------------------------------------------------------------------

export const STEP_PHRASES = {
  gap: /\bgaps?\b|vacated|vacant|empty (?:spaces?|places?|positions?|bits?|slots?)|shifted[- ]in|shift(?:ed|s)? in\b|new bits?|bits? (?:coming|shifted|brought|moved|that come) in|\bfill(?:ed|ing|s)?\b|padd(?:ed|ing)|pad with/i,
  fallOff: /(?:fall|fell|falls|falling|drop|drops|dropped|pushed|shifted|go|goes|went|move[sd]?|slides?|slid)\s+off|off the (?:end|edge)|end bits?|bits? (?:at|on) the (?:end|edge)|other end|wrap(?:ped|s|ping)?\s*(?:a)?round|rotat/i,
  direction: /\bdirection\b|wrong way|other way|opposite way|(?:left|right)\s+instead\s+of|instead\s+of\s+(?:shifting\s+|moving\s+|going\s+)?(?:to\s+the\s+)?(?:left|right)/i,
  amount: /number of (?:places|positions|shifts)|how (?:many|far)|too (?:many|few|far)|extra (?:place|position|shift)|(?:\d|one|two|three|four)\s+(?:places?|positions?)\s*,?\s*(?:instead|rather|not|but)|(?:instead of|rather than|not)\s+(?:by\s+)?(?:\d|one|two|three|four)\s+(?:places?|positions?)|off by one/i,
  value: /denary|decimal|base[- ]?10|(?:the|your) value|convert(?:ing|ed)?|conversion|(?:bits|binary|pattern|shift(?:ed bits)?)\s+(?:is|are|was|were)\s+(?:right|correct|fine)/i,
  plusOne: /add(?:ing|ed)?\s+(?:a\s+|the\s+)?(?:1|one)\b|\+\s*1\b(?!\d)|plus\s+(?:1|one)\b|(?:final|last|second)\s+step/i,
  invert: /invert|flip|complement|(?:swap|change|switch)(?:ping|ed)?\s+(?:all|every|each)\s+(?:the\s+)?(?:bits?|0s|1s)|0s?\s+(?:to|into|for)\s+1s?|1s?\s+(?:to|into|for)\s+0s?/i,
  topBit: /(?:top|first|leftmost|left-most|most significant|highest|sign)\s+bit|\bMSB\b|negative\s+(?:weight|place value)|(?:weight|worth|place value)\s+(?:of\s+)?-\s?\d/i,
  rest: /(?:other|remaining|rest of the|lower)\s+(?:\d+\s+|seven\s+)?bits|magnitude/i,
  rangeMin: /smallest|minimum|\bmin\b|lowest|most negative|lower (?:end|bound|limit)/i,
  rangeMax: /largest|maximum|\bmax\b|highest|biggest|most positive|upper (?:end|bound|limit)|top of the range/i,
  rangeEnds: /\bends?\s+of\s+the\s+range|\blimits\b|\bbounds\b/i,
  overflow: /overflow/i,
  ninth: /(?:9th|ninth|extra|additional|nine|9)[- ]?bits?\b|carry[- ]out|carr(?:y|ied) out|leftmost 1|the 1 (?:on|at) the (?:far )?left|(?:extra|additional) (?:digit|1)\b/i,
};

const squash = (s) => normalise(s).toLowerCase().replace(/\s+/g, '');

function locateOk(spec, text) {
  switch (spec.kind) {
    case 'col': {
      const locs = firstErrorLocations(text, spec.w);
      return !!locs && [...locs].some((i) => spec.cols.includes(i));
    }
    // the step named where the reply corrects the student, not in a general explanation
    case 'phrase': return sentences(text).some((s) => (ERR.test(s.text) || CONTRASTS.test(s.text)) && STEP_PHRASES[spec.set].test(errorPart(s.text)));
    case 'number': return hasNumber(text, spec.n);
    // the phrase inside a sentence that plainly says something is wrong
    case 'errPhrase': return sentences(text).some((s) => STRONG_ERR.test(s.text) && STEP_PHRASES[spec.set].test(errorPart(s.text)));
    case 'overflow': { const v = overflowVerdicts(text); return spec.want === 'yes' ? v.yes : v.no; }
    case 'flag': return sentences(text).some((s) => ERR.test(s.text) && spec.flags.some((f) => new RegExp(FLAG_NAME[f]).test(s.text)));
    case 'line': {
      if (new RegExp(`\\blines?\\s*${spec.line}\\b`, 'i').test(normalise(text))) return true;
      const t = squash(text);
      return spec.frags.some((f) => t.includes(squash(f)));
    }
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// Misconception rules, one per tag. `any`: one pattern anywhere in the reply;
// `all`: every pattern of one group inside the same sentence.
// ---------------------------------------------------------------------------

const OVERFLOW_WORD = /overflow|\bOF\b/;
const CARRY_WORD = /[Cc]arr(?:y|ied|ies)|\bCF\b/;
const WRAP = /wrap(?:s|ped|ping)?\s*-?\s*(?:a)?round|\bwraps\b|\bwrapped\b|wrap-?around/i;

export function misconceptionRule(tag, item = {}) {
  const w = item.key?.w ?? 8;
  const M = 2 ** (w - 1);
  const top = 2 ** w - 1;
  switch (tag) {
    case 'add_or': return { any: [/\bOR\b/, /\b(?:logical|bitwise|boolean)\s+or\b/i, /\bor(?:-ing|ed)\b/i,
      /\b1\s*\+\s*1\s*(?:=|was|is|as|equals?|to be|gives?|makes?|→|->)\s*(?:just\s+|only\s+)?1(?!\d|\.\d)/i,
      /(?:wrote|put|write|writing|got|gave)\s+(?:a\s+|just\s+(?:a\s+)?)?1\s+(?:for|in|when|where)\s+(?:the\s+)?1\s*\+\s*1\b/i,
      /(?:treat|treated|treating)\s+1\s*\+\s*1\s+(?:as|like)\s+(?:just\s+)?1(?!\d|\.\d)/i,
      /1\s*\+\s*1(?!\s*\+)[^.\n]{0,30}\b(?:wrote|put|written|got|gave|write)\s+(?:down\s+)?(?:a\s+|just\s+(?:a\s+)?)?1\b(?!\s*(?:and|,)?\s*carr)(?!\d|\.\d)/i] };
    case 'add_no_carry': return { any: [
      /(?:forg[eo]t(?:ten|ting)?|didn'?t|did not|missed|miss(?:ing)?|dropped|drop(?:ping)?|lost|lose|ignored?|ignoring|left out|leaving out|never|failed to|neglected)\s+(?:to\s+|about\s+)?(?:(?:add|include|bring|write|put|carry|use|pass|move)(?:ing|ed)?\s+(?:in\s+|over\s+|on\s+|across\s+)?)?(?:(?:the|a|that|your|this|any|each|every)\s+)?(?:1\s+|one\s+)?(?:incoming\s+)?carr(?:y|ied|ies|ying)/i,
      /carr(?:y|ies)\s+(?:was|were|is|got|has been|have been)\s+(?:dropped|lost|missed|forgotten|ignored|left out|not (?:added|included|carried))/i,
      /(?:didn'?t|did not|never)\s+(?:add|include)\s+(?:in\s+)?(?:the|that|this)\s+(?:1|one)\s+(?:you\s+)?carried/i] };
    case 'add_three_ones': return { any: [/1\s*\+\s*1\s*\+\s*1\s+(?:as|is not|isn'?t|to be|was|=)\s+0\s*(?:,\s*)?(?:carry|with a carry)/i], all: [[
      /1\s*\+\s*1\s*\+\s*1|three (?:1s|ones|1's)|1\s*\+\s*1\s*(?:\+|plus|and|with)\s*(?:a\s+|the\s+)?carr(?:y|ied)/i,
      /\b11\b|=\s*3\b|\bis\s+3\b|write\s+(?:a\s+)?1\s+and\s+carry|\b1,?\s+carry\s+(?:the\s+)?1|not\s+(?:a\s+)?0\b|instead of\s+(?:a\s+)?0\b|(?:wrote|put)\s+(?:a\s+)?0\b/i]] };
    case 'add_carry_wrong_col': return { all: [[
      /carr(?:y|ies)/i,
      /(?:wrong|incorrect|same|different|adjacent)\s+(?:column|place|position|spot)|one (?:column|place|position) (?:to the |too far (?:to the )?)?(?:left|right)|one (?:column|place|position) away|(?:mis|wrongly )aligned|misplaced|shifted|offset|off by one|(?:above|under|over)\s+the\s+(?:wrong|same)|column (?:it|they|that) (?:came|come|comes) from|should (?:go|be written|be placed|sit) (?:above|over|in) the next/i]] };
    case 'add_ninth_bit': return { any: [/(?:kept|keep|keeping|wrote|write|writing|included?|including|added|adding)\s+(?:an?\s+|the\s+)?(?:extra|additional|9th|ninth)\s+bit/i], all: [[STEP_PHRASES.ninth,
      /\b8[- ]?bits?\b|eight bits|no room|nowhere|(?:does|do)(?:n'?t| not) fit|can(?:'?t|not)|discard|dropped|drop it|\blost\b|isn'?t (?:part|kept|stored)|not (?:part|kept|stored|included)|only (?:keep|hold|store|have)|ignored?|thrown|throw|removed?|leave (?:it )?out|left out|should(?:n'?t| not)/i]] };
    // "there is an overflow" plus why (a carry out, it does not fit), or "you missed the overflow"
    case 'add_overflow_missed': return { verdict: 'yes', any: [/miss(?:ed|ing)?\s+(?:an?\s+|the\s+)?overflow/i,
      new RegExp(`carr(?:y|ied|ies)[- ]?out|out of the (?:top|leftmost|last|most significant)|9th|ninth|nine bits|${w + 1} bits|(?:does|do|did)(?:n'?t| not) fit|can(?:'?t|not) fit|too (?:big|large)|exceeds?|(?:bigger|greater|larger|more) than (?:${top}|the (?:max|largest))|>\\s*${top}|over ${top}|above ${top}`, 'i')] };
    // "no overflow" (or "you said there was one") plus why: nothing carries out, it fits
    case 'add_overflow_false': return { test: (t) => (overflowVerdicts(t).no || /(?:said|claimed|thought|wrote|put|answered)[^.\n]{0,30}overflow/i.test(t))
      && new RegExp(`no carr(?:y|ies)[- ]?out|nothing carri(?:es|ed)(?: out)?|no carry (?:out|from|leaves|comes)|(?:doesn'?t|does not|didn'?t|did not|never) carr(?:y|ies) out|\\bfits?\\b|within|(?:less|smaller|lower) than ${top + 1}|(?:under|below) ${top + 1}|at most ${top}|(?:doesn'?t|does not) exceed|no (?:9th|ninth)|only (?:happens|occurs|overflow)`, 'i').test(t) };
    case 'shift_direction': return { any: [STEP_PHRASES.direction,
      /(?:shifted|moved|went|shift)\s+(?:the\s+bits\s+|them\s+|it\s+|everything\s+)?(?:to\s+the\s+)?(?:left|right)[^.\n]{0,30}\b(?:but|should|instead|rather)\b/i] };
    case 'shift_amount': return { any: [STEP_PHRASES.amount,
      /\b(?:\d|one|two|three|four|five)\s+(?:places?|positions?|times)[^.\n]{0,30}\b(?:instead of|rather than|not|but)\b[^.\n]{0,20}\b(?:\d|one|two|three|four|five)\b/i] };
    case 'shift_kept_bits': return { any: [/rotat/i, WRAP, /circular|cyclic/i,
      /(?:fall|fell|falls|falling|drop|drops|dropped|pushed|shifted|go|goes|went|move[sd]?)\s+off\b/i,
      /(?:lost|discarded|thrown away|disappear|gone)\b[^.\n]{0,40}\b(?:end|edge)\b|\b(?:end|edge)\b[^.\n]{0,40}\b(?:lost|discarded|thrown away|disappear|gone)\b/i,
      /(?:don'?t|do not|doesn'?t|does not|never)\s+(?:come back|reappear|wrap|appear)/i, /other end/i] };
    case 'shift_fill': return { all: [[STEP_PHRASES.gap, /\b0s\b|0's|zeros?|zeroes|\b0\b|\b1s\b|1's|\bones\b|\b1\b|sign bit|(?:wrong|other) bit/i]] };
    case 'shift_value_myth': return { any: [/as if (?:the shift|it|shifting|a shift)[^.\n]{0,30}(?:multipl|divid)/i], all: [[
      /multipl|divid|halv|doubl|×\s*\d|\*\s*\d|÷|\/\s*\d|times\s+\d|powers? of (?:2|two)|2\s*\^/i,
      /overflow|\blost\b|\blos[et]s?\b|fell off|falls? off|drop(?:ped|s)? off|pushed off|(?:doesn'?t|does not|don'?t|do not|won'?t|can'?t|cannot) fit|too (?:big|large)|out of range|remainder|round(?:s|ed|ing)?|truncat|no longer|only (?:works|true|holds|exact)|not (?:exact|always)|isn'?t (?:exact|always)|only (?:when|if)|discard|(?:doesn'?t|does not) (?:hold|work)|breaks?/i]] };
    case 'shift_arith_logical': return { any: [/\bsign[- ]?extension\b|\bsign[- ]?extend/i, /cop(?:y|ies|ied|ying)\s+(?:of\s+)?the\s+sign\s+bit/i,
      /sign\s+bit\s+(?:is\s+|gets\s+|was\s+|should\s+be\s+|being\s+)?(?:copied|repeated|preserved|kept|extended|replicated|duplicated|shifted in)/i,
      /(?:preserv|keep)(?:e|es|ing|s)?\s+the\s+sign/i], all: [[/\barithmetic\b/i, /\blogical\b/i]] };
    case 'twos_sign_magnitude': return { any: [/sign[- ]and[- ]magnitude|sign[- ]magnitude|signed[- ]magnitude/i,
      /(?:just|only|simply)\s+(?:put|set|flip(?:ped)?|change[sd]?|turn(?:ed)?|add(?:ed)?|made)(?:ting)?\s+(?:a\s+)?(?:1\s+(?:in|at|as|on)\s+)?the\s+(?:sign|top|first|leftmost|left-most|most significant)\s+bit/i,
      /(?:treat|read|use|using|used|treated|reading)[^.\n]{0,30}(?:top|first|leftmost|sign|most significant)\s+bit[^.\n]{0,25}(?:as|like)\s+(?:a|the|just a|only a)\s+(?:plain\s+|simple\s+|mere\s+)?(?:minus|negative|sign)/i,
      /(?:not|isn'?t)\s+(?:just\s+)?(?:a\s+)?(?:minus|negative)\s+sign/i] };
    case 'twos_no_plus1': return { any: [/ones'?\s*complement|one'?s\s*complement/i,
      /(?:forg[eo]t|forgetting|didn'?t|did not|missed|miss(?:ing)?|skipp?(?:ed|ing)?|left out|leave out|omit(?:ted)?|without)[^.\n]{0,25}\b(?:add(?:ing)?|plus|\+)\s*(?:the\s+)?(?:1|one)\b/i,
      /(?:then|and|also|still)\s+(?:you\s+)?(?:need|have|must|should)\s+(?:to\s+)?add\s+(?:1|one)\b/i,
      /invert(?:ed|ing)?[^.\n]{0,60}\bbut\b[^.\n]{0,30}\badd\s+(?:1|one)\b/i, /(?:off|out) by\s+(?:1|one)\b/i] };
    case 'twos_msb_positive': return { any: [new RegExp(`(?:-|minus\\s|negative\\s)\\s?${M}\\b`), /\bunsigned\b/i,
      /(?:top|first|leftmost|most significant|highest|sign)\s+bit\s+(?:as|was|is)\s+(?:a\s+)?(?:positive|\+\s?\d+)/i,
      /(?:top|first|leftmost|most significant|highest|sign)\s*bit[^.\n]{0,40}(?:negative|minus)|\bMSB\b[^.\n]{0,40}(?:negative|minus)/i, /negative\s+(?:weight|place value)/i] };
    case 'twos_range': return { any: [/wrong\s+(?:two's complement\s+)?range|because of (?:the )?zero|zero (?:takes|uses|is (?:counted|one of|included|positive))|(?:takes|uses) up (?:one|a) (?:of the )?(?:patterns?|values?|spots?|slots?)|0 is (?:counted|included|one of)|including (?:0|zero)|asymmetr|not symmetric|isn'?t symmetric|one more negative|extra negative|negative zero|minus zero|-0\b|two zeros/i],
      all: [[new RegExp(`(?:-|minus\\s)${M}\\b`), new RegExp(`(?<![\\d-])${M - 1}\\b`)]] };
    case 'flags_carry_is_overflow': return { all: [[CARRY_WORD, OVERFLOW_WORD,
      /\bnot\b|n't|different|differ|confus|mix|same thing|unsigned|signed|mean|separate|independent|unrelated|irrelevant|ignore|treat|as (?:an? )?(?:overflow|carry)|other way round|swap|instead|rather than/i]] };
    case 'flags_signed_overflow_missed': return { any: [/signed\s+overflow/i], all: [[OVERFLOW_WORD, new RegExp(`(?:both|two)\\s+(?:positive|negative)|same sign|sign (?:changed|flipped|changes|flips)|(?:became|becomes|turned|comes out|came out|is|gives?|result is)\\s+(?:a\\s+)?(?:negative|positive)|${WRAP.source}|out(?:side)? (?:of )?(?:the )?range|(?:doesn'?t|does not|can'?t|cannot|won'?t) fit|too (?:big|large|small)|exceed|beyond|(?:greater|more|bigger|larger) than \\+?${M - 1}|(?:less|smaller|lower) than -${M}|>\\s*${M - 1}|<\\s*-${M}|\\brange\\b`, 'i')]] };
    case 'flags_sub_carry': return { any: [/(?:\bCF\b|[Cc]arry flag)[^.\n]{0,40}\b(?:after|in|for)\s+(?:a\s+|the\s+)?subtract/], all: [[/\bCF\b|[Cc]arry flag/, /borrow|invert|inverse|opposite|not the carry|\bNOT\b|complement|flip|negat|revers/i]] };
    case 'c_signed_overflow': return { any: [WRAP, /undefined behaviou?r|\bUB\b/, /(?:signed|int(?:eger)?)\s+overflow/i,
      /overflow(?:s|ed)?\s+(?:an?\s+|the\s+)?(?:32[- ]bit\s+)?(?:signed\s+)?int/i,
      /modulo\s+2\s*\^?\s*32|mod\s+2\s*\^?\s*32|4,?294,?967,?296|2\s*\^\s*32|low(?:er)?\s+32\s+bits|bottom\s+32\s+bits|truncat/i] };
    case 'c_usual_conversions': return { any: [/usual arithmetic conversions?/i,
      /(?:convert|converted|converts|conversion|promot(?:ed|es|ion)|cast|casts|casted|treated|treats|interpreted|reinterpreted|becomes|turned into|turns into|seen as|read as)\s+(?:(?:the|it|a|an)\s+)?(?:int\s+|value\s+|number\s+|-?\d+\s+)?(?:to\s+|into\s+|as\s+)?(?:an?\s+)?unsigned/i,
      /\bunsigned\b[^.\n]{0,60}(?:4,?294,?967,?2\d\d|2\s*\^\s*32|huge|very large|large positive|big positive)/i,
      /(?:4,?294,?967,?2\d\d|UINT_MAX)[^.\n]{0,60}\bunsigned\b/i, /unsigned (?:comparison|compare)/i] };
    case 'c_promotion': return { any: [/(?:integer\s+)?promot(?:ed|ion|ions|es)\b/i,
      /(?:converted|convert|widened|widen|becomes?|turned|turn|extended|zero-extended)\s+(?:to|into)\s+(?:an?\s+)?\(?int\b/i,
      /(?:done|computed|calculated|performed|happens|evaluated|carried out|worked out|added)\s+(?:in|as|using)\s+(?:an?\s+|full\s+)?(?:int\b|ints\b|32[- ]bits?)/i] };
    case 'c_truncating_division': return { any: [/truncat/i, /toward(?:s)?\s+(?:zero|0)\b/i, /down,?\s+not\s+(?:toward|towards|to)\s+(?:0|zero)\b/i,
      /(?:sign of the|same sign as the)\s+(?:dividend|numerator|first|left)/i, /floor(?:ed)?\s+division|\bfloor(?:s|ing)?\b|python/i,
      /(?:chops?|drops?|discards?|throws? away)\s+(?:off\s+)?the\s+(?:fraction|decimal|fractional)/i] };
    case 'c_shift_negative': return { any: [/arithmetic\s+(?:right\s+)?shift|\bsar\b/i, /\blogical(?:\s+right)?(?:\s+shift)?\b|\bshr\b/i, /sign[- ]?exten(?:d|sion|ded|ds)/i,
      /cop(?:y|ies|ied|ying)\s+(?:of\s+)?the\s+sign\s+bit/i,
      /sign\s+bit\s+(?:is\s+|gets\s+|was\s+)?(?:copied|preserved|extended|replicated|kept|shifted in|repeated)/i,
      /(?:fill(?:s|ed|ing)?|shift(?:s|ed)?\s+in)\s+(?:the\s+(?:gap|top|left|high(?:er)?|upper)\s+(?:bits\s+)?)?(?:with\s+)?(?:1s|ones|1's)\b/i,
      /(?:preserv|keep)(?:e|es|ing|s)?\s+the\s+sign/i] };
    case 'c_char_signedness': return { any: [/\b(?:plain\s+)?char\b[^.\n]{0,40}\b(?:un)?signed\b/i, /\bsigned\s+char\b/i,
      /-\s?128\s*(?:to|\.\.|-|and|through)\s*\+?127/i, /(?:range|max(?:imum)?|largest|biggest|highest|up to|only)[^.\n]{0,30}\b127\b/i,
      /(?:can'?t|cannot|can not|doesn'?t|does not|won'?t)\s+(?:hold|fit|store|represent)\s+(?:the\s+(?:value|number)\s+)?\d+/i,
      /\b\d+\s+(?:doesn'?t|does not|won'?t|can'?t|cannot)\s+fit/i] };
    case 'c_unsigned_wrap': return { any: [WRAP, /modulo|\bmod\s+2/i, /2\s*\^\s*32|4,?294,?967,?296|UINT_MAX/,
      /(?:can'?t|cannot|can not|never|doesn'?t|does not|won'?t)\s+(?:be|go|become|hold|store|represent)\s+(?:a\s+)?negative/i, /no negative/i, /underflow/i,
      /go(?:es|ing)?\s+below\s+(?:0|zero)/i] };
    case 'c_narrowing': return { any: [/truncat/i,
      /low(?:er|est)?\s+(?:8|16|eight|sixteen)\s+bits|bottom\s+(?:8|16)\s+bits|last\s+(?:8|16)\s+bits|least significant\s+(?:8|16)/i,
      /(?:keeps?|stores?|holds?)\s+(?:only\s+)?(?:the\s+|its\s+)?(?:low|bottom|last|least significant|lower)\b/i, /(?:cut|chopped)\s+off/i,
      /(?:mod|modulo)\s+(?:65,?536|256|2\s*\^\s*(?:16|8))/i,
      /(?:upper|top|high(?:er)?)\s+(?:8\s+|16\s+)?bits\s+(?:are|get|is|were)\s+(?:dropped|discarded|lost|cut|thrown|removed|chopped)/i,
      /narrow/i, /(?:doesn'?t|does not|won'?t|can'?t|cannot)\s+fit/i, /(?:doesn'?t|does not|won'?t|don'?t|isn'?t|is not)\s+(?:clamp|saturat|cap)/i, /no (?:clamping|saturation)/i] };
    case 'c_jump_signedness': return { any: [/\b(?:jae|jnb|jb|ja|jbe|jnae|jnbe|jna|jc|jnc|setb|seta)\b/,
      /unsigned\s+(?:jump|branch|condition(?:al)?|comparison|compare|test)/i, /\b(?:jge|jl|jg|jle)\b[^.\n]{0,60}\bsigned\b/i,
      /(?:below|above)\b[^.\n]{0,20}\b(?:unsigned|CF|carry)/i] };
    default: return { any: [] };
  }
}

function ruleOk(rule, text) {
  const t = normalise(text);
  if (rule.test) return rule.test(t);
  if (rule.verdict) {
    const v = overflowVerdicts(t);
    if (!(rule.verdict === 'yes' ? v.yes : v.no)) return false;
  }
  if ((rule.any || []).some((re) => re.test(t))) return true;
  const ss = sentences(t).map((s) => s.text);
  return (rule.all || []).some((group) => ss.some((s) => group.every((re) => re.test(s))));
}

// ---------------------------------------------------------------------------
// Scoring one reply
// ---------------------------------------------------------------------------

/** does the reply give every part the student got wrong? */
export function answerOk(item, text) {
  const p = item.key.parts || {};
  const checks = [];
  if (p.bits !== undefined) checks.push(hasBits(text, p.bits));
  if (p.number !== undefined) checks.push(hasNumber(text, p.number));
  if (p.numbers !== undefined) checks.push(p.numbers.every((n) => hasNumber(text, n)));
  if (p.overflow !== undefined) { const v = overflowVerdicts(text); checks.push(p.overflow === 'yes' ? v.yes : v.no); }
  if (p.flags !== undefined) checks.push(Object.entries(p.flags).every(([f, v]) => flagValues(text, f).has(v)));
  if (p.output !== undefined) checks.push(hasOutput(text, p.output));
  if (p.message !== undefined) checks.push(hasMessage(text, p.message));
  return checks.length > 0 && checks.every(Boolean);
}

export function columnOk(item, text) {
  return (item.key.locate || []).some((spec) => locateOk(spec, text));
}

export function misconceptionOk(item, text) {
  return ruleOk(misconceptionRule(item.tag, item), text);
}

export function scoreResponse(item, response) {
  const text = String(response ?? '');
  return { answer_ok: answerOk(item, text), column_ok: columnOk(item, text), misconception_ok: misconceptionOk(item, text) };
}

// ---------------------------------------------------------------------------
// Human ratings, report and the E0 rule
// ---------------------------------------------------------------------------

/** '1', 'y', 'yes', 'true', '✓' → true; '0', 'n', 'no', 'false', '✗' → false; blank → null */
export function parseRating(v) {
  const t = String(v ?? '').trim().toLowerCase();
  if (!t) return null;
  if (['1', 'y', 'yes', 'true', 't', '✓', '✔', 'ok'].includes(t)) return true;
  if (['0', 'n', 'no', 'false', 'f', '✗', '✘', 'x'].includes(t)) return false;
  return null;
}

const rowKey = (id, model) => `${String(id).trim()}\u0000${String(model).trim()}`;

/**
 * Merge automatic and human scores. A rater named "final" (an adjudication)
 * always wins; otherwise the human value is used when every human who rated
 * that cell agrees, and the automatic one stays when humans disagree (the row
 * is then listed for adjudication).
 */
export function mergeRatings(scored, ratings) {
  const byKey = new Map();
  for (const r of ratings) {
    const k = rowKey(r.id, r.model);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  return scored.map((s) => {
    const humans = byKey.get(rowKey(s.id, s.model)) || [];
    const out = { ...s, human: {}, final: {}, source: {} };
    for (const c of CRITERIA) {
      const given = humans.map((h) => ({ rater: h.rater, v: parseRating(h[c]) })).filter((x) => x.v !== null);
      const adj = given.find((x) => String(x.rater).trim().toLowerCase() === 'final');
      const agree = given.length && given.every((x) => x.v === given[0].v);
      out.human[c] = given;
      if (adj) { out.final[c] = adj.v; out.source[c] = 'final'; } else if (agree) { out.final[c] = given[0].v; out.source[c] = 'human'; } else { out.final[c] = s.auto[c]; out.source[c] = given.length ? 'split' : 'auto'; }
    }
    return out;
  });
}

const pct = (x) => (x === null ? '  —  ' : `${(100 * x).toFixed(1).padStart(5)}%`);
const ci = (w) => (w.p === null ? 'n = 0' : `${pct(w.p)}  [${pct(w.lo).trim()} – ${pct(w.hi).trim()}]  (${w.k}/${w.n})`);

/** per-model rates with Wilson intervals, on the final (human-over-auto) scores */
export function rates(rows, criterion, pickScore = (r) => r.final[criterion]) {
  const byModel = new Map();
  for (const r of rows) {
    if (!byModel.has(r.model)) byModel.set(r.model, { k: 0, n: 0 });
    const m = byModel.get(r.model);
    m.n++;
    if (pickScore(r)) m.k++;
  }
  return [...byModel.entries()].map(([model, { k, n }]) => ({ model, ...wilson(k, n) }));
}

/**
 * The pre-registered E0 rule. Schools: if a free-tier model identifies the
 * first wrong column or step in ≥ 95% of attempts, drop "verified" from the
 * schools pitch. We apply it per model and fire it if ANY model reaches 95%
 * (a student only needs one of them). University: keep "verified" there only
 * if the gap holds on the x86 items (every model below 95% on them).
 */
export function applyRule(rows, totalItems) {
  const all = rates(rows, 'column_ok');
  const x86 = rates(rows.filter((r) => r.route === 'university'), 'column_ok');
  const reached = all.filter((r) => r.p !== null && r.p >= E0_THRESHOLD).map((r) => r.model);
  const x86reached = x86.filter((r) => r.p !== null && r.p >= E0_THRESHOLD).map((r) => r.model);
  const incomplete = all.filter((r) => totalItems && r.n < totalItems).map((r) => `${r.model} (${r.n} of ${totalItems})`);
  return {
    all, x86, reached, x86reached, incomplete,
    schools: reached.length ? 'drop' : 'keep',
    university: reached.length ? (x86reached.length ? 'drop' : 'keep') : 'keep',
  };
}

export function report(rows, { totalItems, kappas = [], splits = 0, humanRows = 0 } = {}) {
  const L = [];
  const models = [...new Set(rows.map((r) => r.model))];
  L.push('E0 — Do free LLMs already find where a student\'s working broke?');
  L.push(`Scored replies: ${rows.length} (${models.length} model${models.length === 1 ? '' : 's'}).${humanRows ? ` Human scores used on ${humanRows} row${humanRows === 1 ? '' : 's'}.` : ' Automatic first-pass scores only.'}`);
  L.push('');
  for (const c of CRITERIA) {
    L.push(`${c} (Wilson 95% interval)`);
    for (const r of rates(rows, c)) L.push(`  ${r.model.padEnd(16)} ${ci(r)}`);
    L.push('');
  }
  L.push('column_ok by family');
  const fams = [...new Set(rows.map((r) => r.family))];
  for (const f of fams) {
    const part = rates(rows.filter((r) => r.family === f), 'column_ok');
    L.push(`  ${f.padEnd(11)} ${part.map((r) => `${r.model} ${r.p === null ? '—' : `${(100 * r.p).toFixed(0)}%`} (${r.k}/${r.n})`).join('   ')}`);
  }
  L.push('');
  const rule = applyRule(rows, totalItems);
  L.push(`The pre-registered rule: ≥ ${E0_THRESHOLD * 100}% column_ok → drop "verified" from the schools pitch.`);
  for (const r of rule.all) L.push(`  ${r.model.padEnd(16)} ${ci(r)}  ${r.p !== null && r.p >= E0_THRESHOLD ? '≥ 95%' : '< 95%'}${r.lo !== null && r.lo >= E0_THRESHOLD ? ' (even the lower bound)' : ''}`);
  if (rule.incomplete.length) L.push(`  Not every item has a reply yet: ${rule.incomplete.join(', ')}. Do not decide on partial data.`);
  L.push(rule.schools === 'drop'
    ? `  Result: ${rule.reached.join(', ')} reached 95%. Drop "verified" from the schools pitch and compete on workflow.`
    : '  Result: no model reached 95%. Keep "verified" in the schools pitch.');
  L.push('  x86 items (C cards and CS:APP flags), for the university route:');
  for (const r of rule.x86) L.push(`  ${r.model.padEnd(16)} ${ci(r)}`);
  // A C snippet has one operation, so naming it is easy; show the misconception rate beside it.
  const x86m = rates(rows.filter((r) => r.route === 'university'), 'misconception_ok');
  if (x86m.length) L.push(`  (misconception_ok on the same items: ${x86m.map((r) => `${r.model} ${r.p === null ? '—' : `${(100 * r.p).toFixed(0)}%`}`).join(', ')})`);
  if (rule.schools === 'drop') {
    L.push(rule.university === 'keep'
      ? '  Result: the gap holds on the x86 items (every model below 95%). Keep "verified" for the university route only.'
      : `  Result: ${rule.x86reached.join(', ')} reached 95% on the x86 items too. Drop "verified" there as well.`);
  }
  L.push('');
  if (kappas.length) {
    L.push("Agreement (Cohen's kappa)");
    for (const k of kappas) L.push(`  ${k.label.padEnd(36)} ${k.criterion.padEnd(17)} κ = ${k.kappa === null ? 'undefined' : k.kappa.toFixed(2)}  (agreement ${k.po === null ? '—' : `${(100 * k.po).toFixed(0)}%`}, n = ${k.n})`);
    if (splits) L.push(`  ${splits} cell${splits === 1 ? '' : 's'} where human raters disagree: see e0-disagreements.csv and add a rater named "final" to settle them.`);
    L.push('');
  }
  L.push('Automatic scoring is a first pass. Where it and a human rater disagree, the human decides.');
  return L.join('\n');
}

export function kappaTable(merged) {
  const out = [];
  const raters = [...new Set(merged.flatMap((r) => CRITERIA.flatMap((c) => r.human[c].map((h) => h.rater))))].filter((x) => String(x).trim().toLowerCase() !== 'final');
  for (const name of raters) {
    for (const c of CRITERIA) {
      const pairs = merged.flatMap((r) => r.human[c].filter((h) => h.rater === name).map((h) => [r.auto[c], h.v]));
      if (pairs.length) out.push({ label: `automatic vs ${name || '(unnamed rater)'}`, criterion: c, ...cohenKappa(pairs) });
    }
  }
  for (let i = 0; i < raters.length; i++) {
    for (let j = i + 1; j < raters.length; j++) {
      for (const c of CRITERIA) {
        const pairs = [];
        for (const r of merged) {
          const a = r.human[c].find((h) => h.rater === raters[i]);
          const b = r.human[c].find((h) => h.rater === raters[j]);
          if (a && b) pairs.push([a.v, b.v]);
        }
        if (pairs.length) out.push({ label: `${raters[i]} vs ${raters[j]}`, criterion: c, ...cohenKappa(pairs) });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

export function loadItems(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function parseArgs(argv) {
  const a = { raters: [], seed: 20261218, forceSample: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--items') a.items = argv[++i];
    else if (v === '--out') a.out = argv[++i];
    else if (v === '--rater') a.raters.push(argv[++i]);
    else if (v === '--seed') a.seed = Number(argv[++i]);
    else if (v === '--force-sample') a.forceSample = true;
    else if (v === '-h' || v === '--help') a.help = true;
    else if (!a.responses) a.responses = v;
    else throw new Error(`Unexpected argument: ${v}`);
  }
  return a;
}

const USAGE = 'Usage: node tools/e0/score.mjs responses.csv [--items e0-items.jsonl] [--out dir] [--rater rater.csv]... [--seed N] [--force-sample]';

export function main(argv = process.argv.slice(2), log = console.log) {
  const args = parseArgs(argv);
  if (args.help || !args.responses) { log(USAGE); return args.help ? 0 : 1; }
  const dir = path.dirname(path.resolve(args.responses));
  const itemsFile = args.items || path.join(dir, 'e0-items.jsonl');
  const out = path.resolve(args.out || dir);
  fs.mkdirSync(out, { recursive: true });
  const items = new Map(loadItems(itemsFile).map((it) => [it.id, it]));

  const table = readTable(fs.readFileSync(args.responses, 'utf8'));
  const skipped = { blank: 0, unknown: new Set() };
  const scored = [];
  for (const r of table) {
    const id = String(r.id || '').trim();
    const model = String(r.model || '').trim();
    if (!String(r.response || '').trim()) { skipped.blank++; continue; }
    const item = items.get(id);
    if (!item) { skipped.unknown.add(id); continue; }
    scored.push({ id, model, family: item.family, route: item.route, tag: item.tag, response: r.response, auto: scoreResponse(item, r.response) });
  }
  const ratings = args.raters.flatMap((f) => readTable(fs.readFileSync(f, 'utf8')));
  const merged = mergeRatings(scored, ratings);
  const humanRows = merged.filter((r) => CRITERIA.some((c) => r.source[c] !== 'auto')).length;
  const splits = merged.reduce((n, r) => n + CRITERIA.filter((c) => r.source[c] === 'split').length, 0);
  const kappas = kappaTable(merged);

  const notes = [];
  if (skipped.blank) notes.push(`${skipped.blank} row${skipped.blank === 1 ? '' : 's'} without a reply were skipped.`);
  if (skipped.unknown.size) notes.push(`Unknown ids skipped: ${[...skipped.unknown].slice(0, 10).join(', ')}${skipped.unknown.size > 10 ? ' …' : ''}.`);

  const b = (x) => (x ? 1 : 0);
  fs.writeFileSync(path.join(out, 'e0-scored.csv'), toCsv([
    ['id', 'model', 'family', 'route', 'tag', 'auto_answer_ok', 'auto_column_ok', 'auto_misconception_ok', 'answer_ok', 'column_ok', 'misconception_ok', 'source'],
    ...merged.map((r) => [r.id, r.model, r.family, r.route, r.tag, ...CRITERIA.map((c) => b(r.auto[c])), ...CRITERIA.map((c) => b(r.final[c])),
      [...new Set(CRITERIA.map((c) => r.source[c]))].join('+')]),
  ]));

  // The second rater's 20%: blind to the automatic scores, with the key to judge by.
  const samplePath = path.join(out, 'e0-rater-sample.csv');
  if (fs.existsSync(samplePath) && !args.forceSample) {
    notes.push(`${samplePath} already exists, so it was left alone (it may hold a rater's work). Use --force-sample to rewrite it.`);
  } else {
    const sample = raterSample(scored, { seed: args.seed });
    fs.writeFileSync(samplePath, toCsv([
      ['id', 'model', 'response', 'answer_ok', 'column_ok', 'misconception_ok', 'rater', 'correct_answer', 'first_wrong_step', 'misconception', 'student_message'],
      ...sample.map((r) => {
        const it = items.get(r.id);
        return [r.id, r.model, safeCell(r.response), '', '', '', '', it.key.correct, it.key.step, it.key.tagLabel, safeCell(it.message)];
      }),
    ]));
    notes.push(`Wrote ${samplePath} (${sample.length} rows) for the second rater.`);
  }
  if (ratings.length) {
    const dis = [];
    for (const r of merged) {
      for (const c of CRITERIA) {
        for (const h of r.human[c]) if (h.v !== r.auto[c]) dis.push([r.id, r.model, c, b(r.auto[c]), b(h.v), h.rater, r.source[c]]);
      }
    }
    fs.writeFileSync(path.join(out, 'e0-disagreements.csv'), toCsv([['id', 'model', 'criterion', 'automatic', 'human', 'rater', 'decided_by'], ...dis]));
    notes.push(`Wrote ${path.join(out, 'e0-disagreements.csv')} (${dis.length} row${dis.length === 1 ? '' : 's'}).`);
  }
  const text = report(merged, { totalItems: items.size, kappas, splits, humanRows });
  const full = `${text}\n\n${notes.join('\n')}`.trimEnd();
  fs.writeFileSync(path.join(out, 'e0-report.txt'), `${full}\n`);
  log(full);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
