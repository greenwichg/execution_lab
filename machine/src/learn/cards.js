// CS:APP cards: twelve classic C-on-x86-64 traps from chapters 2 and 3, each a
// short Mini-C snippet. Every answer key comes from running the snippet on the
// engine (tests re-check it against gcc -O0 -fwrapv), never from a typed key.
// A card states what the C standard says AND what gcc -O0 on x86-64 does,
// because for undefined and implementation-defined cases those differ.
//
// params { id, v }: v = 0 is the canonical card; v > 0 seeds new constants
// that exercise the same concept (see each card's `vary`).
import { compile, run } from '../engine/minic.js';
import { mulberry32, mixSeed, randInt, pick, chance } from '../lib/rng.js';
import {
  normOutput, lineLayer, asmLayer, regsLayer, flagsLayer, flagReasons, columnsLayer, columnsWindow,
  adderLayer, adderWires, signAdderSay, shiftLayer, hexOf, binOf,
} from './paste.js';

export const TYPE = 'card';
export const TYPE_ID = 5;
export const V_MAX = 9999;
export const TARGETS = [
  'c_signed_overflow', 'c_usual_conversions', 'c_promotion', 'c_truncating_division', 'c_shift_negative',
  'c_char_signedness', 'c_unsigned_wrap', 'c_narrowing', 'c_jump_signedness',
];

const FLAGS = ['CF', 'ZF', 'SF', 'OF'];
const INT_MAX = 2147483647;
const s32 = (x) => Number(BigInt.asIntN(32, BigInt(x)));
const u32 = (x) => Number(BigInt.asUintN(32, BigInt(x)));
const s16 = (x) => Number(BigInt.asIntN(16, BigInt(x)));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const ERRORISH = /error|overflow|crash|undefined|exception|infinit|nan|trap|abort|segfault|sigfpe|garbage|random/i;

/** the value of the text the learner typed, if it is a whole number */
const numIn = (g) => (typeof g === 'string' && /^-?\d+$/.test(g) ? Number(g) : typeof g === 'number' ? g : null);
const isNum = (want) => (g) => numIn(g) === want;
const isText = (want) => (g) => g === want;

// ---------------------------------------------------------------------------
// Context helpers: one compiled + traced run per card instance
// ---------------------------------------------------------------------------

const lineOf = (src, needle) => src.split('\n').findIndex((l) => l.includes(needle)) + 1;

/** the nth trace event on `line` whose instruction text matches `re` */
function eventOn(ctx, line, re, nth = 0) {
  const list = ctx.res.events.filter((e) => e.line === line && re.test(e.text));
  return list[nth] || null;
}
const instOf = (ctx, ev) => ctx.prog.insts[ev.i];

/** column labels for a compare's adder window, in cmp order */
const columnLabels = (o) => ({ a: `${o.x}, bits 31–24`, b: `~${o.y}, bits 31–24`, r: `${o.sub}, bits 31–24` });

/**
 * The operand order of a compare: like gcc -O0, the lab compiler turns an unsigned a > b
 * (b not a constant) into b < a, so it runs cmp b, a. Returns the names in cmp order,
 * the unsigned values in that order and the phrase for the subtraction.
 */
function cmpOrder(ctx, cmp, ua, ub) {
  const swapped = !!(instOf(ctx, cmp).alu && instOf(ctx, cmp).alu.swapped);
  const [x, y] = swapped ? ['b', 'a'] : ['a', 'b'];
  const [ux, uy] = swapped ? [ub, ua] : [ua, ub];
  return { swapped, x, y, ux, uy, sub: `${x} − ${y}`, ins: `cmp ${x}, ${y}` };
}

// ---------------------------------------------------------------------------
// The cards, in CS:APP section order
// ---------------------------------------------------------------------------

