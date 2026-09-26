// Tiny DOM helpers. Everything user-visible is built with h()/svg(): text is
// always inserted as text nodes, never parsed as HTML.

const SVG_NS = 'http://www.w3.org/2000/svg';
const BOOL_PROPS = new Set(['disabled', 'hidden', 'checked', 'selected', 'readOnly', 'required', 'open', 'multiple', 'autofocus']);

function apply(el, attrs, isSvg) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false && !BOOL_PROPS.has(k)) continue;
    if (k === 'class' || k === 'className') {
      const cls = Array.isArray(v) ? v.flat(Infinity).filter(Boolean).join(' ') : v;
      if (isSvg) el.setAttribute('class', cls); else el.className = cls;
    } else if (k === 'style' && typeof v === 'object') {
      for (const [p, pv] of Object.entries(v)) if (pv !== undefined && pv !== null) {
        if (p.startsWith('--')) el.style.setProperty(p, pv); else el.style[p] = pv;
      }
    } else if (k === 'dataset') {
      for (const [p, pv] of Object.entries(v)) el.dataset[p] = pv;
    } else if (k === 'on') {
      for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    } else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'html') {
      throw new Error('h(): raw HTML is not allowed');
    } else if (!isSvg && (BOOL_PROPS.has(k) || k === 'value' || k === 'textContent')) {
      el[k] = v;
    } else if (k === 'text') {
      el.textContent = v;
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

/** h('button', { class: 'btn primary', onclick }, 'Check') */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  apply(el, attrs, false);
  append(el, children);
  return el;
}

/** svg('circle', { cx: 4, cy: 4, r: 3 }) */
export function svg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, attrs, true);
  append(el, children);
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function replace(el, ...children) { clear(el); append(el, children); return el; }

/** announce a result to screen readers (the #live region in index.html) */
export function announce(message, assertive = false) {
  const live = document.getElementById(assertive ? 'live-assertive' : 'live');
  if (!live) return;
  live.textContent = '';
  // a new text node on the next frame makes repeated identical messages announce again
  requestAnimationFrame(() => { live.textContent = message; });
}

/** copy text to the clipboard; resolves true on success */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall back */ }
  const ta = h('textarea', { class: 'visually-hidden', readOnly: true, 'aria-hidden': 'true' });
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

/** save a text file made on this device (e.g. the board's CSV) */
export function download(filename, text, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = h('a', { href: url, download: filename, class: 'visually-hidden' });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

/** an in-app href that keeps the page's ?query (e.g. ?t=teacher) */
export function href(path) {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${location.pathname}${location.search}#${p}`;
}

/** an absolute link to share (sets, review queues) */
export function shareUrl(path) {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${location.origin}${location.pathname}${location.search}#${p}`;
}

export const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** focus an element without scrolling the page unexpectedly */
export function focus(el) { if (el) { try { el.focus({ preventScroll: false }); } catch { el.focus(); } } }
