// The story builder: for every program (the editor's examples + the compiler
// corpus) and every operation the film can follow, the generated story must be
// complete and must agree with the real execution and the gate simulation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const cut = (a, b) => html.slice(html.indexOf(a), html.indexOf(b));
const tlStart = html.indexOf('const TL = {');
const tlSrc = html.slice(tlStart, html.indexOf('};', tlStart) + 2);
const faX = html.match(/const FA_X = .*\n/)[0];
const { MiniC, StoryKit, TL } = new Function(`${cut('// @@MINIC-BEGIN', '// @@MINIC-END')}${tlSrc}${faX}${cut('// @@STORY-BEGIN', '// @@STORY-END')}; return { MiniC, StoryKit, TL };`)();
const EXAMPLES = new Function(`return ${html.slice(html.indexOf('const EXAMPLES = [') + 17, html.indexOf('];', html.indexOf('const EXAMPLES = [')) + 1)};`)();

const PROGRAMS = { ...Object.fromEntries(EXAMPLES.map((e) => [`example: ${e.name}`, e.code])), ...require('./programs.cjs') };
const bit = (v, i) => (v >>> i) & 1;
const beatTime = (beat) => { const m = beat.match(/^(\w+)(?:\[(\d+)\])?$/); const v = TL[m[1]]; return m[2] === undefined ? v : v?.[+m[2]]; };

function checkStory(name, an, cand) {
  const st = StoryKit.programStory(an, cand.i);
  const where = `${name} · ${cand.label}`;
  const json = JSON.stringify(st);
  assert.ok(!/undefined|NaN/.test(json), `${where}: no undefined/NaN in the story (${json.match(/.{40}(undefined|NaN).{20}/)?.[0]})`);

  // featured operation = the emulator's last execution of that instruction
  const ins = an.prog.insts[cand.i];
  const f = st.featured;
  assert.equal(f.i, cand.i, where);
  const rec = an.res.aluLog.get(cand.i).last.at(-1);
  assert.equal(f.a, rec.a, `${where}: A`); assert.equal(f.b, rec.b, `${where}: B`);
  const expect = { add: (f.a + f.b) | 0, inc: (f.a + f.b) | 0, sub: (f.a - f.b) | 0, dec: (f.a - f.b) | 0, cmp: (f.a - f.b) | 0, mul: Math.imul(f.a, f.b) }[f.kind];
  assert.equal(f.r, expect, `${where}: result`);

  // compiler rows: five, one featured, carrying the instruction's real bytes
  assert.equal(st.rows.length, 5, where);
  const feats = st.rows.filter((r) => r.feat);
  assert.equal(feats.length, 1, `${where}: one featured row`);
  assert.deepEqual(feats[0].bytes, ins.bytes, `${where}: featured bytes`);
  assert.ok(feats[0].inMem, `${where}: featured bytes are laid into memory`);
  assert.ok(st.rows.filter((r) => r.inMem).reduce((s, r) => s + r.bytes.length, 0) <= 12, `${where}: ≤ 12 bytes in memory`);
  assert.equal(st.decode.hex.replace(/\s/g, ''), ins.bytes.map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase(), `${where}: decode hex`);

  // the board, the adder inputs and the gate simulation all agree
  const { board } = st.alu, { sim, key, cin } = st.adder;
  assert.equal((board.a + board.b + board.cin) & 255, board.s, `${where}: board adds up`);
  for (let i = 0; i < 8; i++) {
    assert.equal(sim.final[`X${i}`], bit(board.s, i), `${where}: gate sum bit ${i}`);
    assert.equal(board.carries[i], i === 0 ? cin : sim.final[`C${i}`], `${where}: carry into bit ${i}`);
  }
  assert.ok(Number.isInteger(key.k) && key.k >= 0 && key.k <= 7, `${where}: key column ${key.k}`);
  assert.ok(key.tauOut >= key.tauArr, `${where}: output settles after its input arrives`);
  if (!key.none) assert.equal(sim.final[`X${key.k}`], key.outDir > 0 ? 1 : 0, `${where}: key output direction`);
  assert.deepEqual(key.carries.map((c) => c.i), [...key.carries.map((c) => c.i)].sort((a, b) => a - b), where);

  // narration: 17 cues, every line has text, every anchor is a real beat
  const sh = StoryKit.retimeFor(st);
  assert.equal(typeof sh, 'function');
  assert.ok(TL.run0 < TL.run1, `${where}: RUN segment`);
  assert.equal(st.narration.cues.length, 17, where);
  for (const c of st.narration.cues) {
    assert.ok(c.lines.length && c.lines.every((l) => typeof l.text === 'string' && l.text.trim().length > 3), `${where}: cue ${c.id} has text`);
    for (const a of [c.anchor, ...c.lines.map((l) => l.anchor)].filter(Boolean)) assert.equal(typeof beatTime(a.beat), 'number', `${where}: cue ${c.id} anchor ${a.beat}`);
  }
  // the high-level run reproduces the program's output
  assert.equal(st.run.output, an.res.output, `${where}: run output`);
  assert.equal(st.run.ret, an.res.ret, `${where}: run return value`);
  assert.equal(st.run.steps.at(-1).out, an.res.output, `${where}: last step shows all output`);
  return st;
}

for (const [name, src] of Object.entries(PROGRAMS)) {
  test(`story for "${name}"`, () => {
    let an;
    try { an = StoryKit.analyze(src); } catch (e) {
      // only the size limits may reject a corpus program
      assert.equal(e.kind, 'limit', `${name}: ${e.message}`);
      return;
    }
    if (!an.cands.length) { assert.throws(() => StoryKit.programStory(an), /follows an addition/); return; }
    for (const cand of an.cands) checkStory(name, an, cand);
  });
}

test('the demo story still matches the original film', () => {
  const d = StoryKit.demoStory();
  assert.equal(d.narration, null, 'the demo keeps its recorded narration');
  assert.deepEqual(d.inserts, []);
  StoryKit.retimeFor(d);
  for (const [k, v] of Object.entries(StoryKit.TL_BASE)) assert.deepEqual(TL[k], v, `TL.${k} unchanged`);
  assert.equal(d.adder.key.k, 3, 'the demo dives into bit 3 (5 + 3 = 8)');
  assert.equal(d.alu.board.s, 8);
});

test('friendly errors carry a line and column', () => {
  const cases = [
    ['int x = 5\nreturn x;', 2, /;/],
    ['int total = 0;\ntotal = total + j;\nreturn total;', 2, /"j" hasn't been declared/],
    ['int x = 1;\nx = x / 0;\nreturn x;', 2, /division by zero/i],
    [Array.from({ length: 17 }, (_, i) => `int v${i} = ${i};`).join('\n'), 17, /16 lines/],
    [`int x = ${'1 + '.repeat(20)}1;`, 1, /longer than 60/],
  ];
  for (const [src, line, re] of cases) {
    assert.throws(() => StoryKit.analyze(src), (e) => { assert.ok(e instanceof MiniC.CError, e.message); assert.equal(e.line, line, `${e.message}`); assert.match(e.message, re); return true; });
  }
});

test('a program with nothing to follow gets a clear message', () => {
  const an = StoryKit.analyze('int x = 5;\nprintf("%d\\n", x);\nreturn x;');
  assert.equal(an.cands.length, 0);
  assert.throws(() => StoryKit.programStory(an), /addition, subtraction, multiplication or comparison/);
});
