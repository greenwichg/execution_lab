// Paste your own C: run it with a full trace, mark the predicted output and,
// when the prediction is wrong, find the first variable write where the
// learner's mental model and the machine part ways (≤ 3 checkpoint questions).
//
// Also home to the "layer kit" the CS:APP cards share (asm rows with real
// bytes, register before/after, flags with reasons, bit-column windows and the
// sign-column full adder), because both are views of one engine trace event.
import { compile, run, TYPES } from '../engine/minic.js';
import { addBits, toBits } from '../engine/bits.js';

// Enough for every loop the 30-line limit makes practical; the bisection only
// uses writes that were recorded.
const TRACE_LIMIT = 8000;
const MAX_CHECKPOINTS = 3;
const LONG_RUN = 40;              // more writes than this: probe only easy-to-answer writes

// ---------------------------------------------------------------------------
// Small formatting helpers (exported for cards.js)
// ---------------------------------------------------------------------------

const mask = (w) => (1n << BigInt(w)) - 1n;
const big = (v) => (typeof v === 'bigint' ? v : BigInt(v));
/** a BigInt as a Number when that is exact, so answers compare with === */
export const plain = (v) => (typeof v === 'bigint' && v >= -(2n ** 53n) && v <= 2n ** 53n ? Number(v) : v);
export const signedOf = (u, w) => BigInt.asIntN(w, big(u));
export const unsignedOf = (u, w) => BigInt.asUintN(w, big(u));
export const hexBytes = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
/** 0x-prefixed, zero-padded, upper-case hex of the w-bit pattern of v */
export const hexOf = (v, w = 32) => `0x${unsignedOf(v, w).toString(16).toUpperCase().padStart(Math.ceil(w / 4), '0')}`;
export const binOf = (v, w) => unsignedOf(v, w).toString(2).padStart(w, '0');
const bit = (v, i) => Number((big(v) >> BigInt(i)) & 1n);
const ordinal = (n) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${s}`;
};

/** printf output compared the forgiving way: CRLF, trailing spaces and trailing newlines don't count */
export function normOutput(s) {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[−–]/g, '-')
    .split('\n').map((l) => l.replace(/\s+$/, '')).join('\n')
    .replace(/\n+$/, '');
}

// ---------------------------------------------------------------------------
// Registers and ALU views of one trace event
// ---------------------------------------------------------------------------

const FAMILY = {};
for (const [r64, names] of Object.entries({
  rax: ['al', 'ax', 'eax'], rcx: ['cl', 'cx', 'ecx'], rdx: ['dl', 'dx', 'edx'],
  rsi: ['sil', 'si', 'esi'], rdi: ['dil', 'di', 'edi'], r8: ['r8b', 'r8w', 'r8d'], r9: ['r9b', 'r9w', 'r9d'],
})) {
  FAMILY[r64] = r64;
  for (const n of names) FAMILY[n] = r64;
}
const IS64 = new Set(['rax', 'rcx', 'rdx', 'rsi', 'rdi', 'r8', 'r9']);

/** register families an instruction's text names, in order ("add eax, ecx" → rax, rcx) */
export function regsIn(text) {
  const out = [];
  for (const tok of String(text).replace(/\[[^\]]*\]/g, ' ').split(/[\s,]+/)) {
    const f = FAMILY[tok];
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

/** operand width of an instruction: from the event, else from its register names */
function widthOf(ev) {
  if (ev.width) return ev.width;
  const toks = String(ev.text).replace(/\[[^\]]*\]/g, ' ').split(/[\s,]+/);
  return toks.some((t) => IS64.has(t)) ? 64 : 32;
}

/**
 * The adder's view of add / sub / cmp / neg: sub is a + ~b + 1, so CF after a
 * subtraction is the inverse of the adder's carry out. carryInto(i) is the
 * carry arriving at bit i (carryInto(w) = carry out of the top bit), from the
 * identity carry_i = bit i of (a XOR b XOR (a + b + cin)).
 */
export function adderView(ev, op) {
  const w = ev.width || 32;
  const sub = op === 'sub' || op === 'cmp' || op === 'neg';
  const a = unsignedOf(ev.a, w);
  const b = sub ? ~unsignedOf(ev.b, w) & mask(w) : unsignedOf(ev.b, w);
  const cin = sub ? 1n : 0n;
  const full = a + b + cin;
  const cv = a ^ b ^ full;
  const carryInto = (i) => bit(cv, i);
  return { w, sub, a, b, cin: Number(cin), r: full & mask(w), carryInto, cout: carryInto(w) };
}

const opOf = (prog, ev) => prog.insts[ev.i].op;
const isAddSub = (op) => op === 'add' || op === 'sub' || op === 'cmp' || op === 'neg';

/** one-sentence reasons for each flag after an ALU event (≤ 1 sentence each) */
export function flagReasons(prog, ev) {
  const op = opOf(prog, ev);
  const f = ev.flagsAfter;
  const w = ev.width || 32;
  const top = w - 1;
  const why = {};
  if (isAddSub(op)) {
    const v = adderView(ev, op);
    const cin = v.carryInto(top), cout = v.cout;
    const ua = unsignedOf(ev.a, w), ub = unsignedOf(ev.b, w);
    if (v.sub) {
      why.CF = f.CF
        ? `CF = 1: read as unsigned, ${ua} is below ${ub}, so the subtraction borrows.`
        : `CF = 0: read as unsigned, ${ua} is not below ${ub}, so there is no borrow.`;
    } else {
      why.CF = f.CF
        ? `CF = 1: a 1 carries out of bit ${top}, so the unsigned sum does not fit.`
        : `CF = 0: nothing carries out of bit ${top}, so the unsigned sum fits.`;
    }
    why.OF = f.OF
      ? `OF = 1: the carry into bit ${top} (${cin}) differs from the carry out (${cout}), so the signed result is wrong.`
      : `OF = 0: the carry into bit ${top} equals the carry out (both ${cin}), so the signed result is right.`;
  } else if (op === 'imul') {
    why.CF = `CF = ${f.CF}: the full signed product ${f.CF ? 'needs' : 'fits in'} ${f.CF ? `more than ${w} bits` : `${w} bits`}.`;
    why.OF = `OF = ${f.OF}: imul sets OF and CF together.`;
  }
  if (op !== 'imul') {
    why.SF = `SF = ${f.SF}: it copies bit ${top} of the result.`;
    why.ZF = f.ZF ? 'ZF = 1: the result is 0.' : 'ZF = 0: the result is not 0.';
  }
  return why;
}

// ---------------------------------------------------------------------------
// Layer kit (CONTRACTS.md "Why layers")
// ---------------------------------------------------------------------------

/** 'line' layer */
export function lineLayer(src, line, say, note = '') {
  return { id: 'line', kind: 'line', title: `Line ${line}`, say, data: { src, line, note } };
}

/**
 * 'asm' layer: the instructions of `lines` (in program order) with the engine's
 * real bytes; `hot` is the instruction index to mark; `upto` cuts the rows a
 * little after the last instruction worth showing.
 */
export function asmLayer(prog, { lines, hot, upto = null, say, title = 'The instructions' }) {
  const want = new Set(Array.isArray(lines) ? lines : [lines]);
  let rows = prog.insts.filter((ins) => want.has(ins.line));
  if (upto !== null) rows = rows.filter((ins) => ins.i <= upto);
  if (rows.length > 12) {
    // keep a window around the hot instruction
    const at = Math.max(0, rows.findIndex((ins) => ins.i === hot));
    const from = Math.max(0, Math.min(at - 5, rows.length - 12));
    rows = rows.slice(from, from + 12);
  }
  return {
    id: 'asm', kind: 'asm', title, say,
    data: {
      rows: rows.map((ins) => ({ addr: ins.addr, bytes: hexBytes(ins.bytes), text: ins.text, hot: ins.i === hot })),
      note: "This lab's compiler (gcc -O0 style).",
    },
  };
}

/** 'regs' layer from one trace event: the registers the instruction names, plus any it changed */
export function regsLayer(ev, say, { id = 'regs', title = 'Registers', names = null } = {}) {
  const width = widthOf(ev);
  const shown = names ? names.slice() : regsIn(ev.text);
  for (const r of Object.keys(ev.after)) if (ev.after[r] !== ev.before[r] && !shown.includes(r)) shown.push(r);
  if (!shown.length) shown.push('rax');
  const val = (v) => (width <= 32 ? Number(unsignedOf(v, width)) : unsignedOf(v, width));
  const before = {}, after = {};
  for (const r of shown) { before[r] = val(ev.before[r]); after[r] = val(ev.after[r]); }
  const changed = shown.filter((r) => unsignedOf(ev.before[r], width) !== unsignedOf(ev.after[r], width));
  return { id, kind: 'regs', title, say, data: { before, after, changed, width } };
}

/** 'flags' layer; imul leaves SF and ZF undefined, so they are null there */
export function flagsLayer(prog, ev, say) {
  const f = ev.flagsAfter;
  const op = opOf(prog, ev);
  const undef = op === 'imul';
  return {
    id: 'flags', kind: 'flags', title: 'The flags', say,
    data: { CF: f.CF, ZF: undef ? null : f.ZF, SF: undef ? null : f.SF, OF: f.OF, why: flagReasons(prog, ev) },
  };
}

/** the 8 columns base..base+7 of an add/sub event, as an honest addition window */
export function columnsWindow(prog, ev, base) {
  const op = opOf(prog, ev);
  const v = adderView(ev, op);
  const byte = (x) => Number((x >> BigInt(base)) & 0xffn);
  const A = toBits(byte(v.a), 8), B = toBits(byte(v.b), 8);
  const cin0 = v.carryInto(base);
  const sum = addBits(A, B, 8, cin0);
  const carries = sum.carries.slice();
  return { v, A, B, result: sum.result, carries, cout: carries[8], top: base + 8 === v.w };
}

/** 'columns' layer: an 8-bit window (bits base+7 … base) of an add or a − b as a + ~b + 1 */
export function columnsLayer(prog, ev, base, say, { labels = null } = {}) {
  const c = columnsWindow(prog, ev, base);
  const hi = base + 7;
  const range = `bits ${hi}–${base}`;
  return {
    id: 'columns', kind: 'columns', title: `The adder, ${range}`, say,
    data: {
      w: 8, a: c.A, b: c.B, op: c.v.sub ? '-' : '+',
      carries: c.carries, result: c.result, highlight: 7,
      // a carry out of the register's top bit is lost; from a lower window it moves on to the next bit
      dropped: c.top && c.cout === 1,
      // only a window that ends at the register's top bit has a sign column
      signed: c.top,
      base,
      labels: labels || {
        a: `a, ${range}`,
        b: c.v.sub ? `~b, ${range}` : `b, ${range}`,
        r: `result, ${range}`,
      },
    },
  };
}

/** full-adder wires for one column */
export function adderWires(a, b, cin) {
  const x1 = a ^ b, a1 = a & b, a2 = x1 & cin;
  return { a, b, cin, x1, a1, a2, sum: x1 ^ cin, cout: a1 | a2 };
}

/** 'adder' layer for bit `col` of an add/sub event */
export function adderLayer(prog, ev, col, say) {
  const op = opOf(prog, ev);
  const v = adderView(ev, op);
  const d = adderWires(bit(v.a, col), bit(v.b, col), v.carryInto(col));
  return { id: 'adder', kind: 'adder', title: `Full adder, bit ${col}`, say, data: d };
}

/** the standard two sentences for the sign column's full adder */
export function signAdderSay(prog, ev) {
  const op = opOf(prog, ev);
  const v = adderView(ev, op);
  const top = v.w - 1;
  const d = adderWires(bit(v.a, top), bit(v.b, top), v.carryInto(top));
  const first = `In the sign column (bit ${top}) the full adder gets a = ${d.a}, b = ${d.b} and carry-in ${d.cin}, so sum = ${d.sum} and carry out = ${d.cout}.`;
  const of = d.cin ^ d.cout;
  const second = v.sub
    ? `CF = NOT carry out = ${1 - d.cout} (the borrow), and OF = carry-in XOR carry out = ${of}.`
    : `CF = carry out = ${d.cout}, and OF = carry-in XOR carry out = ${of}.`;
  return [first, second];
}

/** 'shift' layer for a shl / shr / sar event (full register width) */
export function shiftLayer(prog, ev, say) {
  const op = opOf(prog, ev);
  const w = ev.width || 32;
  const k = Number(ev.b);
  const before = toBitsBig(ev.a, w), after = toBitsBig(ev.r, w);
  const dir = op === 'shl' ? 'L' : 'R';
  const fill = op === 'sar' ? before[w - 1] : 0;
  const lost = [];
  if (dir === 'L') for (let i = Math.max(0, w - k); i < w; i++) lost.push(i);
  else for (let i = 0; i < Math.min(k, w); i++) lost.push(i);
  return { id: 'shift', kind: 'shift', title: `${op} by ${k}`, say, data: { w, before, after, dir, k, fill, lost } };
}

function toBitsBig(v, w) {
  const u = unsignedOf(v, w);
  return Array.from({ length: w }, (_, i) => Number((u >> BigInt(i)) & 1n));
}

// ---------------------------------------------------------------------------
// Paste mode
// ---------------------------------------------------------------------------

/**
 * Compile and run pasted C with a full trace. Throws the engine's CError
 * (with line/col/kind) for code it can't run.
 * Returns { src, prog, res, events } where `events` is the list of variable
 * writes in execution order: { k, n, line, v, name, type, val, nth, times,
 * surprise: { tag, n } | null, key: trace index of the instruction that explains it }.
 */
export function analyzePaste(src) {
  const prog = compile(String(src ?? ''));
  const res = run(prog, { trace: true, traceLimit: TRACE_LIMIT });
  return { src: prog.src ?? String(src), prog, res, events: writeEvents(prog, res) };
}

const cValue = (pattern, type) => {
  const t = TYPES[type];
  return t.signed ? BigInt.asIntN(t.bits, big(pattern)) : BigInt.asUintN(t.bits, big(pattern));
};

function writeEvents(prog, res) {
  const out = [];
  const seen = new Map();
  let from = 0;
  const evs = res.events || [];
  evs.forEach((ev, n) => {
    if (!ev.write || ev.write.v === undefined) return;
    const vr = prog.vars[ev.write.v];
    if (!vr || vr.size * 8 !== ev.write.width) return;
    // the instructions that computed this value: same line, since the previous write
    const win = [];
    for (let j = from; j < n; j++) if (evs[j].line === ev.line) win.push(j);
    from = n + 1;
    const key = `${ev.line}|${vr.id}`;
    const nth = (seen.get(key) || 0) + 1;
    seen.set(key, nth);
    const val = cValue(ev.write.val, vr.type);
    // i++ and x += k compile to one instruction that computes AND stores (add DWORD PTR
    // [rbp-4], 1), so the write event itself belongs to the window when it is an ALU op
    if (prog.insts[ev.i].alu) win.push(n);
    const surprise = surpriseOf(prog, evs, win, n, vr, val);
    const lastAlu = [...win].reverse().find((j) => prog.insts[evs[j].i].alu);
    out.push({
      k: out.length, n, line: ev.line, v: vr.id, name: vr.name, type: vr.type, val: plain(val), nth, times: 0,
      surprise, key: surprise ? surprise.n : lastAlu ?? n,
      constant: win.length === 0 && typeof prog.insts[ev.i].b === 'number',
    });
  });
  if (res.eventsTruncated) extendPastTrace(prog, res, out, seen);
  // how often each (line, variable) store ran in the WHOLE run, not just the traced part
  for (const w of out) if (!w.final) w.times = storeCount(prog, res, w.line, prog.vars[w.v]) || seen.get(`${w.line}|${w.v}`);
  // the last entry of each variable: "what is x at the end?" is the easiest question in a long run
  const lastOf = new Map();
  out.forEach((w, k) => lastOf.set(w.v, k));
  for (const w of out) w.last = lastOf.get(w.v) === w.k;
  return out;
}

// ---------------------------------------------------------------------------
// Beyond the trace: a long loop can run past TRACE_LIMIT instructions. The
// engine still records statement-level writes (res.steps, first 5000 steps),
// each variable's final value (finalVars) and, per ALU instruction, its first
// and last three results with flags (aluLog). Writes rebuilt from those have no
// trace event (n = null); traps are recognised from the aluLog records.
// ---------------------------------------------------------------------------

const STEP_CAP = 5000;            // minic.js keeps the first 5000 steps

/** a trap in one aluLog record (the rules of surpriseOf, without the node types) */
function surpriseFromRec(prog, i, rec) {
  const ins = prog.insts[i];
  const op = ins.op;
  const w = rec.width;
  const f = rec.flags || {};
  if (['add', 'sub', 'imul', 'neg'].includes(op) && rec.signed && f.OF) return 'c_signed_overflow';
  if ((op === 'add' || op === 'sub') && !rec.signed && f.CF) return 'c_unsigned_wrap';
  if (op === 'idiv' && rec.b !== null && rec.b !== undefined) {
    const x = signedOf(rec.a, w), y = signedOf(rec.b, w);
    if (y !== 0n && x % y !== 0n && (x < 0n) !== (y < 0n)) return 'c_truncating_division';
  }
  if (op === 'sar' && signedOf(rec.a, w) < 0n && big(rec.b) > 0n) return 'c_shift_negative';
  return null;
}

/** the aluLog records of the ALU instructions on `line`, as [{ i, rec }] */
function recsOnLine(prog, res, line, pickRecs) {
  const out = [];
  for (const [i, e] of res.aluLog || []) {
    const ins = prog.insts[i];
    if (!ins || ins.line !== line) continue;
    for (const rec of pickRecs(e)) out.push({ i, rec });
  }
  return out.sort((x, y) => x.i - y.i);
}

/** turn a trap found in an aluLog record into the untraced write's surprise */
function recSurprise(prog, found) {
  for (const { i, rec } of found) {
    const tag = surpriseFromRec(prog, i, rec);
    if (tag) return { tag, n: null, alu: { i, rec } };
  }
  return null;
}

/** a synthetic trace event from an aluLog record (no registers), for the Why layers */
function recEvent(prog, { i, rec }) {
  const ins = prog.insts[i];
  const w = rec.width;
  const ev = { n: null, i, line: ins.line, text: ins.text, width: w, a: unsignedOf(rec.a, w), r: unsignedOf(rec.r, w), flagsAfter: { ...rec.flags } };
  if (rec.b !== null && rec.b !== undefined) ev.b = unsignedOf(rec.b, w);
  return ev;
}

function extendPastTrace(prog, res, out, seen) {
  const add = (w) => { out.push({ k: out.length, n: null, nth: null, times: null, key: null, constant: false, traced: false, ...w }); };
  // 1. statement-level writes after the last traced one (they share the trace's order)
  const flat = [];
  (res.steps || []).forEach((st, si) => st.writes.forEach((w) => flat.push({ ...w, line: st.line, step: si })));
  const aligned = out.every((w, k) => flat[k] && flat[k].v === w.v && big(flat[k].val) === big(w.val));
  const capped = (res.steps || []).length >= STEP_CAP;
  if (aligned) {
    for (const f of flat.slice(out.length)) {
      const key = `${f.line}|${f.v}`;
      const nth = (seen.get(key) || 0) + 1;
      seen.set(key, nth);
      // once the steps are capped, every later record carries the last step number, so it can't be matched
      const exact = !(capped && f.step >= STEP_CAP - 1);
      const found = exact ? recsOnLine(prog, res, f.line, (e) => [e.first, ...e.last].filter((r) => r && r.step === f.step)) : [];
      add({ line: f.line, v: f.v, name: f.name, type: f.type, val: f.val, nth, surprise: recSurprise(prog, found) });
    }
  }
  // 2. each variable's value at the end, when the recorded writes stop short of the end
  //    (then "the last recorded write" is not the last write, so every variable gets one)
  if (aligned && !capped) return;                 // every write is already in the list
  for (const vr of prog.vars) {
    if (!res.finalVars || !res.finalVars.has(vr.id)) continue;
    const fin = res.finalVars.get(vr.id);
    const line = lastStoreLine(prog, res, vr);
    if (line === null) continue;
    const found = recsOnLine(prog, res, line, (e) => (e.last.length ? [e.last[e.last.length - 1]] : []));
    add({ line, v: vr.id, name: vr.name, type: vr.type, val: plain(big(fin)), final: true, surprise: recSurprise(prog, found) });
  }
}

/** a store instruction into vr's stack slot, at vr's full width (as the engine records writes) */
const storesInto = (ins, vr) => {
  const dst = ins.a;
  return !!dst && typeof dst === 'object' && dst.m && dst.d === vr.d && dst.w === vr.size * 8;
};

/** how many times the stores into vr on `line` ran (execCount is per instruction, never truncated) */
function storeCount(prog, res, line, vr) {
  if (!res.execCount || !vr) return 0;
  let n = 0;
  for (const ins of prog.insts) if (ins.line === line && storesInto(ins, vr)) n += res.execCount[ins.i] || 0;
  return n;
}

/**
 * The line of the store that most likely gave vr its final value: among the
 * store instructions into vr's stack slot that ran, the last in program order
 * (a loop's body and increment come before the code after the loop).
 */
function lastStoreLine(prog, res, vr) {
  let best = null;
  for (const ins of prog.insts) {
    if (!storesInto(ins, vr)) continue;
    if (res.execCount && !res.execCount[ins.i]) continue;
    if (!best || ins.i > best.i) best = ins;
  }
  return best ? best.line : null;
}

/** the declared type of a variable named in an expression (the latest declaration wins) */
function varType(prog, name, line) {
  const c = prog.vars.filter((v) => v.name === name && v.line <= line);
  return c.length ? c[c.length - 1].ctype : null;
}
const exprType = (prog, e, line) => (!e ? null : e.ty || (e.k === 'num' ? e.type : e.k === 'var' ? varType(prog, e.name, line) : null));

/** the assigned expression of a store's statement, when there is one */
function storedExpr(ins, vr) {
  const s = ins.node;
  if (!s) return null;
  if (s.k === 'decl') return s.items.find((it) => it.name === vr.name && it.line === vr.line)?.init || null;
  if (s.k === 'assign' && s.op === '=') return s.e;
  return null;
}

/**
 * Recognise the CS:APP traps in the instructions that produced one write:
 * signed overflow, unsigned wrap, truncating division, arithmetic shift of a
 * negative value, a signed/unsigned comparison, and value-changing stores.
 */
function surpriseOf(prog, evs, win, n, vr, val) {
  for (const j of win) {
    const e = evs[j];
    const ins = prog.insts[e.i];
    const alu = ins.alu;
    if (!alu) continue;
    const w = e.width || alu.width;
    const op = ins.op;
    if ((op === 'add' || op === 'sub' || op === 'imul' || op === 'neg') && alu.signed && e.flagsAfter.OF) return { tag: 'c_signed_overflow', n: j };
    if ((op === 'add' || op === 'sub') && !alu.signed && e.flagsAfter.CF) return { tag: 'c_unsigned_wrap', n: j };
    if (op === 'idiv' && e.b !== undefined) {
      const x = signedOf(e.a, w), y = signedOf(e.b, w);
      if (y !== 0n && x % y !== 0n && (x < 0n) !== (y < 0n)) return { tag: 'c_truncating_division', n: j };
    }
    if (op === 'sar' && signedOf(e.a, w) < 0n && big(e.b) > 0n) return { tag: 'c_shift_negative', n: j };
    if (op === 'cmp' && !alu.signed && alu.node && alu.node.l && alu.node.r) {
      const lt = exprType(prog, alu.node.l, e.line), rt = exprType(prog, alu.node.r, e.line);
      const neg = (t, x) => t && t.signed && signedOf(x, w) < 0n;
      if (neg(lt, e.a) || neg(rt, e.b)) return { tag: 'c_usual_conversions', n: j };
    }
  }
  // a store that changed the value: narrowing or a conversion to unsigned
  const ev = evs[n];
  const ins = prog.insts[ev.i];
  const t = TYPES[vr.type];
  const e = storedExpr(ins, vr);
  let pre = null;
  if (e && e.k === 'num') pre = big(e.v);
  else if (e) {
    const et = exprType(prog, e, ev.line);
    const src = typeof ins.b === 'string' ? FAMILY[ins.b] : null;
    if (et && src) {
      const W = et.bits > 32 ? 64 : 32;
      pre = et.signed ? signedOf(ev.before[src], W) : unsignedOf(ev.before[src], W);
    }
  } else {
    // compound assignment or ++/--: the last ALU result, read in its own type
    // (cmp and test compute a − b or a & b only for the flags, so their result is never stored)
    const j = [...win].reverse().find((x) => prog.insts[evs[x].i].alu && evs[x].r !== undefined && !['cmp', 'test'].includes(prog.insts[evs[x].i].op));
    if (j !== undefined) {
      const a = evs[j], al = prog.insts[a.i].alu;
      pre = al.signed ? signedOf(a.r, a.width || al.width) : unsignedOf(a.r, a.width || al.width);
    }
  }
  if (pre === null || pre === val) return null;
  let tag = 'c_narrowing';
  if (!t.signed && pre < 0n) tag = 'c_unsigned_wrap';
  else if (vr.type === 'char' && pre >= 128n && pre <= 255n) tag = 'c_char_signedness';
  return { tag, n, pre: plain(pre) };
}

/** marking for a predicted output: one cell per expected line, plus the whole */
export function markOutput(res, predicted) {
  const want = normOutput(res.output);
  const got = normOutput(predicted);
  const W = want === '' ? [] : want.split('\n');
  const G = got === '' ? [] : got.split('\n');
  const n = Math.max(W.length, G.length);
  const lines = [];
  for (let i = 0; i < n; i++) {
    if (i >= G.length) lines.push('missing');
    else if (i >= W.length) lines.push('extra');
    else lines.push(G[i] === W[i] ? 'ok' : 'bad');
  }
  const correct = got === want;
  const idx = lines.findIndex((s) => s !== 'ok');
  const right = lines.filter((s) => s === 'ok').length;
  return {
    correct,
    cells: { output: correct ? 'ok' : got === '' && want !== '' ? 'missing' : 'bad', lines },
    firstWrong: correct ? null : { field: 'output', index: Math.max(0, idx) },
    score: { right: correct ? Math.max(1, right) : right, total: Math.max(1, W.length) },
  };
}

/** prior weight of "the learner's model first breaks here" */
const weightOf = (w) => (w.surprise ? 12 : w.constant ? 0.25 : 1);

/** a checkpoint reply as a BigInt, or null when it is not a whole number ('abc', NaN, 1.5) */
function replyInt(ans) {
  if (typeof ans === 'bigint') return ans;
  if (typeof ans === 'number') return Number.isInteger(ans) ? BigInt(ans) : null;
  const t = String(ans ?? '').trim().replace(/[−–]/g, '-');
  return /^-?\d+$/.test(t) ? BigInt(t) : null;
}
const sameNumber = (ans, val) => { const g = replyInt(ans); return g !== null && g === big(val); };

/**
 * Weighted bisection over writes lo+1 … hi (hi = n stands for "only the output
 * differs"): probe the write that best halves the remaining weight.
 */
function nextProbe(writes, lo, hi, skip) {
  const n = writes.length;
  const wt = (k) => (k === n ? 1 : weightOf(writes[k]));
  // in a long run only ask questions a learner can answer without replaying the loop by
  // hand: a variable's last value, a line that runs once, or a recognised trap
  const askable = n <= LONG_RUN ? () => true : (k) => { const w = writes[k]; return w.last || w.final || w.times === 1 || !!w.surprise; };
  let total = 0;
  for (let k = lo + 1; k <= hi; k++) total += wt(k);
  let best = null, bestGap = Infinity, left = 0;
  for (let k = lo + 1; k < hi; k++) {
    left += wt(k);
    if (skip.has(k) || !askable(k)) continue;
    const gap = Math.abs(left - (total - left));
    if (gap < bestGap) { best = k; bestGap = gap; }
  }
  return best;
}

function replay(writes, cpAnswers) {
  let lo = -1, hi = writes.length;
  const skip = new Set();
  const asked = [];
  for (let q = 0; q < MAX_CHECKPOINTS; q++) {
    const k = nextProbe(writes, lo, hi, skip);
    if (k === null) break;
    if (q >= cpAnswers.length) return { next: k, q, lo, hi, asked };
    const ans = cpAnswers[q];
    skip.add(k);
    asked.push({ k, ans });
    if (replyInt(ans) === null) continue;                    // "Not sure" (or no number at all) is not evidence
    if (sameNumber(ans, writes[k].val)) lo = k; else hi = k;
  }
  return { next: null, lo, hi, asked };
}

/** ' (the 3rd time it runs)' when the line runs more than once (times is null past the trace) */
const whenOf = (w) => (w.nth && (w.times > 1 || (w.times === null && w.nth > 1)) ? ` (the ${ordinal(w.nth)} time it runs)` : '');

function checkpointFor(w, q) {
  return {
    id: `paste-cp${q}`,
    prompt: w.final ? `What value does ${w.name} end up with?` : `What is ${w.name} after line ${w.line}${whenOf(w)}?`,
    input: { kind: 'number' },
    // beyond ±2^53 a Number would show the wrong digits, so the exact BigInt is kept
    answer: w.val,
    line: w.line, event: w.k,
  };
}

/** the trace event of a trap, or one rebuilt from its aluLog record past the trace */
function trapEvent(analysis, s) {
  if (s.n !== null && s.n !== undefined) return analysis.res.events[s.n] || null;
  return s.alu ? recEvent(analysis.prog, s.alu) : null;
}

/** the event that explains a write past the trace: its trap, else the line's last ALU result */
function untracedEvent(analysis, w) {
  if (w.surprise?.alu) return recEvent(analysis.prog, w.surprise.alu);
  const found = recsOnLine(analysis.prog, analysis.res, w.line, (e) => (e.last.length ? [e.last[e.last.length - 1]] : []))
    .filter(({ i }) => !['cmp', 'test'].includes(analysis.prog.insts[i].op));
  return found.length ? recEvent(analysis.prog, found[found.length - 1]) : null;
}

/** the specific 1–2 sentence explanation of a recognised trap at one write */
function surpriseDetail(analysis, w) {
  const { prog, res } = analysis;
  const s = w.surprise;
  const e = trapEvent(analysis, s);
  if (!e) return `The machine stores ${w.val} in ${w.name} (${w.type}) here.`;
  const ins = prog.insts[e.i];
  const width = e.width || ins.alu?.width || 32;
  const t = TYPES[w.type];
  switch (s.tag) {
    case 'c_signed_overflow':
      return `The true result does not fit in a ${width}-bit signed integer, so ${ins.op} wraps round to ${signedOf(e.r, width)}. In C signed overflow is undefined behaviour, and gcc -O0 on x86-64 just wraps.`;
    case 'c_unsigned_wrap':
      if (s.pre !== undefined) return `${w.name} is ${w.type}, so it can't hold ${s.pre}: the value wraps round modulo 2^${t.bits} to ${w.val}.`;
      return `Unsigned arithmetic works modulo 2^${width}, so the result wraps round to ${unsignedOf(e.r, width)} instead of ${ins.op === 'sub' ? 'going below 0' : 'growing past the maximum'}.`;
    case 'c_truncating_division': {
      // BigInt division truncates toward zero, exactly as C and idiv do
      const x = signedOf(e.a, width), y = signedOf(e.b, width);
      const q = x / y, rem = x % y;
      return `C division truncates toward zero, so ${signedOf(e.a, width)} / ${signedOf(e.b, width)} gives ${q} with remainder ${rem}. The remainder has the sign of the number being divided.`;
    }
    case 'c_shift_negative':
      return `>> on a negative signed value compiles to sar, which copies the sign bit in, so ${signedOf(e.a, width)} >> ${e.b} is ${signedOf(e.r, width)}. That is the division rounded down, and it stays negative.`;
    case 'c_usual_conversions':
      return `This comparison mixes signed and unsigned, so the signed value is converted to unsigned first: ${signedOf(e.a, width)} is compared as ${unsignedOf(e.a, width)}.`;
    case 'c_char_signedness':
      return `Plain char is signed on x86-64 gcc (-128 to 127), so storing ${s.pre} keeps its 8 bits, which read as ${w.val}.`;
    default:
      return `${w.name} is ${w.type} (${t.bits} bits), so only the low ${t.bits} bits of ${s.pre} are kept, giving ${w.val}.`;
  }
}

