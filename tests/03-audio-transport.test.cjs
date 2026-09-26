// Live sound: audio graph, narration sync, mute, subtitles, pause/resume, scrub,
// stage jumps, speed, tab visibility, restart and effect-cue scheduling.
// Runs with ?norender so the clocks run in real time on a software-GL machine.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.cjs');

let s, page, L;
const dbg = () => page.evaluate(() => window.__lab.audio.debug());
const level = (bus) => page.evaluate((b) => window.__lab.audio.level(b), bus);
const F = () => page.evaluate(() => window.__lab.F);
const waitF = (f, timeout = 30000) => H.until(page, (x) => window.__lab.F >= x, f, timeout);
const voiceStarts = (id) => page.evaluate((i) => window.__lab.audio.debug().voiceLog.filter((v) => v.id === i), id);
/** loudest voice-bus RMS seen over `ms` */
async function peakVoice(ms = 600) {
  let best = -200;
  for (let t = 0; t < ms; t += 60) { best = Math.max(best, (await level('voice')).rms); await H.sleep(60); }
  return best;
}
async function timelineX(f) {
  const r = await page.evaluate(() => { const b = document.querySelector('#timeline').getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2, w: b.width, dur: window.__lab.timeline.duration }; });
  return { x: r.x + (f / r.dur) * r.w, y: r.y };
}
async function jumpFilm(f) { await page.evaluate((x) => window.__lab.jumpFilm(x), f); }
/** worst per-frame |heard audio − film clock| over `ms`, once the picture has caught up with the sound */
async function syncWorstOver(ms) {
  await H.until(page, () => { const d = window.__lab.audio.debug(); return d.syncErr !== null && d.syncErr > -0.02; });
  await page.evaluate(() => { window.__lab.timeline.syncWorst = 0; });
  await H.sleep(ms);
  return page.evaluate(() => window.__lab.timeline.syncWorst);
}

before(async () => {
  s = await H.open('norender&q=0', { width: 1280, height: 720 });
  page = s.page;
  await page.evaluate(() => { try { localStorage.removeItem('cel.audio'); } catch { /* ignore */ } });
  await H.beginWithSound(page);
  L = Object.fromEntries((await page.evaluate(() => window.__lab.audio.schedule())).map((l) => [l.id, l]));
});
after(async () => { await s?.close(); await H.teardown(); });

test('audio graph initialises inside the Begin click', async () => {
  const d = await dbg();
  assert.equal(d.ctx, 'running');
  assert.equal(d.mode, 'narrated');
  assert.equal(d.cut, 'narrated');
  assert.ok(d.duration > 120 && d.duration < 150);
  const g = await page.evaluate(() => { const e = window.__lab.audio.director.engine; return ['voice', 'fx', 'amb', 'music', 'master'].map((k) => !!e.meters[k]).concat([e.limiter.ratio.value >= 12, e.ctx.sampleRate > 0]); });
  assert.ok(g.every(Boolean), 'voice / effects / ambience / music buses → limiter → master');
  assert.ok(d.cues > 40, `sound cues built (${d.cues})`);
});

test('first lines play on cue, heard in sync with the film clock', async () => {
  await waitF(L['intro.0'].F0 + 0.4);
  assert.ok(await peakVoice() > -40, 'voice audible during intro.0');
  const starts = await voiceStarts('intro.0');
  assert.equal(starts.length, 1);
  assert.ok(starts[0].late < 0.02, `intro.0 scheduled ahead, not late (${starts[0].late})`);
  const worst = await syncWorstOver(2000);
  assert.ok(worst < 0.03, `every frame shows what is being heard (worst |Δ| ${(worst * 1000).toFixed(1)} ms)`);
  assert.equal(await page.evaluate(() => document.querySelector('#subs span').textContent), await page.evaluate(() => window.__lab.audio.hud().subs) || 'You\'ve written three lines of code.');
  const m = await level('master');
  assert.ok(m.peak < -0.5, `master peak under the limiter ceiling (${m.peak.toFixed(1)} dBFS)`);
});

