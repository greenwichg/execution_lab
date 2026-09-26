// Check my working: the learner brings their own question (homework, a past
// paper) and their own working; we mark every cell and find the first break.
import { h } from '../../lib/dom.js';
import { makeItem } from '../../learn/items/index.js';
import { button, seg, callout } from '../parts.js';
import { mountItem } from '../runner.js';
import { setNav } from '../nav.js';

const KINDS = [
  { value: 'add', label: 'Binary addition' },
  { value: 'shift', label: 'Binary shift' },
  { value: 'twos', label: "Two's complement" },
];

export function render(el, ctx) {
  let kind = ['add', 'shift', 'twos'].includes(ctx.query.get('kind')) ? ctx.query.get('kind') : 'add';
  let runner = null;
  const formHolder = h('div', { class: 'stack' });
  const itemHolder = h('div');
  const picker = seg(KINDS, { label: 'What kind of question?', value: kind, onChange: (v) => { kind = v; drawForm(); } });
  const main = h('main', { class: 'page page-narrow stack', 'data-view': 'check' },
    h('h1', null, 'Check my working'),
    h('p', { class: 'lede' }, "Type in a question from your homework or a past paper, then your own working. We'll mark every part and show where it first goes wrong."),
    h('div', { class: 'row' }, h('span', { class: 'field-label' }, 'Question type'), picker.el),
    formHolder, itemHolder,
    h('p', { class: 'small muted' }, 'Nothing you type leaves this device.'));
  el.append(main);
  setNav('#/check');
  drawForm();

  function drawForm() {
    runner?.destroy(); runner = null;
    itemHolder.replaceChildren();
    formHolder.replaceChildren();
    const error = h('div');
    const form = h('form', { class: 'panel stack', novalidate: true });
    let read;
    if (kind === 'add') {
      const a = textIn('First number (binary)', '11001000');
      const b = textIn('Second number (binary)', '01000001');
      form.append(a.el, b.el);
      read = () => {
        const A = binary(a.input.value), B = binary(b.input.value);
        if (!A || !B) return 'Type each number in binary, using only 0 and 1 (up to 16 digits).';
        const w = Math.max(4, A.length, B.length);
        return makeItem('add', { w, a: parseInt(A, 2), b: parseInt(B, 2), ask: 'full', level: 'gcse' });
      };
    } else if (kind === 'shift') {
      const x = textIn('The number (binary)', '10110100');
      let dir = 'L', kindS = 'logical';
      const dirSeg = seg([{ value: 'L', label: 'Left' }, { value: 'R', label: 'Right' }], { label: 'Direction', value: dir, onChange: (v) => { dir = v; } });
      const kSeg = seg([{ value: 'logical', label: 'Logical' }, { value: 'arithmetic', label: 'Arithmetic' }], { label: 'Kind of shift', value: kindS, onChange: (v) => { kindS = v; } });
      const places = h('input', { type: 'number', min: '1', max: '15', value: '2', class: 'num-in', 'aria-label': 'Places' });
      form.append(x.el,
        h('div', { class: 'row' }, h('span', { class: 'field-label' }, 'Direction'), dirSeg.el),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Places'), places),
        h('div', { class: 'row' }, h('span', { class: 'field-label' }, 'Kind'), kSeg.el, h('span', { class: 'small muted' }, 'GCSE shifts are logical.')));
      read = () => {
        const X = binary(x.input.value);
        const k = Number(places.value);
        if (!X) return 'Type the number in binary, using only 0 and 1 (up to 16 digits).';
        if (!Number.isInteger(k) || k < 1 || k >= Math.max(4, X.length)) return `Choose between 1 and ${Math.max(4, X.length) - 1} places.`;
        const w = Math.max(4, X.length);
        return makeItem('shift', { w, x: parseInt(X, 2), dir, k, kind: kindS, askValue: false, level: kindS === 'arithmetic' ? 'alevel' : 'gcse' });
      };
    } else {
      const n = textIn('The number (denary)', '-37');
      const wIn = h('input', { type: 'number', min: '4', max: '16', value: '8', class: 'num-in', 'aria-label': 'Number of bits' });
      form.append(n.el, h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Number of bits'), wIn));
      read = () => {
        const t = n.input.value.trim().replace(/[−–]/g, '-');
        const w = Number(wIn.value);
        if (!/^-?\d+$/.test(t)) return 'Type a whole number, like -37.';
        if (!Number.isInteger(w) || w < 4 || w > 16) return 'Choose between 4 and 16 bits.';
        const v = Number(t), lo = -(2 ** (w - 1)), hi = 2 ** (w - 1) - 1;
        if (v < lo || v > hi) return `${w} bits of two's complement hold ${lo} to ${hi}. Choose a number in that range, or use more bits.`;
        return makeItem('twos', { w, n: v, task: 'encode', level: 'alevel' });
      };
    }
    form.append(error, button('Set up my working', { kind: 'primary', type: 'submit' }));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      let item;
      try { item = read(); } catch (err) { item = err.message; }
      if (typeof item === 'string') { error.replaceChildren(callout('bad', null, item)); return; }
      error.replaceChildren();
      showItem(item);
    });
    formHolder.append(form);
  }

  function showItem(item) {
    runner?.destroy();
    itemHolder.replaceChildren();
    runner = mountItem(itemHolder, item, {
      mode: 'check', feedback: 'full', level: item.level, variants: false, nextLabel: 'Check another',
      onNext: () => { runner?.destroy(); runner = null; itemHolder.replaceChildren(); formHolder.querySelector('input')?.focus(); },
    });
    runner.focus();
  }
}

function textIn(label, placeholder) {
  const input = h('input', { type: 'text', placeholder, autocomplete: 'off', spellcheck: 'false', class: 'mono' });
  return { input, el: h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input) };
}

function binary(s) {
  const t = String(s).replace(/\s+/g, '');
  return /^[01]{1,16}$/.test(t) ? t : null;
}

