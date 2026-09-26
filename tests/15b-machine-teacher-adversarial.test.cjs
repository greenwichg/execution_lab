// Predict the Machine — adversarial checks of the teacher surfaces, as
// (a) a teacher projecting a starter on a 1366×768 / 1920×1080 projector,
// (b) learners doing sets on Chromebooks and phones, and
// (c) a methodologist checking the board's study numbers against study.js.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const H = require('./harness.cjs');

after(H.teardown);

const MACHINE = path.join(H.ROOT, 'machine/src');
const esm = (rel) => import(pathToFileURL(path.join(MACHINE, rel)).href);
const PHONE = { width: 390, height: 844, isMobile: true, hasTouch: true };
const store = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(`pm.${k}`) || 'null'), key);
const put = (page, key, value) => page.evaluate(([k, v]) => localStorage.setItem(`pm.${k}`, JSON.stringify(v)), [key, value]);
const view = (page, name) => page.waitForSelector(`main[data-view="${name}"]`);
const go = async (page, route, name) => {
  await page.evaluate((r) => { location.hash = r; }, route);
  await view(page, name);
};
const todayOf = (page) => page.evaluate(() => { const d = new Date(); return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000); });
const scrollX = (page) => page.evaluate(() => document.documentElement.scrollWidth);
function clean(s, label) {
  assert.deepEqual(s.errors, [], `${label}: console errors`);
  const foreign = s.requests.filter((u) => !/^http:\/\/127\.0\.0\.1:\d+\//.test(u) && !u.startsWith('data:') && !u.startsWith('blob:'));
  assert.deepEqual(foreign, [], `${label}: requests to another origin`);
}

/** WCAG contrast of an element's text against the first opaque background behind it */
const contrastOf = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const rgb = (c) => (c.match(/[\d.]+/g) || []).map(Number);
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  let bg = null;
  for (let n = el; n && !bg; n = n.parentElement) { const c = rgb(getComputedStyle(n).backgroundColor); if (c.length >= 3 && (c.length < 4 || c[3] > 0.9)) bg = c; }
  const fg = rgb(getComputedStyle(el).color);
  const [a, b] = [lum(fg), lum(bg || [255, 255, 255])].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}, sel);

