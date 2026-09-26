// The original silent film must keep working exactly as before.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.cjs');

after(H.teardown);

// counts AudioContext constructions so we can prove silent mode never touches audio
const countContexts = () => {
  window.__ctxCount = 0;
  const Real = window.AudioContext;
  window.AudioContext = class extends Real { constructor(...a) { super(...a); window.__ctxCount++; } };
};

test('?autoplay plays the silent cut with no gate and no audio', async () => {
  const s = await H.open('autoplay&q=0', { width: 1280, height: 720, init: countContexts });
  const { page, errors } = s;
  assert.equal(await page.isVisible('#gate'), false, 'gate hidden');
  await H.until(page, () => document.querySelector('#controls').classList.contains('on'));
  const d0 = await page.evaluate(() => window.__lab.audio.debug());
  assert.equal(d0.mode, 'silent');
  assert.equal(d0.cut, 'silent');
  assert.ok(Math.abs(d0.duration - 84.6) < 1e-6, `silent cut is the original 84.6 s film (${d0.duration})`);
  const t0 = await page.evaluate(() => window.__lab.T);
  await H.sleep(2500);
  const t1 = await page.evaluate(() => window.__lab.T);
  assert.ok(t1 > t0 + 0.2, `film advances (${t0.toFixed(2)} → ${t1.toFixed(2)})`);
  assert.equal(await page.evaluate(() => window.__ctxCount), 0, 'no AudioContext created');
  assert.equal(await page.evaluate(() => window.__lab.F === window.__lab.T), true, 'silent film clock = story clock');
  // long captions are still shown in the silent cut; no subtitles
  await page.evaluate(() => { window.__lab.jump(40); window.__lab.pause(); });
  await H.sleep(600);
  assert.equal(await page.isVisible('#capBody'), true, 'caption body visible');
  assert.equal(await page.evaluate(() => document.querySelector('#subs').classList.contains('on')), false, 'no subtitles');
  await H.shot(page, 'silent-1280x720-t40');
  assert.deepEqual(errors, []);
  await s.close();
});

test('existing deep links (?t, ?paused, ?manual) still work', async () => {
  const s = await H.open('manual&paused&t=33&q=0', { width: 960, height: 540 });
  const { page, errors } = s;
  const st = await page.evaluate(() => { window.__lab.step(1 / 60); return { T: window.__lab.T, playing: window.__lab.timeline.playing, gate: !document.querySelector('#gate').hidden }; });
  assert.ok(Math.abs(st.T - 33) < 1e-6, `T=${st.T}`);
  assert.equal(st.playing, false);
  assert.equal(st.gate, false);
  // stage navigation in the silent cut targets the original story times
  const nav = await page.evaluate(() => window.__lab.STAGES.map((s) => window.__lab.audio.director.navFilm(s)));
  assert.deepEqual(nav.map((x) => +x.toFixed(3)), [4.6, 10, 21.4, 25.4, 31.7, 43.9, 48.3, 54, 58.8, 64.6]);
  assert.deepEqual(errors, []);
  await s.close();
});
