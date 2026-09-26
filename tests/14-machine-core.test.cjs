// Predict the Machine — the core learner loop in the browser:
// predict → verify → diagnose → Why → practise → review.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.cjs');

after(H.teardown);

const ORIGIN_OK = (u) => u.startsWith('http://127.0.0.1:') || u.startsWith('data:') || u.startsWith('blob:');

/** 200 + 65 in 8 bits, typed the way a learner works: result bit, then the carry it makes */
const RIGHT_WORKING = ['1', '0', '0', '0', '0', '0', '1', '0', '0', '0', '0', '0', '0', '1', '0', '1'];
// same, but column 6 (1 + 1) written as 1 with no carry → 1 + 0 + 0 = 1 in column 7
const OR_WORKING = ['1', '0', '0', '0', '0', '0', '1', '0', '0', '0', '0', '0', '1', '0', '1', '0'];

async function setUpAddition(page) {
  await page.fill('input[placeholder="11001000"]', '11001000');
  await page.fill('input[placeholder="01000001"]', '01000001');
  await page.click('button:has-text("Set up my working")');
  await page.waitForSelector('.addgrid');
}

async function typeWorking(page, keys) {
  await page.click('.ag-res input[aria-label="Result bit 0"]');
  for (const k of keys) await page.keyboard.press(k);
}

/** mount one item with the real runner on a blank page (for flows no route reaches deterministically) */
async function mountTestItem(page, type, params, opts = {}) {
  await page.evaluate(async ({ type, params, opts }) => {
    const { mountItem } = await import('./src/ui/runner.js');
    const { makeItem } = await import('./src/learn/items/index.js');
    const { h } = await import('./src/lib/dom.js');
    const main = h('main', { class: 'page page-narrow', 'data-view': 'test' }, h('h1', null, 'Test'));
    document.getElementById('app').replaceChildren(main);
    window.__done = null; window.__final = null; window.__next = null;
    mountItem(main, makeItem(type, params), { ...opts, onDone: (r) => { window.__done = r; }, onFinal: (r) => { window.__final = { tag: r.diagnosis?.tag ?? null, depth: r.depth, checkpoints: r.checkpoints }; }, onNext: (k) => { window.__next = k; } });
  }, { type, params, opts });
}

test('home: loads with no network beyond this origin, a strict CSP and a small payload', async () => {
  const s = await H.openMachine('/', { width: 1366, height: 768 });
  const { page, errors, requests } = s;
  assert.equal(await page.textContent('h1'), 'Predict the Machine');
  assert.ok(await page.isVisible('a:has-text("Start with binary addition")'));
  const csp = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content');
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  // the budget (CONTRACTS.md): any one screen ≤ 560 KB of JS + CSS; the whole app ≤ 650 KB
  const all = new Map();
  for (const r of ['/', '/practice/add?level=gcse', '/check', '/review', '/teacher', '/board', '/cards', '/card/char-200', '/paste', '/practice/sadd?level=csapp']) {
    const p2 = await s.context.newPage();
    await p2.goto(page.url().split('#')[0] + '#' + r);
    await p2.waitForSelector('main[data-view]');
    await H.sleep(200);
    const res = await p2.evaluate(() => performance.getEntriesByType('resource').map((e) => [e.name, e.decodedBodySize || 0]));
    const bytes = res.reduce((n, [, b]) => n + b, 0);
    assert.ok(bytes <= 560 * 1024, `${r}: ${Math.round(bytes / 1024)} KB`);
    res.forEach(([n, b]) => all.set(n, b));
    await p2.close();
  }
  const total = [...all.values()].reduce((n, b) => n + b, 0);
  assert.ok(total <= 650 * 1024, `whole app ${Math.round(total / 1024)} KB`);
  assert.deepEqual(requests.filter((u) => !ORIGIN_OK(u)), [], 'no request leaves the page origin');
  assert.deepEqual(errors, []);
  await s.close();
});

