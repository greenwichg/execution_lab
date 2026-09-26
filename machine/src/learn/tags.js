// Binary misconception texts + worked examples (owner: items). See CONTRACTS.md.
// Each worked example is generated from real numbers chosen so that the
// misconception WOULD change the answer, and is split into labelled subgoals
// (the steps a learner can reuse on the next question).
import * as add from './items/add.js';
import * as shift from './items/shift.js';
import * as twos from './items/twos.js';
import * as sadd from './items/sadd.js';
import { toBits, range as bitRange } from '../engine/bits.js';

const { binStr, colName, colRule, colTerms, num } = add;

// ---------------------------------------------------------------------------
// Worked-example builders
// ---------------------------------------------------------------------------

/** an addition item that exercises `tag`, with its simulation */
function addExample(rng, tag) {
  const item = add.build({ ...add.generate(rng, { w: 8, target: tag }), ask: 'full' });
  return { item, A: item.show.a, B: item.show.b, c: item.sim.carries, r: item.sim };
}

function firstColumn(ex, test) {
  for (let i = 0; i < 8; i++) if (test(ex.A[i], ex.B[i], ex.c[i])) return i;
  return 7;
}

/** the four subgoals every addition follows; step 2–3 focus one column */
function additionSteps(ex, f, focusNote) {
  const { item, A, B, c, r } = ex;
  const { a, b } = item.params;
  const n = A[f] + B[f] + c[f];
  const [s, co] = colRule(A[f], B[f], c[f]);
  const layers = add.why(item, { tag: null, focus: { column: f } }, { level: 'gcse' });
  const next = f === 7 ? 'out of the top column' : `into ${colName(f + 1)}`;
  return [
    { subgoal: '1. Start at the right-hand column', text: `Write ${binStr(A)} (${a}) above ${binStr(B)} (${b}) and start with the 1s column.` },
    { subgoal: '2. Add the two bits and the carry', text: `In ${colName(f)}, ${colTerms(A[f], B[f], c[f])} = ${n}.${focusNote ? ` ${focusNote}` : ''}` },
    {
      subgoal: '3. Write the last bit, carry the rest',
      text: n >= 2 ? `${n} is ${n.toString(2)} in binary: write ${s} and carry ${co} ${next}.` : `${n} is less than 2: write ${s} and carry nothing.`,
      layer: layers[1],
    },
    {
      subgoal: '4. Check the final carry: overflow?',
      text: r.cout
        ? `A 1 carries out of the top column, so there is an overflow: the 8-bit answer is ${binStr(r.result)} (${r.value}), not ${a + b}.`
        : `Nothing carries out of the top column, so there is no overflow: ${a} + ${b} = ${r.value} = ${binStr(r.result)}.`,
      layer: layers[0],
    },
  ];
}

function workedAdd(title, tag, pickColumn, note) {
  return (rng) => {
    const ex = addExample(rng, tag);
    const f = pickColumn(ex);
    return { title, steps: additionSteps(ex, f, note ? note(ex, f) : '') };
  };
}

const firstCarry = (ex) => firstColumn(ex, (a, b, c) => a + b + c >= 2);