const DEFS = [
  // ------------------------------------------------------------- 2.2.3
  {
    id: 'char-200', section: '2.2.3', title: 'A char that holds 200', spec: 'CSAPP-2.2',
    tags: ['c_char_signedness', 'c_narrowing'], kind: 'output',
    canon: { n: 200 },
    vary: (rng) => ({ n: randInt(rng, 128, 255) }),
    src: ({ n }) => `char c = ${n};\nprintf("%d\\n", c);`,
    derive(ctx) {
      const { n } = ctx.vals;
      return { line: 1, hot: eventOn(ctx, 2, /^movsx/), val: n - 256, bin: binOf(n, 8) };
    },
    prompt: () => 'What does this program print (gcc -O0 on x86-64)?',
    because: (c) => `A plain char is signed on x86-64 gcc and holds -128 to 127, so ${c.vals.n} keeps just its 8 bits ${c.bin}. Read as two's complement those bits mean ${c.vals.n} − 256 = ${c.val}.`,
    std: (c) => ({
      status: 'implementation-defined',
      text: `C11 6.2.5p15 leaves it to the implementation whether plain char is signed. If it is, storing ${c.vals.n} (too big for it) gives an implementation-defined result or raises an implementation-defined signal (C11 6.3.1.3p3).`,
    }),
    gcc: (c) => `On x86-64 gcc char is signed, so c keeps the 8 bits ${c.bin}, which read as ${c.val}. movsx then sign-extends that byte to an int for printf.`,
    classic: (c) => [
      { match: isNum(c.vals.n), tag: 'c_char_signedness', headline: `You treated char as able to hold ${c.vals.n}.`,
        detail: `On x86-64 gcc a plain char is signed and holds -128 to 127, so ${c.vals.n} is stored as ${c.vals.n} − 256 = ${c.val}.` },
      { match: isNum(127), tag: 'c_narrowing', headline: 'C does not clamp the value at 127.',
        detail: `An out-of-range value keeps its low 8 bits instead: ${c.vals.n} is ${c.bin}, which reads as ${c.val}.` },
      { match: isNum(256 - c.vals.n), tag: 'twos_msb_positive', headline: 'You got the size right but lost the sign.',
        detail: `The top bit of ${c.bin} is worth -128, so the value is ${c.val}, a negative number.` },
    ],
    checkpoints: (c) => [
      { prompt: 'On x86-64 gcc, what is the largest value a plain char can hold?', input: { kind: 'number' }, answer: 127,
        tag: 'c_char_signedness', headline: 'You expected char to hold more than 127.',
        detail: `A plain char is signed on x86-64 gcc, so its range is -128 to 127 and ${c.vals.n} does not fit.` },
      { prompt: `Read the 8 bits ${c.bin} as a two's complement number. What value is it?`, input: { kind: 'number' }, answer: c.val,
        tag: 'twos_msb_positive', headline: 'You read the top bit as +128.',
        detail: `In two's complement the top bit of 8 is worth -128, so ${c.bin} is ${c.val}.` },
    ],
    layers(c) {
      const ins = instOf(c, c.hot);
      return [
        lineLayer(c.src, 1, [
          `char c = ${c.vals.n}; asks for a value that a signed char cannot hold (its range is -128 to 127).`,
          `gcc keeps the low 8 bits, ${c.bin}, which mean ${c.val} as a signed char.`,
        ], 'Line 1 stores the byte; line 2 reads it back for printf.'),
        asmLayer(c.prog, { lines: [1, 2], hot: ins.i, upto: ins.i + 1, say: [
          `The compiler already writes the byte as ${c.val} (${hexOf(c.vals.n, 8)}), then movsx loads it into eax.`,
          'movsx (move with sign extension) copies bit 7 into all 24 upper bits, so the int keeps the same value.',
        ] }),
        regsLayer(c.hot, [
          `eax becomes ${hexOf(c.val, 32)}, which is ${c.val} as an int.`,
          'That int is what printf receives for %d.',
        ], { names: ['rax'] }),
      ];
    },
  },

  // ------------------------------------------------------------- 2.2.5
  {
    id: 'minus-one-vs-unsigned', section: '2.2.5', title: 'Comparing -1 with an unsigned 0', spec: 'CSAPP-2.2',
    tags: ['c_usual_conversions'], kind: 'output',
    canon: { k: 1, m: 0, op: '<' },
    vary: (rng) => ({ k: randInt(rng, 1, 9), m: randInt(rng, 0, 9), op: chance(rng, 0.5) ? '<' : '>' }),
    src: ({ k, m, op }) => `int a = -${k};\nunsigned b = ${m};\nprintf("%d\\n", a ${op} b);`,
    derive(ctx) {
      const { k, m, op } = ctx.vals;
      const ua = 2 ** 32 - k;
      const cmp = eventOn(ctx, 3, /^cmp/);
      const set = eventOn(ctx, 3, /^set/);
      const signedAns = op === '<' ? Number(-k < m) : Number(-k > m);
      return {
        line: 3, cmp, hot: set, ua, signedAns, set: set.text.split(' ')[0], sset: op === '<' ? 'setl' : 'setg',
        truth: op === '<' ? ua < m : ua > m, order: cmpOrder(ctx, cmp, ua, m),
      };
    },
    prompt: () => 'What does this program print (gcc -O0 on x86-64)?',
    because: (c) => `a ${c.vals.op} b mixes int and unsigned int, so a is converted to unsigned int first: -${c.vals.k} becomes ${c.ua}. ${c.ua} ${c.vals.op} ${c.vals.m} is ${c.truth ? 'true' : 'false'}, so it prints ${c.out}.`,
    std: (c) => ({
      status: 'defined',
      text: `The usual arithmetic conversions (C11 6.3.1.8) convert the int to unsigned int, and C11 6.3.1.3p2 turns -${c.vals.k} into ${c.ua}. The comparison is then between two unsigned values, so the result is fully defined.`,
    }),
    // checked against gcc 13 -O0: for unsigned a > b gcc swaps the operands (cmp b, a) and
    // uses setb, and so does this lab's compiler (the Why layers show the same order)
    gcc: (c) => (c.vals.op === '<'
      ? `gcc compares with cmp a, b and turns the flags into 0 or 1 with setb, an unsigned test that reads CF, which gives ${c.out}. A signed comparison would have used setl instead.`
      : `gcc rewrites a > b as b < a, so it runs cmp b, a and then setb, an unsigned test that reads CF, which gives ${c.out}. A signed comparison would have used setg instead.`),
    classic: (c) => [
      { match: isNum(c.signedAns), tag: 'c_usual_conversions', headline: 'You compared them as signed numbers.',
        detail: `When an int meets an unsigned int, C converts the int to unsigned, so -${c.vals.k} becomes ${c.ua}. Then ${c.ua} ${c.vals.op} ${c.vals.m} is ${c.truth ? 'true' : 'false'}.` },
    ],
    checkpoints: (c) => [
      { prompt: `For the comparison, a is converted to unsigned int. What value does -${c.vals.k} become?`, input: { kind: 'number' }, answer: c.ua,
        tag: 'c_usual_conversions', headline: `You missed what -${c.vals.k} becomes as an unsigned int.`,
        detail: `Converting a negative int to unsigned adds 2^32 (4294967296), so -${c.vals.k} becomes ${c.ua}.` },
      { prompt: `Is ${c.ua} ${c.vals.op} ${c.vals.m}? Answer 1 for yes or 0 for no.`, input: { kind: 'bit' }, answer: Number(c.truth),
        tag: 'other', headline: 'The comparison itself went wrong.', detail: `${c.ua} ${c.vals.op} ${c.vals.m} is ${c.truth ? 'true' : 'false'}, and C prints a comparison as 1 or 0.` },
    ],
    layers(c) {
      const { k, m, op } = c.vals;
      const f = c.cmp.flagsAfter;
      const o = c.order;
      const borrow = f.CF ? 'needs a borrow' : 'needs no borrow';
      const setWhy = c.set === 'seta'
        ? `CF = ${f.CF} and ZF = ${f.ZF}: read as unsigned, ${o.ux} − ${o.uy} ${borrow}${f.ZF ? ' and is 0' : ' and is not 0'}, so seta gives ${c.out}.`
        : `CF = ${f.CF}: read as unsigned, ${o.ux} − ${o.uy} ${borrow}, so ${c.set} gives ${c.out}.`;
      const cw = columnsWindow(c.prog, c.cmp, 24);
      return [
        lineLayer(c.src, 3, [
          `a ${op} b compares an int with an unsigned int, so C first converts a to unsigned: -${k} becomes ${c.ua}.`,
          `So the question the machine answers is ${c.ua} ${op} ${m}.`,
        ]),
        asmLayer(c.prog, { lines: 3, hot: instOf(c, c.hot).i, upto: instOf(c, c.hot).i + 1, say: o.swapped ? [
          `Like gcc, this compiler tests a > b as b < a: cmp b, a works out b − a only to set the flags, then ${c.set} turns them into 0 or 1.`,
          `${c.set} ("set if below") is an unsigned test that reads only CF, while a signed comparison would keep the order and use ${c.sset}, which reads ZF, SF and OF.`,
        ] : [
          `cmp works out a − b only to set the flags, then ${c.set} turns them into 0 or 1.`,
          `${c.set} ("set if ${c.set === 'seta' ? 'above' : 'below'}") is an unsigned test that reads CF${c.set === 'seta' ? ' and ZF' : ''}, while the signed ${c.sset} would read ${op === '>' ? 'ZF, SF and OF' : 'SF and OF'}.`,
        ] }),
        regsLayer(c.cmp, [
          `cmp changes no register: eax still holds ${hexOf(-k, 32)}, the bits of -${k}.`,
          `Read as unsigned, those bits are ${c.ua}.`,
        ]),
        flagsLayer(c.prog, c.cmp, [setWhy, `A signed test would see SF = ${f.SF} and OF = ${f.OF} and answer ${c.signedAns} instead.`]),
        columnsLayer(c.prog, c.cmp, 24, [
          `This is the top byte (bits 31–24) of ${o.x} + ~${o.y} + 1, which is how the ALU subtracts; a carry of ${cw.carries[0]} comes in from bit 23.`,
          `The carry out of bit 31 is ${cw.cout}, and after a subtraction CF is its opposite, so CF = ${f.CF}.`,
        ], { labels: columnLabels(o) }),
        adderLayer(c.prog, c.cmp, 31, signAdderSay(c.prog, c.cmp)),
      ];
    },
  },

  // ------------------------------------------------------------- 2.2.6
  {
    id: 'uchar-promotion', section: '2.2.6', title: 'Adding two unsigned chars', spec: 'CSAPP-2.2',
    tags: ['c_promotion'], kind: 'value',
    canon: { a: 200, b: 100 },
    vary: (rng) => { const a = randInt(rng, 130, 255); return { a, b: randInt(rng, 256 - a, 255) }; },
    src: ({ a, b }) => `unsigned char a = ${a};\nunsigned char b = ${b};\nint c = a + b;\nprintf("%d\\n", c);`,
    derive(ctx) {
      const { a, b } = ctx.vals;
      return { line: 3, hot: eventOn(ctx, 3, /^add/), sum: a + b, low: (a + b) & 255, askVar: 'c' };
    },
    prompt: () => 'What value does c hold after line 3?',
    because: (c) => `Before adding, C promotes both unsigned chars to int, so a + b is worked out in 32 bits. ${c.vals.a} + ${c.vals.b} = ${c.sum} fits easily in an int.`,
    std: (c) => ({
      status: 'defined',
      text: `The integer promotions (C11 6.3.1.1p2) convert unsigned char operands to int before +, so a + b is an int. ${c.sum} fits in an int, so c is exactly ${c.sum}.`,
    }),
    gcc: () => 'gcc loads each byte with movzx (zero-extending it to 32 bits) and adds with a 32-bit add. The carry out of bit 7 simply goes into bit 8.',
    classic: (c) => [
      { match: isNum(c.low), tag: 'c_promotion', headline: 'You added in 8 bits.',
        detail: `C promotes unsigned char to int before adding, so nothing is cut off: ${c.vals.a} + ${c.vals.b} = ${c.sum}. Only a store into an 8-bit variable would keep just ${c.low}.` },
      { match: isNum(255), tag: 'c_promotion', headline: 'The sum does not stop at 255.',
        detail: `Both operands become int before the addition, so the sum is ${c.sum}.` },
      { match: isNum(c.sum - 256 >= 128 ? c.sum - 512 : c.sum - 256), tag: 'c_promotion', headline: 'You wrapped the sum into 8 bits.',
        detail: `C promotes both unsigned chars to int first, so the sum ${c.sum} is kept whole.` },
    ],
    checkpoints: () => [
      { prompt: 'Before the addition, C converts a and b to which type?', input: { kind: 'choice', choices: ['unsigned char', 'int', 'unsigned int'] }, answer: 'int',
        tag: 'c_promotion', headline: 'You missed the integer promotions.',
        detail: 'Any char or short operand is promoted to int before arithmetic, and int holds every unsigned char value.' },
    ],
    layers(c) {
      const ins = instOf(c, c.hot);
      const cw = columnsWindow(c.prog, c.hot, 0);
      const d = adderWires(cw.A[7], cw.B[7], cw.carries[7]);
      return [
        lineLayer(c.src, 3, [
          'a + b looks like 8-bit arithmetic, but C first promotes both unsigned chars to int.',
          `So the sum ${c.sum} is computed and stored as an int.`,
        ]),
        asmLayer(c.prog, { lines: 3, hot: ins.i, say: [
          'movzx loads each byte and fills the upper 24 bits of the register with 0s.',
          `${ins.text} then adds two 32-bit values, so the result can go past 255.`,
        ] }),
        regsLayer(c.hot, [
          `eax goes from ${Number(c.hot.before.rax & 0xffffffffn)} to ${Number(c.hot.after.rax & 0xffffffffn)} (${hexOf(c.hot.after.rax, 32)}).`,
          'Bit 8 is now 1, and a 32-bit register has room for it.',
        ]),
        columnsLayer(c.prog, c.hot, 0, [
          `These are bits 7–0 of the add; the carry out of bit 7 is ${cw.cout}.`,
          'Because the add is 32 bits wide, that carry lands in bit 8 instead of being lost.',
        ], { labels: { a: `a = ${c.vals.a}`, b: `b = ${c.vals.b}`, r: `low byte of ${c.sum}` } }),
        adderLayer(c.prog, c.hot, 7, [
          `In bit 7 the full adder gets a = ${d.a}, b = ${d.b} and carry-in ${d.cin}, so sum = ${d.sum} and carry out = ${d.cout}.`,
          'That carry out feeds bit 8 of the 32-bit sum.',
        ]),
      ];
    },
  },

  // ------------------------------------------------------------- 2.2.7
  {
    id: 'short-truncation', section: '2.2.7', title: 'Storing 70000 in a short', spec: 'CSAPP-2.2',
    tags: ['c_narrowing'], kind: 'value',
    canon: { i: 70000 },
    vary: (rng) => ({ i: randInt(rng, 32768, 300000) }),
    src: ({ i }) => `int i = ${i};\nshort s = i;\nprintf("%d\\n", s);`,
    derive(ctx) {
      const { i } = ctx.vals;
      const low = i % 65536;
      return { line: 2, hot: eventOn(ctx, 2, /^mov WORD PTR/), load: eventOn(ctx, 3, /^movsx/), low, s: s16(i), askVar: 's' };
    },
    prompt: () => 'What value does s hold after line 2?',
    because: (c) => `A short has 16 bits, so storing i keeps only its low 16 bits: ${c.vals.i} mod 65536 = ${c.low}. ${c.low >= 32768 ? `Bit 15 is 1, so as a signed short that is ${c.low} − 65536 = ${c.s}.` : `Bit 15 is 0, so s is ${c.s}.`}`,
    std: (c) => ({
      status: 'implementation-defined',
      text: `${c.vals.i} does not fit in a short, and C11 6.3.1.3p3 makes converting it to a signed type implementation-defined (or it may raise a signal).`,
    }),
    gcc: (c) => `gcc documents that it keeps the low 16 bits (reduction modulo 2^16): the store writes only ax, and movsx sign-extends it again for printf. ${c.vals.i} = ${hexOf(c.vals.i, 32)} becomes ${hexOf(c.low, 16)} = ${c.s}.`,
    classic: (c) => [
      { match: isNum(c.vals.i), tag: 'c_narrowing', headline: 'You kept the whole value.',
        detail: `A short has only 16 bits, so it keeps ${c.vals.i} mod 65536 = ${c.low}${c.low >= 32768 ? `, which as a signed short is ${c.s}` : ''}.` },
      { match: isNum(32767), tag: 'c_narrowing', headline: 'C does not clamp the value to the largest short.',
        detail: `The conversion keeps the low 16 bits instead: ${hexOf(c.vals.i, 32)} becomes ${hexOf(c.low, 16)} = ${c.s}.` },
      { match: isNum(c.low), tag: 'twos_msb_positive', headline: 'You read bit 15 as +32768.',
        detail: `A short is signed, so bit 15 is worth -32768 and ${hexOf(c.low, 16)} is ${c.s}.` },
    ],
    checkpoints: (c) => [
      { prompt: 'How many bits does a short have on x86-64?', input: { kind: 'number' }, answer: 16,
        tag: 'c_narrowing', headline: 'You used the wrong size for short.', detail: `A short is 16 bits on x86-64, so it holds -32768 to 32767 and ${c.vals.i} does not fit.` },
      { prompt: `What is ${c.vals.i} mod 65536 (its low 16 bits)?`, input: { kind: 'number' }, answer: c.low,
        tag: 'c_narrowing', headline: 'The low 16 bits went wrong.', detail: `${c.vals.i} = ${Math.floor(c.vals.i / 65536)} × 65536 + ${c.low}, so the low 16 bits are ${c.low}.` },
      ...(c.low >= 32768 ? [{ prompt: `Read ${c.low} as a 16-bit two's complement number. What value is it?`, input: { kind: 'number' }, answer: c.s,
        tag: 'twos_msb_positive', headline: 'You read bit 15 as +32768.', detail: `In a signed 16-bit value bit 15 is worth -32768, so ${c.low} reads as ${c.s}.` }] : []),
    ],
    layers(c) {
      const ins = instOf(c, c.hot);
      const top = c.vals.i >>> 16;
      return [
        lineLayer(c.src, 2, [
          'short s = i; copies a 32-bit int into a 16-bit short.',
          `Only the low 16 bits fit, so s gets ${c.s}.`,
        ]),
        asmLayer(c.prog, { lines: [2, 3], hot: ins.i, upto: instOf(c, c.load).i, say: [
          `${ins.text} stores ax, the low 16 bits of eax, and ignores the rest.`,
          'On line 3 movsx sign-extends those 16 bits back to 32 for printf.',
        ] }),
        regsLayer(c.hot, [
          `eax holds ${c.vals.i} = ${hexOf(c.vals.i, 32)}, but only ax = ${hexOf(c.low, 16)} is written to s.`,
          `The top 16 bits (${hexOf(top, 16)}) are simply dropped.`,
        ], { names: ['rax'] }),
      ];
    },
  },

  // ------------------------------------------------------------- 2.3.1
  {
    id: 'unsigned-wrap', section: '2.3.1', title: 'Unsigned 0 minus 1', spec: 'CSAPP-2.3',
    tags: ['c_unsigned_wrap'], kind: 'output',
    canon: { k: 0, m: 1 },
    vary: (rng) => { const k = randInt(rng, 0, 9); return { k, m: randInt(rng, k + 1, k + 20) }; },
    src: ({ k, m }) => `unsigned u = ${k};\nu = u - ${m};\nprintf("%u\\n", u);`,
    derive(ctx) {
      const { k, m } = ctx.vals;
      return { line: 2, hot: eventOn(ctx, 2, /^sub/), val: 2 ** 32 - (m - k), gap: m - k };
    },
    prompt: () => 'What does this program print (gcc -O0 on x86-64)?',
    because: (c) => `Unsigned arithmetic wraps round modulo 2^32, so ${c.vals.k} − ${c.vals.m} gives 4294967296 − ${c.gap} = ${c.val}.`,
    std: (c) => ({
      status: 'defined',
      text: `C11 6.2.5p9: unsigned arithmetic never overflows, because results are reduced modulo one more than the largest value (2^32 here). So ${c.vals.k} − ${c.vals.m} is exactly ${c.val}.`,
    }),
    gcc: (c) => `gcc uses sub, which wraps ${c.vals.k} − ${c.vals.m} round to ${hexOf(c.val, 32)} and sets CF = 1 to record the borrow. printf's %u shows those bits as ${c.val}.`,
    classic: (c) => [
      { match: isNum(c.vals.k - c.vals.m), tag: 'c_unsigned_wrap', headline: 'You let the unsigned value go negative.',
        detail: `An unsigned int cannot hold a negative number, so ${c.vals.k} − ${c.vals.m} wraps round to 4294967296 − ${c.gap} = ${c.val}.` },
      { match: isNum(0), tag: 'c_unsigned_wrap', headline: 'Unsigned values do not stop at 0.',
        detail: `Going below 0 wraps round to the top of the range, so the result is ${c.val}.` },
      { match: (g) => ERRORISH.test(String(g)), tag: 'c_unsigned_wrap', headline: 'Nothing goes wrong: unsigned arithmetic just wraps.',
        detail: `C defines unsigned arithmetic modulo 2^32, so the result is ${c.val} with no error.` },
      { match: isNum(c.val + 1), tag: 'other', headline: 'You are off by one.',
        detail: `The largest unsigned int is 4294967295 (2^32 − 1), so the answer is 4294967296 − ${c.gap} = ${c.val}.` },
      { match: isNum(4294967295), tag: 'other', headline: 'You wrapped to the maximum but stopped there.',
        detail: `After wrapping from 0 to 4294967295 you still have ${c.gap - 1} more to subtract, giving ${c.val}.` },
    ],
    checkpoints: () => [
      { prompt: 'What is the largest value an unsigned int can hold?', input: { kind: 'number' }, answer: 4294967295,
        tag: 'c_unsigned_wrap', headline: 'You used the wrong maximum for unsigned int.', detail: 'An unsigned int has 32 bits, so it holds 0 to 4294967295 (2^32 − 1).' },
      { prompt: 'What is 0 − 1 in 32-bit unsigned arithmetic?', input: { kind: 'number' }, answer: 4294967295,
        tag: 'c_unsigned_wrap', headline: 'You missed the wrap below 0.', detail: 'Unsigned arithmetic works modulo 2^32, so 0 − 1 wraps round to 4294967295.' },
    ],
    layers(c) {
      const ins = instOf(c, c.hot);
      const cw = columnsWindow(c.prog, c.hot, 24);
      const fr = flagReasons(c.prog, c.hot);
      return [
        lineLayer(c.src, 2, [
          `u - ${c.vals.m} is unsigned arithmetic, which works modulo 2^32.`,
          `${c.vals.k} − ${c.vals.m} would be negative, so it wraps round to ${c.val}.`,
        ]),
        asmLayer(c.prog, { lines: 2, hot: ins.i, say: [
          `${ins.text} subtracts in a 32-bit register; the hardware does the same for signed and unsigned values.`,
          'Only the flags record that the unsigned result wrapped.',
        ] }),
        regsLayer(c.hot, [
          `eax goes from ${hexOf(c.vals.k, 32)} to ${hexOf(c.val, 32)}.`,
          `Read as unsigned, ${hexOf(c.val, 32)} is ${c.val}.`,
        ]),
        flagsLayer(c.prog, c.hot, [fr.CF, `The borrow has nowhere to go, so the result wraps round to ${c.val}.`]),
        columnsLayer(c.prog, c.hot, 24, [
          `This is the top byte (bits 31–24) of u + ~${c.vals.m} + 1, which is how the ALU subtracts; a carry of ${cw.carries[0]} comes in from bit 23.`,
          `The carry out of bit 31 is ${cw.cout}, so CF (the borrow, its opposite) is ${1 - cw.cout}.`,
        ]),
        adderLayer(c.prog, c.hot, 31, signAdderSay(c.prog, c.hot)),
      ];
    },
  },

  // ------------------------------------------------------------- 2.3.2
  {
    id: 'int-max-plus-one', section: '2.3.2', title: 'INT_MAX + 1', spec: 'CSAPP-2.3',
    tags: ['c_signed_overflow'], kind: 'output',
    canon: { x: INT_MAX, d: 1, macro: true },
    vary: (rng) => {
      const x = chance(rng, 0.5) ? INT_MAX - randInt(rng, 0, 5000) : randInt(rng, 1200000000, 2100000000);
      const need = INT_MAX - x + 1;
      return { x, d: chance(rng, 0.5) ? randInt(rng, need, need + 5000) : randInt(rng, need, Math.max(need, 2000000000)), macro: false };
    },
    src: ({ x, d, macro }) => (macro
      ? `#include <limits.h>\nint x = INT_MAX;\nint y = x + ${d};\nprintf("%d\\n", y);`
      : `int x = ${x};\nint y = x + ${d};\nprintf("%d\\n", y);`),
    derive(ctx) {
      const { x, d } = ctx.vals;
      const line = lineOf(ctx.src, 'int y');
      return { line, hot: eventOn(ctx, line, /^add/), sum: x + d, val: s32(x + d) };
    },
    prompt: () => 'What does this program print (gcc -O0 on x86-64)?',
    because: (c) => `${c.vals.x} + ${c.vals.d} = ${c.sum} is bigger than INT_MAX (2147483647), so it does not fit in an int. The add instruction wraps round: ${c.sum} − 4294967296 = ${c.val}.`,
    std: () => ({
      status: 'undefined',
      text: 'C11 6.5p5: if a result is not in the range of its type the behaviour is undefined, and int overflow is exactly that. The standard allows any outcome, including an optimiser assuming it never happens.',
    }),
    gcc: (c) => `At -O0 gcc emits a plain add, which wraps to ${c.val} and sets OF = 1. With optimisation on, gcc may assume signed overflow never happens and do something else.`,
    classic: (c) => [
      { match: isNum(c.sum), tag: 'c_signed_overflow', headline: 'You gave the mathematical answer.',
        detail: `An int holds at most 2147483647, so ${c.sum} cannot fit; the 32-bit add wraps round to ${c.val}.` },
      { match: isNum(INT_MAX), tag: 'c_signed_overflow', headline: 'The value does not stop at INT_MAX.',
        detail: `The hardware does not clamp: the 32-bit add wraps past 2147483647 round to ${c.val}.` },
      { match: (g) => ERRORISH.test(String(g)), tag: 'c_signed_overflow', headline: 'The program does not stop or report an error.',
        detail: `The C standard calls this undefined behaviour, but gcc -O0 just runs add, which quietly wraps to ${c.val}.` },
    ],
    checkpoints: () => [
      { prompt: 'What is the largest value an int can hold?', input: { kind: 'number' }, answer: INT_MAX,
        tag: 'c_signed_overflow', headline: 'You used the wrong maximum for int.', detail: 'An int has 32 bits, so it holds -2147483648 to 2147483647.' },
      { prompt: "In 32-bit two's complement, what comes straight after 2147483647?", input: { kind: 'number' }, answer: -2147483648,
        tag: 'c_signed_overflow', headline: 'You missed the wrap past INT_MAX.',
        detail: 'Adding 1 to 0x7FFFFFFF gives 0x80000000, which is -2147483648 as an int.' },
    ],
    layers(c) {
      const ins = instOf(c, c.hot);
      const cw = columnsWindow(c.prog, c.hot, 24);
      const f = c.hot.flagsAfter;
      return [
        lineLayer(c.src, c.line, [
          `x + ${c.vals.d} is worked out in int, and the true answer ${c.sum} is bigger than INT_MAX (2147483647).`,
          'The C standard calls this undefined, but the machine simply runs an add instruction.',
        ]),
        asmLayer(c.prog, { lines: c.line, hot: ins.i, say: [
          `${ins.text} adds in a 32-bit register, exactly as it would for unsigned numbers.`,
          'The hardware does not know the values are signed; it only records a signed overflow in OF.',
        ] }),
        regsLayer(c.hot, [
          `eax goes from ${hexOf(c.vals.x, 32)} to ${hexOf(c.val, 32)}.`,
          `Read as a signed int, ${hexOf(c.val, 32)} is ${c.val}.`,
        ]),
        flagsLayer(c.prog, c.hot, [
          'OF = 1: two positive numbers gave a negative result, so the signed answer is wrong.',
          `CF = ${f.CF}: ${f.CF ? 'a 1 carried out of bit 31' : 'nothing carried out of bit 31'}, so as unsigned numbers the sum ${f.CF ? 'did not fit' : 'fitted'}.`,
        ]),
        columnsLayer(c.prog, c.hot, 24, [
          `Only the top byte (bits 31–24) is shown; a carry of ${cw.carries[0]} comes in from bit 23.`,
          `The sign column gets carry-in ${cw.carries[7]} but sends out ${cw.cout}, and that mismatch is what sets OF.`,
        ]),
        adderLayer(c.prog, c.hot, 31, signAdderSay(c.prog, c.hot)),
      ];
    },
  },

  // ------------------------------------------------------------- 2.3.5
  {
    id: 'int-multiply-overflow', section: '2.3.5', title: '65536 × 65536 as an int', spec: 'CSAPP-2.3',
    tags: ['c_signed_overflow'], kind: 'output',
    canon: { a: 65536, b: null },
    vary: (rng) => {
      const a = randInt(rng, 40000, 200000);
      const need = Math.floor(INT_MAX / a) + 1;
      return { a, b: randInt(rng, need, need + 60000) };
    },
    src: ({ a, b }) => (b === null
      ? `int a = ${a};\nint b = a * a;\nprintf("%d\\n", b);`
      : `int a = ${a};\nint b = a * ${b};\nprintf("%d\\n", b);`),
    derive(ctx) {
      const { a } = ctx.vals;
      const b = ctx.vals.b ?? a;
      const prod = BigInt(a) * BigInt(b);
      const low = Number(BigInt.asUintN(32, prod));
      return { line: 2, hot: eventOn(ctx, 2, /^imul/), bv: b, prod: prod.toString(), low, val: s32(prod) };
    },
    prompt: () => 'What does this program print (gcc -O0 on x86-64)?',
    because: (c) => `${c.vals.a} × ${c.bv} = ${c.prod} needs more than 32 bits, so imul keeps only the low 32 bits. Read as an int, those bits are ${c.val}.`,
    std: () => ({
      status: 'undefined',
      text: 'C11 6.5p5: a signed int multiplication whose result does not fit is undefined behaviour. The standard puts no requirement on the result.',
    }),
    gcc: (c) => `At -O0 gcc uses imul, which keeps the low 32 bits of the product (${c.val}) and sets CF and OF to 1. An optimising compiler may assume the overflow cannot happen.`,
    classic: (c) => [
      { match: (g) => g === c.prod, tag: 'c_signed_overflow', headline: 'You gave the mathematical answer.',
        detail: `${c.prod} is far outside the int range, so imul keeps only the low 32 bits, which read as ${c.val}.` },
      { match: isNum(INT_MAX), tag: 'c_signed_overflow', headline: 'The value does not stop at INT_MAX.',
        detail: `The hardware keeps the low 32 bits of the product instead, which read as ${c.val}.` },
      { match: (g) => ERRORISH.test(String(g)), tag: 'c_signed_overflow', headline: 'The program does not stop or report an error.',
        detail: `The C standard calls this undefined behaviour, but gcc -O0 just runs imul, which keeps the low 32 bits: ${c.val}.` },
      { match: isNum(c.low), tag: 'twos_msb_positive', headline: 'You read the low 32 bits as unsigned.',
        detail: `b is an int, so bit 31 is worth -2147483648 and ${hexOf(c.low, 32)} is ${c.val}.` },
    ],
    checkpoints: (c) => [
      { prompt: 'What is the largest value an int can hold?', input: { kind: 'number' }, answer: INT_MAX,
        tag: 'c_signed_overflow', headline: 'You used the wrong maximum for int.', detail: 'An int has 32 bits, so it holds -2147483648 to 2147483647.' },
      { prompt: `What are the low 32 bits of ${c.prod}, read as an unsigned number (that is, ${c.prod} mod 4294967296)?`, input: { kind: 'number' }, answer: c.low,
        tag: 'c_signed_overflow', headline: 'You missed that only the low 32 bits are kept.',
        detail: `imul keeps ${c.prod} mod 4294967296 = ${c.low}, and the int reads those bits as ${c.val}.` },
      ...(c.val < 0 ? [{ prompt: `Read ${c.low} as a 32-bit two's complement number. What value is it?`, input: { kind: 'number' }, answer: c.val,
        tag: 'twos_msb_positive', headline: 'You read bit 31 as positive.', detail: `In an int bit 31 is worth -2147483648, so ${c.low} reads as ${c.val}.` }] : []),
    ],
    layers(c) {
      const ins = instOf(c, c.hot);
      return [
        lineLayer(c.src, 2, [
          `The true product ${c.prod} is far bigger than INT_MAX (2147483647).`,
          'The C standard calls this undefined, but the machine simply runs imul.',
        ]),
        asmLayer(c.prog, { lines: 2, hot: ins.i, say: [
          `${ins.text} multiplies two 32-bit values and keeps only the low 32 bits of the product.`,
          'The bits above bit 31 are thrown away; CF and OF say that happened.',
        ] }),
        regsLayer(c.hot, [
          `eax goes from ${hexOf(c.vals.a, 32)} to ${hexOf(c.low, 32)}.`,
          `As an int that is ${c.val}.`,
        ]),
        flagsLayer(c.prog, c.hot, [
          'CF = OF = 1: the full signed product needs more than 32 bits.',
          'After imul the processor leaves SF and ZF undefined, so they are not shown.',
        ]),
      ];
    },
  },

  // ------------------------------------------------------------- 2.3.7
  {
    id: 'negative-shift-right', section: '2.3.7', title: '-8 >> 1', spec: 'CSAPP-2.3',
    // shift_value_myth: "x >> s is x / 2^s in C", which truncates instead of rounding down
    tags: ['c_shift_negative', 'shift_value_myth'], kind: 'output',
    canon: { x: -8, s: 1 },
    vary: (rng) => ({ x: -randInt(rng, 3, 5000), s: randInt(rng, 1, 4) }),
    src: ({ x, s }) => `int x = ${x};\nint y = x >> ${s};\nprintf("%d\\n", y);`,
    derive(ctx) {
      const { x, s } = ctx.vals;
      const p = 2 ** s;
      return { line: 2, hot: eventOn(ctx, 2, /^sar/), p, val: x >> s, logical: x >>> s, trunc: Math.trunc(x / p) };
    },
    prompt: () => 'What does this program print (gcc -O0 on x86-64)?',
    because: (c) => `gcc shifts a negative int with sar, which copies the sign bit into the gap, so the result stays negative. That makes x >> ${c.vals.s} equal to ${c.vals.x} ÷ ${c.p} rounded down: ${c.val}.`,
    std: () => ({
      status: 'implementation-defined',
      text: 'C11 6.5.7p5: if E1 has a signed type and a negative value, the value of E1 >> E2 is implementation-defined.',
    }),
    gcc: (c) => `gcc documents that >> on a negative number acts by sign extension, so it emits sar (arithmetic shift right). The sign bit is copied in and ${c.vals.x} >> ${c.vals.s} is ${c.val}.`,
    classic: (c) => [
      { match: isNum(c.logical), tag: 'c_shift_negative', headline: 'You filled the gap with 0s.',
        detail: `For a negative int gcc uses an arithmetic shift, which copies the sign bit (1) in, so ${c.vals.x} >> ${c.vals.s} is ${c.val}.` },
      { match: isNum(c.trunc), tag: 'shift_value_myth', headline: 'You rounded toward zero, the way C\'s / does.',
        detail: `sar rounds down (toward minus infinity), so ${c.vals.x} >> ${c.vals.s} is ${c.val}, not ${c.trunc}.` },
      { match: isNum(-c.val), tag: 'other', headline: 'The result stays negative.',
        detail: `sar copies the sign bit in, so shifting a negative number right keeps it negative: ${c.val}.` },
    ],
    checkpoints: (c) => [
      { prompt: 'When sar shifts a negative number right, which bit value fills the gap at the top?', input: { kind: 'bit' }, answer: 1,
        tag: 'c_shift_negative', headline: 'You expected 0s to fill the gap.', detail: 'sar is an arithmetic shift: it copies the sign bit, which is 1 for a negative number.' },
      { prompt: `What is ${c.vals.x} ÷ ${c.p} rounded down (toward minus infinity)?`, input: { kind: 'number' }, answer: c.val,
        tag: 'shift_value_myth', headline: 'The rounding went the wrong way.', detail: `An arithmetic right shift rounds down, so ${c.vals.x} >> ${c.vals.s} = ${c.val}.` },
    ],
    layers(c) {
      const ins = instOf(c, c.hot);
      const { s } = c.vals;
      return [
        lineLayer(c.src, 2, [
          `x is a negative int, so how x >> ${s} fills the top bits decides the answer.`,
          'On x86-64 gcc it copies the sign bit, so the value stays negative.',
        ]),
        asmLayer(c.prog, { lines: 2, hot: ins.i, say: [
          `${ins.text} is an arithmetic shift right: it shifts every bit ${plural(s, 'place')} right.`,
          'It copies the sign bit into the gap, where shr would put 0s.',
        ] }),
        regsLayer(c.hot, [
          `eax goes from ${hexOf(c.vals.x, 32)} (${c.vals.x}) to ${hexOf(c.val, 32)} (${c.val}).`,
          'The top bits stay 1, so the value stays negative.',
        ]),
        shiftLayer(c.prog, c.hot, [
          `sar moves every bit ${plural(s, 'place')} right and copies the sign bit (1) into the top.`,
          'The bits that fall off the right end are the part rounded away, which is why the result rounds down.',
        ]),
      ];
    },
  },

  {
    id: 'truncating-division', section: '2.3.7', title: '7 / -2 and -7 % 2', spec: 'CSAPP-2.3',
    tags: ['c_truncating_division'], kind: 'output',
    canon: { a: 7, b: -2, c: -7, d: 2 },
    vary: (rng) => {
      let a, b, c, d;
      do { a = randInt(rng, 5, 99); b = -randInt(rng, 2, 9); } while (a % b === 0);
      do { c = -randInt(rng, 5, 99); d = randInt(rng, 2, 9); } while (c % d === 0);
      return { a, b, c, d };
    },
    // d is a variable, not a constant: for c % 2 (or any constant) gcc -O0 avoids
    // idiv and uses shifts or a multiply, and the gcc text below talks about idiv
    src: ({ a, b, c, d }) => `int a = ${a};\nint b = ${b};\nint c = ${c};\nint d = ${d};\nprintf("%d %d\\n", a / b, c % d);`,
    derive(ctx) {
      const { a, b, c, d } = ctx.vals;
      const q = Math.trunc(a / b), r = c % d;
      const line = lineOf(ctx.src, 'printf');
      return {
        line, hot: eventOn(ctx, line, /^idiv/, 0), rem: eventOn(ctx, line, /^idiv/, 1), q, r,
        fq: Math.floor(a / b), fr: ((c % d) + d) % d, qr: a % b, cq: Math.trunc(c / d),
      };
    },
    prompt: () => 'What does this program print (gcc -O0 on x86-64)?',
    because: (c) => `C division truncates toward zero, so ${c.vals.a} / ${c.vals.b} drops the fraction and gives ${c.q}, not ${c.fq}. The remainder takes the sign of the number being divided, so ${c.vals.c} % ${c.vals.d} is ${c.r}.`,
    std: () => ({
      status: 'defined',
      text: 'Since C99 (C11 6.5.5p6) integer division discards the fractional part, which is truncation toward zero, and (a/b)*b + a%b equals a. So the remainder has the sign of the dividend.',
    }),
    gcc: () => 'gcc uses cdq and idiv, which truncates toward zero and leaves the quotient in eax and the remainder in edx. The two printed values come straight from those registers.',
    classic: (c) => [
      { match: isText(`${c.fq} ${c.fr}`), tag: 'c_truncating_division', headline: 'You rounded down, the way maths (or Python) does.',
        detail: `C truncates toward zero, so ${c.vals.a} / ${c.vals.b} is ${c.q} and ${c.vals.c} % ${c.vals.d} is ${c.r}, with the sign of the number being divided.` },
      { match: isText(`${c.fq} ${c.r}`), tag: 'c_truncating_division', headline: 'You rounded the quotient down.',
        detail: `C division truncates toward zero, so ${c.vals.a} / ${c.vals.b} is ${c.q}, not ${c.fq}.` },
      { match: isText(`${c.q} ${c.fr}`), tag: 'c_truncating_division', headline: 'You gave a positive remainder.',
        detail: `In C the remainder has the sign of the number being divided, so ${c.vals.c} % ${c.vals.d} is ${c.r}.` },
      { match: isText(`${-c.q} ${-c.r}`), tag: 'other', headline: 'The signs went wrong.',
        detail: `A positive divided by a negative is negative, so ${c.vals.a} / ${c.vals.b} is ${c.q}; ${c.vals.c} % ${c.vals.d} takes the sign of ${c.vals.c} and is ${c.r}.` },
    ],
    checkpoints: (c) => [
      { prompt: `What is ${c.vals.a} / ${c.vals.b} in C?`, input: { kind: 'number' }, answer: c.q,
        tag: 'c_truncating_division', headline: 'The quotient went wrong.', detail: `C division truncates toward zero, so ${c.vals.a} / ${c.vals.b} is ${c.q}.` },
      { prompt: `What is ${c.vals.c} % ${c.vals.d} in C?`, input: { kind: 'number' }, answer: c.r,
        tag: 'c_truncating_division', headline: 'The remainder went wrong.', detail: `${c.vals.c} / ${c.vals.d} truncates to ${c.cq}, so the remainder is ${c.vals.c} − (${c.cq} × ${c.vals.d}) = ${c.r}.` },
    ],
    layers(c) {
      const ins = instOf(c, c.hot), ins2 = instOf(c, c.rem);
      return [
        lineLayer(c.src, c.line, [
          'Both / and % here mix a positive and a negative number, so the rounding rule decides the answer.',
          'C rounds the quotient toward zero, and the remainder follows from it.',
        ]),
        asmLayer(c.prog, { lines: c.line, hot: ins.i, upto: ins2.i + 1, say: [
          'cdq copies the sign bit of eax into every bit of edx, making the 64-bit dividend edx:eax.',
          'idiv divides it, putting the quotient (rounded toward zero) in eax and the remainder in edx.',
        ] }),
        regsLayer(c.hot, [
          `After ${ins.text}, eax holds ${c.q} and edx holds ${c.qr}.`,
          `Check: ${c.vals.a} = ${c.vals.b} × ${c.q} + ${c.qr}.`,
        ], { names: ['rax', 'rdx'] }),
        regsLayer(c.rem, [
          `For ${c.vals.c} % ${c.vals.d}, idiv gives the quotient ${c.cq} in eax and the remainder ${c.r} in edx.`,
          'This lab\'s compiler then copies edx into eax, because % wants the remainder.',
        ], { id: 'regs-rem', title: 'Registers for %', names: ['rax', 'rdx'] }),
      ];
    },
  },

  // ------------------------------------------------------------- 3.5.3
  {
    id: 'unsigned-shift-right', section: '3.5.3', title: 'Shifting an unsigned value right', spec: 'CSAPP-3.5',
    tags: ['shift_arith_logical'], kind: 'output',
    canon: { u: 0xFFFFFFF8, s: 1 },
    vary: (rng) => ({ u: 0xFFFFFFFF - randInt(rng, 0, 0x7FFFFFFF), s: randInt(rng, 1, 4) }),
    src: ({ u, s }) => `unsigned u = 0x${u.toString(16).toUpperCase()}u;\nunsigned v = u >> ${s};\nprintf("%u\\n", v);`,
    derive(ctx) {
      const { u, s } = ctx.vals;
      const p = 2 ** s;
      return {
        line: 2, hot: eventOn(ctx, 2, /^shr/), p, hex: `0x${u.toString(16).toUpperCase()}`,
        val: u >>> s, arith: (u | 0) >> s, arithU: ((u | 0) >> s) >>> 0,
      };
    },
    prompt: () => 'What does this program print (gcc -O0 on x86-64)?',
    because: (c) => `u is unsigned, so >> is a logical shift: 0s fill the gap at the top. ${c.hex} >> ${c.vals.s} is ${c.vals.u} ÷ ${c.p} rounded down, which is ${c.val}.`,
    std: (c) => ({
      status: 'defined',
      text: `C11 6.5.7p5: for an unsigned E1, E1 >> E2 is the integral part of E1 / 2^E2. So the result is fully defined: ${c.val}.`,
    }),
    gcc: (c) => `gcc uses shr (logical shift right), which fills the top bits with 0s. So bit 31 of the result is 0 and v is ${c.val}.`,
    classic: (c) => [
      { match: isNum(c.arith), tag: 'shift_arith_logical', headline: 'You used an arithmetic shift.',
        detail: `u is unsigned, so gcc uses shr, which shifts 0s in at the top; the result is ${c.val}, a large positive number.` },
      { match: isNum(c.arithU), tag: 'shift_arith_logical', headline: 'You copied the top bit into the gap.',
        detail: `Only a signed shift (sar) copies the sign bit; for an unsigned value shr puts 0s in, giving ${c.val}.` },
    ],
    checkpoints: (c) => [
      { prompt: 'Which bit value does shr put into bit 31?', input: { kind: 'bit' }, answer: 0,
        tag: 'shift_arith_logical', headline: 'You expected the sign bit to be copied.', detail: 'shr is a logical shift: it always fills the gap with 0s.' },
      { prompt: `What is ${c.vals.u} ÷ ${c.p}, rounded down?`, input: { kind: 'number' }, answer: c.val,
        tag: 'other', headline: 'The division by a power of 2 went wrong.', detail: `For an unsigned value, >> ${c.vals.s} is ÷ ${c.p} rounded down, which is ${c.val}.` },
    ],
    layers(c) {
      const ins = instOf(c, c.hot);
      const { s } = c.vals;
      return [
        lineLayer(c.src, 2, [
          `u is unsigned, so u >> ${s} is a logical shift.`,
          `Its top bit is 1, but that bit means 2147483648 here, not a sign.`,
        ]),
        asmLayer(c.prog, { lines: 2, hot: ins.i, say: [
          `${ins.text} is a logical shift right: every bit moves ${plural(s, 'place')} right.`,
          'It fills the gap with 0s, where sar would copy the top bit.',
        ] }),
        regsLayer(c.hot, [
          `eax goes from ${hexOf(c.vals.u, 32)} to ${hexOf(c.val, 32)}.`,
          `Read as unsigned that is ${c.val}.`,
        ]),
        shiftLayer(c.prog, c.hot, [
          `shr moves every bit ${plural(s, 'place')} right and puts 0s in at the top.`,
          'The bits that fall off the right end are lost, so the value is divided and rounded down.',
        ]),
      ];
    },
  },

  // ------------------------------------------------------------- 3.6
  {
    id: 'signed-unsigned-branch', section: '3.6', title: 'Which branch runs?', spec: 'CSAPP-3.6',
    tags: ['c_jump_signedness', 'c_usual_conversions'], kind: 'branch',
    canon: { k: 1, m: 1, op: '<' },
    vary: (rng) => ({ k: randInt(rng, 1, 50), m: randInt(rng, 0, 50), op: chance(rng, 0.5) ? '<' : '>' }),
    src: ({ k, m, op }) => {
      const [m1, m2] = op === '<' ? ['less', 'not less'] : ['greater', 'not greater'];
      return `int a = -${k};\nunsigned b = ${m};\nif (a ${op} b)\n  printf("${m1}\\n");\nelse\n  printf("${m2}\\n");`;
    },
    derive(ctx) {
      const { k, m, op } = ctx.vals;
      const cmp = eventOn(ctx, 3, /^cmp/);
      const jmp = eventOn(ctx, 3, /^j(?!mp)/);
      const j = jmp.text.split(' ')[0];
      const ua = 2 ** 32 - k;
      const order = cmpOrder(ctx, cmp, ua, m);
      // the jump a signed comparison would use: it keeps the order (cmp a, b), so a < b skips with
      // jge and a > b with jle; it jumps (skips the first message) when the signed test is false
      const sj = op === '<' ? 'jge' : 'jle';
      const signedTaken = !(op === '<' ? -k < m : -k > m);
      return {
        line: 3, cmp, hot: jmp, j, sj, ua, taken: takenOf(ctx, jmp), order,
        signedTaken, msgs: op === '<' ? ['less', 'not less'] : ['greater', 'not greater'], truth: op === '<' ? ua < m : ua > m,
      };
    },
    prompt: () => 'Which message does this program print (gcc -O0 on x86-64)?',
    because: (c) => `b is unsigned, so a is converted to unsigned int for the test and -${c.vals.k} becomes ${c.ua}. ${c.ua} ${c.vals.op} ${c.vals.m} is ${c.truth ? 'true' : 'false'}, so the program prints "${c.out}".`,
    std: (c) => ({
      status: 'defined',
      text: `By the usual arithmetic conversions (C11 6.3.1.8) a is converted to unsigned int, so -${c.vals.k} becomes ${c.ua}. The if then tests ${c.ua} ${c.vals.op} ${c.vals.m}, which is fully defined.`,
    }),
    // checked against gcc 13 -O0: gcc prints jae as jnb (the same instruction), and for
    // unsigned a > b it swaps the operands (cmp b, a) and uses jnb instead of jbe
    gcc: (c) => (c.vals.op === '<'
      ? `Because the comparison is unsigned, gcc skips the first branch with jnb (jump if not below, taken when CF = 0; the same instruction as jae) rather than the signed jge. After cmp a, b, CF = ${c.cmp.flagsAfter.CF}, so the jump is ${c.taken ? 'taken' : 'not taken'} and "${c.out}" is printed.`
      : `gcc rewrites a > b as b < a, runs cmp b, a and skips the first branch with the unsigned jnb (jump if not below, taken when CF = 0) rather than the signed jle. Read as unsigned, ${c.vals.m} − ${c.ua} borrows, so CF = 1, jnb is not taken and "${c.out}" is printed.`),
    classic: () => [],
    checkpoints: (c) => [
      { prompt: `Line 3 compiles to cmp and then a jump that skips the "${c.msgs[0]}" message. Which jump does this lab's compiler use?`,
        input: { kind: 'choice', choices: [c.sj, c.j] }, answer: c.j,
        tag: 'c_jump_signedness', headline: 'You expected a signed jump.',
        detail: `b is unsigned, so the comparison is unsigned and the compiler uses ${c.j}, which reads ${c.j === 'jbe' ? 'CF and ZF' : 'CF'}; the signed ${c.sj} would read ${c.sj === 'jle' ? 'ZF, SF and OF' : 'SF and OF'}.` },
      { prompt: `For the test, a is converted to unsigned int. What value does -${c.vals.k} become?`, input: { kind: 'number' }, answer: c.ua,
        tag: 'c_usual_conversions', headline: `You missed what -${c.vals.k} becomes as an unsigned int.`,
        detail: `Converting a negative int to unsigned adds 2^32 (4294967296), so -${c.vals.k} becomes ${c.ua}.` },
      { prompt: `Straight after ${c.order.ins} (which works out ${c.order.sub}), what is CF?`, input: { kind: 'bit' }, answer: c.cmp.flagsAfter.CF,
        tag: 'flags_sub_carry', headline: 'You misread CF after cmp.',
        detail: `cmp subtracts ${c.order.y} from ${c.order.x}, and CF is the borrow: read as unsigned, ${c.order.ux} − ${c.order.uy} ${c.cmp.flagsAfter.CF ? 'needs one' : 'needs none'}, so CF = ${c.cmp.flagsAfter.CF}.` },
    ],
    // used only when at least one checkpoint was answered correctly (see diagnose)
    fallback: (c) => ({ tag: 'c_jump_signedness', headline: 'You know the pieces; put them together.',
      detail: `${c.j} ${c.taken ? 'is taken' : 'is not taken'} because CF = ${c.cmp.flagsAfter.CF}, so the program prints "${c.out}".` }),
    layers(c) {
      const { k, m, op } = c.vals;
      const f = c.cmp.flagsAfter;
      const o = c.order;
      const cw = columnsWindow(c.prog, c.cmp, 24);
      const ins = instOf(c, c.hot);
      return [
        lineLayer(c.src, 3, [
          `a ${op} b compares an int with an unsigned int, so the int is converted: -${k} becomes ${c.ua}.`,
          `The if therefore tests ${c.ua} ${op} ${m}, which is ${c.truth ? 'true' : 'false'}.`,
        ]),
        asmLayer(c.prog, { lines: 3, hot: ins.i, upto: ins.i, say: [
          o.swapped
            ? `Like gcc, this compiler tests a > b as b < a: cmp b, a sets the flags from b − a, then ${c.j} decides whether to skip the "${c.msgs[0]}" branch.`
            : `cmp sets the flags from a − b, then ${c.j} decides whether to skip the "${c.msgs[0]}" branch.`,
          `${c.j} is an unsigned jump that reads CF${c.j === 'jbe' ? ' and ZF' : ''}, while a signed comparison would ${o.swapped ? 'keep the order and ' : ''}use ${c.sj}, which reads ${c.sj === 'jle' ? 'ZF, SF and OF' : 'SF and OF'}.`,
        ] }),
        regsLayer(c.cmp, [
          `cmp changes no register: eax holds ${hexOf(-k, 32)}, the bits of -${k}.`,
          'The flags are its only output.',
        ]),
        flagsLayer(c.prog, c.cmp, [
          `CF = ${f.CF}${c.j === 'jbe' ? ` and ZF = ${f.ZF}` : ''}: read as unsigned, ${o.ux} − ${o.uy} ${f.CF ? 'needs a borrow' : 'needs no borrow'}${c.j === 'jbe' ? (f.ZF ? ' and is 0' : ' and is not 0') : ''}, so ${c.j} is ${c.taken ? 'taken' : 'not taken'}.`,
          o.swapped
            ? `As signed ints -${k} ${op} ${m} is ${c.signedTaken ? 'false' : 'true'}, so the signed ${c.sj} (after cmp a, b) ${c.signedTaken ? 'would have been taken' : 'would not have been taken'}.`
            : `SF = ${f.SF} and OF = ${f.OF}, so the signed ${c.sj} ${c.signedTaken ? 'would have been taken' : 'would not have been taken'}.`,
        ]),
        columnsLayer(c.prog, c.cmp, 24, [
          `This is the top byte (bits 31–24) of ${o.x} + ~${o.y} + 1, which is how cmp subtracts; a carry of ${cw.carries[0]} comes in from bit 23.`,
          `The carry out of bit 31 is ${cw.cout}, so CF (the borrow, its opposite) is ${f.CF}.`,
        ], { labels: columnLabels(o) }),
        adderLayer(c.prog, c.cmp, 31, signAdderSay(c.prog, c.cmp)),
      ];
    },
  },

  // ------------------------------------------------------------- 3.6.1
  {
    id: 'flags-after-cmp', section: '3.6.1', title: 'The flags after cmp', spec: 'CSAPP-3.6',
    tags: ['flags_sub_carry', 'flags_signed_overflow_missed', 'flags_carry_is_overflow'], kind: 'flags',
    canon: { a: -3, b: 5 },
    vary: (rng) => {
      switch (randInt(rng, 0, 6)) {
        case 0: { const a = randInt(rng, 1, 50); return { a, b: randInt(rng, a + 1, 99) }; }
        case 1: return { a: -randInt(rng, 1, 99), b: randInt(rng, 1, 99) };
        case 2: { const a = randInt(rng, -99, 99); return { a, b: a }; }
        case 3: return { a: randInt(rng, 1, 99), b: -randInt(rng, 1, 99) };
        case 4: { const a = randInt(rng, 2000000000, INT_MAX); return { a, b: -randInt(rng, INT_MAX - a + 1, 2000000000) }; }
        case 5: { const a = -randInt(rng, 1500000000, 2100000000); return { a, b: randInt(rng, a + 2147483649, 2000000000) }; }
        default: { const b = randInt(rng, 1, 50); return { a: randInt(rng, b + 1, 99), b }; }
      }
    },
    src: ({ a, b }) => `int a = ${a};\nint b = ${b};\nif (a < b)\n  printf("yes\\n");`,
    derive(ctx) {
      const { a, b } = ctx.vals;
      const cmp = eventOn(ctx, 3, /^cmp/);
      const f = cmp.flagsAfter;
      return { line: 3, cmp, hot: cmp, diff: a - b, r32: s32(a - b), ua: u32(a), ub: u32(b), jge: eventOn(ctx, 3, /^jge/), taken: f.SF === f.OF };
    },
    prompt: () => 'Line 3 compiles to cmp, which works out a − b and sets the flags. What are CF, ZF, SF and OF just after it?',
    because: (c) => `The ALU works out ${c.vals.a} − ${c.vals.b}${c.cmp.flagsAfter.OF ? `, whose true value ${c.diff} does not fit in an int, so it wraps to ${c.r32}` : ` = ${c.r32}`}. CF comes from the unsigned reading (${c.ua} − ${c.ub}), OF from the signed one.`,
    std: () => ({
      status: 'defined',
      text: 'Comparing two ints with < is fully defined (C11 6.5.8), and the comparison itself never overflows in C. The flags belong to the processor, not to C.',
    }),
    gcc: (c) => {
      const f = c.cmp.flagsAfter;
      return `gcc compiles if (a < b) to cmp followed by jge, which skips the body when SF = OF. Here CF = ${f.CF}, ZF = ${f.ZF}, SF = ${f.SF} and OF = ${f.OF}, so jge is ${c.taken ? 'taken' : 'not taken'}.`;
    },
    classic: () => [],
    checkpoints: () => [],
    layers(c, diag) {
      const f = c.cmp.flagsAfter;
      const fr = flagReasons(c.prog, c.cmp);
      const cw = columnsWindow(c.prog, c.cmp, 24);
      const ins = instOf(c, c.cmp);
      const focus = diag?.focus?.flag;
      const say = focus && fr[focus] ? [fr[focus], focus === 'CF' ? fr.OF : fr.CF] : [fr.CF, fr.OF];
      return [
        lineLayer(c.src, 3, [
          `a < b compares two ints, so the machine works out a − b = ${c.vals.a} − ${c.vals.b} just to set the flags.`,
          `The 32-bit result is ${c.r32}${f.OF ? `, not the true ${c.diff}` : ''}.`,
        ]),
        asmLayer(c.prog, { lines: 3, hot: ins.i, upto: ins.i + 1, say: [
          `${ins.text} subtracts without storing the result; only CF, ZF, SF and OF change.`,
          'jge then reads SF and OF to decide whether to skip the body.',
        ] }),
        regsLayer(c.cmp, [
          `cmp changes no register: eax holds ${hexOf(c.vals.a, 32)} (a).`,
          'Its only output is the flags.',
        ]),
        flagsLayer(c.prog, c.cmp, say),
        columnsLayer(c.prog, c.cmp, 24, [
          `This is the top byte (bits 31–24) of a + ~b + 1, which is how cmp subtracts; a carry of ${cw.carries[0]} comes in from bit 23.`,
          `The sign column gets carry-in ${cw.carries[7]} and sends out ${cw.cout}, so OF = ${cw.carries[7] ^ cw.cout} and CF = ${1 - cw.cout}.`,
        ]),
        adderLayer(c.prog, c.cmp, 31, signAdderSay(c.prog, c.cmp)),
      ];
    },
  },
];