/** the line of the last printf call that ran (for output printed after the recorded steps) */
function lastPrintfLine({ prog, res }) {
  let best = null;
  for (const ins of prog.insts) if (ins.op === 'call' && res.execCount?.[ins.i] && (!best || ins.i > best.i)) best = ins;
  return best ? best.line : null;
}

/** where the printed output first differs, when every value was right */
function outputDiagnosis(analysis, predicted) {
  const { res } = analysis;
  const want = normOutput(res.output).split('\n');
  const got = normOutput(predicted).split('\n');
  let i = 0;
  while (i < want.length && want[i] === got[i]) i++;
  // find the step (printf call) that printed line i
  let seen = 0, line = null;
  for (const st of res.steps) {
    if (!st.out) continue;
    seen += (st.out.match(/\n/g) || []).length;
    if (seen > i || (seen === i && !st.out.endsWith('\n'))) { line = st.line; break; }
  }
  if (line === null) line = lastPrintfLine(analysis) ?? res.steps.filter((s) => s.out).at(-1)?.line ?? 1;
  return {
    tag: 'other',
    headline: `Line ${line} prints something different from your prediction.`,
    detail: analysis.events.length
      ? 'The values you gave match the machine, so the difference is in what is printed. Check each % conversion: %d reads the bits as signed, %u as unsigned.'
      : 'This program prints expressions directly, so work through the expression on that line one operation at a time.',
    focus: { line },
  };
}