test('pause mid-sentence and resume from the exact word', async () => {
  await waitF(L['intro.1'].F0 + 0.8);
  await page.keyboard.press('Space');
  await H.sleep(450);
  const p = await dbg();
  assert.equal(p.state, 'pause');
  assert.deepEqual(p.speaking, [], 'voice stopped');
  assert.ok((await level('voice')).rms < -60, 'voice faded out');
  const Fp = p.F;
  await H.sleep(800);
  assert.equal(await F(), Fp, 'film clock frozen while paused');
  await page.keyboard.press('Space');
  await H.until(page, () => window.__lab.audio.debug().speaking.includes('intro.1'));
  const live = (await dbg()).live.find((r) => r.id === 'intro.1');
  assert.ok(Math.abs(live.offset - (Fp - L['intro.1'].F0)) < 0.1, `resumed at offset ${live.offset.toFixed(2)} (paused at ${(Fp - L['intro.1'].F0).toFixed(2)})`);
  assert.ok(await peakVoice(900) > -45, 'voice audible again');
});

test('M mutes everything, and the choice persists', async () => {
  await page.keyboard.press('m');
  await H.sleep(400);
  assert.ok((await level('master')).rms < -90, 'master silent');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('cel.audio')).muted), true);
  assert.match(await page.textContent('#toast'), /muted/i);
  await page.keyboard.press('m');
  await H.sleep(500);
  assert.ok((await level('master')).rms > -80, 'sound back');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('cel.audio')).muted), false);
});

test('C toggles subtitles', async () => {
  await jumpFilm(L['source.1'].F0 - 0.3);
  await waitF(L['source.1'].F0 + 0.3);
  assert.equal(await page.evaluate(() => document.querySelector('#subs').classList.contains('on')), true);
  assert.equal(await page.textContent('#subs span'), L['source.1'].text);
  assert.equal(await page.isVisible('#capBody'), false, 'long caption text is replaced by the narration');
  await page.keyboard.press('c');
  await H.sleep(150);
  assert.equal(await page.evaluate(() => document.querySelector('#subs').classList.contains('on')), false);
  await page.keyboard.press('c');
  await H.sleep(150);
  assert.equal(await page.evaluate(() => document.querySelector('#subs').classList.contains('on')), true);
});

test('scrub: silent while dragging, early release rewinds to the sentence start', async () => {
  const ln = L['syntax.0'];
  const a = await timelineX(ln.F0 + 1.0), b = await timelineX(ln.F0 + 1.2);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await H.sleep(300);
  const mid = await dbg();
  assert.equal(mid.state, 'scrub');
  assert.deepEqual(mid.speaking, [], 'no voice while dragging');
  await page.mouse.up();
  await H.until(page, () => window.__lab.audio.debug().state === 'play');
  const land = await F();
  assert.ok(land < ln.F0 + 0.35, `released early in the sentence → back to its start (F ${land.toFixed(2)}, line at ${ln.F0.toFixed(2)})`);
  await H.until(page, () => window.__lab.audio.debug().speaking.includes('syntax.0'));
  const st = (await voiceStarts('syntax.0')).pop();
  assert.ok(st.offset < 0.12, `sentence starts from its first word (offset ${st.offset.toFixed(2)})`);
});

test('scrub: late release waits for the next sentence', async () => {
  const ln = L['lowering.0'], next = L['machine.0'];
  const a = await timelineX(ln.F0 + 4.6);
  await page.mouse.click(a.x, a.y);
  await H.until(page, (f) => window.__lab.audio.debug().state === 'play' && window.__lab.timeline.scrubTarget === null && Math.abs(window.__lab.F - f) < 0.5, ln.F0 + 4.6);
  const land = await F();
  assert.ok(Math.abs(land - (ln.F0 + 4.6)) < 0.3, `stays where released (F ${land.toFixed(2)})`);
  await H.sleep(700);
  assert.ok(!(await dbg()).speaking.includes('lowering.0'), 'does not restart mid-sentence');
  await waitF(next.F0 + 0.3, 8000);
  const st = (await voiceStarts('machine.0')).pop();
  assert.ok(st && st.late < 0.02 && st.offset < 0.05, 'next sentence starts on time from its first word');
});

test('stage jump: voice fades, travel sound, camera travel, then the new narration', async () => {
  const cpu = await page.evaluate(() => window.__lab.STAGES.findIndex((s) => s.id === 'CPU'));
  await page.click(`#stages .stg:nth-child(${cpu + 1})`);
  await H.sleep(250);
  const j = await dbg();
  assert.equal(j.state, 'jump');
  assert.deepEqual(j.speaking, []);
  assert.ok(j.sfxLog.some((e) => e.id === 'travel' && e.sound === 'whoosh'), 'travel sound');
  await H.until(page, () => window.__lab.audio.debug().state === 'play', null, 8000);
  const target = await page.evaluate(() => window.__lab.audio.director.navFilm(window.__lab.STAGES.find((s) => s.id === 'CPU')));
  assert.ok(Math.abs((await F()) - target) < 0.4, 'arrived at the stage');
  await waitF(L['cpu.0'].F0 + 0.3, 6000);
  const st = (await voiceStarts('cpu.0')).pop();
  assert.ok(st && st.offset < 0.05 && st.late < 0.02, 'CPU narration starts cleanly after arrival');
});