/** whether a conditional jump event was taken: the next event is not the fall-through */
function takenOf(ctx, jmp) {
  const evs = ctx.res.events;
  const at = evs.indexOf(jmp);
  const next = evs[at + 1];
  return !!next && next.i !== jmp.i + 1;
}

export const CARDS = DEFS.map((d) => ({ id: d.id, section: `CS:APP ${d.section}`, title: d.title, spec: d.spec, tags: d.tags.slice(), ask: d.kind }));

// ---------------------------------------------------------------------------
// Item interface
// ---------------------------------------------------------------------------

function defFor(id) {
  const i = DEFS.findIndex((d) => d.id === id);
  if (i < 0) throw new Error(`unknown card: ${id}`);
  return { def: DEFS[i], index: i };
}

function valsFor(def, v) {
  if (!v) return { ...def.canon };
  return def.vary(mulberry32(mixSeed('card', def.id, v)));
}

function context(def, vals) {
  const src = def.src(vals);
  const prog = compile(src);
  const res = run(prog, { trace: true });
  const ctx = { vals, src, prog, res, out: normOutput(res.output) };
  const extra = def.derive(ctx);
  for (const k of Object.keys(extra)) if (k in ctx) throw new Error(`card ${def.id}: derive() may not replace ctx.${k}`);
  Object.assign(ctx, extra);
  return ctx;
}

