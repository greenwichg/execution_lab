// Predict the Machine — teacher surfaces: classes and taught dates, the
// projected starter (reveal ripple, taps, Why, keys), homework / study /
// delayed sets by link (result codes that decode), and the class board.
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
const noScrollX = (page) => page.evaluate(() => document.documentElement.scrollWidth);
const view = (page, name) => page.waitForSelector(`main[data-view="${name}"]`);
const go = async (page, route, name) => {
  await page.evaluate((r) => { location.hash = r; }, route);
  await view(page, name);
};
function clean(s, label) {
  assert.deepEqual(s.errors, [], `${label}: console errors`);
  const foreign = s.requests.filter((u) => !/^http:\/\/127\.0\.0\.1:\d+\//.test(u) && !u.startsWith('data:') && !u.startsWith('blob:'));
  assert.deepEqual(foreign, [], `${label}: requests to another origin`);
}

/** answer every question of an open set via the UI (Guessing, empty answer), with an optional hook after question i */
async function runSet(page, n, afterQuestion) {
  for (let i = 0; i < n; i++) {
    await page.waitForSelector('.item .confidence button');
    assert.match(await page.textContent('.item-progress'), new RegExp(`Question ${i + 1} of ${n}`));
    await page.click('.item .confidence button[data-value="guess"]');
    await page.click('.item-actions .btn.primary');
    // wrong answers with full feedback may ask checkpoints: say "Not sure" until the diagnosis
    for (let k = 0; k < 4; k++) {
      if (await page.$('.item-next .btn')) break;
      const skip = await page.$('.checkpoint button.ghost:not([disabled])');
      if (skip) await skip.click(); else await H.sleep(50);
    }
    await page.click('.item-next .btn.primary');
    if (afterQuestion) await afterQuestion(i);
  }
  await page.waitForSelector('.hs-end .copy-value.big');
  return (await page.textContent('.hs-end .copy-value.big')).trim();
}

test('teacher: class, taught date, starter preview; starter on a projector', async () => {
  const s = await H.openMachine('/teacher', { width: 1366, height: 768 });
  const { page } = s;
  let classes = await store(page, 'classes');
  assert.equal(classes.length, 1);
  assert.equal(classes[0].name, 'My class');
  assert.equal(await page.locator('main[data-view="teacher"] h1').count(), 1);

  // mark binary addition as taught 14 days ago
  const date14 = await page.evaluate(() => {
    const d = new Date(); d.setDate(d.getDate() - 14);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  await page.check('#tc-t-J277124add-on');
  await page.fill('#tc-t-J277124add-date', date14);
  await page.dispatchEvent('#tc-t-J277124add-date', 'change');
  classes = await store(page, 'classes');
  const today = await page.evaluate(() => { const d = new Date(); return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000); });
  assert.equal(classes[0].taught['J277-1.2.4-add'], today - 14);
  await H.until(page, () => document.querySelectorAll('.tc-plan-line').length === 5);
  assert.match(await page.textContent('.tc-plan'), /From 2 weeks ago/);

  // add, rename, delete (with confirmation)
  await page.click('text=Add a class');
  await H.until(page, () => JSON.parse(localStorage.getItem('pm.classes')).length === 2);
  await page.fill('#tc-name', 'Year 10 set 2');
  await page.dispatchEvent('#tc-name', 'change');
  await H.until(page, () => JSON.parse(localStorage.getItem('pm.classes'))[1].name === 'Year 10 set 2');
  await page.click('text=Delete this class');
  await page.waitForSelector('[role="alertdialog"]');
  assert.equal((await store(page, 'classes')).length, 2, 'nothing deleted before confirming');
  await page.click('[role="alertdialog"] >> text=Delete class');
  await H.until(page, () => JSON.parse(localStorage.getItem('pm.classes')).length === 1);
  assert.equal((await store(page, 'classes'))[0].name, 'My class');
  await H.until(page, () => document.querySelectorAll('.tc-plan-line').length === 5);
  await H.shot(page, 'teacher-1366');

  // make a normal set: the link and the instructions appear and the set is remembered
  await page.click('text=Make the link');
  await page.waitForSelector('.tc-made .copy-value');
  const link = await page.textContent('.tc-made .copy-value');
  assert.match(link, /#\/set\/[0-9A-Z]{14}$/);
  assert.equal(await page.locator('.tc-made .tc-steps li').count(), 3);
  const sets = await store(page, 'sets');
  assert.equal(sets.length, 1);
  assert.equal(sets[0].mode, 'normal');
  assert.equal(await page.locator('.tc-setlist a', { hasText: 'Open the board for this set' }).count(), 1);

  // the starter, projected at 1920×1080
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.click('text=Project starter');
  await view(page, 'starter');
  assert.equal(await page.evaluate(() => document.body.classList.contains('projector')), true);
  assert.match(await page.textContent('.sr-count'), /^1 of 5$/);
  // find an addition question (the plan's first slot is the spaced addition)
  for (let k = 0; k < 5 && !(await page.$('.rv-add')); k++) await page.keyboard.press('ArrowRight');
  assert.ok(await page.$('.rv-add'), 'an addition question in the starter');
  assert.equal(await page.locator('.rv-carry.on').count(), 0, 'carries hidden before the reveal');
  await H.shot(page, 'starter-question-1920');
  const minDigit = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.rv-bit')).fontSize));
  assert.ok(minDigit >= 48, `projector digits are ${minDigit}px`);
  await page.keyboard.press('Space');
  await H.until(page, () => document.querySelectorAll('.rv-carry.on').length > 0);
  await H.until(page, () => document.querySelector('.rv-done'));
  assert.match(await page.textContent('.rv-note'), /overflow/i);
  await page.keyboard.press('3');
  await H.until(page, () => JSON.parse(localStorage.getItem('pm.classes'))[0].taps.length === 1);
  const tap = (await store(page, 'classes'))[0].taps[0];
  assert.equal(tap.result, 'missed');
  assert.equal(tap.spec, 'J277-1.2.4-add');
  assert.equal(tap.day, today);
  // changing the tap replaces it
  await page.keyboard.press('2');
  await H.until(page, () => JSON.parse(localStorage.getItem('pm.classes'))[0].taps[0].result === 'split');
  assert.equal((await store(page, 'classes'))[0].taps.length, 1);
  await page.keyboard.press('w');
  await page.waitForSelector('.sr-why .why-layer');
  await H.shot(page, 'starter-revealed-1920');
  const before = await page.textContent('.sr-count');
  await page.keyboard.press('ArrowRight');
  await H.until(page, (b) => document.querySelector('.sr-count').textContent !== b, before);
  await page.keyboard.press('ArrowLeft');
  await H.until(page, (b) => document.querySelector('.sr-count').textContent === b, before);
  assert.ok(await page.$('.rv-done'), 'a revealed question stays revealed');

  // a non-addition reveal shows the key answer
  for (let k = 0; k < 5; k++) {
    await page.keyboard.press('ArrowRight');
    if (!(await page.$('.rv-add')) && await page.$('.sr-q')) break;
  }
  if (await page.$('.sr-q') && !(await page.$('.rv-add'))) {
    await page.keyboard.press('Enter');
    await page.waitForSelector('.rv-key dd');
    await H.shot(page, 'starter-key-1920');
  }
  // the end screen
  for (let k = 0; k < 6 && !(await page.$('.sr-end')); k++) await page.keyboard.press('ArrowRight');
  await page.waitForSelector('.sr-end');
  assert.match(await page.textContent('.sr-nexttime'), /Next time these come back: Binary addition and overflow/);
  await H.shot(page, 'starter-end-1920');

  await page.keyboard.press('Escape');
  await view(page, 'teacher');
  assert.equal(await page.evaluate(() => document.body.classList.contains('projector')), false);

  // 1366×768 projector: the whole question and its buttons fit on the screen
  await page.setViewportSize({ width: 1366, height: 768 });
  await go(page, `/starter?class=${classes[0].id}`, 'starter');
  await page.keyboard.press('Space');
  await H.until(page, () => document.querySelector('.rv-done') || document.querySelector('.rv-key'));
  await H.shot(page, 'starter-revealed-1366');
  const bottom = await page.evaluate(() => document.querySelector('.sr-next').getBoundingClientRect().bottom);
  assert.ok(bottom <= 768, `Next is on screen at 1366×768 (bottom ${bottom})`);
  clean(s, 'teacher + starter');
  await s.close();
});

test('teacher and starter on a phone: no horizontal scroll', async () => {
  const s = await H.openMachine('/teacher', PHONE);
  const { page } = s;
  await page.waitForSelector('.tc-plan');
  assert.ok(await noScrollX(page) <= 390, 'teacher fits 390 px');
  await H.shot(page, 'teacher-390');
  const id = (await store(page, 'classes'))[0].id;
  await go(page, `/starter?class=${id}`, 'starter');
  await page.keyboard.press('Space');
  await H.sleep(300);
  assert.ok(await noScrollX(page) <= 390, 'starter fits 390 px');
  await H.shot(page, 'starter-390');
  clean(s, 'phone');
  await s.close();
});

test('a normal set: kind error for a bad link, resume after reload, a result code that decodes', async () => {
  const codec = await esm('lib/codec.js');
  const code = codec.encodeSet({ level: 'gcse', topics: ['add', 'shift'], n: 5, seed: 12345, mode: 'normal' });
  const set = codec.decodeSet(code);
  const s = await H.openMachine(`/set/${code.slice(0, 9)}`, PHONE);
  const { page } = s;
  assert.match(await page.textContent('main[data-view="set"]'), /This link looks incomplete\. Ask your teacher to send it again\./);
  await go(page, `/set/${code}`, 'set');
  assert.match(await page.textContent('main'), /When you finish you'll get a result code to paste into your assignment\. Your answers stay on this device\./);
  assert.ok(await noScrollX(page) <= 390);
  await H.shot(page, 'set-intro-390');
  await page.click('text=Start');
  let reloaded = false;
  const token = await runSet(page, 5, async (i) => {
    if (i === 1 && !reloaded) {
      reloaded = true;
      await page.reload();
      await view(page, 'set');
      await page.click('text=Carry on from question 3');
    }
  });
  const prog = await store(page, `setprog.${set.setId}`);
  assert.equal(prog.results.filter(Boolean).length, 5);
  const t = codec.decodeToken(token);
  assert.equal(t.error, undefined, `token decodes: ${token}`);
  assert.equal(t.setId, set.setId);
  assert.equal(t.mode, 'normal');
  assert.equal(t.total, 5);
  assert.match(await page.textContent('.hs-end'), /Paste this code into your assignment\./);
  assert.ok(await noScrollX(page) <= 390);
  await H.shot(page, 'set-end-390');
  // misses feed the review queue
  const sched = await store(page, 'sched');
  assert.ok(sched && sched.queue.length > 0, 'misses go into the review queue');
  clean(s, 'normal set');
  await s.close();
});

test('study set assigns and stores the arm; delayed set recovers it from a pasted code', async () => {
  const codec = await esm('lib/codec.js');
  const studyCode = codec.encodeSet({ level: 'gcse', topics: ['add', 'shift'], n: 5, seed: 777, mode: 'study' });
  const study = codec.decodeSet(studyCode);
  let s = await H.openMachine(`/set/${studyCode}`, { width: 1366, height: 768 });
  let page = s.page;
  const arm = await store(page, `arm.${study.setId}`);
  assert.ok(arm === 0 || arm === 1, `arm stored: ${arm}`);
  assert.doesNotMatch(await page.textContent('main'), /arm|group/i, 'the arm is never shown');
  await page.click('text=Start');
  const token = await runSet(page, 5);
  const t = codec.decodeToken(token);
  assert.equal(t.error, undefined);
  assert.equal(t.mode, 'study');
  assert.equal(t.setId, study.setId);
  assert.equal(t.arm, arm, 'token carries the stored arm');
  await H.shot(page, 'set-end-1366');
  clean(s, 'study set');
  await s.close();

  // a fresh device: the delayed set has no stored arm, so the learner pastes last week's code
  const delayedCode = codec.encodeSet({ level: 'gcse', topics: ['add', 'shift'], n: 5, seed: 778, mode: 'delayed', link: study.setId });
  const delayed = codec.decodeSet(delayedCode);
  s = await H.openMachine(`/set/${delayedCode}`, { width: 1920, height: 1080 });
  page = s.page;
  await page.waitForSelector('#hs-recover');
  await page.fill('#hs-recover', 'NOT-A-CODE');
  await page.click('text=Use this code');
  await page.waitForSelector('.hs-recover .callout.bad');
  await page.fill('#hs-recover', token.toLowerCase());
  await page.click('text=Use this code');
  await page.waitForSelector('.hs-recover .callout.ok');
  assert.equal(await store(page, `arm.${study.setId}`), arm);
  await H.shot(page, 'set-recover-1920');
  await page.click('text=Start');
  const t2 = codec.decodeToken(await runSet(page, 5));
  assert.equal(t2.error, undefined);
  assert.equal(t2.mode, 'delayed');
  assert.equal(t2.setId, delayed.setId);
  assert.equal(t2.arm, arm, 'delayed token carries the recovered arm');
  clean(s, 'delayed set');
  await s.close();
});

test('board: pasted codes, junk and duplicates, misconceptions, worked example overlay, study panel, CSV', async () => {
  const codec = await esm('lib/codec.js');
  const setCode = codec.encodeSet({ level: 'gcse', topics: ['add'], n: 10, seed: 99, mode: 'normal' });
  const setId = codec.decodeSet(setCode).setId;
  const tok = (right, tags) => codec.encodeToken({ setId, mode: 'normal', g1: { right, total: 8 }, g2: { right: 1, total: 2 }, tags });
  const a = tok(5, ['add_no_carry', 'add_overflow_missed']);
  const b = tok(7, ['add_no_carry']);
  const c = tok(3, ['add_no_carry', 'add_three_ones', 'add_or']);
  // study codes: 12 learners, both arms
  const studySet = codec.decodeSet(codec.encodeSet({ level: 'gcse', topics: ['add', 'shift'], n: 10, seed: 5, mode: 'study' }));
  const study = [];
  for (let i = 0; i < 12; i++) {
    const arm = i % 2;
    const drill = 3 + (i % 3);
    const other = 2 + (i % 2);
    study.push(codec.encodeToken({ setId: studySet.setId, mode: 'study', arm, g1: { right: arm === 0 ? drill : other, total: 5 }, g2: { right: arm === 0 ? other : drill, total: 5 }, tags: [] }));
  }
  const text = [
    'Name\tResult code',
    `Aisha\t${a}`,
    `Ben\t${b}`,
    `Cara\t${c}`,
    `Dan\t${b}`,
    'hello world',
    `Eve\t${a.slice(0, -1)}X`,
    '12AB-34CD-56EF',
  ].join('\n');

  const s = await H.openMachine(`/board?set=${setCode}`, { width: 1366, height: 768 });
  const { page } = s;
  assert.equal(await page.inputValue('#bd-set'), setCode);
  assert.match(await page.textContent('main'), /Everything here stays on this device\./);
  await page.fill('#bd-codes', text);
  await page.click('text=Analyse');
  await page.waitForSelector('.bd-bars');
  const tiles = await page.$$eval('.bd-tiles .tile', (els) => els.map((e) => [e.querySelector('.tile-label').textContent, e.querySelector('.tile-value').textContent]));
  const T = Object.fromEntries(tiles);
  assert.equal(T.valid, '4');
  assert.equal(T.duplicates, '1');
  assert.ok(Number(T['codes found']) >= 6, 'junk that looks like a code is reported');
  const bars = await page.$$eval('.bd-bar', (els) => els.map((e) => [e.querySelector('.bd-bar-label').textContent, e.querySelector('.bd-bar-count').textContent]));
  assert.ok(bars[0][0].length > 3, 'first bar has a label');
  assert.equal(bars[0][1], '4 of 4', 'the most common misconception first');
  assert.ok(bars.length >= 4);
  assert.ok(await page.locator('.bd-invalid tbody tr').count() >= 2, 'invalid lines listed with reasons');
  assert.match(await page.textContent('.bd-rows'), /Same as line 3/);
  await H.shot(page, 'board-1366');

  // the worked example overlay: keyboard open, focus trapped, Escape closes and restores focus
  const opener = page.locator('.bd-bar .btn', { hasText: 'Project a worked example' }).first();
  await opener.focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('.wx[role="dialog"]');
  assert.equal(await page.evaluate(() => document.body.classList.contains('projector')), true);
  for (let k = 0; k < 4; k++) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('.wx')), true, 'focus stays in the overlay');
  }
  assert.ok(await page.locator('.wx-step').count() >= 3, 'numbered subgoals');
  await page.setViewportSize({ width: 1920, height: 1080 });
  await H.shot(page, 'board-worked-1920');
  await page.keyboard.press('Escape');
  await H.until(page, () => !document.querySelector('.wx'));
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Project a worked example');
  assert.equal(await page.evaluate(() => document.body.classList.contains('projector')), false);

  // study codes: the panel, the crossover difference and the reading
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.fill('#bd-set', '');
  await page.fill('#bd-codes', study.join('\n'));
  await page.click('text=Analyse');
  await page.waitForSelector('.bd-study');
  const studyText = await page.textContent('.bd-study');
  assert.match(studyText, /95% CI/);
  assert.match(studyText, /n = 12/);
  assert.match(studyText, /Reading: (Invest|Stop|Replicate)/);
  assert.match(studyText, /≥ 0\.3 invest in the drill-down · < 0\.1 stop · between: replicate/);
  await page.evaluate(() => document.querySelector('.bd-study').scrollIntoView());
  await H.shot(page, 'board-study-1366');

  // CSV
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=Download CSV')]);
  assert.equal(dl.suggestedFilename(), 'board.csv');
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  assert.match(csv.split('\r\n')[0], /^line,code,set,mode/);
  assert.equal(csv.trim().split('\r\n').length, 13);

  // phone
  await page.setViewportSize({ width: 390, height: 844 });
  await page.fill('#bd-codes', text);
  await page.click('text=Analyse');
  await page.waitForSelector('.bd-bars');
  assert.ok(await noScrollX(page) <= 390, 'board fits 390 px');
  await H.shot(page, 'board-390');
  clean(s, 'board');
  await s.close();
});
