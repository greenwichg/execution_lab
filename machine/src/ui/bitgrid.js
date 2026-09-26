// Bit entry: rows of one-digit cells that behave like squared paper.
// Typing 0/1 fills a cell and moves on — LEFT in an addition, because you add
// right to left. Arrows move, Backspace clears and steps back, Tab leaves.
// After marking, cells lock and show ✓/✗, with the right digit under a wrong one.
import { h } from '../lib/dom.js';
import { statusGlyph } from './parts.js';

/**
 * A row of w bit inputs bound to an LSB-first array.
 * opts: { values (array, mutated), label, dir: 'left'|'right' (typing direction),
 *         optionalIndex, onChange, cellLabel(i) }
 * Returns { el, cells (index → input), focusStart(), lock(statuses, key) }.
 */
export function bitRow(w, opts = {}) {
  const values = opts.values || new Array(w).fill(null);
  const cells = new Array(w);
  const el = h('div', { class: 'bitrow', role: 'group', 'aria-label': opts.label || 'Bits' });
  for (let i = w - 1; i >= 0; i--) {
    const input = bitInput({
      label: opts.cellLabel ? opts.cellLabel(i) : `${opts.label || 'Bit'} ${i}`,
      value: values[i],
      optional: opts.optionalIndex === i,
      onSet: (v) => { values[i] = v; opts.onChange?.(i, v); },
      onMove: (step) => move(i, step),
    });
    cells[i] = input;
    el.appendChild(input.wrap);
  }
  // step: +1 = towards the next cell in typing order; -1 = back
  function move(i, step) {
    const leftward = (opts.dir || 'right') === 'left';
    const delta = (leftward ? 1 : -1) * step;          // bit index delta (higher index = further left)
    let j = i + delta;
    while (j >= 0 && j < w && cells[j].input.readOnly) j += delta;
    if (j >= 0 && j < w) cells[j].input.focus();
  }
  rovingTabs(el, cells[(opts.dir || 'right') === 'left' ? 0 : w - 1]?.input);
  return {
    el, cells, values,
    focusStart() { const start = (opts.dir || 'right') === 'left' ? 0 : w - 1; cells[start]?.input.focus(); },
    lock(statuses, key) { cells.forEach((c, i) => c.lock(statuses?.[i] ?? null, key?.[i])); },
  };
}

/**
 * One cell. Arrow keys are handled by the caller through onMove(step) for
 * typing order, and by data attributes for spatial moves in the grid.
 */
export function bitInput({ label, value = null, optional = false, onSet, onMove, small = false }) {
  const input = h('input', {
    type: 'text', inputmode: 'numeric', maxlength: '1', autocomplete: 'off', spellcheck: 'false',
    class: ['bit-in', small && 'small', optional && 'optional'], 'aria-label': label,
    value: value === null || value === undefined ? '' : String(value),
  });
  const under = h('span', { class: 'bit-under', 'aria-hidden': 'true' });
  const glyph = h('span', { class: 'bit-glyph' });
  const wrap = h('span', { class: ['bit-cell', small && 'small', optional && 'optional'] }, input, glyph, under);
  const set = (v) => { input.value = v === null ? '' : String(v); onSet?.(v); };
  input.addEventListener('keydown', (e) => {
    if (input.readOnly) return;
    if (e.key === '0' || e.key === '1') { e.preventDefault(); set(+e.key); onMove?.(1); }
    else if (e.key === 'Backspace') { e.preventDefault(); if (input.value) set(null); else onMove?.(-1); }
    else if (e.key === 'Delete' || e.key === ' ') { e.preventDefault(); set(null); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      wrap.dispatchEvent(new CustomEvent('bitnav', { bubbles: true, detail: { dx: e.key === 'ArrowLeft' ? -1 : 1, dy: 0, from: input } }));
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      wrap.dispatchEvent(new CustomEvent('bitnav', { bubbles: true, detail: { dx: 0, dy: e.key === 'ArrowUp' ? -1 : 1, from: input } }));
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) e.preventDefault();
  });
  // phones send text through input events (keydown key is often 'Unidentified')
  input.addEventListener('input', () => {
    const ch = input.value.replace(/[^01]/g, '').slice(-1);
    if (ch) { set(+ch); onMove?.(1); } else set(null);
  });
  input.addEventListener('focus', () => input.select());
  return {
    input, wrap,
    lock(status, correct) {
      input.readOnly = true;
      input.setAttribute('aria-readonly', 'true');
      wrap.classList.add('locked');
      if (!status) return;
      wrap.classList.add(`st-${status}`);
      glyph.replaceChildren(statusGlyph(status === 'extra' ? 'bad' : status));
      if ((status === 'bad' || status === 'missing' || status === 'extra') && correct !== undefined) {
        under.textContent = correct === null ? '—' : String(correct);
        input.setAttribute('aria-label', `${label}: ${status === 'missing' ? 'not answered' : 'incorrect'}, should be ${correct === null ? 'empty' : correct}`);
      } else if (status === 'ok') input.setAttribute('aria-label', `${label}: correct`);
    },
  };
}