function askFor(def, ctx) {
  switch (def.kind) {
    case 'value': return { kind: 'value', var: ctx.askVar, line: ctx.line };
    case 'flags': return { kind: 'flags', line: ctx.line, text: ctx.cmp.text, flags: FLAGS.slice() };
    case 'branch': return { kind: 'branch', line: ctx.line, choices: ctx.msgs.slice() };
    default: return { kind: 'output' };
  }
}

function fieldFor(ask) {
  switch (ask.kind) {
    case 'value': return { id: 'value', kind: 'number', label: `Value of ${ask.var}` };
    case 'flags': return { id: 'flags', kind: 'flags', label: 'Flags after cmp', flags: FLAGS.slice() };
    case 'branch': return { id: 'branch', kind: 'choice', label: 'Message printed', choices: ask.choices.slice() };
    default: return { id: 'output', kind: 'text', label: 'Output', multiline: true, rows: 2 };
  }
}

function keyFor(ctx, ask) {
  switch (ask.kind) {
    case 'value': {
      const v = ctx.prog.vars.find((x) => x.name === ask.var);
      return { value: Number(ctx.res.finalVars.get(v.id)) };
    }
    case 'flags': { const f = ctx.cmp.flagsAfter; return { flags: { CF: f.CF, ZF: f.ZF, SF: f.SF, OF: f.OF } }; }
    case 'branch': return { branch: ctx.out };
    default: return { output: ctx.out };
  }
}

