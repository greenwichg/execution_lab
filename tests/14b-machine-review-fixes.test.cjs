// Regression tests for findings from the final four-lens review of the core
// learner experience (each test names the finding it guards).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const H = require('./harness.cjs');

after(H.teardown);

const mod = (p) => import(pathToFileURL(path.join(__dirname, '../machine/src', p)).href);

async function mountTestItem(page, type, params, opts = {}) {
  await page.evaluate(async ({ type, params, opts }) => {
    const { mountItem } = await import('./src/ui/runner.js');
    const { makeItem } = await import('./src/learn/items/index.js');
    const { h } = await import('./src/lib/dom.js');
    const main = h('main', { class: 'page page-narrow', 'data-view': 'test' }, h('h1', null, 'Test'));
    document.getElementById('app').replaceChildren(main);
    mountItem(main, makeItem(type, params), { ...opts });
  }, { type, params, opts });
}

/** a scheduler state with `n` misses already due today */
async function dueState(n) {
  const sched = await mod('learn/scheduler.js');
  const add = await mod('learn/items/add.js');
  const today = sched.dayNumber(new Date());
  let state = sched.emptyState();
  const pairs = [[210, 22], [178, 31], [222, 24], [150, 61], [99, 99], [120, 7]];
  for (let k = 0; k < n; k++) {
    state = sched.recordAttempt(state, { type: add.TYPE_ID, params: add.encodeParams({ w: 8, a: pairs[k][0], b: pairs[k][1], ask: 'full', level: 'gcse' }), correct: false, tag: 'add_no_carry', group: 'drill', today: today - 2 });
  }
  return `localStorage.setItem('pm.sched', ${JSON.stringify(JSON.stringify(state))});`;
}

test('bugs #1: a signed sum shows its two\'s complement value, not the unsigned one', async () => {
  const s = await H.openMachine('/', { width: 1366, height: 900 });
  const { page, errors } = s;
  await mountTestItem(page, 'sadd', { w: 8, a: -20, b: -30, op: '+', askFlags: ['OF'], level: 'alevel' }, { level: 'alevel' });
  const bits = ((-50) & 255).toString(2).padStart(8, '0').split('').reverse();       // LSB first
  await page.click('.ag-res input[aria-label="Result bit 0"]');
  for (const b of bits) await page.keyboard.press(b);
  const no = page.locator('.field-flags button:has-text("0"), .field-choice button:has-text("No")');
  await no.first().click();
  await page.click('.confidence button:has-text("Certain")');
  await page.click('button:has-text("Check answer")');
  await page.waitForSelector('.callout');
  const labels = await page.$$eval('.ag-value', (xs) => xs.map((x) => x.textContent));
  assert.ok(labels.includes('−50'), `labels ${labels}`);
  assert.ok(!labels.includes('206'));
  assert.deepEqual(errors, []);
  await s.close();
});

test('bugs #2: a miss reaches the review queue even if the page reloads before "Next"', async () => {
  const s = await H.openMachine('/practice/add?level=gcse', { width: 1366, height: 900 });
  const { page, errors } = s;
  await page.waitForSelector('.addgrid');
  // a result that is wrong for any sum with a carry: all ones
  const cells = page.locator('.ag-res input:not([aria-label^="Extra"])');
  for (let k = 0; k < await cells.count(); k++) await cells.nth(k).fill('1');
  await page.locator('.field-choice button:has-text("Yes")').first().click();
  await page.click('.confidence button:has-text("Guessing")');
  await page.click('button:has-text("Check answer")');
  await page.waitForSelector('.item-next button');
  const wasWrong = !!(await page.$('.callout.bad, .neutral-line:has-text("correct answer")'));
  await page.reload();
  await page.waitForSelector('main[data-view="practice"]');
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('pm.sched')));
  if (wasWrong) assert.ok(st.queue.length >= 1, 'the miss survived the reload');
  assert.deepEqual(errors, []);
  await s.close();
});

test('bugs #4/#5/#8: a review asks every due item even after "Try one like it"; "Back to review" works; no stray "null"', async () => {
  const s = await H.openMachine('/review', { width: 1366, height: 900, init: await dueState(3) });
  const { page, errors } = s;
  assert.doesNotMatch(await page.textContent('main'), /null/);
  await page.click('button:has-text("Start review (3)")');
  const asked = [];
  for (let q = 0; q < 6; q++) {
    const grid = await page.waitForSelector('.addgrid, .session-end');
    if (await page.$('.session-end')) break;
    void grid;
    const ops = await page.$$eval('.ag-digit', (ds) => ds.map((d) => d.textContent).join(''));
    asked.push(ops);
    const cells = page.locator('.ag-res input:not([aria-label^="Extra"])');
    for (let k = 0; k < await cells.count(); k++) await cells.nth(k).fill('1');
    await page.locator('.field-choice button:has-text("No")').first().click();
    await page.click('.confidence button:has-text("Guessing")');
    await page.click('button:has-text("Check answer")');
    await page.waitForSelector('.item-next button');
    const like = await page.$('button:has-text("Try one like it")');
    if (q === 0 && like) await like.click(); else await page.click('.item-next button:has-text("Next question")');
  }
  await page.waitForSelector('.session-end');
  const due = new Set(['1101001000010110', '1011001000011111', '1101111000011000']);    // 210+22, 178+31, 222+24
  for (const d of due) assert.ok(asked.includes(d), `due item ${d} was asked (${asked.length} asked)`);
  await page.click('button:has-text("Back to review")');
  await page.waitForSelector('main[data-view="review"] .tile');
  assert.equal(await page.$('.session-end'), null, 'back on the overview');
  assert.doesNotMatch(await page.textContent('main'), /null/);
  assert.deepEqual(errors, []);
  await s.close();
});

