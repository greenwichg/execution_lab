// Render the Code Execution Lab's narrated demo to an MP4 (frames stepped
// deterministically in headless Chromium, the recorded narration clips placed
// at their scheduled film times, burned-in subtitles). Marketing asset only:
// the product's learning path is Predict the Machine (machine/).
//
//   FFMPEG=/path/to/ffmpeg node tools/render-film/render.cjs [--fps 24] [--w 1280] [--h 720] [--q 1]
//        [--from 0] [--to <seconds>] [--out media/code-execution-lab.mp4] [--frames-only]
// q=0 and q=1 look nearly identical in stills; q=0 renders ~40% faster.
//
// Needs the tests' Playwright install (cd tests && npm install) and an ffmpeg
// with libx264 + aac (e.g. the static build inside the imageio-ffmpeg wheel).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const H = require('../../tests/harness.cjs');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const FPS = +arg('fps', 24), W = +arg('w', 1280), HGT = +arg('h', 720), Q = arg('q', '0');
const OUT = path.resolve(arg('out', 'media/code-execution-lab.mp4'));
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const WORK = path.resolve(arg('work', path.join(require('os').tmpdir(), 'cel-render')));

(async () => {
  fs.mkdirSync(path.join(WORK, 'frames'), { recursive: true });
  fs.mkdirSync(path.join(WORK, 'clips'), { recursive: true });
  const s = await H.open(`manual&narrated&q=${Q}`, { width: W, height: HGT });
  const { page } = s;
  // a film, not an app: no playback controls or stage buttons in the picture
  await page.addStyleTag({ content: '#controls, #stages, #infoBtn { display: none !important; }' });
  const info = await page.evaluate(() => {
    const L = window.__lab;
    L.pause();
    return { duration: L.audio.debug().duration, cut: L.audio.debug().cut, schedule: L.audio.schedule() };
  });
  if (info.cut !== 'narrated') throw new Error(`expected the narrated cut, got ${info.cut}`);
  const from = +arg('from', 0), to = Math.min(+arg('to', info.duration + 1.5), info.duration + 1.5);
  const n0 = Math.round(from * FPS), n1 = Math.round(to * FPS);
  console.log(`film ${info.duration.toFixed(1)} s · frames ${n0}–${n1} at ${FPS} fps · ${W}×${HGT} q=${Q}`);
  const t0 = Date.now();
  for (let f = n0; f < n1; f++) {
    await page.evaluate((F) => { const L = window.__lab; L.jumpFilm(F); L.step(0); }, f / FPS);
    await page.screenshot({ path: path.join(WORK, 'frames', `${String(f - n0).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 90 });
    if ((f - n0) % 12 === 11) {
      const done = f - n0 + 1, per = (Date.now() - t0) / done;
      console.log(`frame ${done}/${n1 - n0} · ${(per / 1000).toFixed(2)} s/frame · ~${Math.round(per * (n1 - f) / 60000)} min left`);
    }
  }
  // narration clips from the embedded voice asset, placed at their film start times
  const asset = await page.evaluate(() => JSON.parse(document.getElementById('voice-asset').textContent));
  await s.close(); await H.teardown();
  if (process.argv.includes('--frames-only')) return;
  const lines = info.schedule.filter((l) => asset.lines[l.id] && l.F0 >= from && l.F0 < to);
  const inputs = [], filters = [];
  lines.forEach((l, i) => {
    const file = path.join(WORK, 'clips', `${l.id}.mp3`);
    fs.writeFileSync(file, Buffer.from(asset.lines[l.id].data, 'base64'));
    inputs.push('-i', file);
    const ms = Math.round((l.F0 - from) * 1000);
    // the player skips each clip's leading silence; so do we
    filters.push(`[${i + 1}:a]silenceremove=start_periods=1:start_threshold=-50dB,adelay=${ms}|${ms},aresample=48000[a${i}]`);
  });
  const mix = lines.length
    ? `${filters.join(';')};${lines.map((_, i) => `[a${i}]`).join('')}amix=inputs=${lines.length}:normalize=0:dropout_transition=0,apad[aout]`
    : 'anullsrc=r=48000:cl=mono[aout]';
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
    '-framerate', String(FPS), '-i', path.join(WORK, 'frames', '%05d.jpg'), ...inputs,
    '-filter_complex', mix, '-map', '0:v', '-map', '[aout]', '-shortest',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '96k', OUT], { stdio: 'inherit' });
  console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
})().catch((e) => { console.error(e); process.exit(1); });
