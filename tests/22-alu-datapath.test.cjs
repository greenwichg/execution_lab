// The ALU layer as a physical datapath: operand latches whose bit windows show the story's operands,
// a bit-slice adder whose green tile frame and carry straps follow STORY.alu.board, the result latch
// filling with the story's sum, callouts carrying the story's values, and a clean hand-over to the
// gate layer (whose full-adder tiles sit exactly under the ALU's bit slices).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.cjs');

after(H.teardown);

const STEP = 0.26;                                   // one bit slice per step (AL_STEP; the SFX cue list ticks on it)
const sliceX = (i) => (35 - 10 * i + 0.6) * 0.25;    // FA_X(i) = 35 − 10 i gate units (section 12), gates layer scale 24/96

/** jump to story time (TL key + offset, or seconds) and render a few frames, paused */
const at = (page, key, off = 0) => page.evaluate(([k, o]) => {
  const L = window.__lab, t = (typeof k === 'number' ? k : L.TL[k]) + o;
  L.pause(); L.jump(t); for (let i = 0; i < 3; i++) L.step(1 / 60);
  return t;
}, [key, off]);

/** the ALU layer's state: bit windows, glyph alphas, carry straps, frames, callouts, render cost */
const inspect = (page) => page.evaluate(() => {
  const { kit } = window.__lab, L = kit.LAYER.alu, g = L.group, by = (n) => g.getObjectByName(n);
  const win = by('alu-bit-windows'), gl = by('alu-glyphs'), st = by('alu-carry-straps'), fr = by('alu-slice-frame'), kf = by('alu-key-frame'), of = by('alu-op-frame');
  const c = win.instanceColor.array;
  const lit = [...Array(28).keys()].map((i) => (c[i * 3 + 1] > 0.05 && c[i * 3 + 1] > c[i * 3] * 1.15 && c[i * 3 + 1] > c[i * 3 + 2] * 1.2 ? 1 : 0));
  const aA = gl.geometry.attributes.aA.array, hl = st.geometry.attributes.aHL.array;
  let extrude = 0, textMeshes = 0, inst = 0;
  g.traverse((o) => { if (o.geometry?.type === 'ExtrudeGeometry') extrude++; if (o.isInstancedMesh) inst++; else if (o.isMesh && o.material?.uniforms?.map) textMeshes++; });
  const callouts = kit.Callouts.items.filter((it) => it.L === L && it.el.style.visibility !== 'hidden' && +it.el.style.opacity > 0.3).map((it) => ({ title: it.tt.textContent, sub: it.st.textContent }));
  return {
    fade: L.fade, lit, glyphA: Array.from(aA.slice(0, gl.count)), strap: [...Array(9).keys()].map((j) => hl[j * 3]), strapFade: st.material.userData.fadeU.value,
    frame: { vis: fr.visible, x: fr.position.x }, key: { vis: kf.visible, x: kf.position.x }, op: of.visible,
    callouts, extrude, textMeshes, inst, info: window.__lab.info(),
  };
});

const story = (page) => page.evaluate(() => { const S = window.__lab.story; return { alu: S.alu, w: S.adder.w ?? 0, k: S.adder.key.k }; });
const bit = (v, i) => (v >> i) & 1;
const bin8 = (v) => (v & 255).toString(2).padStart(8, '0');