test('check my working: typing follows the working order; a correct grid is marked correct', async () => {
  const s = await H.openMachine('/check', { width: 1366, height: 900 });
  const { page, errors } = s;
  await setUpAddition(page);
  await typeWorking(page, RIGHT_WORKING);
  // the carry out went into the carry row above the extra column; the extra result cell stays empty
  assert.equal(await page.inputValue('input[aria-label="Carry out of bit 7"]'), '1');
  assert.equal(await page.inputValue('input[aria-label="Carry into bit 7"]'), '1');
  assert.equal(await page.inputValue('input[aria-label^="Extra bit 8"]'), '');
  await page.click('.field-choice button:has-text("Yes")');
  // Check without confidence explains itself and does not mark
  await page.click('button:has-text("Check answer")');
  assert.match(await page.textContent('.check-hint'), /how sure you are/);
  assert.equal(await page.$('.bit-cell.locked'), null);
  await page.click('.confidence button:has-text("Certain")');
  // Enter from the grid submits (on a button it presses that button, as usual)
  await page.focus('.ag-res input[aria-label="Result bit 0"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.callout.ok');
  assert.match(await page.textContent('.callout.ok'), /^Correct\./);
  assert.equal(await page.locator('.bit-cell.st-bad').count(), 0);
  assert.ok(await page.locator('.bit-cell.st-ok').count() >= 16, 'every asked cell shows a ✓');
  await H.shot(page, 'ptm-check-correct');
  assert.deepEqual(errors, []);
  await s.close();
});

test('diagnosis names the first break in working order, and GCSE Why stops at the column rule', async () => {
  const s = await H.openMachine('/check', { width: 1366, height: 900 });
  const { page, errors } = s;
  await setUpAddition(page);
  await typeWorking(page, OR_WORKING);
  await page.click('.field-choice button:has-text("No")');
  await page.click('.confidence button:has-text("Fairly sure")');
  await page.click('button:has-text("Check answer")');
  await page.waitForSelector('.callout.bad');
  const text = await page.textContent('.callout.bad');
  assert.match(text, /64s column/, text);
  assert.match(text, /1 \+ 1 as 1 with no carry/, text);
  // wrong cells show the right digit underneath
  assert.ok(await page.locator('.bit-cell.st-bad .bit-under:text("0")').count() >= 1);
  // on a miss the first layer is already open; deeper is one click at a time
  await page.waitForSelector('.why-layer[data-kind="columns"]');
  await page.click('button:has-text("Deeper ↓")');
  await page.waitForSelector('.why-layer[data-kind="column"]');
  assert.match(await page.textContent('.why-end'), /deepest layer for GCSE/);
  assert.equal(await page.locator('.why-layer[data-kind="adder"]').count(), 0, 'no gates at GCSE');
  // the focus column is highlighted in the columns layer and the lost carry is struck through
  assert.ok(await page.locator('.why-columns .c.hl').count() >= 3);
  assert.equal(await page.locator('.why-columns .c.lost').count(), 1);
  await H.shot(page, 'ptm-check-wrong');
  assert.deepEqual(errors, []);
  await s.close();
});

test('A-level Why goes down to the full adder with live wire values', async () => {
  const s = await H.openMachine('/', { width: 1366, height: 1000 });
  const { page, errors } = s;
  await mountTestItem(page, 'add', { w: 8, a: 200, b: 65, ask: 'full', level: 'alevel' }, { level: 'alevel' });
  await typeWorking(page, OR_WORKING);
  await page.click('.field-choice button:has-text("No")');
  await page.click('.confidence button:has-text("Guessing")');
  await page.click('button:has-text("Check answer")');
  await page.waitForSelector('.why-layer');
  for (let i = 0; i < 4; i++) { const d = await page.$('button:has-text("Deeper ↓")'); if (!d) break; await d.click(); }
  await page.waitForSelector('.why-layer[data-kind="adder"] svg.adder-svg');
  const label = await page.getAttribute('svg.adder-svg', 'aria-label');
  assert.match(label, /A = 1, B = 1, carry in = 0/);
  await page.click('button:has-text("Try one like it")');
  const fin = await page.evaluate(() => window.__final);
  assert.equal(fin.tag, 'add_or');
  assert.ok(fin.depth >= 3);
  assert.equal(await page.evaluate(() => window.__next), 'variant');
  assert.deepEqual(errors, []);
  await s.close();
});

