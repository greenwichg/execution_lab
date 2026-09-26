// Predict the Machine — C on x86-64: the card list, every card answered right,
// classic wrong answers diagnosed, the Why rail to the deepest layer, variants,
// and "Paste your own C" (checkpoints, diagnosis, errors, share links, safety).
const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const H = require('./harness.cjs');

after(H.teardown);

const M = (p) => pathToFileURL(path.join(__dirname, '../machine/src', p)).href;
let CARDS, makeItem, analyzePaste, diagnosePaste;
before(async () => {
  ({ CARDS } = await import(M('learn/cards.js')));
  ({ makeItem } = await import(M('learn/items/index.js')));
  ({ analyzePaste, diagnosePaste } = await import(M('learn/paste.js')));
});

const SHORT = 'int a = 5;\nint b = a * 3;\nunsigned u = 2;\nu = u - b;\nprintf("%u\\n", u);';
const foreign = (reqs) => reqs.filter((u) => !/^(https?:\/\/127\.0\.0\.1[:/]|data:|blob:|about:)/.test(u));
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth);

/** go to a hash route in the same page and wait for its view */
async function go(page, route, view, h1) {
  await page.evaluate((r) => { location.hash = r; }, route);
  await H.until(page, ([v, t]) => {
    const m = document.querySelector(`main[data-view="${v}"]`);
    return !!m && (!t || m.querySelector('h1')?.textContent === t);
  }, [view, h1]);
}

/** fill in a card's single answer field */
async function answerCard(page, item, answer) {
  const kind = item.card.ask.kind;
  if (kind === 'output') await page.fill('.item-answer textarea', answer);
  else if (kind === 'value') await page.fill('.item-answer input.num-in', String(answer));
  else if (kind === 'branch') await page.click(`.item-answer .seg button:text-is("${answer}")`);
  else if (kind === 'flags') {
    for (const [n, v] of Object.entries(answer)) {
      await page.click(`.item-answer .flag-row:has(abbr:text-is("${n}")) .seg button:text-is("${v}")`);
    }
  }
  await page.click('.confidence .seg button:text-is("Certain")');
  await page.click('button:text-is("Check answer")');
}
const keyOf = (item) => { const k = item.key; return k.output ?? k.value ?? k.branch ?? k.flags; };

/** open the Why rail layer by layer to the end; returns the layer kinds */
async function openWhyFully(page, scope = 'main') {
  await page.click(`${scope} .why-foot button`);
  for (let i = 0; i < 12; i++) {
    const more = page.locator(`${scope} .why-foot button`);
    if (!(await more.count())) break;
    await more.click();
  }
  await page.waitForSelector(`${scope} .why-end`);
  return page.$$eval(`${scope} .why-layer`, (ls) => ls.map((l) => l.dataset.kind));
}

