// The class board: result codes pasted from anywhere → what the class got
// wrong (with a worked example to project), every row, the lines that were
// not codes, and the crossover study's reading. The pasted text is kept in
// memory only; everything stays on this device.
import { h, href, announce, download, focus, replace } from '../../lib/dom.js';
import { mulberry32, newSeed } from '../../lib/rng.js';
import { analyzeTokens, toCsv } from '../../learn/board.js';
import { TAGS, tagLabel } from '../../learn/catalogue.js';
import { button, callout, tile } from '../parts.js';
import { renderLayer } from '../why.js';
import { setNav } from '../nav.js';
import { codeFromText } from './teacher.js';

const MODE_TEXT = { normal: 'Normal', study: 'Study', delayed: 'Delayed' };
const pct = (x) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${Math.round(x * 100)}%`);
const pts = (x) => { const r = Math.round(x * 100); return r === 0 ? '0' : `${r > 0 ? '+' : '−'}${Math.abs(r)}`; };
const fix2 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : (x < 0 ? `−${Math.abs(x).toFixed(2)}` : x.toFixed(2)));

let overlay = null;
// a whole year's export pasted at once must not freeze a Chromebook: tables show
// this many rows, and the CSV always has every row
const SHOW_MAX = 300;
const ARM_TEXT = { 0: 'A (arm 0)', 1: 'B (arm 1)', 2: 'unknown' };
function capNote(shown, all) {
  return all > shown ? h('p', { class: 'small muted bd-cap' }, `Showing the first ${shown} of ${all}. Download the CSV to see them all.`) : null;
}

export function render(el, ctx) {
  setNav('#/teacher');
  const text = h('textarea', { id: 'bd-codes', rows: '8', spellcheck: 'false', autocomplete: 'off', placeholder: 'One code per line, e.g.\n7K2M-9QXA-40TT\nor paste a whole spreadsheet column' });
  const setIn = h('input', { type: 'text', id: 'bd-set', class: 'mono', autocomplete: 'off', spellcheck: 'false', value: ctx.query.get('set') || '', placeholder: 'optional' });
  const results = h('div', { class: 'stack-lg bd-results' });
  let last = null;

  const form = h('form', { class: 'panel stack', novalidate: true },
    h('label', { class: 'field', for: 'bd-codes' }, h('span', null, 'Paste result codes'), h('span', { class: 'hint' }, 'From a chat, a form or a spreadsheet column. Names and other text are ignored.'), text),
    h('label', { class: 'field', for: 'bd-set' }, h('span', null, 'Set link or code'), h('span', { class: 'hint' }, 'Optional: only codes from this set are counted.'), setIn),
    h('div', { class: 'row' }, button('Analyse', { kind: 'primary', type: 'submit' }), h('span', { class: 'small muted' }, 'Everything here stays on this device.')));
  form.addEventListener('submit', (e) => { e.preventDefault(); analyse(); });

  const main = h('main', { class: 'page stack-lg bd', 'data-view': 'board' },
    h('div', { class: 'stack-sm' },
      h('h1', null, 'Class board'),
      h('p', { class: 'lede' }, 'Paste the result codes your class sent back to see what they got wrong and what to reteach.'),
      h('p', { class: 'small' }, h('a', { href: href('/teacher') }, '← For teachers'))),
    form, results);
  el.append(main);

  function analyse() {
    const setCode = codeFromText(setIn.value);
    let r;
    try { r = analyzeTokens(text.value, { setCode: setCode || undefined }); } catch (e) {
      console.error(e);
      results.replaceChildren(callout('bad', 'These codes could not be read.', 'Check what you pasted and try again.'));
      return;
    }
    last = r;
    draw(r);
    const valid = r.rows.length;
    announce(`${valid} valid code${valid === 1 ? '' : 's'}${r.invalid.length ? `, ${r.invalid.length} line${r.invalid.length === 1 ? '' : 's'} not read` : ''}.`);
  }

  function draw(r) {
    const c = r.completion;
    const found = r.rows.length + r.invalid.length;
    const heading = h('h2', { id: 'bd-res-h', tabindex: '-1' }, 'Results');
    replace(results,
      h('section', { class: 'stack', 'aria-labelledby': 'bd-res-h' },
        heading,
        r.setError ? callout('bad', 'That set link did not work, so every set is counted.', r.setError) : null,
        r.set ? h('p', { class: 'small muted' }, `Only codes from set ${r.set.code} (${r.set.n} questions, ${MODE_TEXT[r.set.mode] || r.set.mode}) are counted.`) : null,
        h('div', { class: 'row bd-tiles' },
          tile(found, 'codes found'),
          tile(r.rows.length, 'valid'),
          tile(c.duplicates, 'duplicates'),
          tile(pct(r.meanScore), 'mean first-attempt score'),
          r.set && c.finished !== null ? tile(`${c.finished}/${r.rows.length}`, `did all ${c.expected}`) : null),
        c.duplicates ? h('p', { class: 'small muted' }, 'Duplicates are still counted: two learners with the same results get the same code.') : null,
        c.sets.length > 1 && !r.set ? h('p', { class: 'small muted' }, `These codes come from ${c.sets.length} different sets. Add the set link above to count one set only.`) : null,
        r.rows.length ? null : h('p', null, 'No valid result codes yet.')),
      r.rows.length ? tagsSection(r) : null,
      r.study ? studySection(r.study) : null,
      r.rows.length ? rowsSection(r) : null,
      r.invalid.length ? invalidSection(r) : null,
      found ? h('div', { class: 'row' },
        button('Download CSV', { onClick: () => { download('board.csv', toCsv(last), 'text/csv'); announce('CSV downloaded.'); } }),
        h('span', { class: 'small muted' }, 'A spreadsheet of every row, made on this device.')) : null);
    focus(heading);
  }
}

// ---------------------------------------------------------------- misconceptions
// 'other' means "wrong, but no named misconception": it is a count, not a misconception to reteach
const isUnclassified = (t) => !!t.unclassified || t.tag === 'other' || !t.tag;
function tagsSection(r) {
  const list = r.tagCounts.filter((t) => !isUnclassified(t));
  const unclassified = r.tagCounts.filter(isUnclassified).reduce((n, t) => Math.max(n, t.count), 0);
  return h('section', { class: 'stack', 'aria-labelledby': 'bd-tags-h' },
    h('h2', { id: 'bd-tags-h' }, 'What the class got wrong'),
    list.length
      ? h('ul', { class: 'bd-bars' }, list.map((t) => h('li', { class: 'bd-bar' },
        h('div', { class: 'bd-bar-head' },
          h('span', { class: 'bd-bar-label' }, t.label),
          h('span', { class: 'bd-bar-count' }, `${t.count} of ${t.of}`)),
        h('div', { class: 'bd-track', 'aria-hidden': 'true' }, h('div', { class: 'bd-fill', style: { width: `${Math.max(2, Math.round((t.count / Math.max(1, t.of)) * 100))}%` } })),
        TAGS[t.tag]?.fix ? h('p', { class: 'small muted' }, TAGS[t.tag].fix) : null,
        TAGS[t.tag]?.worked ? button('Project a worked example', { small: true, onClick: (e) => openWorked(t.tag, e.currentTarget) }) : null)))
      : h('p', null, unclassified ? 'No named misconceptions came up in these codes.' : 'No misconceptions came up in these codes.'),
    unclassified ? h('p', { class: 'bd-unclassified' }, `Unclassified mistakes — ${unclassified}`,
      h('span', { class: 'small muted' }, ` (codes with a wrong answer that matched no named misconception, out of ${r.rows.length})`)) : null,
    h('p', { class: 'small muted' }, 'Each code lists up to three kinds of mistake from first attempts. A count is how many codes list it.'));
}

// ---------------------------------------------------------------- rows
const groupsText = (x, prefix) => (x.mode === 'normal'
  ? `${prefix ? 'drill ' : ''}${x.g1.right}/${x.g1.total} · ${prefix ? 'holdout ' : ''}${x.g2.right}/${x.g2.total}`
  : `${prefix ? 'A ' : ''}${x.g1.right}/${x.g1.total} · ${prefix ? 'B ' : ''}${x.g2.right}/${x.g2.total}`);
function rowsSection(r) {
  const study = r.rows.some((x) => x.mode !== 'normal');
  // normal rows hold drill · holdout, study rows A · B: when both are pasted, each cell says which
  const mixed = study && r.rows.some((x) => x.mode === 'normal');
  const shown = r.rows.slice(0, SHOW_MAX);
  return h('section', { class: 'stack-sm', 'aria-labelledby': 'bd-rows-h' },
    h('h2', { id: 'bd-rows-h' }, 'Every code'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table bd-rows' },
      h('thead', null, h('tr', null,
        h('th', null, 'Line'), h('th', null, 'Code'), h('th', null, 'Set'), h('th', null, 'Score'),
        h('th', null, mixed ? 'Groups' : study ? 'A · B' : 'Drill · Holdout'),
        study ? h('th', null, 'Full feedback on') : null,
        h('th', null, 'Misconceptions'), h('th', null, 'Note'))),
      h('tbody', null, shown.map((x) => h('tr', null,
        h('td', null, String(x.line)),
        h('td', { class: 'mono' }, x.code),
        h('td', { class: 'mono' }, `${x.setId}${x.mode !== 'normal' ? ` ${MODE_TEXT[x.mode]}` : ''}`),
        h('td', null, x.total ? `${x.right}/${x.total} (${pct(x.score)})` : '—'),
        h('td', { class: 'mono' }, groupsText(x, mixed)),
        study ? h('td', null, ARM_TEXT[x.arm] || '—') : null,
        h('td', null, x.tags.length ? x.tags.map(tagLabel).join('; ') : '—'),
        h('td', { class: 'small' }, x.dupOf !== null ? `Same as line ${x.dupOf}` : '')))))),
    capNote(shown.length, r.rows.length));
}

function invalidSection(r) {
  return h('section', { class: 'stack-sm', 'aria-labelledby': 'bd-bad-h' },
    h('h2', { id: 'bd-bad-h' }, `Not counted (${r.invalid.length})`),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table bd-invalid' },
      h('thead', null, h('tr', null, h('th', null, 'Line'), h('th', null, 'What was pasted'), h('th', null, 'Why'))),
      h('tbody', null, r.invalid.slice(0, SHOW_MAX).map((x) => h('tr', null,
        h('td', null, String(x.line)), h('td', { class: 'mono bd-cut', title: x.text }, x.text), h('td', null, x.error)))))),
    capNote(Math.min(SHOW_MAX, r.invalid.length), r.invalid.length),
    h('p', { class: 'small muted' }, 'Ask these learners to copy their code again: every code has a check, so a typo is never counted as someone else\'s result.'));
}

// ---------------------------------------------------------------- study
function studySection(s) {
  return h('section', { class: 'panel stack bd-study', 'aria-labelledby': 'bd-study-h' },
    h('h2', { id: 'bd-study-h' }, 'Study: full feedback vs answer only'),
    h('p', { class: 'small' }, 'Each learner was put in one of two groups at random, and never saw which. Arm 0 got full feedback on addition (A) and only the answer on shifts (B); arm 1 the other way round. The CSV uses the same arm numbers.'),
    s.study ? blockEl('Practice set (study)', s.study, 'Full feedback minus answer only: ') : null,
    s.delayed ? blockEl('A week later (delayed)', s.delayed, 'Topic that had full feedback minus topic that had the answer only: ') : null,
    h('p', { class: 'small muted' }, 'Pre-registered rule, set before any data: effect size (dz) ≥ 0.3 invest in the drill-down · < 0.1 stop · between: replicate with another class.'));
}

const READING = {
  invest: 'Invest in the drill-down: full feedback made a worthwhile difference.',
  stop: 'Stop: full feedback made little or no difference here.',
  replicate: 'Replicate: the effect is in between, so run it again with another class.',
};
const NO_INTERVAL = {
  tooFew: 'No interval: too few learners answered both topics.',
  noSpread: 'No interval: every learner\'s difference was the same, so the spread cannot be estimated.',
  oneArm: 'No interval: all codes come from one group, so feedback and topic cannot be told apart.',
};

function blockEl(title, b, diffLabel) {
  const d = b.diff;
  let reading;
  if (!d) reading = 'No learner answered both topics yet.';
  else if (d.noInterval) reading = NO_INTERVAL[d.noInterval] || 'No interval.';
  else if (d.reading) reading = `Reading: ${READING[d.reading]}`;
  else reading = `No reading yet: fewer than 10 learners (n = ${d.n}). The numbers are shown, but they are too noisy to act on.`;
  return h('div', { class: 'stack-sm bd-block' },
    h('h3', null, title),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table bd-arms' },
      h('thead', null, h('tr', null, h('th', null, 'Group'), h('th', null, 'Learners'), h('th', null, 'A: addition'), h('th', null, 'B: shifts'))),
      h('tbody', null, b.arms.map((a) => h('tr', null,
        h('td', null, a.arm === 0 ? 'Arm 0: full feedback on A' : 'Arm 1: full feedback on B'),
        h('td', null, String(a.n)),
        h('td', null, a.A.total ? `${pct(a.A.acc)} (${a.A.right}/${a.A.total})` : '—'),
        h('td', null, a.B.total ? `${pct(a.B.acc)} (${a.B.right}/${a.B.total})` : '—')))))),
    b.unknownArm ? h('p', { class: 'small muted' }, `${b.unknownArm} code${b.unknownArm === 1 ? '' : 's'} had no group (the learner used another device and skipped the paste), so ${b.unknownArm === 1 ? 'it is' : 'they are'} left out of the comparison.`) : null,
    // with one arm only, the difference mixes feedback with topic difficulty, so it is not shown
    d && d.noInterval !== 'oneArm' ? h('p', { class: 'bd-diff' },
      h('strong', null, diffLabel),
      `${pts(d.mean)} percentage points`,
      d.lo !== null && d.hi !== null ? ` (95% CI ${pts(d.lo)} to ${pts(d.hi)})` : '',
      `, n = ${d.n}`,
      d.dz !== null ? `, dz = ${fix2(d.dz)}` : '',
      '.') : null,
    h('p', { class: ['bd-reading', d?.reading && `bd-reading-${d.reading}`] }, reading));
}

// ---------------------------------------------------------------- worked example overlay
function openWorked(tag, opener) {
  closeWorked();
  const info = TAGS[tag];
  let ex = null;
  try { ex = info.worked(mulberry32(newSeed())); } catch (e) { console.error(e); }
  if (!ex) { announce('No worked example for this one.'); return; }
  const app = document.getElementById('app');
  const top = document.querySelector('.topbar');
  const close = button('Close', { onClick: () => closeWorked() });
  close.append(' ', h('kbd', { class: 'kbd' }, 'Esc'));
  const title = h('h2', { id: 'wx-title', tabindex: '-1' }, ex.title);
  const box = h('div', { class: 'wx', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'wx-title' },
    h('div', { class: 'wx-inner stack' },
      h('div', { class: 'row spread wx-head' },
        h('p', { class: 'chip accent' }, `Worked example · ${info.label}`),
        close),
      title,
      info.fix ? h('p', { class: 'wx-fix' }, info.fix) : null,
      h('ol', { class: 'wx-steps' }, ex.steps.map((s, i) => h('li', { class: 'wx-step' },
        h('span', { class: 'wx-num', 'aria-hidden': 'true' }, String(i + 1)),
        h('div', { class: 'wx-body' },
          h('p', { class: 'wx-sub' }, String(s.subgoal).replace(/^\d+\.\s*/, '')),
          h('p', null, s.text),
          s.layer ? h('div', { class: 'wx-layer' }, renderLayer(s.layer)) : null))))));
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeWorked(); return; }
    if (e.key !== 'Tab') return;
    const items = [...box.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const lastEl = items[items.length - 1];
    const active = document.activeElement;
    if (!items.includes(active)) { e.preventDefault(); (e.shiftKey ? lastEl : first).focus(); }
    else if (e.shiftKey && active === first) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && active === lastEl) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey, true);
  document.body.classList.add('projector', 'wx-open');
  if (app) app.inert = true;
  if (top) top.inert = true;
  document.body.append(box);
  overlay = {
    close() {
      document.removeEventListener('keydown', onKey, true);
      box.remove();
      document.body.classList.remove('projector', 'wx-open');
      if (app) app.inert = false;
      if (top) top.inert = false;
      if (opener && opener.isConnected) focus(opener);
    },
  };
  focus(title);
  announce(`Worked example: ${ex.title}. Press Escape to close.`);
}

function closeWorked() { const o = overlay; overlay = null; o?.close(); }

export function dispose() { closeWorked(); }
