// The code editor: write a program, run it, and the film becomes about it.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.cjs');

after(H.teardown);

const SUM = 'int total = 0;\nfor (int i = 1; i <= 10; i++) {\n  total = total + i;\n}\nprintf("%d\\n", total);\nreturn total;';
const AREA = 'int width = 6;\nint height = 7;\nint area = width * height;\nprintf("area = %d\\n", area);\nreturn area;';
const run = (page) => page.evaluate(() => window.__lab.editor.run());
const statusOf = (page) => page.evaluate(() => ({ text: window.__lab.editor.status, cls: document.querySelector('#edStatus').className, runOff: document.querySelector('#edRun').disabled }));

test('editor: open, type, errors, examples, follow picker, keyboard isolation', async () => {
  const s = await H.open('autoplay&q=0&norender', { width: 1366, height: 768 });
  const { page, errors } = s;
  await page.evaluate(() => window.__lab.jump(30));
  // E opens the editor and pauses the film
  await page.keyboard.press('e');
  await H.until(page, () => window.__lab.editor.open);
  assert.equal(await page.isVisible('#editor'), true);
  assert.equal(await page.evaluate(() => window.__lab.timeline.playing), false, 'film paused while editing');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'edText', 'focus in the code');

  // typing never reaches the film's shortcuts (Space, R, M, arrows, E)
  await page.fill('#edText', '');
  await page.keyboard.type('int x = 5;');
  await page.keyboard.press('Enter');
  await page.keyboard.type('x = x + 3; // r m e');
  await page.keyboard.press('ArrowLeft');
  const iso = await page.evaluate(() => ({ T: window.__lab.T, playing: window.__lab.timeline.playing, muted: window.__lab.audio.director.settings.muted, text: document.querySelector('#edText').value }));
  assert.equal(iso.text, 'int x = 5;\nx = x + 3; // r m e');
  assert.ok(Math.abs(iso.T - 30) < 1e-6, 'R did not restart');
  assert.equal(iso.playing, false, 'Space did not play');
  assert.equal(iso.muted, false, 'M did not mute');
  await H.until(page, () => /Compiled and ran/.test(window.__lab.editor.status));
  // Tab indents, Enter after { indents the next line
  await page.fill('#edText', 'if (1) {');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  assert.equal(await page.inputValue('#edText'), 'if (1) {\n    ');

  // a mistake: line + column, the line marked, Run disabled
  await page.evaluate(() => window.__lab.editor.setCode('int total = 0;\nfor (int i = 1; i <= 10; i++) {\n  total = total + j;\n}\nreturn total;'));
  let st = await statusOf(page);
  assert.match(st.text, /^Error — Line 3, column 19: "j" hasn't been declared/);
  assert.match(st.cls, /err/);
  assert.equal(st.runOff, true);
  assert.equal(await page.locator('#edHl .herr').count(), 1, 'error line highlighted');
  // a runtime error
  await page.evaluate(() => window.__lab.editor.setCode('int a = 4;\nint b = a - 4;\nreturn a / b;'));
  st = await statusOf(page);
  assert.match(st.text, /^Runtime error — Line 3.*Division by zero/);
  // nothing the film can follow
  await page.evaluate(() => window.__lab.editor.setCode('int x = 5;\nreturn x;'));
  st = await statusOf(page);
  assert.match(st.text, /addition, subtraction, multiplication or comparison/);
  assert.equal(st.runOff, true);

  // examples load and compile; the follow picker lists every operation
  await page.selectOption('#edExamples', '1');
  assert.equal(await page.inputValue('#edText'), AREA);
  st = await statusOf(page);
  assert.match(st.text, /Compiled and ran: .* returned 42\./);
  assert.equal(st.runOff, false);
  assert.equal((await page.textContent('#edOut')).trim(), 'area = 42');
  await page.selectOption('#edExamples', '0');
  const opts = await page.$$eval('#edFollow option', (os) => os.map((o) => ({ v: +o.value, t: o.textContent })));
  assert.ok(opts.length >= 3, `several operations to follow (${opts.length})`);
  assert.match(opts[0].t, /^line 3 · total \+ i\s+\(last of 10: 45 \+ 10 = 55\)$/, 'the loop body is followed by default');
  await page.selectOption('#edFollow', String(opts[1].v));
  assert.equal(await page.evaluate(() => window.__lab.editor.pick), opts[1].v);

  // Escape closes, the button toggles
  await page.focus('#edText');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.__lab.editor.open), false);
  await page.click('#codeBtn');
  assert.equal(await page.evaluate(() => window.__lab.editor.open), true);
  await page.click('#codeBtn');
  assert.equal(await page.evaluate(() => window.__lab.editor.open), false);
  assert.deepEqual(errors, []);
  await s.close();
});