/**
 * diagnosePaste(analysis, predicted, cpAnswers) → { next, diagnosis }.
 * Bisection over the variable writes (≤ 3 checkpoints); the final diagnosis is
 * 'trace_value', or a c_* tag when the write where the model breaks is a known trap.
 */
export function diagnosePaste(analysis, predicted, cpAnswers = []) {
  const m = markOutput(analysis.res, predicted);
  const finish = (d) => ({ next: null, diagnosis: d });
  if (m.correct) return finish({ tag: null, headline: 'Your prediction matches the machine.', detail: 'Every line of output is the same as what the program printed.', focus: {} });
  if (normOutput(predicted) === '') {
    return finish({ tag: null, headline: "You didn't predict any output.", detail: 'Write what you think each printf shows, one line per \\n.', focus: {} });
  }
  const writes = analysis.events;
  if (!writes.length) return finish(outputDiagnosis(analysis, predicted));
  const r = replay(writes, cpAnswers);
  if (r.next !== null) return { next: checkpointFor(writes[r.next], r.q), diagnosis: null };

  const n = writes.length;
  if (r.lo === n - 1) return finish(outputDiagnosis(analysis, predicted));
  // candidates for the first break: lo+1 … hi (hi confirmed, unless it is the output)
  const last = Math.min(r.hi, n - 1);
  let k = null;
  for (let j = r.lo + 1; j <= last; j++) if (writes[j].surprise) { k = j; break; }
  if (k === null) k = r.hi < n ? r.hi : r.lo + 1;
  const w = writes[k];
  const confirmed = k === r.hi && r.hi - r.lo === 1;
  const when = whenOf(w);
  const headline = w.final
    ? `By the end of the run ${w.name} holds ${w.val}, last set on line ${w.line}.`
    : confirmed
      ? `Your model first differs at line ${w.line}${when}: ${w.name} becomes ${w.val}.`
      : `Your model most likely parts ways at line ${w.line}${when}, where ${w.name} becomes ${w.val}.`;
  const tag = w.surprise ? w.surprise.tag : 'trace_value';
  const detail = w.surprise
    ? surpriseDetail(analysis, w)
    : `The machine stores ${w.val} in ${w.name} (${w.type}) here. Open "Why?" to follow that value through the instructions.`;
  return finish({ tag, headline, detail, focus: { line: w.line, event: k } });
}

