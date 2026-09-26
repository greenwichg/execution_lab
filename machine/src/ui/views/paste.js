// Paste your own C: write a short program, predict what it prints, run it on
// the lab's compiler + x86-64 emulator. A wrong prediction runs the bisection
// checkpoints (≤ 3) to find the first write where the learner's model and the
// machine part ways, then the diagnosis and the Why rail for that statement.
import { h, announce, focus, shareUrl } from '../../lib/dom.js';
import { load, save } from '../../lib/store.js';
import { LIMITS } from '../../engine/minic.js';
import { analyzePaste, markOutput, diagnosePaste, whyPaste, normOutput } from '../../learn/paste.js';
import { TAGS } from '../../learn/catalogue.js';
import { button, confidence, callout, copyBox, statusGlyph } from '../parts.js';
import { checkpointInput, sameValue } from '../runner.js';
import { renderWhy } from '../why.js';
import { highlightC } from '../code.js';
import { setNav } from '../nav.js';

export const SHARE_MAX = 4000;          // characters of base64url in a share link
const CODE_KEY = 'paste.code';

export const EXAMPLES = [
  { title: 'Unsigned 2 minus 15', code: 'int a = 5;\nint b = a * 3;\nunsigned u = 2;\nu = u - b;\nprintf("%u\\n", u);' },
  { title: 'A byte that counts past 255', code: 'unsigned char c = 250;\nint n = 0;\nfor (int i = 0; i < 8; i++) {\n  c = c + 1;\n  n = n + c;\n}\nprintf("%d %d\\n", c, n);' },
  { title: 'A total that overflows', code: 'int x = 2147483600;\nfor (int i = 0; i < 5; i++)\n  x = x + 20;\nprintf("%d\\n", x);' },
  { title: 'Storing 160 in a char', code: 'int t = 100;\nint k = t + 60;\nchar c = k;\nint d = c / 2;\nprintf("%d\\n", d);' },
  { title: 'Dividing a negative number', code: 'int s = 0;\nfor (int i = 1; i <= 6; i++) {\n  s = s + i;\n}\nint q = -s / 4;\nint r = q * 2;\nprintf("%d %d\\n", q, r);' },
  { title: 'Comparing -5 with an unsigned 3', code: 'int a = -5;\nunsigned b = 3;\nint lt = a < b;\nint m = lt + 10;\nprintf("%d\\n", m);' },
  { title: 'Shifting a negative number right', code: 'int total = 0;\nfor (int i = 0; i < 6; i++) {\n  total = total + i * i;\n}\nint h = (total - 100) >> 2;\nprintf("%d\\n", h);' },
];

