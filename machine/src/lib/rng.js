// Deterministic randomness. Generators take an rng so the same seed always
// gives the same items (set codes, review links and tests rely on this).

/** mulberry32: small, fast, good enough for question generation */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hash of a string */
export function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** combine numbers into one seed (order matters) */
export function mixSeed(...parts) { return hashStr(parts.map(String).join('|')); }

export function randInt(rng, lo, hi) { return lo + Math.floor(rng() * (hi - lo + 1)); }
export function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
export function shuffle(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
export function chance(rng, p) { return rng() < p; }

/** a fresh random seed (crypto when available) */
export function newSeed() {
  try {
    const u = new Uint32Array(1);
    globalThis.crypto.getRandomValues(u);
    return u[0] >>> 0;
  } catch {
    return (Math.random() * 4294967296) >>> 0;
  }
}