test('result-only answers are located with checkpoint questions (≤ 3), then diagnosed', async () => {
  const s = await H.openMachine('/', { width: 1366, height: 1000 });
  const { page, errors } = s;
  await mountTestItem(page, 'add', { w: 8, a: 200, b: 65, ask: 'result', level: 'gcse' });
  // learner answers 11001001: bit 6 is wrong (1+1 as 1), bit 7 follows from it
  await page.click('.ag-res input[aria-label="Result bit 0"]');
  for (const k of ['1', '0', '0', '1', '0', '0', '1', '1']) await page.keyboard.press(k);
  await page.click('.field-choice button:has-text("No")');
  await page.click('.confidence button:has-text("Certain")');
  await page.click('button:has-text("Check answer")');
  await page.waitForSelector('.checkpoint');
  let asked = 0;
  while (await page.$('.checkpoint button:has-text("Answer"):not([disabled])')) {
    asked++;
    const box = page.locator('.checkpoint').last();
    const q = await box.textContent();
    if (/carry into/.test(q)) await box.locator('button:has-text("1")').first().click();
    else { await box.locator('input').first().click(); await page.keyboard.press('0'); await page.keyboard.press('1'); }
    await box.locator('button:has-text("Answer")').click();
    await H.sleep(100);
    if (asked > 3) break;
  }
  assert.ok(asked >= 1 && asked <= 3, `asked ${asked} checkpoints`);
  await page.waitForSelector('.callout.bad');
  assert.match(await page.textContent('.callout.bad'), /64s column/);
  assert.deepEqual(errors, []);
  await s.close();
});

test('practice: a session records misses for spaced review, and the review link restores them elsewhere', async () => {
  const s = await H.openMachine('/practice/add?level=gcse', { width: 1366, height: 900 });
  const { page, errors } = s;
  // an empty grid is refused with a hint (a blank is not a prediction)
  await page.waitForSelector('.item .confidence button:not([disabled])');
  await page.click('.item .confidence button:has-text("Guessing")');
  await page.click('button:has-text("Check answer")');
  assert.match(await page.textContent('.check-hint'), /Fill in every bit/);
  assert.equal(await page.$('.bit-cell.locked'), null);
  // answer three questions with a nonsense result (all ones except bit 0), moving on each time
  let wrong = 0;
  for (let q = 0; q < 3; q++) {
    await page.waitForSelector('.item .confidence button:not([disabled])');
    const cells = page.locator('.ag-res input:not([aria-label^="Extra"])');
    const n = await cells.count();
    for (let k = 0; k < n; k++) await cells.nth(k).fill(k === n - 1 ? '0' : '1');
    const yes = page.locator('.item .field-choice button:has-text("No")');
    if (await yes.count()) await yes.first().click();
    await page.click('.item .confidence button:has-text("Guessing")');
    await page.click('button:has-text("Check answer")');
    await page.waitForSelector('.item-next button');
    if (await page.$('.callout.bad, .neutral-line:has-text("correct answer")')) wrong++;
    await page.click('.item-next button:has-text("Next question")');
  }
  assert.ok(wrong >= 1, 'at least one miss');
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('pm.sched')));
  assert.ok(st.queue.length >= 1, 'misses go into the review queue');
  await page.evaluate(() => { location.hash = '/review'; });
  await page.waitForSelector('main[data-view="review"]');
  const link = await page.textContent('.copy-value');
  assert.match(link, /#\/review\/[0-9A-Z]+$/);
  await s.close();
  // a fresh device with no storage gets the same queue from the link
  const s2 = await H.openMachine(`/review/${link.split('#/review/')[1]}`, { width: 1366, height: 900 });
  assert.match(await s2.page.textContent('.callout'), /Added \d+ questions? from your link/);
  const st2 = await s2.page.evaluate(() => JSON.parse(localStorage.getItem('pm.sched')));
  assert.equal(st2.queue.length, st.queue.length);
  // a damaged link is refused kindly
  await s2.page.evaluate(() => { location.hash = '/review/ZZZZ'; });
  await s2.page.waitForSelector('.callout.bad');
  assert.match(await s2.page.textContent('.callout.bad'), /didn't work/);
  assert.deepEqual([...errors, ...s2.errors], []);
  await s2.close();
});