function workedShift(title, tag, emphasis) {
  return (rng) => {
    const p = shift.generate(rng, { w: 8, target: tag, kind: tag === 'shift_arith_logical' ? 'arithmetic' : 'logical', level: tag === 'shift_arith_logical' ? 'alevel' : 'gcse' });
    const item = shift.build(p);
    const layers = shift.why(item, { tag: null });
    const s = item.sim;
    const end = p.dir === 'L' ? 'left' : 'right';
    const gapSide = p.dir === 'L' ? 'right' : 'left';
    const lostBits = s.lost.map((i) => item.show.x[i]).reverse().join('');
    const fillWhy = p.kind === 'arithmetic' && p.dir === 'R' ? `copies of the sign bit (${s.fill})` : `${s.fill}s`;
    const steps = [
      { subgoal: '1. Write out the bits', text: `Start with ${binStr(item.show.x)}, which is ${num(item.show.xValue)}${p.kind === 'arithmetic' ? " in two's complement" : ''}.` },
      { subgoal: `2. Move every bit ${p.k} place${p.k === 1 ? '' : 's'} ${end}`, text: emphasis.move || `Every bit slides ${p.k} place${p.k === 1 ? '' : 's'} to the ${end}; none of them change.` },
      { subgoal: '3. Let the end bits fall off', text: emphasis.lost || `The ${p.k === 1 ? `bit ${lostBits} goes` : `bits ${lostBits} go`} past the ${end} end and ${p.k === 1 ? 'is' : 'are'} lost for good.` },
      { subgoal: '4. Fill the gap', text: `${emphasis.fill ? `${emphasis.fill} ` : ''}Fill the gap on the ${gapSide} with ${fillWhy}: the answer is ${binStr(s.bits)}.`, layer: layers[0] },
      { subgoal: '5. Check the value', text: layers[layers.length - 1].say.join(' '), layer: layers[layers.length - 1] },
    ];
    return { title, steps };
  };
}

function workedEncode(title, tag, stressPlusOne) {
  return (rng) => {
    const p = twos.generate(rng, { w: 8, target: tag });
    const n = p.n;                     // targeted items are always negative
    const w = 8;
    const pos = toBits(-n, w);
    const inv = pos.map((x) => 1 - x);
    const bits = toBits(n, w);
    const item = twos.build({ w, n, task: 'encode' });
    const layers = twos.why(item);
    return {
      title,
      steps: [
        { subgoal: '1. Write the positive number', text: `Write +${-n} in 8-bit binary: ${binStr(pos)}.` },
        { subgoal: '2. Invert every bit', text: `Change every 0 to 1 and every 1 to 0: ${binStr(inv)}.`, layer: layers[0] },
        {
          subgoal: '3. Add 1',
          text: `${binStr(inv)} + 1 = ${binStr(bits)}.${stressPlusOne ? ' Without this step you are 1 out.' : ''}`,
          layer: layers[1],
        },
        { subgoal: '4. Check with place values', text: `The top bit is worth −128, so ${binStr(bits)} = −128 + ${n + 128} = ${num(n)}.` },
      ],
    };
  };
}

function workedFlags(title, tag, stepsFor) {
  return (rng) => {
    const p = sadd.generate(rng, { w: 8, target: tag, level: 'csapp' });
    const item = sadd.build(p);
    const layers = sadd.why(item, { tag: null, focus: { column: 7 } }, { level: 'csapp' });
    return { title, steps: stepsFor(item, layers) };
  };
}

