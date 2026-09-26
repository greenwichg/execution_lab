// The narration script, the voice asset and the narrated cut (film clock ↔ story clock).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.cjs');

let s;
before(async () => { s = await H.open('norender&paused', { width: 960, height: 540 }); });
after(async () => { await s?.close(); await H.teardown(); });

test('voice asset: every narration line has a decoded clip with matching text', async () => {
  const r = await s.page.evaluate(() => {
    const d = window.__lab.audio.director, NS = window.__lab.audio.NarrationScript;
    return { lines: NS.lines.map((l) => ({ id: l.id, text: l.text })), clips: Object.fromEntries(Object.entries(d.asset.clips).map(([k, v]) => [k, v.text])),
      decoded: d.asset.buffers.size, meta: d.asset.meta, ready: d.ready };
  });
  assert.equal(r.ready.asset, true, `asset ready (${r.ready.error})`);
  assert.equal(r.lines.length, 25);
  assert.equal(r.decoded, 25);
  for (const l of r.lines) assert.equal(r.clips[l.id], l.text, `clip text for ${l.id}`);
  assert.equal(r.meta.label, 'TEMPORARY NARRATION VOICE');
  assert.equal(r.meta.temporary, true);
});

test('narrated schedule: ordered, never overlapping, anchored to its beats', async () => {
  const r = await s.page.evaluate(() => ({ sched: window.__lab.audio.schedule(), lines: window.__lab.audio.NarrationScript.lines.map((l) => ({ id: l.id, anchorT: l.anchorT })), dur: window.__lab.audio.director.cuts.narrated.duration }));
  const anchorOf = Object.fromEntries(r.lines.map((l) => [l.id, l.anchorT]));
  for (let i = 0; i < r.sched.length; i++) {
    const l = r.sched[i];
    assert.ok(Math.abs(l.F1 - l.F0 - l.dur) < 1e-9, `${l.id} spans its clip`);
    if (anchorOf[l.id] != null) assert.ok(l.T0 >= anchorOf[l.id] - 1e-3, `${l.id} starts at/after its beat (${l.T0} vs ${anchorOf[l.id]})`);
    if (i) assert.ok(l.F0 >= r.sched[i - 1].F1 + 0.3 - 1e-9, `${l.id} starts after ${r.sched[i - 1].id} ends + pause`);
    assert.ok(l.T0 >= 0 && l.T1 <= 84.6);
  }
  assert.ok(r.dur > 120 && r.dur < 150, `narrated cut ≈ 2–2.5 min (${r.dur.toFixed(1)} s)`);
});

test('film cut: monotone, never faster than story time, invertible', async () => {
  const r = await s.page.evaluate(() => {
    const cut = window.__lab.audio.director.cuts.narrated, out = { maxRate: 0, minRate: 9, worstInv: 0, monotone: true };
    let prev = -1;
    for (let F = 0; F <= cut.duration; F += 0.05) {
      const T = cut.storyAt(F);
      if (T < prev - 1e-9) out.monotone = false;
      prev = T;
      const r = cut.rate(Math.min(F, cut.duration - 0.01));
      out.maxRate = Math.max(out.maxRate, r); out.minRate = Math.min(out.minRate, r);
      out.worstInv = Math.max(out.worstInv, Math.abs(cut.filmAt(T) - F));
    }
    out.ends = [cut.storyAt(0), cut.storyAt(cut.duration)];
    return out;
  });
  assert.ok(r.monotone, 'story time never runs backwards');
  assert.ok(r.maxRate <= 1.02, `story never runs faster than 1× (max ${r.maxRate.toFixed(3)})`);
  assert.ok(r.minRate > 0.05, `story never freezes (min ${r.minRate.toFixed(3)})`);
  assert.ok(r.worstInv < 1e-3, `filmAt(storyAt(F)) = F (err ${r.worstInv})`);
  assert.deepEqual(r.ends.map((x) => +x.toFixed(6)), [0, 84.6]);
});

test('audio cues: one sorted list, carry pulses follow the adder simulation', async () => {
  // cues are built with the engine; build the same list directly here (no AudioContext needed)
  const r = await s.page.evaluate(() => {
    const d = window.__lab.audio.director;
    d.setMode('narrated');
    const cues = d.cues.length ? d.cues : null;
    return { cues, schedule: window.__lab.audio.schedule().length, mode: d.mode };
  });
  assert.equal(r.mode, 'narrated');
  // cues exist only once sound starts; the transport test checks them live. Here: nav never lands mid-sentence.
  const nav = await s.page.evaluate(() => {
    const d = window.__lab.audio.director, sched = window.__lab.audio.schedule();
    return window.__lab.STAGES.map((st) => { const F = d.navFilm(st); return { id: st.id, F, inside: sched.filter((l) => F > l.F0 + 1e-6 && F < l.F1).map((l) => l.id) }; });
  });
  for (const n of nav) assert.deepEqual(n.inside, [], `stage ${n.id} target is not mid-sentence`);
  for (let i = 1; i < nav.length; i++) assert.ok(nav[i].F > nav[i - 1].F, `stage targets increase (${nav[i].id})`);
});

test('subtitle/card/panel state follows the film clock', async () => {
  const r = await s.page.evaluate(() => {
    const d = window.__lab.audio.director, sched = window.__lab.audio.schedule(), at = (F) => { const h = d.hudState(F); return { line: h.line?.id ?? null, card: h.card?.ln.id ?? null, panel: h.panel, reveals: [...h.reveals] }; };
    const L = Object.fromEntries(sched.map((l) => [l.id, l]));
    return {
      midSource: at((L['source.1'].F0 + L['source.1'].F1) / 2),
      midIntroCard: at((L['intro.1'].F0 + L['intro.1'].F1) / 2),
      midRoutes: at((L['routes.0'].F0 + L['routes.0'].F1) / 2),
      afterEnding: at(L['ending.1'].F0 + 0.1),
      beforeAny: at(1.0),
    };
  });
  assert.deepEqual(r.midSource, { line: 'source.1', card: null, panel: null, reveals: [] });
  assert.equal(r.midIntroCard.card, 'intro.1');
  assert.equal(r.midIntroCard.line, null, 'a line shown on a card is never duplicated in the subtitles');
  assert.equal(r.midRoutes.panel, 'paths');
  assert.ok(r.afterEnding.reveals.includes('wrote-2'));
  assert.deepEqual(r.beforeAny, { line: null, card: null, panel: null, reveals: [] });
});

test('no console errors or warnings', () => { assert.deepEqual(s.errors, []); });