test('Run & Explain turns the program into the film, and back to the demo', async () => {
  const s = await H.open('autoplay&q=0&norender', { width: 1366, height: 768 });
  const { page, errors } = s;
  await page.keyboard.press('e');
  await page.evaluate((src) => window.__lab.editor.setCode(src), SUM);
  await page.click('#edRun');
  await H.until(page, () => window.__lab.story.id === 'program' && window.__lab.timeline.playing, null, 60000);
  assert.equal(await page.isVisible('#editor'), false, 'editor closes');
  const info = await page.evaluate(() => {
    const L = window.__lab, st = L.story;
    return {
      run0: L.TL.run0, run1: L.TL.run1, featured: st.featured.exprText, a: st.featured.a, b: st.featured.b, r: st.featured.r,
      calc: document.querySelector('#calc').textContent, brand: document.querySelector('.brand-sub').textContent,
      dbg: L.audio.debug(), sched: L.audio.schedule(), stages: L.STAGES.map((x) => x.t),
    };
  });
  assert.ok(info.run0 > 0 && info.run1 > info.run0, 'a RUN segment is inserted');
  assert.equal(info.featured, 'total + i');
  assert.deepEqual([info.a, info.b, info.r], [45, 10, 55]);
  assert.match(info.calc.replace(/\s+/g, ' '), /45 \+ 10 = 55/);
  assert.match(info.brand, /YOUR PROGRAM/);
  assert.equal(info.dbg.story, 'program');
  assert.equal(info.dbg.voiceKind, 'speech');
  assert.equal(info.dbg.cut, 'narrated', 'the program film is laid out around its narration');
  assert.ok(info.sched.length >= 20, `generated narration (${info.sched.length} lines)`);
  assert.ok(info.sched.some((l) => l.id === 'run.0' && /steps through \d+ statements, goes around a loop 10 times, prints 55 and returns 55/.test(l.text)));
  assert.ok(info.sched.some((l) => /total \+ i on line 3|total plus i on line 3/.test(l.text)));
  for (let i = 1; i < info.sched.length; i++) assert.ok(info.sched[i].F0 >= info.sched[i - 1].F1 - 1e-6, `lines never overlap (${info.sched[i].id})`);
  for (let i = 1; i < info.stages.length; i++) assert.ok(info.stages[i] > info.stages[i - 1], 'stages stay ordered');

  // mid-run: the EXECUTION panel shows the variables changing, subtitles carry the voice (silent mode)
  await page.evaluate(() => { const L = window.__lab; L.pause(); L.jump((L.TL.run0 + L.TL.run1) / 2); });
  await H.until(page, () => document.querySelector('#runPanel').classList.contains('on'));
  const mid = await page.evaluate(() => ({ step: document.querySelector('#runStep').textContent, vars: document.querySelector('#runVars').textContent }));
  assert.match(mid.vars, /total/);
  assert.match(mid.step, /STEP|MORE STEPS/);
  await page.evaluate(() => { const L = window.__lab; L.jump(L.TL.run1 + 0.5); });
  await H.until(page, () => /DONE · \d+ STEPS · RETURNED 55/.test(document.querySelector('#runStep').textContent));
  assert.match(await page.textContent('#runOut'), /55/);
  const runLine = info.sched.find((l) => l.id === 'run.0');
  await page.evaluate((F) => window.__lab.jumpFilm(F), (runLine.F0 + runLine.F1) / 2);
  await H.until(page, () => window.__lab.audio.hud().line === 'run.0');
  await H.until(page, () => /When it runs/.test(window.__lab.audio.hud().subs));
  await page.evaluate(() => window.__lab.jump(0));
  await H.until(page, () => !document.querySelector('#runPanel').classList.contains('on'));

  // back to the original demo: the 84.6 s silent film again
  await page.keyboard.press('e');
  await page.click('#edDemo');
  await H.until(page, () => window.__lab.story.id === 'demo' && window.__lab.timeline.playing, null, 60000);
  const d = await page.evaluate(() => ({ dbg: window.__lab.audio.debug(), run0: window.__lab.TL.run0, calc: document.querySelector('#calc').textContent }));
  assert.equal(d.dbg.voiceKind, 'clips');
  assert.equal(d.dbg.cut, 'silent');
  assert.ok(Math.abs(d.dbg.duration - 84.6) < 1e-6, `demo duration ${d.dbg.duration}`);
  assert.equal(d.run0, undefined);
  assert.match(d.calc.replace(/\s+/g, ' '), /5 \+ 3 = 8/);
  assert.deepEqual(errors, []);
  await s.close();
});

