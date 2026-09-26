// Predict the Machine's C engine (machine/src/engine/minic.js), checked against
// the real toolchain:
//   · every program's stdout and exit code must match gcc -O0 on x86-64
//   · every instruction's bytes must match what the GNU assembler emits
// (the toolchain checks are skipped automatically when gcc / as are missing)
//
// Why -fwrapv: signed overflow is undefined behaviour in C, so without it gcc may
// assume it never happens. The engine shows what the hardware does (two's
// complement wraparound); the cards label the UB separately. -fwrapv makes gcc
// promise exactly that hardware behaviour, so the comparison is meaningful.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import {
  compile, run, CError, LIMITS, TYPES, promote, commonType, formatPrintf,
} from '../machine/src/engine/minic.js';

const require = createRequire(import.meta.url);
const OLD = require('./programs.cjs');
const TYPED = require('./programs-typed.cjs');
const CORPUS = { ...OLD, ...Object.fromEntries(Object.entries(TYPED).map(([k, v]) => [`t_${k}`, v])) };

const have = (cmd) => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };
const HAVE_GCC = have('gcc'), HAVE_AS = have('as') && have('objcopy') && have('nm');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-'));
// the Lab's corpus predates the 72-column limit (one program has a long line)
const build = (src) => compile(src, { limits: false });