const cache = new Map();

export function build(params) {
  const { def } = defFor(params.id);
  const v = params.v | 0;
  const ck = `${def.id}|${v}`;
  if (cache.has(ck)) return cache.get(ck);
  const ctx = context(def, valsFor(def, v));
  const ask = askFor(def, ctx);
  const item = {
    type: TYPE,
    params: { id: def.id, v },
    level: 'csapp',
    spec: def.spec,
    prompt: def.prompt(ctx),
    show: { src: ctx.src, lines: ctx.src.split('\n'), section: `CS:APP ${def.section}`, title: def.title, focusLine: ctx.line },
    fields: [fieldFor(ask)],
    key: keyFor(ctx, ask),
    family: 'c',
    card: {
      id: def.id, section: `CS:APP ${def.section}`, title: def.title, src: ctx.src, ask,
      std: def.std(ctx), gcc: def.gcc(ctx),
    },
    sim: ctx,
  };
  if (cache.size > 200) cache.clear();
  cache.set(ck, item);
  return item;
}

export function blank(item) {
  const f = item.fields[0];
  if (f.kind === 'flags') return { flags: { CF: null, ZF: null, SF: null, OF: null } };
  return { [f.id]: null };
}

/** the learner's answer in a comparable form (null when empty) */
function given(item, answer) {
  const f = item.fields[0];
  const raw = answer?.[f.id];
  if (raw === null || raw === undefined) return null;
  if (f.kind === 'text') { const s = normOutput(raw); return s === '' ? null : s; }
  if (f.kind === 'number') {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    const t = String(raw).trim().replace(/[−–]/g, '-');
    return /^-?\d+$/.test(t) ? Number(t) : null;
  }
  return raw;
}

