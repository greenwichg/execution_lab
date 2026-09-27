// The silicon layers in the reference style: a FinFET cross-section of matte instanced parts with small
// callouts (contact, source/drain, high-k film, gate metal, channel) whose channel fills with electrons as the
// story's gate voltage rises; then the crystal under that gate — a diamond-cubic lattice of grey atoms with
// one atom and its four bonds highlighted, a spacing callout that agrees with the FIELD OF VIEW ruler, and a
// stream of electrons at the bit flip. Everything is driven by the story (rising or falling input).
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

/** callouts of a layer that are on screen */
const callouts = (page, layer) => page.evaluate((id) => {
  const { kit } = window.__lab;
  return kit.Callouts.items.filter((it) => it.L === kit.LAYER[id] && it.el.style.visibility !== 'hidden' && +it.el.style.opacity > 0.3)
    .map((it) => ({ title: it.tt.textContent, sub: it.st.textContent }));
}, layer);

/** geometry of the si + lat layers */
const inspect = (page) => page.evaluate(() => {
  const { kit } = window.__lab, THREE = kit.THREE;
  const r = { labels: 0, si: {}, lat: {}, fade: { si: kit.LAYER.si.fade, lat: kit.LAYER.lat.fade }, info: window.__lab.info() };
  for (const id of ['si', 'lat']) kit.LAYER[id].group.traverse((o) => {
    if (o.material?.uniforms?.uClip) r.labels++;                               // in-world text labels (label())
    if (o.name) r[id][o.name] = { n: o.count ?? 1, inst: !!o.isInstancedMesh, fade: o.material?.userData?.fadeU?.value, u: o.material?.uniforms ? Object.fromEntries(['uG', 'uBurst', 'uI'].filter((k) => o.material.uniforms[k]).map((k) => [k, o.material.uniforms[k].value])) : null };
  });
  // the crystal: atom centres, the highlighted atom and highlighted bonds
  const pos = [], m4 = new THREE.Matrix4(), v = new THREE.Vector3();
  let hi = null, hiBonds = 0, hiAtoms = 0, bondLen = 0;
  kit.LAYER.lat.group.traverse((o) => {
    if (!o.isInstancedMesh) return;
    const aHL = o.geometry.attributes.aHL;
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m4); v.setFromMatrixPosition(m4);
      const h = aHL ? aHL.getX(i) : 0;
      if (o.name.startsWith('lat-atoms')) { pos.push(v.toArray()); if (h > 0.5) { hi = v.toArray(); hiAtoms++; } }
      else if (o.name.startsWith('lat-bonds') && h > 0.5) { hiBonds++; bondLen = new THREE.Vector3().setFromMatrixScale(m4).y; }
    }
  });
  const d = hi ? pos.map((p) => Math.hypot(p[0] - hi[0], p[1] - hi[1], p[2] - hi[2])).filter((x) => x > 1e-6).sort((a, b) => a - b) : [];
  r.crystal = { atoms: pos.length, hiAtoms, hiBonds, bondLen, nn: d.slice(0, 6) };
  return r;
});

const fovNm = (page) => page.evaluate(() => { const t = document.querySelector('#fovTxt').textContent; const m = /([\d.]+)\s*(nm|pm)/.exec(t); return m ? +m[1] * (m[2] === 'pm' ? 1e-3 : 1) : NaN; });

