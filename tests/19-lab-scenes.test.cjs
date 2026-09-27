// The code → compiler → machine code → memory scenes (sections 13–18): the part that is
// "happening now" is named by a callout whose text comes from the story being shown —
// the demo's x + 3 and any program from the editor — and the scenes stay within the
// draw-call budget at every beat.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.cjs');

after(H.teardown);

const SUB = 'int a = 200;\nint b = a - 73;\nreturn b;';
const LOOP = 'int total = 0;\nfor (int i = 1; i <= 4; i++) {\n  total = total + i * 31;\n}\nreturn total;';

/** jump to story time T (a TL expression evaluated in the page), render a few frames, list the visible callouts */
const at = (page, expr) => page.evaluate((expr) => {
  const L = window.__lab, TL = L.TL;
  const T = new Function('TL', `return ${expr};`)(TL);
  L.jump(T); for (let i = 0; i < 3; i++) L.step(1 / 60);
  const info = L.info();
  const callouts = [...document.querySelectorAll('#callouts .co')].filter((el) => el.style.visibility === 'visible' && +el.style.opacity > 0.2)
    .map((el) => ({ title: el.querySelector('.box span').textContent, sub: el.querySelector('.box small').textContent }));
  return { T, calls: info.calls, tris: info.tris, callouts };
}, expr);
const find = (r, title) => r.callouts.find((c) => c.title === title);
const hex = (a) => '0x' + a.toString(16).toUpperCase();

async function checkStory(page, label) {
  const st = await page.evaluate(() => {
    const s = window.__lab.story, f = s.rows.find((r) => r.feat), fi = s.rows.indexOf(f);
    const prev = s.rows.slice(0, fi).filter((r) => r.bytes && r.inMem !== false).at(-1);
    return { hl: s.src.hl, line: s.src.lines[s.src.hl.line], ast: s.ast, feat: f, prevAddr: prev?.addr ?? f.addr };
  });
  const expr = st.line.slice(st.hl.c0, st.hl.c1).trim();

  let r = await at(page, 'TL.hl + 0.6');
  assert.ok(find(r, 'Expression we follow')?.sub.includes(expr), `${label}: the expression callout names ${expr} (${JSON.stringify(r.callouts)})`);

  r = await at(page, 'TL.addHL + 0.4');
  const opLabel = st.ast.nodes[st.ast.op].label;
  assert.equal(find(r, `${opLabel} node`)?.sub, st.ast.addTag[0], `${label}: the operation node's callout starts from the source expression`);
  r = await at(page, 'TL.res8 + 0.3');
  assert.equal(find(r, `${opLabel} node`)?.sub, st.ast.addTag[2], `${label}: … and ends with the evaluated result`);

  r = await at(page, 'TL.asm + 0.6');
  assert.equal(find(r, 'x86-64 instruction')?.sub, st.feat.texts[3].replace(/\s+/g, ' '), `${label}: the featured instruction's assembly`);
  r = await at(page, 'TL.bin + 0.4');
  assert.equal(find(r, 'Machine code · binary')?.sub, st.feat.bytes.map((b) => b.toString(2).padStart(8, '0')).join(' '), `${label}: … its bits`);

  r = await at(page, 'TL.ip0 + 0.5');
  assert.equal(find(r, 'Instruction pointer')?.sub, `RIP = ${hex(st.prevAddr)}`, `${label}: RIP first points at the previous instruction`);
  r = await at(page, 'TL.ip1 + 0.4');
  assert.equal(find(r, 'Instruction pointer')?.sub, `RIP = ${hex(st.feat.addr)}`, `${label}: … then at the one we follow`);

  for (const beat of ['TL.panel + 1', 'TL.lex + 1', 'TL.ast + 1.2', 'TL.ir + 0.6', 'TL.stream + 0.6', 'TL.tower + 1', 'TL.ip1', 'TL.pkg - 0.6']) {
    r = await at(page, beat);
    assert.ok(r.calls <= 220 && r.tris <= 1.5e6, `${label} @ ${beat}: ${r.calls} draw calls, ${r.tris} triangles`);
    assert.ok(r.callouts.length <= 4, `${label} @ ${beat}: at most four callouts (${r.callouts.length})`);
  }
}

test('lab scenes: demo callouts follow x + 3 from the source to memory, within budget', async () => {
  const s = await H.open('manual&silent&q=0', { width: 800, height: 450 });
  const { page, errors } = s;
  await checkStory(page, 'demo');
  assert.deepEqual(errors, []);
  await s.close();
});

test('lab scenes: a program from the editor drives the same callouts, and the RUN frame follows its execution', async () => {
  const s = await H.open('manual&silent&q=0', { width: 800, height: 450 });
  const { page, errors } = s;
  for (const [name, code] of [['sub', SUB], ['loop', LOOP]]) {
    assert.equal(await page.evaluate((c) => { window.__lab.editor.setCode(c); return window.__lab.editor.run(); }, code), true, `${name} runs`);
    await page.evaluate(() => window.__lab.pause());
    await checkStory(page, name);
    // while the program runs line by line, the callout on the green frame names the line being executed
    const steps = await page.evaluate(() => window.__lab.story.run.steps.map((st) => ({ line: st.line, skip: st.skip })));
    const n = steps.length;
    for (const k of [0, Math.floor(n / 2), n - 1]) {
      const r = await at(page, `TL.run0 + (TL.run1 - TL.run0) * ${(k + 0.5) / n}`);
      const want = steps[k].skip ? `… ${steps[k].skip} more steps` : `Line ${steps[k].line}`;
      assert.ok(r.callouts.some((c) => c.title === want), `${name}: step ${k} → “${want}” (${JSON.stringify(r.callouts)})`);
    }
  }
  assert.deepEqual(errors, []);
  await s.close();
});