/** a flag bit as 0 | 1 | null: the UI sends numbers, but '1' or true from a hand-built answer means the same */
const bitOf = (x) => (x === 1 || x === '1' || x === true ? 1 : x === 0 || x === '0' || x === false ? 0 : null);
/** the learner's four flags, normalised */
const flagsGiven = (answer) => {
  const raw = answer && typeof answer.flags === 'object' && answer.flags ? answer.flags : {};
  return Object.fromEntries(FLAGS.map((n) => [n, bitOf(raw[n])]));
};

const st = (got, want) => (got === null || got === undefined ? 'missing' : got === want ? 'ok' : 'bad');

export function mark(item, answer) {
  const f = item.fields[0];
  if (f.kind === 'flags') {
    const got = flagsGiven(answer);
    const cells = FLAGS.map((n) => st(got[n], item.key.flags[n]));
    const right = cells.filter((s) => s === 'ok').length;
    const wrongAt = cells.findIndex((s) => s !== 'ok');
    return { correct: right === 4, cells: { flags: cells }, firstWrong: wrongAt < 0 ? null : { field: 'flags', index: wrongAt }, score: { right, total: 4 } };
  }
  const g = given(item, answer);
  const s = st(g, item.key[f.id]);
  return { correct: s === 'ok', cells: { [f.id]: s }, firstWrong: s === 'ok' ? null : { field: f.id, index: 0 }, score: { right: s === 'ok' ? 1 : 0, total: 1 } };
}

