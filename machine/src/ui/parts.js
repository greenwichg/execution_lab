// Small shared UI pieces. All text goes in as text nodes (see lib/dom.js).
import { h, announce, copyText } from '../lib/dom.js';

/** a button; opts: { kind: 'primary'|'ghost'|null, small, onClick, disabled, title, type } */
export function button(label, opts = {}) {
  const cls = ['btn', opts.kind, opts.small && 'small'];
  const b = h('button', { type: opts.type || 'button', class: cls, title: opts.title, disabled: !!opts.disabled, 'aria-keyshortcuts': opts.keys }, label);
  if (opts.onClick) b.addEventListener('click', opts.onClick);
  return b;
}

export function chip(text, variant) { return h('span', { class: ['chip', variant] }, text); }

/**
 * Segmented control (a group of toggle buttons, one pressed).
 * options: [{ value, label, key? }]. Returns { el, get value, set value, setDisabled }.
 */
export function seg(options, { label, value = null, onChange, name } = {}) {
  let current = value;
  const buttons = options.map((o) => h('button', {
    type: 'button', 'aria-pressed': String(o.value === current), dataset: { value: String(o.value) },
    onclick: () => set(o.value, true),
  }, o.label));
  const el = h('div', { class: 'seg', role: 'group', 'aria-label': label, dataset: { name: name || '' } }, buttons);
  function set(v, fromUser) {
    current = v;
    buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i].value === v)));
    if (fromUser && onChange) onChange(v);
  }
  return {
    el,
    get value() { return current; },
    set value(v) { set(v, false); },
    setDisabled(d) { buttons.forEach((b) => { b.disabled = d; }); },
  };
}

export const CONFIDENCE = [
  { value: 'guess', label: 'Guessing' },
  { value: 'fair', label: 'Fairly sure' },
  { value: 'sure', label: 'Certain' },
];

/** "How sure are you?" — required before checking an answer */
export function confidence(onChange, value = null) {
  const s = seg(CONFIDENCE, { label: 'How sure are you?', value, onChange, name: 'confidence' });
  const el = h('div', { class: 'confidence row' }, h('span', { class: 'confidence-label' }, 'How sure are you?'), s.el);
  return { el, get value() { return s.value; }, set value(v) { s.value = v; }, setDisabled: (d) => s.setDisabled(d) };
}

const GLYPH = { ok: ['✓', 'correct'], bad: ['✗', 'incorrect'], missing: ['–', 'not answered'], extra: ['✗', 'should be empty'] };
/** ✓ / ✗ with words for screen readers — never colour alone */
export function statusGlyph(status) {
  const [g, words] = GLYPH[status] || ['', ''];
  return h('span', { class: ['glyph', `glyph-${status}`] }, h('span', { 'aria-hidden': 'true' }, g), h('span', { class: 'visually-hidden' }, words));
}

/** a callout: kind 'ok' | 'bad' | null */
export function callout(kind, headline, detail) {
  return h('div', { class: ['callout', kind], role: kind === 'bad' || kind === 'ok' ? 'status' : null },
    headline ? h('p', { class: 'callout-head' }, headline) : null,
    detail ? h('p', { class: 'callout-body' }, detail) : null);
}

/** a monospace value with a Copy button (result codes, review links, set links) */
export function copyBox(text, { label = 'Copy', big = false, what = 'Copied' } = {}) {
  const value = h('code', { class: ['copy-value', big && 'big'] }, text);
  const btn = button(label, { small: !big, kind: big ? 'primary' : null });
  btn.addEventListener('click', async () => {
    const ok = await copyText(text);
    btn.textContent = ok ? 'Copied ✓' : 'Select and copy';
    announce(ok ? what : 'Copy failed — select the text and copy it.');
    if (!ok) { const r = document.createRange(); r.selectNodeContents(value); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
    setTimeout(() => { btn.textContent = label; }, 2200);
  });
  return h('div', { class: ['copy-box', big && 'big'] }, value, btn);
}

/** bits (LSB-first array) → '11001000' (MSB first); nulls become '·' */
export function bitsText(bits) { return bits.slice().reverse().map((b) => (b === null || b === undefined ? '·' : String(b))).join(''); }

/** keyboard hint: keyHint('Space', 'reveal') */
export function keyHint(key, what) { return h('span', { class: 'key-hint' }, h('kbd', { class: 'kbd' }, key), ` ${what}`); }

/** a labelled stat tile */
export function tile(value, label) { return h('div', { class: 'tile' }, h('div', { class: 'tile-value' }, String(value)), h('div', { class: 'tile-label' }, label)); }
