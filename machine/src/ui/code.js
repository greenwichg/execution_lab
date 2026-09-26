// Safe C syntax colouring: the source is split into tokens and every token is
// inserted as a text node inside a classed <span>. Nothing is ever parsed as
// HTML, so pasted code (and printf strings such as "<img …>") stays plain text.
import { h } from '../lib/dom.js';

const KEYWORDS = new Set(['if', 'else', 'for', 'while', 'do', 'return', 'break', 'continue', 'switch', 'case', 'default', 'goto', 'sizeof']);
const TYPES = new Set(['int', 'unsigned', 'signed', 'char', 'short', 'long', 'void', 'const', 'static', 'volatile', 'float', 'double', 'size_t', '_Bool', 'bool', 'struct', 'enum', 'union', 'typedef', 'extern', 'register']);

/**
 * Split one line into tokens. `inComment` carries an open block comment
 * from the previous line. Returns { tokens: [{ cls|null, text }], inComment }.
 */
export function tokenizeLine(line, inComment = false) {
  const out = [];
  let i = 0;
  const push = (cls, text) => { if (text) out.push({ cls, text }); };
  if (inComment) {
    const end = line.indexOf('*/');
    if (end < 0) { push('comment', line); return { tokens: out, inComment: true }; }
    push('comment', line.slice(0, end + 2));
    i = end + 2;
    inComment = false;
  }
  if (/^\s*#/.test(line.slice(i)) && i === 0) {
    const c = line.indexOf('//');
    push('preprocessor', c >= 0 ? line.slice(0, c) : line);
    if (c >= 0) push('comment', line.slice(c));
    return { tokens: out, inComment: false };
  }
  while (i < line.length) {
    const rest = line.slice(i);
    let m;
    if (rest.startsWith('//')) { push('comment', rest); break; }
    if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/', 2);
      if (end < 0) { push('comment', rest); inComment = true; break; }
      push('comment', rest.slice(0, end + 2)); i += end + 2; continue;
    }
    if ((m = /^\s+/.exec(rest))) { push(null, m[0]); i += m[0].length; continue; }
    if ((m = /^"(?:[^"\\]|\\.)*"?/.exec(rest))) { push('string', m[0]); i += m[0].length; continue; }
    if ((m = /^'(?:[^'\\]|\\.)*'?/.exec(rest))) { push('char', m[0]); i += m[0].length; continue; }
    if ((m = /^(?:0[xX][0-9a-fA-F]+|\d+)[uUlL]*/.exec(rest))) { push('number', m[0]); i += m[0].length; continue; }
    if ((m = /^[A-Za-z_]\w*/.exec(rest))) {
      const w = m[0];
      push(KEYWORDS.has(w) ? 'keyword' : TYPES.has(w) ? 'type' : null, w);
      i += w.length; continue;
    }
    if ((m = /^(?:<<=|>>=|\+\+|--|<<|>>|<=|>=|==|!=|&&|\|\||[-+*/%&|^]=|->|[-+*/%=<>!&|^~?:])/.exec(rest))) { push('operator', m[0]); i += m[0].length; continue; }
    push(null, rest[0]); i += 1;
  }
  return { tokens: out, inComment };
}

/**
 * highlightC(src, { focusLine, lineNumbers = true, errorLine, label }) →
 * <pre class="code c-src"> with one .cl span per line.
 */
export function highlightC(src, { focusLine = null, lineNumbers = true, errorLine = null, label = null } = {}) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const pad = String(lines.length).length;
  let inComment = false;
  const rows = lines.map((text, idx) => {
    const n = idx + 1;
    const r = tokenizeLine(text, inComment);
    inComment = r.inComment;
    const focus = n === focusLine;
    const err = n === errorLine;
    return h('span', { class: ['cl', focus && 'focus', err && 'err'], dataset: { line: String(n) } },
      lineNumbers ? h('span', { class: 'cl-n', 'aria-hidden': 'true' }, `${focus || err ? '▸' : ' '}${String(n).padStart(pad, ' ')}`) : null,
      focus ? h('span', { class: 'visually-hidden' }, `Line ${n}, the line in focus: `) : null,
      h('span', { class: 'cl-t' }, r.tokens.length ? r.tokens.map((t) => (t.cls ? h('span', { class: `tk-${t.cls}` }, t.text) : t.text)) : ' '),
      '\n');
  });
  return h('pre', { class: 'code c-src', tabindex: '0', role: 'group', 'aria-label': label || 'C source code' }, h('span', { class: 'c-lines' }, rows));
}

const STD_WORDS = { defined: 'defined', 'implementation-defined': 'implementation-defined', undefined: 'undefined' };
const STD_MARK = { defined: '●', 'implementation-defined': '◐', undefined: '○' };
/** the C-standard status as a chip in words (the shape mark is decoration, the words carry the meaning) */
export function stdChip(status, { prefix = 'C standard: ' } = {}) {
  const word = STD_WORDS[status] || String(status);
  return h('span', { class: ['chip', 'std-chip', `std-${status}`] },
    h('span', { class: 'std-mark', 'aria-hidden': 'true' }, STD_MARK[status] || ''),
    prefix ? h('span', { class: 'std-prefix' }, prefix) : null, word);
}
