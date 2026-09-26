// A short landing/outreach clip: the projector reveal of an 8-bit overflow
// (default 200 + 65 = 9) exactly as Predict the Machine shows it in class.
//   FFMPEG=/path/to/ffmpeg node tools/render-film/reveal-clip.cjs [--a 200] [--b 65] [--out media/overflow-200-65.mp4]
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { chromium } = require('../../tests/node_modules/playwright');
const H = require('../../tests/harness.cjs');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const A = +arg('a', 200), B = +arg('b', 65);
const OUT = path.resolve(arg('out', 'media/overflow-200-65.mp4'));
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

(async () => {
  await H.setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reveal-'));
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, recordVideo: { dir, size: { width: 1920, height: 1080 } } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${H.port()}/machine/index.html#/`);
  await page.waitForSelector('main[data-view]');
  const t0 = Date.now();
  await page.evaluate(async ({ A, B }) => {
    const { makeItem } = await import('./src/learn/items/index.js');
    const { mountAddition } = await import('./src/ui/reveal.js');
    const { h } = await import('./src/lib/dom.js');
    document.body.classList.add('projector');
    const item = makeItem('add', { w: 8, a: A, b: B, ask: 'result', level: 'gcse' });
    // the starter's own layout classes (css/teacher.css), so the clip looks like class use
    const visual = h('div', { class: 'sr-visual' });
    const cue = h('p', { class: 'sr-board' }, 'Answer on your whiteboards.');
    const main = h('main', { class: 'page page-wide sr', 'data-view': 'clip' },
      h('div', { class: 'sr-top' }, h('h1', { class: 'sr-title' }, 'Starter · Year 10'), h('span', { class: 'sr-count' }, '1 of 5')),
      h('div', { class: 'sr-stage' }, h('section', { class: 'sr-q' },
        h('p', { class: 'sr-source' }, h('span', { class: 'chip accent' }, 'Missed last time'), ' ', h('span', { class: 'sr-note' }, 'Binary addition and overflow')),
        h('h2', { class: 'sr-prompt' }, item.prompt), visual, cue)));
    document.getElementById('app').replaceChildren(main);
    const ctl = mountAddition(visual, item);        // as the starter does: mount once, reveal in place
    window.__reveal = () => { cue.remove(); ctl.reveal({ animate: true }); };
  }, { A, B });
  await page.waitForTimeout(2500);                 // time to think
  await page.evaluate(() => window.__reveal());
  await page.waitForTimeout(5000);                 // the ripple, the lost bit, a moment to read
  const lead = (Date.now() - t0) / 1000;
  const video = page.video();
  await context.close();
  const webm = await video.path();
  await browser.close();
  await H.teardown();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  // the recording starts before the page is ready; keep the last `lead` seconds
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-sseof', `-${lead.toFixed(2)}`, '-i', webm,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart', '-an', OUT], { stdio: 'inherit' });
  console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB)`);
})().catch((e) => { console.error(e); process.exit(1); });