async function checkStory(page, label) {
  const { alu, w, k } = await story(page);
  const BD = alu.board, carry = [...BD.carries.map((x) => (x ? 1 : 0)), (bit(BD.a, 7) + bit(BD.b, 7) + (BD.carries[7] ? 1 : 0)) >> 1];
  const cost = (s, where) => {
    assert.ok(s.info.calls <= 220, `${label} ${where}: ≤ 220 draw calls (${s.info.calls})`);
    assert.ok(s.info.tris <= 1.5e6, `${label} ${where}: ≤ 1.5 M triangles (${s.info.tris})`);
  };
  // operands latched: each window shows its bit, the callouts carry the story's values
  await at(page, 'aluIn', 0.9);
  const s1 = await inspect(page);
  assert.ok(s1.fade > 0.9, `${label}: ALU layer visible (${s1.fade})`);
  assert.equal(s1.extrude, 0, `${label}: no logic-symbol shapes`);
  assert.equal(s1.textMeshes, 0, `${label}: no per-label text meshes (glyphs are instanced)`);
  assert.ok(s1.inst >= 8, `${label}: hardware is instanced (${s1.inst} instanced meshes)`);
  for (let i = 0; i < 8; i++) {
    assert.equal(s1.lit[i], bit(alu.aBits, i), `${label}: latch A bit ${i}`);
    assert.equal(s1.lit[8 + i], bit(alu.bBits, i), `${label}: latch B bit ${i}`);
  }
  const cA = s1.callouts.find((c) => c.title === `Input A = ${alu.a}`), cB = s1.callouts.find((c) => c.title === `Input B = ${alu.b}`);
  assert.ok(cA && cA.sub.endsWith(bin8(alu.aBits)), `${label}: input A callout (${JSON.stringify(s1.callouts)})`);
  assert.ok(cB && cB.sub.endsWith(bin8(alu.bBits)), `${label}: input B callout`);
  if (alu.window) assert.ok(cA.sub.startsWith(alu.window), `${label}: the 8-bit window is named (${cA.sub})`);
  assert.ok(s1.callouts.length <= 4, `${label}: at most four ALU callouts (${s1.callouts.length})`);
  cost(s1, 'aluIn');
  // the operation select
  await at(page, 'aluOp', 0.4);
  const s2 = await inspect(page);
  assert.ok(s2.op, `${label}: the active operation is framed`);
  assert.ok(s2.callouts.some((c) => c.title === `Operation · ${alu.op}`), `${label}: operation callout (${JSON.stringify(s2.callouts)})`);
  // mid-ripple: the frame is on bit slice 3, carries into slices 0..3 have crossed, later ones not yet
  const t3 = await page.evaluate((st) => window.__lab.TL.aluRip + 3 * st + 0.05, STEP);
  await at(page, t3);
  const s3 = await inspect(page);
  assert.ok(s3.frame.vis && Math.abs(s3.frame.x - sliceX(3)) < 0.01, `${label}: frame on slice 3 (${s3.frame.x})`);
  const tile = s3.callouts.find((c) => c.title === `Full adder · bit ${w + 3}`);
  assert.ok(tile, `${label}: tile callout for bit ${w + 3} (${JSON.stringify(s3.callouts)})`);
  assert.match(tile.sub, new RegExp(`carry in ${carry[3]} → sum ${bit(BD.s, 3)} · carry out ${carry[4]}$`));
  for (let j = 0; j <= 8; j++) {
    const crossed = j <= 3 && carry[j];
    assert.equal(s3.strap[j] > 0.2, !!crossed, `${label}: carry strap ${j} (${s3.strap[j].toFixed(2)})`);
  }
  cost(s3, 'aluRip');
  // done: the result latch holds the story's sum, the column the film dives into is framed
  await at(page, 'aluDone', 0.05);
  const s4 = await inspect(page);
  for (let i = 0; i < 8; i++) {
    const one = s4.glyphA[16 + i * 2 + 1] > 0.9, zero = s4.glyphA[16 + i * 2] > 0.9;
    assert.deepEqual([one, zero], [!!bit(BD.s, i), !bit(BD.s, i)], `${label}: result bit ${i}`);
    assert.equal(s4.lit[16 + i], bit(BD.s, i), `${label}: result window ${i}`);
  }
  assert.ok(s4.key.vis && Math.abs(s4.key.x - sliceX(k)) < 0.01, `${label}: key slice ${k} framed (${s4.key.x})`);
  assert.ok(!s4.frame.vis, `${label}: the sweeping frame has handed over to the key slice`);
  const res = s4.callouts.find((c) => c.title === `Result ${alu.resultLabel}`);
  assert.ok(res && res.sub.endsWith(`= ${bin8(BD.s)}`), `${label}: result callout (${JSON.stringify(s4.callouts)})`);
  assert.ok(s4.callouts.some((c) => c.title === `Full adder · bit ${w + k}`), `${label}: key tile callout`);
  cost(s4, 'aluDone');
  // hand-over: ALU-level frames and carry straps give way to the gate layer
  await at(page, 'gIn', 0.9);
  const s5 = await inspect(page);
  assert.ok(!s5.key.vis && !s5.frame.vis, `${label}: frames gone at the gate level`);
  assert.equal(s5.strapFade, 0, `${label}: carry straps handed over`);
}

test('demo: latches, bit-slice ripple, result and hand-over follow the story', async () => {
  const s = await H.open('manual&silent&q=0', { width: 1280, height: 720 });
  const { page, errors } = s;
  page.setDefaultTimeout(240000);
  await checkStory(page, 'demo');
  assert.deepEqual(errors, []);
  await s.close();
});

test('program stories: subtraction, long carry, multiplier, a high 8-bit window', async () => {
  const s = await H.open('manual&silent&q=0', { width: 1280, height: 720 });
  const { page, errors } = s;
  page.setDefaultTimeout(240000);
  for (const [name, src] of [
    ['sub', 'int a = 200;\nint b = a - 73;\nreturn b;\n'],
    ['carry7', 'int a = 127;\nint b = a + 1;\nreturn b;\n'],
    ['mul', 'int total = 0;\nfor (int i = 1; i <= 4; i++) {\n  total = total + i * 31;\n}\nreturn total;\n'],
    ['window', 'int a = 1000;\nint b = a + 3000;\nreturn b;\n'],
  ]) {
    const ok = await page.evaluate(async (c) => { window.__lab.editor.setCode(c); return window.__lab.editor.run(); }, src);
    assert.ok(ok, `${name} runs`);
    await page.evaluate(() => window.__lab.pause());
    await checkStory(page, name);
  }
  assert.deepEqual(errors, []);
  await s.close();
});
