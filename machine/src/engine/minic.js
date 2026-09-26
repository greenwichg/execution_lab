// Mini-C: a tiny C compiler, x86-64 assembler and emulator.
//
// Ported from the Execution Lab's editor (index.html, the @@MINIC block) and
// extended with C's integer types. Learners are told "this is what the machine
// does", so two things are checked against the real toolchain by
// tests/10-engine.test.mjs:
//   · every program prints and returns exactly what gcc -O0 -fwrapv prints and returns
//   · every instruction's bytes are exactly what GNU as emits for its text
// Implementation-defined behaviour follows gcc on x86-64: char is signed,
// narrowing keeps the low bits, >> on a signed value is arithmetic.
//
// Pure ES module: no DOM, no randomness. Values that can need 64 bits are
// BigInts internally; see run() for what the trace hands out.

export const LIMITS = { lines: 30, cols: 72, vars: 32, steps: 200000, output: 4000 };

// kind: 'syntax' (can't read it / not supported), 'type' (names and types),
// 'limit' (too long, too many, too much output or too many steps), 'runtime' (the CPU faulted)
export class CError extends Error {
  constructor(message, line = 0, col = 0, kind = 'syntax') {
    super(message);
    this.name = 'CError';
    this.line = line;
    this.col = col;
    this.kind = kind;
  }
}

// ------------------------------------------------------------------ types

const TYPE_LIST = [
  ['char', 1, true, 1], ['signed char', 1, true, 1], ['unsigned char', 1, false, 1],
  ['short', 2, true, 2], ['unsigned short', 2, false, 2],
  ['int', 4, true, 3], ['unsigned int', 4, false, 3],
  ['long', 8, true, 4], ['unsigned long', 8, false, 4],
];

/** name → { name, size (bytes), bits, signed, rank, min, max (BigInt) } — LP64, as on x86-64 Linux */
export const TYPES = Object.freeze(Object.fromEntries(TYPE_LIST.map(([name, size, signed, rank]) => {
  const bits = size * 8;
  const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
  const max = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
  return [name, Object.freeze({ name, size, bits, signed, rank, min, max })];
})));
const INT = TYPES.int, UINT = TYPES['unsigned int'], LONG = TYPES.long, ULONG = TYPES['unsigned long'];

/** integer promotion: anything narrower than int becomes int (int holds every char and short value) */
export const promote = (t) => (t.rank < INT.rank ? INT : t);

/** the usual arithmetic conversions (C11 6.3.1.8) for two integer types */
export function commonType(a, b) {
  a = promote(a);
  b = promote(b);
  if (a === b) return a;
  if (a.signed === b.signed) return a.rank >= b.rank ? a : b;
  const u = a.signed ? b : a, s = a.signed ? a : b;
  if (u.rank >= s.rank) return u;                 // int vs unsigned → unsigned; long vs unsigned long → unsigned long
  if (s.size > u.size) return s;                  // long can hold every unsigned int → long
  return s === LONG ? ULONG : UINT;
}

/** convert a value to type t the way gcc does: keep the low bits, reread them in t */
export const wrapTo = (v, t) => (t.signed ? BigInt.asIntN(t.bits, BigInt(v)) : BigInt.asUintN(t.bits, BigInt(v)));

// <limits.h> names, with the types the header gives them
const LIMIT_MACROS = {
  CHAR_BIT: [8n, INT], SCHAR_MIN: [-128n, INT], SCHAR_MAX: [127n, INT], UCHAR_MAX: [255n, INT],
  CHAR_MIN: [-128n, INT], CHAR_MAX: [127n, INT], SHRT_MIN: [-32768n, INT], SHRT_MAX: [32767n, INT],
  USHRT_MAX: [65535n, INT], INT_MIN: [INT.min, INT], INT_MAX: [INT.max, INT], UINT_MAX: [UINT.max, UINT],
  LONG_MIN: [LONG.min, LONG], LONG_MAX: [LONG.max, LONG], ULONG_MAX: [ULONG.max, ULONG],
};

// ------------------------------------------------------------------ lexer

const TYPE_WORDS = new Set(['char', 'short', 'int', 'long', 'signed', 'unsigned']);
const KEYWORDS = new Set([...TYPE_WORDS, 'return', 'if', 'else', 'while', 'for', 'break', 'continue', 'void']);
const WHAT_WORKS = 'this lab runs whole-number variables (char, short, int, long, signed or unsigned) inside main';
const UNSUPPORTED = {
  float: 'Floating-point types (float, double) aren\'t supported — this lab is about integer types',
  double: 'Floating-point types (float, double) aren\'t supported — this lab is about integer types',
  sizeof: '"sizeof" isn\'t supported here — the sizes are char 1, short 2, int 4 and long 8 bytes',
  struct: `Structs aren't supported — ${WHAT_WORKS}`,
  union: `Unions aren't supported — ${WHAT_WORKS}`,
  enum: `Enums aren't supported — ${WHAT_WORKS}`,
  typedef: `"typedef" isn't supported — ${WHAT_WORKS}`,
  switch: '"switch" isn\'t supported — use if and else instead',
  case: '"case" isn\'t supported — use if and else instead',
  default: '"default" isn\'t supported — use if and else instead',
  do: '"do … while" isn\'t supported — use while or for instead',
  goto: '"goto" isn\'t supported — use while, for, break or continue instead',
  _Bool: `"_Bool" isn't supported — ${WHAT_WORKS}`,
};
for (const w of ['static', 'const', 'volatile', 'extern', 'register', 'auto', 'inline', 'restrict']) {
  UNSUPPORTED[w] = `"${w}" isn't supported — ${WHAT_WORKS}`;
}
const OPS3 = ['<<=', '>>='];
const OPS2 = ['<=', '>=', '==', '!=', '&&', '||', '<<', '>>', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '->'];
const OPS1 = '+-*/%<>=!&|^~?:';
const PUNCT = '(){};,';
const SIMPLE_ESC = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '\\': 92, '\'': 39, '"': 34, '?': 63 };

/** the type of an integer constant (C11 6.4.4.1, without long long) */
function constType(v, decimal, suffix) {
  const u = suffix.includes('u'), l = suffix.includes('l');
  const cands = u ? (l ? [ULONG] : [UINT, ULONG])
    : l ? (decimal ? [LONG] : [LONG, ULONG])
      : decimal ? [INT, LONG] : [INT, UINT, LONG, ULONG];
  return cands.find((t) => v <= t.max) ?? null;
}

