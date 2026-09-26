// The teacher's class board: result codes pasted from anywhere (a chat, a
// spreadsheet column, an exported form) → what the class got wrong, and the
// crossover study's result. Codes carry no names; everything stays on the
// teacher's device.
import { decodeToken, decodeSet, ARM_UNKNOWN } from '../lib/codec.js';
import { tagIndex, tagLabel } from './catalogue.js';
import { crossoverStats } from './study.js';

// 4 + 4 + 4 base32-ish characters, optionally split by spaces or dashes, not
// glued to other letters or digits. Letters outside base32 (I L O U) are let
// in so decodeToken can name the problem instead of the code vanishing.
const CANDIDATE = /(?<![0-9A-Z])[0-9A-Z]{4}[ -]*[0-9A-Z]{4}[ -]*[0-9A-Z]{4}(?![0-9A-Z])/gi;
const CELL_SPLIT = /[\t,;|]/;

/** Unicode dashes and non-breaking spaces (word processors add them) → plain ones */
const plain = (s) => s.replace(/[‐-―−]/g, '-').replace(/[   ]/g, ' ').replace(/[​-‍﻿]/g, '');

/** a leftover fragment that someone probably meant as a code (names and headers have no digits) */
function looksLikeCode(s) {
  const bare = s.replace(/-/g, '');
  return /^[0-9A-Z]+$/i.test(bare) && bare.length >= 9 && bare.length <= 16 && /\d/.test(bare);
}

/** leftover text → fragments; runs of short pieces are joined so "7K2M 9QXA 40T" is judged as one */
function fragments(text) {
  const parts = text.split(/\s+/).filter(Boolean);
  const out = [];
  let run = [];
  const flush = () => { if (run.length) out.push(run.join('')); run = []; };
  for (const p of parts) {
    if (p.replace(/-/g, '').length <= 4 && /^[0-9A-Z-]+$/i.test(p)) run.push(p);
    else { flush(); out.push(p); }
  }
  flush();
  return out;
}

/** A failed 12-character match is only worth reporting when it looks like a code (a digit, or grouped like one), not an ordinary word. */
const worthReporting = (text) => /\d/.test(text) || /[ -]/.test(text);

/**
 * Codes in one cell. A candidate that does not decode may be a neighbouring
 * word plus the start of a real code ("Aisha Khan 7K2M-9QXA-40TT" first
 * matches "Khan 7K2M-9QXA"), so the scan retries from the next group inside
 * it and a code that decodes wins. Overlapping failures are one problem,
 * reported once, as the failed candidate most like a code that ends before
 * the next good code. Everything else is cut out by
 * slices, so the scan stays linear.
 */
function scanCell(cell, found, bad) {
  const re = new RegExp(CANDIDATE.source, 'gi');
  const rest = [];
  let from = 0;          // start of the text not yet used by a code or a reported failure
  let run = null;        // overlapping failures: { start, end, recent: the last few [{ end, text, error }] }

  const flush = (limit) => {
    if (!run) return;
    // written like a code (dashes or nothing between groups) beats a span that
    // takes in a word; on a tie, the later one
    const tidy = (x) => (/\s/.test(x.text) ? 0 : 1);
    const fits = run.recent.filter((x) => x.end <= limit);
    const f = fits.reduce((b, x) => (tidy(x) >= tidy(b) ? x : b), fits[0] || run.recent[0]);
    if (worthReporting(f.text)) bad.push({ text: f.text, error: f.error });
    rest.push(cell.slice(from, run.start));
    from = Math.min(limit, run.end);
    run = null;
  };

  for (let m = re.exec(cell); m; m = re.exec(cell)) {
    const start = m.index;
    const end = start + m[0].length;
    const text = m[0].trim();
    const token = decodeToken(text);
    if (!token.error) {
      // failures that end before this code are a separate problem; if none do, they were this code plus a neighbour
      if (run && run.recent.some((f) => f.end <= start)) flush(start);
      run = null;
      rest.push(cell.slice(from, start));
      found.push({ text, token });
      from = end;
      re.lastIndex = end;
    } else {
      const f = { end, text, error: token.error };
      if (run && start < run.end) {
        run.end = Math.max(run.end, end);
        run.recent.push(f);
        if (run.recent.length > 8) run.recent.splice(1, 1);   // keep the first and the latest few
      } else {
        flush(start);
        run = { start, end, recent: [f] };
      }
      re.lastIndex = start + 1;   // a real code may start at the next group inside this one
    }
  }
  flush(cell.length);
  rest.push(cell.slice(from));
  for (const f of fragments(rest.join(' '))) {
    if (looksLikeCode(f)) bad.push({ text: f, error: decodeToken(f).error || 'This is not a result code.' });
  }
}