/**
 * One tab stop per group of cells (a "roving" tabindex): Tab enters at the
 * last cell used (initially `first`) and Tab again leaves; arrows move inside.
 */
export function rovingTabs(container, first) {
  const cells = () => [...container.querySelectorAll('input.bit-in')];
  const make = (cur) => cells().forEach((c) => { c.tabIndex = c === cur ? 0 : -1; });
  make(first);
  container.addEventListener('focusin', (e) => { if (e.target.matches?.('input.bit-in')) make(e.target); });
}

/**
 * Spatial arrow navigation inside a container: cells are found by their
 * rendered position, so any grid layout works.
 */
export function enableGridNav(container) {
  container.addEventListener('bitnav', (e) => {
    const { dx, dy, from } = e.detail;
    const all = [...container.querySelectorAll('input.bit-in')];
    const r0 = from.getBoundingClientRect();
    const cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
    let best = null, bestD = Infinity;
    for (const el of all) {
      if (el === from) continue;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const ddx = x - cx, ddy = y - cy;
      if (dx && Math.sign(ddx) !== dx) continue;
      if (dy && Math.sign(ddy) !== dy) continue;
      const d = dx ? Math.abs(ddx) + Math.abs(ddy) * 3 : Math.abs(ddy) + Math.abs(ddx) * 3;
      if ((dx && Math.abs(ddx) < 4) || (dy && Math.abs(ddy) < 4)) continue;
      if (d < bestD) { bestD = d; best = el; }
    }
    best?.focus();
  });
}

/**
 * The exam-style addition grid for add / sadd items.
 * item.show: { w, a, b, op, ask, aValue?, bValue? }.
 * answer: the item's Answer; carriesField / resultField: field ids ('carries', 'result' | 'bits').
 * Returns { el, focusStart(), lock(marking), showValues() }.
 */