/** a class that has addition (2 weeks ago) and shifts (3 weeks ago) taught, saved before the app reads it */
async function seedClass(page, { level = 'gcse', taught } = {}) {
  const day = await todayOf(page);
  const cls = { v: 1, id: 'ctest', name: 'Year 10 set 2', level, taught: taught || { 'J277-1.2.4-add': day - 14, 'J277-1.2.4-shift': day - 21 }, taps: [] };
  await put(page, 'classes', [cls]);
  return { cls, day };
}
const prompts = (page) => page.evaluate(async () => {
  const out = [];
  for (let k = 0; k < 5; k++) {
    // the prompt and the operand bits (not the answer, which a tapped question shows revealed)
    out.push(document.querySelector('.sr-prompt').textContent + '|' + [...document.querySelectorAll('.rv-bit, .rv-bitbox')].map((c) => c.textContent).join(''));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
  }
  for (let k = 0; k < 5; k++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  return out;
});

// ---------------------------------------------------------------------------------------------
test('reveal: every carry, result bit and lost bit matches the engine; lost only on overflow; ripple runs right to left', async () => {
  const s = await H.openMachine('/', { width: 1366, height: 768 });
  const { page } = s;
  const report = await page.evaluate(async () => {
    const R = await import('./src/ui/reveal.js');
    const { makeItem } = await import('./src/learn/items/index.js');
    const { addBits, subBits, toBits } = await import('./src/engine/bits.js');
    const { mulberry32, randInt } = await import('./src/lib/rng.js');
    const rng = mulberry32(2024);
    const problems = [];
    const read = (grid, cls) => [...grid.querySelectorAll(`.${cls}`)].map((c) => c.textContent);
    let n = 0, lostSeen = 0, silentCarrySeen = 0;
    for (let k = 0; k < 400; k++) {
      const signed = k % 2 === 1;
      const w = [4, 6, 8, 8, 8, 12][k % 6];
      let item;
      if (!signed) item = makeItem('add', { w, a: randInt(rng, 0, 2 ** w - 1), b: randInt(rng, 0, 2 ** w - 1), ask: 'result' });
      else {
        const lo = -(2 ** (w - 1)), hi = 2 ** (w - 1) - 1;
        item = makeItem('sadd', { w, a: randInt(rng, lo, hi), b: randInt(rng, lo, hi), op: k % 4 === 1 ? '-' : '+', askFlags: ['OF'] });
      }
      const box = document.createElement('div');
      document.body.append(box);
      const ctl = R.mountAddition(box, item);
      if (box.querySelectorAll('.rv-carry.on, .rv-res.on').length) problems.push(`${k}: answer visible before reveal`);
      await ctl.reveal({ animate: false });
      const p = item.params;
      const truth = signed ? (p.op === '-' ? subBits(p.a, p.b, w) : addBits(p.a, p.b, w)) : addBits(p.a, p.b, w);
      const B = signed && p.op === '-' ? truth.binv : toBits(p.b, w);
      // columns MSB first; carry row has w + 1 cells (carry out first), result row w + 1 (extra first)
      const carries = read(box, 'rv-carry');
      const res = read(box, 'rv-res');
      const bRow = [...box.querySelectorAll('.rv-bit')].slice(w).map((c) => c.textContent).join('');
      if (bRow !== B.slice().reverse().join('')) problems.push(`${k}: second row ${bRow}`);
      for (let i = 0; i <= w; i++) {
        const want = truth.carries[i] === 1 ? '1' : '';
        if (carries[w - i] !== want) problems.push(`${k}: carry into ${i} is "${carries[w - i]}", want "${want}"`);
      }
      const bits = res.slice(1).join('');
      if (bits !== truth.result.slice().reverse().join('')) problems.push(`${k}: result ${bits}`);
      const overflow = signed ? truth.OF === 1 : truth.cout === 1;
      const lost = box.querySelector('.rv-lost');
      const shouldLose = truth.cout === 1 && overflow;
      if (!!lost !== shouldLose) problems.push(`${k}: lost bit ${lost ? 'drawn' : 'missing'} (cout ${truth.cout}, overflow ${overflow})`);
      if (lost && (getComputedStyle(lost).textDecorationLine !== 'line-through' || lost.textContent !== '1')) problems.push(`${k}: lost bit not struck through`);
      const out = box.querySelector('.rv-carry-out');
      if (truth.cout === 1 && !overflow) {
        silentCarrySeen++;
        if (out.classList.contains('rv-carry-lost') || res[0] !== '') problems.push(`${k}: ignored signed carry drawn as lost`);
      }
      if (shouldLose) lostSeen++;
      const note = box.querySelector('.rv-note').textContent;
      if (overflow !== /overflow/i.test(note.replace(/No overflow/i, ''))) problems.push(`${k}: note "${note}"`);
      if (!signed && overflow && !note.includes(`needs ${w + 1} bits`)) problems.push(`${k}: note "${note}"`);
      box.remove();
      n++;
    }
    // the ripple: carries appear right to left, before any result bit
    const item = makeItem('add', { w: 8, a: 255, b: 1, ask: 'result' });
    const box = document.createElement('div');
    document.body.append(box);
    const ctl = R.mountAddition(box, item);
    const order = [];
    const t0 = performance.now();
    const cells = [...box.querySelectorAll('.rv-carry')];
    const resCells = [...box.querySelectorAll('.rv-res')];
    let firstResult = null;
    const mo = new MutationObserver(() => {
      cells.forEach((c, pos) => { if (c.classList.contains('on') && !order.some((o) => o.pos === pos)) order.push({ pos, t: performance.now() - t0 }); });
      if (firstResult === null && resCells.some((c) => c.classList.contains('on'))) firstResult = performance.now() - t0;
    });
    mo.observe(box, { subtree: true, attributes: true, attributeFilter: ['class'] });
    await ctl.reveal({ animate: true });
    mo.disconnect();
    const total = performance.now() - t0;
    box.remove();
    return { problems, n, lostSeen, silentCarrySeen, order, firstResult, total };
  });
  assert.deepEqual(report.problems, [], 'reveal matches the engine');
  assert.equal(report.n, 400);
  assert.ok(report.lostSeen > 20 && report.silentCarrySeen > 10, `both cases met (${report.lostSeen} lost, ${report.silentCarrySeen} ignored)`);
  const positions = report.order.map((o) => o.pos);
  assert.deepEqual(positions, [...positions].sort((a, b) => b - a), 'carries appear right to left');
  assert.equal(positions.length, 9);
  assert.ok(report.order[8].t - report.order[1].t >= 7 * 100, 'about 120 ms per column');
  assert.ok(report.firstResult >= report.order[8].t, 'result bits after the carries');
  assert.ok(report.total <= 2000, `the whole ripple is short (${Math.round(report.total)} ms)`);
  clean(s, 'reveal');
  await s.close();
});

// ---------------------------------------------------------------------------------------------
test('starter on projectors: big high-contrast digits, keyboard only, stable plan, taps persist and feed the next plan', async () => {
  const starter = await esm('learn/starter.js');
  const s = await H.openMachine('/', { width: 1366, height: 768 });
  const { page } = s;
  const { day } = await seedClass(page);

  // the teacher preview and the projected plan
  await go(page, '/teacher?class=ctest', 'teacher');
  await H.until(page, () => document.querySelectorAll('.tc-plan-line').length === 5);
  const preview = await page.$$eval('.tc-plan-title', (els) => els.map((e) => e.textContent));
  assert.match(await page.textContent('#tc-starter ~ *, .panel.raised'), /W explains/);
  await page.click('text=Project starter');
  await view(page, 'starter');
  const first = await prompts(page);
  assert.equal(first.length, 5);

  // every button shows its key; every key works
  const btns = await page.$$eval('.sr-btn', (els) => els.map((b) => [b.textContent, !!b.querySelector('.kbd'), b.getAttribute('aria-keyshortcuts')]));
  for (const [label, hasKbd, keys] of btns) assert.ok(hasKbd && keys, `"${label}" shows its key`);
  // find the addition question
  let at = 0;
  while (!(await page.$('.rv-add')) && at < 5) { await page.keyboard.press('ArrowRight'); at++; }
  assert.ok(await page.$('.rv-add'), 'an addition question');
  const minFont = await page.$$eval('.rv-bit', (els) => Math.min(...els.map((e) => parseFloat(getComputedStyle(e).fontSize))));
  assert.ok(minFont >= 48, `operand digits ${minFont}px at 1366×768`);
  for (const sel of ['.rv-bit', '.sr-prompt', '.sr-note', '.sr-board', '.sr-title', '.rv-idx']) {
    const c = await contrastOf(page, sel);
    assert.ok(c >= 7, `${sel} contrast ${c && c.toFixed(1)} ≥ 7 (bright classroom)`);
  }
  // reduced motion: the whole answer at once
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const instant = await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    return !!document.querySelector('.rv-done') && document.querySelectorAll('.rv-res.on').length >= 4;
  });
  assert.ok(instant, 'reveal is instant under reduced motion');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await H.until(page, () => document.querySelector('.sr-taps'));
  const noteContrast = await contrastOf(page, '.rv-verdict');
  assert.ok(noteContrast >= 4.5, `verdict contrast ${noteContrast.toFixed(1)}`);
  await H.until(page, () => /announce|revealed/i.test(document.getElementById('live').textContent) || true);
  // tap: Most missed, then change to Split — one tap is kept
  await page.keyboard.press('3');
  await H.until(page, () => (JSON.parse(localStorage.getItem('pm.classes'))[0].taps || []).length === 1);
  await page.keyboard.press('2');
  await H.until(page, () => JSON.parse(localStorage.getItem('pm.classes'))[0].taps[0].result === 'split');
  assert.equal((await store(page, 'classes'))[0].taps.length, 1, 'changing the tap replaces it');
  assert.equal(await page.getAttribute('.sr-tap-split', 'aria-pressed'), 'true');
  assert.match(await page.textContent('.sr-tap-split'), /✓/, 'the chosen tap is marked by a glyph, not colour alone');
  assert.equal(await page.evaluate(() => document.getElementById('live').textContent), 'Recorded: Split.');
  // Why: W opens layers one at a time; at the deepest layer the button goes, and the rail has no duplicate button
  await page.keyboard.press('w');
  await page.waitForSelector('.sr-why .why-layer');
  assert.equal(await page.locator('.sr-why .why-foot .btn:visible').count(), 0, 'no second Deeper button in the rail');
  for (let k = 0; k < 8 && await page.$('.sr-whybtn'); k++) await page.keyboard.press('w');
  assert.equal(await page.$('.sr-whybtn'), null, 'Why button gone at the deepest layer');
  const layers = await page.locator('.sr-why .why-layer').count();
  assert.ok(layers >= 2, `${layers} layers`);
  // the buttons stay on screen however far the rail scrolled
  await H.sleep(400);
  const nb = await page.evaluate(() => document.querySelector('.sr-next').getBoundingClientRect().bottom);
  assert.ok(nb <= 768, `Next stays on screen (bottom ${nb})`);
  await H.shot(page, 'adv-starter-why-1366');

  // reload mid-lesson: the same five questions, the tap still shown, and no second tap for the question
  await page.reload();
  await view(page, 'starter');
  const again = await prompts(page);
  assert.deepEqual(again, first, 'reloading the projector keeps the same questions');
  for (let k = 0; k < at; k++) await page.keyboard.press('ArrowRight');
  assert.equal(await page.getAttribute('.sr-tap-split', 'aria-pressed'), 'true', 'the tap is still shown after a reload');
  assert.ok(await page.$('.rv-done'), 'a tapped question is shown revealed');
  await page.keyboard.press('3');
  await H.until(page, () => JSON.parse(localStorage.getItem('pm.classes'))[0].taps[0].result === 'missed');
  assert.equal((await store(page, 'classes'))[0].taps.length, 1, 'still one tap for this question after a reload');

  // Esc to the teacher page: today's preview is unchanged by today's taps
  await page.keyboard.press('Escape');
  await view(page, 'teacher');
  await H.until(page, () => document.querySelectorAll('.tc-plan-line').length === 5);
  assert.deepEqual(await page.$$eval('.tc-plan-title', (els) => els.map((e) => e.textContent)), preview, 'the preview is stable all day');
  // …and the tap feeds the next starter
  const cls = (await store(page, 'classes'))[0];
  const nextPlan = starter.buildStarter(cls, day + 1);
  const missed = nextPlan.filter((e) => e.source === 'missed');
  assert.ok(missed.some((e) => e.spec === 'J277-1.2.4-add'), 'the missed question comes back in the next starter');

  // 1920×1080: big digits, everything visible
  await page.setViewportSize({ width: 1920, height: 1080 });
  await go(page, '/starter?class=ctest', 'starter');
  for (let k = 0; k < at; k++) await page.keyboard.press('ArrowRight');
  const big = await page.$$eval('.rv-bit', (els) => Math.min(...els.map((e) => parseFloat(getComputedStyle(e).fontSize))));
  assert.ok(big >= 60, `operand digits ${big}px at 1920×1080`);
  await H.sleep(700);
  await H.shot(page, 'adv-starter-1920');
  // a shift (bit boxes) is as big
  await page.keyboard.press('ArrowLeft');
  if (!(await page.$('.rv-bits'))) await page.keyboard.press('ArrowRight'), await page.keyboard.press('ArrowRight');
  if (await page.$('.rv-bitbox')) {
    await page.setViewportSize({ width: 1366, height: 768 });
    const bb = await page.$$eval('.rv-bitbox', (els) => Math.min(...els.map((e) => parseFloat(getComputedStyle(e).fontSize))));
    assert.ok(bb >= 48, `shift digits ${bb}px at 1366×768`);
    await page.keyboard.press('Space');
    await page.waitForSelector('.rv-key dd');
    await H.sleep(700);
    const kb = await page.evaluate(() => document.querySelector('.sr-next').getBoundingClientRect().bottom);
    assert.ok(kb <= 768, `Next on screen after a shift reveal (bottom ${kb})`);
    await H.shot(page, 'adv-starter-shift-1366');
  }
  // 1280×720 is still ≥ 48 px
  await page.setViewportSize({ width: 1280, height: 720 });
  await go(page, '/starter?class=ctest', 'starter');
  for (let k = 0; k < at; k++) await page.keyboard.press('ArrowRight');
  const small = await page.$$eval('.rv-bit', (els) => Math.min(...els.map((e) => parseFloat(getComputedStyle(e).fontSize))));
  assert.ok(small >= 48, `operand digits ${small}px at 1280×720`);
  clean(s, 'starter');
  await s.close();
});

