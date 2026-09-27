// The transistor layer (inside the XOR cell): a FinFET layout whose green highlights follow the
// story's gate voltage and channel conduction, whose callouts carry the live values, whose trench
// opens the focus transistor's section exactly where the silicon layer is anchored, and which stays
// inside the draw-call / triangle budget at every one of its beats.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./harness.cjs');

const SUB = 'int a = 200;\nint b = a - 73;\nreturn b;\n';   // the carry into the key column falls

/** state of the transistor layer at story time t (runs in the page) */
function probe(t) {
  const lab = window.__lab, { LAYER, Callouts, THREE } = lab.kit;
  lab.jump(t); lab.step(1 / 60); lab.jump(t); lab.step(1 / 60);
  const L = LAYER.xtor, info = lab.info();
  const meshes = [], cutGroups = [];
  L.group.traverse((o) => { if (o.isInstancedMesh && o.geometry.attributes.aHL && o.material.isMeshStandardMaterial) meshes.push(o); });
  L.group.children.forEach((o) => { if (o.isGroup && o.children.some((c) => c.isInstancedMesh && c.geometry.attributes.aHL)) cutGroups.push(o); });
  // highest green highlight, and the highlight of the part that contains a point (kept pieces only)
  const m4 = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  let maxHL = 0;
  const at = (x, y, z) => {
    let best = null;
    for (const m of meshes) {
      if (m.parent !== L.group) continue;
      const hl = m.geometry.attributes.aHL;
      for (let i = 0; i < m.count; i++) {
        m.getMatrixAt(i, m4); m4.decompose(p, q, s);
        if (Math.abs(x - p.x) <= s.x / 2 && Math.abs(y - p.y) <= s.y / 2 && Math.abs(z - p.z) <= s.z / 2) best = Math.max(best ?? 0, hl.getX(i));
      }
    }
    return best;
  };
  for (const m of meshes) { const hl = m.geometry.attributes.aHL; for (let i = 0; i < m.count; i++) maxHL = Math.max(maxHL, hl.getX(i)); }
  const co = Callouts.items.filter((it) => it.L === L).map((it) => ({ title: it.tt.textContent, sub: it.st.textContent, a: it.a, at: typeof it.at === 'function' ? [...it.at(t)] : it.at }));
  const cg = cutGroups[0];
  return {
    t, calls: info.calls, tris: info.tris, frame: info.frame, fade: L.fade,
    maxHL, chanHL: at(3, 1.5, 6.45), capHL: at(3, 5.2, 0), meshes: meshes.length,
    cutY: cg ? cg.position.y : null, cutVisible: cg ? cg.visible : null,
    siAnchor: LAYER.si.anchor.toArray(), siParent: LAYER.si.parent.id, co,
  };
}

test('transistor layer: highlights, callouts, trench and budget follow the demo story', { timeout: 240000 }, async () => {
  const s = await H.open('?manual&silent');
  try {
    const { page, errors } = s;
    await page.evaluate(() => window.__lab.pause());
    const TL = await page.evaluate(() => window.__lab.TL);
    const at = (t) => page.evaluate(probe, t);

    // the silicon layer dives into the focus transistor's gate/fin crossing
    const a = await at(TL.xtor + 0.8);
    assert.equal(a.siParent, 'xtor');
    assert.deepEqual(a.siAnchor.map((v) => +v.toFixed(3)), [3, 1.4, 6.6]);
    assert.ok(a.meshes >= 4, 'instanced hardware meshes (kept + cut-away, matte + metal)');
    assert.ok(a.chanHL !== null, 'a channel piece sits at the silicon anchor');
    assert.ok(a.capHL !== null, 'the focus gate crosses the cell');
    // before the gate rises: matte grey, no strong green anywhere; the cell callout names the column
    assert.ok(a.maxHL < 0.15, `no highlight before V_G rises (max ${a.maxHL})`);
    assert.ok(a.capHL < 0.05 && a.chanHL < 0.05);
    const cell = a.co.find((c) => /^XOR cell · full adder \d$/.test(c.title));
    assert.ok(cell && cell.a > 0.5, 'XOR cell callout visible');
    assert.ok(a.co.filter((c) => c.a > 0.01).length <= 4, 'at most four callouts at once');

    // the gate voltage rises: its cap glows, the callout reads high
    const b = await at(TL.vg + 1.3);
    assert.ok(b.capHL > 0.6, `focus gate lit (${b.capHL})`);
    const gate = b.co.find((c) => c.title.startsWith('Gate'));
    assert.equal(gate.title, 'Gate · carry in');
    assert.equal(gate.sub, 'V_G high');
    assert.ok(gate.a > 0.5);

    // the channel forms: green along the fin under the gate, callout says so
    const c = await at(TL.chan + 1.0);
    assert.ok(c.chanHL > 0.4, `channel glows (${c.chanHL})`);
    const fin = c.co.find((x) => x.title === 'Fin');
    assert.equal(fin.sub, 'channel forming');
    assert.ok(['Source', 'Drain'].every((t) => c.co.find((x) => x.title === t).a > 0.5), 'source and drain named');
    assert.ok(c.co.filter((x) => x.a > 0.01).length <= 4, 'at most four callouts at once');

    // the trench is open and the callouts sit on the section face (where the silicon layer continues)
    const d = await at(TL.si - 0.4);
    assert.ok(d.cutY > 10 && d.cutVisible === false, `lamella lifted out (${d.cutY}, ${d.cutVisible})`);
    for (const t of ['Source', 'Drain', 'Fin']) { const x = d.co.find((cc) => cc.title === t); assert.ok(Math.abs(x.at[2] - 6.62) < 0.05, `${t} callout on the section face (${x.at})`); }

    // budget at every beat of the layer
    for (const r of [a, b, c, d, await at(TL.vg)]) {
      assert.ok(r.calls <= 220, `${r.t}: ${r.calls} draw calls`);
      assert.ok(r.tris <= 1.5e6, `${r.t}: ${r.tris} triangles`);
    }
    assert.deepEqual(errors, []);
  } finally { await s.close(); await H.teardown(); }
});

test('transistor layer: a falling input (subtraction) reverses gate and channel', { timeout: 240000 }, async () => {
  const s = await H.open('?manual&silent');
  try {
    const { page, errors } = s;
    const ok = await page.evaluate(async (c) => { window.__lab.editor.setCode(c); return window.__lab.editor.run(); }, SUB);
    assert.ok(ok, 'program runs');
    await page.evaluate(() => window.__lab.pause());
    const st = await page.evaluate(() => ({ inDir: window.__lab.story.adder.key.inDir, driver: window.__lab.story.adder.key.driver }));
    assert.equal(st.inDir, -1, 'this program drives the key column with a falling input');
    const TL = await page.evaluate(() => window.__lab.TL);
    const at = (t) => page.evaluate(probe, t);
    const before = await at(TL.vg - 0.1);
    assert.ok(before.capHL > 0.6, `gate starts high (${before.capHL})`);
    assert.equal(before.co.find((c) => c.title.startsWith('Gate')).sub, 'V_G high');
    const after = await at(TL.chan + 1.0);
    assert.ok(after.capHL < 0.05, `gate falls (${after.capHL})`);
    assert.equal(after.co.find((c) => c.title.startsWith('Gate')).sub, 'V_G low');
    assert.equal(after.co.find((c) => c.title === 'Fin').sub, 'channel closing');
    assert.ok(after.chanHL < before.chanHL, 'channel glow fades as it closes');
    assert.deepEqual(errors, []);
  } finally { await s.close(); await H.teardown(); }
});