// ------------------------------------------------------------ share links
/** UTF-8 → base64url (no padding) */
export function encodeCode(code) {
  const bytes = new TextEncoder().encode(String(code));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url → code, or null for anything malformed (the link is untrusted) */
export function decodeCode(text) {
  try {
    const t = String(text ?? '').trim();
    if (!t || t.length > SHARE_MAX || !/^[A-Za-z0-9_-]+$/.test(t) || t.length % 4 === 1) return null;
    const b64 = t.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((t.length + 3) % 4);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const code = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // keep printable text, tabs and newlines only
    return code.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
  } catch { return null; }
}

export function render(el, ctx) {
  setNav('#/cards');
  let notice = null;
  let code = null;
  const fromLink = ctx.query.get('code');
  if (fromLink !== null) {
    code = decodeCode(fromLink);
    notice = code === null
      ? callout('bad', "That share link didn't work.", 'It may have been cut short when it was copied. Your own code is below.')
      : callout(null, null, 'Loaded the program from your link. It stays on this device.');
  }
  if (code === null) {
    const saved = load(CODE_KEY, null);
    code = typeof saved === 'string' && saved.length <= 20000 ? saved : EXAMPLES[0].code;
  }

  // ------------------------------------------------------------ editor
  const gutter = h('div', { class: 'pe-gutter', 'aria-hidden': 'true' });
  const ta = h('textarea', {
    id: 'pe-code', class: 'pe-text', rows: '12', wrap: 'off', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off',
    'aria-describedby': 'pe-help pe-count',
  });
  ta.value = code;
  const count = h('p', { id: 'pe-count', class: 'pe-count small muted', 'aria-live': 'polite' });
  const editor = h('div', { class: 'pe' }, gutter, ta);
  let errLine = null;
  let escaped = false;

  const examples = h('select', { id: 'pe-examples', class: 'pe-examples', 'aria-label': 'Load an example program' },
    h('option', { value: '' }, 'Load an example…'),
    EXAMPLES.map((ex, i) => h('option', { value: String(i) }, ex.title)));

  const predict = h('textarea', { id: 'pe-predict', class: 'pe-predict', rows: '4', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', 'aria-describedby': 'pe-predict-help' });
  let conf = null;
  const confBox = confidence((v) => { conf = v; hint.textContent = ''; });
  const hint = h('p', { class: 'check-hint small muted', role: 'status' });
  const runBtn = button('Run and check', { kind: 'primary', onClick: () => runIt() });
  runBtn.id = 'pe-run';
  const result = h('section', { class: 'paste-result stack', 'aria-label': 'Result' });

  const shareHolder = h('div', { class: 'stack-sm' });
  const shareBtn = button('Make a share link', { small: true, onClick: () => makeShare() });
  shareBtn.id = 'pe-share';

  const main = h('main', { class: 'page stack paste-page', 'data-view': 'paste' },
    h('div', { class: 'stack-sm' },
      h('p', { class: 'chip accent' }, 'C on x86-64'),
      h('h1', null, 'Paste your own C'),
      h('p', { class: 'lede' }, "Write a short program, predict what it prints, then run it on this lab's C compiler and x86-64 emulator. If your prediction is off, we find the first line where your model and the machine part ways.")),
    notice,
    h('div', { class: 'paste-grid' },
      h('div', { class: 'paste-col stack-sm' },
        h('div', { class: 'row spread pe-head' },
          h('label', { for: 'pe-code', class: 'field-label' }, 'Your C program'),
          examples),
        editor,
        count,
        h('p', { id: 'pe-help', class: 'small muted' },
          `Up to ${LIMITS.lines} lines of ${LIMITS.cols} characters. Whole-number types (char, short, int, long, signed or unsigned), arithmetic, bitwise and shift operators, comparisons, if, else, while, for, break, continue and printf with %d %u %x %o %c. Everything runs inside main; no arrays, pointers or other functions. Tab indents; press Esc then Tab to leave the editor.`)),
      h('div', { class: 'paste-col stack-sm' },
        h('label', { for: 'pe-predict', class: 'field-label' }, 'What will it print?'),
        predict,
        h('p', { id: 'pe-predict-help', class: 'small muted' }, 'One line for each line of output. Ctrl + Enter runs.'),
        confBox.el,
        h('div', { class: 'row' }, runBtn, hint))),
    result,
    h('section', { class: 'panel tight stack-sm share-panel', 'aria-labelledby': 'share-h' },
      h('h2', { id: 'share-h', class: 'share-h' }, 'Share this program'),
      h('p', { class: 'small' }, 'The link carries your code after the # in the address, so opening it sends nothing to a server.'),
      shareBtn, shareHolder),
    h('p', { class: 'small muted' }, "Your code is kept on this device only. The answers come from this lab's compiler and emulator, which are checked against gcc -O0 on x86-64."));
  el.append(main);

  // ------------------------------------------------------------ editor behaviour
  function drawGutter() {
    const n = ta.value.split('\n').length;
    const rows = [];
    for (let i = 1; i <= Math.max(n, 1); i++) {
      rows.push(h('span', { class: ['pe-ln', i === errLine && 'err'] }, i === errLine ? `▸${i}` : String(i)));
    }
    gutter.replaceChildren(h('div', { class: 'pe-gutter-inner' }, rows));
    gutter.scrollTop = ta.scrollTop;
    const long = ta.value.split('\n').map((l, i) => ({ i: i + 1, len: l.length })).filter((x) => x.len > LIMITS.cols);
    const parts = [`${n} of ${LIMITS.lines} lines.`];
    if (n > LIMITS.lines) parts.push(`That is ${n - LIMITS.lines} too many.`);
    if (long.length) parts.push(`Line ${long[0].i} is ${long[0].len} characters; the limit is ${LIMITS.cols}.`);
    count.textContent = parts.join(' ');
    count.classList.toggle('over', n > LIMITS.lines || long.length > 0);
  }
  ta.addEventListener('input', () => {
    errLine = null;
    examples.value = '';
    drawGutter();
    save(CODE_KEY, ta.value);
  });
  ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { escaped = true; return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runIt(); return; }
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !escaped && !ta.readOnly) {
      e.preventDefault();
      let done = false;
      try { done = document.execCommand('insertText', false, '  '); } catch { done = false; }
      if (!done) { ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); }
      return;
    }
    escaped = false;
  });
  ta.addEventListener('blur', () => { escaped = false; });
  predict.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runIt(); }
  });
  examples.addEventListener('change', () => {
    const ex = EXAMPLES[Number(examples.value)];
    if (!ex || ta.readOnly) return;
    ta.value = ex.code;
    errLine = null;
    drawGutter();
    save(CODE_KEY, ta.value);
    result.replaceChildren();
    shareHolder.replaceChildren();
    announce(`Loaded the example: ${ex.title}.`);
  });
  drawGutter();

  function makeShare() {
    const enc = encodeCode(ta.value);
    shareHolder.replaceChildren(enc.length > SHARE_MAX
      ? h('p', { class: 'small' }, 'This program is too long to fit in a share link.')
      : copyBox(shareUrl(`/paste?code=${enc}`), { what: 'Share link copied' }));
  }

  // ------------------------------------------------------------ run and check
  let locked = false;
  function lock(on) {
    locked = on;
    ta.readOnly = on;
    predict.readOnly = on;
    examples.disabled = on;
    confBox.setDisabled(on);
    runBtn.hidden = on;
    editor.classList.toggle('locked', on);
  }

  function runIt() {
    if (locked) return;
    const src = ta.value;
    save(CODE_KEY, src);
    if (!conf) {
      hint.textContent = 'First choose how sure you are — it helps you see what you really know.';
      confBox.el.querySelector('button')?.focus();
      return;
    }
    hint.textContent = '';
    let analysis;
    try { analysis = analyzePaste(src); } catch (e) { return showError(e); }
    errLine = null;
    drawGutter();
    lock(true);
    const predicted = predict.value;
    const m = markOutput(analysis.res, predicted);
    result.replaceChildren();
    if (m.correct) return showCorrect(analysis);
    showWrong(analysis, predicted, m);
  }

  function showError(e) {
    const line = Number.isInteger(e?.line) && e.line > 0 ? e.line : null;
    const col = Number.isInteger(e?.col) && e.col > 0 ? e.col : null;
    const where = line ? ` at line ${line}${col ? `, column ${col}` : ''}` : '';
    const isC = e && e.name === 'CError';
    const head = !isC ? "This program couldn't be run." : e.kind === 'runtime' ? `Runtime error${where}.` : `Compile error${where}.`;
    const msg = isC ? `${e.message}.`.replace(/\.\.$/, '.') : 'The compiler stopped unexpectedly. Try a smaller program.';
    errLine = line;
    drawGutter();
    const box = callout('bad', head, msg);
    box.classList.add('pe-error');
    const actions = h('div', { class: 'row' });
    if (line) {
      actions.append(button(`Go to line ${line}`, { small: true, onClick: () => goTo(line, col || 1) }));
    }
    result.replaceChildren(box, line ? h('div', { class: 'pe-error-src' }, highlightC(ta.value, { errorLine: line, focusLine: line, label: 'Your program, with the problem line marked' })) : null, actions);
    announce(`${head} ${msg}`);
    box.setAttribute('tabindex', '-1');
    focus(box);
  }

  function goTo(line, col) {
    const lines = ta.value.split('\n');
    let pos = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
    pos += Math.min(col - 1, (lines[line - 1] || '').length);
    ta.focus();
    ta.setSelectionRange(pos, pos);
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 22;
    ta.scrollTop = Math.max(0, (line - 3) * lh);
  }

  function showCorrect(analysis) {
    const box = callout('ok', 'Correct.', 'Your prediction matches the machine, line for line.');
    result.append(box,
      outputBlock('The machine printed', analysis.res.output),
      h('p', { class: 'small muted' }, "Run on this lab's compiler and x86-64 emulator, which match gcc -O0 on x86-64."),
      againRow());
    announce('Correct.');
    box.setAttribute('tabindex', '-1');
    focus(box);
  }

  function showWrong(analysis, predicted, m) {
    const fw = m.firstWrong ? m.firstWrong.index : 0;
    const head = callout('bad', 'Not quite.', `Your prediction first differs from the machine on output line ${fw + 1}.`);
    result.append(head, compare(predicted, analysis.res.output, m.cells.lines || [], fw));
    announce(`Not quite. Your prediction first differs on output line ${fw + 1}.`);
    head.setAttribute('tabindex', '-1');
    focus(head);
    const cps = [];
    const lines = String(analysis.src).split('\n');
    const step = () => {
      let r = { next: null, diagnosis: null };
      try { r = diagnosePaste(analysis, predicted, cps); } catch (e) { console.error(e); }
      if (r.next && cps.length < 3) return ask(r.next);
      diagnose(r.diagnosis);
    };
    const ask = (cp) => {
      const box = h('div', { class: 'checkpoint panel tight stack-sm' },
        cps.length === 0 ? h('p', { class: 'checkpoint-intro' }, "Let's find where it went wrong.") : null,
        h('p', { class: 'checkpoint-q' }, cp.prompt),
        cp.line && lines[cp.line - 1] !== undefined
          ? h('p', { class: 'cp-line small' }, h('span', { class: 'muted' }, `Line ${cp.line}: `), h('code', null, lines[cp.line - 1].trim()))
          : null);
      let value = null;
      const input = checkpointInput(cp, (v) => { value = v; });
      const go = button('Answer', { kind: 'primary', small: true });
      const skip = button('Not sure', { small: true, kind: 'ghost' });
      box.append(h('div', { class: 'row' }, input.el, go, skip));
      result.append(box);
      let answered = false;
      const submit = (v) => {
        if (answered) return;
        answered = true;
        go.disabled = true; skip.disabled = true; input.disable();
        const right = v !== null && sameValue(v, cp.answer);
        box.append(h('p', { class: ['small', 'cp-result', right ? 'ok' : 'bad'] }, statusGlyph(right ? 'ok' : 'bad'), ' ',
          v === null ? `It's ${String(cp.answer)}.` : right ? 'Right.' : `Not quite — it's ${String(cp.answer)}.`));
        cps.push(v);
        step();
      };
      go.addEventListener('click', () => submit(value));
      skip.addEventListener('click', () => submit(null));
      if (input.el.tagName === 'INPUT') input.el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(value); } });
      input.focus();
    };
    const diagnose = (d) => {
      const diag = d || { tag: 'other', headline: 'Not quite.', detail: 'Compare your prediction with the output line by line.', focus: {} };
      const info = diag.tag && diag.tag !== 'other' && diag.tag !== 'trace_value' ? TAGS[diag.tag] : null;
      const box = callout('bad', diag.headline, diag.detail);
      box.classList.add('diagnosis');
      if (info) box.append(h('p', { class: 'callout-body diag-tag small' }, h('strong', null, 'Common mistake: '), `${info.label}. ${info.fix || ''}`));
      result.append(box);
      let layers = [];
      try { layers = whyPaste(analysis, diag) || []; } catch (e) { console.error(e); }
      if (layers.length) {
        const holder = h('div', { class: 'item-why' });
        result.append(holder);
        renderWhy(holder, layers, { level: 'csapp', startOpen: 0 });
      }
      result.append(againRow());
      box.setAttribute('tabindex', '-1');
      focus(box);
      announce(diag.headline);
    };
    step();
  }

  function againRow() {
    return h('div', { class: 'row item-next' }, button('Edit and run again', {
      kind: 'primary',
      onClick: () => {
        lock(false);
        result.replaceChildren();
        conf = null;
        confBox.value = null;
        ta.focus();
      },
    }));
  }
}

