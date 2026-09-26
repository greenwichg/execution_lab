// Whatever goes wrong with audio, the film still plays — silently.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.cjs');

after(H.teardown);
const corruptVoice = (html) => html.replace(/("data":")[A-Za-z0-9+/=]+(")/g, '$1AAAAAAAA$2');
const countContexts = () => {
  window.__ctxCount = 0;
  const Real = window.AudioContext;
  window.AudioContext = class extends Real { constructor(...a) { super(...a); window.__ctxCount++; } };
};
async function playsSilently(page) {
  await H.until(page, () => window.__lab.audio.debug().mode === 'silent' && window.__lab.timeline.playing);
  const t0 = await page.evaluate(() => window.__lab.F);
  await H.until(page, (x) => window.__lab.F > x + 0.3, t0, 10000);   // film plays (polls: software GL can stall a frame for seconds)
  assert.equal(await page.evaluate(() => window.__lab.timeline.cut.id), 'silent');
}

test('voice fails to decode → gate offers a silent start', async () => {
  const s = await H.open('norender', { html: corruptVoice });
  const { page } = s;
  await page.waitForSelector('#gate:not([hidden])');
  assert.match(await page.textContent('#beginBtn'), /BEGIN/);
  assert.doesNotMatch(await page.textContent('#beginBtn'), /SOUND/);
  assert.match(await page.textContent('#gateNote'), /unavailable/i);
  await page.click('#beginBtn');
  await playsSilently(page);
  assert.ok(s.infos.some((m) => /narration audio unavailable/.test(m)), 'reason logged (info level)');
  assert.deepEqual(s.errors, []);
  await s.close();
});

test('no Web Audio in the browser → silent', async () => {
  const s = await H.open('norender', { init: () => { window.AudioContext = undefined; window.webkitAudioContext = undefined; window.OfflineAudioContext = undefined; window.webkitOfflineAudioContext = undefined; } });
  await s.page.click('#beginBtn');
  await playsSilently(s.page);
  assert.deepEqual(s.errors, []);
  await s.close();
});

test('audio output blocked (context never starts) → silent, user told', async () => {
  const s = await H.open('norender', { init: () => {
    const Real = window.AudioContext;
    window.AudioContext = class extends Real {
      get state() { return 'suspended'; }
      resume() { return new Promise(() => {}); }
    };
  } });
  await s.page.click('#beginBtn');
  await H.until(s.page, () => document.querySelector('#toast').classList.contains('on'), null, 6000);
  assert.match(await s.page.textContent('#toast'), /silently/);
  await playsSilently(s.page);
  assert.deepEqual(s.errors, []);
  await s.close();
});

test('"Watch silently" never touches audio; sound can be turned on later', async () => {
  const s = await H.open('norender', { init: countContexts });
  const { page } = s;
  await page.click('#silentBtn');
  await playsSilently(page);
  assert.equal(await page.evaluate(() => window.__ctxCount), 0);
  assert.equal(await page.getAttribute('#soundBtn', 'data-state'), 'off');
  await page.evaluate(() => window.__lab.jump(40));
  await page.click('#soundBtn');
  assert.equal(await page.isVisible('#mixer'), true);
  assert.equal(await page.isVisible('#soundOnBtn'), true);
  const T0 = await page.evaluate(() => window.__lab.T);
  await page.click('#soundOnBtn');
  await H.until(page, () => window.__lab.audio.debug().mode === 'narrated' && window.__lab.audio.debug().ctx === 'running');
  const T1 = await page.evaluate(() => window.__lab.T);
  assert.ok(Math.abs(T1 - T0) < 0.5, `same story moment after switching to the narrated cut (${T0.toFixed(2)} → ${T1.toFixed(2)})`);
  assert.equal(await page.getAttribute('#soundBtn', 'data-state'), 'on');
  assert.deepEqual(s.errors, []);
  await s.close();
});

test('a line missing from the voice asset plays as subtitles only', async () => {
  const dropLine = (html) => html.replace(/\n"alu\.0": \{[^\n]*\},/, '\n');
  const s = await H.open('norender', { html: dropLine });
  const r = await s.page.evaluate(() => ({ has: window.__lab.audio.director.asset.has('alu.0'), inSchedule: window.__lab.audio.schedule().some((l) => l.id === 'alu.0'), ready: window.__lab.audio.director.ready.asset }));
  assert.deepEqual(r, { has: false, inSchedule: true, ready: true });
  assert.ok(s.infos.some((m) => /no clip for alu\.0/.test(m)));
  assert.deepEqual(s.errors, []);
  await s.close();
});
