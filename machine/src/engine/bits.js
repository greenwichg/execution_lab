// n-bit integer arithmetic that keeps its working: every carry, every lost
// bit and every flag. Items compute their answer keys here, so learners are
// always marked against a simulation, never against a hand-typed answer.
// Bit arrays are LSB-first (bits[0] is bit 0). Widths up to 32 bits stay
// exact because every intermediate value is a safe JS integer.

const pow2 = (w) => 2 ** w;

/** v reduced to w bits, as an unsigned value (wraps like the hardware does) */
export function toUnsigned(v, w) {
  const m = pow2(w);
  return ((Math.trunc(v) % m) + m) % m;
}

/** v reduced to w bits, read as two's complement */
export function toSigned(v, w) {
  const u = toUnsigned(v, w);
  return u >= pow2(w - 1) ? u - pow2(w) : u;
}

/** LSB-first bits of v in w bits (negatives come out in two's complement) */
export function toBits(value, w) {
  let u = toUnsigned(value, w);
  const bits = new Array(w);
  for (let i = 0; i < w; i++) { bits[i] = u % 2; u = Math.floor(u / 2); }
  return bits;
}

/** value of an LSB-first bit array; signed reads the top bit as −2^(w−1) */
export function fromBits(bits, { signed = false } = {}) {
  let v = 0;
  for (let i = bits.length - 1; i >= 0; i--) v = v * 2 + (bits[i] ? 1 : 0);
  if (signed && bits.length && bits[bits.length - 1]) v -= pow2(bits.length);
  return v;
}

/** { min, max } of a w-bit integer */
export function range(w, signed = false) {
  return signed ? { min: -pow2(w - 1), max: pow2(w - 1) - 1 } : { min: 0, max: pow2(w) - 1 };
}

// Operands may arrive as numbers or as bit arrays; the adder only sees bits.
const asBits = (x, w) => (Array.isArray(x) ? x.slice(0, w).map((b) => (b ? 1 : 0)) : toBits(x, w));

/**
 * Ripple-carry addition. carries[i] is the carry INTO column i, so
 * carries[0] = cin and carries[w] = the carry out of the top column.
 * OF = carry into the sign column XOR carry out of it (signed overflow).
 */
export function addBits(a, b, w, cin = 0) {
  const A = asBits(a, w);
  const B = asBits(b, w);
  const result = new Array(w);
  const carries = new Array(w + 1);
  carries[0] = cin ? 1 : 0;
  for (let i = 0; i < w; i++) {
    const s = A[i] + B[i] + carries[i];
    result[i] = s & 1;
    carries[i + 1] = s >> 1;
  }
  const cout = carries[w];
  const value = fromBits(result);
  return {
    result, carries, cout, value,
    CF: cout,
    OF: carries[w - 1] ^ carries[w],
    SF: result[w - 1],
    ZF: value === 0 ? 1 : 0,
  };
}

/**
 * Subtraction the way an ALU does it: a + ~b + 1. The adder's carry out is 1
 * when there is NO borrow, so x86's CF (the borrow) is its inverse. `binv` is
 * the inverted b that actually went into the adder (for column diagrams).
 */
export function subBits(a, b, w) {
  const binv = asBits(b, w).map((x) => 1 - x);
  const r = addBits(asBits(a, w), binv, w, 1);
  return { ...r, CF: 1 - r.cout, binv };
}

/**
 * Shift x (number or bits) k places. `lost` lists the bit indices of x that
 * fall off the end; `fill` is the bit shifted in (the sign bit for an
 * arithmetic right shift, otherwise 0).
 */
export function shiftBits(x, w, dir, k, kind = 'logical') {
  const X = asBits(x, w);
  const fill = dir === 'R' && kind === 'arithmetic' ? X[w - 1] : 0;
  const bits = new Array(w);
  const lost = [];
  if (dir === 'L') {
    for (let i = 0; i < w; i++) bits[i] = i - k >= 0 ? X[i - k] : fill;
    for (let i = Math.max(0, w - k); i < w; i++) lost.push(i);
  } else {
    for (let i = 0; i < w; i++) bits[i] = i + k < w ? X[i + k] : fill;
    for (let i = 0; i < Math.min(k, w); i++) lost.push(i);
  }
  return { bits, lost, fill };
}