/** the trace event that best explains a line (a trap first, then any ALU op, then the first) */
function eventForLine(analysis, line) {
  const { prog, res } = analysis;
  const evs = (res.events || []).map((e, n) => ({ e, n })).filter((x) => x.e.line === line);
  const alu = evs.filter((x) => prog.insts[x.e.i].alu && x.e.a !== undefined);
  const trap = alu.find((x) => x.e.flagsAfter.OF || ['idiv', 'sar'].includes(prog.insts[x.e.i].op));
  return (trap || alu[0] || evs[0])?.n ?? null;
}

/**
 * whyPaste(analysis, diagnosis) → Layer[] for the statement in focus:
 * line → asm → regs → flags / columns / adder (add, sub, cmp) or shift.
 */
export function whyPaste(analysis, diagnosis) {
  const { prog, res, src } = analysis;
  const f = diagnosis?.focus || {};
  const w = Number.isInteger(f.event) ? analysis.events[f.event] : null;
  const line = w ? w.line : f.line;
  if (!line) return [];
  const n = w ? w.key : eventForLine(analysis, line);
  // past the trace there are no registers, only the ALU record of the line's last run
  const ev = w && w.n === null ? untracedEvent(analysis, w) : n === null || n === undefined ? null : res.events[n];
  const code = String(src).split('\n')[line - 1]?.trim() ?? '';
  const layers = [lineLayer(src, line, w
    ? [`Line ${line} is where ${w.name} gets ${w.final ? 'its final value' : 'the value'} ${w.val}.`, `It is ${/^[aeiou]/.test(w.type) ? 'an' : 'a'} ${w.type}, so it holds ${TYPES[w.type].bits} bits.`]
    : [`Line ${line} is where the output first differs.`], code)];
  if (!ev) return layers;
  const ins = prog.insts[ev.i];
  const op = ins.op;
  layers.push(asmLayer(prog, {
    lines: line, hot: ins.i,
    say: [`The marked instruction, ${ins.text}, is the one that decides this value.`],
  }));
  const width = ev.width || 32;
  if (ev.write && !ins.alu) {
    const src64 = typeof ins.b === 'string' ? FAMILY[ins.b] : null;
    layers.push(regsLayer(ev, src64
      ? [`The store writes only the low ${ev.write.width} bits of ${src64} to memory: ${hexOf(ev.write.val, ev.write.width)}.`]
      : [`The store writes the constant ${hexOf(ev.write.val, ev.write.width)} straight to memory.`], { names: src64 ? [src64] : ['rax'] }));
    return layers;
  }
  const regName = regsIn(ins.text)[0] || 'rax';
  if (ev.before) layers.push(regsLayer(ev, ev.r !== undefined
    ? [`${ins.text.split(' ')[0]} works on ${width}-bit values and gives ${hexOf(ev.r, width)}, which is ${signedOf(ev.r, width)} signed or ${unsignedOf(ev.r, width)} unsigned.`]
    : [`${regName} before and after ${ins.text}.`]));
  if (isAddSub(op) && ev.b !== undefined) {
    const fr = flagReasons(prog, ev);
    layers.push(flagsLayer(prog, ev, [fr.CF, fr.OF]));
    const base = width - 8;
    const cw = columnsWindow(prog, ev, base);
    layers.push(columnsLayer(prog, ev, base, [
      `This is the top byte (bits ${width - 1}–${base}) of the ${cw.v.sub ? 'subtraction, done as a + ~b + 1' : 'addition'}; a carry of ${cw.carries[0]} comes in from bit ${base - 1}.`,
      `The carry out of bit ${width - 1} is ${cw.cout}${cw.v.sub ? `, so CF (the borrow) is ${1 - cw.cout}` : cw.cout ? ', which has nowhere to go, so CF = 1' : ', so CF = 0'}.`,
    ]));
    layers.push(adderLayer(prog, ev, width - 1, signAdderSay(prog, ev)));
  } else if (op === 'imul') {
    layers.push(flagsLayer(prog, ev, [flagReasons(prog, ev).CF, 'SF and ZF are undefined after imul, so they are not shown.']));
  } else if (op === 'sar' || op === 'shr' || op === 'shl') {
    layers.push(shiftLayer(prog, ev, [op === 'sar'
      ? `sar copies the sign bit (${bit(ev.a, width - 1)}) into the gap; the bits that fall off the right are lost.`
      : `${op} fills the gap with 0s; the bits that fall off the end are lost.`]));
  }
  return layers;
}
