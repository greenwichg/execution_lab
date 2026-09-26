// Predict the Machine — C on x86-64, adversarially: every card end to end with
// no answer in the page before Check, variants that don't promise the old
// numbers, "Not sure" checkpoints, keyboard-only use, awkward pasted C,
// BigInt checkpoints, truncated and tampered share links, phones and projectors.
const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const H = require('./harness.cjs');

after(H.teardown);

const M = (p) => pathToFileURL(path.join(__dirname, '../machine/src', p)).href;
let CARDS, makeItem, analyzePaste, diagnosePaste, why;
before(async () => {
  ({ CARDS, why } = await import(M('learn/cards.js')));
  ({ makeItem } = await import(M('learn/items/index.js')));
  ({ analyzePaste, diagnosePaste } = await import(M('learn/paste.js')));
});

const foreign = (reqs) => reqs.filter((u) => !/^(https?:\/\/127\.0\.0\.1[:/]|data:|blob:|about:)/.test(u));
const scrollW = (page) => page.evaluate(() => document.documentElement.scrollWidth);
const active = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return { tag: a.tagName, id: a.id, cls: a.className, text: (a.textContent || '').trim().slice(0, 80) };
});

async function go(page, route, view) {
  await page.evaluate((r) => { location.hash = r; }, route);
  await H.until(page, ([r, v]) => location.hash === `#${r}` && !!document.querySelector(`main[data-view="${v}"] h1`), [route, view]);
}

/** a wrong answer for any card's field */
function wrongFor(item) {
  const f = item.fields[0];
  const k = item.key;
  if (f.kind === 'flags') return { flags: { ...k.flags, CF: 1 - k.flags.CF } };
  if (f.kind === 'choice') return { branch: f.choices.find((c) => c !== k.branch) };
  if (f.kind === 'number') return { value: 12345 };
  return { output: '12345' };
}
async function fillCard(page, item, ans) {
  const f = item.fields[0];
  if (f.kind === 'text') await page.fill('.item-answer textarea', ans.output);
  else if (f.kind === 'number') await page.fill('.item-answer input.num-in', String(ans.value));
  else if (f.kind === 'choice') await page.click(`.item-answer .seg button:text-is("${ans.branch}")`);
  else for (const [n, v] of Object.entries(ans.flags)) await page.click(`.item-answer .flag-row:has(abbr:text-is("${n}")) .seg button:text-is("${v}")`);
  await page.click('.confidence .seg button:text-is("Fairly sure")');
  await page.click('button:text-is("Check answer")');
}

