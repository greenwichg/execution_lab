// Full narrated journey, start to finish, in real time.
//   node journey.cjs                 # clocks + audio only (fast on software GL)
//   RENDER=1 node journey.cjs        # also render the film and save a frame per narration line
//   RECORD=1 node journey.cjs        # also record the final mix to artifacts/journey-mix.webm
// Prints a timing report: every line's scheduled vs actual start, cue order,
// picture/sound sync and the mix levels per act.
const fs = require('fs');
const path = require('path');
const H = require('./harness.cjs');

const RENDER = process.env.RENDER === '1', RECORD = process.env.RECORD === '1';
(async () => {
  const s = await H.open(RENDER ? 'q=0' : 'norender', RENDER ? { width: 960, height: 540 } : { width: 1280, height: 720 });
  const { page } = s;
  await H.beginWithSound(page);
  if (RECORD) {
    await page.evaluate(() => {
      const e = window.__lab.audio.director.engine, dest = e.ctx.createMediaStreamDestination();
      e.master.connect(dest);
      const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 160000 });
      window.__chunks = []; rec.ondataavailable = (ev) => window.__chunks.push(ev.data); rec.start(1000); window.__rec = rec;
    });
  }
  const sched = await page.evaluate(() => window.__lab.audio.schedule());
  const dur = await page.evaluate(() => window.__lab.timeline.duration);
  const samples = [], shots = new Set();
  await page.evaluate(() => { window.__lab.timeline.syncWorst = 0; });
  const t0 = Date.now();
  while (true) {
    const r = await page.evaluate(() => {
      const a = window.__lab.audio, d = a.debug();
      return { F: d.F, T: d.T, state: d.state, playing: window.__lab.timeline.playing, v: a.level('voice'), fx: a.level('fx'), amb: a.level('amb'), mus: a.level('music'), m: a.level('master'), subs: a.hud().subs, syncErr: d.syncErr };
    });
    samples.push(r);
    if (RENDER) {
      const ln = sched.find((l) => r.F >= l.F0 + 0.6 && r.F < l.F1 && !shots.has(l.id));
      if (ln) { shots.add(ln.id); await H.shot(page, `journey-${String(shots.size).padStart(2, '0')}-${ln.id}`); }
    }
    if (!r.playing && r.F >= dur - 0.01) break;
    if (Date.now() - t0 > (dur + 60) * 1000) throw new Error('journey did not finish');
    await H.sleep(200);
  }
  const wall = (Date.now() - t0) / 1000;
  const d = await page.evaluate(() => { const x = window.__lab.audio.debug(); return { voiceLog: window.__lab.audio.director.narr.log, sfx: window.__lab.audio.director.sfx.log, syncWorst: x.syncWorst, cues: window.__lab.audio.cues() }; });
  if (RECORD) {
    const b64 = await page.evaluate(async () => { window.__rec.stop(); await new Promise((r) => setTimeout(r, 1500)); const blob = new Blob(window.__chunks, { type: 'audio/webm' }); const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)); return btoa(s); });
    fs.mkdirSync(H.ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(H.ARTIFACTS, 'journey-mix.webm'), Buffer.from(b64, 'base64'));
  }
  // ---- report ----
  const lines = [];
  const say = (x) => { lines.push(x); console.log(x); };
  say(`narrated journey: film ${dur.toFixed(1)} s, wall ${wall.toFixed(1)} s, ${RENDER ? 'rendered' : 'no-render'}`);
  let missing = 0, worstLate = 0;
  for (const l of sched) {
    const st = d.voiceLog.filter((v) => v.id === l.id);
    if (!st.length) { missing++; say(`  MISSING ${l.id}`); continue; }
    worstLate = Math.max(worstLate, st[0].late);
    if (st.length > 1 || st[0].offset > 0.05 || st[0].late > 0.02) say(`  note ${l.id}: starts ${st.length}, offset ${st[0].offset.toFixed(3)}, late ${st[0].late.toFixed(3)}`);
  }
  say(`voice lines started: ${sched.length - missing}/${sched.length} · worst late start ${(worstLate * 1000).toFixed(1)} ms`);
  const cueIds = d.cues.map((c) => c.id), fired = d.sfx.map((e) => e.id).filter((id) => cueIds.includes(id));
  let ordered = true; for (let i = 1; i < fired.length; i++) if (cueIds.indexOf(fired[i]) < cueIds.indexOf(fired[i - 1])) ordered = false;
  say(`effect cues fired: ${new Set(fired).size}/${cueIds.length} · in story order: ${ordered}`);
  const notFired = cueIds.filter((id) => !fired.includes(id));
  if (notFired.length) say(`  not fired: ${notFired.join(', ')}`);
  say(`worst per-frame picture/sound error: ${(d.syncWorst * 1000).toFixed(1)} ms`);
  const TL = await page.evaluate(() => window.__lab.TL);
  const acts = [['Act I software', 3, TL.pkg - 1.5], ['Act II processor', TL.pkg - 1.5, TL.gIn - 1], ['Act III gates', TL.gIn - 1, TL.xtor - 0.5], ['transistor', TL.xtor - 0.5, TL.si - 0.5], ['silicon', TL.si - 0.5, TL.pull], ['pull-back', TL.pull + 0.5, TL.end[0]], ['end card', TL.end[0], 84.6]];
  const db = (xs) => (xs.length ? 10 * Math.log10(xs.reduce((a, x) => a + Math.pow(10, x / 10), 0) / xs.length) : -Infinity);
  say('mix levels (mean RMS dBFS per act; voice only while speaking):');
  for (const [name, a, b] of acts) {
    const w = samples.filter((x) => x.T >= a && x.T < b);
    const speaking = w.filter((x) => x.v.rms > -50);
    say(`  ${name.padEnd(17)} voice ${db(speaking.map((x) => x.v.rms)).toFixed(1).padStart(6)}  fx ${db(w.map((x) => x.fx.rms)).toFixed(1).padStart(6)}  amb ${db(w.map((x) => x.amb.rms)).toFixed(1).padStart(6)}  music ${db(w.map((x) => x.mus.rms)).toFixed(1).padStart(6)}  master ${db(w.map((x) => x.m.rms)).toFixed(1).padStart(6)}`);
  }
  say(`master peak max: ${Math.max(...samples.map((x) => x.m.peak)).toFixed(1)} dBFS`);
  say(`console errors/warnings: ${s.errors.length ? s.errors.join(' | ') : 'none'}`);
  fs.mkdirSync(H.ARTIFACTS, { recursive: true });
  fs.writeFileSync(path.join(H.ARTIFACTS, `journey-report${RENDER ? '-rendered' : ''}.txt`), lines.join('\n') + '\n');
  await s.close(); await H.teardown();
  process.exit(missing || !ordered || s.errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
