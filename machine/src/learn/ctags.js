// C/x86 misconception texts + worked examples (owner: cards). See CONTRACTS.md
// "Misconception tags". The flags_* ids belong to tags.js (binary items), so
// they are not repeated here. Worked examples draw fresh numbers from the rng
// so a learner who sees two of them practises the steps, not the numbers.
import { randInt, pick } from '../lib/rng.js';

const TWO32 = 4294967296;
const s32 = (x) => Number(BigInt.asIntN(32, BigInt(x)));
const hex32 = (x) => `0x${Number(BigInt.asUintN(32, BigInt(x))).toString(16).toUpperCase().padStart(8, '0')}`;
const bin8 = (x) => (x & 255).toString(2).padStart(8, '0');

export const C_TAGS = {
  c_signed_overflow: {
    label: 'Expected int overflow not to wrap',
    student: 'You expected the int result to keep growing, stop at the largest int or crash the program, but an int has only 32 bits. At -O0 gcc\'s add or imul keeps just the low 32 bits, so the result wraps round, often to a negative number.',
    fix: 'If the true answer is outside -2147483648 to 2147483647, subtract (or add) 4294967296 until it fits.',
    worked(rng) {
      const a = 2147483647 - randInt(rng, 0, 999);
      const b = randInt(rng, 2147483647 - a + 1, 2147483647 - a + 5000);
      const sum = a + b;
      return {
        title: `${a} + ${b} as an int`,
        steps: [
          { subgoal: 'Know the range', text: 'An int has 32 bits, so it holds -2147483648 to 2147483647.' },
          { subgoal: 'Work out the true answer', text: `${a} + ${b} = ${sum}, which is above 2147483647.` },
          { subgoal: 'Wrap it round', text: `Subtract 2^32 = 4294967296: ${sum} − 4294967296 = ${s32(sum)}.` },
          { subgoal: 'Check with the flags', text: 'Two positive numbers gave a negative result, so the add sets OF = 1 (signed overflow).' },
          { subgoal: 'Say what C promises', text: 'The C standard calls this undefined behaviour; gcc -O0 wraps, but an optimising compiler may not.' },
        ],
      };
    },
  },

  c_usual_conversions: {
    label: 'Missed the conversion to unsigned',
    student: 'You treated the comparison as signed, but when an int meets an unsigned int C converts the int to unsigned first. A negative number such as -1 becomes a huge positive one (4294967295).',
    fix: 'When an int meets an unsigned int, convert the int to unsigned (add 4294967296 to a negative value) before comparing.',
    worked(rng) {
      const k = randInt(rng, 1, 9), m = randInt(rng, 0, 9);
      const u = TWO32 - k;
      return {
        title: `-${k} < ${m}u`,
        steps: [
          { subgoal: 'Spot the mix', text: `-${k} is an int and ${m}u is an unsigned int, so the usual arithmetic conversions apply.` },
          { subgoal: 'Convert the int', text: `The int becomes unsigned int: -${k} + 4294967296 = ${u}.` },
          { subgoal: 'Compare as unsigned', text: `${u} < ${m} is false, so the expression is 0.` },
          { subgoal: 'See it in the code', text: 'The compiler uses an unsigned test (setb or jb, which read CF) instead of a signed one (setl or jl).' },
        ],
      };
    },
  },

  c_promotion: {
    label: 'Missed integer promotion',
    student: 'You did the arithmetic in 8 or 16 bits, but C promotes char and short operands to int first. The arithmetic is done in 32 bits, so nothing is cut off unless the result is stored in a smaller type.',
    fix: 'Before + − * /, turn every char or short operand into an int; only a store into a smaller variable loses bits.',
    worked(rng) {
      const a = randInt(rng, 130, 255), b = randInt(rng, 256 - a, 255);
      return {
        title: `unsigned char ${a} + ${b}`,
        steps: [
          { subgoal: 'Promote', text: `Both unsigned chars become ints: ${a} and ${b}, now 32 bits wide.` },
          { subgoal: 'Add in int', text: `${a} + ${b} = ${a + b}, which fits easily in an int.` },
          { subgoal: 'Look at the store', text: `Stored in an int it stays ${a + b}; only an unsigned char variable would keep just ${(a + b) & 255}.` },
          { subgoal: 'See it in the code', text: 'movzx loads each byte into a 32-bit register and add works on all 32 bits, so the carry out of bit 7 lands in bit 8.' },
        ],
      };
    },
  },

  c_truncating_division: {
    label: 'Rounded division down, not to 0',
    student: 'You rounded the quotient down, but C integer division truncates toward zero. The remainder then has the same sign as the number being divided.',
    fix: 'Divide the sizes, drop the fraction, attach the sign, then get the remainder from a − (a / b) × b.',
    worked(rng) {
      let a, b;
      do { a = -randInt(rng, 5, 49); b = randInt(rng, 2, 9); } while (a % b === 0);
      const q = Math.trunc(a / b), r = a % b;
      return {
        title: `${a} / ${b} and ${a} % ${b}`,
        steps: [
          { subgoal: 'Divide the sizes', text: `${-a} ÷ ${b} = ${Math.floor(-a / b)} remainder ${-a % b}; drop the remainder.` },
          { subgoal: 'Attach the sign', text: `The signs differ, so ${a} / ${b} = ${q} (toward zero, not ${Math.floor(a / b)}).` },
          { subgoal: 'Find the remainder', text: `${a} − (${q} × ${b}) = ${r}, which has the sign of ${a}.` },
          { subgoal: 'See it in the code', text: 'idiv does exactly this: the quotient goes in eax and the remainder in edx.' },
        ],
      };
    },
  },

  c_shift_negative: {
    label: 'Expected >> on a negative to be logical',
    student: 'You treated >> on a negative int like a shift of unsigned bits. gcc uses an arithmetic shift (sar), which copies the sign bit in, so the result stays negative and rounds down.',
    fix: 'For a negative int, x >> k is x ÷ 2^k rounded down (toward minus infinity).',
    worked(rng) {
      const x = -randInt(rng, 3, 99), k = randInt(rng, 1, 3);
      return {
        title: `${x} >> ${k}`,
        steps: [
          { subgoal: 'Check the type', text: `${x} is a negative int, so gcc emits sar (arithmetic shift right).` },
          { subgoal: 'Fill with the sign', text: `sar copies the sign bit (1) into the ${k} new top bit${k > 1 ? 's' : ''}, so the bits ${hex32(x)} become ${hex32(x >> k)}.` },
          { subgoal: 'Read the value', text: x % 2 ** k === 0 ? `${x} ÷ ${2 ** k} = ${x >> k} exactly, so nothing is rounded.` : `${x} ÷ ${2 ** k} = ${x / 2 ** k}, rounded down (toward minus infinity) to ${x >> k}.` },
          { subgoal: 'Know the rule', text: 'The C standard leaves this implementation-defined; a logical shift would have given a huge positive number.' },
        ],
      };
    },
  },

  c_char_signedness: {
    label: 'Assumed char is unsigned',
    student: 'You treated char as holding 0 to 255, but on x86-64 gcc a plain char is signed and holds -128 to 127. A value like 200 keeps its 8 bits, which read as 200 − 256 = -56.',
    fix: 'For a plain char given a value from 128 to 255, subtract 256 to get what it holds.',
    worked(rng) {
      const n = randInt(rng, 128, 255);
      return {
        title: `char c = ${n};`,
        steps: [
          { subgoal: 'Know the range', text: 'On x86-64 gcc a plain char is signed: -128 to 127.' },
          { subgoal: 'Keep 8 bits', text: `${n} in binary is ${bin8(n)}; those 8 bits are what gets stored.` },
          { subgoal: 'Read them signed', text: `The top bit is worth -128, so ${bin8(n)} = ${n} − 256 = ${n - 256}.` },
          { subgoal: 'See it in the code', text: `movsx copies that sign bit when the char is loaded into an int, so printf("%d") shows ${n - 256}.` },
        ],
      };
    },
  },

  c_unsigned_wrap: {
    label: 'Expected unsigned to go below 0',
    student: 'You expected the unsigned value to go negative or stop at 0, but unsigned arithmetic wraps round modulo 2^32. So 0 − 1 gives 4294967295.',
    fix: 'If an unsigned result would be negative, add 4294967296.',
    worked(rng) {
      const k = randInt(rng, 0, 5), m = randInt(rng, k + 1, k + 9);
      const v = TWO32 - (m - k);
      return {
        title: `unsigned ${k} − ${m}`,
        steps: [
          { subgoal: 'Know the range', text: 'An unsigned int holds 0 to 4294967295 and can never be negative.' },
          { subgoal: 'Do the maths', text: `${k} − ${m} = ${k - m}, which is below 0.` },
          { subgoal: 'Wrap it round', text: `Add 2^32: ${k - m} + 4294967296 = ${v}.` },
          { subgoal: 'See it in the code', text: 'sub gives those same 32 bits and sets CF = 1 to show it borrowed.' },
        ],
      };
    },
  },

  c_narrowing: {
    label: 'Missed truncation into a smaller type',
    student: 'You kept the whole value (or stopped it at the largest one that fits), but a smaller type keeps only its low bits: a short keeps 16, a char 8. Whatever is above them is cut off.',
    fix: 'Take the value modulo 2^bits, then if the type is signed and the result has its top bit set, subtract 2^bits.',
    worked(rng) {
      const i = randInt(rng, 32768, 200000);
      const low = i % 65536;
      const s = low >= 32768 ? low - 65536 : low;
      return {
        title: `short s = ${i};`,
        steps: [
          { subgoal: 'Know the size', text: 'A short has 16 bits, so it holds -32768 to 32767.' },
          { subgoal: 'Keep the low bits', text: `${i} mod 65536 = ${low}.` },
          { subgoal: 'Read them signed', text: low >= 32768 ? `Bit 15 is 1, so the short is ${low} − 65536 = ${s}.` : `Bit 15 is 0, so the short is ${s}.` },
          { subgoal: 'See it in the code', text: 'The store writes only ax, the low 16 bits of eax; the top 16 bits are dropped.' },
        ],
      };
    },
  },

  c_jump_signedness: {
    label: 'Mixed up signed and unsigned jumps',
    student: 'You read the comparison as signed, but the compiler used an unsigned jump (jb, jae, ja or jbe), which tests CF (and ZF for ja and jbe). Signed jumps (jl, jge, jg, jle) test SF and OF instead (and ZF for jg and jle).',
    fix: 'When an int is compared with an unsigned int, the comparison is unsigned: work out the answer with both values read as unsigned.',
    worked(rng) {
      const k = randInt(rng, 1, 9), m = randInt(rng, 1, 9);
      const op = pick(rng, ['<', '>']);
      const u = TWO32 - k;
      const truth = op === '<' ? u < m : u > m;
      return {
        title: `int a = -${k}; unsigned b = ${m}; if (a ${op} b)`,
        steps: [
          { subgoal: 'Find the comparison type', text: 'b is unsigned, so a is converted to unsigned int and the comparison is unsigned.' },
          { subgoal: 'Convert', text: `-${k} becomes ${u}.` },
          { subgoal: 'Pick the jump', text: `To skip the body this lab's compiler uses ${op === '<' ? 'jae (taken when CF = 0)' : 'jbe (taken when CF = 1 or ZF = 1)'}, not the signed ${op === '<' ? 'jge' : 'jle'}.` },
          { subgoal: 'Decide', text: `${u} ${op} ${m} is ${truth ? 'true, so the body runs' : 'false, so the body is skipped'}.` },
        ],
      };
    },
  },
};