test('every card end to end: nothing leaks before Check; labels after; Not sure; Why to the end; variant; next', async () => {
  const s = await H.openMachine('/cards', { width: 1366, height: 768 });
  const { page, errors, requests } = s;
  for (const [i, c] of CARDS.entries()) {
    const v = 40 + i;
    for (const vv of [0, v]) {
      const item = makeItem('card', { id: c.id, v: vv });
      await go(page, vv ? `/card/${c.id}?v=${vv}` : `/card/${c.id}`, 'card');
      await page.waitForSelector('.item-before .c-src');
      const pre = await page.evaluate(() => {
        const main = document.querySelector('main');
        return {
          text: main.innerText,
          attrs: [...main.querySelectorAll('*')].flatMap((e) => [...e.attributes].filter((a) => a.name !== 'tabindex').map((a) => a.value)).join(' | '),
          code: [...main.querySelectorAll('.item-before .c-src .cl-t')].map((e) => e.textContent).join('\n'),
          focus: [...main.querySelectorAll('.item-before .c-src .cl.focus')].map((e) => +e.dataset.line),
          h1: main.querySelector('h1').textContent,
          revealed: main.querySelectorAll('.card-reveal, .std-line, .gcc-line, .why, .callout').length,
          live: document.getElementById('live').textContent,
        };
      });
      const tag = `${c.id} v${vv}`;
      // the highlighted snippet is exactly the item's source, with its focus line
      assert.equal(pre.code, item.show.src, `${tag}: snippet`);
      assert.deepEqual(pre.focus, [item.show.focusLine], `${tag}: focus line`);
      // nothing about the answer, the C standard or gcc before Check
      assert.equal(pre.revealed, 0, `${tag}: revealed before Check`);
      assert.doesNotMatch(pre.text, /C standard:|gcc -O0 on x86-64:|Same output as gcc|implementation-defined|undefined/, tag);
      const k = item.key;
      const keyText = String(k.output ?? k.value ?? k.branch ?? '');
      for (const piece of [keyText, ...keyText.split(/\s+/)]) {
        if (piece.length < 2 || item.show.src.includes(piece) || item.card.ask.kind === 'branch') continue;
        assert.ok(!pre.text.includes(piece) && !pre.attrs.includes(piece), `${tag}: the answer ${piece} is in the page before Check`);
      }
      // a variant's heading doesn't promise the canonical card's numbers
      if (vv) assert.doesNotMatch(pre.h1, /\d/, `${tag}: ${pre.h1}`);
      else assert.equal(pre.h1, c.title);
    }

    // answer the variant wrongly; say "Not sure" to every checkpoint
    const item = makeItem('card', { id: c.id, v });
    await fillCard(page, item, wrongFor(item));
    for (let q = 0; q < 4; q++) {
      const skip = page.locator('.checkpoint button:text-is("Not sure"):not([disabled])');
      if (!(await skip.count())) break;
      assert.ok(q < 3, `${c.id}: more than 3 checkpoints`);
      await skip.click();
      const res = page.locator('.checkpoint .cp-result').nth(q);
      await res.waitFor();
      assert.match(await res.textContent(), /^The answer is .+\.$/, `${c.id}: Not sure is neutral`);
      assert.equal(await res.locator('.glyph').count(), 0, `${c.id}: no ✗ for Not sure`);
    }
    await page.waitForSelector('.item-feedback > .callout.bad');
    // focus lands on the diagnosis, not on an old checkpoint
    const a = await active(page);
    assert.ok(/callout/.test(a.cls) && /bad/.test(a.cls), `${c.id}: focus on ${JSON.stringify(a)}`);
    // labels, always, after reveal
    const std = await page.textContent('.std-line');
    assert.ok(std.startsWith('C standard:') && std.includes(item.card.std.status), `${c.id}: ${std}`);
    assert.ok((await page.textContent('.gcc-line')).startsWith('gcc -O0 on x86-64:'));
    assert.match(await page.textContent('.card-reveal'), /Same output as gcc -O0 on x86-64/);
    // Why to the deepest layer; the line layer shows the same source
    await page.click('.why-foot button');
    for (let n = 0; n < 10; n++) {
      const more = page.locator('.why-foot button');
      if (!(await more.count())) break;
      await more.click();
    }
    await page.waitForSelector('.why-end');
    const kinds = await page.$$eval('.why-layer', (ls) => ls.map((l) => l.dataset.kind));
    const expect = why(item, null, { level: 'csapp' }).map((l) => l.kind);
    assert.deepEqual(kinds, expect, c.id);
    assert.equal(kinds[0], 'line');
    const lineSrc = await page.$eval('.why-line .src-lines', (p) => [...p.querySelectorAll('.src-line')].map((l) => l.textContent.replace(/^\s*\d+ /, '').replace(/\n$/, '')).join('\n'));
    assert.equal(lineSrc.replace(/ +$/gm, ''), item.show.src.replace(/ +$/gm, ''), `${c.id}: Why line source`);
    if (i === 3) await H.shot(page, 'cards-adv-variant-why-1366');
    // another like it: the same card, new numbers
    const was = await page.evaluate(() => location.hash);
    await page.click('button:text-is("Try one like it")');
    await H.until(page, ([w, id]) => location.hash !== w && location.hash.startsWith(`#/card/${id}?v=`) && !!document.querySelector('main[data-view="card"] .item-before'), [was, c.id]);
    assert.doesNotMatch(await page.textContent('main h1'), /\d/);
    assert.equal(await page.locator('main .card-variant-note a').count(), 1);
  }

  // next from a card goes to the following card
  const first = makeItem('card', { id: CARDS[0].id, v: 0 });
  await go(page, `/card/${CARDS[0].id}`, 'card');
  await fillCard(page, first, { output: first.key.output });
  await page.click('button:text-is("Next card")');
  await H.until(page, (id) => location.hash === `#/card/${id}`, CARDS[1].id);

  // tampered card links
  for (const bad of ['/card/%E0%A4%A', '/card/<img src=x>', `/card/${CARDS[0].id}?v=-1`, `/card/${CARDS[0].id}?v=99999999`, `/card/${CARDS[0].id}?v=1e3`]) {
    await go(page, '/cards', 'cards');
    await page.evaluate((r) => { location.hash = r; }, bad);
    const want = bad.includes('?v=') ? CARDS[0].title : 'Card not found';
    await H.until(page, (w) => document.querySelector('main[data-view="card"] h1')?.textContent === w, want);
  }
  assert.equal(await page.locator('main img').count(), 0);

  assert.deepEqual(errors, []);
  assert.deepEqual(foreign(requests), []);
  await s.close();
});