async function checkStory(page, label) {
  const st = await page.evaluate(() => { const A = window.__lab.story.adder; return { rising: A.key.inDir >= 0, bit: (A.w ?? 0) + A.key.k, to: window.__lab.story.cards.flip[1] }; });
  // cross-section (ref: gate, fin, channel)
  await at(page, 'si', 0.6);
  const s1 = await inspect(page);
  assert.ok(s1.fade.si > 0.9, `${label}: si layer visible (${s1.fade.si})`);
  assert.equal(s1.labels, 0, `${label}: no in-world text labels in si/lat`);
  for (const k of ['si-matte', 'si-metal', 'si-epi', 'si-cont']) assert.ok(s1.si[k]?.inst, `${label}: ${k} is instanced`);
  assert.ok(Object.values(s1.si).filter((o) => o.inst).reduce((s, o) => s + o.n, 0) > 100, `${label}: dense cross-section`);
  const c1 = await callouts(page, 'si');
  const titles = c1.map((c) => c.title);
  for (const t of ['Contact', 'Source / drain', 'High-k film', 'Gate metal']) assert.ok(titles.includes(t), `${label}: callout ${t} (${JSON.stringify(titles)})`);
  assert.ok(c1.length <= 4, `${label}: at most four callouts (${c1.length})`);
  const gate = c1.find((c) => c.title === 'Gate metal');
  assert.match(gate.sub, st.rising ? /V_G high$/ : /V_G low$/, `${label}: gate voltage from the story (${gate.sub})`);
  assert.equal(s1.si['si-channel'].fade, 1, `${label}: channel opaque while the lattice is away`);
  // closer: the channel and its live state
  await at(page, 'si', 1.5);
  const c2 = await callouts(page, 'si');
  const ch = c2.find((c) => c.title === 'Channel');
  assert.ok(ch, `${label}: channel callout (${JSON.stringify(c2)})`);
  assert.equal(ch.sub, st.rising ? 'electrons gathering' : 'electrons leaving', `${label}: channel state`);
  assert.ok(c2.length <= 4, `${label}: at most four callouts`);
  const s2 = await inspect(page);
  assert.ok(s2.si['si-electrons'].u.uG > 0.05, `${label}: electrons in the channel (${s2.si['si-electrons'].u.uG})`);
  // the crystal under the gate
  await at(page, 'lattice', 1.6);
  const s3 = await inspect(page);
  assert.ok(s3.fade.lat > 0.99 && s3.fade.si < 0.01, `${label}: lattice has replaced the cross-section (${JSON.stringify(s3.fade)})`);
  assert.ok(s3.info.tris <= 1.5e6 && s3.info.calls <= 220, `${label}: within the frame budget (${s3.info.tris} tris, ${s3.info.calls} calls)`);
  const X = s3.crystal;
  assert.ok(X.atoms > 1500, `${label}: thousands of atoms (${X.atoms})`);
  assert.equal(X.hiAtoms, 1, `${label}: one highlighted atom`);
  assert.equal(X.hiBonds, 4, `${label}: its four bonds highlighted`);
  assert.ok(Math.abs(X.nn[3] - X.bondLen) < 1e-3 && X.nn[4] > X.bondLen * 1.5, `${label}: four nearest neighbours at the bond length (${X.nn.map((x) => x.toFixed(2))})`);
  const c3 = await callouts(page, 'lat');
  assert.ok(c3.some((c) => c.title === 'One silicon atom' && c.sub === 'bonds to four neighbours'), `${label}: atom callout (${JSON.stringify(c3)})`);
  assert.ok(c3.some((c) => c.title === '0.235 nm apart'), `${label}: spacing callout`);
  // the spacing agrees with the FIELD OF VIEW ruler: frame width (render units) ↔ the ruler's nanometres
  const w = await page.evaluate(() => { const i = window.__lab.info(); return 2 * i.Df * Math.tan((38 * Math.PI) / 360) * (i.px[0] / i.px[1]); });
  const nm = await fovNm(page);
  const bondNm = X.bondLen * (nm / w);
  assert.ok(bondNm > 0.17 && bondNm < 0.31, `${label}: a bond is ≈ 0.235 nm on the ruler's scale (${bondNm.toFixed(3)} nm; field ${nm} nm)`);
  // the bit flips: electrons stream (rising) or the channel empties (falling)
  await at(page, 'flip', 0.3);
  const s4 = await inspect(page);
  const e = s4.lat['lat-electrons'].u;
  assert.ok(e.uBurst > 0.5, `${label}: surge at the flip`);
  if (st.rising) assert.ok(e.uG > 0.95, `${label}: full stream of electrons (${e.uG})`);
  else assert.ok(e.uG < 0.05, `${label}: channel emptied (${e.uG})`);
  const c4 = await callouts(page, 'lat');
  const fl = c4.find((c) => c.title === (st.rising ? 'Electrons flow' : 'Channel empties'));
  assert.ok(fl, `${label}: flip callout (${JSON.stringify(c4)})`);
  assert.ok(fl.sub.endsWith(`bit ${st.bit} = ${st.to}`), `${label}: flip callout names the story's bit (${fl.sub})`);
}

test('demo: cross-section callouts, the channel, the crystal and its highlighted atom', async () => {
  const s = await H.open('manual&silent&q=0', { width: 1280, height: 720 });
  const { page, errors } = s;
  await checkStory(page, 'demo');
  assert.deepEqual(errors, []);
  await s.close();
});

test('program stories drive the gate voltage, channel state and the flip (falling and rising inputs)', async () => {
  const s = await H.open('manual&silent&q=0', { width: 1280, height: 720 });
  const { page, errors } = s;
  const seen = new Set();
  for (const [name, src] of [['sub', 'int a = 200;\nint b = a - 73;\nreturn b;\n'], ['loop', 'int total = 0;\nfor (int i = 1; i <= 4; i++) {\n  total = total + i * 31;\n}\nreturn total;\n']]) {
    const ok = await page.evaluate(async (c) => { window.__lab.editor.setCode(c); return window.__lab.editor.run(); }, src);
    assert.ok(ok, `${name} runs`);
    await page.evaluate(() => window.__lab.pause());
    seen.add(await page.evaluate(() => window.__lab.story.adder.key.inDir >= 0));
    await checkStory(page, name);
  }
  assert.ok(seen.has(false), 'a falling input is covered');
  assert.deepEqual(errors, []);
  await s.close();
});
