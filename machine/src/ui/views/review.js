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
import { forgetControl } from '../forget.js';
import { setNav } from '../nav.js';

const CONFIRM_OVER = 5;          // importing more than this from a link asks first
let session = null;

function itemOf(e) {
  try {
    const mod = typeById(e.type);
    return makeItem(mod.TYPE, mod.decodeParams(e.params));
  } catch { return null; }                 // a damaged entry is skipped, never fatal
}

export function render(el, ctx) {
  setNav('#/review');
  const day = sched.dayNumber(new Date());
  let state = loadSched();
  const notice = h('div');
  const holder = h('div', { class: 'stack' });
  el.append(h('main', { class: 'page page-narrow stack', 'data-view': 'review' },
    h('h1', null, 'Review'),
    h('p', { class: 'lede' }, 'Questions you got wrong come back after 2 days, then 7, then 21 — the spacing that helps them stick.'),
    notice, holder));

  function importLink(entries) {
    const r = sched.mergeQueue(state, entries, day);
    state = r.state;
    saveSched(state);
    const skipped = r.skipped || 0;
    notice.replaceChildren(callout('ok', null, [
      r.added ? `Added ${r.added} question${r.added === 1 ? '' : 's'} from your link.` : 'Everything in your link is already here.',
      skipped ? ` ${skipped} ${skipped === 1 ? 'was' : 'were'} not added: your review list is full.` : '',
    ].join('')));
    overview();
  }

  if (ctx.params.q) {
    let entries = null;
    try { entries = decodeQueue(ctx.params.q); } catch (e) {
      notice.replaceChildren(callout('bad', "That review link didn't work.", `${e.message || 'It may have been cut short when it was copied.'} Your other reviews are safe.`));
    }
    if (entries) {
      if (entries.length > CONFIRM_OVER && sched.activeEntries(state).length) {
        // someone else's link must never quietly crowd out this learner's own reviews
        const yes = button(`Add ${entries.length} questions`, { kind: 'primary', small: true, onClick: () => importLink(entries) });
        const no = button('Not now', { small: true, onClick: () => { notice.replaceChildren(); ctx.nav('/review', { replace: true }); } });
        notice.replaceChildren(h('div', { class: 'callout stack-sm' },
          h('p', null, `This link has ${entries.length} questions. Add them to the reviews already on this device?`),
          h('div', { class: 'row' }, yes, no)));
      } else importLink(entries);
    }
  }

  function overview() {
    const sum = sched.queueSummary(state, day);
    const due = sched.dueEntries(state, day);
    const link = reviewLink(state);
    const acc = sched.reviewAccuracy(state);
    const measured = acc.drill.total + acc.holdout.total;
    const pct = (g) => (g.total ? `${Math.round((100 * g.right) / g.total)}% (${g.right} of ${g.total})` : '—');
    holder.replaceChildren(...[
      h('div', { class: 'row' }, tile(sum.due, 'due now'), tile(sum.later, 'coming back later'),
        sum.next !== null && sum.next !== undefined && !sum.due ? tile(formatDay(sum.next), 'next review') : null),
      due.length
        ? button(`Start review (${Math.min(due.length, 20)})`, { kind: 'primary', onClick: () => start(due) })
        : h('p', null, sum.later ? 'Nothing is due today — come back on the day shown above.' : h('span', null, 'Nothing to review yet. ', h('a', { href: href('/practice/add?level=gcse') }, 'Practise something'), ' and your misses will appear here.')),
      link ? h('section', { class: 'panel stack-sm', 'aria-labelledby': 'link-h' },
        h('h2', { id: 'link-h' }, 'Your review link'),
        h('p', { class: 'small' }, 'Bookmark this. It brings your reviews back even if this device forgets, and works on any device.'),
        copyBox(link, { what: 'Review link copied' })) : null,
      measured ? h('section', { class: 'panel tight stack-sm', 'aria-labelledby': 'ev-h' },
        h('h2', { id: 'ev-h', class: 'small-h' }, 'Does the explaining help you?'),
        h('p', { class: 'small' }, 'Reviews answered right first time, a week or more after the miss:'),
        h('table', { class: 'table small' },
          h('tbody', null,
            h('tr', null, h('th', { scope: 'row' }, 'After a full explanation'), h('td', null, pct(acc.drill))),
            h('tr', null, h('th', { scope: 'row' }, 'After seeing only the answer'), h('td', null, pct(acc.holdout))))),
        h('p', { class: 'small muted' }, 'About 1 in 7 practice questions only shows the answer, so the two can be compared. Small numbers mean little.')) : null,
      h('div', { class: 'small muted' }, forgetControl({ onDone: () => {
        state = loadSched();
        notice.replaceChildren(callout('ok', null, 'Everything from Predict the Machine on this device has been forgotten.'));
        overview();
      } })),
    ].filter(Boolean));
  }

  function start(dueList) {
    const list = dueList.slice(0, 20);
    session = runSession(holder, {
      total: list.length, seed: newSeed(), level: undefined, variantsExtend: true,
      endTitle: 'Review complete', againLabel: 'Back to review',
      next() {
        while (list.length) {
          const e = list.shift();
          const item = itemOf(e);
          if (item) return { item, review: true, group: e.group, target: tagId(e.tag) || undefined };
        }
        return null;
      },
      again: () => { session?.dispose(); session = null; state = loadSched(); ctx.app.route(); },
    });
  }
  overview();
}

export function dispose() { session?.dispose(); session = null; }