test('cards by keyboard only: answer, confidence, Check, checkpoint by Enter, unreadable replies', async () => {
  const s = await H.openMachine('/card/short-truncation', { width: 1366, height: 768 });
  const { page, errors } = s;
  const item = makeItem('card', { id: 'short-truncation', v: 0 });
  assert.equal((await active(page)).tag, 'H1', 'the router focuses the heading');
  const tabTo = async (pred, max = 30) => {
    for (let n = 0; n < max; n++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(pred)) return;
    }
    throw new Error(`never reached ${pred}`);
  };
  await tabTo(() => document.activeElement.matches('.item-answer input'));
  await page.keyboard.type('70000');
  await tabTo(() => document.activeElement.matches('.confidence button'));
  await page.keyboard.press('Tab');
  await page.keyboard.press('Space');                     // Fairly sure
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  assert.equal((await active(page)).text, 'Check answer');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.callout.bad');
  // a classic mistake: diagnosed straight away, focus on the diagnosis
  assert.match(await page.textContent('.callout.bad .callout-head'), /kept the whole value/);
  assert.match((await active(page)).cls, /callout/);

  // a variant that needs checkpoints: unreadable replies are not "Not sure"
  await page.evaluate(() => { location.hash = '/card/short-truncation?v=17'; });
  await page.waitForSelector('.card-variant-note');
  const v = makeItem('card', { id: 'short-truncation', v: 17 });
  await page.click('.confidence .seg button:text-is("Certain")');
  await page.fill('.item-answer input.num-in', '5');
  await page.keyboard.press('Enter');                     // Enter in the answer box checks
  await page.waitForSelector('.checkpoint');
  assert.match((await active(page)).tag, /INPUT/, 'focus moves to the checkpoint');
  await page.keyboard.press('Enter');
  assert.match(await page.textContent('.checkpoint .cp-hint'), /Give an answer first, or choose Not sure/);
  await page.keyboard.type('0x10');
  await page.keyboard.press('Enter');
  assert.match(await page.textContent('.checkpoint .cp-hint'), /whole number in denary/);
  assert.equal(await page.locator('.checkpoint .cp-result').count(), 0);
  await page.fill('.checkpoint input', '16');
  await page.keyboard.press('Enter');
  await page.locator('.checkpoint .cp-result').first().waitFor();
  assert.match(await page.textContent('.checkpoint .cp-result'), /Right\./);
  assert.equal(await page.locator('.checkpoint .cp-hint').count(), 1, 'the answered hint is removed');
  void v;
  assert.deepEqual(errors, []);
  await s.close();
});

const LINES = (n) => Array.from({ length: n }, (_, i) => `int v${i} = ${i};`).join('\n');
async function setCode(page, code) {
  await page.evaluate((c) => { const ta = document.querySelector('#pe-code'); ta.value = c; ta.dispatchEvent(new Event('input')); }, code);
}
async function run(page, predict = 'x', conf = 'Guessing') {
  if (await page.$eval('#pe-code', (t) => t.readOnly)) await finishCps(page);
  if (await page.$('button:text-is("Edit and run again")')) await page.click('button:text-is("Edit and run again")');
  await page.fill('#pe-predict', predict);
  await page.click(`.confidence .seg button:text-is("${conf}")`);
  await page.click('#pe-run');
}
/** say "Not sure" until the diagnosis */
async function finishCps(page) {
  for (let q = 0; q < 4; q++) {
    await page.waitForSelector('.checkpoint button:text-is("Not sure"):not([disabled]), .paste-result .item-next');
    const skip = page.locator('.checkpoint button:text-is("Not sure"):not([disabled])');
    if (!(await skip.count())) return;
    await skip.click();
  }
}
const errHead = (page) => H.until(page, () => document.querySelector('.pe-error .callout-head')?.textContent || false);