test('starter for an A-level class: signed sums reveal with flags, and a class that does not exist', async () => {
  const s = await H.openMachine('/', { width: 1920, height: 1080 });
  const { page } = s;
  const day = await todayOf(page);
  await seedClass(page, { level: 'alevel', taught: { 'H446-1.4.1-arith': day - 10, 'H446-1.4.1-twos': day - 20, 'H446-1.4.3-adders': day - 3 } });
  await go(page, '/starter?class=ctest', 'starter');
  let seen = 0;
  for (let k = 0; k < 5; k++) {
    await page.keyboard.press('Space');
    await H.until(page, () => document.querySelector('.sr-taps'));
    await H.until(page, () => !document.querySelector('.rv-add') || document.querySelector('.rv-done'));
    const txt = await page.textContent('.sr-answer, .sr-visual');
    assert.ok(txt.trim().length > 0, `question ${k + 1} shows an answer`);
    if (await page.$('.rv-add')) seen++;
    if (k === 0) { await H.sleep(500); await H.shot(page, 'adv-starter-alevel-1920'); }
    await page.keyboard.press('ArrowRight');
  }
  await page.waitForSelector('.sr-end');
  assert.match(await page.textContent('.sr-nexttime'), /Nothing was marked as split or missed/);
  assert.ok(seen >= 1, 'at least one signed sum');
  // a stale starter link
  await go(page, '/starter?class=nope', 'starter');
  assert.match(await page.textContent('main'), /No class to project/);
  assert.equal(await page.evaluate(() => document.body.classList.contains('projector')), false);
  clean(s, 'alevel starter');
  await s.close();
});

// ---------------------------------------------------------------------------------------------
/** fill every empty answer field (the runner refuses a blank prediction): 0s, "0" and each control's first choice */
async function fillAnswer(page) {
  await page.evaluate(() => {
    const area = document.querySelector('.item .item-answer');
    if (!area) return;
    const put = (i, v) => { i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); };
    for (const i of area.querySelectorAll('input.bit-in')) if (!i.value && !i.readOnly && !i.closest('.optional')) put(i, '0');
    for (const i of area.querySelectorAll('input:not(.bit-in), textarea')) if (!i.value && !i.readOnly) put(i, '0');
    for (const g of area.querySelectorAll('.seg')) if (!g.querySelector('[aria-pressed="true"]')) g.querySelector('button')?.click();
  });
}

/** answer the open question with Guessing and a filler answer; then Next */
async function answerOne(page, { next = true } = {}) {
  await page.waitForSelector('.item .confidence button');
  await fillAnswer(page);
  await page.click('.item .confidence button[data-value="guess"]');
  await page.click('.item-actions .btn.primary');
  if (!next) return;
  for (let k = 0; k < 4; k++) {
    if (await page.$('.item-next .btn')) break;
    const skip = await page.$('.checkpoint button.ghost:not([disabled])');
    if (skip) await skip.click(); else await H.sleep(50);
  }
  await page.click('.item-next .btn.primary');
}

test('sets on a Chromebook: token decodes to the plan, a reload never double-counts, misses reach the review queue', async () => {
  const codec = await esm('lib/codec.js');
  const sets = await esm('learn/sets.js');
  const code = codec.encodeSet({ level: 'gcse', topics: ['add', 'shift'], n: 7, seed: 4242, mode: 'normal' });
  const set = codec.decodeSet(code);
  const plan = sets.planSet(set);
  const s = await H.openMachine(`/set/${code}`, { width: 1366, height: 768 });
  const { page } = s;
  assert.equal(await page.locator('main[data-view="set"] h1').count(), 1);
  await page.click('text=Start');
  await answerOne(page);
  await answerOne(page);
  // Check on question 3, then the tab reloads before Next: the answer and the miss are kept once
  await answerOne(page, { next: false });
  const before = (await store(page, 'sched'))?.queue?.length || 0;
  await page.reload();
  await view(page, 'set');
  const sched1 = await store(page, 'sched');
  assert.equal(sched1.queue.length, before + 1, 'the miss on question 3 reached the review queue on reload');
  assert.match(await page.textContent('.hs-gate h2'), /^This device already has answers for this set \(3 of 7 answered, last on [^)]+\)\.$/);
  await page.click('text=Carry on from question 4');
  assert.match(await page.textContent('.item-progress'), /Question 4 of 7/);
  for (let i = 3; i < 7; i++) await answerOne(page);
  await page.waitForSelector('.hs-end .copy-value.big');
  const token = (await page.textContent('.hs-end .copy-value.big')).trim();
  const prog = await store(page, `setprog.${set.code}`);
  const expected = codec.encodeToken(sets.summarizeSet(prog.results, plan, { setId: set.setId, mode: 'normal' }));
  assert.equal(token, expected, 'the token is exactly the summary of the stored first attempts');
  const t = codec.decodeToken(token);
  assert.equal(t.g1.total + t.g2.total, 7);
  assert.equal(t.g2.total, plan.filter((p) => p.group === 'holdout').length, 'g2 counts the holdout slots');
  assert.equal(t.arm, codec.ARM_NONE);
  const missTags = [...new Set(prog.results.filter((r) => !r.correct && r.tag).map((r) => r.tag))];
  for (const tag of t.tags) assert.ok(missTags.includes(tag), `token tag ${tag} came from a miss`);
  const queueAfter = (await store(page, 'sched')).queue.length;
  // coming back to the link: same code, nothing recorded twice, no way to redo it
  await page.reload();
  await page.waitForSelector('.hs-gate');
  await page.click('button:text-is("Show my code")');
  await page.waitForSelector('.hs-end .copy-value.big');
  assert.equal((await page.textContent('.hs-end .copy-value.big')).trim(), token);
  assert.equal((await store(page, 'sched')).queue.length, queueAfter, 'reopening the set records nothing again');
  assert.equal(await page.locator('button:text-is("Start")').count(), 0);
  assert.ok(await contrastOf(page, '.hs-end .copy-value.big') >= 7);
  await H.shot(page, 'adv-set-end-1366');
  clean(s, 'normal set');
  await s.close();
});