/** a labelled monospace output block, one line per row */
function outputBlock(label, text, { statuses = null, first = -1, glyphs = false } = {}) {
  const norm = normOutput(text);
  const lines = norm === '' ? [] : norm.split('\n');
  const n = statuses ? Math.max(statuses.length, lines.length) : lines.length;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const st = statuses ? statuses[i] : null;
    const has = i < lines.length;
    rows.push(h('span', { class: ['out-line', i === first && 'first-diff', !has && 'empty'] },
      glyphs && st ? h('span', { class: 'out-glyph' }, statusGlyph(st === 'extra' ? 'extra' : st)) : null,
      i === first ? h('span', { class: 'visually-hidden' }, 'First difference: ') : null,
      h('span', { class: 'out-text' }, has ? (lines[i] || ' ') : '(no line)'),
      '\n'));
  }
  if (!n) rows.push(h('span', { class: 'out-line empty' }, h('span', { class: 'out-text' }, '(nothing)')));
  return h('div', { class: 'out-block' },
    h('p', { class: 'out-label small' }, label),
    h('pre', { class: 'code out-pre', tabindex: '0' }, rows));
}

function compare(predicted, output, statuses, first) {
  return h('div', { class: 'compare' },
    outputBlock('You predicted', predicted, { statuses, first, glyphs: true }),
    outputBlock('The machine printed', output, { statuses, first }),
    h('p', { class: 'small muted compare-note' }, h('span', { 'aria-hidden': 'true' }, '▸ '), 'marks the first line that differs.'));
}