test('speech narration: the film waits at the end of a sentence until the voice finishes', async () => {
  // a controllable speech synthesiser: utterances end only when the test says so
  const stub = () => {
    const spoken = [];
    window.__spoken = spoken;
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    const synth = {
      getVoices: () => [{ name: 'Test Voice', lang: 'en-US', default: true, localService: true }],
      speak(u) { spoken.push(u); setTimeout(() => u.onstart?.(), 5); },
      cancel() { for (const u of spoken) if (!u.done) { u.done = true; u.onerror?.({ error: 'interrupted' }); } },
      pause() {}, resume() {}, addEventListener() {}, speaking: false, pending: false,
    };
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
    window.__finishSpeech = () => { for (const u of spoken) if (!u.done) { u.done = true; u.onend?.(); } };
  };
  const s = await H.open(`norender&q=0&code=${encodeURIComponent(SUM)}`, { width: 1280, height: 720, init: stub });
  const { page, errors } = s;
  await H.beginWithSound(page);
  assert.equal(await page.evaluate(() => window.__lab.audio.speech.voice?.name), 'Test Voice');
  await page.evaluate(() => { window.__lab.pause(); });
  assert.equal(await page.evaluate(() => window.__lab.editor.run()), true);
  await H.until(page, () => window.__spoken.length >= 1, null, 30000);
  const first = await page.evaluate(() => {
    const text = window.__spoken[0].text;
    return window.__lab.audio.schedule().find((l) => l.text === text);
  });
  assert.ok(first, 'the first spoken sentence is on the schedule');
  assert.match(first.text, /You've written 6 lines of code/);
  // the estimate runs out but the voice is still talking: the film holds at the sentence end
  await H.until(page, (F1) => window.__lab.F >= F1 - 0.02, first.F1, 20000);
  await H.sleep(1200);
  const held = await page.evaluate(() => window.__lab.F);
  assert.ok(held <= first.F1 + 0.02, `film held at ${held.toFixed(3)} (sentence ends at ${first.F1.toFixed(3)})`);
  assert.equal(await page.evaluate(() => window.__lab.timeline.playing), true, 'still playing, only waiting');
  // the voice finishes → the film moves on
  await page.evaluate(() => window.__finishSpeech());
  await H.until(page, (F1) => window.__lab.F > F1 + 0.3, first.F1, 10000);
  // muting stops the voice and never holds the film
  await page.keyboard.press('m');
  await H.until(page, () => window.__lab.audio.director.settings.muted);
  assert.equal(await page.evaluate(() => window.__lab.audio.director.filmLimit()), Infinity);
  assert.deepEqual(errors, []);
  await s.close();
});

test('?code=…&run opens straight into that program', async () => {
  const s = await H.open(`autoplay&q=0&norender&run&code=${encodeURIComponent(AREA)}`, { width: 1280, height: 720 });
  const { page, errors } = s;
  const st = await page.evaluate(() => ({ id: window.__lab.story.id, feat: window.__lab.story.featured.exprText, code: document.querySelector('#edText').value, playing: window.__lab.timeline.playing }));
  assert.equal(st.id, 'program');
  assert.equal(st.feat, 'width * height');
  assert.equal(st.code, AREA);
  assert.equal(st.playing, true);
  assert.deepEqual(errors, []);
  await s.close();
});

test('a shared ?code= link cannot inject markup', async () => {
  const evil = 'printf("<img src=x onerror=window.__xss=1>");\nint a = 1 + 2;\nreturn a;';
  const s = await H.open(`autoplay&q=0&norender&run&code=${encodeURIComponent(evil)}`, { width: 1280, height: 720 });
  const { page, errors } = s;
  assert.equal(await page.evaluate(() => window.__lab.story.id), 'program');
  await page.evaluate(() => { window.__lab.editor.show(); const L = window.__lab; L.pause(); L.jump(L.TL.run1 + 0.5); });
  await H.until(page, () => /RETURNED 3/.test(document.querySelector('#runStep').textContent));
  await H.sleep(300);
  assert.equal(await page.evaluate(() => document.querySelectorAll('img').length), 0, 'no <img> element was created');
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.match(await page.textContent('#edOut'), /<img src=x/, 'the output is shown as text');
  assert.deepEqual(errors, []);
  await s.close();
});

test('rebuilding the film for new programs does not leak GPU memory', async () => {
  const s = await H.open('autoplay&q=0', { width: 480, height: 270 });
  const { page, errors } = s;
  const once = async (src) => {
    if (src) { await page.evaluate((c) => window.__lab.editor.setCode(c), src); await run(page); } else await page.evaluate(() => window.__lab.editor.demo());
    await H.sleep(300);
    return page.evaluate(() => { const i = window.__lab.info(); return { g: i.geometries, t: i.textures, story: window.__lab.story.id }; });
  };
  const ms = [];
  for (const src of [SUM, AREA, SUM, null, SUM, AREA, SUM]) ms.push(await once(src));
  assert.equal(ms.at(-1).story, 'program');
  const sums = [ms[0], ms[2], ms[4], ms[6]];
  // geometries are exact; which label textures are on the GPU depends on the frames drawn so far
  assert.ok(sums.every((m) => m.g <= sums[0].g + 2), `geometries stable: ${ms.map((m) => m.g).join(' → ')}`);
  assert.ok(sums.every((m) => m.t <= sums[0].t * 1.1), `textures stable: ${ms.map((m) => m.t).join(' → ')}`);
  assert.deepEqual(errors, []);
  await s.close();
});
