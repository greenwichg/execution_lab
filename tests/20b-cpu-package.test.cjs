// The CPU package + die in the reference style: a real package (substrate, pads, capacitors, a heat spreader
// that lifts away) and a dense die floorplan whose instruction route (memory controller → ring → L3 slice →
// core 0's L2 → core 0) lights green as the signal travels it. Small callouts carry the running program's own
// instruction bytes and mnemonic.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.cjs');

after(H.teardown);

/** jump to a TL key + offset and render a few frames */
const at = (page, key, off = 0) => page.evaluate(([k, o]) => {
  const L = window.__lab, t = L.TL[k] + o;
  L.jump(t); for (let i = 0; i < 3; i++) L.step(1 / 60);
  return t;
}, [key, off]);

/** the die layer's instanced geometry, how many parts glow green, the green frames on screen, the CPU callouts */
const inspect = (page) => page.evaluate(() => {
  const { kit, story } = window.__lab, D = kit.LAYER.die, lab = kit.LAYER.lab;
  let inst = 0, meshes = 0, lit = 0, frames = 0;
  D.group.traverse((o) => {
    if (!o.isInstancedMesh) return;
    const a = o.geometry.attributes.aHL;
    if (a) { meshes++; inst += o.count; for (let i = 0; i < o.count; i++) if (a.getX(i) > 0.5) lit++; } else if (o.parent.visible && o.visible) frames++;
  });
  const callouts = kit.Callouts.items.filter((it) => (it.L === D || it.L === lab) && it.el.style.visibility !== 'hidden' && +it.el.style.opacity > 0.3)
    .map((it) => ({ title: it.tt.textContent, sub: it.st.textContent }));
  const info = window.__lab.info();
  return { inst, meshes, lit, frames, callouts, calls: info.calls, tris: info.tris, dieFade: D.fade, hex: story.decode.hex, asm: story.decode.asm };
});

const find = (s, title) => s.callouts.find((c) => c.title === title);

async function checkStory(page, label) {
  // the package on its plinth; the instruction is on its way in
  await at(page, 'pkg', 0.6);
  let s = await inspect(page);
  const pkg = find(s, 'Processor package');
  assert.ok(pkg, `${label}: package callout (${JSON.stringify(s.callouts)})`);
  assert.ok(pkg.sub.includes(s.hex), `${label}: package callout names the instruction bytes ${s.hex} (${pkg.sub})`);
  assert.equal(s.lit, 0, `${label}: nothing on the die glows before the signal arrives`);
  assert.equal(s.frames, 0, `${label}: no green frame yet`);
  // the heat spreader lifts off, then the bare die
  await at(page, 'lid', 0.4);
  s = await inspect(page);
  assert.ok(find(s, 'Integrated heat spreader'), `${label}: lid callout (${JSON.stringify(s.callouts)})`);
  await at(page, 'lid', 1);
  s = await inspect(page);
  assert.ok(find(s, 'Silicon die'), `${label}: die callout (${JSON.stringify(s.callouts)})`);
  // the memory controller takes the line from DRAM: framed in green
  await at(page, 'die', 0.4);
  s = await inspect(page);
  const mc = find(s, 'Memory controller');
  assert.ok(mc && mc.sub.includes(s.hex), `${label}: memory-controller callout with ${s.hex} (${JSON.stringify(s.callouts)})`);
  assert.ok(s.frames >= 1, `${label}: the memory controller is framed (${s.frames})`);
  // the L3 slice holds the line; the ring route behind the signal glows, the rest of the die stays matte
  await at(page, 'die', 1);
  s = await inspect(page);
  assert.ok(s.dieFade > 0.9, `${label}: die layer visible (${s.dieFade})`);
  assert.ok(s.inst > 3000, `${label}: dense instanced floorplan (${s.inst} instances)`);
  assert.ok(s.meshes <= 16, `${label}: parts are batched (${s.meshes} instanced meshes)`);
  assert.ok(s.lit >= 10 && s.lit < 200, `${label}: only the route is lit (${s.lit} of ${s.inst})`);
  const l3 = find(s, 'Shared L3 cache');
  assert.ok(l3 && l3.sub.includes(s.hex), `${label}: L3 callout with ${s.hex} (${JSON.stringify(s.callouts)})`);
  assert.ok(s.calls <= 220 && s.tris <= 1.5e6, `${label}: within the frame budget (${s.calls} calls, ${s.tris} triangles)`);
  // diving into core 0: framed, named with the instruction it is about to run
  await at(page, 'toCore', -0.2);
  s = await inspect(page);
  const c0 = find(s, 'Core 0');
  assert.ok(c0 && c0.sub.includes(s.asm), `${label}: core-0 callout with ${s.asm} (${JSON.stringify(s.callouts)})`);
  assert.ok(s.frames >= 1, `${label}: core 0 is framed (${s.frames})`);
  for (const [k, o] of [['pkg', 0.6], ['lid', 1], ['die', 0.4], ['die', 1], ['toCore', -0.2]]) {
    await at(page, k, o);
    const n = (await inspect(page)).callouts.length;
    assert.ok(n <= 4, `${label}: at most four CPU callouts at ${k}${o >= 0 ? '+' : ''}${o} (${n})`);
  }
  // later layers: the CPU callouts and highlights are gone
  await at(page, 'gates0', 3);
  s = await inspect(page);
  assert.equal(s.callouts.length, 0, `${label}: CPU callouts cleared deeper in (${JSON.stringify(s.callouts)})`);
}

test('demo: package, lifting lid and a die whose instruction route lights up', async () => {
  const s = await H.open('manual&silent&q=0', { width: 1280, height: 720 });
  const { page, errors } = s;
  await checkStory(page, 'demo');
  assert.deepEqual(errors, []);
  await s.close();
});

test('program stories drive the CPU callouts (sub, loop)', async () => {
  const s = await H.open('manual&silent&q=0', { width: 1280, height: 720 });
  const { page, errors } = s;
  for (const [name, src] of [['sub', 'int a = 200;\nint b = a - 73;\nreturn b;\n'], ['loop', 'int total = 0;\nfor (int i = 1; i <= 4; i++) {\n  total = total + i * 31;\n}\nreturn total;\n']]) {
    const ok = await page.evaluate(async (c) => { window.__lab.editor.setCode(c); return window.__lab.editor.run(); }, src);
    assert.ok(ok, `${name} runs`);
    await page.evaluate(() => window.__lab.pause());
    await checkStory(page, name);
  }
  assert.deepEqual(errors, []);
  await s.close();
});