test('cards: list, every card right, classic mistakes, Why to the deepest layer, variants', async () => {
  const s = await H.openMachine('/cards', { width: 1366, height: 768 });
  const { page, errors, requests } = s;

  // the list: 12 cards in 4 sections; a card's C-standard status stays hidden until it has been
  // tried (showing "undefined" first would give the answer away)
  const list = await page.$$eval('.card-group', (gs) => gs.map((g) => ({ h: g.querySelector('h2').textContent, n: g.querySelectorAll('a.card-tile').length })));
  assert.deepEqual(list.map((g) => g.h.split(' ')[0]), ['2.2', '2.3', '3.5', '3.6']);
  assert.equal(list.reduce((a, g) => a + g.n, 0), 12);
  assert.equal(await page.locator('a.card-tile .std-chip').count(), 0, 'no status before trying');
  assert.equal(await page.locator('a.card-tile:has-text("shown after you try it")').count(), 12);
  assert.equal(await page.locator('a[href$="#/paste"]').count() >= 1, true, 'links to paste');
  assert.match(await page.textContent('.honest'), /gcc -O0 on x86-64/);
  await H.shot(page, 'cards-list-1366');

  // every card, answered with the computed key
  for (const [i, c] of CARDS.entries()) {
    const item = makeItem('card', { id: c.id, v: 0 });
    await go(page, `/card/${c.id}`, 'card', c.title);
    assert.equal(await page.textContent('.card-count'), `Card ${i + 1} of 12`);
    assert.equal(await page.locator('.item-before .c-src .cl.focus').count(), 1, `${c.id}: focus line`);
    await answerCard(page, item, keyOf(item));
    await page.waitForSelector('.callout.ok');
    assert.equal(await page.textContent('.callout.ok .callout-head'), 'Correct.', c.id);
    assert.match(await page.textContent('.card-reveal'), /Same output as gcc -O0 on x86-64/);
    const std = await page.textContent('.std-line');
    assert.ok(std.startsWith('C standard:') && std.includes(item.card.std.status), `${c.id}: ${std}`);
    assert.ok((await page.textContent('.gcc-line')).startsWith('gcc -O0 on x86-64:'), c.id);
    if (i === 8) await H.shot(page, 'card-correct-1366');
  }
  // once every card has been tried, the list shows each status in words
  await go(page, '/cards', 'cards', 'C on x86-64: twelve cards');
  const stds = await page.$$eval('a.card-tile .std-chip', (cs) => cs.map((c) => c.textContent.replace(/^\W+/, '')));
  assert.equal(stds.length, 12);
  for (const t of stds) assert.match(t, /^C standard: (defined|implementation-defined|undefined)$/);
  assert.ok(stds.some((t) => t.endsWith(' undefined')) && stds.some((t) => t.endsWith('implementation-defined')));

  // classic wrong answers name the misconception
  const classic = [
    { id: 'char-200', answer: '200', head: /treated char as able to hold 200/ },
    { id: 'uchar-promotion', answer: 44, head: /added in 8 bits/ },
    { id: 'minus-one-vs-unsigned', answer: '1', head: /compared them as signed numbers/ },
  ];
  for (const k of classic) {
    const item = makeItem('card', { id: k.id, v: 0 });
    await go(page, `/card/${k.id}`, 'card', item.card.title);
    await answerCard(page, item, k.answer);
    await page.waitForSelector('.callout.bad');
    assert.match(await page.textContent('.callout.bad .callout-head'), k.head);
    assert.equal(await page.locator('.std-line').count(), 1);
    const kinds = await openWhyFully(page);
    assert.equal(kinds[0], 'line');
    assert.ok(kinds.includes('asm') && kinds.includes('regs'), kinds.join());
    const bytes = await page.$$eval('.why-asm td.bytes', (tds) => tds.map((t) => t.textContent));
    assert.ok(bytes.length > 0 && bytes.every((b) => /^[0-9a-f]{2}( [0-9a-f]{2})*$/.test(b)), bytes.join('|'));
    if (kinds.includes('flags')) assert.equal(await page.locator('.why-flags .flag-tile').count() >= 2, true);
    if (k.id === 'minus-one-vs-unsigned') {
      assert.deepEqual(kinds, ['line', 'asm', 'regs', 'flags', 'columns', 'adder']);
      await H.shot(page, 'card-why-1366');
    }
  }

  // "Try one like it" gives a new variant of the same card, and the miss is queued for review
  const before = await page.evaluate(() => location.hash);
  await page.click('button:text-is("Try one like it")');
  await H.until(page, (b) => location.hash !== b && /^#\/card\/minus-one-vs-unsigned\?v=\d+$/.test(location.hash) && !!document.querySelector('main[data-view="card"] .item-before'), before);
  assert.match(await page.textContent('main .chip:not(.accent)'), /^Variant \d+$/);
  const sched = await page.evaluate(() => JSON.parse(localStorage.getItem('pm.sched')));
  assert.ok(sched.queue.some((e) => e.type === 5), 'a missed card is in the review queue');

  // the flags card shows four flag toggles; next from the last card returns to the list
  await go(page, '/card/flags-after-cmp', 'card', 'The flags after cmp');
  assert.equal(await page.locator('.item-answer .flag-row').count(), 4);
  const item = makeItem('card', { id: 'flags-after-cmp', v: 0 });
  await answerCard(page, item, keyOf(item));
  await page.click('button:text-is("Next card")');
  await H.until(page, () => location.hash === '#/cards' && !!document.querySelector('main[data-view="cards"]'));

  // a bad id is a kind error page
  await go(page, '/card/nope', 'card', 'Card not found');

  // projector-sized screen
  await page.setViewportSize({ width: 1920, height: 1080 });
  await go(page, '/card/int-max-plus-one', 'card', 'INT_MAX + 1');
  const im = makeItem('card', { id: 'int-max-plus-one', v: 0 });
  await answerCard(page, im, '2147483648');
  await page.waitForSelector('.callout.bad');
  await H.shot(page, 'card-wrong-1920');

  assert.deepEqual(errors, []);
  assert.deepEqual(foreign(requests), []);
  await s.close();
});

test('paste: wrong prediction → checkpoints → diagnosis → Why; errors; share links; safety', async () => {
  const s = await H.openMachine('/paste', { width: 1366, height: 768 });
  const { page, errors, requests } = s;
  let dialogs = 0;
  page.on('dialog', (d) => { dialogs++; d.dismiss().catch(() => {}); });

  // Tab inserts two spaces
  await page.fill('#pe-code', '');
  await page.focus('#pe-code');
  await page.keyboard.type('int x = 1;');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('x = x + 1;');
  assert.equal(await page.inputValue('#pe-code'), 'int x = 1;\n  x = x + 1;');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'pe-code');
  assert.equal(await page.locator('.pe-gutter .pe-ln').count(), 2);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('pm.paste.code'))), 'int x = 1;\n  x = x + 1;', 'saved under paste.code');

  // an example, predicted wrongly: the learner thinks u goes negative
  await page.selectOption('#pe-examples', '0');
  assert.equal(await page.inputValue('#pe-code'), SHORT);
  await page.fill('#pe-predict', '-13');
  await page.click('#pe-run');
  assert.match(await page.textContent('.check-hint'), /how sure/, 'confidence is required');
  await page.click('.confidence .seg button:text-is("Certain")');
  await page.click('#pe-run');
  await page.waitForSelector('.compare');
  assert.equal(await page.locator('.compare .out-line.first-diff').count(), 2, 'first differing line marked in both columns');
  assert.equal(await page.textContent('.compare .out-block:nth-child(2) .out-text'), '4294967283');
  // the checkpoints the logic will ask (computed here), answered as that learner would
  const a = analyzePaste(SHORT);
  const plan = [];
  for (const cps = []; ;) {
    const r = diagnosePaste(a, '-13', cps);
    if (!r.next) { plan.diagnosis = r.diagnosis; break; }
    const reply = a.events[r.next.event].k < 3 ? String(r.next.answer) : '-13';
    plan.push({ prompt: r.next.prompt, reply, right: reply === String(r.next.answer) });
    cps.push(reply);
  }
  assert.ok(plan.length >= 1 && plan.length <= 3);
  for (const [q, p] of plan.entries()) {
    const box = page.locator('.checkpoint').nth(q);
    await box.waitFor();
    assert.equal(await box.locator('.checkpoint-q').textContent(), p.prompt);
    await box.locator('input').fill(p.reply);
    await box.locator('button:text-is("Answer")').click();
    await box.locator('.cp-result').waitFor();
    assert.match(await box.locator('.cp-result').textContent(), p.right ? /^✓.*Right\.$/ : /^✗.*Not quite — it's/);
  }
  await page.waitForSelector('.paste-result .diagnosis');
  assert.equal(await page.textContent('.paste-result .diagnosis .callout-head'), plan.diagnosis.headline);
  assert.match(await page.textContent('.paste-result .diagnosis'), /Common mistake: Expected unsigned to go below 0/);
  const kinds = await openWhyFully(page, '.paste-result');
  assert.deepEqual(kinds.slice(0, 3), ['line', 'asm', 'regs']);
  assert.ok(kinds.includes('flags') && kinds.includes('adder'), kinds.join());
  const bytes = await page.$$eval('.paste-result .why-asm td.bytes', (tds) => tds.map((t) => t.textContent));
  assert.ok(bytes.length && bytes.every((b) => /^[0-9a-f]{2}( [0-9a-f]{2})*$/.test(b)));
  assert.equal(await page.locator('.paste-result .why-flags .flag-tile').count(), 4);
  assert.equal(await page.evaluate(() => document.querySelector('#pe-code').readOnly), true, 'locked after checking');
  await H.shot(page, 'paste-diagnosis-1366');

  // Edit and run again: back to the editor; a right prediction
  await page.click('button:text-is("Edit and run again")');
  assert.equal(await page.evaluate(() => document.querySelector('#pe-code').readOnly), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'pe-code');
  await page.fill('#pe-predict', '4294967283');
  await page.click('.confidence .seg button:text-is("Fairly sure")');
  await page.click('#pe-run');
  await page.waitForSelector('.paste-result .callout.ok');
  assert.equal(await page.textContent('.paste-result .callout.ok .callout-head'), 'Correct.');
  await page.click('button:text-is("Edit and run again")');

  // a compile error shows line and column and marks the line
  await page.fill('#pe-code', 'int x = 5\nreturn x;');
  await page.click('.confidence .seg button:text-is("Guessing")');
  await page.click('#pe-run');
  await page.waitForSelector('.pe-error');
  assert.match(await page.textContent('.pe-error .callout-head'), /^Compile error at line 2, column 1\.$/);
  assert.match(await page.textContent('.pe-error .callout-body'), /Expected ";"/);
  assert.equal(await page.textContent('.pe-gutter .pe-ln.err'), '▸2');
  assert.equal(await page.locator('.pe-error-src .cl.err').count(), 1);
  await H.shot(page, 'paste-error-1366');
  await page.click('button:text-is("Go to line 2")');
  assert.equal(await page.evaluate(() => document.querySelector('#pe-code').selectionStart), 10);
  // a runtime error
  await page.fill('#pe-code', 'int x = 0;\nint y = 5 / x;');
  await page.click('#pe-run');
  await H.until(page, () => /^Runtime error at line 2/.test(document.querySelector('.pe-error .callout-head')?.textContent || ''));

  // a printf string with markup is text, never HTML
  const XSS = 'printf("<img src=x onerror=alert(1)>\\n");';
  await page.fill('#pe-code', XSS);
  await page.fill('#pe-predict', 'nothing');
  await page.click('#pe-run');
  await page.waitForSelector('.paste-result .diagnosis');
  await openWhyFully(page, '.paste-result');
  assert.match(await page.textContent('.compare'), /<img src=x onerror=alert\(1\)>/);
  assert.equal(await page.locator('img').count(), 0);
  await H.sleep(200);
  assert.equal(dialogs, 0);
  await page.click('button:text-is("Edit and run again")');

  // the share link round-trips (UTF-8 too)
  const CODE = '// £5 → pence\nint p = 5 * 100;\nprintf("%d\\n", p);';
  await page.fill('#pe-code', CODE);
  await page.click('#pe-share');
  const url = await page.textContent('.share-panel .copy-value');
  assert.match(url, /#\/paste\?k=[0-9a-z]+&code=[A-Za-z0-9_-]+$/);
  await page.fill('#pe-code', 'int z = 0;');
  await page.goto(url);
  await H.until(page, () => /Loaded the program from your link/.test(document.querySelector('main[data-view="paste"]')?.textContent || ''));
  assert.equal(await page.inputValue('#pe-code'), CODE);
  // a broken link is refused kindly
  const refused = () => /That share link didn't work/.test(document.querySelector('main[data-view="paste"]')?.textContent || '');
  await page.evaluate(() => { location.hash = '/paste?code=%%%'; });
  await H.until(page, refused);
  await page.evaluate(() => { location.hash = '/cards'; });
  await H.until(page, () => !!document.querySelector('main[data-view="cards"]'));
  await page.evaluate((c) => { location.hash = `/paste?code=${c}`; }, 'A'.repeat(4001));
  await H.until(page, refused);
  assert.equal(await page.inputValue('#pe-code'), 'int z = 0;', 'a refused link falls back to the saved code');

  // projector-sized screen
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.selectOption('#pe-examples', '3');
  await page.fill('#pe-predict', '80');
  await page.click('.confidence .seg button:text-is("Certain")');
  await page.click('#pe-run');
  await page.waitForSelector('.checkpoint');
  await H.shot(page, 'paste-1920');

  assert.deepEqual(errors, []);
  assert.deepEqual(foreign(requests), []);
  await s.close();
});