/** every code-like thing on one line: { found: [{ text, token }], bad: [{ text, error }] } */
function scanLine(line) {
  const found = [];
  const bad = [];
  for (const cell of plain(line).split(CELL_SPLIT)) scanCell(cell, found, bad);
  return { found, bad };
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

const acc = (g) => ({ ...g, acc: g.total ? g.right / g.total : null });
const addTo = (sum, g) => ({ right: sum.right + g.right, total: sum.total + g.total });

/** per-arm, per-family accuracy and the crossover estimate of drill family − answer-only family */
function studyBlock(rows) {
  if (!rows.length) return null;
  const arms = [0, 1].map((arm) => {
    const mine = rows.filter((r) => r.arm === arm);
    const A = mine.reduce((s, r) => addTo(s, r.g1), { right: 0, total: 0 });
    const B = mine.reduce((s, r) => addTo(s, r.g2), { right: 0, total: 0 });
    return { arm, n: mine.length, A: acc(A), B: acc(B) };
  });
  // Each learner is their own control: accuracy on the family they drilled
  // minus accuracy on the family they only saw answers for. The two arms are
  // kept apart so the family gap cancels (study.js crossoverStats).
  const diffsFor = (arm) => rows
    .filter((r) => r.arm === arm && r.g1.total > 0 && r.g2.total > 0)
    .map((r) => {
      const a = r.g1.right / r.g1.total;
      const b = r.g2.right / r.g2.total;
      return arm === 0 ? a - b : b - a;
    });
  return {
    n: arms[0].n + arms[1].n,
    unknownArm: rows.filter((r) => r.arm === ARM_UNKNOWN).length,
    arms,
    diff: crossoverStats(diffsFor(0), diffsFor(1)),
  };
}

function tagCountsOf(rows) {
  const counts = new Map();
  for (const r of rows) for (const t of new Set(r.tags)) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, index: tagIndex(tag), label: tagLabel(tag), count, of: rows.length }))
    .sort((a, b) => (b.count - a.count) || (a.index - b.index));
}

/**
 * analyzeTokens(text, { setCode? }) — see CONTRACTS.md. Duplicate codes are
 * flagged (dupOf = the first line with that code) but still counted: two
 * learners with the same results get the same code, so a repeat is not
 * proof of a double paste.
 */
export function analyzeTokens(text, { setCode } = {}) {
  let set = null;
  let setError = null;
  if (setCode) {
    try { set = decodeSet(setCode); } catch (e) { setError = e.message; }
  }
  const rows = [];
  const invalid = [];
  const firstLine = new Map();
  String(text ?? '').split(/\r\n|\r|\n/).forEach((raw, i) => {
    const line = i + 1;
    const { found, bad } = scanLine(raw);
    for (const b of bad) invalid.push({ line, text: b.text, error: b.error });
    for (const { text: t, token } of found) {
      if (set && (token.setId !== set.setId || token.mode !== set.mode)) {
        invalid.push({ line, text: t, error: 'This code is from a different set.' });
        continue;
      }
      const dupOf = firstLine.has(token.code) ? firstLine.get(token.code) : null;
      if (dupOf === null) firstLine.set(token.code, line);
      const { setId, mode, g1, g2, arm, tags, right, total, score, code } = token;
      rows.push({ line, code, setId, mode, g1, g2, arm, tags, right, total, score, dupOf });
    }
  });

  const scored = rows.filter((r) => r.total > 0);
  const bySet = new Map();
  for (const r of rows) bySet.set(r.setId, (bySet.get(r.setId) || 0) + 1);
  const unique = firstLine.size;
  const studyRows = (mode) => rows.filter((r) => r.mode === mode);
  const hasStudy = rows.some((r) => r.mode !== 'normal');

  return {
    rows,
    invalid,
    tagCounts: tagCountsOf(rows),
    completion: {
      codes: rows.length,
      unique,
      duplicates: rows.length - unique,
      sets: [...bySet.entries()].map(([setId, count]) => ({ setId, count })).sort((a, b) => b.count - a.count || a.setId - b.setId),
      expected: set ? set.n : null,
      finished: set ? rows.filter((r) => r.total === set.n).length : null,
    },
    meanScore: scored.length ? scored.reduce((s, r) => s + r.score, 0) / scored.length : null,
    study: hasStudy ? { study: studyBlock(studyRows('study')), delayed: studyBlock(studyRows('delayed')) } : null,
    set,
    setError,
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * RFC 4180 cell. Pasted text is untrusted and CSVs open in spreadsheets, so a
 * cell that would start a formula (= + - @) gets a leading apostrophe.
 */
function cell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const ARM_TEXT = ['0', '1', 'unknown', ''];

export function toCsv(result) {
  const head = ['line', 'code', 'set', 'mode', 'score %', 'g1 right (drill or A)', 'g1 total', 'g2 right (holdout or B)', 'g2 total',
    'arm', 'misconception 1', 'misconception 2', 'misconception 3', 'duplicate of line', 'problem'];
  const out = [head];
  for (const r of result.rows) {
    out.push([r.line, r.code, r.setId, r.mode, r.score === null ? '' : Math.round(r.score * 100),
      r.g1.right, r.g1.total, r.g2.right, r.g2.total, ARM_TEXT[r.arm] ?? '',
      ...[0, 1, 2].map((k) => (r.tags[k] ? tagLabel(r.tags[k]) : '')), r.dupOf ?? '', '']);
  }
  for (const bad of result.invalid) {
    out.push([bad.line, bad.text, '', '', '', '', '', '', '', '', '', '', '', '', bad.error]);
  }
  return out.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