/** does a checkpoint reply match? numbers may arrive as text ('-56', '−56'), bits as '1' or true */
function sameReply(input, got, want) {
  if (input.kind === 'bit') return bitOf(got) === want;
  if (input.kind === 'number') {
    const t = typeof got === 'number' ? got : String(got).trim().replace(/[−–]/g, '-');
    return typeof t === 'number' ? t === want : /^-?\d+$/.test(t) && Number(t) === want;
  }
  return got === want;
}

const finish = (tag, headline, detail, focus) => ({ next: null, diagnosis: { tag, headline, detail, focus } });

function flagsDiagnosis(item, answer, ctx) {
  const key = item.key.flags;
  const got = flagsGiven(answer);
  const fr = flagReasons(ctx.prog, ctx.cmp);
  const known = (n) => got[n] !== null;
  const wrong = (n) => known(n) && got[n] !== key[n];
  const focus = (n) => ({ line: ctx.line, field: 'flags', flag: n, index: FLAGS.indexOf(n) });
  const { a, b } = ctx.vals;
  if (wrong('CF') && wrong('OF') && got.CF === key.OF && got.OF === key.CF) {
    return finish('flags_carry_is_overflow', 'You swapped CF and OF.',
      `CF is about the unsigned reading (${ctx.ua} − ${ctx.ub}) and is ${key.CF}; OF says whether the signed answer fits and is ${key.OF}.`, focus('OF'));
  }
  if (wrong('OF')) {
    if (key.OF === 1) {
      return finish('flags_signed_overflow_missed', 'You missed the signed overflow.',
        `The true answer ${a} − ${b} = ${ctx.diff} does not fit in an int, so the result wraps to ${ctx.r32} and OF = 1.`, focus('OF'));
    }
    if (key.CF === 1) {
      return finish('flags_carry_is_overflow', 'You treated the borrow as an overflow.',
        `CF = 1 says the unsigned subtraction borrowed, but the signed answer ${ctx.diff} fits in an int, so OF = 0.`, focus('OF'));
    }
    return finish('other', 'Your OF is not right.', fr.OF, focus('OF'));
  }
  if (wrong('CF')) {
    return finish('flags_sub_carry', 'You misread CF after cmp.',
      `After a subtraction CF is the borrow of the unsigned reading: ${ctx.ua} − ${ctx.ub} ${key.CF ? 'needs a' : 'needs no'} borrow, so CF = ${key.CF}. Whether a < b as signed ints is a job for SF and OF.`, focus('CF'));
  }
  const n = FLAGS.find((x) => wrong(x));
  if (n) return finish('other', `Your ${n} is not right.`, fr[n], focus(n));
  const e = FLAGS.find((x) => !known(x));
  return finish(null, `You didn't give ${e}.`, fr[e], focus(e));
}

