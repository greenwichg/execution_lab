// A 10-question practice session on one topic: due reviews first, then new
// items; "Try one like it" aims a variant at the misconception just seen.
import { h, href } from '../../lib/dom.js';
import { newSeed, mulberry32 } from '../../lib/rng.js';
import { SPECS, TOPIC_NAMES, LEVELS, specLabel } from '../../learn/spec.js';
import { itemForSpec, makeItem, typeById } from '../../learn/items/index.js';
import * as sched from '../../learn/scheduler.js';
import { tagId } from '../../learn/catalogue.js';
import { runSession, loadSched } from '../session.js';
import { setNav } from '../nav.js';

const DEFAULT_LEVEL = { add: 'gcse', shift: 'gcse', twos: 'alevel', sadd: 'alevel', fa: 'alevel' };
const TOTAL = 10;
let session = null;

export function render(el, ctx) {
  const topic = ctx.params.topic;
  if (topic === 'c') { ctx.nav('/cards', { replace: true }); return; }
  let level = ctx.query.get('level');
  let spec = SPECS.find((s) => s.topic === topic && s.level === level);
  if (!spec) { level = DEFAULT_LEVEL[topic]; spec = SPECS.find((s) => s.topic === topic && s.level === level); }
  setNav('#/practice/add');
  if (!spec) {
    el.append(h('main', { class: 'page page-narrow stack', 'data-view': 'practice' },
      h('h1', null, 'Nothing to practise here'),
      h('p', { class: 'lede' }, `There is no topic called “${topic}”.`),
      h('p', null, h('a', { class: 'btn primary', href: href('/') }, 'Choose a topic'))));
    return;
  }
  const type = spec.make.type;
  const seed = newSeed();
  const rng = mulberry32(seed);
  const reviews = sched.dueEntries(loadSched(), sched.dayNumber(new Date()))
    .filter((e) => typeById(e.type)?.TYPE === type).slice(0, 2);
  const others = SPECS.filter((s) => s.topic === topic && s.id !== spec.id);
  const holder = h('div', { class: 'session' });
  el.append(h('main', { class: 'page page-narrow stack', 'data-view': 'practice' },
    h('div', { class: 'stack-sm' },
      h('p', { class: 'chip accent' }, LEVELS.find((l) => l.id === level)?.name || level),
      h('h1', null, `Practise: ${TOPIC_NAMES[topic]}`),
      h('p', { class: 'muted small' }, specLabel(spec), others.length ? [' · also at ', others.map((o, k) => [k ? ', ' : '', h('a', { href: href(`/practice/${topic}?level=${o.level}`) }, LEVELS.find((l) => l.id === o.level)?.name)])] : null)),
    holder));

  session = runSession(holder, {
    total: TOTAL, seed, level, showSpec: false,
    next(i) {
      const due = reviews.shift();
      if (due) {
        const mod = typeById(due.type);
        return { item: makeItem(mod.TYPE, mod.decodeParams(due.params)), review: true, group: due.group, target: tagId(due.tag) || undefined };
      }
      const { type: t, params } = itemForSpec(spec.id, rng, { level });
      return { item: makeItem(t, params), group: sched.isHoldout(seed, i) ? 'holdout' : 'drill' };
    },
    again: () => ctx.app.route(),
  });
}

export function dispose() { session?.dispose(); session = null; }
