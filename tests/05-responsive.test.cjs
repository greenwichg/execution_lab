// Layout at desktop, laptop, tablet and phone sizes: gate, subtitles, speaker menu.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.cjs');

after(H.teardown);
const SIZES = [
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: 'tablet-768x1024', width: 768, height: 1024, isMobile: true, hasTouch: true },
  { name: 'phone-390x844', width: 390, height: 844, isMobile: true, hasTouch: true },
];
const rects = (page, sels) => page.evaluate((ss) => Object.fromEntries(ss.map((s) => { const el = document.querySelector(s); if (!el) return [s, null]; const r = el.getBoundingClientRect(), cs = getComputedStyle(el); const vis = cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05 && r.width > 0; return [s, vis ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null]; })), sels);
const overlap = (a, b) => a && b && a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1;
const inside = (a, W, H) => a && a.l >= -1 && a.t >= -1 && a.r <= W + 1 && a.b <= H + 1;

for (const sz of SIZES) {
  test(`gate + narrated HUD at ${sz.name}`, async () => {
    const g = await H.open('q=0', sz);
    await g.page.waitForSelector('#gate:not([hidden])');
    const gr = await rects(g.page, ['#beginBtn', '#silentBtn', '#gateNote', '.g-in h1']);
    for (const [k, r] of Object.entries(gr)) assert.ok(inside(r, sz.width, sz.height), `${k} fully on screen`);
    assert.ok(await g.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll');
    await H.shot(g.page, `gate-${sz.name}`);
    assert.deepEqual(g.errors, []);
    await g.close();

    for (const T of [8.2, 36.6]) {
      const s = await H.open(`narrated&paused&t=${T}&q=0`, sz);
      const { page } = s;
      await H.until(page, () => document.querySelector('#subs').classList.contains('on'));
      await H.sleep(700);                          // let HUD fades settle
      const r = await rects(page, ['#subs span', '#controls .row', '#stages', '.bl', '.br', '#caption', '#reality', '#paths', '#proc']);
      assert.ok(inside(r['#subs span'], sz.width, sz.height), 'subtitles on screen');
      for (const k of ['#controls .row', '#stages', '.bl', '.br', '#caption', '#reality', '#paths', '#proc']) assert.ok(!overlap(r['#subs span'], r[k]), `subtitles clear of ${k}`);
      assert.ok(!overlap(r['#caption'], r['#reality']), 'caption clear of the reality panel');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll');
      await H.shot(page, `narrated-${sz.name}-t${T}`);
      if (T === 8.2) {
        await page.click('#soundBtn');
        const m = await rects(page, ['#mixer', '#soundBtn']);
        assert.ok(inside(m['#mixer'], sz.width, sz.height), 'speaker menu on screen');
        await H.shot(page, `mixer-${sz.name}`);
      }
      assert.deepEqual(s.errors, []);
      await s.close();
    }
  });
}
