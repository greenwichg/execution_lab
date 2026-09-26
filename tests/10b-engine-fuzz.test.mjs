// Differential fuzzing of the C engine (machine/src/engine/minic.js).
//
// A seeded generator writes small random Mini-C programs that mix every integer
// type, casts, suffixed constants, all the arithmetic, bitwise, shift, comparison
// and logical operators, ?:, compound assignments, ++/-- and printf. Each program
// must print and return exactly what gcc -O0 -fwrapv gives, and its machine code
// must be byte-for-byte what GNU as assembles from the engine's own text.
//
// The generator tracks C types itself (independently of the engine) so it can
// keep shift counts in range and pick printf conversions that match the
// argument, which keeps every program free of undefined behaviour that gcc
// could exploit. Divisions are not guarded: when the engine reports a divide
// error, gcc must crash with SIGFPE too (checked separately).
//
// For speed, programs are batched: one C file holds many programs as functions,
// and one assembler file holds many programs between nm-visible labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { compile, run, CError } from '../machine/src/engine/minic.js';
import { mulberry32, randInt, pick, chance } from '../machine/src/lib/rng.js';

const have = (cmd) => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };
const HAVE_GCC = have('gcc'), HAVE_AS = have('as') && have('objcopy') && have('nm');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-fuzz-'));

// FUZZ_N / FUZZ_SEED run a longer campaign by hand (e.g. FUZZ_N=5000); the default stays fast for CI
const N_PROGRAMS = Number(process.env.FUZZ_N) || 300;
const FIRST_SEED = Number(process.env.FUZZ_SEED) || 0x5eed;
const BATCH = 50;

// ------------------------------------------------------------ the generator's own model of C types

const T = {
  char: { bits: 8, signed: true, rank: 1 },
  'signed char': { bits: 8, signed: true, rank: 1 },
  'unsigned char': { bits: 8, signed: false, rank: 1 },
  short: { bits: 16, signed: true, rank: 2 },
  'unsigned short': { bits: 16, signed: false, rank: 2 },
  int: { bits: 32, signed: true, rank: 3 },
  'unsigned int': { bits: 32, signed: false, rank: 3 },
  long: { bits: 64, signed: true, rank: 4 },
  'unsigned long': { bits: 64, signed: false, rank: 4 },
};
const TYPE_NAMES = Object.keys(T);
// alternative spellings, so the parser's type-word handling is exercised too
const SPELLINGS = {
  'unsigned int': ['unsigned', 'unsigned int', 'int unsigned'],
  'unsigned long': ['unsigned long', 'long unsigned', 'unsigned long int'],
  'unsigned short': ['unsigned short', 'short unsigned int'],
  short: ['short', 'short int', 'signed short'],
  long: ['long', 'long int', 'signed long'],
  int: ['int', 'signed', 'signed int'],
};
const spell = (rng, t) => pick(rng, SPELLINGS[t] ?? [t]);
const promote = (t) => (T[t].rank < 3 ? 'int' : t);
function common(a, b) {
  a = promote(a); b = promote(b);
  if (a === b) return a;
  if (T[a].signed === T[b].signed) return T[a].rank >= T[b].rank ? a : b;
  const u = T[a].signed ? b : a, s = T[a].signed ? a : b;
  if (T[u].rank >= T[s].rank) return u;
  return s;          // only long vs unsigned int reaches here: long holds every unsigned int
}

// constants worth hitting: type boundaries and their neighbours
const CONSTS = [0n, 1n, 2n, 3n, 5n, 7n, 9n, 13n, 31n, 100n, 127n, 128n, 200n, 255n, 256n, 1000n, 32767n, 32768n, 65535n,
  65536n, 100000n, 2147483647n, 2147483648n, 3000000000n, 4294967295n, 4294967296n, 1n << 40n, 9223372036854775807n];