test('security #1: a big review link asks first and never crowds out the learner\'s own reviews', async () => {
  const sched = await mod('learn/scheduler.js');
  const codec = await mod('lib/codec.js');
  const add = await mod('learn/items/add.js');
  const today = sched.dayNumber(new Date());
  let other = sched.emptyState();
  for (let k = 0; k < 60; k++) other = sched.recordAttempt(other, { type: add.TYPE_ID, params: add.encodeParams({ w: 8, a: 100 + k, b: 60, ask: 'full', level: 'gcse' }), correct: false, tag: 'add_no_carry', group: 'drill', today });
  const q = codec.encodeQueue(sched.activeEntries(other));
  const s = await H.openMachine(`/review/${q}`, { width: 1366, height: 900, init: await dueState(5) });
  const { page, errors } = s;
  await page.waitForSelector('button:has-text("Add 60 questions")');
  let st = await page.evaluate(() => JSON.parse(localStorage.getItem('pm.sched')));
  assert.equal(st.queue.length, 5, 'nothing imported before the learner agrees');
  await page.click('button:has-text("Add 60 questions")');
  await page.waitForSelector('.callout');
  st = await page.evaluate(() => JSON.parse(localStorage.getItem('pm.sched')));
  const own = st.queue.filter((e) => e.params[2] !== 60);
  assert.equal(own.length, 5, 'the learner\'s own 5 reviews are all still there');
  assert.deepEqual(errors, []);
  await s.close();
});

test('a11y #1/#11: the skip link focuses the heading without changing the page; each view has its own title', async () => {
  const s = await H.openMachine('/practice/add?level=gcse', { width: 1366, height: 900 });
  const { page, errors } = s;
  await page.waitForSelector('.addgrid');
  assert.match(await page.title(), /^Practise: Binary addition · Predict the Machine$/);
  await page.focus('a.skip');
  await page.keyboard.press('Enter');
  await H.sleep(150);
  assert.equal(await page.$('main[data-view="notfound"]'), null);
  assert.ok(await page.$('main[data-view="practice"] .addgrid'), 'the question is still there');
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'H1');
  await page.evaluate(() => { location.hash = '/review'; });
  await page.waitForSelector('main[data-view="review"]');
  assert.match(await page.title(), /^Review · Predict the Machine$/);
  assert.deepEqual(errors, []);
  await s.close();
});

test('a11y #6: the addition grid is one tab stop, entered at result bit 0', async () => {
  const s = await H.openMachine('/check', { width: 1366, height: 900 });
  const { page, errors } = s;
  await page.fill('input[placeholder="11001000"]', '11001000');
  await page.fill('input[placeholder="01000001"]', '01000001');
  await page.click('button:has-text("Set up my working")');
  await page.waitForSelector('.addgrid');
  const tabbable = await page.$$eval('.addgrid input.bit-in', (xs) => xs.filter((x) => x.tabIndex === 0).map((x) => x.getAttribute('aria-label')));
  assert.deepEqual(tabbable, ['Result bit 0']);
  assert.deepEqual(errors, []);
  await s.close();
});

test('security #3: generated links keep only ?t=, never other query parameters', async () => {
  const s = await H.openMachine('/review', { width: 1366, height: 900, query: 't=mrsk&student=aisha.khan%40school.org', init: await dueState(1) });
  const { page, errors } = s;
  const link = await page.textContent('.copy-value');
  assert.match(link, /\?t=mrsk#\/review\//);
  assert.doesNotMatch(link, /student/);
  const hrefs = await page.$$eval('main a[href*="#/"]', (as) => as.map((a) => a.getAttribute('href')));
  for (const hr of hrefs) assert.doesNotMatch(hr, /student/);
  assert.deepEqual(errors, []);
  await s.close();
});

test('security #5: "Forget everything on this device" removes every pm.* key', async () => {
  const s = await H.openMachine('/review', { width: 1366, height: 900, init: await dueState(2) });
  const { page, errors } = s;
  await page.evaluate(() => { localStorage.setItem('pm.paste.code', '"int x = 1;"'); localStorage.setItem('other.app', '1'); });
  await page.click('button:has-text("Forget everything on this device")');
  await page.click('button:has-text("Yes, forget it all")');
  await page.waitForSelector('text=has been forgotten');
  const keys = await page.evaluate(() => Object.keys(localStorage));
  assert.deepEqual(keys.filter((k) => k.startsWith('pm.')), []);
  assert.ok(keys.includes('other.app'), 'other sites\' data is left alone');
  assert.deepEqual(errors, []);
  await s.close();
});