test('speed ≠ 1×: narration off, subtitles forced on, user told why', async () => {
  await page.keyboard.press('c');                                  // subtitles off …
  await page.click('#speedBtn');                                   // … then 1.5×
  await H.sleep(300);
  assert.match(await page.textContent('#toast'), /1×/);
  const d = await dbg();
  assert.equal(d.speed, 1.5);
  assert.deepEqual(d.speaking, []);
  await H.until(page, () => !!window.__lab.audio.hud().line, null, 15000);
  assert.equal(await page.evaluate(() => document.querySelector('#subs').classList.contains('on')), true, 'subtitles forced on while narration is off');
  assert.ok((await level('amb')).rms > -80, 'ambience continues');
  for (let i = 0; i < 3; i++) await page.click('#speedBtn');       // 2× → 0.5× → 1×
  assert.equal((await dbg()).speed, 1);
  await page.keyboard.press('c');                                  // subtitles back on
  const next = await page.evaluate(() => { const F = window.__lab.F; return window.__lab.audio.schedule().find((l) => l.F0 > F + 0.2); });
  await waitF(next.F0 + 0.3, 15000);
  const st = (await voiceStarts(next.id)).pop();
  assert.ok(st && st.offset < 0.05, `narration resumes at the next sentence (${next.id})`);
});

test('hidden tab auto-pauses; returning resumes without drift', async () => {
  const setHidden = (h) => page.evaluate((hidden) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, h);
  await setHidden(true);
  await H.sleep(500);
  const h = await dbg();
  assert.equal(h.state, 'pause');
  assert.equal(h.ctx, 'suspended');
  const Fh = h.F;
  await H.sleep(700);
  await setHidden(false);
  await H.until(page, () => { const d = window.__lab.audio.debug(); return d.state === 'play' && d.ctx === 'running' && d.master !== null; });
  const back = await dbg();
  assert.ok(back.F - Fh < 0.3, `continued from where it stopped (${Fh.toFixed(2)} → ${back.F.toFixed(2)})`);
  const worst = await syncWorstOver(1500);
  assert.ok(worst < 0.03, `no drift after returning (worst ${(worst * 1000).toFixed(1)} ms)`);
});

test('effect cues fire in order; carry pulses keep the adder timing', async () => {
  const cues = await page.evaluate(() => window.__lab.audio.cues());
  for (let i = 1; i < cues.length; i++) assert.ok(cues[i].T >= cues[i - 1].T, 'cue list sorted by story time');
  const carry = cues.filter((c) => c.id.startsWith('carry_bit_'));
  assert.deepEqual(carry.map((c) => c.id), ['carry_bit_0', 'carry_bit_1', 'carry_bit_2', 'carry_bit_3']);
  await jumpFilm(carry[0].F - 0.6);
  await waitF(carry[3].F + 0.4, 20000);
  const log = (await dbg()).sfxLog.filter((e) => e.id.startsWith('carry_bit_'));
  const last4 = log.slice(-4);
  assert.deepEqual(last4.map((e) => e.id), carry.map((c) => c.id), 'all four carries sounded, in order');
  for (let i = 1; i < 4; i++) {
    const heard = last4[i].at - last4[0].at, film = carry[i].F - carry[0].F;
    assert.ok(Math.abs(heard - film) < 0.03, `carry ${i} spacing ${heard.toFixed(3)} s vs film ${film.toFixed(3)} s`);
  }
  const flip = cues.find((c) => c.id === 'flip');
  assert.equal(flip.sound, 'resolve', 'a single resolved tone marks 0 → 1');
});

test('R restarts the narrated film from the beginning', async () => {
  const before = (await voiceStarts('intro.0')).length;
  await page.keyboard.press('r');
  await H.until(page, () => window.__lab.audio.debug().state === 'jump');
  await H.until(page, () => window.__lab.audio.debug().state === 'play', null, 8000);
  assert.ok((await F()) < 1.0);
  await waitF(L['intro.0'].F0 + 0.3, 8000);
  assert.equal((await voiceStarts('intro.0')).length, before + 1);
});

test('no console errors, decode errors or warnings', () => { assert.deepEqual(s.errors, []); });
