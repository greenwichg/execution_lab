// The item registry: every practice type behind one interface (CONTRACTS.md
// "Items"), plus the two ways the rest of the app asks for an item — by spec
// point (teacher plans, starters) and by misconception (practise a variant).
import * as add from './add.js';
import * as shift from './shift.js';
import * as twos from './twos.js';
import * as sadd from './sadd.js';
import * as fa from './fa.js';
import * as card from '../cards.js';
import { specById } from '../spec.js';

export const ITEM_TYPES = { add, shift, twos, sadd, fa, card };

// Indexed by TYPE_ID: result codes and review queues store the number.
const BY_ID = [add, shift, twos, sadd, fa, card];

export const typeById = (id) => BY_ID[id] || null;

export function makeItem(type, params) {
  const mod = ITEM_TYPES[type];
  if (!mod) throw new Error(`unknown item type: ${type}`);
  return mod.build(params);
}

export function itemForSpec(specId, rng, opts = {}) {
  const spec = specById(specId);
  if (!spec) throw new Error(`unknown spec point: ${specId}`);
  const { type, opts: specOpts } = spec.make;
  const params = ITEM_TYPES[type].generate(rng, { level: spec.level, ...specOpts, ...opts });
  return { type, params };
}

// Which type practises a misconception by default. add_* tags can also be
// practised in signed sums or full adders (pass opts.type to choose).
function ownerOf(tagId) {
  if (!tagId) return null;
  if (tagId.startsWith('add_')) return 'add';
  if (tagId.startsWith('shift_')) return 'shift';
  if (tagId.startsWith('twos_')) return 'twos';
  if (tagId.startsWith('flags_')) return 'sadd';
  if (tagId.startsWith('c_')) return 'card';
  return null;
}

/** a fresh item aimed at one misconception; null when no type practises it */
export function itemForTag(tagId, rng, opts = {}) {
  const wanted = opts.type && ITEM_TYPES[opts.type];
  const canTarget = wanted && (opts.type === 'card' ? ownerOf(tagId) === 'card' : (wanted.TARGETS || []).includes(tagId));
  const type = canTarget ? opts.type : ownerOf(tagId);
  if (!type) return null;
  const rest = { ...opts };
  delete rest.type;
  const params = ITEM_TYPES[type].generate(rng, { ...rest, target: tagId });
  return { type, params };
}