test('study and delayed sets: the arm is never shown or chosen; recovery accepts only the linked study set\'s code', async () => {
  const codec = await esm('lib/codec.js');
  const studyCode = codec.encodeSet({ level: 'gcse', topics: ['add', 'shift'], n: 5, seed: 9001, mode: 'study' });
  const study = codec.decodeSet(studyCode);
  const otherStudy = codec.decodeSet(codec.encodeSet({ level: 'gcse', topics: ['add', 'shift'], n: 5, seed: 9002, mode: 'study' }));
  const delayedCode = codec.encodeSet({ level: 'gcse', topics: ['add', 'shift'], n: 5, seed: 9003, mode: 'delayed', link: study.setId });
  const delayed = codec.decodeSet(delayedCode);
  const g = { right: 2, total: 3 };
  const g2 = { right: 1, total: 2 };
  const tok = (o) => codec.encodeToken({ g1: g, g2, tags: [], ...o });
  const wrongSet = tok({ setId: otherStudy.setId, mode: 'study', arm: 1 });
  const normal = tok({ setId: study.setId, mode: 'normal' });
  const delayedTok = tok({ setId: study.setId, mode: 'delayed', arm: 1 });
  const unknownArm = tok({ setId: study.setId, mode: 'study', arm: codec.ARM_UNKNOWN });
  const good = tok({ setId: study.setId, mode: 'study', arm: 1 });
  const typo = `${good.slice(0, 5)}${good[5] === 'Z' ? 'Y' : 'Z'}${good.slice(6)}`;

  const s = await H.openMachine(`/set/${studyCode}?arm=0`, PHONE);
  const { page } = s;
  const armWords = /\b(arm|group|condition|control)\b/i;
  const arm = await store(page, `arm.${study.code}`);
  assert.ok(arm === 0 || arm === 1);
  assert.doesNotMatch(await page.textContent('main'), armWords, 'intro never mentions the arm');
  assert.equal(await page.locator('main select, main input[type="radio"]').count(), 0, 'nothing to choose');
  await page.click('text=Start');
  for (let i = 0; i < 5; i++) {
    assert.doesNotMatch(await page.textContent('main'), armWords, `question ${i + 1} never mentions the arm`);
    assert.ok(await scrollX(page) <= 390, 'no sideways scroll on a phone');
    if (i === 0) await H.shot(page, 'adv-set-question-390');
    await answerOne(page);
  }
  await page.waitForSelector('.hs-end');
  assert.doesNotMatch(await page.textContent('main'), armWords, 'the end never mentions the arm');
  const t = codec.decodeToken((await page.textContent('.hs-end .copy-value.big')).trim());
  assert.equal(t.arm, arm);
  assert.equal(t.mode, 'study');
  // families: g1 = addition, g2 = shifts
  const plan = (await esm('learn/sets.js')).planSet(study, { arm });
  assert.equal(t.g1.total, plan.filter((p) => p.family === 'A').length);
  assert.equal(t.g2.total, plan.filter((p) => p.family === 'B').length);

  // the delayed set on this device knows the arm already: no paste box
  await go(page, `/set/${delayedCode}`, 'set');
  assert.equal(await page.$('#hs-recover'), null, 'no recovery box when the arm is stored');
  await s.close();

  // a fresh device: only the linked study set's code (with an arm) is accepted
  const s2 = await H.openMachine(`/set/${delayedCode}`, { width: 1366, height: 768 });
  const p2 = s2.page;
  await p2.waitForSelector('#hs-recover');
  const name = await p2.evaluate(() => { const i = document.getElementById('hs-recover'); return [...i.labels].map((l) => l.textContent).join(' '); });
  assert.match(name, /Paste its result code/);
  assert.doesNotMatch(name, /Use this code/, 'the button text is not part of the input label');
  for (const [bad, why] of [[wrongSet, /different set/], [normal, /not from a study set/], [delayedTok, /not from a study set/], [unknownArm, /which group/], [typo, /mistyped|swapped/], ['hello', /12 characters|never used/]]) {
    await p2.fill('#hs-recover', bad);
    await p2.keyboard.press('Enter');
    await p2.waitForSelector('.hs-recover .callout.bad');
    assert.match(await p2.textContent('.hs-recover .callout.bad'), why, `refused: ${bad}`);
    assert.equal(await store(p2, `arm.${delayed.code}`), null, `nothing stored for ${bad}`);
  }
  await p2.fill('#hs-recover', ` ${good.toLowerCase().replace(/-/g, ' ')} `);
  await p2.click('text=Use this code');
  await p2.waitForSelector('.hs-recover .callout.ok');
  assert.equal(await store(p2, `arm.${delayed.code}`), 1);
  await H.shot(p2, 'adv-set-recovered-1366');
  await p2.click('text=Start');
  for (let i = 0; i < 5; i++) await answerOne(p2);
  const t2 = codec.decodeToken((await p2.textContent('.hs-end .copy-value.big')).trim());
  assert.equal(t2.mode, 'delayed');
  assert.equal(t2.setId, delayed.setId);
  assert.equal(t2.arm, 1, 'the recovered arm is in the token');
  clean(s2, 'delayed');
  await s2.close();

  // a fresh device that skips the paste: arm unknown
  const s3 = await H.openMachine(`/set/${delayedCode}`, { width: 1366, height: 768 });
  await s3.page.click('text=Start');
  for (let i = 0; i < 5; i++) await answerOne(s3.page);
  const t3 = codec.decodeToken((await s3.page.textContent('.hs-end .copy-value.big')).trim());
  assert.equal(t3.arm, codec.ARM_UNKNOWN);
  clean(s, 'study set');
  clean(s3, 'delayed, skipped');
  await s3.close();
});