function lex(src) {
  const toks = [];
  const includes = new Set();
  let i = 0, line = 1, col = 1;
  const adv = (n = 1) => { for (let k = 0; k < n; k++) { if (src[i] === '\n') { line++; col = 1; } else col++; i++; } };
  const at = (k = 0) => src[i + k] ?? '';

  /** one escape after a backslash → a byte value 0–255 */
  function escape() {
    const l0 = line, c0 = col - 1;
    const e = at();
    if (e in SIMPLE_ESC) { adv(); return SIMPLE_ESC[e]; }
    if (/[0-7]/.test(e)) {
      let s = '';
      while (s.length < 3 && /[0-7]/.test(at())) { s += at(); adv(); }
      return parseInt(s, 8) & 255;
    }
    if (e === 'x') {
      adv();
      let s = '';
      while (/[0-9a-fA-F]/.test(at())) { s += at(); adv(); }
      if (!s) throw new CError('\\x needs hex digits after it', l0, c0);
      return parseInt(s.slice(-2), 16);
    }
    throw new CError(`Unknown escape \\${e}`, l0, c0);
  }

  function number(l0, c0, start) {
    let digits = '', base = 10;
    if (at() === '0' && /[xX]/.test(at(1))) {
      base = 16;
      adv(2);
      while (/[0-9a-fA-F]/.test(at())) { digits += at(); adv(); }
      if (!digits) throw new CError('A hex number needs digits after 0x', l0, c0);
    } else {
      while (/[0-9]/.test(at())) { digits += at(); adv(); }
      if (digits.length > 1 && digits[0] === '0') {
        base = 8;
        if (/[89]/.test(digits)) throw new CError(`${digits} isn't a valid number: a leading 0 means octal (base 8), which only uses the digits 0 to 7`, l0, c0);
      }
    }
    let suffix = '';
    while (/[uUlL]/.test(at())) { suffix += at(); adv(); }
    if (at() === '.' || (base === 10 && /[eE]/.test(at()))) throw new CError(UNSUPPORTED.float, l0, c0);
    if (/[A-Za-z0-9_]/.test(at())) throw new CError(`"${src.slice(start, i)}${at()}…" isn't a number this lab understands (whole numbers only)`, l0, c0);
    const s = suffix.toLowerCase();
    if (s.includes('ll')) throw new CError('long long isn\'t supported — use L instead (long is already 64 bits here)', l0, c0);
    if (!['', 'u', 'l', 'ul', 'lu'].includes(s)) throw new CError(`"${suffix}" isn't a valid number suffix — use U, L or UL`, l0, c0);
    const v = base === 16 ? BigInt('0x' + digits) : base === 8 ? BigInt('0o' + digits) : BigInt(digits);
    const type = constType(v, base === 10, s);
    if (!type) throw new CError(`${src.slice(start, i)} is too big for any integer type here (the largest is unsigned long, 18446744073709551615)`, l0, c0);
    return { t: 'num', v, type, text: src.slice(start, i), line: l0, col: c0, end: col };
  }

  function charConst(l0, c0, start) {
    adv();
    let v;
    if (at() === '\\') { adv(); v = escape(); } else if (at() === '\'' || at() === '\n' || !at()) v = NaN;
    else {
      v = src.charCodeAt(i);
      if (v > 127) throw new CError('Only plain ASCII characters work between \' \' here', l0, c0);
      adv();
    }
    if (at() !== '\'' || Number.isNaN(v)) throw new CError('A character constant holds one character, like \'a\' or \'\\n\'', l0, c0);
    adv();
    // a character constant has type int; a byte above 127 reads back negative because char is signed
    return { t: 'num', v: BigInt.asIntN(8, BigInt(v)), type: INT, text: src.slice(start, i), line: l0, col: c0, end: col, char: true };
  }

  function string(l0, c0, start) {
    adv();
    let s = '';
    while (i < src.length && at() !== '"') {
      if (at() === '\n') throw new CError('This string is missing its closing "', l0, c0);
      if (at() === '\\') { adv(); s += String.fromCharCode(escape()); continue; }
      s += at();
      adv();
    }
    if (i >= src.length) throw new CError('This string is missing its closing "', l0, c0);
    adv();
    return { t: 'str', v: s, text: src.slice(start, i), line: l0, col: c0, end: col };
  }

  while (i < src.length) {
    const c = src[i];
    if (c === '\n' || c === ' ' || c === '\t' || c === '\r') { adv(); continue; }
    if (c === '/' && at(1) === '/') { while (i < src.length && src[i] !== '\n') adv(); continue; }
    if (c === '/' && at(1) === '*') {
      const l0 = line, c0 = col;
      adv(2);
      while (i < src.length && !(src[i] === '*' && at(1) === '/')) adv();
      if (i >= src.length) throw new CError('This comment is never closed with */', l0, c0);
      adv(2);
      continue;
    }
    const l0 = line, c0 = col, start = i;
    if (c === '#') {
      let s = '';
      while (i < src.length && src[i] !== '\n') { s += src[i]; adv(); }
      const m = /^#\s*include\s*[<"]([\w./]+)[>"]\s*$/.exec(s.replace(/\/\/.*$/, '').trimEnd());
      if (!m) throw new CError('Only #include lines are supported (no #define)', l0, c0);
      includes.add(m[1]);
      continue;
    }
    if (/[0-9]/.test(c)) { toks.push(number(l0, c0, start)); continue; }
    if (/[A-Za-z_]/.test(c)) {
      let s = '';
      while (/[A-Za-z0-9_]/.test(at())) { s += at(); adv(); }
      if (UNSUPPORTED[s]) throw new CError(UNSUPPORTED[s], l0, c0);
      toks.push({ t: KEYWORDS.has(s) ? 'kw' : 'id', v: s, text: s, line: l0, col: c0, end: col });
      continue;
    }
    if (c === '"') { toks.push(string(l0, c0, start)); continue; }
    if (c === '\'') { toks.push(charConst(l0, c0, start)); continue; }
    if (c === '.' && /[0-9]/.test(at(1))) throw new CError(UNSUPPORTED.float, l0, c0);
    const op = OPS3.find((o) => src.startsWith(o, i)) || OPS2.find((o) => src.startsWith(o, i)) || (OPS1.includes(c) ? c : null);
    if (op === '->') throw new CError(`Pointers and structs aren't supported — ${WHAT_WORKS}`, l0, c0);
    if (op) { adv(op.length); toks.push({ t: 'op', v: op, text: op, line: l0, col: c0, end: col }); continue; }
    if (PUNCT.includes(c)) { adv(); toks.push({ t: 'pu', v: c, text: c, line: l0, col: c0, end: col }); continue; }
    if (c === '[' || c === ']') throw new CError(`Arrays aren't supported — ${WHAT_WORKS}`, l0, c0);
    if (c === '.') throw new CError(`Structs aren't supported — ${WHAT_WORKS}`, l0, c0);
    throw new CError(`Unexpected character "${c}"`, l0, c0);
  }
  toks.push({ t: 'eof', v: '', text: '', line, col, end: col });
  toks.includes = includes;
  return toks;
}

// ----------------------------------------------------------------- parser

const POINTER_MSG = `Pointers (* and &) aren't supported — ${WHAT_WORKS}`;
const incDecInside = (t) => new CError(`Put ${t.v} on its own line (e.g. "i${t.v};") — it isn't supported inside expressions`, t.line, t.col);

let nodeId = 0;
const mk = (k, tok, o) => ({ k, id: ++nodeId, line: tok.line, col: tok.col, ...o });

