// Mini-C programs that exercise C's integer types (tests/10-engine.test.mjs).
// Every one must print and return exactly what gcc -O0 -fwrapv gives on x86-64.
// All fit the engine's limits (30 lines, 72 columns).
module.exports = {
  // ---- unsigned basics and wraparound
  uWrapDown: 'unsigned u = 0;\nu = u - 1;\nprintf("%u %x %d\\n", u, u, u);\nreturn u == 4294967295U;',
  uWrapUp: 'unsigned u = 4294967295U;\nu++;\nprintf("%u\\n", u);\nu += 10;\nprintf("%u\\n", u);\nreturn u;',
  intMaxPlus1: '#include <limits.h>\nint x = INT_MAX;\nint y = x + 1;\nprintf("%d %d %u\\n", x, y, y);\nreturn y < 0;',
  intMinNeg: '#include <limits.h>\nint m = INT_MIN;\nint n = -m;\nprintf("%d %d\\n", n, n == m);\nprintf("%u %x\\n", UINT_MAX, INT_MIN);\nreturn 3;',
  minusOneLtZeroU: 'int a = -1;\nunsigned b = 0;\nif (a < b) printf("less\\n");\nelse printf("not less\\n");\nprintf("%d %d\\n", -1 < 0U, -1 < 0);\nreturn a < b;',
  hexConstType: 'int x = 0xFFFFFFFF;\nlong l = 0xFFFFFFFF;\nlong m = 4294967295;\nprintf("%d %ld %ld\\n", x, l, m);\nprintf("%d %d\\n", 0xFFFFFFFF > 0, -1 > 0);\nreturn x;',
  bigDecimalIsLong: 'long a = 2147483648;\nlong b = -2147483648;\nint c = 2147483647 + 1;\nprintf("%ld %ld %d\\n", a, b, c);\nprintf("%d\\n", 2147483648 > 0);\nreturn 0;',
  suffixes: 'long a = 1L << 40;\nunsigned long b = 1UL << 63;\nunsigned c = 1U << 31;\nprintf("%ld %lu %u\\n", a, b, c);\nprintf("%d %d\\n", 5U > -1, 5L > -1);\nreturn 1;',
  octal: 'int a = 017, b = 0777, c = 010 + 1;\nunsigned d = 037777777777;\nprintf("%d %d %d %u\\n", a, b, c, d);\nprintf("%o %#o %#x\\n", a, b, c);\nreturn a;',
  // ---- char and signedness
  charSigned: 'char c = 200;\nunsigned char u = 200;\nsigned char s = -56;\nprintf("%d %d %d\\n", c, u, s);\nprintf("%d %d\\n", c == u, c == s);\nreturn u;',
  charOverflowLoop: 'char c = 125;\nint n = 0;\nwhile (c > 0) {\n  c++;\n  n++;\n}\nprintf("%d %d\\n", c, n);\nreturn n;',
  ucharWrapLoop: 'unsigned char u = 250;\nint n = 0;\nfor (; u != 4; u++) n++;\nprintf("%d %d\\n", u, n);\nreturn n;',
  charArith: 'char a = 100, b = 100;\nchar c = a + b;\nint d = a + b;\nprintf("%d %d\\n", c, d);\nreturn d;',
  charConsts: "char c = 'z';\nint up = c - 'a' + 'A';\nchar nl = '\\n', t = '\\t';\nint hi = '\\xff', oct = '\\101';\nprintf(\"%c%d %d %d %d\\n\", up, nl, t, hi, oct);\nreturn up;",
  ucharPromotion: 'unsigned char a = 200, b = 100;\nint s = a + b;\nunsigned char t = a + b;\nprintf("%d %d\\n", s, t);\nprintf("%d\\n", a * b);\nreturn t;',
  charCompare: 'char c = -1;\nunsigned char u = 255;\nprintf("%d %d %d\\n", c == 255, u == 255, c == u);\nprintf("%d\\n", (unsigned char)c == u);\nreturn c;',
  // ---- short
  shortTrunc: 'short s = 40000;\nunsigned short us = 40000;\nshort t = 65536 + 7;\nprintf("%d %d %d\\n", s, us, t);\nreturn us / 1000;',
  shortArith: 'short a = 30000, b = 30000;\nshort c = a + b;\nint d = a + b;\nunsigned short e = a + b;\nprintf("%hd %d %hu\\n", c, d, e);\nreturn 0;',
  shortIncWrap: 'short s = 32767;\ns++;\nunsigned short u = 0;\nu--;\nprintf("%d %u %hd %hu\\n", s, u, s, u);\nreturn 0;',
  // ---- long
  longArith: 'long a = 3000000000;\nlong b = a * 4;\nlong c = b / 7, d = b % 7;\nprintf("%ld %ld %ld %ld\\n", a, b, c, d);\nreturn d;',
  longMixInt: 'int i = -5;\nlong l = i;\nunsigned u = i;\nlong m = u;\nprintf("%ld %u %ld\\n", l, u, m);\nprintf("%ld\\n", i * 1000000000L);\nreturn 0;',
  intOverflowVsLong: 'int a = 100000, b = 100000;\nint p = a * b;\nlong q = a * b;\nlong r = (long)a * b;\nprintf("%d %ld %ld\\n", p, q, r);\nreturn 0;',
  longBig: 'long x = 0x123456789ABCDEF0;\nlong y = x >> 4;\nunsigned long z = (unsigned long)x >> 60;\nprintf("%lx %lx %lu\\n", x, y, z);\nreturn z;',
  longMinMax: '#include <limits.h>\nlong a = LONG_MAX;\nlong b = a + 1;\nunsigned long c = ULONG_MAX;\nprintf("%ld %ld %lu\\n", a, b, c);\nprintf("%lx %d\\n", c, b < 0);\nreturn 0;',
  longVsUnsigned: 'long l = -1;\nunsigned u = 1;\nprintf("%d\\n", l < u);\nunsigned long ul = 1;\nprintf("%d\\n", l < ul);\nprintf("%d\\n", -1L < 1U);\nreturn 0;',
  longNeg: 'long a = -9000000000;\nlong b = -a;\nlong c = ~a;\nprintf("%ld %ld %ld\\n", b, c, a / -3);\nprintf("%ld %ld\\n", a % 7, -a % 7);\nreturn !a;',
  // ---- casts
  casts: 'int x = 300;\nprintf("%d %d\\n", (unsigned char)x, (char)x);\nprintf("%d %d\\n", (short)70000, (unsigned short)-1);\nprintf("%u %ld\\n", (unsigned)-1, (long)-1);\nreturn (char)x;',
  castChain: 'long big = 0x1234567890;\nint i = (int)big;\nshort s = (short)big;\nchar c = (char)big;\nprintf("%x %x %d\\n", i, s, c);\nprintf("%lu\\n", (unsigned long)(unsigned)big);\nreturn c;',
  castToUnsignedLong: 'int n = -1;\nunsigned long a = n;\nunsigned long b = (unsigned)n;\nprintf("%lu %lu\\n", a, b);\nprintf("%lx\\n", (unsigned long)(char)0x80);\nreturn 0;',
  castInCompare: 'int a = -1;\nunsigned b = 1;\nprintf("%d %d\\n", a < b, a < (int)b);\nprintf("%d\\n", (unsigned)a > 100);\nreturn 0;',
  // ---- shifts
  shiftNegative: 'int a = -16;\nunsigned b = -16;\nprintf("%d %u\\n", a >> 2, b >> 2);\nprintf("%d %d\\n", -1 >> 31, (int)(0x80000000U >> 31));\nreturn a >> 1;',
  shiftVarCounts: 'int n = 3;\nunsigned u = 0xF0000000;\nint s = 0xF0000000;\nprintf("%x %x %x\\n", u >> n, s >> n, u << n);\nlong l = -1;\nprintf("%lx\\n", l << 36);\nreturn 0;',
  shiftChar: 'unsigned char c = 0x81;\nint a = c << 1, b = c >> 1;\nchar d = 0x81;\nint e = d >> 1;\nprintf("%d %d %d\\n", a, b, e);\nreturn 0;',
  shiftUnsignedLong: 'unsigned long u = 1;\nfor (int i = 0; i < 4; i++) u = u << 16;\nprintf("%lu\\n", u);\nlong s = 1L << 62;\nprintf("%ld %ld\\n", s, s >> 61);\nreturn 0;',
  // ---- division and modulo
  unsignedDiv: 'unsigned a = 4294967295U;\nunsigned b = a / 2, c = a % 7;\nint d = -7;\nprintf("%u %u %u\\n", b, c, d / 2U);\nprintf("%d %d\\n", d / 2, d % 2);\nreturn c;',
  unsignedDivVar: 'unsigned a = 100, b = 7;\nunsigned q = a / b, r = a % b;\nint x = -100;\nunsigned y = x / b;\nprintf("%u %u %u %u\\n", q, r, y, x % b);\nreturn q;',
  mixedDivision: 'int a = -17;\nlong b = 5;\nunsigned long c = 5;\nprintf("%ld %ld\\n", a / b, a % b);\nprintf("%lu %lu\\n", a / c, a % c);\nreturn 0;',
  // ---- comparisons and control flow with signedness
  unsignedLoop: 'int n = 0;\nfor (unsigned i = 3; i < 10; i--) n++;\nprintf("%d\\n", n);\nreturn n;',
  whileUnsigned: 'unsigned x = 5;\nint k = 0;\nwhile (x - 10 > 0 && k < 3) k++;\nprintf("%d %u\\n", k, x - 10);\nreturn k;',
  ternaryConvert: 'int a = -1;\nunsigned b = 2;\nlong t = 1 ? a : b;\nprintf("%ld\\n", t);\nint c = a < 0 ? a : b;\nprintf("%d %d\\n", c, (a > b) ? 10 : 20);\nreturn c;',
  ternaryLong: 'int a = -1;\nlong b = 2;\nlong t = a > 0 ? b : a;\nunsigned long u = a > 0 ? 1UL : a;\nprintf("%ld %lu\\n", t, u);\nreturn 0;',
  logicTypes: 'long l = 0x100000000;\nint i = (int)l;\nprintf("%d %d %d\\n", !l, !i, l && 1);\nunsigned char c = 256 + 1;\nprintf("%d %d\\n", !c, c || 0);\nreturn !i;',
  compareChain: 'unsigned char a = 255;\nsigned char b = -1;\nshort c = -1;\nunsigned short d = 65535;\nprintf("%d %d %d\\n", a == b, c == d, b == c);\nreturn (a > b) + (d > c) * 2;',
  // ---- compound assignment and ++/-- on every type
  compoundTypes: 'char c = 100;\nc += 100;\nunsigned char u = 10;\nu -= 20;\nshort s = 1000;\ns *= 100;\nprintf("%d %d %d\\n", c, u, s);\nreturn 0;',
  compoundMixed: 'unsigned u = 10;\nu -= 20;\nint i = 7;\ni /= 2U;\nlong l = 5;\nl *= -3;\nl <<= 40;\nprintf("%u %d %ld\\n", u, i, l);\nreturn 0;',
  compoundShift: 'int s = -64;\ns >>= 3;\nunsigned u = 0x80000000;\nu >>= 3;\nchar c = 1;\nc <<= 7;\nprintf("%d %x %d\\n", s, u, c);\nreturn 0;',
  incDecAll: 'long l = -1;\nl++;\nunsigned long ul = 0;\nul--;\nsigned char sc = -128;\nsc--;\nunsigned short us = 65535;\n++us;\nprintf("%ld %lu %d %d\\n", l, ul, sc, us);\nreturn sc;',
  // ---- printf length modifiers, flags and widths
  printfModifiers: 'int x = -1;\nprintf("%hhd %hhu %hd %hu\\n", x, x, x, x);\nprintf("%hhx %hx %x\\n", x, x, x);\nreturn 0;',
  printfLong: 'long a = -5;\nunsigned long b = 18446744073709551615UL;\nprintf("%ld %lu %lx %lX\\n", a, a, b, b);\nprintf("[%20ld][%-20lu]\\n", a, b);\nreturn 0;',
  printfFlags: 'int v = 255;\nprintf("[%8x][%-8X][%08o][%#x][%#o]\\n", v, v, v, v, v);\nint n = -42;\nprintf("[%+d][% d][%+05d][%-6d][%.5d]\\n", v, v, n, n, n);\nreturn 0;',
  printfChars: "char c = 'A';\nunsigned char u = 66;\nint big = 256 + 'C';\nprintf(\"%c%c%c [%3c][%-3c]\\n\", c, u, big, c, u);\nreturn 0;",
  printfPrecision: 'unsigned u = 42;\nprintf("[%.4u][%8.3x][%.0d][%5.0d]\\n", u, u, 0, 0);\nlong l = 7;\nprintf("[%-8.3ld][%08ld]\\n", l, -l);\nreturn 0;',
  // ---- mixed bags
  bitsTypes: 'unsigned char m = 0xF0;\nint a = ~m;\nunsigned char b = ~m;\nunsigned short c = ~0;\nprintf("%d %d %d\\n", a, b, c);\nprintf("%x\\n", ~0U ^ m);\nreturn b;',
  sumBytes: 'unsigned char total = 0;\nint wide = 0;\nfor (int i = 1; i <= 30; i++) {\n  total += i;\n  wide += i;\n}\nprintf("%d %d %d\\n", total, wide, wide % 256);\nreturn total;',
  hashLoop: 'unsigned h = 2166136261U;\nfor (int i = 0; i < 5; i++) {\n  h = h ^ (unsigned)(i + 97);\n  h = h * 16777619U;\n}\nprintf("%u %x\\n", h, h);\nreturn h & 255;',
  longFactorial: 'long f = 1;\nint of = 0;\nfor (int i = 1; i <= 20; i++) f = f * i;\nprintf("%ld\\n", f);\nf = f * 21;\nprintf("%ld\\n", f);\nreturn of;',
  unsignedCountdown: 'unsigned char n = 3;\nint laps = 0;\nwhile (n > 0 && laps < 6) {\n  n -= 2;\n  laps++;\n}\nprintf("%d %d\\n", n, laps);\nreturn laps;',
  returnTypes: 'long big = 0x100000102;\nunsigned char c = 255;\nprintf("%d\\n", (int)big);\nif (c > 200) return big;\nreturn 0;',
  mainTyped: '#include <stdio.h>\n\nint main(void) {\n  unsigned char a = 250;\n  a += 10;\n  short b = -a;\n  long c = (long)b * b;\n  printf("%d %d %ld\\n", a, b, c);\n  return a;\n}',
  manyDecls: 'unsigned char a = 1, b = 2;\nshort c = 3;\nint d = 4;\nlong e = 5;\nunsigned long f = 6;\nchar g = 7;\nunsigned short h = 8;\nunsigned i = 9;\nsigned char j = 10;\nlong total = a + b + c + d + e + f + g + h + i + j;\nprintf("%ld\\n", total);\nreturn total;',
  frameDisp32: 'long a = 1, b = 2, c = 3, d = 4, e = 5, f = 6;\nlong g = 7, h = 8, i = 9, j = 10, k = 11, l = 12;\nlong m = 13, n = 14, o = 15, p = 16, q = 17, r = 18;\nlong s = a + b + c + d + e + f + g + h + i + j;\ns = s + k + l + m + n + o + p + q + r;\nprintf("%ld\\n", s);\nreturn s;',
};