test('review: due items run as a session and move up the 2/7/21-day ladder', async () => {
  const { pathToFileURL } = require('node:url');
  const path = require('node:path');
  const sched = await import(pathToFileURL(path.join(__dirname, '../machine/src/learn/scheduler.js')).href);
  const add = await import(pathToFileURL(path.join(__dirname, '../machine/src/learn/items/add.js')).href);
  const today = sched.dayNumber(new Date());
  let state = sched.emptyState();
  state = sched.recordAttempt(state, { type: add.TYPE_ID, params: add.encodeParams({ w: 8, a: 200, b: 65, ask: 'full', level: 'gcse' }), correct: false, tag: 'add_or', group: 'drill', today: today - 2 });
  const s = await H.openMachine('/review', { width: 1366, height: 900, init: `localStorage.setItem('pm.sched', ${JSON.stringify(JSON.stringify(state))});` });
  const { page, errors } = s;
  await page.click('button:has-text("Start review (1)")');
  await page.waitForSelector('.addgrid');
  await typeWorking(page, RIGHT_WORKING);
  await page.click('.field-choice button:has-text("Yes")');
  await page.click('.confidence button:has-text("Certain")');
  await page.click('button:has-text("Check answer")');
  await page.waitForSelector('.callout.ok');
  await page.click('.item-next button');
  await page.waitForSelector('.session-end');
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('pm.sched')));
  const e = after.queue[0];
  assert.equal(e.stage, 1, 'a right review moves the item to the 7-day step');
  assert.equal(e.due, today + 7);
  assert.deepEqual(errors, []);
  await s.close();
});

test('route text is never parsed as HTML; unknown routes get a kind page', async () => {
  const s = await H.openMachine('/practice/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E', { width: 1366, height: 768 });
  const { page, errors } = s;
  let dialog = false;
  page.on('dialog', (d) => { dialog = true; d.dismiss(); });
  assert.match(await page.textContent('main'), /There is no topic called “<img src=x onerror=alert\(1\)>”/);
  assert.equal(await page.locator('main img').count(), 0);
  await page.evaluate(() => { location.hash = '/nowhere'; });
  await page.waitForSelector('main[data-view="notfound"]');
  assert.equal(dialog, false);
  assert.deepEqual(errors, []);
  await s.close();
});

test('phones: no horizontal page scroll on the learner screens; the grid fits 8 bits', async () => {
  for (const route of ['/', '/practice/add?level=gcse', '/check', '/review', '/practice/shift?level=alevel', '/practice/twos?level=alevel']) {
    const s = await H.openMachine(route, { width: 390, height: 844, isMobile: true, hasTouch: true });
    const { page, errors } = s;
    await H.sleep(150);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(sw <= 390, `${route}: page is ${sw}px wide`);
    if (route.startsWith('/practice/add')) {
      const fits = await page.evaluate(() => { const g = document.querySelector('.addgrid-wrap'); return g.scrollWidth <= g.clientWidth + 1; });
      assert.ok(fits, 'the 8-bit grid fits a phone without scrolling');
      await H.shot(page, 'ptm-phone-practice');
    }
    assert.deepEqual(errors, [], route);
    await s.close();
  }
});