function signedSteps(item, layers) {
  const { a, b, op } = item.params;
  const s = item.sim;
  const { min, max } = bitRange(8, true);
  const opText = op === '-' ? `${num(a)} − ${b < 0 ? `(${num(b)})` : num(b)}` : `${num(a)} + ${b < 0 ? `(${num(b)})` : num(b)}`;
  return {
    add: { subgoal: '1. Add the bits', text: `${opText} in 8 bits gives ${binStr(s.result)}, which reads as ${num(s.signedValue)}.`, layer: layers[0] },
    truth: { subgoal: '2. Work out the true answer', text: `The true answer is ${num(s.truth)}, and 8 bits hold ${num(min)} to ${max}.` },
    of: { subgoal: '3. Decide OF: does the answer fit?', text: layers.find((l) => l.kind === 'flags').data.why.OF },
    cf: { subgoal: '4. Decide CF from the carry', text: layers.find((l) => l.kind === 'flags').data.why.CF, layer: layers.find((l) => l.kind === 'flags') },
  };
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

export const BINARY_TAGS = {
  add_or: {
    label: 'Treated 1 + 1 as 1',
    student: 'You added 1 + 1 and wrote 1, as if it were OR. In binary 1 + 1 = 10: write 0 and carry 1.',
    fix: 'When a column adds up to 2, write 0 and carry 1 into the next column.',
    worked: workedAdd('Adding 1 + 1 in binary', 'add_or',
      (ex) => firstColumn(ex, (a, b, c) => a === 1 && b === 1 && c === 0),
      () => 'Two 1s make 2, not 1.'),
  },
  add_no_carry: {
    label: 'Dropped a carry',
    student: "You didn't carry the 1 into the next column, or you wrote it but didn't add it in. Every carry must be added to the next column's bits.",
    fix: 'When a column adds up to 2 or 3, write the last bit and carry 1 left, then add that carry into the next column.',
    worked: workedAdd('Carrying into the next column', 'add_no_carry', firstCarry,
      () => 'The carry you write here must be added into the next column.'),
  },
  add_three_ones: {
    label: 'Wrote 1 + 1 + 1 as 0 carry 1',
    student: 'You worked out 1 + 1 + 1 as 0 carry 1. It is 3, which is 11 in binary: write 1 and carry 1.',
    fix: 'When a column adds up to 3, write 1 and carry 1.',
    worked: workedAdd('Adding three 1s in a column', 'add_three_ones',
      (ex) => firstColumn(ex, (a, b, c) => a + b + c === 3),
      () => 'That is three 1s, so the total is 3, not 2.'),
  },
  add_carry_wrong_col: {
    label: 'Carry written in the wrong column',
    student: 'You wrote your carries one column away from where they belong. A carry goes above the next column to the left, the one it is added into.',
    fix: 'Write each carry above the column to the left of the one that made it.',
    worked: workedAdd('Where to write a carry', 'add_carry_wrong_col', firstCarry,
      (ex, f) => `Its carry goes above ${f === 7 ? 'the space left of the top column' : colName(f + 1)}, the next column to the left.`),
  },
  add_ninth_bit: {
    label: 'Kept an extra bit in the result',
    student: 'You wrote an extra bit on the left of the result. An 8-bit answer has only 8 bits, so the carry out of the top column is lost: that is an overflow error.',
    fix: 'Keep the result to the stated number of bits and report the lost carry as an overflow.',
    worked: workedAdd('When the carry has nowhere to go', 'add_ninth_bit', () => 7,
      () => 'This is the top column, so there is no column left for its carry.'),
  },
  add_overflow_missed: {
    label: 'Missed an overflow',
    student: 'You missed that a 1 carried out of the top column, so the answer did not fit. That is an overflow error.',
    fix: 'After the top column, check the carry: a 1 carried out means overflow.',
    worked: workedAdd('Spotting overflow', 'add_overflow_missed', () => 7,
      () => 'Watch what happens to the carry from this top column.'),
  },
  add_overflow_false: {
    label: 'Claimed overflow when there was none',
    student: 'You said there was an overflow, but nothing carried out of the top column. Big numbers only overflow when the answer needs more bits than you have.',
    fix: 'Say overflow only when a 1 carries out of the top column.',
    worked: workedAdd('A big sum that still fits', 'add_overflow_false', () => 7,
      (ex) => `The answer ${ex.item.params.a + ex.item.params.b} is big, but 8 bits hold up to 255.`),
  },

  shift_direction: {
    label: 'Shifted the wrong way',
    student: 'You shifted the bits the opposite way. Left means towards the bigger place values; right means towards the 1s column.',
    fix: 'Before you start, point to the end the bits move towards: left is the big end.',
    worked: workedShift('Which way is left?', 'shift_direction', { move: 'Left moves bits towards the bigger place values; right moves them towards the 1s column.' }),
  },
  shift_amount: {
    label: 'Shifted by the wrong number of places',
    student: 'You moved the bits by the wrong number of places. After a shift of k places the gap is exactly k bits wide.',
    fix: 'Count the places as you move, then check that the gap is exactly that many bits wide.',
    worked: workedShift('Counting the places', 'shift_amount', { fill: 'Count the gap first: it must be exactly as wide as the shift.' }),
  },
  shift_kept_bits: {
    label: 'Wrapped lost bits round (rotated)',
    student: 'You moved the bits that fall off one end round to the other end. In a shift they are lost, and the gap is filled instead.',
    fix: 'Cross out the bits that go past the end before you fill the gap.',
    worked: workedShift('Bits that fall off are lost', 'shift_kept_bits', { lost: 'The bits that go past the end are lost for good; they do not come round to the other end.' }),
  },
  shift_fill: {
    label: 'Filled the gap with the wrong bit',
    student: 'You filled the gap with the wrong bit. A logical shift always fills with 0s; only an arithmetic right shift copies the sign bit.',
    fix: 'Fill with 0s unless it is an arithmetic right shift, which copies the sign bit.',
    worked: workedShift('Filling the gap', 'shift_fill', { fill: 'A logical shift always brings in 0s.' }),
  },
  shift_value_myth: {
    label: 'Used ×2ⁿ or ÷2ⁿ though bits fell off',
    student: 'You worked out the value as if the shift multiplied or divided exactly. That only holds when no 1s fall off the end.',
    fix: 'Read the value from the shifted bits, not from multiplying or dividing.',
    worked: workedShift('What a shift does to the value', 'shift_value_myth', {}),
  },
  shift_arith_logical: {
    label: 'Mixed up arithmetic and logical shift',
    student: 'You mixed up the two kinds of right shift. An arithmetic shift copies the sign bit into the gap; a logical shift fills with 0s.',
    fix: 'For a right shift, check the kind first: arithmetic copies the sign bit, logical brings in 0s.',
    worked: workedShift('Arithmetic right shift', 'shift_arith_logical', { fill: 'An arithmetic shift keeps a negative number negative.' }),
  },

  twos_sign_magnitude: {
    label: 'Used sign and magnitude',
    student: "You used the top bit as a plain minus sign. In two's complement the top bit is worth −128 (in 8 bits), so you invert and add 1 instead.",
    fix: 'To make a negative number, write the positive one, invert every bit, then add 1.',
    worked: workedEncode("Writing a negative number in two's complement", 'twos_sign_magnitude', false),
  },
  twos_no_plus1: {
    label: 'Inverted but forgot to add 1',
    student: 'You inverted the bits but did not add 1. That is ones\' complement, and it is always 1 out.',
    fix: 'After inverting every bit, always add 1.',
    worked: workedEncode('Invert, then add 1', 'twos_no_plus1', true),
  },
  twos_msb_positive: {
    label: 'Read the top bit as positive',
    student: 'You counted the top bit as +128 (in 8 bits). In two\'s complement it is worth −128, so a pattern starting with 1 is negative.',
    fix: 'Give the top bit a negative place value, then add the other place values to it.',
    worked: (rng) => {
      const p = twos.generate(rng, { w: 8, target: 'twos_msb_positive' });
      const item = twos.build(p);
      const layers = twos.why(item);
      const b = binStr(toBits(p.n, 8));
      return {
        title: "Reading a negative two's complement number",
        steps: [
          { subgoal: '1. Look at the top bit', text: `${b} starts with 1, so it is negative.` },
          { subgoal: '2. Give the top bit its negative value', text: 'In 8 bits the top bit is worth −128, not +128.' },
          { subgoal: '3. Add the other place values', text: `The other bits add up to ${p.n + 128}, so the value is −128 + ${p.n + 128} = ${num(p.n)}.`, layer: layers[layers.length - 1] },
          { subgoal: '4. Check: invert and add 1', text: layers[0].say.join(' '), layer: layers[0] },
        ],
      };
    },
  },
  twos_range: {
    label: "Wrong two's complement range",
    student: "You gave the wrong range. An 8-bit two's complement number goes from −128 to 127, because zero takes one of the non-negative patterns.",
    fix: 'For w bits the range is −2^(w−1) to 2^(w−1) − 1.',
    worked: (rng) => {
      const p = twos.generate(rng, { target: 'twos_range' });
      const w = p.w;
      const M = 2 ** (w - 1);
      const layers = twos.why(twos.build(p));
      return {
        title: `The range of ${w}-bit two's complement`,
        steps: [
          { subgoal: '1. Find the smallest pattern', text: `The most negative number has only the top bit set: ${binStr(toBits(-M, w))} = ${num(-M)}.`, layer: layers[0] },
          { subgoal: '2. Find the largest pattern', text: `The most positive has every bit set except the top one: ${binStr(toBits(M - 1, w))} = ${M - 1}.` },
          { subgoal: '3. Count the patterns', text: `${2 * M} patterns = ${M} negative + zero + ${M - 1} positive, so the range is ${num(-M)} to ${M - 1}.`, layer: layers[1] },
        ],
      };
    },
  },

  flags_carry_is_overflow: {
    label: 'Confused carry (CF) with overflow (OF)',
    student: 'You treated the carry out as an overflow, or the other way round. The carry flag (CF) is about unsigned numbers; the overflow flag (OF) says whether the signed answer fits.',
    fix: 'Decide CF from the carry out and OF from the signs of the inputs and the result.',
    worked: workedFlags('Carry is not overflow', 'flags_carry_is_overflow', (item, layers) => {
      const s = signedSteps(item, layers);
      return [s.add, s.truth, s.of, s.cf, { subgoal: '5. Keep them apart', text: `Here CF = ${item.sim.CF} but OF = ${item.sim.OF}: a carry out does not mean the signed answer is wrong.` }];
    }),
  },
  flags_signed_overflow_missed: {
    label: 'Missed a signed overflow',
    student: 'You missed that the true answer did not fit in the signed range, so the result wrapped round. That is a signed overflow, even if nothing carries out.',
    fix: 'Two positives giving a negative, or two negatives giving a positive, always means overflow.',
    worked: workedFlags('Spotting signed overflow', 'flags_signed_overflow_missed', (item, layers) => {
      const s = signedSteps(item, layers);
      const adder = layers.find((l) => l.kind === 'adder');
      return [s.add, s.truth, s.of, { subgoal: '4. Confirm in the sign column', text: adder.say[1], layer: adder }];
    }),
  },
  flags_sub_carry: {
    label: 'Misread CF after subtraction',
    student: "You read the carry flag (CF) after a subtraction as the adder's carry out. After a subtraction CF = 1 means a borrow was needed, which is the opposite.",
    fix: 'After a − b, set CF = 1 exactly when a is smaller than b as unsigned numbers.',
    worked: workedFlags('The carry flag after subtraction', 'flags_sub_carry', (item, layers) => {
      const { a, b } = item.params;
      const s = item.sim;
      const ua = a < 0 ? a + 256 : a;
      const ub = b < 0 ? b + 256 : b;
      return [
        { subgoal: '1. Turn it into an addition', text: `The ALU works out ${num(a)} − ${b < 0 ? `(${num(b)})` : num(b)} as ${binStr(s.A)} + ${binStr(s.B)} + 1 (b inverted, plus 1).` },
        { subgoal: '2. Add in columns', text: `The adder gives ${binStr(s.result)} with a carry out of ${s.cout}.`, layer: layers[0] },
        { subgoal: '3. Invert the carry for CF', text: `CF is the borrow, the opposite of the carry out, so CF = ${s.CF}.` },
        { subgoal: '4. Check as unsigned numbers', text: `As unsigned numbers this is ${ua} − ${ub}, which ${s.CF ? 'needs' : 'does not need'} a borrow, so CF = ${s.CF}.`, layer: layers.find((l) => l.kind === 'flags') },
      ];
    }),
  },
};