function parse(src) {
  const toks = lex(src);
  let p = 0;
  const peek = (o = 0) => toks[Math.min(p + o, toks.length - 1)];
  const is = (t, v) => peek().t === t && (v === undefined || peek().v === v);
  const isTypeAt = (o = 0) => peek(o).t === 'kw' && TYPE_WORDS.has(peek(o).v);
  const next = () => toks[p++];
  const want = (t, v, what) => {
    if (is(t, v)) return next();
    const k = peek();
    throw new CError(`Expected ${what ?? `"${v}"`}${k.t === 'eof' ? ' before the end of the program' : ` but found "${k.text}"`}`, k.line, k.col);
  };
  const endOf = (n, tok) => { n.endLine = tok.line; n.endCol = tok.end; return n; };
  const last = () => toks[p - 1];

  /** type specifiers in any order (C allows "short unsigned int") → a TYPES entry */
  function typeName() {
    const t0 = peek();
    const n = { char: 0, short: 0, int: 0, long: 0, signed: 0, unsigned: 0 };
    while (isTypeAt()) n[next().v]++;
    const bad = (msg) => { throw new CError(msg, t0.line, t0.col); };
    if (n.long > 1) bad('long long isn\'t supported — use long (it is already 64 bits here)');
    if (n.char > 1 || n.short > 1 || n.int > 1 || n.signed > 1 || n.unsigned > 1) bad('A type word is repeated here');
    if (n.signed && n.unsigned) bad('A type can\'t be both signed and unsigned');
    if (n.char && (n.short || n.long || n.int)) bad('"char" can\'t be combined with short, int or long');
    if (n.short && n.long) bad('A type can\'t be both short and long');
    const pre = n.unsigned ? 'unsigned ' : '';
    if (n.char) return TYPES[n.unsigned ? 'unsigned char' : n.signed ? 'signed char' : 'char'];
    if (n.short) return TYPES[pre + 'short'];
    if (n.long) return TYPES[pre + 'long'];
    return TYPES[n.unsigned ? 'unsigned int' : 'int'];
  }

  // expressions (precedence climbing)
  const BIN = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '<=', '>', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];
  function expr() { return ternary(); }
  function ternary() {
    const c = binary(0);
    if (is('op', '?')) {
      next();
      const a = expr();
      want('op', ':');
      const b = ternary();
      return endOf(mk('cond', c, { c, a, b, line: c.line, col: c.col }), last());
    }
    return c;
  }
  function binary(level) {
    if (level >= BIN.length) return unary();
    let l = binary(level + 1);
    while (peek().t === 'op' && BIN[level].includes(peek().v)) {
      const opTok = next();
      const r = binary(level + 1);
      l = endOf(mk('bin', l, { op: opTok.v, l, r, line: l.line, col: l.col, opLine: opTok.line, opCol: opTok.col }), last());
    }
    return l;
  }
  function unary() {
    const t = peek();
    if (t.t === 'op' && (t.v === '*' || t.v === '&')) throw new CError(POINTER_MSG, t.line, t.col);
    if (t.t === 'op' && ['-', '!', '~', '+'].includes(t.v)) {
      next();
      const e = unary();
      if (t.v === '+') return e;
      // fold "-5" into one constant, as C compilers do (keeps "-2147483648" readable)
      if (t.v === '-' && e.k === 'num') {
        const type = promote(e.type);
        return endOf(mk('num', t, { v: wrapTo(-e.v, type), type, text: '-' + e.text }), last());
      }
      return endOf(mk('un', t, { op: t.v, e }), last());
    }
    if (t.t === 'op' && (t.v === '++' || t.v === '--')) throw incDecInside(t);
    if (t.t === 'pu' && t.v === '(' && isTypeAt(1)) return cast();
    return postfix();
  }
  function cast() {
    const t = next();
    const to = typeName();
    if (is('op', '*')) throw new CError(POINTER_MSG, peek().line, peek().col);
    want('pu', ')');
    const e = unary();
    return endOf(mk('cast', t, { to, e }), last());
  }
  function postfix() {
    const e = primary();
    const t = peek();
    if (is('op', '++') || is('op', '--')) throw incDecInside(t);
    if (t.t === 'op' && (t.v === '=' || /^[-+*/%&|^]=$|^<<=$|^>>=$/.test(t.v))) {
      throw new CError('Assignments go on their own line here (e.g. "x = x + 1;")', t.line, t.col);
    }
    return e;
  }
  function primary() {
    const t = peek();
    if (t.t === 'num') { next(); return endOf(mk('num', t, { v: t.v, type: t.type, text: t.text, char: t.char }), t); }
    if (t.t === 'id') {
      next();
      if (is('pu', '(')) {
        const msg = t.v === 'printf' ? 'printf can only be used as a statement on its own here'
          : `Calling functions like ${t.v}() isn't supported — only printf and main`;
        throw new CError(msg, t.line, t.col);
      }
      return endOf(mk('var', t, { name: t.v }), t);
    }
    if (is('pu', '(')) { next(); const e = expr(); want('pu', ')'); return e; }
    if (t.t === 'str') throw new CError('Strings can only be used as the first argument of printf', t.line, t.col);
    throw new CError(t.t === 'eof' ? 'The program ends in the middle of an expression' : `Expected a value but found "${t.text}"`, t.line, t.col);
  }

  // statements
  const ASSIGN_OPS = ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>='];
  function declaration(t) {
    const type = typeName();
    const items = [];
    do {
      if (is('op', '*')) throw new CError(POINTER_MSG, peek().line, peek().col);
      const nameTok = want('id', undefined, 'a variable name');
      if (is('pu', '(')) throw new CError('Only one function (main) is supported', t.line, t.col);
      let init = null;
      if (is('op', '=')) { next(); init = expr(); }
      items.push({ name: nameTok.v, type, init, line: nameTok.line, col: nameTok.col });
    } while (is('pu', ',') && next());
    return endOf(mk('decl', t, { type, items }), last());
  }
  function printfCall(t) {
    next(); next();
    const fmt = want('str', undefined, 'a format string like "%d\\n"');
    const args = [];
    while (is('pu', ',')) { next(); args.push(expr()); }
    want('pu', ')');
    const text = fmt.v.split('\0')[0];         // printf stops at a \0 byte
    const conv = (text.match(FMT_RE) || []).filter((s) => s !== '%%').length;
    const bad = text.replace(FMT_RE, '').match(/%.?/);
    if (bad && !/%[A-Za-z0-9.#+ -]/.test(bad[0])) throw new CError('To print a % sign, write %% in the format string', fmt.line, fmt.col);
    if (bad) {
      const shown = JSON.stringify(bad[0]).slice(1, -1);
      throw new CError(`printf here supports %d %i %u %x %X %o %c %% with hh, h or l (like %hhd, %lu) — not ${shown}`, fmt.line, fmt.col);
    }
    if (conv !== args.length) {
      const n = args.length;
      throw new CError(`The format string has ${conv} placeholder${conv === 1 ? '' : 's'} but ${n} value${n === 1 ? '' : 's'} follow${n === 1 ? 's' : ''}`, fmt.line, fmt.col);
    }
    if (args.length > 5) throw new CError('printf here takes at most 5 values', fmt.line, fmt.col, 'limit');
    return endOf(mk('printf', t, { fmt: text, fmtText: fmt.text, args }), last());
  }
  function simple(inFor = false) {
    // declaration | assignment | ++/-- | printf  (no trailing ;)
    const t = peek();
    if (isTypeAt()) return declaration(t);
    if ((is('op', '++') || is('op', '--')) && peek(1).t === 'id') {
      const opTok = next(), nameTok = next();
      return endOf(mk('incdec', opTok, { name: nameTok.v, op: opTok.v, nameCol: nameTok.col }), last());
    }
    if (t.t === 'id' && t.v === 'printf' && peek(1).t === 'pu' && peek(1).v === '(') return printfCall(t);
    if (t.t === 'id') {
      const nameTok = next();
      if (is('op', '++') || is('op', '--')) {
        const opTok = next();
        return endOf(mk('incdec', nameTok, { name: nameTok.v, op: opTok.v, post: true, nameCol: nameTok.col }), last());
      }
      if (peek().t === 'op' && ASSIGN_OPS.includes(peek().v)) {
        const opTok = next(), e = expr();
        return endOf(mk('assign', nameTok, { name: nameTok.v, op: opTok.v, e, opCol: opTok.col }), last());
      }
      p--;
    }
    const e = expr();
    throw new CError(inFor ? 'Expected an assignment here' : 'This expression doesn\'t do anything on its own — assign it to a variable or print it', e.line, e.col);
  }
  /** the body of if / else / while / for: C only allows a statement there, not a declaration */
  function bodyStmt() {
    if (isTypeAt()) {
      const t = peek();
      throw new CError('A declaration can\'t be the whole body of if, else, while or for — put it inside { }', t.line, t.col);
    }
    return stmt();
  }
  function stmt() {
    const t = peek();
    if (is('pu', '{')) return block();
    if (is('pu', ';')) { next(); return mk('block', t, { body: [] }); }
    if (is('kw', 'if')) {
      next(); want('pu', '(');
      const c = expr();
      want('pu', ')');
      const th = bodyStmt();
      let el = null;
      if (is('kw', 'else')) { next(); el = bodyStmt(); }
      return mk('if', t, { c, t: th, f: el, endLine: c.endLine });
    }
    if (is('kw', 'while')) {
      next(); want('pu', '(');
      const c = expr();
      want('pu', ')');
      return mk('while', t, { c, body: bodyStmt(), endLine: c.endLine });
    }
    if (is('kw', 'for')) {
      next(); want('pu', '(');
      const init = is('pu', ';') ? null : simple(true);
      want('pu', ';');
      const c = is('pu', ';') ? null : expr();
      want('pu', ';');
      const step = is('pu', ')') ? null : simple(true);
      want('pu', ')');
      return mk('for', t, { init, c, step, body: bodyStmt(), endLine: t.line });
    }
    if (is('kw', 'return')) {
      next();
      const e = is('pu', ';') ? null : expr();
      want('pu', ';', '";" after return');
      return endOf(mk('return', t, { e }), last());
    }
    if (is('kw', 'break') || is('kw', 'continue')) { next(); want('pu', ';'); return endOf(mk(t.v, t, {}), last()); }
    if (is('kw', 'else')) throw new CError('This "else" has no matching "if"', t.line, t.col);
    if (is('kw', 'void')) throw new CError('Only one function (main) is supported', t.line, t.col);
    const s = simple();
    want('pu', ';', '";" at the end of the statement');
    return s;
  }
  function block() {
    const t = want('pu', '{');
    const body = [];
    while (!is('pu', '}')) {
      if (is('eof')) throw new CError('A "{" is never closed with "}"', t.line, t.col);
      body.push(stmt());
    }
    next();
    return mk('block', t, { body });
  }
  // program: int main(void) { … }  or bare statements
  let body;
  if (is('kw', 'int') && peek(1).t === 'id' && peek(1).v === 'main' && peek(2).v === '(') {
    next(); next(); next();
    if (is('kw', 'void')) next();
    want('pu', ')', '")" — main takes no parameters here');
    body = block().body;
    if (!is('eof')) { const k = peek(); throw new CError('Only one function (main) is supported', k.line, k.col); }
  } else {
    body = [];
    while (!is('eof')) body.push(stmt());
  }
  return { k: 'program', body, toks, includes: toks.includes };
}

// printf conversions: flags, width, precision, length (hh h l), conversion
const FMT_RE = /%%|%([-+ 0#]*)(\d*)(?:\.(\d*))?(hh|h|l)?([diouxX]|(?<![hl])c)/g;

// ------------------------------------------------------ x86-64 registers and encoding

// name → [register number, width in bits]
const REG = {
  rax: [0, 64], eax: [0, 32], ax: [0, 16], al: [0, 8],
  rcx: [1, 64], ecx: [1, 32], cx: [1, 16], cl: [1, 8],
  rdx: [2, 64], edx: [2, 32],
  rsp: [4, 64], rbp: [5, 64],
  rsi: [6, 64], esi: [6, 32], rdi: [7, 64], edi: [7, 32],
  r8: [8, 64], r8d: [8, 32], r9: [9, 64], r9d: [9, 32],
};
// register family + size in bytes → name
const RN = {
  a: { 1: 'al', 2: 'ax', 4: 'eax', 8: 'rax' }, c: { 1: 'cl', 2: 'cx', 4: 'ecx', 8: 'rcx' },
  d: { 4: 'edx', 8: 'rdx' }, si: { 4: 'esi', 8: 'rsi' }, r8: { 4: 'r8d', 8: 'r8' }, r9: { 4: 'r9d', 8: 'r9' },
};
const ALU = { add: 0, or: 1, and: 4, sub: 5, xor: 6, cmp: 7 };
const ALU_RM_R = { add: 0x01, or: 0x09, and: 0x21, sub: 0x29, xor: 0x31, cmp: 0x39 };
const ALU_R_RM = { add: 0x03, or: 0x0b, and: 0x23, sub: 0x2b, xor: 0x33, cmp: 0x3b };
const ALU_EAX_IMM = { add: 0x05, or: 0x0d, and: 0x25, sub: 0x2d, xor: 0x35, cmp: 0x3d };
const GROUP3 = { not: 2, neg: 3, div: 6, idiv: 7 };
const SHIFT = { shl: 4, shr: 5, sar: 7 };
const CC = { b: 2, ae: 3, e: 4, ne: 5, be: 6, a: 7, l: 0xc, ge: 0xd, le: 0xe, g: 0xf };
const CMP_SIGNED = { '==': 'e', '!=': 'ne', '<': 'l', '<=': 'le', '>': 'g', '>=': 'ge' };
const CMP_UNSIGNED = { '==': 'e', '!=': 'ne', '<': 'b', '<=': 'be', '>': 'a', '>=': 'ae' };
const INV = { e: 'ne', ne: 'e', l: 'ge', ge: 'l', le: 'g', g: 'le', b: 'ae', ae: 'b', be: 'a', a: 'be' };
const OP_INS = { '+': 'add', '-': 'sub', '&': 'and', '|': 'or', '^': 'xor', '*': 'imul' };
const PTR = { 8: 'BYTE', 16: 'WORD', 32: 'DWORD', 64: 'QWORD' };

const isImm8 = (v) => v >= -128 && v <= 127;
const le16 = (v) => [v & 255, (v >>> 8) & 255];
const le32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
const le64 = (v) => Array.from({ length: 8 }, (_, k) => Number((BigInt.asUintN(64, v) >> BigInt(8 * k)) & 255n));
const mem = (d, w) => ({ m: true, d, w });
const isMem = (x) => !!(x && x.m);
const widthOf = (x) => (isMem(x) ? x.w : REG[x][1]);
const hex = (v) => (v < 0 ? '-' : '') + '0x' + Math.abs(v).toString(16);

/** operand-size prefix, REX prefix and ModRM (+ displacement) for "reg field, r/m operand" */
function modrm(regField, rm, w) {
  const rmNum = isMem(rm) ? REG.rbp[0] : REG[rm][0];
  const rex = 0x40 | (w === 64 ? 8 : 0) | (regField >= 8 ? 4 : 0) | (rmNum >= 8 ? 1 : 0);
  const pre = [...(w === 16 ? [0x66] : []), ...(rex !== 0x40 ? [rex] : [])];
  if (!isMem(rm)) return { pre, tail: [0xc0 | ((regField & 7) << 3) | (rmNum & 7)] };
  // [rbp+disp]: mod 01 with disp8 when it fits, else mod 10 with disp32 (GNU as picks the short form)
  if (isImm8(rm.d)) return { pre, tail: [0x40 | ((regField & 7) << 3) | 5, rm.d & 255] };
  return { pre, tail: [0x80 | ((regField & 7) << 3) | 5, ...le32(rm.d)] };
}
const withModrm = (opcode, regField, rm, w, imm = []) => { const m = modrm(regField, rm, w); return [...m.pre, ...opcode, ...m.tail, ...imm]; };
const immBytes = (v, w) => (w === 8 ? [v & 255] : w === 16 ? le16(v) : le32(v));

/** encode one instruction → bytes (branch targets resolved by the caller) */
export function encode(ins, rel = 0, long = false) {
  const { op, a, b, c } = ins;
  switch (op) {
    case 'push': return [0x50 + REG[a][0]];
    case 'pop': return [0x58 + REG[a][0]];
    case 'mov_rbp_rsp': return [0x48, 0x89, 0xe5];
    case 'sub_rsp': return isImm8(b) ? [0x48, 0x83, 0xec, b & 255] : [0x48, 0x81, 0xec, ...le32(b)];
    case 'leave': return [0xc9];
    case 'ret': return [0xc3];
    case 'cdq': return [0x99];
    case 'cdqe': return [0x48, 0x98];
    case 'cqo': return [0x48, 0x99];
    case 'mov': {
      const w = widthOf(a);
      if (typeof b === 'number') {
        if (isMem(a)) return withModrm([w === 8 ? 0xc6 : 0xc7], 0, a, w, immBytes(b, w));
        if (w === 32) { const n = REG[a][0]; return [...(n >= 8 ? [0x41] : []), 0xb8 + (n & 7), ...le32(b)]; }
        return withModrm([0xc7], 0, a, w, le32(b));          // mov r64, imm32 (sign-extended)
      }
      if (isMem(b)) return withModrm([0x8b], REG[a][0], b, w);
      return withModrm([w === 8 ? 0x88 : 0x89], REG[b][0], a, w);
    }
    case 'movabs': return [0x48, 0xb8 + REG[a][0], ...le64(b)];
    case 'movsx': case 'movzx': {
      const sw = widthOf(b);
      const opc = op === 'movsx' ? (sw === 8 ? 0xbe : 0xbf) : (sw === 8 ? 0xb6 : 0xb7);
      return withModrm([0x0f, opc], REG[a][0], b, widthOf(a));
    }
    case 'add': case 'sub': case 'and': case 'or': case 'xor': case 'cmp': {
      const w = widthOf(a);
      if (typeof b === 'number') {
        if (isImm8(b)) return withModrm([0x83], ALU[op], a, w, [b & 255]);
        if (!isMem(a) && REG[a][0] === 0) return [...(w === 64 ? [0x48] : []), ALU_EAX_IMM[op], ...le32(b)];
        return withModrm([0x81], ALU[op], a, w, le32(b));
      }
      if (isMem(b)) return withModrm([ALU_R_RM[op]], REG[a][0], b, w);
      return withModrm([ALU_RM_R[op]], REG[b][0], a, w);
    }
    case 'imul': {
      const w = widthOf(a);
      if (c !== undefined) return withModrm([isImm8(c) ? 0x6b : 0x69], REG[a][0], b, w, isImm8(c) ? [c & 255] : le32(c));
      return withModrm([0x0f, 0xaf], REG[a][0], b, w);
    }
    case 'idiv': case 'div': case 'neg': case 'not': return withModrm([0xf7], GROUP3[op], a, widthOf(a));
    case 'test': return withModrm([0x85], REG[b][0], a, widthOf(a));
    case 'shl': case 'shr': case 'sar': {
      const w = widthOf(a);
      if (b === 'cl') return withModrm([0xd3], SHIFT[op], a, w);
      return b === 1 ? withModrm([0xd1], SHIFT[op], a, w) : withModrm([0xc1], SHIFT[op], a, w, [b & 255]);
    }
    case 'set': return [0x0f, 0x90 + CC[ins.cc], 0xc0];
    case 'lea_fmt': return [0x48, 0x8d, 0x3d, 0, 0, 0, 0];        // rip-relative; the linker fills the offset
    case 'call': return [0xe8, 0, 0, 0, 0];
    case 'jmp': return long ? [0xe9, ...le32(rel)] : [0xeb, rel & 255];
    case 'j': return long ? [0x0f, 0x80 + CC[ins.cc], ...le32(rel)] : [0x70 + CC[ins.cc], rel & 255];
    default: throw new Error('cannot encode ' + op);
  }
}

const operandText = (x) => (isMem(x) ? `${PTR[x.w]} PTR [rbp${x.d < 0 ? '-' : '+'}${Math.abs(x.d)}]` : String(x));

/** Intel-syntax text as gcc -S / objdump print it (labelAddr given → jump targets as addresses) */
export function text(ins, labelAddr) {
  const { op, a, b, c } = ins;
  switch (op) {
    case 'mov_rbp_rsp': return 'mov rbp, rsp';
    case 'sub_rsp': return `sub rsp, ${b}`;
    case 'push': case 'pop': case 'idiv': case 'div': case 'neg': case 'not': return `${op} ${operandText(a)}`;
    case 'leave': case 'ret': case 'cdq': case 'cdqe': case 'cqo': return op;
    case 'set': return `set${ins.cc} al`;
    case 'lea_fmt': return `lea rdi, .LC${ins.str}[rip]`;
    case 'call': return 'call printf';
    case 'jmp': case 'j': return `${op === 'jmp' ? 'jmp' : 'j' + ins.cc} ${labelAddr ? hex(labelAddr(ins.target)) : '.L' + ins.target}`;
    case 'imul': return c !== undefined ? `imul ${a}, ${b}, ${c}` : `imul ${a}, ${operandText(b)}`;
    default: return `${op} ${operandText(a)}, ${operandText(b)}`;
  }
}

// ------------------------------------------------------------ compiler

function checkSize(lines) {
  if (lines.length > LIMITS.lines) throw new CError(`This program has ${lines.length} lines — the limit here is ${LIMITS.lines}`, LIMITS.lines + 1, 1, 'limit');
  lines.forEach((l, k) => {
    if (l.length <= LIMITS.cols) return;
    throw new CError(`Line ${k + 1} is ${l.length} characters long — keep each line to ${LIMITS.cols} or fewer`, k + 1, LIMITS.cols + 1, 'limit');
  });
}

/**
 * Compile Mini-C to x86-64.
 * opts.limits = false skips the line and column limits (the variable limit always applies).
 */
export function compile(src, opts = {}) {
  nodeId = 0;
  const lines = src.replace(/\r/g, '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (opts.limits !== false) checkSize(lines);
  const ast = parse(src);

  // ---- scopes + stack slots ----
  const vars = [];
  let frameUsed = 0;                     // bytes of locals below rbp
  const scopes = [new Map()];
  function newVar(it) {
    const sc = scopes[scopes.length - 1];
    if (sc.has(it.name)) throw new CError(`"${it.name}" is already declared in this block`, it.line, it.col, 'type');
    if (vars.length >= LIMITS.vars) throw new CError(`Too many variables (the limit is ${LIMITS.vars})`, it.line, it.col, 'limit');
    const t = it.type;
    frameUsed = Math.ceil((frameUsed + t.size) / t.size) * t.size;    // natural alignment, like gcc
    const v = { id: vars.length, name: it.name, type: t.name, ctype: t, d: -frameUsed, size: t.size, line: it.line, col: it.col };
    vars.push(v);
    return v;
  }
  function findVar(name) {
    for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return scopes[i].get(name);
    return null;
  }
  function lookup(e) {
    const v = findVar(e.name);
    if (!v) throw new CError(`"${e.name}" hasn't been declared — add "int ${e.name} = …;" first`, e.line, e.col, 'type');
    return v;
  }
  /** a <limits.h> name that isn't a variable becomes the constant it stands for */
  function norm(e) {
    if (e.k !== 'var' || findVar(e.name) || !LIMIT_MACROS[e.name]) return e;
    if (!ast.includes.has('limits.h')) throw new CError(`${e.name} comes from <limits.h> — add "#include <limits.h>" at the top`, e.line, e.col, 'type');
    const [v, type] = LIMIT_MACROS[e.name];
    return Object.assign(e, { k: 'num', v, type, text: e.name });
  }

  // ---- types of expressions ----
  function ty(e) {
    e = norm(e);
    if (e.k === 'var') return lookup(e).ctype;          // not cached: the same name can mean another variable later
    if (e.ty) return e.ty;
    let t;
    switch (e.k) {
      case 'num': t = e.type; break;
      case 'cast': t = e.to; break;
      case 'un': t = e.op === '!' ? INT : promote(ty(e.e)); break;
      case 'cond': t = commonType(ty(e.a), ty(e.b)); break;
      case 'bin':
        if (CMP_SIGNED[e.op] || e.op === '&&' || e.op === '||') t = INT;
        else if (e.op === '<<' || e.op === '>>') t = promote(ty(e.l));     // shifts don't mix the two types
        else t = commonType(ty(e.l), ty(e.r));
        break;
      default: throw new Error('ty ' + e.k);
    }
    e.ty = t;
    return t;
  }

  // ---- emit ----
  const code = [];                      // instructions and labels
  const strings = [];
  let labelN = 0;
  const newLabel = () => labelN++;
  let cur = { line: 0, node: null, stmt: null, ctl: null };
  const loopsInfo = [];
  const loops = [];
  const emit = (op, a, b, c, extra = {}) => {
    const ins = { op, a, b, c, line: cur.line, node: cur.node, stmt: cur.stmt, ctl: cur.ctl, ...extra };
    code.push(ins);
    return ins;
  };
  const jump = (cc, target) => emit(cc ? 'j' : 'jmp', undefined, undefined, undefined, cc ? { cc, target } : { target });
  const label = (l) => code.push({ label: l });
  const A = (t) => RN.a[t.size === 8 ? 8 : 4];
  const C = (t) => RN.c[t.size === 8 ? 8 : 4];
  const D = (t) => RN.d[t.size === 8 ? 8 : 4];
  const memOf = (v) => mem(v.d, v.size * 8);
  const alu = (op, t, node, more = {}) => ({ alu: { op, signed: t.signed, width: t.bits, node, ...more } });
  const fitsImm32 = (s) => s >= -(2n ** 31n) && s < 2n ** 31n;

  /** load constant v (already of type t) into register family r */
  function loadConst(r, v, t) {
    if (t.size <= 4) return emit('mov', RN[r][4], Number(BigInt.asIntN(32, v)));
    const u = BigInt.asUintN(64, v), s = BigInt.asIntN(64, v);
    if (u < 2n ** 32n) return emit('mov', RN[r][4], Number(u));      // writing a 32-bit register clears the top half
    if (fitsImm32(s)) return emit('mov', RN[r][8], Number(s));
    return emit('movabs', RN[r][8], s);
  }
  /** the value of a literal, or of a cast of one (which gcc folds), else null */
  function constOf(e) {
    e = norm(e);
    if (e.k === 'num') return e.v;
    if (e.k === 'cast') { const v = constOf(e.e); return v === null ? null : wrapTo(v, e.to); }
    return null;
  }
  /** a right operand that can go straight into the instruction (constant or same-size variable) */
  function simpleOperand(e, t) {
    e = norm(e);
    if (e.k === 'num') {
      const s = BigInt.asIntN(t.size === 8 ? 64 : 32, wrapTo(e.v, t));
      return fitsImm32(s) ? Number(s) : null;
    }
    if (e.k === 'var') { const v = lookup(e); return v.size === t.size ? memOf(v) : null; }
    return null;
  }

  // The accumulator (eax / rax) always holds an expression's value extended to
  // its promoted width. gen() returns true when the value is 32-bit but rax's
  // top half may still hold junk from a 64-bit value it was truncated from.
  function gen(e) {
    e = norm(e);
    const saved = cur.node;
    cur.node = e;
    let dirty = false;
    switch (e.k) {
      case 'num': loadConst('a', e.v, e.type); break;
      case 'var': {
        const v = lookup(e);
        if (v.size < 4) emit(v.ctype.signed ? 'movsx' : 'movzx', 'eax', memOf(v));
        else emit('mov', A(v.ctype), memOf(v));
        break;
      }
      case 'cast': dirty = genAs(e.e, e.to); break;
      case 'un': genUnary(e); break;
      case 'cond': {
        const t = ty(e), lElse = newLabel(), lEnd = newLabel();
        genBranch(e.c, lElse);
        dirty = genAs(e.a, t);
        jump(null, lEnd);
        label(lElse);
        dirty = genAs(e.b, t) || dirty;
        label(lEnd);
        break;
      }
      case 'bin': genBinary(e); break;
      default: throw new Error('gen ' + e.k);
    }
    cur.node = saved;
    return dirty;
  }
  /** evaluate e and convert it to type t (returns dirty, as gen) */
  function genAs(e, t) {
    e = norm(e);
    const from = ty(e);
    if (e.k === 'var' && t.size === 8 && from.size < 4 && from.signed) {
      // one sign-extending load straight to 64 bits, as gcc does
      const saved = cur.node;
      cur.node = e;
      emit('movsx', 'rax', memOf(lookup(e)));
      cur.node = saved;
      return false;
    }
    return convert(from, t, gen(e));
  }
  /** convert the accumulator from type `from` to type `to` */
  function convert(from, to, dirty) {
    if (to.size === 8) {
      if (from.size === 8) return false;
      if (from.signed) emit('cdqe');                  // sign-extend eax into rax
      else if (dirty) emit('mov', 'eax', 'eax');      // zero-extend: a 32-bit write clears the top half
      return false;
    }
    if (to.size === 4) return dirty || from.size === 8;   // truncation: just use the low half (eax)
    // narrowing cast: keep the low byte/word, then extend it back to int as the new type says
    const same = from.size === to.size && from.signed === to.signed;
    const widens = from.size < to.size && (!from.signed || to.signed);
    if (!same && !widens) emit(to.signed ? 'movsx' : 'movzx', 'eax', RN.a[to.size]);
    return false;
  }
  function genUnary(e) {
    const t = promote(ty(e.e)), acc = A(t);
    genAs(e.e, t);
    if (e.op === '-') emit('neg', acc, undefined, undefined, alu('neg', t, e));
    else if (e.op === '~') emit('not', acc, undefined, undefined, alu('~', t, e));
    else {
      emit('test', acc, acc, undefined, alu('!', t, e));
      emit('set', undefined, undefined, undefined, { cc: 'e' });
      emit('movzx', 'eax', 'al');
    }
  }
  /** evaluate r then l, leaving l in rax and r in rcx */
  function genPair(l, r, lt, rt) {
    genAs(r, rt);
    emit('push', 'rax');
    genAs(l, lt);
    emit('pop', 'rcx');
  }
  function genBinary(e) {
    if (e.op === '&&' || e.op === '||') {
      const lF = newLabel(), lEnd = newLabel();
      genBranch(e, lF);
      emit('mov', 'eax', 1);
      jump(null, lEnd);
      label(lF);
      emit('mov', 'eax', 0);
      label(lEnd);
      return;
    }
    if (CMP_SIGNED[e.op]) {
      emit('set', undefined, undefined, undefined, { cc: genCmp(e) });
      emit('movzx', 'eax', 'al');
      return;
    }
    const t = ty(e), acc = A(t), info = alu(e.incdec || e.op, t, e, e.compound ? { compound: true } : {});
    if (e.op === '<<' || e.op === '>>') {
      const ins = e.op === '<<' ? 'shl' : t.signed ? 'sar' : 'shr';
      const r = norm(e.r);
      if (r.k === 'num') { genAs(e.l, t); emit(ins, acc, Number(BigInt.asUintN(8, r.v)), undefined, info); }
      else { genPair(e.l, e.r, t, promote(ty(e.r))); emit(ins, acc, 'cl', undefined, info); }
      return;
    }
    if (e.op === '/' || e.op === '%') { genDivide(e, t, info); return; }
    const ins = OP_INS[e.op];
    const rv = simpleOperand(e.r, t);
    if (rv !== null) {
      genAs(e.l, t);
      if (ins === 'imul' && typeof rv === 'number') emit('imul', acc, acc, rv, info);
      else emit(ins, acc, rv, undefined, info);
    } else {
      genPair(e.l, e.r, t, t);
      emit(ins, acc, C(t), undefined, info);
    }
  }
  function genDivide(e, t, info) {
    const r = norm(e.r);
    // gcc -O0 folds a signed division by the constant -1 into neg (so INT_MIN / -1 wraps to INT_MIN
    // instead of trapping) and x % -1 into 0; a variable holding -1 still goes through idiv
    const k = constOf(r);
    if (t.signed && k !== null && wrapTo(k, t) === -1n) {
      if (e.op === '/') { genAs(e.l, t); emit('neg', A(t), undefined, undefined, info); } else loadConst('a', 0n, t);
      return;
    }
    let src;
    if (r.k === 'var' && lookup(r).size === t.size) { genAs(e.l, t); src = memOf(lookup(r)); }
    else if (r.k === 'num') { genAs(e.l, t); loadConst('c', wrapTo(r.v, t), t); src = C(t); }
    else { genPair(e.l, e.r, t, t); src = C(t); }
    // the dividend is rdx:rax — sign-extend it for idiv, zero it for div
    if (t.signed) emit(t.size === 8 ? 'cqo' : 'cdq');
    else emit('mov', 'edx', 0);
    emit(t.signed ? 'idiv' : 'div', src, undefined, undefined, info);
    if (e.op === '%') emit('mov', A(t), D(t));
  }
  /** set flags for a comparison; returns the condition code (signed or unsigned by the common type) */
  function genCmp(e) {
    const t = commonType(ty(e.l), ty(e.r)), acc = A(t);
    const rv = simpleOperand(e.r, t);
    // like gcc -O0, an unsigned a > b or a <= b against a non-constant b is rewritten as b < a or
    // b >= a: cmp b, a then setb / setae (so CF = 1 exactly when the original test is true for >)
    if (!t.signed && (e.op === '>' || e.op === '<=') && constOf(e.r) === null) {
      const info = alu(e.op, t, e, { swapped: true });
      if (rv !== null) { genAs(e.l, t); emit('cmp', rv, acc, undefined, info); }
      else { genPair(e.l, e.r, t, t); emit('cmp', C(t), acc, undefined, info); }
      return e.op === '>' ? 'b' : 'ae';
    }
    if (rv !== null) { genAs(e.l, t); emit('cmp', acc, rv, undefined, alu(e.op, t, e)); }
    else { genPair(e.l, e.r, t, t); emit('cmp', acc, C(t), undefined, alu(e.op, t, e)); }
    return (t.signed ? CMP_SIGNED : CMP_UNSIGNED)[e.op];
  }
  /** jump to `target` when condition e is false (jumpIfTrue: when true) */
  function genBranch(e, target, jumpIfTrue = false) {
    e = norm(e);
    const saved = cur.node;
    cur.node = e;
    if (e.k === 'bin' && CMP_SIGNED[e.op]) {
      const cc = genCmp(e);
      jump(jumpIfTrue ? cc : INV[cc], target);
    } else if (e.k === 'bin' && (e.op === '&&' || e.op === '||')) {
      if ((e.op === '&&') !== jumpIfTrue) { genBranch(e.l, target, jumpIfTrue); genBranch(e.r, target, jumpIfTrue); }
      else { const skip = newLabel(); genBranch(e.l, skip, !jumpIfTrue); genBranch(e.r, target, jumpIfTrue); label(skip); }
    } else if (e.k === 'un' && e.op === '!') {
      genBranch(e.e, target, !jumpIfTrue);
    } else {
      const t = promote(ty(e));
      genAs(e, t);
      emit('test', A(t), A(t));
      jump(jumpIfTrue ? 'ne' : 'e', target);
    }
    cur.node = saved;
  }

  // ---- statements ----
  function storeConst(v, val, st) {
    cur.node = st;
    const s = BigInt.asIntN(v.size * 8, val);
    if (v.size === 8 && !fitsImm32(s)) { loadConst('a', val, v.ctype); emit('mov', memOf(v), 'rax'); return; }
    emit('mov', memOf(v), Number(s));
  }
  /** v = e, converting to v's type (a narrower store simply keeps the low bits) */
  function assignExpr(v, e, st) {
    const n = norm(e);
    if (n.k === 'num') { storeConst(v, wrapTo(n.v, v.ctype), st); return; }
    if (v.size === 8) genAs(e, v.ctype); else gen(e);
    cur.node = st;
    emit('mov', memOf(v), RN.a[v.size]);
  }
  function compoundNode(v, op, e, st, more = {}) {
    const l = { k: 'var', name: v.name, line: st.line, col: st.col, id: -1 };
    return { k: 'bin', op, l, r: e, id: st.id, line: st.line, col: st.col, endLine: st.endLine, endCol: st.endCol, compound: true, ...more };
  }
  function genIncDec(s) {
    const v = lookup({ name: s.name, line: s.line, col: s.nameCol });
    if (v.size >= 4) { emit(s.op === '++' ? 'add' : 'sub', memOf(v), 1, undefined, alu(s.op, v.ctype, s, { incdec: true })); return; }
    // char/short: C adds in int, then narrows on the store (just as gcc -O0 does)
    const one = { k: 'num', v: 1n, type: INT, text: '1', line: s.line, col: s.col, id: -1 };
    assignExpr(v, compoundNode(v, s.op[0], one, s, { incdec: s.op }), s);
  }
  function genPrintf(s) {
    const regs = ['si', 'd', 'c', 'r8', 'r9'];
    const types = s.args.map((a) => {
      const t = promote(ty(a));                      // default argument promotions
      genAs(a, t);
      cur.node = s;
      emit('push', 'rax');
      return t;
    });
    for (let k = s.args.length - 1; k >= 0; k--) {
      const size = types[k].size === 8 ? 8 : 4;
      emit('pop', 'rax');
      emit('mov', RN[regs[k]][size], RN.a[size]);
    }
    let si = strings.indexOf(s.fmt);
    if (si < 0) { si = strings.length; strings.push(s.fmt); }
    emit('lea_fmt', undefined, undefined, undefined, { str: si });
    emit('mov', 'eax', 0);                           // no vector registers used (varargs convention)
    emit('call', undefined, undefined, undefined, { fmt: s.fmt, nargs: s.args.length });
  }
  function genStmt(s) {
    cur.stmt = s; cur.line = s.line; cur.node = s;
    switch (s.k) {
      case 'block': scopes.push(new Map()); s.body.forEach(genStmt); scopes.pop(); break;
      case 'decl':
        for (const it of s.items) {
          cur.line = it.line; cur.stmt = s; cur.node = s;
          // the initialiser is compiled before the name is in scope ("int x = x;" is an error here)
          const v = newVar(it);
          if (it.init) assignExpr(v, it.init, s);
          scopes[scopes.length - 1].set(it.name, v);
        }
        break;
      case 'assign': {
        const v = lookup(s);
        assignExpr(v, s.op === '=' ? s.e : compoundNode(v, s.op.slice(0, -1), s.e, s), s);
        break;
      }
      case 'incdec': genIncDec(s); break;
      case 'printf': genPrintf(s); break;
      case 'if': {
        const lElse = newLabel(), lEnd = newLabel();
        cur.ctl = 'if'; genBranch(s.c, lElse); cur.ctl = null;
        genStmt(s.t);
        if (s.f) {
          cur.line = s.line; cur.stmt = s;
          jump(null, lEnd);
          label(lElse);
          genStmt(s.f);
          label(lEnd);
        } else label(lElse);
        break;
      }
      case 'while': {
        const lBody = newLabel(), lCond = newLabel(), lEnd = newLabel();
        jump(null, lCond);
        label(lBody);
        loopsInfo.push({ line: s.line, body: lBody });
        loops.push({ brk: lEnd, cont: lCond }); genStmt(s.body); loops.pop();
        label(lCond);
        cur.line = s.line; cur.stmt = s; cur.node = s; cur.ctl = 'cond';
        genBranch(s.c, lBody, true);
        cur.ctl = null;
        label(lEnd);
        break;
      }
      case 'for': {
        scopes.push(new Map());
        const lBody = newLabel(), lStep = newLabel(), lCond = newLabel(), lEnd = newLabel();
        if (s.init) genStmt(s.init);
        cur.line = s.line; cur.stmt = s;
        jump(null, lCond);
        label(lBody);
        loopsInfo.push({ line: s.line, body: lBody });
        loops.push({ brk: lEnd, cont: lStep }); genStmt(s.body); loops.pop();
        label(lStep);
        if (s.step) { cur.ctl = 'step'; genStmt(s.step); cur.ctl = null; }
        label(lCond);
        cur.line = s.line; cur.stmt = s; cur.node = s; cur.ctl = 'cond';
        if (s.c) genBranch(s.c, lBody, true); else jump(null, lBody);
        cur.ctl = null;
        label(lEnd);
        scopes.pop();
        break;
      }
      case 'return':
        if (s.e) genAs(s.e, INT); else emit('mov', 'eax', 0);
        cur.node = s;
        emit('leave');
        emit('ret');
        break;
      case 'break': case 'continue': {
        const lp = loops[loops.length - 1];
        if (!lp) throw new CError(`"${s.k}" only works inside a loop`, s.line, s.col, 'syntax');
        jump(null, s.k === 'break' ? lp.brk : lp.cont);
        break;
      }
      default: throw new Error('stmt ' + s.k);
    }
  }

  // prologue, body, epilogue
  cur = { line: 0, node: null, stmt: null, ctl: null };
  emit('push', 'rbp');
  emit('mov_rbp_rsp');
  const frameAt = code.length;
  ast.body.forEach(genStmt);
  cur = { line: lines.length, node: null, stmt: null, ctl: null };
  emit('mov', 'eax', 0);
  emit('leave');
  emit('ret');
  // locals live below rbp; reserve them so pushes and calls never overwrite them
  const usesStack = code.some((x) => x.op === 'push' && x.a === 'rax') || code.some((x) => x.op === 'call');
  const frame = Math.max(Math.ceil(frameUsed / 16) * 16, usesStack ? 16 : 0);
  if (frame > 0 && (vars.length || usesStack)) code.splice(frameAt, 0, { op: 'sub_rsp', b: frame, line: 0, node: null });

  return assemble({ src, lines, ast, vars, code, strings, loopsInfo, frame });
}

/** lay out instructions, choose short or long jumps (as GNU as does), fill in bytes and text */
function assemble({ src, lines, ast, vars, code, strings, loopsInfo, frame }) {
  const BASE = 0x401136;
  const insts = code.filter((x) => x.label === undefined);
  const labelIdx = new Map();
  { let n = 0; for (const x of code) { if (x.label !== undefined) labelIdx.set(x.label, n); else n++; } }
  insts.forEach((ins) => { ins.long = false; });
  // branch relaxation: start short, lengthen any jump whose target is out of rel8 range, repeat
  let changed = true, guard = 0;
  while (changed && guard++ < 20) {
    changed = false;
    let addr = BASE;
    for (const ins of insts) { ins.addr = addr; ins.size = encode(ins, 0, ins.long).length; addr += ins.size; }
    const endAddr = addr;
    const at = (l) => { const k = labelIdx.get(l); return k < insts.length ? insts[k].addr : endAddr; };
    for (const ins of insts) {
      if (ins.target === undefined) continue;
      const rel = at(ins.target) - (ins.addr + ins.size);
      if (!ins.long && !isImm8(rel)) { ins.long = true; changed = true; }
    }
  }
  const endAddr = insts.length ? insts[insts.length - 1].addr + insts[insts.length - 1].size : BASE;
  const labelAddr = (l) => { const k = labelIdx.get(l); return k < insts.length ? insts[k].addr : endAddr; };
  insts.forEach((ins, i) => {
    ins.i = i;
    if (ins.target !== undefined) {
      ins.tIndex = labelIdx.get(ins.target);
      ins.bytes = encode(ins, labelAddr(ins.target) - (ins.addr + ins.size), ins.long);
    } else ins.bytes = encode(ins);
    ins.text = text(ins, labelAddr);
    ins.asText = text(ins);          // with symbolic labels (for GNU as)
  });
  const loopBodies = loopsInfo.map((l) => ({ line: l.line, inst: labelIdx.get(l.body) }));
  return { src, lines, ast, vars, insts, code, strings, labelIdx, base: BASE, frame, loopBodies };
}

// ------------------------------------------------------------ printf

/** interpret a raw register value (BigInt bit pattern) as printf would for this conversion */
function fmtOne(flags, width, prec, len, conv, raw) {
  const v = BigInt(raw);
  if (conv === 'c') {
    const s = String.fromCharCode(Number(BigInt.asUintN(8, v)));
    return flags.includes('-') ? s.padEnd(width) : s.padStart(width);
  }
  const bits = len === 'l' ? 64 : len === 'h' ? 16 : len === 'hh' ? 8 : 32;
  const signedConv = conv === 'd' || conv === 'i';
  const n = signedConv ? BigInt.asIntN(bits, v) : BigInt.asUintN(bits, v);
  const neg = n < 0n, mag = neg ? -n : n;
  const radix = conv === 'o' ? 8 : conv === 'x' || conv === 'X' ? 16 : 10;
  let digits = mag.toString(radix);
  if (conv === 'X') digits = digits.toUpperCase();
  if (prec !== null) digits = prec === 0 && mag === 0n ? '' : digits.padStart(prec, '0');
  if (flags.includes('#') && conv === 'o' && digits[0] !== '0') digits = '0' + digits;
  let prefix = neg ? '-' : signedConv && flags.includes('+') ? '+' : signedConv && flags.includes(' ') ? ' ' : '';
  if (flags.includes('#') && mag !== 0n && (conv === 'x' || conv === 'X')) prefix += conv === 'x' ? '0x' : '0X';
  const body = prefix + digits;
  if (body.length >= width) return body;
  if (flags.includes('-')) return body.padEnd(width);
  if (flags.includes('0') && prec === null) return prefix + digits.padStart(width - prefix.length, '0');
  return body.padStart(width);
}

/** format like glibc printf; args are the raw argument registers (BigInt or Number) */
export function formatPrintf(fmt, args) {
  let k = 0;
  return fmt.replace(FMT_RE, (m, flags, width, prec, len, conv) => {
    if (m === '%%') return '%';
    return fmtOne(flags, +width || 0, prec === undefined ? null : +prec || 0, len, conv, args[k++] ?? 0n);
  });
}

// ------------------------------------------------------------ emulator

const MASK = { 8: 0xffn, 16: 0xffffn, 32: 0xffffffffn, 64: 0xffffffffffffffffn };
const msb = (v, w) => Number((v >> BigInt(w - 1)) & 1n);
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
/** a bit pattern read as a C value: Number when it fits exactly, BigInt otherwise */
const cValue = (bits, w, signed) => {
  const v = signed ? BigInt.asIntN(w, bits) : BigInt.asUintN(w, bits);
  return v >= -SAFE && v <= SAFE ? Number(v) : v;
};
const TRACE_REGS = [['rax', 0], ['rcx', 1], ['rdx', 2], ['rsi', 6], ['rdi', 7], ['r8', 8], ['r9', 9]];
const STACK_HI = 0x7ffe0000, STACK_SIZE = 0x10000, STACK_LO = STACK_HI - STACK_SIZE;
const RETURN_ADDR = 0x7f3a1c02a1caan;       // where main "returns to" (libc); a sentinel here

/**
 * Execute the compiled program instruction by instruction.
 * Returns { output, ret, exit, count, steps, aluLog, execCount, finalVars } and, with trace, events:
 *   steps     – statement-level steps (line changes): { line, writes: [{ v, name, type, val }], out, inst, stmt }
 *   aluLog    – per ALU instruction index: { i, n, first, last: [≤ 3 recs] }, rec = { a, b, r, flags, step, n, width, signed }
 *   events    – per executed instruction (first traceLimit): { n, i, line, text, before, after, flagsBefore,
 *               flagsAfter, a?, b?, r?, width?, write? }; registers and a/b/r are unsigned BigInt bit patterns
 * C values (val, a/b/r in aluLog, finalVars) are Numbers, or BigInts when a 64-bit value is beyond ±2^53.
 */
export function run(prog, o = {}) {
  const maxSteps = o.maxSteps ?? LIMITS.steps;
  const trace = !!o.trace, traceLimit = o.traceLimit ?? 4000;
  const { insts, vars } = prog;
  const regs = new Array(10).fill(0n);            // unsigned 64-bit patterns, indexed by register number
  const F = { CF: 0, ZF: 0, SF: 0, OF: 0 };
  const stack = new DataView(new ArrayBuffer(STACK_SIZE));
  let rsp = STACK_HI - 0x1d8, rbp = STACK_HI - 0x100;
  let output = '', ip = 0, count = 0;
  const execCount = new Uint32Array(insts.length);
  const slotVar = new Map(vars.map((v) => [v.d, v]));
  const steps = [];
  let curStep = null;
  const varVals = new Map();
  const hasValue = new Set();                     // ids of variables written at least once
  const aluLog = new Map();
  const events = trace ? [] : undefined;
  let eventsTruncated = false;

  // ---- registers and memory ----
  const rdReg = (name) => { const [n, w] = REG[name]; return regs[n] & MASK[w]; };
  const wrReg = (name, v) => {
    const [n, w] = REG[name];
    v &= MASK[w];
    // 32-bit writes zero the top half; 8- and 16-bit writes keep the rest of the register
    regs[n] = w >= 32 ? v : (regs[n] & ~MASK[w]) | v;
  };
  const offset = (addr, w) => {
    const off = addr - STACK_LO;
    if (off < 0 || off + w / 8 > STACK_SIZE) throw new CError('The program touched memory outside its stack', insts[ip].line, 1, 'runtime');
    return off;
  };
  const rdMem = (addr, w) => {
    const off = offset(addr, w);
    if (w === 8) return BigInt(stack.getUint8(off));
    if (w === 16) return BigInt(stack.getUint16(off, true));
    if (w === 32) return BigInt(stack.getUint32(off, true));
    return stack.getBigUint64(off, true);
  };
  const wrMem = (addr, w, v) => {
    const off = offset(addr, w);
    if (w === 8) stack.setUint8(off, Number(v & 0xffn));
    else if (w === 16) stack.setUint16(off, Number(v & 0xffffn), true);
    else if (w === 32) stack.setUint32(off, Number(v & 0xffffffffn), true);
    else stack.setBigUint64(off, BigInt.asUintN(64, v), true);
  };
  const push = (v) => { rsp -= 8; wrMem(rsp, 64, v); };
  const pop = () => { const v = rdMem(rsp, 64); rsp += 8; return v; };
  push(RETURN_ADDR);

  // ---- operands ----
  const val = (x, w) => {
    if (isMem(x)) {
      // gcc leaves a local without an initialiser holding whatever was in that memory, so there is
      // no honest value to show: stop rather than pretend C sets it to 0
      const vr = slotVar.get(x.d);
      if (vr && !hasValue.has(vr.id)) {
        throw new CError(`"${vr.name}" is used before it has been given a value. In C it holds whatever was left in that memory (not 0), so this lab stops here.`, insts[ip].line, 1, 'runtime');
      }
      return rdMem(rbp + x.d, x.w);
    }
    if (typeof x === 'string') return rdReg(x);
    return BigInt.asUintN(w, BigInt(x));           // immediates are sign-extended to the operand width
  };
  let write = null;
  const store = (x, v) => {
    if (!isMem(x)) { wrReg(x, v); return; }
    v &= MASK[x.w];
    wrMem(rbp + x.d, x.w, v);
    const vr = slotVar.get(x.d);
    if (vr) hasValue.add(vr.id);
    write = { d: x.d, width: x.w, val: v, v: vr ? vr.id : undefined };
    if (vr && vr.size * 8 === x.w) {
      const cv = cValue(v, x.w, vr.ctype.signed);
      varVals.set(vr.id, cv);
      if (curStep) curStep.writes.push({ v: vr.id, name: vr.name, type: vr.type, val: cv });
    }
  };

  // ---- flags, computed at the operand width exactly as x86 does ----
  const setZS = (r, w) => { F.ZF = r === 0n ? 1 : 0; F.SF = msb(r, w); };
  const flagsAdd = (a, b, r, w) => { setZS(r, w); F.CF = a + b > MASK[w] ? 1 : 0; F.OF = msb(a, w) === msb(b, w) && msb(r, w) !== msb(a, w) ? 1 : 0; };
  const flagsSub = (a, b, r, w) => { setZS(r, w); F.CF = a < b ? 1 : 0; F.OF = msb(a, w) !== msb(b, w) && msb(r, w) !== msb(a, w) ? 1 : 0; };
  const flagsLogic = (r, w) => { setZS(r, w); F.CF = 0; F.OF = 0; };
  const cond = (cc) => {
    switch (cc) {
      case 'e': return F.ZF === 1;
      case 'ne': return F.ZF === 0;
      case 'l': return F.SF !== F.OF;
      case 'ge': return F.SF === F.OF;
      case 'le': return F.ZF === 1 || F.SF !== F.OF;
      case 'g': return F.ZF === 0 && F.SF === F.OF;
      case 'b': return F.CF === 1;
      case 'ae': return F.CF === 0;
      case 'be': return F.CF === 1 || F.ZF === 1;
      case 'a': return F.CF === 0 && F.ZF === 0;
      default: throw new Error('cc ' + cc);
    }
  };

  // ---- ALU operation record (for events and aluLog) ----
  let op3 = null;
  const logAlu = (ins, a, b, r, w, extra = {}) => {
    op3 = b === null ? { a, r, width: w, ...extra } : { a, b, r, width: w, ...extra };
    if (!ins.alu) return;
    let e = aluLog.get(ins.i);
    if (!e) { e = { i: ins.i, n: 0, first: null, last: [] }; aluLog.set(ins.i, e); }
    const s = ins.alu.signed;
    const rec = { a: cValue(a, w, s), b: b === null ? null : cValue(b, w, s), r: cValue(r, w, s), flags: { ...F }, step: steps.length - 1, n: e.n, width: w, signed: s };
    if (!e.first) e.first = rec;
    e.last.push(rec);
    if (e.last.length > 3) e.last.shift();
    e.n++;
  };
  const fault = (ins, msg) => new CError(msg, ins.line, 1, 'runtime');

  function divide(ins, signed) {
    const w = widthOf(ins.a), d = val(ins.a, w);
    const lo = rdReg(RN.a[w / 8]), hi = rdReg(RN.d[w / 8]);
    const wide = (hi << BigInt(w)) | lo;
    if (d === 0n) throw fault(ins, 'Division by zero — the processor raises a divide error and the program is killed (SIGFPE)');
    const x = signed ? BigInt.asIntN(2 * w, wide) : wide;
    const y = signed ? BigInt.asIntN(w, d) : d;
    const q = x / y, rem = x % y;                  // BigInt division truncates toward zero, like idiv
    const lim = signed ? [-(1n << BigInt(w - 1)), (1n << BigInt(w - 1)) - 1n] : [0n, MASK[w]];
    if (q < lim[0] || q > lim[1]) {
      throw fault(ins, `${x} / ${y} doesn't fit in ${w} bits, so the processor raises a divide error and the program is killed (SIGFPE)`);
    }
    wrReg(RN.a[w / 8], q);
    wrReg(RN.d[w / 8], rem);
    const isRem = ins.alu && ins.alu.op === '%';
    logAlu(ins, BigInt.asUintN(w, x), d, BigInt.asUintN(w, isRem ? rem : q), w, { q: BigInt.asUintN(w, q), rem: BigInt.asUintN(w, rem) });
  }
  function shift(ins) {
    const { op, a, b } = ins;
    const w = widthOf(a), x = val(a, w);
    const n = BigInt((b === 'cl' ? Number(rdReg('cl')) : b) & (w === 64 ? 63 : 31));   // the CPU masks the count
    let r = x;
    if (n > 0n) {
      const k = Number(n);
      if (op === 'shl') { r = (x << n) & MASK[w]; F.CF = Number((x >> BigInt(w - k)) & 1n); F.OF = msb(r, w) ^ F.CF; }
      else if (op === 'shr') { r = x >> n; F.CF = Number((x >> (n - 1n)) & 1n); F.OF = msb(x, w); }
      else { const sx = BigInt.asIntN(w, x); r = BigInt.asUintN(w, sx >> n); F.CF = Number((sx >> (n - 1n)) & 1n); F.OF = 0; }
      setZS(r, w);                                  // a zero count leaves every flag alone
    }
    logAlu(ins, x, n, r, w);
    store(a, r);
  }
  function callPrintf(ins) {
    const s = formatPrintf(ins.fmt, [regs[6], regs[2], regs[1], regs[8], regs[9]].slice(0, ins.nargs));
    output += s;
    if (curStep) curStep.out += s;
    if (output.length > LIMITS.output) throw new CError(`The program printed more than ${LIMITS.output} characters, so it was stopped`, ins.line, 1, 'limit');
    // printf returns the character count; the caller-saved registers are clobbered
    regs[0] = BigInt(s.length);
    for (const n of [1, 2, 6, 7, 8, 9]) regs[n] = 0n;
  }

  function exec(ins) {
    const { op, a, b, c } = ins;
    let next = ip + 1;
    switch (op) {
      case 'push': push(a === 'rbp' ? BigInt(rbp) : rdReg(a)); break;
      case 'pop': { const v = pop(); if (a === 'rbp') rbp = Number(v); else wrReg(a, v); break; }
      case 'mov_rbp_rsp': rbp = rsp; break;
      case 'sub_rsp': rsp -= b; break;
      case 'leave': rsp = rbp; rbp = Number(pop()); break;
      case 'ret': {
        if (pop() !== RETURN_ADDR) throw fault(ins, 'The program returned to a bad address');
        return -1;
      }
      case 'mov': { const w = widthOf(a); store(a, val(b, w)); break; }
      case 'movabs': wrReg(a, BigInt.asUintN(64, b)); break;
      case 'movsx': case 'movzx': {
        const sw = widthOf(b), x = val(b, sw);
        wrReg(a, op === 'movsx' ? BigInt.asUintN(64, BigInt.asIntN(sw, x)) : x);
        break;
      }
      case 'cdq': wrReg('edx', msb(rdReg('eax'), 32) ? MASK[32] : 0n); break;
      case 'cqo': wrReg('rdx', msb(regs[0], 64) ? MASK[64] : 0n); break;
      case 'cdqe': regs[0] = BigInt.asUintN(64, BigInt.asIntN(32, regs[0] & MASK[32])); break;
      case 'add': case 'sub': case 'cmp': {
        const w = widthOf(a), x = val(a, w), y = val(b, w);
        const r = (op === 'add' ? x + y : x - y) & MASK[w];
        if (op === 'add') flagsAdd(x, y, r, w); else flagsSub(x, y, r, w);
        logAlu(ins, x, y, r, w);
        if (op !== 'cmp') store(a, r);
        break;
      }
      case 'and': case 'or': case 'xor': {
        const w = widthOf(a), x = val(a, w), y = val(b, w);
        const r = op === 'and' ? x & y : op === 'or' ? x | y : x ^ y;
        flagsLogic(r, w);
        logAlu(ins, x, y, r, w);
        store(a, r);
        break;
      }
      case 'test': { const w = widthOf(a), x = val(a, w), y = val(b, w); flagsLogic(x & y, w); logAlu(ins, x, y, x & y, w); break; }
      case 'imul': {
        // SF and ZF are undefined after imul; they are left unchanged here
        const w = widthOf(a), x = c !== undefined ? val(b, w) : val(a, w), y = c !== undefined ? val(c, w) : val(b, w);
        const full = BigInt.asIntN(w, x) * BigInt.asIntN(w, y), r = BigInt.asUintN(w, full);
        F.CF = F.OF = BigInt.asIntN(w, r) !== full ? 1 : 0;
        logAlu(ins, x, y, r, w);
        store(a, r);
        break;
      }
      case 'idiv': case 'div': divide(ins, op === 'idiv'); break;   // flags are undefined; left unchanged
      case 'neg': { const w = widthOf(a), x = val(a, w), r = (0n - x) & MASK[w]; flagsSub(0n, x, r, w); logAlu(ins, 0n, x, r, w); store(a, r); break; }
      case 'not': { const w = widthOf(a), x = val(a, w), r = ~x & MASK[w]; logAlu(ins, x, null, r, w); store(a, r); break; }
      case 'shl': case 'shr': case 'sar': shift(ins); break;
      case 'set': wrReg('al', cond(ins.cc) ? 1n : 0n); break;
      case 'lea_fmt': regs[7] = BigInt(0x402004 + ins.str * 16); break;   // a stand-in .rodata address
      case 'call': callPrintf(ins); break;
      case 'jmp': next = ins.tIndex; break;
      case 'j': if (cond(ins.cc)) next = ins.tIndex; break;
      default: throw new Error('exec ' + op);
    }
    return next;
  }

  const snapRegs = () => Object.fromEntries(TRACE_REGS.map(([name, n]) => [name, regs[n]]));
  let lastLine = -1;
  while (true) {
    if (ip < 0 || ip >= insts.length) throw new CError('Execution ran off the end of the program', 0, 0, 'runtime');
    const ins = insts[ip];
    if (++count > maxSteps) throw new CError(`Stopped after ${maxSteps.toLocaleString('en-GB')} instructions — is there a loop that never ends?`, ins.line, 1, 'limit');
    if (ins.line && ins.line !== lastLine) {
      lastLine = ins.line;
      curStep = { line: ins.line, writes: [], out: '', inst: count - 1, stmt: ins.stmt ? ins.stmt.id : 0 };
      if (steps.length < 5000) steps.push(curStep); else curStep = { ...curStep, writes: [] };
    }
    execCount[ip]++;
    const recording = trace && events.length < traceLimit;
    if (trace && !recording) eventsTruncated = true;
    const before = recording ? snapRegs() : null, flagsBefore = recording ? { ...F } : null;
    op3 = null;
    write = null;
    const next = exec(ins);
    if (recording) {
      const ev = { n: count - 1, i: ip, line: ins.line, text: ins.text, before, after: snapRegs(), flagsBefore, flagsAfter: { ...F } };
      if (op3) Object.assign(ev, op3);
      if (write) ev.write = write;
      events.push(ev);
    }
    if (next < 0) break;
    ip = next;
  }
  const eax = regs[0] & MASK[32];
  const res = {
    output, ret: Number(BigInt.asIntN(32, eax)), exit: Number(eax & 255n), count, steps, aluLog, execCount,
    finalVars: new Map(varVals),
  };
  if (trace) { res.events = events; res.eventsTruncated = eventsTruncated; }
  return res;
}

export { lex, parse };
