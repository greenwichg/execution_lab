// The CS:APP card hooks for mountItem: the C program above the question, and
// after Check what the machine did, what the C standard says and what gcc -O0
// on x86-64 does. card.js passes them; runner.js applies them to every item
// with type 'card' when the caller passes no hooks (reviews and sets).
import { h } from '../lib/dom.js';
import { highlightC, stdChip } from './code.js';

/** what the machine did, in the learner's terms */
export function machineDid(item) {
  const ask = item.card.ask;
  const key = item.key;
  switch (ask.kind) {
    case 'value': return { label: `${ask.var} holds`, text: String(key.value) };
    case 'flags': return { label: 'Flags after cmp', text: ['CF', 'ZF', 'SF', 'OF'].map((n) => `${n} = ${key.flags[n]}`).join('  ') };
    case 'branch': return { label: 'It printed', text: key.branch };
    default: return { label: 'It printed', text: key.output === '' ? '(nothing)' : key.output };
  }
}

/** mountItem's beforePrompt for a card: the C source, focus line marked */
export function beforePrompt(el, item) {
  if (!item?.show?.src) return;
  el.append(highlightC(item.show.src, { focusLine: item.show.focusLine, label: 'The C program' }));
}

/** mountItem's afterReveal for a card: what the machine did, the C standard, gcc -O0 */
export function afterReveal(el, { item }) {
  if (!item?.card) return;
  const did = machineDid(item);
  const std = item.card.std;
  el.append(h('section', { class: 'card-reveal panel tight stack-sm', 'aria-label': 'What the machine did' },
    h('div', { class: 'machine-did' },
      h('span', { class: 'machine-did-label' }, `${did.label}: `),
      h('code', { class: 'machine-did-value' }, did.text)),
    h('p', { class: 'small muted' }, 'Same output as gcc -O0 on x86-64.'),
    h('p', { class: 'std-line' }, h('strong', null, 'C standard:'), ' ', stdChip(std.status, { prefix: '' }), ' ', std.text),
    h('p', { class: 'gcc-line' }, h('strong', null, 'gcc -O0 on x86-64:'), ' ', item.card.gcc)));
}