test('paste: awkward programs get a clear, correct message', async () => {
  const s = await H.openMachine('/paste', { width: 1366, height: 768 });
  const { page, errors, requests } = s;
  let dialogs = 0;
  page.on('dialog', (d) => { dialogs++; d.dismiss().catch(() => {}); });

  // empty
  await setCode(page, '  \n\n');
  await run(page);
  assert.match(await page.textContent('.check-hint'), /no program to run yet/);
  assert.equal(await page.locator('.paste-result > *').count(), 0);

  // 30 lines plus blank lines at the end is fine; 31 is not
  await setCode(page, `${LINES(30)}\n\n\n`);
  assert.equal(await page.textContent('#pe-count'), '30 of 30 lines.');
  assert.equal(await page.locator('#pe-count.over').count(), 0);
  await setCode(page, LINES(31));
  assert.equal(await page.textContent('#pe-count'), '31 of 30 lines. That is 1 too many.');
  await run(page);
  assert.equal(await errHead(page), 'Too big for this lab at line 31, column 1.');

  // 73+ columns, and a very long single line (scrolls inside its box)
  await setCode(page, `int x = 1; // ${'y'.repeat(70)}\nprintf("%d\\n", x);`);
  assert.match(await page.textContent('#pe-count'), /Line 1 is 84 characters; the limit is 72\./);
  await run(page);
  assert.equal(await errHead(page), 'Too big for this lab at line 1, column 73.');
  await setCode(page, `int x = 1;${' '.repeat(40)}/*${'z'.repeat(400)}*/`);
  await run(page);
  await errHead(page);
  assert.ok(await scrollW(page) <= 1366, 'no page scroll from a 450-character line');

  // unsupported C: named clearly as a compile error, with the line
  const unsupported = [
    ['int x = 5;\nint *p = &x;\nprintf("%d\\n", *p);', /^Compile error at line 2, column \d+\.$/, /Pointers/],
    ['int a[3];\na[0] = 1;', /^Compile error at line 1/, /Arrays/],
    ['float f = 1.5;\nprintf("%f\\n", f);', /^Compile error at line 1/, /Floating-point/],
    ['printf("%s\\n", "hi");', /^Compile error at line 1/, /Strings/],
    ['int x = 1;\nprintf("%n", x);', /^Compile error at line 2/, /not %n/],
    ['int f(int a) { return a; }\nint main() { return f(1); }', /^Compile error at line 1/, /one function/],
  ];
  for (const [code, head, body] of unsupported) {
    await setCode(page, code);
    await run(page);
    assert.match(await errHead(page), head, code);
    assert.match(await page.textContent('.pe-error .callout-body'), body);
    assert.doesNotMatch(await page.textContent('.pe-error .callout-body'), /[.?!]\.$/, 'no doubled full stop');
  }
  await H.shot(page, 'paste-adv-compile-error-1366');

  // runtime errors and limits hit while running: "stopped", never "compile error"
  await setCode(page, 'int x = 0;\nint y = 5 / x;');
  await run(page);
  assert.equal(await errHead(page), 'Runtime error at line 2.');
  await setCode(page, 'int x = 0;\nwhile (1) {\n  x = x + 1;\n}');
  await run(page);
  assert.match(await errHead(page), /^The program was stopped at line \d\.$/);
  assert.match(await page.textContent('.pe-error .callout-body'), /never ends\?$/);
  await setCode(page, 'for (int i = 0; i < 100000; i++)\n  printf("%d\\n", i);');
  await run(page);
  assert.match(await errHead(page), /^The program was stopped at line 2\.$/);
  assert.match(await page.textContent('.pe-error .callout-body'), /more than 4000 characters/);

  // lots of output that fits: the comparison scrolls inside its own box, first difference in view
  const many = 'for (int i = 0; i < 300; i++)\n  printf("%d\\n", i);';
  const out = Array.from({ length: 300 }, (_, i) => String(i));
  out[250] = 'oops';
  await setCode(page, many);
  await run(page, out.join('\n'));
  await page.waitForSelector('.compare');
  await H.until(page, () => [...document.querySelectorAll('.out-pre')].every((p) => p.scrollTop > 0));
  const box = await page.$eval('.out-pre', (p) => p.getBoundingClientRect().height);
  assert.ok(box < 600, `output box is ${box}px high`);
  await page.waitForSelector('.paste-result .diagnosis, .paste-result .checkpoint');

  // unicode, and markup in strings and comments stays text
  await setCode(page, '// héllo → ✓ <b>bold</b>\nint x = 3; /* <script>alert(1)</script> */\nprintf("£%d ✓ <i>x</i>\\n", x);');
  await run(page, '£3 ✓ <i>x</i>', 'Certain');
  await page.waitForSelector('.paste-result .callout.ok');
  assert.match(await page.textContent('.paste-result'), /£3 ✓ <i>x<\/i>/);
  assert.equal(await page.locator('main script, main b, main i, main img').count(), 0);
  await setCode(page, 'printf("<img src=x onerror=alert(1)>\\n");\nint y = 1 / 0; // <svg onload=alert(2)>');
  await run(page);
  await errHead(page);
  assert.match(await page.textContent('.pe-error-src'), /<svg onload=alert\(2\)>/);
  assert.equal(await page.locator('main img, main svg:not(.adder-svg)').count(), 0);

  // Windows line endings in the program and the prediction
  await setCode(page, 'int a = 7;\r\nint b = a * 6;\r\nprintf("%d\\n%d\\n", a, b);\r\n');
  await run(page, '7\r\n42\r\n', 'Certain');
  await page.waitForSelector('.paste-result .callout.ok');

  await H.sleep(200);
  assert.equal(dialogs, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(foreign(requests), []);
  await s.close();
});

test('paste: BigInt checkpoints, Not sure all the way, unreadable replies, example undo', async () => {
  const s = await H.openMachine('/paste', { width: 1366, height: 768 });
  const { page, errors } = s;

  // 64-bit values beyond 2^53 are asked and checked exactly
  const BIG = 'long x = 9007199254740993L;\nlong y = x * 3;\nlong z = y + 1;\nprintf("%ld\\n", z);';
  const a = analyzePaste(BIG);
  const first = diagnosePaste(a, '0', []).next;
  assert.equal(typeof first.answer, 'bigint');
  await setCode(page, BIG);
  await run(page, '0', 'Certain');
  await page.waitForSelector('.checkpoint');
  await page.fill('.checkpoint input', String(first.answer));
  await page.keyboard.press('Enter');
  await page.locator('.checkpoint .cp-result').first().waitFor();
  assert.match(await page.textContent('.checkpoint .cp-result'), /^✓.*Right\.$/);
  await finishCps(page);
  // the Number-rounded value is wrong, and says the exact one
  await page.click('button:text-is("Edit and run again")');
  await run(page, '0', 'Certain');
  await page.waitForSelector('.checkpoint');
  await page.fill('.checkpoint input', String(Number(first.answer)));
  await page.click('.checkpoint button:text-is("Answer")');
  await page.locator('.checkpoint .cp-result').first().waitFor();
  assert.ok((await page.textContent('.checkpoint .cp-result')).includes(`Not quite — it's ${first.answer}.`));
  await finishCps(page);

  // Not sure every time: neutral, still ends in a diagnosis with focus on it
  await go(page, '/cards', 'cards');
  await go(page, '/paste', 'paste');
  await page.selectOption('#pe-examples', '1');
  await run(page, '2 9', 'Certain');
  for (let q = 0; q < 4; q++) {
    const skip = page.locator('.checkpoint button:text-is("Not sure"):not([disabled])');
    await page.waitForSelector('.checkpoint button:text-is("Not sure"):not([disabled]), .paste-result .diagnosis');
    if (!(await skip.count())) break;
    assert.ok(q < 3);
    // an unreadable reply first
    await page.locator('.checkpoint').last().locator('input').fill('abc');
    await page.keyboard.press('Enter');
    assert.match(await page.locator('.checkpoint').last().locator('.cp-hint').textContent(), /whole number in denary/);
    await skip.click();
    const r = page.locator('.checkpoint .cp-result').nth(q);
    await r.waitFor();
    assert.match(await r.textContent(), /^The answer is -?\d+\.$/);
  }
  await page.waitForSelector('.paste-result .diagnosis');
  assert.match((await active(page)).cls, /diagnosis/);
  await H.shot(page, 'paste-adv-notsure-1366');

  // loading an example keeps the learner's code one click away
  await page.click('button:text-is("Edit and run again")');
  await setCode(page, 'int mine = 1;\nprintf("%d\\n", mine);');
  await page.selectOption('#pe-examples', '2');
  assert.match(await page.inputValue('#pe-code'), /2147483600/);
  await page.click('button:text-is("Put my own code back")');
  assert.equal(await page.inputValue('#pe-code'), 'int mine = 1;\nprintf("%d\\n", mine);');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('pm.paste.code'))), 'int mine = 1;\nprintf("%d\\n", mine);');
  assert.equal((await active(page)).id, 'pe-code');

  assert.deepEqual(errors, []);
  await s.close();
});