/** the type C gives an integer constant (decimal: int, long; hex and octal: also the unsigned ones) */
function constType(v, hex, suffix) {
  const u = /u/i.test(suffix), l = /l/i.test(suffix);
  const cands = u ? (l ? ['unsigned long'] : ['unsigned int', 'unsigned long'])
    : l ? (hex ? ['long', 'unsigned long'] : ['long'])
      : hex ? ['int', 'unsigned int', 'long', 'unsigned long'] : ['int', 'long'];
  return cands.find((t) => v <= (T[t].signed ? (1n << BigInt(T[t].bits - 1)) - 1n : (1n << BigInt(T[t].bits)) - 1n));
}

const BIN_OPS = ['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '<', '<=', '>', '>=', '==', '!=', '&&', '||'];
const CMP = new Set(['<', '<=', '>', '>=', '==', '!=', '&&', '||']);

function makeGen(rng) {
  let vars = [];          // { name, t } in scope
  let nextVar = 0;

  function constant() {
    const v = pick(rng, CONSTS);
    const base = pick(rng, [10, 10, 10, 16, 16, 8]);
    const suffix = pick(rng, ['', '', '', 'u', 'U', 'l', 'L', 'ul', 'UL', 'lu', 'Lu']);
    const t = constType(v, base !== 10, suffix);
    const body = base === 16 ? '0x' + v.toString(16).toUpperCase() : base === 8 && v > 0n ? '0' + v.toString(8) : v.toString();
    return { s: body + suffix, t };
  }
  // <limits.h> names and the types the header gives them
  const MACROS = [['INT_MIN', 'int'], ['INT_MAX', 'int'], ['UINT_MAX', 'unsigned int'], ['LONG_MIN', 'long'],
    ['LONG_MAX', 'long'], ['ULONG_MAX', 'unsigned long'], ['CHAR_MIN', 'int'], ['SCHAR_MAX', 'int'],
    ['UCHAR_MAX', 'int'], ['SHRT_MIN', 'int'], ['USHRT_MAX', 'int'], ['CHAR_BIT', 'int']];
  function leaf() {
    const r = rng();
    if (r < 0.55 && vars.length) { const v = pick(rng, vars); return { s: v.name, t: v.t }; }
    if (r < 0.62) return { s: pick(rng, ["'a'", "'Z'", "'\\n'", "'\\377'", "'\\x7f'", "'0'", "'\\0'", "'\\200'"]), t: 'int' };
    if (r < 0.68) { const [s, t] = pick(rng, MACROS); return { s, t }; }
    return constant();
  }
  /** a shift count that is always in range for a left operand of type lt (after promotion) */
  function shiftCount(lt) {
    const w = T[promote(lt)].bits;
    if (chance(rng, 0.6)) { const k = randInt(rng, 0, w - 1); return { s: String(k), t: 'int' }; }
    const e = expr(1);
    return { s: `(${e.s} & ${w - 1})`, t: common(e.t, 'int') };
  }
  // most divisors are made odd (so never 0) to keep programs running to the end;
  // the rest may be 0 or -1, which exercises the divide-error path
  const divisor = (op, s) => ((op === '/' || op === '%') && chance(rng, 0.6) ? `(${s} | 1)` : s);
  function expr(depth) {
    if (depth <= 0 || chance(rng, 0.25)) return leaf();
    const r = rng();
    if (r < 0.55) {
      const op = pick(rng, BIN_OPS);
      const l = expr(depth - 1);
      if (op === '<<' || op === '>>') {
        const k = shiftCount(l.t);
        return { s: `(${l.s} ${op} ${k.s})`, t: promote(l.t) };
      }
      const rr = expr(depth - 1);
      const t = CMP.has(op) ? 'int' : common(l.t, rr.t);
      return { s: `(${l.s} ${op} ${divisor(op, rr.s)})`, t };
    }
    if (r < 0.7) {
      // sometimes a chain of casts: narrowing then widening is where zero/sign extension goes wrong
      const to = pick(rng, TYPE_NAMES), via = chance(rng, 0.35) ? pick(rng, TYPE_NAMES) : null;
      const e = expr(depth - 1);
      return { s: `(${spell(rng, to)})${via ? `(${spell(rng, via)})` : ''}${e.s}`, t: to };
    }
    if (r < 0.82) {
      const op = pick(rng, ['-', '~', '!']);
      const e = expr(depth - 1);
      // "- -5", never "--5" (which C reads as the decrement operator)
      return { s: `${op}${e.s[0] === op ? ' ' : ''}${e.s}`, t: op === '!' ? 'int' : promote(e.t) };
    }
    const c = expr(depth - 1), a = expr(depth - 1), b = expr(depth - 1);
    return { s: `(${c.s} ? ${a.s} : ${b.s})`, t: common(a.t, b.t) };
  }

  // printf: a conversion that matches the promoted argument type
  const CONV = {
    int: ['%d', '%i', '%x', '%X', '%o', '%u', '%hhd', '%hd', '%hu', '%hhx', '%5d', '%-4d|', '%04x', '%+d', '% d', '%.3d', '%#x', '%#o'],
    'unsigned int': ['%u', '%x', '%X', '%o', '%d', '%hu', '%hhu', '%08x', '%#X', '%-9u|'],
    long: ['%ld', '%li', '%lx', '%lu', '%lo', '%+ld', '%20ld', '%#lx', '%.12ld'],
    'unsigned long': ['%lu', '%lx', '%lX', '%lo', '%ld', '%016lx', '%-21lu|'],
  };
  function printfStmt() {
    const n = randInt(rng, 1, 3);
    const parts = [], args = [];
    for (let k = 0; k < n; k++) {
      const e = expr(randInt(rng, 0, 3));
      parts.push(pick(rng, CONV[promote(e.t)]));
      args.push(e.s);
    }
    // an occasional %c of a printable character
    if (chance(rng, 0.1) && vars.length) { parts.push('%c'); args.push(`65 + (${pick(rng, vars).name} & 15)`); }
    return `printf("${parts.join(' ')}\\n", ${args.join(', ')});`;
  }
  function declare() {
    const t = pick(rng, TYPE_NAMES);
    const name = `v${nextVar++}`;
    const init = expr(randInt(rng, 0, 3));
    vars.push({ name, t });
    return `${spell(rng, t)} ${name} = ${init.s};`;
  }
  function assign() {
    const v = pick(rng, vars);
    const r = rng();
    if (r < 0.2) return pick(rng, [`${v.name}++;`, `${v.name}--;`, `++${v.name};`, `--${v.name};`]);
    if (r < 0.35) return `${v.name} = ${expr(3).s};`;
    const op = pick(rng, ['+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);
    if (op === '<<=' || op === '>>=') return `${v.name} ${op} ${shiftCount(v.t).s};`;
    return `${v.name} ${op} ${divisor(op.slice(0, -1), expr(2).s)};`;
  }
  function cond() {
    const l = expr(2), r = expr(2);
    const c = `${l.s} ${pick(rng, ['<', '<=', '>', '>=', '==', '!='])} ${r.s}`;
    return chance(rng, 0.2) ? `${c} ${pick(rng, ['&&', '||'])} ${expr(1).s}` : c;
  }
  function statement(depth, top = true) {
    const r = rng();
    if (!vars.length || (top && r < 0.25)) return [declare()];
    if (r < 0.25) return [assign()];
    if (r < 0.55) return [assign()];
    if (r < 0.75) return [printfStmt()];
    if (depth <= 0) return [assign()];
    if (r < 0.8) {
      // no declarations inside blocks: the generator keeps one flat scope
      const inner = [...statement(depth - 1, false), ...statement(depth - 1, false)];
      const out = [`if (${cond()}) {`, ...inner.map((s) => '  ' + s)];
      if (chance(rng, 0.4)) out.push('} else {', '  ' + assign());
      out.push('}');
      return out;
    }
    if (r < 0.86) {
      // a block with its own variable, which may shadow an outer one of another type
      const saved = vars.slice();
      const shadow = chance(rng, 0.5) ? pick(rng, vars) : null;
      const t = pick(rng, TYPE_NAMES), name = shadow ? shadow.name : `v${nextVar++}`;
      // in C the new name is in scope from its own declarator on, so its initialiser must not mention it
      vars = vars.filter((v) => v.name !== name);
      const init = expr(2);
      vars.push({ name, t });
      const inner = [`${spell(rng, t)} ${name} = ${init.s};`, ...statement(depth - 1, false), printfStmt()];
      vars = saved;
      return ['{', ...inner.map((x) => '  ' + x), '}'];
    }
    if (r < 0.92) {
      // while (1) with continue and break
      const i = `k${nextVar++}`, n = randInt(rng, 2, 5);
      return [`${pick(rng, ['int', 'short', 'unsigned char', 'long'])} ${i} = 0;`, 'while (1) {', `  ${i}++;`,
        `  if (${i} > ${n}) break;`, `  if (${cond()}) continue;`, '  ' + assign(), '}'];
    }
    // a short counted loop
    const i = `k${nextVar++}`;
    const it = pick(rng, ['int', 'unsigned char', 'long', 'short', 'unsigned']);
    const body = [assign(), chance(rng, 0.5) ? printfStmt() : assign()];
    return [`for (${it} ${i} = 0; ${i} < ${randInt(rng, 1, 4)}; ${i}++) {`, ...body.map((s) => '  ' + s), '}'];
  }
  function program() {
    vars = [];
    nextVar = 0;
    const lines = [];
    // some programs have a big frame, so [rbp-disp] needs a 32-bit displacement (beyond -128)
    if (chance(rng, 0.15)) for (let k = randInt(rng, 16, 22); k > 0; k--) lines.push(declare());
    const n = lines.length + randInt(rng, 5, 14);
    while (lines.length < n) lines.push(...statement(1));
    lines.push(`return ${expr(2).s};`);
    return '#include <limits.h>\n' + lines.join('\n');
  }
  return { program };
}

// ------------------------------------------------------------ generate and run in the engine

function generateAll() {
  const programs = [];
  const rejected = [];
  let seed = FIRST_SEED;
  while (programs.length < N_PROGRAMS) {
    const rng = mulberry32(seed++);
    const src = makeGen(rng).program();
    let prog, res, fault = null;
    try { prog = compile(src, { limits: false }); } catch (e) {
      if (e instanceof CError && e.kind === 'limit') continue;      // too many variables: try another seed
      rejected.push({ src, err: e.message });
      continue;
    }
    try { res = run(prog); } catch (e) {
      if (!(e instanceof CError)) throw e;
      if (e.kind !== 'runtime') continue;                           // output or step limit
      fault = e;
    }
    programs.push({ k: programs.length, seed: seed - 1, src, prog, res, fault });
  }
  return { programs, rejected };
}

const { programs: ALL, rejected: REJECTED } = generateAll();
const OK = ALL.filter((p) => !p.fault);
const FAULTS = ALL.filter((p) => p.fault);
const batches = (list) => Array.from({ length: Math.ceil(list.length / BATCH) }, (_, b) => list.slice(b * BATCH, (b + 1) * BATCH));

test('the generator writes C the engine accepts, and mostly non-faulting programs', () => {
  assert.deepEqual(REJECTED, [], 'every generated program compiles');
  assert.equal(ALL.length, N_PROGRAMS);
  assert.ok(OK.length >= N_PROGRAMS * 0.75, `${OK.length} programs ran to completion`);
  // the mix really covers the features
  const all = ALL.map((p) => p.src).join('\n');
  for (const needle of ['INT_M', 'continue', 'break', ')(', 'unsigned char', 'signed char', 'short', 'unsigned long', '<<=', '>>=', '%=', ' ? ', '(unsigned', '%hhd', '%lx', 'UL', '0x', '++', '--', '&&', '||', '~', '!']) {
    assert.ok(all.includes(needle), `programs use ${needle}`);
  }
});

/** one C file with every program in the batch as a function; main prints each one's return value after its output */
function gccBatch(name, list) {
  const src = ['#include <stdio.h>', '#include <limits.h>'];
  for (const p of list) src.push(`static int f${p.k}(void) {`, p.src.replace(/^#.*\n/, ''), '}');
  src.push('int main(void) {', '  int r;');
  for (const p of list) src.push(`  r = f${p.k}();`, `  printf("@@${p.k} %d\\n", r);`);
  src.push('  return 0;', '}', '');
  const c = path.join(tmp, `${name}.c`), exe = path.join(tmp, name);
  fs.writeFileSync(c, src.join('\n'));
  execFileSync('gcc', ['-O0', '-fwrapv', '-w', '-o', exe, c]);
  const out = execFileSync(exe, { encoding: 'utf8', maxBuffer: 1 << 26 });
  const results = new Map();
  let start = 0;
  for (const m of out.matchAll(/@@(\d+) (-?\d+)\n/g)) {
    results.set(+m[1], { out: out.slice(start, m.index), ret: +m[2] });
    start = m.index + m[0].length;
  }
  return results;
}

test(`${N_PROGRAMS} random programs: same output and return value as gcc -O0 -fwrapv`, { skip: !HAVE_GCC && 'gcc not installed' }, () => {
  const bad = [];
  let compared = 0;
  batches(OK).forEach((list, b) => {
    const g = gccBatch(`fuzz${b}`, list);
    for (const p of list) {
      const r = g.get(p.k);
      assert.ok(r, `program ${p.k} ran under gcc`);
      compared++;
      if (r.out !== p.res.output || r.ret !== p.res.ret) bad.push({ seed: p.seed, src: p.src, engine: [p.res.output, p.res.ret], gcc: [r.out, r.ret] });
    }
  });
  assert.deepEqual(bad.slice(0, 3), [], `${bad.length} programs differ from gcc`);
  assert.equal(compared, OK.length);
});

// Dividing by zero (or INT_MIN / -1) is undefined behaviour, so plain gcc may fold it away even at -O0
// (it turns x / x into 1). The engine shows what the idiv instruction does instead. The oracle here is
// gcc's trapping sanitizer, which checks every division before any folding: it must trap (SIGILL)
// exactly where the engine faults.
test('programs where the engine raises a divide error trap under gcc\'s division sanitizer', { skip: !HAVE_GCC && 'gcc not installed' }, () => {
  assert.ok(FAULTS.length > 0, 'some programs fault');
  for (const p of FAULTS.slice(0, Number(process.env.FUZZ_FAULTS) || 12)) {
    const c = path.join(tmp, `fault${p.k}.c`), exe = path.join(tmp, `fault${p.k}`);
    fs.writeFileSync(c, `#include <stdio.h>\n#include <limits.h>\nint main(void) {\n${p.src.replace(/^#.*\n/, '')}\n}\n`);
    execFileSync('gcc', ['-O0', '-fwrapv', '-w', '-fsanitize=integer-divide-by-zero,signed-integer-overflow',
      '-fsanitize-undefined-trap-on-error', '-o', exe, c]);
    const r = spawnSync(exe, { encoding: 'utf8' });
    assert.ok(['SIGILL', 'SIGFPE'].includes(r.signal), `seed ${p.seed}: ${p.fault.message} but gcc: ${r.signal ?? r.status}\n${p.src}`);
    assert.ok(p.fault.line >= 1, 'the fault points at a line');
  }
});

/** GNU as bytes for every program in the batch, sliced apart by nm */
function gasBatch(name, list) {
  const lines = ['.intel_syntax noprefix', '.text'];
  const rodata = [];
  for (const p of list) {
    lines.push(`P${p.k}:`);
    // labels are per program: give each program its own namespace
    const local = (t) => t.replace(/\.L(C?)(\d+)/g, `.L$1${p.k}_$2`);
    for (const x of p.prog.code) lines.push(x.label !== undefined ? `.L${p.k}_${x.label}:` : `  ${local(x.asText)}`);
    p.prog.strings.forEach((s, i) => rodata.push(`.LC${p.k}_${i}: .string ${JSON.stringify(s)}`));
  }
  lines.push('Pend:', '.section .rodata', ...rodata, '');
  const sFile = path.join(tmp, `${name}.s`), oFile = path.join(tmp, `${name}.o`), bFile = path.join(tmp, `${name}.bin`);
  fs.writeFileSync(sFile, lines.join('\n'));
  execFileSync('as', ['--64', '-o', oFile, sFile]);
  execFileSync('objcopy', ['-O', 'binary', '-j', '.text', oFile, bFile]);
  const bin = fs.readFileSync(bFile);
  const nm = execFileSync('nm', [oFile], { encoding: 'utf8' });
  const off = Object.fromEntries(nm.trim().split('\n').map((l) => l.trim().split(/\s+/)).map(([a, , n]) => [n, parseInt(a, 16)]));
  return list.map((p, j) => bin.subarray(off[`P${p.k}`], off[j + 1 < list.length ? `P${list[j + 1].k}` : 'Pend']));
}

test(`${N_PROGRAMS} random programs: every instruction's bytes match GNU as`, { skip: !HAVE_AS && 'binutils not installed' }, () => {
  let checked = 0;
  batches(ALL).forEach((list, b) => {
    const theirs = gasBatch(`fuzz${b}`, list);
    list.forEach((p, j) => {
      const ours = Buffer.from(p.prog.insts.flatMap((i) => i.bytes)).toString('hex');
      if (ours !== theirs[j].toString('hex')) {
        // find the first instruction that differs, for a readable failure
        let at = 0;
        const ins = p.prog.insts.find((i) => { const h = Buffer.from(i.bytes).toString('hex'); const ok = theirs[j].toString('hex').startsWith(h, at); at += h.length; return !ok; });
        assert.fail(`seed ${p.seed}: bytes differ at "${ins?.asText}"\n${p.src}`);
      }
      checked += p.prog.insts.length;
    });
  });
  assert.ok(checked > 20000, `checked ${checked} instructions`);
  assert.ok(ALL.some((p) => p.prog.vars.some((v) => v.d < -128)), 'some programs use 32-bit displacements');
});

// ------------------------------------------------------------ trace events are internally consistent

const M = (w) => (1n << BigInt(w)) - 1n;
const msb = (v, w) => Number((v >> BigInt(w - 1)) & 1n);
const REG_NAMES = ['rax', 'rcx', 'rdx', 'rsi', 'rdi', 'r8', 'r9'];
const FLAG_NAMES = ['CF', 'ZF', 'SF', 'OF'];

/** check one traced event against x86 semantics recomputed from its own operands */
function checkEvent(ev, ins) {
  for (const k of ['before', 'after']) assert.deepEqual(Object.keys(ev[k]).sort(), [...REG_NAMES].sort(), `${k} registers`);
  for (const k of ['flagsBefore', 'flagsAfter']) assert.deepEqual(Object.keys(ev[k]).sort(), [...FLAG_NAMES].sort(), `${k}`);
  for (const r of REG_NAMES) {
    assert.equal(typeof ev.before[r], 'bigint');
    assert.ok(ev.after[r] >= 0n && ev.after[r] <= M(64), `${r} is an unsigned 64-bit pattern`);
  }
  const op = ins.op;
  const aluOps = ['add', 'sub', 'cmp', 'and', 'or', 'xor', 'test', 'imul', 'neg', 'not', 'shl', 'shr', 'sar', 'div', 'idiv'];
  if (!aluOps.includes(op)) return;
  const { a, b, r, width: w } = ev;
  assert.ok([8, 16, 32, 64].includes(w), `${ev.text}: width`);
  assert.equal(typeof a, 'bigint', `${ev.text}: a`);
  assert.equal(typeof r, 'bigint', `${ev.text}: r`);
  assert.ok(a <= M(w) && r <= M(w), `${ev.text}: a and r fit the width`);
  if (op === 'not') assert.equal(b, undefined, 'not has no b');
  else { assert.equal(typeof b, 'bigint', `${ev.text}: b`); }
  const F = ev.flagsAfter;
  const zs = () => { assert.equal(F.ZF, r === 0n ? 1 : 0, `${ev.text}: ZF`); assert.equal(F.SF, msb(r, w), `${ev.text}: SF`); };
  switch (op) {
    case 'add':
      assert.equal(r, (a + b) & M(w));
      zs(); assert.equal(F.CF, a + b > M(w) ? 1 : 0);
      assert.equal(F.OF, msb(a, w) === msb(b, w) && msb(r, w) !== msb(a, w) ? 1 : 0);
      break;
    case 'sub': case 'cmp': case 'neg':
      assert.equal(r, (a - b) & M(w));
      zs(); assert.equal(F.CF, a < b ? 1 : 0, `${ev.text}: CF`);
      assert.equal(F.OF, msb(a, w) !== msb(b, w) && msb(r, w) !== msb(a, w) ? 1 : 0, `${ev.text}: OF`);
      if (op === 'neg') assert.equal(a, 0n);
      break;
    case 'and': case 'or': case 'xor': case 'test':
      assert.equal(r, op === 'or' ? a | b : op === 'xor' ? a ^ b : a & b);
      zs(); assert.equal(F.CF, 0); assert.equal(F.OF, 0);
      break;
    case 'imul': {
      const full = BigInt.asIntN(w, a) * BigInt.asIntN(w, b);
      assert.equal(r, BigInt.asUintN(w, full));
      assert.equal(F.CF, BigInt.asIntN(w, r) === full ? 0 : 1);
      assert.equal(F.OF, F.CF);
      break;
    }
    case 'not': assert.equal(r, ~a & M(w)); assert.deepEqual(F, ev.flagsBefore, 'not leaves the flags'); break;
    case 'shl': case 'shr': case 'sar': {
      const n = Number(b);
      assert.ok(n < w, `${ev.text}: count masked`);
      const want = op === 'shl' ? (a << b) & M(w) : op === 'shr' ? a >> b : BigInt.asUintN(w, BigInt.asIntN(w, a) >> b);
      assert.equal(r, want, ev.text);
      if (n === 0) assert.deepEqual(F, ev.flagsBefore, 'a zero count leaves the flags');
      else {
        zs();
        const cf = op === 'shl' ? (a >> BigInt(w - n)) & 1n : (BigInt.asIntN(w, op === 'sar' ? BigInt.asIntN(w, a) : a) >> BigInt(n - 1)) & 1n;
        assert.equal(F.CF, Number(cf & 1n), `${ev.text}: CF`);
      }
      break;
    }
    case 'div': case 'idiv': {
      const s = op === 'idiv';
      const x = s ? BigInt.asIntN(w, a) : a, y = s ? BigInt.asIntN(w, b) : b;
      assert.equal(ev.q, BigInt.asUintN(w, x / y), `${ev.text}: q`);
      assert.equal(ev.rem, BigInt.asUintN(w, x % y), `${ev.text}: rem`);
      assert.equal(r, ins.alu && ins.alu.op === '%' ? ev.rem : ev.q);
      break;
    }
    default: break;
  }
  // a register destination really holds the result afterwards
  if (!['cmp', 'test', 'div', 'idiv'].includes(op) && typeof ins.a === 'string') {
    const reg = { eax: 'rax', rax: 'rax', ecx: 'rcx', rcx: 'rcx' }[ins.a];
    if (reg) assert.equal(ev.after[reg] & M(w), r, `${ev.text}: destination holds r`);
  } else if (op !== 'cmp' && op !== 'test' && ev.write) {
    assert.equal(ev.write.val, r, `${ev.text}: stored value is r`);
  }
  // the ALU record says which C operator and type the instruction computes
  if (ins.alu) {
    assert.equal(ins.alu.width, w, `${ev.text}: alu width`);
    assert.equal(typeof ins.alu.signed, 'boolean');
  }
}

test('trace events: registers and flags before/after, operands and width agree with x86 semantics', () => {
  let n = 0;
  for (const p of OK.slice(0, 120)) {
    const r = run(p.prog, { trace: true, traceLimit: 3000 });
    assert.equal(r.output, p.res.output, 'tracing does not change the result');
    for (const ev of r.events) {
      const ins = p.prog.insts[ev.i];
      assert.equal(ev.text, ins.text);
      assert.equal(ev.line, ins.line);
      checkEvent(ev, ins);
      if (ev.write) {
        assert.ok([8, 16, 32, 64].includes(ev.write.width));
        const v = p.prog.vars.find((x) => x.id === ev.write.v);
        if (v) assert.equal(v.size * 8, ev.write.width, `${ev.text}: store width is the variable's size`);
      }
      n++;
    }
    // events are numbered in execution order
    r.events.forEach((ev, k) => assert.equal(ev.n, k));
  }
  assert.ok(n > 10000, `${n} events checked`);
});
