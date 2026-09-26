// Predict the Machine — boot + hash router.
// Each route lazily imports one view module exporting render(el, ctx) and
// optionally dispose(). Unknown or failing routes show a friendly page.
import { h, replace, focus, keptQuery } from './lib/dom.js';

const ROUTES = [
  ['/', () => import('./ui/views/home.js')],
  ['/practice/:topic', () => import('./ui/views/practice.js')],
  ['/check', () => import('./ui/views/check.js')],
  ['/review', () => import('./ui/views/review.js')],
  ['/review/:q', () => import('./ui/views/review.js')],
  ['/teacher', () => import('./ui/views/teacher.js')],
  ['/starter', () => import('./ui/views/starter.js')],
  ['/set/:code', () => import('./ui/views/set.js')],
  ['/board', () => import('./ui/views/board.js')],
  ['/cards', () => import('./ui/views/cards.js')],
  ['/card/:id', () => import('./ui/views/card.js')],
  ['/paste', () => import('./ui/views/paste.js')],
];

function match(path) {
  const parts = path.split('/').filter(Boolean);
  for (const [pattern, load] of ROUTES) {
    const pp = pattern.split('/').filter(Boolean);
    if (pp.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) { try { params[pp[i].slice(1)] = decodeURIComponent(parts[i]); } catch { params[pp[i].slice(1)] = parts[i]; } }   // a mangled %-escape in a pasted link
      else if (pp[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { pattern, load, params };
  }
  return null;
}

/** '#/card/add?v=3' → { path: '/card/add', query: URLSearchParams } */
function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const qi = raw.indexOf('?');
  const path = (qi >= 0 ? raw.slice(0, qi) : raw) || '/';
  const query = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '');
  return { path: path.startsWith('/') ? path : `/${path}`, query };
}

const app = {
  root: null,
  view: null,
  token: 0,
  nav(path, { replace: rep = false } = {}) {
    const p = path.startsWith('/') ? path : `/${path}`;
    if (rep) history.replaceState(null, '', `${location.pathname}${keptQuery()}#${p}`);
    else location.hash = p;
    if (rep) this.route();
  },
  async route() {
    // in-page anchors (the skip link's #app) are not routes
    if (location.hash && !location.hash.startsWith('#/')) return;
    const token = ++this.token;
    const { path, query } = parseHash();
    const m = match(path);
    try { this.view?.dispose?.(); } catch (e) { console.error(e); }
    this.view = null;
    document.body.classList.remove('projector');
    const el = this.root;
    if (!m) { replace(el, notFound(path)); return; }
    let mod;
    try { mod = await m.load(); } catch (e) {
      console.error(e);
      if (token === this.token) replace(el, notBuilt(path));
      return;
    }
    if (token !== this.token) return;              // a newer navigation won
    replace(el);
    const ctx = { params: m.params, query, nav: (p, o) => this.nav(p, o), app: this };
    try {
      await mod.render(el, ctx);
      this.view = mod;
    } catch (e) {
      console.error(e);
      replace(el, failed(e));
    }
    if (token === this.token) {
      window.scrollTo(0, 0);
      const h1 = el.querySelector('h1')?.textContent?.trim();
      document.title = h1 && h1 !== 'Predict the Machine' ? `${h1} · Predict the Machine` : 'Predict the Machine';
      const heading = el.querySelector('h1');
      if (heading) { heading.setAttribute('tabindex', '-1'); focus(heading); }
    }
  },
};

function notFound(path) {
  return h('main', { class: 'page page-narrow stack', 'data-view': 'notfound' },
    h('h1', null, 'Page not found'),
    h('p', { class: 'lede' }, `There is nothing at “${path}”.`),
    h('p', null, h('a', { class: 'btn primary', href: '#/' }, 'Go to the start')));
}
function notBuilt() {
  return h('main', { class: 'page page-narrow stack', 'data-view': 'unavailable' },
    h('h1', null, 'Not available yet'),
    h('p', { class: 'lede' }, 'This part of Predict the Machine could not be loaded.'),
    h('p', null, h('a', { class: 'btn primary', href: '#/' }, 'Go to the start')));
}
function failed(e) {
  return h('main', { class: 'page page-narrow stack', 'data-view': 'error' },
    h('h1', null, 'Something went wrong'),
    h('p', { class: 'lede' }, 'This page hit an error. Nothing you entered has left your device.'),
    h('pre', { class: 'muted small' }, String(e && e.message || e)),
    h('p', null, h('a', { class: 'btn primary', href: '#/' }, 'Go to the start')));
}

export function boot() {
  app.root = document.getElementById('app');
  // "Skip to content" moves focus to the page's heading without changing the route
  document.querySelector('a.skip')?.addEventListener('click', (e) => {
    e.preventDefault();
    const t = app.root.querySelector('h1') || app.root;
    t.setAttribute('tabindex', '-1');
    focus(t);
  });
  addEventListener('hashchange', () => app.route());
  app.route();
  window.__pm = app;                 // for tests
}

boot();