test('paste: keyboard users are never trapped in the editor', async () => {
  const s = await H.openMachine('/paste', { width: 1366, height: 768 });
  const { page, errors } = s;
  await setCode(page, 'int x = 1;');
  await page.focus('#pe-code');
  await page.keyboard.press('End');
  await page.keyboard.press('Tab');
  assert.equal(await page.inputValue('#pe-code'), 'int x = 1;  ', 'Tab indents');
  assert.equal((await active(page)).id, 'pe-code');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  assert.notEqual((await active(page)).id, 'pe-code', 'Escape then Tab leaves');
  assert.equal(await page.inputValue('#pe-code'), 'int x = 1;  ');
  // back in: Escape, then typing, then Tab indents again (Escape only frees the next Tab)
  await page.focus('#pe-code');
  await page.keyboard.press('Escape');
  await page.keyboard.type('y');
  await page.keyboard.press('Tab');
  assert.equal((await active(page)).id, 'pe-code');
  // Shift+Tab always leaves
  await page.keyboard.press('Shift+Tab');
  assert.notEqual((await active(page)).id, 'pe-code');
  // the help says how, and the editor points to it
  assert.match(await page.getAttribute('#pe-code', 'aria-describedby'), /pe-help/);
  assert.match(await page.textContent('#pe-help'), /press Esc then Tab to leave the editor/);
  // Ctrl+Enter runs from the editor; a compile error puts focus on the message, Go to line returns
  await setCode(page, 'int x = 5\nreturn x;');
  await page.click('.confidence .seg button:text-is("Guessing")');
  await page.focus('#pe-code');
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('.pe-error');
  assert.match((await active(page)).cls, /pe-error/);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const at = await active(page);
  assert.equal(at.text, 'Go to line 2', JSON.stringify(at));
  await page.keyboard.press('Enter');
  assert.equal((await active(page)).id, 'pe-code');
  assert.deepEqual(errors, []);
  await s.close();
});