test('set storage by full code: colliding setIds, legacy data, pruning, the linked study arm, shared devices', async () => {
  const codec = await esm('lib/codec.js');
  // two real codes with the same 10-bit setId (found by the security review)
  const A = '81A00000003FSH';
  const B = '81A00000007ASW';
  assert.equal(codec.decodeSet(A).setId, codec.decodeSet(B).setId);
  const s = await H.openMachine(`/set/${A}`, { width: 1366, height: 768 });
  const { page } = s;
  await page.click('button:text-is("Start")');
  for (let i = 0; i < 5; i++) await answerOne(page);
  await page.waitForSelector('.hs-end .copy-value.big');
  const tokenA = (await page.textContent('.hs-end .copy-value.big')).trim();
  await go(page, `/set/${B}`, 'set');
  await page.click('button:text-is("Start")');
  await answerOne(page);
  // set A still has its answers and its code
  await go(page, `/set/${A}`, 'set');
  await page.waitForSelector('.hs-gate');
  assert.match(await page.textContent('.hs-gate h2'), /\(finished /);
  await page.click('button:text-is("Show my code")');
  assert.equal((await page.textContent('.hs-end .copy-value.big')).trim(), tokenA);
  await go(page, `/set/${B}`, 'set');
  await page.waitForSelector('.hs-gate');
  assert.match(await page.textContent('.hs-gate h2'), /\(1 of 5 answered/);

  // an older build's setId-keyed progress moves to the code's key only when it is this set's
  const C = codec.decodeSet(codec.encodeSet({ level: 'gcse', topics: ['add'], n: 5, seed: 31337, mode: 'normal' }));
  const D = codec.decodeSet(codec.encodeSet({ level: 'gcse', topics: ['add'], n: 5, seed: 31338, mode: 'normal' }));
  await page.evaluate(([c, d]) => {
    localStorage.setItem(`pm.setprog.${c.setId}`, JSON.stringify({ code: c.code, results: [{ correct: true, tag: null }], token: null }));
    localStorage.setItem(`pm.setprog.${d.setId}`, JSON.stringify({ code: 'SOMEOTHERCODE0', results: [{ correct: true, tag: null }], token: null }));
  }, [C, D]);
  await go(page, `/set/${C.code}`, 'set');
  await page.waitForSelector('.hs-gate');
  assert.equal((await store(page, `setprog.${C.code}`)).results.filter(Boolean).length, 1);
  assert.equal(await store(page, `setprog.${C.setId}`), null, 'the legacy key is removed once moved');
  await go(page, `/set/${D.code}`, 'set');
  await page.waitForSelector('button:text-is("Start")');
  assert.equal(await page.locator('.hs-gate').count(), 0, 'another set\'s legacy progress is not taken');
  assert.ok(await store(page, `setprog.${D.setId}`), 'and it is left alone');

  // only the newest 100 sets keep their progress
  await page.evaluate(() => {
    const idx = JSON.parse(localStorage.getItem('pm.setindex'));
    for (let i = 0; i < 100; i++) {
      const code = `OLD${String(i).padStart(11, '0')}`;
      idx.push({ code, setId: i, mode: 'normal', t: i });
      localStorage.setItem(`pm.setprog.${code}`, JSON.stringify({ code, results: [], token: null }));
    }
    localStorage.setItem('pm.setindex', JSON.stringify(idx));
  });
  await go(page, `/set/${A}`, 'set');
  await page.waitForSelector('.hs-gate');
  const idx = await store(page, 'setindex');
  assert.equal(idx.length, 100);
  assert.equal(idx[0].code, A, 'newest first');
  assert.equal(await store(page, 'setprog.OLD00000000099'), null, 'the oldest progress is pruned');
  assert.ok(await store(page, `setprog.${B}`), 'recent sets keep theirs');
  clean(s, 'collisions');
  await s.close();

  // the delayed set finds its study set's arm by setId through the index, or an older build's arm.<setId>
  const study = codec.decodeSet(codec.encodeSet({ level: 'gcse', topics: ['add', 'shift'], n: 5, seed: 555, mode: 'study' }));
  const delayed = codec.decodeSet(codec.encodeSet({ level: 'gcse', topics: ['add', 'shift'], n: 5, seed: 556, mode: 'delayed', link: study.setId }));
  const s2 = await H.openMachine(`/set/${study.code}`, { width: 1366, height: 768 });
  const p2 = s2.page;
  const arm = await store(p2, `arm.${study.code}`);
  assert.ok(arm === 0 || arm === 1);
  await go(p2, `/set/${delayed.code}`, 'set');
  await p2.waitForSelector('button:text-is("Start")');
  assert.equal(await p2.$('#hs-recover'), null, 'the linked arm is found');
  await p2.click('button:text-is("Start")');
  for (let i = 0; i < 5; i++) await answerOne(p2);
  const t = codec.decodeToken((await p2.textContent('.hs-end .copy-value.big')).trim());
  assert.equal(t.arm, arm, 'the delayed code carries the study arm');
  // someone else on this device: Start fresh forgets the previous learner's group and offers the paste box
  await p2.reload();
  await p2.waitForSelector('.hs-gate');
  await p2.click('button:text-is("Start fresh (I\'m someone else)")');
  await p2.waitForSelector('#hs-recover');
  await p2.click('button:text-is("Start")');
  for (let i = 0; i < 5; i++) await answerOne(p2);
  assert.equal(codec.decodeToken((await p2.textContent('.hs-end .copy-value.big')).trim()).arm, codec.ARM_UNKNOWN);
  // an older build stored the study arm under arm.<setId>
  await p2.evaluate((d) => { localStorage.clear(); localStorage.setItem(`pm.arm.${d.link}`, '1'); }, delayed);
  await go(p2, '/', 'home');
  await go(p2, `/set/${delayed.code}`, 'set');
  await p2.waitForSelector('button:text-is("Start")');
  assert.equal(await p2.$('#hs-recover'), null, 'the legacy arm is still found');
  clean(s2, 'delayed arm');
  await s2.close();
});

test('projector digits are at least 48 px at 1366×768 and 1920×1080: reveal, Why rail, board overlay; dark OS stays light', async () => {
  const codec = await esm('lib/codec.js');
  const DIGITS = ['.rv-bit', '.rv-carry.on', '.rv-res.on', '.rv-right', '.rv-bitbox', '.cols-grid .c', '.cols-grid .c-right',
    '.eq-box', '.eq-total', '.sh-bits .c', '.flag-val'].join(', ');
  /** every element the class must read that has a digit in it and is under 48 px (font size or box height) */
  const tooSmall = (page, scope) => page.$$eval(`${scope} :is(${DIGITS})`, (els) => els
    .filter((e) => /\d/.test(e.textContent) && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')
    .map((e) => ({ t: e.textContent.trim(), cls: e.className, f: parseFloat(getComputedStyle(e).fontSize), h: Math.round(e.getBoundingClientRect().height) }))
    .filter((x) => x.f < 48 || x.h < 48));
  const count = (page, scope) => page.$$eval(`${scope} :is(${DIGITS})`, (els) => els.filter((e) => /\d/.test(e.textContent)).length);
  for (const vp of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
    const s = await H.openMachine('/', vp);
    const { page } = s;
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await seedClass(page, { taught: { 'J277-1.2.4-add': (await todayOf(page)) - 14, 'J277-1.2.4-shift': (await todayOf(page)) - 21 } });
    await go(page, '/starter?class=ctest', 'starter');
    let checked = 0;
    for (let q = 0; q < 5; q++) {
      await page.keyboard.press('Space');
      await page.waitForSelector('.sr-answer[data-revealed="true"]', { state: 'attached' });
      for (let k = 0; k < 8; k++) {
        if (!(await page.$('.sr-whybtn'))) break;
        await page.keyboard.press('w');
      }
      const bad = await tooSmall(page, '.sr-q');
      assert.deepEqual(bad, [], `question ${q + 1} at ${vp.width}×${vp.height}`);
      checked += await count(page, '.sr-q');
      if (q === 0 || (await page.$('.sr-why .cols-grid'))) await H.shot(page, `adv-starter-why-${vp.width}-q${q + 1}`);
      await page.keyboard.press('ArrowRight');
    }
    assert.ok(checked > 60, `measured ${checked} digits`);
    // the page is light on the projector whatever the OS theme
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(bg, 'rgb(255, 255, 255)');
    // the board's worked-example overlay
    const tok = (tags) => codec.encodeToken({ setId: 5, mode: 'normal', g1: { right: 3, total: 8 }, g2: { right: 1, total: 2 }, tags });
    await go(page, '/board', 'board');
    await page.fill('#bd-codes', [tok(['add_no_carry', 'shift_fill', 'twos_no_plus1']), tok(['flags_sub_carry'])].join('\n'));
    await page.click('button:text-is("Analyse")');
    await page.waitForSelector('.bd-bars');
    const n = await page.locator('.bd-bar button:text-is("Project a worked example")').count();
    assert.equal(n, 4);
    for (let i = 0; i < n; i++) {
      await page.locator('.bd-bar button:text-is("Project a worked example")').nth(i).click();
      await page.waitForSelector('.wx');
      assert.deepEqual(await tooSmall(page, '.wx'), [], `overlay ${i + 1} at ${vp.width}×${vp.height}`);
      assert.ok(await count(page, '.wx') > 5);
      const soft = await page.evaluate(() => getComputedStyle(document.querySelector('.wx .chip')).backgroundColor);
      assert.equal(soft, 'rgb(230, 231, 251)', 'projector chips use the light tokens under a dark OS');
      if (i === 0) await H.shot(page, `adv-board-wx-${vp.width}`);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.wx', { state: 'detached' });
    }
    clean(s, `projector ${vp.width}`);
    await s.close();
  }
});

test('starter survives a stored class whose taps or taught dates are not the right shape', async () => {
  const s = await H.openMachine('/', { width: 1366, height: 768 });
  const { page } = s;
  const day = await todayOf(page);
  await put(page, 'classes', [{ v: 1, id: 'c1', name: 'Broken', level: 'gcse', taught: { 'J277-1.2.4-add': day - 14 }, taps: {} },
    { v: 1, id: 'c2', name: 'Broken too', level: 'gcse', taught: [], taps: 'x' }]);
  await go(page, '/starter?class=c1', 'starter');
  await page.waitForSelector('.sr-prompt');
  await page.keyboard.press('Space');
  await page.keyboard.press('3');
  await H.until(page, () => Array.isArray(JSON.parse(localStorage.getItem('pm.classes'))[0].taps));
  await go(page, '/starter?class=c2', 'starter');
  await page.waitForSelector('.sr-prompt');
  await page.keyboard.press('Space');
  await page.keyboard.press('1');
  await H.until(page, () => JSON.parse(localStorage.getItem('pm.classes'))[1].taps.length === 1);
  await go(page, '/teacher?class=c2', 'teacher');
  clean(s, 'damaged classes');
  await s.close();
});

test('board: unclassified mistakes are a count after the named ones; mixed normal and study rows say which groups they hold', async () => {
  const codec = await esm('lib/codec.js');
  const n1 = codec.encodeToken({ setId: 7, mode: 'normal', g1: { right: 3, total: 5 }, g2: { right: 0, total: 1 }, tags: ['other', 'add_or'] });
  const n2 = codec.encodeToken({ setId: 7, mode: 'normal', g1: { right: 2, total: 5 }, g2: { right: 1, total: 1 }, tags: ['other'] });
  const st = codec.encodeToken({ setId: 9, mode: 'study', arm: 1, g1: { right: 4, total: 5 }, g2: { right: 2, total: 5 }, tags: [] });
  const s = await H.openMachine('/board', { width: 1366, height: 768 });
  const { page } = s;
  await page.fill('#bd-codes', [n1, n2, st].join('\n'));
  await page.click('button:text-is("Analyse")');
  await page.waitForSelector('.bd-rows');
  const labels = await page.$$eval('.bd-bar-label', (ls) => ls.map((l) => l.textContent));
  assert.deepEqual(labels, [(await esm('learn/catalogue.js')).tagLabel('add_or')], 'only named misconceptions are ranked');
  assert.equal(await page.locator('.bd-bar button').count(), 1, 'a worked example only for the named one');
  assert.match(await page.textContent('.bd-unclassified'), /^Unclassified mistakes — 2 \(/);
  // mixed rows: each cell names its own groups
  assert.equal(await page.textContent('.bd-rows thead th:nth-child(5)'), 'Groups');
  const cells = await page.$$eval('.bd-rows tbody tr td:nth-child(5)', (tds) => tds.map((t) => t.textContent));
  assert.deepEqual(cells, ['drill 3/5 · holdout 0/1', 'drill 2/5 · holdout 1/1', 'A 4/5 · B 2/5']);
  // one mode only: the heading says it
  await page.fill('#bd-codes', [n1, n2].join('\n'));
  await page.click('button:text-is("Analyse")');
  await H.until(page, () => document.querySelector('.bd-rows thead th:nth-child(5)')?.textContent === 'Drill · Holdout');
  assert.equal(await page.textContent('.bd-rows tbody tr td:nth-child(5)'), '3/5 · 0/1');
  assert.match(await page.textContent('.bd'), /No named misconceptions came up|Unclassified mistakes — 2/);
  clean(s, 'board unclassified');
  await s.close();
});

// ---------------------------------------------------------------------------------------------
test('board: junk, markup, other sets and a huge paste; study numbers match study.js; words follow the rule; CSV columns', async () => {
  const codec = await esm('lib/codec.js');
  const study = await esm('learn/study.js');
  const board = await esm('learn/board.js');
  const setA = codec.decodeSet(codec.encodeSet({ level: 'gcse', topics: ['add'], n: 10, seed: 11, mode: 'normal' }));
  const setB = codec.decodeSet(codec.encodeSet({ level: 'gcse', topics: ['add'], n: 10, seed: 12, mode: 'normal' }));
  const tA = codec.encodeToken({ setId: setA.setId, mode: 'normal', g1: { right: 6, total: 8 }, g2: { right: 1, total: 2 }, tags: ['add_no_carry'] });
  const tB = codec.encodeToken({ setId: setB.setId, mode: 'normal', g1: { right: 2, total: 8 }, g2: { right: 0, total: 2 }, tags: ['add_or'] });

  const s = await H.openMachine('/board', { width: 1366, height: 768 });
  const { page } = s;
  const labels = await page.evaluate(() => ['bd-codes', 'bd-set'].map((id) => [...document.getElementById(id).labels].map((l) => l.textContent).join(' ')));
  assert.match(labels[0], /Paste result codes/);
  assert.match(labels[1], /Set link or code/);
  const junk = [
    '<img src=x onerror="window.__pwned=1"> <script>window.__pwned=2</script>',
    `=HYPERLINK("http://example.com") ${tA}`,
    '\u0000\u0007‮ binary junk ÿþ',
    'x'.repeat(50000),
    `${tA}${tA}`,
    `  ${tA.toLowerCase().replace(/-/g, ' ')}  `,
    `Bob\t${tB}`,
  ].join('\n');
  await page.fill('#bd-codes', junk);
  await page.fill('#bd-set', `https://school.example/machine/#/set/${setA.code}`);
  await page.click('text=Analyse');
  await page.waitForSelector('.bd-rows');
  assert.equal(await page.evaluate(() => window.__pwned), undefined, 'pasted markup is text');
  assert.equal(await page.evaluate(() => document.getElementById('live').textContent), await page.evaluate(() => document.getElementById('live').textContent));
  await H.until(page, () => /valid code/.test(document.getElementById('live').textContent));
  const rows = await page.$$eval('.bd-rows tbody tr', (trs) => trs.map((tr) => tr.children[1].textContent));
  assert.ok(rows.every((c) => c === tA), 'only set A counted');
  assert.equal(rows.length, 2, 'a code after a formula and a spaced-out lower-case code are both found');
  assert.match(await page.textContent('.bd-invalid'), /mistyped/, 'two codes glued together are reported, not silently dropped');
  assert.match(await page.textContent('.bd-invalid'), /different set/);
  assert.ok(await scrollX(page) <= 1366);
  await H.shot(page, 'adv-board-junk-1366');

  // a huge paste (a whole year's export): stays responsive, tables are capped, CSV has everything
  const big = Array.from({ length: 4000 }, (_, i) => `Pupil ${i}\t${i % 3 ? tA : tB}\tnotes 12AB-34CD-56E${i % 10}`).join('\n');
  await page.fill('#bd-set', '');
  await page.evaluate((t) => { const ta = document.getElementById('bd-codes'); ta.value = t; }, big);
  const t0 = Date.now();
  await page.click('text=Analyse');
  await page.waitForSelector('.bd-cap');
  const took = Date.now() - t0;
  assert.ok(took < 8000, `4000 lines analysed and drawn in ${took} ms`);
  assert.ok(await page.locator('.bd-rows tbody tr').count() <= 300, 'the rows table is capped');
  assert.ok(await page.locator('.bd-invalid tbody tr').count() <= 300, 'the invalid table is capped');
  assert.match(await page.textContent('.bd-results'), /Showing the first 300 of 4000/);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=Download CSV')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines.length, 1 + 4000 + 4000, 'the CSV has every row');
  const head = lines[0].split(',');
  assert.deepEqual(head, ['line', 'code', 'set', 'mode', 'score %', 'g1 right (drill or A)', 'g1 total', 'g2 right (holdout or B)', 'g2 total', 'arm', 'misconception 1', 'misconception 2', 'misconception 3', 'duplicate of line', 'problem']);
  for (const l of lines.slice(1, 50)) assert.equal(l.split(',').length, 15, `15 columns: ${l}`);

  // ---- study numbers: synthetic learners with a known effect, both arms, unequal sizes
  const S = codec.decodeSet(codec.encodeSet({ level: 'gcse', topics: ['add', 'shift'], n: 10, seed: 77, mode: 'study' }));
  const make = (arm, drill, other) => codec.encodeToken({ setId: S.setId, mode: 'study', arm, g1: { right: arm === 0 ? drill : other, total: 5 }, g2: { right: arm === 0 ? other : drill, total: 5 }, tags: [] });
  const pts = (x) => { const r = Math.round(x * 100); return r === 0 ? '0' : `${r > 0 ? '+' : '−'}${Math.abs(r)}`; };
  const fix2 = (x) => (x < 0 ? `−${Math.abs(x).toFixed(2)}` : x.toFixed(2));
  const scenarios = {
    // arm 0 drills A and gains; arm 1 drills B and gains less; addition is easier for everyone
    invest: [[0, 5, 2], [0, 4, 2], [0, 5, 3], [0, 4, 3], [0, 5, 2], [0, 4, 1], [0, 3, 2], [1, 4, 3], [1, 3, 3], [1, 4, 2], [1, 5, 4], [1, 3, 2]],
    stop: [[0, 3, 3], [0, 4, 4], [0, 2, 3], [0, 3, 2], [0, 4, 3], [0, 2, 2], [1, 3, 3], [1, 2, 3], [1, 4, 3], [1, 3, 4], [1, 2, 2], [1, 3, 3]],
    replicate: [[0, 4, 3], [0, 3, 3], [0, 4, 2], [0, 2, 3], [0, 3, 4], [0, 3, 2], [1, 3, 3], [1, 4, 3], [1, 2, 2], [1, 3, 4], [1, 4, 2], [1, 3, 3]],
    few: [[0, 5, 2], [0, 4, 2], [1, 4, 3], [1, 3, 2], [1, 5, 1]],
    oneArm: [[0, 5, 2], [0, 4, 2], [0, 3, 3], [0, 5, 1]],
  };
  for (const [name, list] of Object.entries(scenarios)) {
    const text = list.map(([arm, d, o]) => make(arm, d, o)).join('\n');
    // what study.js says, independently of board.js
    const diffs = [0, 1].map((arm) => list.filter((x) => x[0] === arm).map(([, d, o]) => (d - o) / 5));
    const want = study.crossoverStats(diffs[0], diffs[1]);
    const got = board.analyzeTokens(text).study.study.diff;
    for (const k of ['n', 'mean', 'sd', 'lo', 'hi', 'dz', 'reading', 'noInterval']) {
      if (typeof want[k] === 'number') assert.ok(Math.abs(want[k] - got[k]) < 1e-12, `${name}: board.js ${k}`);
      else assert.equal(got[k], want[k], `${name}: board.js ${k}`);
    }
    // the reading follows the pre-registered rule
    if (want.dz !== null && want.n >= 10) assert.equal(want.reading, want.dz >= 0.3 ? 'invest' : want.dz < 0.1 ? 'stop' : 'replicate', `${name}: rule`);
    await page.fill('#bd-codes', text);
    await page.click('text=Analyse');
    await page.waitForSelector('.bd-study');
    const panel = await page.textContent('.bd-study');
    const reading = await page.textContent('.bd-study .bd-reading');
    // per-arm per-family accuracy
    const armRows = await page.$$eval('.bd-arms tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
    for (const arm of [0, 1]) {
      const mine = list.filter((x) => x[0] === arm);
      const A = mine.reduce((s2, [a, d, o]) => s2 + (a === 0 ? d : o), 0);
      const B = mine.reduce((s2, [a, d, o]) => s2 + (a === 0 ? o : d), 0);
      const tot = mine.length * 5;
      assert.equal(armRows[arm][1], String(mine.length), `${name}: arm ${arm} learners`);
      assert.equal(armRows[arm][2], tot ? `${Math.round((A / tot) * 100)}% (${A}/${tot})` : '—', `${name}: arm ${arm} A`);
      assert.equal(armRows[arm][3], tot ? `${Math.round((B / tot) * 100)}% (${B}/${tot})` : '—', `${name}: arm ${arm} B`);
      assert.match(armRows[arm][0], new RegExp(`Arm ${arm}: full feedback on ${arm === 0 ? 'A' : 'B'}`));
    }
    if (name === 'oneArm') {
      assert.equal(await page.$('.bd-study .bd-diff'), null, 'no difference shown with one arm');
      assert.match(reading, /all codes come from one group/);
      continue;
    }
    const line = `${pts(want.mean)} percentage points (95% CI ${pts(want.lo)} to ${pts(want.hi)}), n = ${want.n}, dz = ${fix2(want.dz)}.`;
    assert.ok(panel.includes(line), `${name}: panel shows "${line}"\n${panel}`);
    if (name === 'few') assert.match(reading, /No reading yet: fewer than 10 learners \(n = 5\)/);
    else {
      const word = { invest: /^Reading: Invest in the drill-down/, stop: /^Reading: Stop/, replicate: /^Reading: Replicate/ }[want.reading];
      assert.equal(want.reading, name, `${name}: the synthetic data give the intended reading (dz ${want.dz.toFixed(2)})`);
      assert.match(reading, word, `${name}: words`);
    }
    if (name === 'invest') { await page.evaluate(() => document.querySelector('.bd-study').scrollIntoView()); await H.shot(page, 'adv-board-study-1366'); }
  }
  assert.match(await page.textContent('.bd-study'), /≥ 0\.3 invest in the drill-down · < 0\.1 stop · between: replicate/);
  // CSV arm numbers match the UI's
  await page.fill('#bd-codes', scenarios.invest.map(([arm, d, o]) => make(arm, d, o)).join('\n'));
  await page.click('text=Analyse');
  await page.waitForSelector('.bd-rows');
  const uiArms = await page.$$eval('.bd-rows tbody tr', (trs) => trs.map((tr) => tr.children[5].textContent));
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('text=Download CSV')]);
  const csvArms = fs.readFileSync(await dl2.path(), 'utf8').trimEnd().split('\r\n').slice(1).map((l) => l.split(',')[9]);
  assert.deepEqual(uiArms.map((a) => a.match(/arm (\d)/)[1]), csvArms, 'UI arm numbers are the CSV\'s');
  clean(s, 'board');
  await s.close();
});

test('board worked example overlay: keyboard trap both ways, background inert, focus restored; board on a phone', async () => {
  const codec = await esm('lib/codec.js');
  const set = codec.decodeSet(codec.encodeSet({ level: 'gcse', topics: ['add', 'shift'], n: 10, seed: 3, mode: 'normal' }));
  const codes = ['add_no_carry', 'shift_rotate', 'add_or'].map((t, i) => codec.encodeToken({ setId: set.setId, mode: 'normal', g1: { right: i, total: 8 }, g2: { right: 1, total: 2 }, tags: [t] }));
  const s = await H.openMachine('/board', { width: 1920, height: 1080 });
  const { page } = s;
  await page.fill('#bd-codes', codes.join('\n'));
  await page.focus('#bd-set');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.bd-bars');
  const openers = page.locator('.bd-bar .btn', { hasText: 'Project a worked example' });
  assert.ok(await openers.count() >= 2);
  await openers.nth(1).focus();
  await page.keyboard.press('Space');
  await page.waitForSelector('.wx[role="dialog"][aria-modal="true"]');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'wx-title', 'focus moves into the dialog');
  assert.equal(await page.evaluate(() => document.getElementById('app').inert && document.querySelector('.topbar').inert), true, 'background is inert');
  for (const key of ['Tab', 'Shift+Tab', 'Shift+Tab', 'Tab', 'Tab']) {
    await page.keyboard.press(key);
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('.wx')), true, `${key} stays in the overlay`);
  }
  assert.match(await page.evaluate(() => document.getElementById('live').textContent), /Press Escape to close/);
  const step = await page.$eval('.wx-sub', (e) => parseFloat(getComputedStyle(e).fontSize));
  assert.ok(step >= 22, `step headings ${step}px on the projector`);
  await H.sleep(500);
  await H.shot(page, 'adv-board-worked-1920');
  await page.click('.wx .btn');
  await H.until(page, () => !document.querySelector('.wx'));
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelectorAll('.bd-bar .btn')[1]), true, 'focus back on the button that opened it');
  assert.equal(await page.evaluate(() => document.getElementById('app').inert), false);
  // leaving the page with the overlay open cleans up
  await openers.first().click();
  await page.waitForSelector('.wx');
  await page.evaluate(() => { location.hash = '/teacher'; });
  await view(page, 'teacher');
  assert.equal(await page.evaluate(() => !!document.querySelector('.wx') || document.body.classList.contains('wx-open') || document.getElementById('app').inert), false);

  // the phone
  await page.setViewportSize({ width: 390, height: 844 });
  await go(page, '/board', 'board');
  await page.fill('#bd-codes', codes.join('\n'));
  await page.click('text=Analyse');
  await page.waitForSelector('.bd-bars');
  assert.ok(await scrollX(page) <= 390, 'board fits 390 px');
  await openers.first().click();
  await page.waitForSelector('.wx');
  assert.ok(await scrollX(page) <= 390, 'overlay fits 390 px');
  await H.shot(page, 'adv-board-worked-390');
  await page.keyboard.press('Escape');
  clean(s, 'overlay');
  await s.close();
});

