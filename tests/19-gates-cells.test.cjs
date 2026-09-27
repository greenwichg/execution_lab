// The gate layer as a physical standard-cell array: dense instanced cells instead of logic-symbol shapes,
// a green frame + callouts on the full adder the film dives into, live values read from the circuit simulation.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.cjs');

after(H.teardown);

/** jump to story time t (or a TL key + offset) and render a few frames */
const at = (page, key, off = 0) => page.evaluate(([k, o]) => {
  const L = window.__lab, t = (typeof k === 'number' ? k : L.TL[k]) + o;
  L.jump(t); for (let i = 0; i < 3; i++) L.step(1 / 60);
  return t;
}, [key, off]);

/** the gates layer's geometry + the callouts currently on screen */
const inspect = (page) => page.evaluate(() => {
  const { kit } = window.__lab, g = kit.LAYER.gates.group;
  let inst = 0, instMeshes = 0, extrude = 0;
  g.traverse((o) => { if (o.isInstancedMesh) { inst += o.count; instMeshes++; } if (o.geometry && o.geometry.type === 'ExtrudeGeometry') extrude++; });
  const callouts = kit.Callouts.items.filter((it) => it.L === kit.LAYER.gates && it.el.style.visibility !== 'hidden' && +it.el.style.opacity > 0.3)
    .map((it) => ({ title: it.tt.textContent, sub: it.st.textContent }));
  return { inst, instMeshes, extrude, callouts, fade: kit.LAYER.gates.fade };
});

/** expected inputs of the key full adder, from the story data (B after the SUB inverter) */
const keyBits = (page) => page.evaluate(() => {
  const A = window.__lab.story.adder, k = A.key.k, b = A.sub ? ~A.b & 255 : A.b;
  return { bit: A.w + k, a: (A.a >> k) & 1, b: (b >> k) & 1, carries: A.key.carries.length, sub: !!A.sub };
});

async function checkStory(page, label) {
  const K = await keyBits(page);
  // establishing shot: the array, the framed tile, its callout with the simulation's live values
  await at(page, 'gIn', 1);
  const s1 = await inspect(page);
  assert.ok(s1.fade > 0.9, `${label}: gates layer visible (${s1.fade})`);
  assert.equal(s1.extrude, 0, `${label}: no logic-symbol shapes`);
  assert.ok(s1.inst > 2500, `${label}: dense instanced cell array (${s1.inst} instances)`);
  assert.ok(s1.instMeshes <= 16, `${label}: cells are batched (${s1.instMeshes} instanced meshes)`);
  const tile = s1.callouts.find((c) => c.title === `Full adder · bit ${K.bit}`);
  assert.ok(tile, `${label}: tile callout for bit ${K.bit} (${JSON.stringify(s1.callouts)})`);
  assert.match(tile.sub, /^A [01] · ¬?B [01] · carry in [01] → sum [01] · carry out [01]$/);
  assert.ok(s1.callouts.length <= 4, `${label}: at most four callouts (${s1.callouts.length})`);
  // just before the dive: inputs have arrived at the key column and match the story's operands
  await at(page, 'gates0', 4.0);
  const s2 = await inspect(page);
  const tile2 = s2.callouts.find((c) => c.title === `Full adder · bit ${K.bit}`);
  assert.ok(tile2, `${label}: tile callout still up before the dive`);
  const m = /^A ([01]) · ¬?B ([01])/.exec(tile2.sub);
  assert.deepEqual([+m[1], +m[2]], [K.a, K.b], `${label}: live A/B of bit ${K.bit} (${tile2.sub})`);
  if (K.sub) assert.match(tile2.sub, /¬B/, `${label}: subtraction shows the inverted B`);
  // the dive: the XOR cell is named with its live inputs
  await at(page, 'gates0', 4.9);
  const s3 = await inspect(page);
  assert.ok(s3.callouts.some((c) => c.title === `XOR gate · sum bit ${K.bit}` && /^P [01] ⊕ carry in [01] → [01]$/.test(c.sub)), `${label}: XOR callout (${JSON.stringify(s3.callouts)})`);
  // a rippling carry is followed by its own callout
  if (K.carries) {
    const t = await page.evaluate(() => { const A = window.__lab.story.adder; return A.key.carries; });
    let seen = null;
    for (const off of [0.8, 1.5, 2.2, 3, 3.8]) {
      await at(page, 'gates0', off);
      const c = (await inspect(page)).callouts.find((x) => /^Carry → bit \d+$/.test(x.title));
      if (c) { seen = c; break; }
    }
    assert.ok(seen, `${label}: carry-front callout while the carry ripples (${t.length} carries)`);
  }
}

test('demo: the adder is a framed tile of standard cells with live callouts', async () => {
  const s = await H.open('manual&silent&q=0', { width: 1280, height: 720 });
  const { page, errors } = s;
  await checkStory(page, 'demo');
  assert.deepEqual(errors, []);
  await s.close();
});

test('program stories drive the tile, bit numbers and values (sub, long carry)', async () => {
  const s = await H.open('manual&silent&q=0', { width: 1280, height: 720 });
  const { page, errors } = s;
  for (const [name, src] of [['sub', 'int a = 200;\nint b = a - 73;\nreturn b;\n'], ['carry7', 'int a = 127;\nint b = a + 1;\nreturn b;\n']]) {
    const ok = await page.evaluate(async (c) => { window.__lab.editor.setCode(c); return window.__lab.editor.run(); }, src);
    assert.ok(ok, `${name} runs`);
    await page.evaluate(() => window.__lab.pause());
    await checkStory(page, name);
  }
  assert.deepEqual(errors, []);
  await s.close();
});
