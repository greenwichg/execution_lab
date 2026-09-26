// Spaced review: what you missed comes back after 2, 7 and 21 days. A review
// link carries the queue in the URL, so it survives a device that forgets.
import { h, href } from '../../lib/dom.js';
import { newSeed } from '../../lib/rng.js';
import { makeItem, typeById } from '../../learn/items/index.js';
import * as sched from '../../learn/scheduler.js';
import { decodeQueue } from '../../lib/codec.js';
import { tagId } from '../../learn/catalogue.js';
import { runSession, loadSched, saveSched, reviewLink, formatDay } from '../session.js';
import { button, callout, copyBox, tile } from '../parts.js';
import { setNav } from '../nav.js';

let session = null;

export function render(el, ctx) {
  setNav('#/review');
  const day = sched.dayNumber(new Date());
  let state = loadSched();
  let notice = null;
  if (ctx.params.q) {
    try {
      const entries = decodeQueue(ctx.params.q);
      const r = sched.mergeQueue(state, entries, day);
      state = r.state;
      saveSched(state);
      notice = callout('ok', null, r.added ? `Added ${r.added} question${r.added === 1 ? '' : 's'} from your link.` : 'Everything in your link is already here.');
    } catch (e) {
      notice = callout('bad', "That review link didn't work.", `${e.message || 'It may have been cut short when it was copied.'} Your other reviews are safe.`);
    }
  }
  const sum = sched.queueSummary(state, day);
  const due = sched.dueEntries(state, day);
  const link = reviewLink(state);
  const acc = sched.reviewAccuracy(state);
  const measured = acc.drill.total + acc.holdout.total;
  const holder = h('div', { class: 'stack' });
  const main = h('main', { class: 'page page-narrow stack', 'data-view': 'review' },
    h('h1', null, 'Review'),
    h('p', { class: 'lede' }, 'Questions you got wrong come back after 2 days, then 7, then 21 — the spacing that helps them stick.'),
    notice, holder);
  el.append(main);

  function overview() {
    holder.replaceChildren(
      h('div', { class: 'row' }, tile(sum.due, 'due now'), tile(sum.later, 'coming back later'),
        sum.next !== null && sum.next !== undefined && !sum.due ? tile(formatDay(sum.next), 'next review') : null),
      due.length
        ? button(`Start review (${Math.min(due.length, 20)})`, { kind: 'primary', onClick: start })
        : h('p', null, sum.later ? 'Nothing is due today — come back on the day shown above.' : h('span', null, 'Nothing to review yet. ', h('a', { href: href('/practice/add?level=gcse') }, 'Practise something'), ' and your misses will appear here.')),
      link ? h('section', { class: 'panel stack-sm', 'aria-labelledby': 'link-h' },
        h('h2', { id: 'link-h' }, 'Your review link'),
        h('p', { class: 'small' }, 'Bookmark this. It brings your reviews back even if this device forgets, and works on any device.'),
        copyBox(link, { what: 'Review link copied' })) : null,
      measured ? h('p', { class: 'small muted' }, `Reviews answered right first time: ${acc.drill.right + acc.holdout.right} of ${measured}.`) : null);
  }

  function start() {
    const list = due.slice(0, 20);
    session = runSession(holder, {
      total: list.length, seed: newSeed(), level: undefined,
      endTitle: 'Review complete', againLabel: 'Back to review',
      next(i) {
        const e = list[i];
        if (!e) return null;
        const mod = typeById(e.type);
        return { item: makeItem(mod.TYPE, mod.decodeParams(e.params)), review: true, group: e.group, target: tagId(e.tag) || undefined };
      },
      again: () => ctx.nav('/review'),
    });
  }
  overview();
}

export function dispose() { session?.dispose(); session = null; }