export function diagnose(item, answer, marking, cpAnswers = []) {
  const m = marking || mark(item, answer);
  const { def } = defFor(item.params.id);
  const ctx = item.sim;
  const focus = { line: ctx.line, field: item.fields[0].id };
  if (m.correct) return finish(null, 'Correct.', def.because(ctx), focus);
  if (def.kind === 'flags') return flagsDiagnosis(item, answer, ctx);
  const g = given(item, answer);
  if (g === null) return finish(null, "You didn't give an answer.", def.because(ctx), focus);
  const right = item.key[item.fields[0].id];
  for (const c of def.classic(ctx)) {
    if (c.match(right)) continue;               // never "recognise" the right answer as a mistake
    if (c.match(g)) return finish(c.tag, c.headline, c.detail, focus);
  }
  const cps = def.checkpoints(ctx).slice(0, 3);
  let rightOnes = 0;
  for (let q = 0; q < cps.length; q++) {
    if (q >= cpAnswers.length) {
      const { prompt, input, answer: ans } = cps[q];
      return { next: { id: `${def.id}-cp${q}`, prompt, input, answer: ans }, diagnosis: null };
    }
    const a = cpAnswers[q];
    if (a === null || a === undefined) continue;             // "Not sure" is not evidence
    if (!sameReply(cps[q].input, a, cps[q].answer)) return finish(cps[q].tag, cps[q].headline, cps[q].detail, focus);
    rightOnes++;
  }
  // a fallback claims the learner knows the pieces and names a misconception, so it needs
  // evidence: at least one checkpoint answered correctly ("Not sure" is never evidence)
  if (def.fallback && rightOnes > 0) { const f = def.fallback(ctx); return finish(f.tag, f.headline, f.detail, focus); }
  return finish('other', 'Not quite.', def.because(ctx), focus);
}

export function why(item, diagnosis, { level } = {}) {
  const { def } = defFor(item.params.id);
  const layers = def.layers(item.sim, diagnosis);
  return level === 'gcse' ? layers.filter((l) => l.kind !== 'adder') : layers;
}

// ---------------------------------------------------------------------------
// Generation and codes
// ---------------------------------------------------------------------------

const sectionMatch = (def, section) => !section || def.section === section || def.section.startsWith(`${section}.`);

export function generate(rng, opts = {}) {
  let pool = DEFS.filter((d) => sectionMatch(d, opts.section));
  if (opts.id) pool = DEFS.filter((d) => d.id === opts.id);
  if (opts.target) {
    const aimed = DEFS.filter((d) => d.tags.includes(opts.target));
    if (aimed.length) pool = aimed;
  }
  if (!pool.length) pool = DEFS.slice();
  const avoid = opts.avoid || null;
  for (let tries = 0; tries < 20; tries++) {
    const def = pick(rng, pool);
    const v = opts.v !== undefined ? opts.v : chance(rng, 0.25) ? 0 : randInt(rng, 1, V_MAX);
    if (avoid && avoid.id === def.id && avoid.v === v && tries < 19) continue;
    return { id: def.id, v };
  }
  return { id: pool[0].id, v: 0 };
}

/** a new instance aimed at tagId: the same card when it practises the tag, otherwise one that does */
export function variant(item, tagId, rng) {
  const cur = item.params;
  const aimed = DEFS.filter((d) => d.tags.includes(tagId));
  const def = !aimed.length || aimed.some((d) => d.id === cur.id) ? defFor(cur.id).def : pick(rng, aimed);
  let v;
  do v = randInt(rng, 1, V_MAX); while (def.id === cur.id && v === cur.v);
  return { id: def.id, v };
}

export function encodeParams(p) {
  return [defFor(p.id).index, p.v | 0];
}

export function decodeParams(ints) {
  if (!Array.isArray(ints) || ints.length !== 2) throw new Error('A card needs two numbers.');
  const [i, v] = ints;
  if (!Number.isInteger(i) || i < 0 || i >= DEFS.length) throw new Error('That card does not exist.');
  if (!Number.isInteger(v) || v < 0 || v > V_MAX) throw new Error('That card variant does not exist.');
  return { id: DEFS[i].id, v };
}

/** test hook: the classic wrong answers a card recognises, with their tags */
export function classicAnswers(item) {
  const { def } = defFor(item.params.id);
  return def.classic(item.sim).map((c) => ({ tag: c.tag, headline: c.headline }));
}