/** bare statements go inside main; #include lines stay at the top */
function gccSource(src) {
  if (/int\s+main\s*\(/.test(src)) return src.includes('#include <stdio.h>') ? src : `#include <stdio.h>\n${src}`;
  const incs = src.split('\n').filter((l) => l.startsWith('#'));
  const body = src.split('\n').filter((l) => !l.startsWith('#'));
  return ['#include <stdio.h>', ...incs, 'int main(void) {', ...body, 'return 0;', '}', ''].join('\n');
}
function runGcc(name, src) {
  const c = path.join(tmp, `${name}.c`), exe = path.join(tmp, name);
  fs.writeFileSync(c, gccSource(src));
  execFileSync('gcc', ['-O0', '-fwrapv', '-w', '-o', exe, c]);
  try {
    return { out: execFileSync(exe, { encoding: 'utf8' }), exit: 0 };
  } catch (e) {
    return { out: e.stdout?.toString() ?? '', exit: e.status };
  }
}

test('corpus size: the Lab programs plus at least 40 typed ones', () => {
  assert.equal(Object.keys(OLD).length, 24);
  assert.ok(Object.keys(TYPED).length >= 40, `${Object.keys(TYPED).length} typed programs`);
  for (const [name, src] of Object.entries(TYPED)) assert.doesNotThrow(() => compile(src), `${name} fits the limits`);
});

for (const [name, src] of Object.entries(CORPUS)) {
  test(`program "${name}": same output and exit code as gcc -O0 -fwrapv`, { skip: !HAVE_GCC && 'gcc not installed' }, () => {
    const r = run(build(src));
    const g = runGcc(name, src);
    assert.equal(r.output, g.out, 'stdout');
    assert.equal(r.exit, g.exit, 'exit code');
  });
}

/** assemble lines with GNU as and return the raw .text bytes */
function gas(name, asmLines) {
  const sFile = path.join(tmp, `${name}.s`), oFile = path.join(tmp, `${name}.o`), bFile = path.join(tmp, `${name}.bin`);
  fs.writeFileSync(sFile, ['.intel_syntax noprefix', '.text', ...asmLines, ''].join('\n'));
  execFileSync('as', ['--64', '-o', oFile, sFile]);
  execFileSync('objcopy', ['-O', 'binary', '-j', '.text', oFile, bFile]);
  return fs.readFileSync(bFile);
}

test('every program assembles to exactly the bytes GNU as produces', { skip: !HAVE_AS && 'binutils not installed' }, () => {
  let checked = 0;
  for (const [name, src] of Object.entries(CORPUS)) {
    const prog = build(src);
    const lines = ['main:'];
    for (const x of prog.code) lines.push(x.label !== undefined ? `.L${x.label}:` : `  ${x.asText}`);
    lines.push('.section .rodata');
    prog.strings.forEach((s, i) => lines.push(`.LC${i}: .string ${JSON.stringify(s)}`));
    const bin = gas(name, lines);
    const ours = Buffer.from(prog.insts.flatMap((i) => i.bytes));
    assert.equal(ours.toString('hex'), bin.toString('hex'), `${name}: bytes differ`);
    checked += prog.insts.length;
  }
  assert.ok(checked > 1500, `checked ${checked} instructions`);
});

test('every distinct instruction text encodes like GNU as on its own', { skip: !HAVE_AS && 'binutils not installed' }, () => {
  const seen = new Map();
  for (const src of Object.values(CORPUS)) {
    for (const ins of build(src).insts) {
      if (ins.target !== undefined) continue;                // jumps are checked in context above
      if (!seen.has(ins.asText)) seen.set(ins.asText, ins.bytes);
    }
  }
  const texts = [...seen.keys()];
  // one label per instruction; nm gives each label's offset, so we can slice the bytes apart
  const bin = gas('distinct', texts.flatMap((t, k) => [`I${k}:`, `  ${t}`]).concat(['Iend:']));
  const nm = execFileSync('nm', [path.join(tmp, 'distinct.o')], { encoding: 'utf8' });
  const off = Object.fromEntries(nm.trim().split('\n').map((l) => l.trim().split(/\s+/)).map(([a, , n]) => [n, parseInt(a, 16)]));
  texts.forEach((t, k) => {
    const theirs = bin.subarray(off[`I${k}`], off[k + 1 < texts.length ? `I${k + 1}` : 'Iend']);
    assert.equal(Buffer.from(seen.get(t)).toString('hex'), theirs.toString('hex'), `"${t}"`);
  });
  // the new encodings the typed corpus must have exercised
  const ops = new Set(texts.map((t) => t.split(' ')[0]));
  for (const op of ['movsx', 'movzx', 'cdqe', 'cqo', 'div', 'idiv', 'shr', 'sar', 'shl', 'setb', 'seta', 'movabs', 'imul', 'neg', 'not']) {
    assert.ok(ops.has(op), `corpus uses ${op}`);
  }
  for (const needle of ['BYTE PTR', 'WORD PTR', 'QWORD PTR', 'rax, rcx', 'cl']) {
    assert.ok(texts.some((t) => t.includes(needle)), `corpus uses ${needle}`);
  }
  assert.ok(texts.length > 150, `${texts.length} distinct instructions`);
});

test('jumps use the unsigned condition codes for unsigned comparisons', () => {
  const texts = (src) => build(src).insts.map((i) => i.asText);
  assert.ok(texts('unsigned a = 1, b = 2;\nif (a < b) a = 3;').some((t) => /^jae /.test(t)));
  assert.ok(texts('int a = 1, b = 2;\nif (a < b) a = 3;').some((t) => /^jge /.test(t)));
  assert.ok(texts('int a = -1;\nint c = a < 0U;').includes('setb al'));
  assert.ok(texts('long a = 5;\nunsigned b = 4;\nint c = a > b;').includes('setg al'));
  assert.ok(texts('unsigned long a = 5;\nlong b = 4;\nint c = a > b;').includes('seta al'));
  for (const [src, cc] of [['<=', 'jbe'], ['>', 'ja'], ['>=', 'jae']]) {
    assert.ok(texts(`unsigned a = 1;\nwhile (a ${src} 9) a++;`).some((t) => t.startsWith(cc + ' ')), `${src} → ${cc}`);
  }
});

test('code looks like gcc -O0: sized loads, stores and extensions', () => {
  const t = build('char c = -3;\nunsigned short s = 7;\nlong l = c;\nunsigned u = s;\nlong m = u;\nint i = l;\nreturn i;').insts.map((x) => x.text);
  assert.ok(t.includes('mov BYTE PTR [rbp-1], -3'));
  assert.ok(t.includes('mov WORD PTR [rbp-4], 7'));
  assert.ok(t.includes('movsx rax, BYTE PTR [rbp-1]'));
  assert.ok(t.includes('movzx eax, WORD PTR [rbp-4]'));
  assert.ok(t.includes('mov QWORD PTR [rbp-16], rax'));
  assert.ok(t.includes('mov eax, DWORD PTR [rbp-20]'));
  const d = build('int a = 7, b = 2;\nunsigned u = 9;\nlong l = 3;\nint q = a / b;\nunsigned r = u % 4U;\nlong z = l / a;').insts.map((x) => x.text);
  assert.ok(d.includes('cdq') && d.includes('idiv DWORD PTR [rbp-8]'));
  assert.ok(d.includes('mov edx, 0') && d.includes('div ecx') && d.includes('mov eax, edx'));
  assert.ok(d.includes('cdqe') && d.includes('cqo') && d.includes('idiv rcx'));
  const x = build('unsigned u = 8;\nint s = -8;\nu = u >> 1;\ns = s >> 1;').insts.map((i) => i.text);
  assert.ok(x.includes('shr eax') || x.includes('shr eax, 1'));
  assert.ok(x.includes('sar eax, 1'));
});

test('types: promotions, usual arithmetic conversions and constants', () => {
  const T = TYPES;
  assert.equal(promote(T.char), T.int);
  assert.equal(promote(T['unsigned short']), T.int);
  assert.equal(commonType(T.int, T['unsigned int']), T['unsigned int']);
  assert.equal(commonType(T.long, T['unsigned int']), T.long);
  assert.equal(commonType(T['unsigned long'], T.int), T['unsigned long']);
  assert.equal(commonType(T['unsigned long'], T.long), T['unsigned long']);
  assert.equal(commonType(T['unsigned char'], T['unsigned short']), T.int);
  const prog = build('unsigned a = 1;\nlong b = 2;\nunsigned long c = 3;\nshort d = 4;\nchar e = 5;\nsigned char f = 6;\nunsigned char g = 7;\nunsigned short h = 8;\nint i = 9;');
  assert.deepEqual(prog.vars.map((v) => [v.name, v.type, v.size]), [
    ['a', 'unsigned int', 4], ['b', 'long', 8], ['c', 'unsigned long', 8], ['d', 'short', 2], ['e', 'char', 1],
    ['f', 'signed char', 1], ['g', 'unsigned char', 1], ['h', 'unsigned short', 2], ['i', 'int', 4],
  ]);
  // natural alignment below rbp, like gcc
  assert.deepEqual(prog.vars.map((v) => v.d), [-4, -16, -24, -26, -27, -28, -29, -32, -36]);
});

test('trace: steps carry typed variable writes; 64-bit values beyond 2^53 are BigInts', () => {
  const prog = build('char c = 200;\nunsigned u = -1;\nlong big = 0x7FFFFFFFFFFFFFFF;\nlong small = -5;\nc++;');
  const r = run(prog);
  const writes = r.steps.flatMap((s) => s.writes);
  assert.deepEqual(writes.map((w) => [w.name, w.type, w.val]), [
    ['c', 'char', -56], ['u', 'unsigned int', 4294967295], ['big', 'long', 9223372036854775807n], ['small', 'long', -5], ['c', 'char', -55],
  ]);
  assert.equal(r.finalVars.get(prog.vars.find((v) => v.name === 'big').id), 9223372036854775807n);
});

test('trace: the Lab\'s step and aluLog shape still works', () => {
  const prog = build(OLD.sum);
  const r = run(prog);
  const total = prog.vars.find((v) => v.name === 'total');
  const writes = r.steps.flatMap((s) => s.writes.filter((w) => w.v === total.id).map((w) => w.val));
  assert.deepEqual(writes, [0, 1, 3, 6, 10, 15, 21, 28, 36, 45, 55]);
  const addIns = prog.insts.find((i) => i.op === 'add' && i.alu && i.alu.op === '+');
  assert.deepEqual([addIns.alu.signed, addIns.alu.width], [true, 32]);
  const log = r.aluLog.get(addIns.i);
  assert.equal(log.n, 10);
  const lastRec = log.last[log.last.length - 1];
  assert.deepEqual([lastRec.a, lastRec.b, lastRec.r], [45, 10, 55]);
  assert.equal(r.output, '55\n');
  assert.equal(r.events, undefined, 'no events without trace');
});

test('trace events: registers, flags for add overflow and cmp, operands', () => {
  const prog = build('int a = 2147483647;\nint b = a + 1;\nunsigned u = 5;\nif (u < 7U) b = 0;\nunsigned char c = 255;\nc = c + 1;\nreturn b;');
  const r = run(prog, { trace: true });
  assert.ok(r.events.length === r.count, 'one event per instruction');
  const ev = r.events.find((e) => e.text.startsWith('add eax'));
  assert.equal(ev.line, 2);
  assert.deepEqual([ev.a, ev.b, ev.r, ev.width], [0x7fffffffn, 1n, 0x80000000n, 32]);
  assert.deepEqual(ev.flagsAfter, { CF: 0, ZF: 0, SF: 1, OF: 1 });
  assert.equal(ev.before.rax, 0x7fffffffn);
  assert.equal(ev.after.rax, 0x80000000n);
  const cmp = r.events.find((e) => e.text.startsWith('cmp'));
  assert.deepEqual([cmp.a, cmp.b, cmp.r, cmp.width], [5n, 7n, 0xfffffffen, 32]);
  assert.deepEqual(cmp.flagsAfter, { CF: 1, ZF: 0, SF: 1, OF: 0 });
  const jump = r.events[r.events.indexOf(cmp) + 1];
  assert.match(jump.text, /^jae /);
  // the char addition happens in int (no carry out at 8 bits), then the store keeps the low byte
  const addC = r.events.filter((e) => e.line === 6 && e.text.startsWith('add eax'))[0];
  assert.deepEqual([addC.a, addC.r, addC.flagsAfter.CF], [255n, 256n, 0]);
  const st = r.events.filter((e) => e.line === 6).at(-1);
  assert.deepEqual([st.text, st.write.val, st.write.width], ['mov BYTE PTR [rbp-13], al', 0n, 8]);
  assert.equal(r.exit, 0);
  // 64-bit registers: sign extension shows in the full rax pattern
  const r2 = run(build('int n = -2;\nlong l = n;\nreturn 0;'), { trace: true });
  const cdqe = r2.events.find((e) => e.text === 'cdqe');
  assert.deepEqual([cdqe.before.rax, cdqe.after.rax], [0xfffffffen, 0xfffffffffffffffen]);
  // traceLimit
  const r3 = run(build(OLD.primes, {}), { trace: true, traceLimit: 50 });
  assert.equal(r3.events.length, 50);
  assert.equal(r3.eventsTruncated, true);
});

test('flags: sub borrow, neg, shifts, logic and imul overflow', () => {
  const ev = (src, re) => run(build(src), { trace: true }).events.find((e) => re.test(e.text));
  assert.deepEqual(ev('int a = 0;\nint b = a - 1;', /^sub eax/).flagsAfter, { CF: 1, ZF: 0, SF: 1, OF: 0 });
  assert.deepEqual(ev('#include <limits.h>\nint a = INT_MIN;\nint b = a - 1;', /^sub eax/).flagsAfter, { CF: 0, ZF: 0, SF: 0, OF: 1 });
  assert.deepEqual(ev('long a = 9223372036854775807;\nlong b = a + 1;', /^add rax/).flagsAfter, { CF: 0, ZF: 0, SF: 1, OF: 1 });
  assert.deepEqual(ev('unsigned a = 4294967295U;\nunsigned b = a + 1;', /^add eax/).flagsAfter, { CF: 1, ZF: 1, SF: 0, OF: 0 });
  assert.deepEqual(ev('int a = -2147483647 - 1;\nint b = -a;', /^neg/).flagsAfter, { CF: 1, ZF: 0, SF: 1, OF: 1 });
  const shr = ev('unsigned a = 3;\nunsigned b = a >> 1;', /^shr/);
  assert.deepEqual([shr.r, shr.flagsAfter.CF], [1n, 1]);
  const sar = ev('int a = -3;\nint b = a >> 1;', /^sar/);
  assert.deepEqual([sar.r, sar.flagsAfter.CF, sar.flagsAfter.SF], [0xfffffffen, 1, 1]);
  const im = ev('int a = 65536;\nint b = a * 65536;', /^imul/);
  assert.deepEqual([im.r, im.flagsAfter.CF, im.flagsAfter.OF], [0n, 1, 1]);
  const div = ev('unsigned a = 4294967295U;\nunsigned b = a / 16U;', /^div/);
  assert.deepEqual([div.a, div.b, div.r], [4294967295n, 16n, 268435455n]);
});

test('printf formatting matches glibc for the supported conversions', () => {
  assert.equal(formatPrintf('%d|%u|%x|%X|%o|%c|%%', [-1n, -1n, 255n, 255n, 8n, 65n]), '-1|4294967295|ff|FF|10|A|%');
  assert.equal(formatPrintf('%hhd %hhu %hd %hu', [200n, 0x1ffn, 40000n, -1n]), '-56 255 -25536 65535');
  assert.equal(formatPrintf('%ld %lu %lx', [0xffffffffffffffffn, 0xffffffffffffffffn, 0x123456789n]), '-1 18446744073709551615 123456789');
  assert.equal(formatPrintf('[%5d][%-5d][%05d][%+d][% d]', [42n, 42n, -42n, 7n, 7n]), '[   42][42   ][-0042][+7][ 7]');
  assert.equal(formatPrintf('[%#x][%#o][%#x][%.3d][%.0d]', [255n, 8n, 0n, 7n, 0n]), '[0xff][010][0][007][]');
});

test('friendly compile errors point at the right place', () => {
  const cases = [
    ['int x = 5\nreturn x;', /Expected ";"/, 2, 'syntax'],
    ['int x = y + 1;', /"y" hasn't been declared/, 1, 'type'],
    ['int x = 1;\nint x = 2;', /already declared/, 2, 'type'],
    ['float f = 1;', /Floating-point.*integer types/, 1, 'syntax'],
    ['double d;', /Floating-point/, 1, 'syntax'],
    ['int x = 1.5;', /Floating-point/, 1, 'syntax'],
    ['int a[3];', /Arrays aren't supported/, 1, 'syntax'],
    ['int x = 1;\nint *p = &x;', /Pointers/, 2, 'syntax'],
    ['int x = 1;\nint y = *x;', /Pointers/, 2, 'syntax'],
    ['int x = 1;\nint y = &x + 1;', /Pointers/, 2, 'syntax'],
    ['int x = (int *)0;', /Pointers/, 1, 'syntax'],
    ['struct point { int x; };', /Structs/, 1, 'syntax'],
    ['int n = sizeof(int);', /sizeof.*char 1, short 2, int 4 and long 8/, 1, 'syntax'],
    ['long long x = 1;', /long long/, 1, 'syntax'],
    ['long x = 1LL;', /long long/, 1, 'syntax'],
    ['unsigned signed x = 1;', /both signed and unsigned/, 1, 'syntax'],
    ['short long x = 1;', /both short and long/, 1, 'syntax'],
    ['int x = 099;', /octal/, 1, 'syntax'],
    ['long x = 99999999999999999999;', /too big/, 1, 'syntax'],
    ['int x = 0;\nint y = x++ + 1;', /own line/, 2, 'syntax'],
    ['int x = foo(3);', /Calling functions/, 1, 'syntax'],
    ['int f(int a) {\n  return a;\n}', /Only one function/, 1, 'syntax'],
    ['int x = "hi";', /Strings can only be used/, 1, 'syntax'],
    ['printf("%d %d", 1);', /2 placeholders but 1 value/, 1, 'syntax'],
    ['printf("%f", 1);', /not %f/, 1, 'syntax'],
    ['printf("%s", 1);', /not %s/, 1, 'syntax'],
    ['printf("%lc", 1);', /not %/, 1, 'syntax'],
    ['printf("%d%d%d%d%d%d\\n", 1, 2, 3, 4, 5, 6);', /at most 5/, 1, 'limit'],
    ['break;', /only works inside a loop/, 1, 'syntax'],
    ['int x = (1 + 2;', /Expected "\)"/, 1, 'syntax'],
    ['int x = INT_MAX;', /limits\.h/, 1, 'type'],
    ["char c = 'ab';", /one character/, 1, 'syntax'],
    ['switch (1) { }', /switch/, 1, 'syntax'],
    ['const int x = 1;', /isn't supported/, 1, 'syntax'],
  ];
  for (const [src, re, line, kind] of cases) {
    assert.throws(() => compile(src), (e) => e instanceof CError && re.test(e.message) && e.line === line && e.kind === kind,
      `${JSON.stringify(src)} → ${re}`);
  }
});

test('limits: lines, columns and variables', () => {
  const tooMany = Array.from({ length: LIMITS.lines + 1 }, (_, k) => `int v${k} = ${k};`).join('\n');
  assert.throws(() => compile(tooMany), (e) => e.kind === 'limit' && /31 lines/.test(e.message));
  assert.throws(() => compile(`int x = 1; // ${'x'.repeat(80)}`), (e) => e.kind === 'limit' && e.line === 1 && /72/.test(e.message));
  const vars = Array.from({ length: 33 }, (_, k) => `v${k}`);
  const decls = (n) => vars.slice(0, n).map((v) => `int ${v};`).join(' ').replace(/(.{1,60}) /g, '$1\n');
  assert.throws(() => compile(decls(33)), (e) => e.kind === 'limit' && /Too many variables/.test(e.message));
  assert.doesNotThrow(() => compile(decls(32)));
});

// The hand-picked traps from CS:APP chapter 2. Expected values are C's (LP64, gcc on x86-64),
// so these hold without gcc; the gcc comparison below re-checks them against the real compiler.
const TRICKY = [
  ['-1 < 0U', 'printf("%d %d %d\\n", -1 < 0U, -1 < 0UL, -1L < 0U);', '0 0 1\n'],
  ['long vs unsigned', 'long a = -1;\nunsigned b = 1;\nunsigned long c = 1;\nprintf("%d %d\\n", a < b, a < c);', '1 0\n'],
  ['narrowing', 'char c = 200;\nshort s = 70000;\nprintf("%d %d %d\\n", c, s, (unsigned char)-1);', '-56 4464 255\n'],
  ['unsigned wrap', 'unsigned u = 0;\nu = u - 1;\nprintf("%u %d\\n", u, u > 0);', '4294967295 1\n'],
  ['shifts', 'printf("%d %u %d\\n", -8 >> 1, (unsigned)-8 >> 1, 3 << 30);', '-4 2147483644 -1073741824\n'],
  ['division', 'printf("%d %d %d %d\\n", 7 / -2, -7 % 2, -7 / 2, 7 % -2);', '-3 -1 -3 1\n'],
  ['overflow', '#include <limits.h>\nint m = INT_MAX;\nprintf("%d %d\\n", m + 1, 65536 * 65536);', '-2147483648 0\n'],
  ['printf lengths', 'printf("%hhd %hu %lx %hhx\\n", 300, -1, -1L, -1);', '44 65535 ffffffffffffffff ff\n'],
  ['promotion', 'unsigned char a = 200, b = 100;\nunsigned char c = a + b;\nprintf("%d %d %d\\n", a + b, c, ~a);', '300 44 -201\n'],
  ['mixed division', 'int a = -7;\nunsigned b = 2;\nlong l = -7;\nprintf("%u %ld\\n", a / b, l / b);', '2147483644 -3\n'],
  ['sign extension', 'short s = -300;\nunsigned long ul = s;\nlong l = (unsigned short)s;\nprintf("%lu %ld\\n", ul, l);', '18446744073709551316 65236\n'],
  ['truncation to 32 bits and back', 'long l = 0x1FFFFFFFFL;\nunsigned long u = (unsigned)l;\nlong m = (int)l;\nprintf("%lu %ld\\n", u, m);', '4294967295 -1\n'],
];

test('tricky semantics: CS:APP traps give C\'s answers', () => {
  for (const [name, src, want] of TRICKY) assert.equal(run(build(src)).output, want, name);
});

test('tricky semantics: and gcc agrees', { skip: !HAVE_GCC && 'gcc not installed' }, () => {
  for (const [name, src] of TRICKY) assert.equal(runGcc(`tricky_${name.replace(/\W+/g, '_')}`, src).out, run(build(src)).output, name);
});

test('cmp flags for signed and unsigned readings of the same bits', () => {
  // -1 < 1 as int: SF != OF → jl taken; as unsigned: 0xffffffff < 1 is false, CF = 0 → jb not taken
  const r = run(build('int a = -1;\nunsigned b = -1;\nint x = a < 1;\nint y = b < 1U;\nreturn x * 10 + y;'), { trace: true });
  const cmps = r.events.filter((e) => e.text.startsWith('cmp'));
  assert.deepEqual(cmps.map((e) => [e.a, e.b, e.r, e.width]), [[0xffffffffn, 1n, 0xfffffffen, 32], [0xffffffffn, 1n, 0xfffffffen, 32]]);
  assert.deepEqual(cmps[0].flagsAfter, { CF: 0, ZF: 0, SF: 1, OF: 0 });
  const sets = r.events.filter((e) => e.text.startsWith('set')).map((e) => [e.text, e.after.rax & 0xffn]);
  assert.deepEqual(sets, [['setl al', 1n], ['setb al', 0n]]);
  assert.equal(r.ret, 10);
});

test('stores are sized by the variable\'s type', () => {
  const src = 'char c = 1;\nshort s = 2;\nint i = 3;\nlong l = 4;\nc = i;\ns = l;\ni = l;\nl = c;';
  const r = run(build(src), { trace: true });
  const widths = r.events.filter((e) => e.write).map((e) => [e.line, e.write.width]);
  assert.deepEqual(widths, [[1, 8], [2, 16], [3, 32], [4, 64], [5, 8], [6, 16], [7, 32], [8, 64]]);
});

test('C rules the engine enforces rather than guessing', () => {
  // a declaration can't be the whole body of if/else/while/for (gcc: "expected expression before 'int'")
  for (const src of ['int x = 1;\nif (x) int y = 5;', 'int x = 1;\nif (x) x = 2; else long z = 3;', 'while (0) char c = 1;', 'for (int i = 0; i < 2; i++) short s = i;']) {
    assert.throws(() => compile(src), (e) => e instanceof CError && e.kind === 'syntax' && /put it inside \{ \}/.test(e.message), src);
  }
  assert.doesNotThrow(() => compile('int x = 1;\nif (x) { int y = 5; }'));
  // reading a variable before it has a value: gcc shows leftover memory, so there is no honest answer
  const uninit = ['int x;\nprintf("%d\\n", x);', 'long n;\nn++;', 'unsigned char c;\nint d = c + 1;'];
  for (const src of uninit) {
    assert.throws(() => run(compile(src)), (e) => e instanceof CError && e.kind === 'runtime' && /before it has been given a value/.test(e.message) && e.line === 2, src);
  }
  assert.equal(run(compile('long i;\nfor (i = 0; i < 3; i++) { }\nreturn i;')).ret, 3);
  assert.equal(run(compile('int x;\nif (1) x = 4;\nreturn x;')).ret, 4);
});

test('runtime errors: SIGFPE cases and runaway loops', () => {
  const err = (src, re, line, kind = 'runtime') => assert.throws(() => run(compile(src)), (e) => e instanceof CError && re.test(e.message) && e.line === line && e.kind === kind, src);
  err('int z = 0;\nint q = 10 / z;\nreturn q;', /Division by zero.*SIGFPE/, 2);
  err('unsigned z = 0;\nunsigned q = 10U % z;', /Division by zero/, 2);
  err('long z = 0;\nlong q = 10L / z;', /Division by zero/, 2);
  err('#include <limits.h>\nint m = INT_MIN;\nint d = -1;\nint q = m / d;', /doesn't fit in 32 bits.*SIGFPE/, 4);
  err('#include <limits.h>\nlong m = LONG_MIN;\nlong q = m % -1L;', /doesn't fit in 64 bits/, 3);
  // x / x with x = 0 is undefined behaviour: plain gcc folds it to 1 even at -O0, but idiv faults
  err('unsigned char v = 0;\nv /= v;', /Division by zero/, 2);
  err('int i = 0;\nwhile (1) {\n  i = i + 1;\n}\nreturn i;', /never ends/, 3, 'limit');
  err('for (unsigned i = 3; i >= 0; i--) {\n}', /never ends/, 1, 'limit');
  err('while (1) printf("spam spam spam\\n");', /more than 4000 characters/, 1, 'limit');
});