test('phone 390 px: no horizontal page scroll; code scrolls inside', async () => {
  const s = await H.openMachine('/cards', { width: 390, height: 844, isMobile: true, hasTouch: true });
  const { page, errors, requests } = s;
  assert.ok(await noHScroll(page) <= 390, 'cards list');
  await H.shot(page, 'cards-list-390');

  const item = makeItem('card', { id: 'minus-one-vs-unsigned', v: 0 });
  await go(page, '/card/minus-one-vs-unsigned', 'card', item.card.title);
  await answerCard(page, item, '1');
  await page.waitForSelector('.callout.bad');
  await openWhyFully(page);
  assert.ok(await noHScroll(page) <= 390, `card with Why open: ${await noHScroll(page)}`);
  await page.evaluate(() => document.querySelector('.card-reveal').scrollIntoView());
  await H.shot(page, 'card-why-390');

  const long = `printf("${'x'.repeat(48)}%d\\n", 7 * 6);\nreturn 0;`;
  await go(page, '/paste', 'paste');
  await page.fill('#pe-code', long);
  await page.fill('#pe-predict', 'no');
  await page.click('.confidence .seg button:text-is("Certain")');
  await page.click('#pe-run');
  await page.waitForSelector('.paste-result .diagnosis');
  await openWhyFully(page, '.paste-result');
  assert.ok(await noHScroll(page) <= 390, `paste with Why open: ${await noHScroll(page)}`);
  const inner = await page.$$eval('.paste-result .code', (els) => els.some((e) => e.scrollWidth > e.clientWidth));
  assert.ok(inner, 'a long line scrolls inside its code block');
  await H.shot(page, 'paste-390');
  await page.click('button:text-is("Edit and run again")');
  await page.evaluate(() => window.scrollTo(0, 0));
  await H.shot(page, 'paste-editor-390');

  assert.deepEqual(errors, []);
  assert.deepEqual(foreign(requests), []);
  await s.close();
});