export function addGrid(item, answer, { carriesField = 'carries', resultField = 'result', onChange, projector = false } = {}) {
  const { w } = item.show;
  const asksCarries = item.fields.some((f) => f.id === carriesField);
  const resultSpec = item.fields.find((f) => f.id === resultField);
  const extra = resultSpec && resultSpec.optionalIndex === w;
  const cols = w + 1;
  const grid = h('div', { class: ['addgrid', projector && 'projector'], style: { '--cols': String(cols) } });
  const place = (el, col, row, cls) => { el.style.gridColumn = String(col); el.style.gridRow = String(row); if (cls) el.classList.add(cls); grid.appendChild(el); return el; };
  // grid column for bit i: bits run MSB (left) → LSB (right); column 1 is the label
  const colOf = (i) => 2 + (w - i);         // i = w is the extra left column
  // row 1: bit numbers
  for (let i = w - 1; i >= 0; i--) place(h('span', { class: 'ag-idx', 'aria-hidden': 'true' }, String(i)), colOf(i), 1);
  place(h('span', { class: 'ag-label small muted' }, asksCarries ? 'carry' : ''), 1, 2);
  // row 2: carries (carry INTO column i sits above column i; carries[w] above the extra column)
  const carryCells = [];
  if (asksCarries) {
    for (let i = w; i >= 1; i--) {
      const c = bitInput({
        label: i === w ? `Carry out of bit ${w - 1}` : `Carry into bit ${i}`,
        value: answer[carriesField][i], small: true,
        onSet: (v) => { answer[carriesField][i] = v; onChange?.(); },
        // typed the carry into column i → next is result bit i; back → result bit i − 1
        onMove: (step) => focusCol('result', step > 0 ? i : i - 1),
      });
      carryCells[i] = c;
      place(c.wrap, colOf(i), 2, 'ag-carry');
    }
  }
  // rows 3–4: operands
  const digitRow = (bits, row, label, valueLabel) => {
    place(h('span', { class: 'ag-label ag-op', 'aria-hidden': 'true' }, label), 1, row);
    for (let i = w - 1; i >= 0; i--) place(h('span', { class: 'ag-digit' }, String(bits[i])), colOf(i), row);
    return place(h('span', { class: 'ag-value muted', 'aria-hidden': 'true' }, valueLabel ?? ''), cols + 2, row);
  };
  const sub = item.show.op === '-';
  const aVal = digitRow(item.show.a, 3, '', '');
  const bVal = digitRow(item.show.b, 4, sub ? '−' : '+', '');
  // row 5: the result
  place(h('span', { class: 'ag-label', 'aria-hidden': 'true' }, '='), 1, 5);
  const resultCells = [];
  for (let i = w - 1; i >= 0; i--) {
    const c = bitInput({
      label: `Result bit ${i}`, value: answer[resultField][i],
      onSet: (v) => { answer[resultField][i] = v; onChange?.(); },
      // typed result bit i → next is the carry it makes (into i + 1); back → the carry into i
      onMove: (step) => (step > 0
        ? focusCol(asksCarries ? 'carry' : 'result', i + 1)
        : focusCol(asksCarries && i >= 1 ? 'carry' : 'result', asksCarries && i >= 1 ? i : i - 1)),
    });
    resultCells[i] = c;
    place(c.wrap, colOf(i), 5, 'ag-res');
  }
  if (extra) {
    const c = bitInput({ label: `Extra bit ${w} (leave empty if the answer fits in ${w} bits)`, value: answer[resultField][w], optional: true, onSet: (v) => { answer[resultField][w] = v; onChange?.(); } });
    resultCells[w] = c;
    place(c.wrap, colOf(w), 5, 'ag-res');
  }
  const rVal = place(h('span', { class: 'ag-value muted', 'aria-hidden': 'true' }), cols + 2, 5);
  place(h('span', { class: 'ag-rule', 'aria-hidden': 'true' }), `2 / ${cols + 2}`, 5);
  // typing order: result bit i, then the carry into i+1, then result bit i+1 …
  function focusCol(kind, i) {
    if (kind === 'carry') { if (i >= 1 && i <= w && carryCells[i]) carryCells[i].input.focus(); return; }
    if (i >= 0 && i < w) resultCells[i].input.focus();
  }
  enableGridNav(grid);
  rovingTabs(grid, resultCells[0].input);         // one tab stop: enter at bit 0, where you start adding
  const summary = h('p', { class: 'visually-hidden' }, `${item.show.op === '-' ? 'Subtract' : 'Add'} ${bitsMsb(item.show.a)} ${item.show.op === '-' ? 'minus' : 'plus'} ${bitsMsb(item.show.b)}. Type the result from bit 0 (the right-hand end)${asksCarries ? ', and each carry above the column it goes into' : ''}.`);
  const hint = h('p', { class: 'grid-hint small muted' }, asksCarries
    ? 'Type 0 or 1, starting at the right. After each bit the cursor jumps to the carry it makes — type 1, or 0 for no carry. Arrow keys move around.'
    : 'Type 0 or 1, starting at the right; the cursor moves left. Arrow keys move around.');
  const el = h('div', { class: 'addgrid-block' }, h('div', { class: 'addgrid-wrap' }, summary, grid), hint);
  return {
    el,
    focusStart() { resultCells[0].input.focus(); },
    focusResult(i) { (resultCells[i] || resultCells[0]).input.focus(); },
    lock(marking, key) {
      const cm = marking.cells[carriesField] || [];
      const rm = marking.cells[resultField] || [];
      if (asksCarries) for (let i = 1; i <= w; i++) carryCells[i].lock(cm[i] ?? null, key[carriesField]?.[i] ?? 0);
      for (let i = 0; i < w; i++) resultCells[i].lock(rm[i] ?? null, key[resultField]?.[i]);
      if (extra) resultCells[w].lock(rm[w] === 'extra' ? 'extra' : null, null);
    },
    showValues(labels) {
      aVal.textContent = labels?.a ?? '';
      bVal.textContent = labels?.b ?? '';
      rVal.textContent = labels?.r ?? '';
    },
  };
}

const bitsMsb = (bits) => bits.slice().reverse().join('');
