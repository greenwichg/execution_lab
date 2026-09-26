// The code editor's compiler, checked against the real toolchain:
//   · every program's output and return value must match gcc's
//   · every instruction's bytes must match what the GNU assembler emits
// (skipped automatically when gcc / as are not installed)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const block = html.slice(html.indexOf('// @@MINIC-BEGIN'), html.indexOf('// @@MINIC-END'));
const MiniC = new Function(`${block}; return MiniC;`)();
const have = (cmd) => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };
const HAVE_GCC = have('gcc'), HAVE_AS = have('as') && have('objdump');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minic-'));

const PROGRAMS = require('./programs.cjs');

function gccSource(src) {
  if (/int\s+main\s*\(/.test(src)) return src.includes('#include') ? src : `#include <stdio.h>\n${src}`;
  return `#include <stdio.h>\nint main(void) {\n${src}\nreturn 0;\n}\n`;
}
function runGcc(name, src) {
  const c = path.join(tmp, `${name}.c`), exe = path.join(tmp, name);
  fs.writeFileSync(c, gccSource(src));
  execFileSync('gcc', ['-O0', '-fwrapv', '-w', '-o', exe, c]);
  try { return { out: execFileSync(exe, { encoding: 'utf8' }), exit: 0 }; } catch (e) { return { out: e.stdout?.toString() ?? '', exit: e.status }; }
}

for (const [name, src] of Object.entries(PROGRAMS)) {
  test(`program "${name}": same output and exit code as gcc`, { skip: !HAVE_GCC && 'gcc not installed' }, () => {
    const prog = MiniC.compile(src);
    const r = MiniC.run(prog);
    const g = runGcc(name, src);
    assert.equal(r.output, g.out, 'stdout');
    assert.equal(r.exit, g.exit, 'exit code');
  });
}

test('every instruction encodes exactly like the GNU assembler', { skip: !HAVE_AS && 'binutils not installed' }, () => {
  let checked = 0;
  for (const [name, src] of Object.entries(PROGRAMS)) {
    const prog = MiniC.compile(src);
    const lines = ['.intel_syntax noprefix', '.text', 'main:'];
    for (const x of prog.code) lines.push(x.label !== undefined ? `.L${x.label}:` : `  ${x.asText ?? MiniC.text(x)}`);
    lines.push('.section .rodata');
    prog.strings.forEach((s, i) => lines.push(`.LC${i}: .string ${JSON.stringify(s)}`));
    const sFile = path.join(tmp, `${name}.s`), oFile = path.join(tmp, `${name}.o`);
    fs.writeFileSync(sFile, lines.join('\n') + '\n');
    execFileSync('as', ['--64', '-o', oFile, sFile]);
    const dump = execFileSync('objdump', ['-d', '-M', 'intel', '--no-show-raw-insn', '-j', '.text', oFile], { encoding: 'utf8' });
    void dump;
    const raw = execFileSync('objcopy', ['-O', 'binary', '-j', '.text', oFile, path.join(tmp, `${name}.bin`)]);
    void raw;
    const bin = fs.readFileSync(path.join(tmp, `${name}.bin`));
    const ours = Buffer.from(prog.insts.flatMap((i) => i.bytes));
    assert.equal(ours.toString('hex'), bin.toString('hex'), `${name}: bytes differ`);
    checked += prog.insts.length;
  }
  assert.ok(checked > 300, `checked ${checked} instructions`);
});

test('friendly compile errors point at the right place', () => {
  const cases = [
    ['int x = 5\nreturn x;', /Expected ";"/, 2],
    ['int x = y + 1;', /"y" hasn't been declared/, 1],
    ['int x = 1;\nint x = 2;', /already declared/, 2],
    ['float f = 1;', /isn't supported/, 1],
    ['int a[3];', /Arrays/, 1],
    ['int x = 0;\nint y = x++ + 1;', /own line/, 2],
    ['int x = foo(3);', /Calling functions/, 1],
    ['printf("%d %d", 1);', /2 placeholders but 1 value/, 1],
    ['break;', /only works inside a loop/, 1],
    ['int x = (1 + 2;', /Expected "\)"/, 1],
  ];
  for (const [src, re, line] of cases) {
    assert.throws(() => MiniC.compile(src), (e) => re.test(e.message) && e.line === line, `${JSON.stringify(src)} → ${re}`);
  }
});

test('runtime errors: division by zero and runaway loops', () => {
  assert.throws(() => MiniC.run(MiniC.compile('int z = 0;\nint q = 10 / z;\nreturn q;')), (e) => /Division by zero/.test(e.message) && e.line === 2);
  assert.throws(() => MiniC.run(MiniC.compile('int i = 0;\nwhile (1) {\n  i = i + 1;\n}\nreturn i;')), (e) => /never ends/.test(e.message));
});

test('the trace records statement steps, variable writes and ALU operands', () => {
  const prog = MiniC.compile(PROGRAMS.sum);
  const r = MiniC.run(prog);
  const total = prog.vars.find((v) => v.name === 'total');
  const writes = r.steps.flatMap((s) => s.writes.filter((w) => w.v === total.id).map((w) => w.val));
  assert.deepEqual(writes, [0, 1, 3, 6, 10, 15, 21, 28, 36, 45, 55]);
  const addIns = prog.insts.find((i) => i.op === 'add' && i.alu && i.alu.k === 'bin');
  const log = r.aluLog.get(addIns.i);
  assert.equal(log.n, 10);
  const lastRec = log.last[log.last.length - 1];
  assert.deepEqual([lastRec.a, lastRec.b, lastRec.r], [45, 10, 55]);
  assert.equal(r.output, '55\n');
});
