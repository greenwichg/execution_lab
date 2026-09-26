// The Why rail: one explanation layer per click, shallow → deep
// (line → instruction → registers → flags → bit columns → full adder).
// Each layer = a small-caps title, one visual, and at most two sentences.
import { h, svg, prefersReducedMotion } from '../lib/dom.js';
import { button } from './parts.js';

/**
 * renderWhy(el, layers, { level, startOpen, onDepth }) → { destroy, openNext, get depth }
 */
export function renderWhy(el, layers, { level = 'gcse', startOpen = 0, onDepth, firstLabel = 'Why? ↓' } = {}) {
  const rail = h('ol', { class: 'why-rail', 'aria-label': 'Explanation, one layer at a time' });
  const foot = h('div', { class: 'why-foot' });
  const root = h('section', { class: 'why', 'aria-label': 'Why' }, rail, foot);
  el.appendChild(root);
  let opened = 0;

  const more = button(firstLabel, { onClick: () => openNext(true) });
  function update() {
    foot.replaceChildren();
    if (!layers.length) return;
    if (opened < layers.length) {
      more.textContent = opened === 0 ? firstLabel : 'Deeper ↓';
      more.className = opened === 0 ? 'btn' : 'btn small';
      foot.appendChild(more);
    } else {
      foot.appendChild(h('p', { class: 'why-end muted small' }, level === 'gcse' ? "That's the deepest layer for GCSE." : "That's the deepest layer."));
    }
  }
  function openNext(focusIt) {
    if (opened >= layers.length) return;
    const item = layerEl(layers[opened], opened);
    rail.appendChild(item);
    opened++;
    onDepth?.(opened);
    update();
    if (focusIt) {
      const title = item.querySelector('.why-title');
      title?.focus({ preventScroll: true });
      item.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
  }
  for (let i = 0; i < Math.min(startOpen, layers.length); i++) openNext(false);
  update();
  return { destroy() { root.remove(); }, openNext: () => openNext(true), get depth() { return opened; } };
}

function layerEl(L, i) {
  const visual = RENDER[L.kind] ? RENDER[L.kind](L.data || {}, L) : null;
  return h('li', { class: ['why-layer', `why-${L.kind}`], dataset: { kind: L.kind, depth: String(i + 1) } },
    h('h3', { class: 'why-title', tabindex: '-1' }, L.title),
    visual ? h('div', { class: 'why-visual' }, visual) : null,
    (L.say || []).map((s) => h('p', { class: 'why-say' }, s)));
}

/** render one layer on its own (projector, worked examples) */
export function renderLayer(L) { return layerEl(L, 0); }

// ----------------------------------------------------------------- formatting
const toBig = (v) => (typeof v === 'bigint' ? v : typeof v === 'string' ? BigInt(v) : BigInt(Math.trunc(Number(v) || 0)));
function unsignedOf(v, width) { const m = 1n << BigInt(width); return ((toBig(v) % m) + m) % m; }
export function hexOf(v, width) { return `0x${unsignedOf(v, width).toString(16).toUpperCase().padStart(Math.ceil(width / 4), '0')}`; }
export function signedOf(v, width) { const u = unsignedOf(v, width); return u >= 1n << BigInt(width - 1) ? u - (1n << BigInt(width)) : u; }
const REG_NAMES = {
  64: {}, 32: { rax: 'eax', rcx: 'ecx', rdx: 'edx', rsi: 'esi', rdi: 'edi', r8: 'r8d', r9: 'r9d' },
  16: { rax: 'ax', rcx: 'cx', rdx: 'dx', rsi: 'si', rdi: 'di', r8: 'r8w', r9: 'r9w' },
  8: { rax: 'al', rcx: 'cl', rdx: 'dl', rsi: 'sil', rdi: 'dil', r8: 'r8b', r9: 'r9b' },
};
const regVal = (v, width) => [hexOf(v, width), h('span', { class: 'dec' }, String(signedOf(v, width)))];
const bitStr = (bits) => bits.slice().reverse().map((b) => (b === null || b === undefined ? '·' : b)).join('');

// ------------------------------------------------------------------ renderers
const RENDER = {
  text: () => null,

  columns(d) {
    const w = d.w, sub = d.op === '-';
    const base = d.base || 0;                 // register bit number of column 0 (cards show bits 31–24)
    const carries = d.carries || [];
    const lost = !!d.dropped && carries[w] === 1;
    const cols = w + 1;
    const grid = h('div', { class: 'cols-grid', style: { '--cols': String(cols) }, 'aria-hidden': 'true' });
    const cell = (text, cls, col) => h('span', { class: ['c', cls, d.highlight === col && 'hl'] }, text);
    const row = (label, cells, right, cls) => {
      grid.appendChild(h('span', { class: ['c-label', cls] }, label));
      cells.forEach((c) => grid.appendChild(c));
      grid.appendChild(h('span', { class: ['c-right', cls] }, right || ''));
    };
    // bit numbers
    row('', [cell('', 'idx', w), ...range(w).map((i) => cell(String(base + i), 'idx', i))], '', 'idx-row');
    // carries: carries[i] sits above column i; carries[w] above the extra column
    row('carry', [
      cell(carries[w] === 1 ? '1' : '', ['carry', 'out'], w),
      ...range(w).map((i) => cell(carries[i] === 1 ? '1' : '', ['carry', i === 0 && 'cin'], i)),
    ], carries[0] === 1 ? (base ? `from bit ${base - 1}` : sub ? '+1' : '') : '', 'carry-row');
    row('', [cell('', null, w), ...range(w).map((i) => cell(String(d.a[i] ?? ''), 'bit', i))], d.labels?.a, 'a-row');
    row(sub ? '+¬' : '+', [cell('', null, w), ...range(w).map((i) => cell(String(d.b[i] ?? ''), 'bit', i))], d.labels?.b, 'b-row');
    // in a subtraction the dropped carry is not an error: dropping it is what makes a + ¬b + 1 = a − b
    row('', [
      cell(lost ? '1' : carries[w] === 1 && d.result?.length > w ? '1' : '', [lost ? (sub ? 'dropped' : 'lost') : 'bit', 'res'], w),
      ...range(w).map((i) => cell(String(d.result?.[i] ?? ''), ['bit', 'res'], i)),
    ], d.labels?.r, 'r-row');
    const summary = `${d.labels?.a ?? bitStr(d.a)} ${sub ? 'minus' : 'plus'} ${d.labels?.b ?? bitStr(d.b)}${base ? `, bits ${base + w - 1} to ${base}` : ` in ${w} bits`}: result ${bitStr(d.result || [])}${lost ? (sub ? '; the carry out of the top column is dropped, as a subtraction needs' : '; the carry out of the top column is lost') : ''}.`;
    return h('div', { class: 'cols', role: 'img', 'aria-label': summary },
      grid,
      lost && !sub ? h('p', { class: 'cols-note small' }, h('span', { class: 'lost-mark', 'aria-hidden': 'true' }, '1'), ` lost — it was worth ${(2n ** BigInt(base + w)).toLocaleString('en-GB')}, but there is no bit ${base + w} to keep it.`) : null,
      lost && sub ? h('p', { class: 'cols-note small muted' }, `The carry out of bit ${base + w - 1} is dropped — that is exactly what makes a + ¬b + 1 equal a − b.`) : null,
      base ? h('p', { class: 'cols-note small muted' }, `Only the top ${w} bits (${base + w - 1}–${base}) are shown; the carry into bit ${base} comes up from the bits below.`) : null,
      sub ? h('p', { class: 'cols-note small muted' }, base ? 'Subtraction is done as an addition: every bit of the second number is inverted (¬) and 1 is added at bit 0.' : 'Subtraction is done as an addition: invert every bit of the second number (¬) and add 1.') : null);
  },

  column(d) {
    const total = (d.a | 0) + (d.b | 0) + (d.cin | 0);
    const box = (v, cls, label) => h('span', { class: ['eq-box', cls], title: label }, String(v));
    return h('div', { class: 'coleq', role: 'img', 'aria-label': `Column ${d.k}: ${d.a} plus ${d.b} plus a carry of ${d.cin} is ${total}, which is ${d.cout}${d.sum} in binary: write ${d.sum}, carry ${d.cout}.` },
      h('div', { class: 'eq', 'aria-hidden': 'true' },
        box(d.a, 'in', 'bit of the first number'), h('span', { class: 'eq-op' }, '+'),
        box(d.b, 'in', 'bit of the second number'), h('span', { class: 'eq-op' }, '+'),
        box(d.cin, 'cin', 'carry in'), h('span', { class: 'eq-op' }, '='),
        h('span', { class: 'eq-total' }, String(total)), h('span', { class: 'eq-op' }, '='),
        h('span', { class: 'eq-bin' }, box(d.cout, 'cout', 'carry out'), box(d.sum, 'sum', 'sum bit'), h('sub', null, '2'))),
      h('p', { class: 'eq-legend small', 'aria-hidden': 'true' }, 'carry in', h('span', { class: 'sep' }, '·'), `write ${d.sum}`, h('span', { class: 'sep' }, '·'), `carry ${d.cout}`));
  },

  adder(d) { return fullAdder(d); },

  shift(d) {
    const w = d.w;
    const lost = new Set(d.lost || []);
    const fills = new Set();
    for (let j = 0; j < d.k; j++) fills.add(d.dir === 'L' ? j : w - 1 - j);
    const rowEl = (label, bits, mark) => h('div', { class: 'sh-row' },
      h('span', { class: 'sh-label' }, label),
      h('span', { class: 'sh-bits' }, range(w).map((i) => h('span', { class: ['c', 'bit', mark(i)] }, String(bits[i] ?? '')))));
    const lostBits = [...lost].sort((x, y) => y - x).map((i) => d.before[i]);
    return h('div', { class: 'shift-vis', role: 'img', 'aria-label': `Before ${bitStr(d.before)}, shifted ${d.dir === 'L' ? 'left' : 'right'} ${d.k}: after ${bitStr(d.after)}${lostBits.length ? `; lost bits ${lostBits.join(' ')}` : ''}.` },
      rowEl('before', d.before, (i) => lost.has(i) && 'lost'),
      h('div', { class: 'sh-arrow', 'aria-hidden': 'true' }, d.dir === 'L' ? `← shift left ${d.k}` : `shift right ${d.k} →`),
      rowEl('after', d.after, (i) => fills.has(i) && 'fill'),
      h('p', { class: 'small muted', 'aria-hidden': 'true' },
        lostBits.length ? ['Fell off the end: ', h('span', { class: 'lost-mark' }, lostBits.join(' ')), '. '] : 'Nothing fell off. ',
        d.k ? `New bits (outlined) are ${d.fill}.` : ''));
  },

  twos(d) {
    return h('div', { class: 'twos-vis' }, (d.steps || []).map((s) => h('div', { class: 'sh-row' },
      h('span', { class: 'sh-label wide' }, s.label),
      h('span', { class: 'sh-bits' }, range(d.w).map((i) => h('span', { class: ['c', 'bit', i === d.w - 1 && 'msb'] }, String(s.bits[i] ?? '')))))));
  },

  flags(d) {
    const names = ['CF', 'ZF', 'SF', 'OF'].filter((n) => d[n] === 0 || d[n] === 1);
    const LONG = { CF: 'carry flag', ZF: 'zero flag', SF: 'sign flag', OF: 'overflow flag' };
    return h('div', { class: 'flags-vis' }, names.map((n) => h('div', { class: ['flag-tile', d[n] ? 'on' : 'off'] },
      h('div', { class: 'flag-head' }, h('abbr', { title: LONG[n] }, n), h('span', { class: 'flag-val' }, ` = ${d[n]}`)),
      d.why?.[n] ? h('p', { class: 'small' }, d.why[n]) : null)));
  },

  regs(d) {
    const width = d.width || 32;
    const names = Object.keys(d.after || d.before || {});
    const changed = new Set(d.changed || []);
    const show = names.filter((n) => changed.has(n) || names.length <= 4);
    const map = REG_NAMES[width] || {};
    return h('div', { class: 'table-wrap' }, h('table', { class: 'table regs' },
      h('thead', null, h('tr', null, h('th', null, 'Register'), h('th', null, 'Before'), h('th', null, 'After'))),
      h('tbody', null, (show.length ? show : names).map((n) => h('tr', { class: changed.has(n) && 'changed' },
        h('td', { class: 'mono' }, changed.has(n) ? '▶ ' : '', map[n] || n),
        h('td', { class: 'mono' }, d.before ? regVal(d.before[n], width) : ''),
        h('td', { class: 'mono' }, d.after ? regVal(d.after[n], width) : ''))))));
  },

  asm(d) {
    return h('div', { class: 'table-wrap' }, h('table', { class: 'table asm' },
      h('thead', null, h('tr', null, h('th', null, 'Address'), h('th', null, 'Bytes'), h('th', null, 'Instruction'))),
      h('tbody', null, (d.rows || []).map((r) => h('tr', { class: r.hot && 'hot' },
        h('td', { class: 'mono' }, typeof r.addr === 'number' ? `0x${r.addr.toString(16)}` : r.addr ?? ''),
        h('td', { class: 'mono bytes' }, r.bytes),
        h('td', { class: 'mono' }, r.hot ? h('span', { class: 'hot-mark', 'aria-label': 'this instruction' }, '▶ ') : null, r.text))))),
      d.note ? h('p', { class: 'small muted' }, d.note) : null);
  },

  line(d) {
    const lines = String(d.src || '').split('\n');
    return h('div', null,
      h('pre', { class: 'code src-lines' }, lines.map((t, i) => h('span', { class: ['src-line', i + 1 === d.line && 'focus'] },
        h('span', { class: 'ln', 'aria-hidden': 'true' }, String(i + 1).padStart(2, ' ')), ' ', t || ' ', '\n'))),
      d.note ? h('p', { class: 'small' }, d.note) : null);
  },
};

function range(w) { const a = []; for (let i = w - 1; i >= 0; i--) a.push(i); return a; }

// ---------------------------------------------------------------- full adder
// XOR(A,B)=x1 · XOR(x1,Cin)=Sum · AND(A,B)=a1 · AND(x1,Cin)=a2 · OR(a1,a2)=Cout
function fullAdder(d) {
  const v = { a: +d.a, b: +d.b, cin: +d.cin, x1: +d.x1, a1: +d.a1, a2: +d.a2, sum: +d.sum, cout: +d.cout };
  const wire = (val, points) => svg('polyline', { class: ['wire', val ? 'w1' : 'w0'], points: points.map((p) => p.join(',')).join(' ') });
  const dot = (val, x, y) => svg('circle', { class: ['junction', val ? 'w1' : 'w0'], cx: x, cy: y, r: 3.5 });
  const label = (x, y, text, cls) => svg('text', { x, y, class: ['lbl', cls] }, text);
  const tag = (x, y, name, val) => svg('text', { x, y, class: ['wtag', val ? 'on' : 'off'] }, `${name} = ${val}`);
  const AND = (cx, cy, hh) => { const x0 = cx - 22; return svg('path', { class: 'gate', d: `M ${x0} ${cy - hh} H ${cx} A ${hh} ${hh} 0 0 1 ${cx} ${cy + hh} H ${x0} Z` }); };
  const OR = (cx, cy, hh) => { const x0 = cx - 22; return svg('path', { class: 'gate', d: `M ${x0} ${cy - hh} Q ${x0 + 12} ${cy} ${x0} ${cy + hh} Q ${cx + 10} ${cy + hh} ${cx + 26} ${cy} Q ${cx + 10} ${cy - hh} ${x0} ${cy - hh} Z` }); };
  const XOR = (cx, cy, hh) => svg('g', null, OR(cx, cy, hh), svg('path', { class: 'gate-back', d: `M ${cx - 29} ${cy - hh} Q ${cx - 17} ${cy} ${cx - 29} ${cy + hh}` }));
  const name = (cx, cy, text) => svg('text', { x: cx - 4, y: cy + 4, class: 'gname', 'text-anchor': 'middle' }, text);

  const summary = `Full adder with A = ${v.a}, B = ${v.b}, carry in = ${v.cin}. The first XOR gives ${v.x1}; the second XOR gives the sum ${v.sum}. The AND gates give ${v.a1} and ${v.a2}; the OR gate gives carry out ${v.cout}.`;
  return svg('svg', { class: 'adder-svg', viewBox: '0 0 700 240', role: 'img', 'aria-label': summary },
    svg('title', null, summary),
    // wires first (gates draw over their ends)
    wire(v.a, [[70, 50], [182, 50]]), wire(v.a, [[120, 50], [120, 135], [178, 135]]),
    wire(v.b, [[70, 90], [182, 90]]), wire(v.b, [[140, 90], [140, 165], [178, 165]]),
    wire(v.x1, [[226, 70], [300, 70], [300, 75], [372, 75]]), wire(v.x1, [[300, 75], [300, 178], [368, 178]]),
    wire(v.cin, [[70, 215], [330, 215], [330, 202], [368, 202]]), wire(v.cin, [[330, 202], [330, 105], [372, 105]]),
    wire(v.a1, [[222, 150], [450, 150], [450, 160], [492, 160]]),
    wire(v.a2, [[412, 190], [460, 190], [460, 180], [492, 180]]),
    wire(v.sum, [[416, 90], [600, 90]]),
    wire(v.cout, [[536, 170], [600, 170]]),
    dot(v.a, 120, 50), dot(v.b, 140, 90), dot(v.x1, 300, 75), dot(v.cin, 330, 202),
    // gates
    XOR(200, 70, 28), name(200, 70, 'XOR'),
    AND(200, 150, 22), name(196, 150, 'AND'),
    XOR(390, 90, 28), name(390, 90, 'XOR'),
    AND(390, 190, 22), name(386, 190, 'AND'),
    OR(510, 170, 22), name(512, 170, 'OR'),
    // labels
    label(8, 55, `A = ${v.a}`, 'in'), label(8, 95, `B = ${v.b}`, 'in'), label(8, 220, `Cin = ${v.cin}`, 'in'),
    tag(232, 62, 'x1', v.x1), tag(232, 144, 'a1', v.a1), tag(418, 183, 'a2', v.a2),
    label(608, 95, `Sum = ${v.sum}`, 'out'), label(608, 175, `Cout = ${v.cout}`, 'out'));
}