test('paste share links: round trip, truncated, tampered, legacy, bidi, restore my own code', async () => {
  const s = await H.openMachine('/paste', { width: 1366, height: 768 });
  const { page, errors } = s;
  const MINE = 'int mine = 2;\nprintf("%d\\n", mine);';
  await setCode(page, MINE);
  const CODE = '// £5 → pence\nint p = 5 * 100;\nprintf("%d\\n", p);';
  await setCode(page, CODE);
  await page.click('#pe-share');
  const url = await page.textContent('.share-panel .copy-value');
  const m = /#(\/paste\?k=([0-9a-z]+)&code=([A-Za-z0-9_-]+))$/.exec(url);
  assert.ok(m, url);
  await setCode(page, MINE);
  const loaded = () => /Loaded the program from your link/.test(document.querySelector('main[data-view="paste"]')?.textContent || '');
  const refused = () => /That share link didn't work/.test(document.querySelector('main[data-view="paste"]')?.textContent || '');
  const visit = async (route, ok) => {
    await page.evaluate(() => { location.hash = '/cards'; });
    await page.waitForSelector('main[data-view="cards"]');
    await page.evaluate((r) => { location.hash = r; }, route);
    await H.until(page, ok);
  };
  await visit(m[1], loaded);
  assert.equal(await page.inputValue('#pe-code'), CODE);
  // restore my own code
  await page.click('button:text-is("Load my own program instead")');
  assert.equal(await page.inputValue('#pe-code'), MINE);
  // truncated at every few characters: never half-loaded
  for (const cut of [1, 2, 3, 4, 7, 12]) {
    await visit(`/paste?k=${m[2]}&code=${m[3].slice(0, -cut)}`, refused);
    assert.equal(await page.inputValue('#pe-code'), MINE, `cut ${cut}`);
  }
  // tampered: one character changed
  const t = m[3].slice(0, 10) + (m[3][10] === 'A' ? 'B' : 'A') + m[3].slice(11);
  await visit(`/paste?k=${m[2]}&code=${t}`, refused);
  await visit(`/paste?k=zzzz&code=${m[3]}`, refused);
  // legacy links without a check still load
  await visit(`/paste?code=${m[3]}`, loaded);
  assert.equal(await page.inputValue('#pe-code'), CODE);
  // bidi controls are dropped from shared code
  const trojan = await page.evaluate(async () => {
    const mod = await import('./src/ui/views/paste.js');
    const c = 'int ok = 1; /* ‮ } ⁦ */\nprintf("%d\\n", ok);';
    return mod.sharePath(c);
  });
  await visit(trojan, loaded);
  assert.doesNotMatch(await page.inputValue('#pe-code'), /[‪-‮⁦-⁩]/);
  await H.shot(page, 'paste-adv-link-1366');
  assert.deepEqual(errors, []);
  await s.close();
});