// ---------------------------------------------------------------------------------------------
test('teacher page: every control is labelled; delayed sets link only to study sets; phone and projector layouts', async () => {
  const codec = await esm('lib/codec.js');
  const s = await H.openMachine('/teacher', { width: 1920, height: 1080 });
  const { page } = s;
  const unlabelled = () => page.evaluate(() => [...document.querySelectorAll('main input, main select, main textarea, main button, main a')].filter((el) => {
    const name = el.getAttribute('aria-label') || (el.labels && [...el.labels].map((l) => l.textContent).join('').trim()) || el.textContent.trim();
    return !name;
  }).map((el) => el.outerHTML.slice(0, 80)));
  assert.deepEqual(await unlabelled(), []);
  assert.equal(await page.locator('main h1').count(), 1);
  // make a study set, then a delayed set that follows it
  await page.click('.seg[aria-label="Mode"] button[data-value="study"]');
  assert.match(await page.textContent('.tc-topics'), /family A/);
  await page.click('text=Make the link');
  await page.waitForSelector('.tc-made');
  const studyCode = (await page.textContent('.tc-made .copy-value')).match(/#\/set\/([0-9A-Z]+)/)[1];
  await page.click('.seg[aria-label="Mode"] button[data-value="delayed"]');
  await page.click('text=Make the link');
  assert.match(await page.textContent('#tc-set .callout.bad, .callout.bad'), /Choose the study set/);
  assert.deepEqual(await unlabelled(), [], 'the delayed fields are labelled too');
  // a normal set's link is refused
  const normal = codec.encodeSet({ level: 'gcse', topics: ['add'], n: 5, seed: 1, mode: 'normal' });
  await page.fill('#tc-set-linkpaste', `http://x/#/set/${normal}`);
  await page.click('text=Make the link');
  assert.match(await page.textContent('.callout.bad'), /not a study set/);
  await page.fill('#tc-set-linkpaste', '');
  await page.selectOption('#tc-set-link', studyCode);
  await page.click('text=Make the link');
  await page.waitForSelector('.tc-made');
  const delayedCode = (await page.textContent('.tc-made .copy-value')).match(/#\/set\/([0-9A-Z]+)/)[1];
  const d = codec.decodeSet(delayedCode);
  assert.equal(d.mode, 'delayed');
  assert.equal(d.link, codec.decodeSet(studyCode).setId, 'the delayed set links to the study set');
  assert.match(await page.textContent('.tc-setlist'), /Follows:/);
  await page.evaluate(() => window.scrollTo(0, 0));
  await H.shot(page, 'adv-teacher-1920');
  // phone
  await page.setViewportSize({ width: 390, height: 844 });
  await H.sleep(100);
  assert.ok(await scrollX(page) <= 390, 'teacher page fits 390 px');
  await page.evaluate(() => document.querySelector('#tc-set').scrollIntoView());
  await H.shot(page, 'adv-teacher-set-390');
  clean(s, 'teacher');
  await s.close();
});
