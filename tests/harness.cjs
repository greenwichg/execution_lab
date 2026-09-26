// Shared test harness: serves the repo, launches headless Chromium, routes the
// three.js CDN to the local npm copy (so tests need no network) and records
// every console error/warning and page error.
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const THREE_JS = path.join(__dirname, 'node_modules/three/build/three.module.min.js');
const ARTIFACTS = path.join(__dirname, 'artifacts');

let server, port, browser;

async function setup() {
  if (browser) return;
  server = http.createServer((req, res) => {
    const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(f, (e, d) => {
      if (e) { res.writeHead(404); res.end(); return; }
      const type = f.endsWith('.html') ? 'text/html' : f.endsWith('.json') ? 'application/json' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type }); res.end(d);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=user-gesture-required'],
  });
}
async function teardown() { await browser?.close(); server?.close(); browser = null; }

/**
 * Open the lab. `query` is appended to index.html; `opts.html` can rewrite the page.
 * Resolves once the loader has finished.
 */
async function open(query = '', opts = {}) {
  await setup();
  const { width = 1280, height = 720, isMobile = false, hasTouch = false, init, html } = opts;
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile, hasTouch });
  const page = await context.newPage();
  const errors = [], infos = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') errors.push(`[${t}] ${m.text()}`);
    else infos.push(`[${t}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  await page.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ path: THREE_JS, headers: { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' } }));
  await page.route('https://unpkg.com/**', (r) => r.abort());
  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: '', headers: { 'content-type': 'text/css' } }));
  await page.route('https://fonts.gstatic.com/**', (r) => r.abort());
  if (html) {
    await page.route(`http://127.0.0.1:${port}/index.html*`, async (r) => {
      r.fulfill({ body: html(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')), headers: { 'content-type': 'text/html' } });
    });
  }
  if (init) await page.addInitScript(init);
  await page.goto(`http://127.0.0.1:${port}/index.html${query ? `?${query}` : ''}`);
  try { await page.waitForSelector('#loader.done', { state: 'attached', timeout: 180000 }); } catch (e) {
    throw new Error(`lab did not finish loading: ${e.message}\n${errors.join('\n')}`);
  }
  return { page, context, errors, infos, close: () => context.close() };
}

const lab = (page, fn, arg) => page.evaluate(fn, arg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** poll `fn` in the page until it returns truthy */
async function until(page, fn, arg, timeout = 20000) {
  const h = await page.waitForFunction(fn, arg, { timeout, polling: 50 });
  return h.jsonValue();
}
function shot(page, name) {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  return page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`) });
}
/** click Begin with sound and wait until narration mode is live */
async function beginWithSound(page) {
  await page.waitForSelector('#gate:not([hidden])');
  await page.click('#beginBtn');
  await until(page, () => window.__lab.audio.debug().mode === 'narrated' && window.__lab.audio.debug().ctx === 'running');
}

module.exports = { setup, teardown, open, lab, until, sleep, shot, beginWithSound, ROOT, ARTIFACTS };
