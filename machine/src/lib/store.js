// localStorage that never throws (private windows, managed Chromebooks and
// blocked storage all happen in schools). Values are JSON under a 'pm.' prefix.
const PREFIX = 'pm.';
const memory = new Map();          // fallback when storage is unavailable

function ls() {
  try { const s = window.localStorage; const k = `${PREFIX}__probe`; s.setItem(k, '1'); s.removeItem(k); return s; } catch { return null; }
}
let storage = null;
function S() { if (storage === null) storage = ls() || false; return storage || null; }

export function load(key, fallback = null) {
  const s = S();
  try {
    const raw = s ? s.getItem(PREFIX + key) : memory.get(key);
    if (raw === null || raw === undefined) return fallback;
    return JSON.parse(raw);
  } catch { return fallback; }
}

export function save(key, value) {
  const raw = JSON.stringify(value);
  const s = S();
  try { if (s) s.setItem(PREFIX + key, raw); else memory.set(key, raw); return true; } catch { memory.set(key, raw); return false; }
}

export function remove(key) {
  const s = S();
  try { if (s) s.removeItem(PREFIX + key); } catch { /* ignore */ }
  memory.delete(key);
}

/** true when the browser keeps data between visits (shown to learners so they know to save their review link) */
export function persistent() { return !!S(); }

/** remove everything this app stored on this device (shared Chromebooks) */
export function clearAll() {
  const s = S();
  try {
    if (s) {
      const keys = [];
      for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k && k.startsWith(PREFIX)) keys.push(k); }
      keys.forEach((k) => s.removeItem(k));
    }
  } catch { /* ignore */ }
  memory.clear();
}