test('phones and projectors: no page scroll, readable code, screenshots', async () => {
  const s = await H.openMachine('/card/int-max-plus-one?v=3', { width: 390, height: 844, isMobile: true, hasTouch: true });
  const { page, errors, requests } = s;
  const item = makeItem('card', { id: 'int-max-plus-one', v: 3 });
  assert.doesNotMatch(await page.textContent('main h1'), /\d/);
  await H.shot(page, 'cards-adv-variant-390');
  await fillCard(page, item, { output: 'overflow error' });
  await page.waitForSelector('.callout.bad');
  await page.click('.why-foot button');
  for (let n = 0; n < 8; n++) { const more = page.locator('.why-foot button'); if (!(await more.count())) break; await more.click(); }
  assert.ok(await scrollW(page) <= 390, `card: ${await scrollW(page)}`);
  await page.evaluate(() => document.querySelector('.callout.bad').scrollIntoView());
  await H.shot(page, 'cards-adv-wrong-390');

  await go(page, '/paste', 'paste');
  await setCode(page, `${LINES(28)}\nint long_name_for_a_total = v1 + v2 + v3 + v4 + v5 + v6 + v7 + v8 + v9;\nprintf("%d\\n", long_name_for_a_total);`);
  await run(page, '44', 'Certain');
  await page.waitForSelector('.paste-result .checkpoint, .paste-result .diagnosis');
  assert.ok(await scrollW(page) <= 390, `paste: ${await scrollW(page)}`);
  await page.evaluate(() => document.querySelector('.paste-result').scrollIntoView());
  await H.shot(page, 'paste-adv-30lines-390');
  await finishCps(page);
  await page.click('button:text-is("Edit and run again")');
  await setCode(page, 'int x = 5;\nint *p = &x;');
  await run(page);
  await errHead(page);
  assert.ok(await scrollW(page) <= 390);
  await page.evaluate(() => document.querySelector('.pe-error').scrollIntoView());
  await H.shot(page, 'paste-adv-error-390');
  assert.deepEqual(errors, []);
  assert.deepEqual(foreign(requests), []);
  await s.close();

  const p = await H.openMachine('/card/signed-unsigned-branch', { width: 1920, height: 1080 });
  const b = makeItem('card', { id: 'signed-unsigned-branch', v: 0 });
  await H.shot(p.page, 'cards-adv-branch-1920');
  const size = await p.page.$eval('.item-before .c-src', (e) => parseFloat(getComputedStyle(e).fontSize));
  assert.ok(size >= 19, `code font ${size}px on a projector`);
  await fillCard(p.page, b, { branch: b.fields[0].choices.find((c) => c !== b.key.branch) });
  await p.page.waitForSelector('.item-feedback .callout.bad, .checkpoint');
  // C spelling is kept: printed messages and instruction names are never capitalised
  assert.deepEqual(await p.page.$$eval('.item-answer .seg button', (bs) => bs.map((x) => x.textContent)), b.fields[0].choices);
  const jumps = await p.page.$$eval('.checkpoint .seg button', (bs) => bs.map((x) => x.textContent));
  assert.ok(jumps.length === 2 && jumps.every((j) => /^j[a-z]+$/.test(j)), jumps.join());
  await H.shot(p.page, 'cards-adv-branch-wrong-1920');
  assert.deepEqual(p.errors, []);
  await p.close();
});
