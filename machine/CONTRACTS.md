# Predict the Machine — architecture and contracts

Predict the Machine is a practice-and-diagnosis tool for **fixed-width integer
arithmetic**, from GCSE binary addition to CS:APP C on x86-64. Every screen runs
one loop:

1. **Predict**: the learner commits an answer plus a confidence rating.
2. **Verify**: the answer is checked against a real simulation (`engine/`).
3. **Diagnose**: find the *first* place the learner's model broke (a cell, a
   column, a line), using up to 3 checkpoint questions when needed.
4. **Explain**: *Why? ↓* opens one layer per click, at most 2 sentences each:
   line → instruction → registers/flags → bit columns → full adder.
5. **Practise**: a fresh variant aimed at the same misconception.
6. **Return**: misses come back after 2, 7 and 21 days (review queue) or in the
   class's next starter.

This file is the contract between modules. Code must follow it exactly; if a
contract is wrong, fix the contract *and* every caller.

## Hard constraints (product decisions, not preferences)

- **No network.** No CDN, no fonts, no analytics, no fetch. The page ships a
  CSP with `connect-src 'none'`. Everything a learner or teacher types stays on
  their device. No accounts, no names, no emails.
- **No three.js, no audio, no autoplay, no music.** 2D HTML/SVG only. Motion is
  short (≤ 600 ms), purposeful, and disabled under `prefers-reduced-motion`.
- **Fast on a £200 Chromebook.** No dependencies, no build step. The whole app
  is ≤ 650 KB of JS + CSS uncompressed (≈ 210 KB gzipped, which is what a static
  host sends); any one screen loads ≤ 560 KB; time to interactive < 1 s with the
  CPU slowed 4×; no layout thrash; SVG only where a picture explains something.
  (The first budget, "< 500 KB in total", was set before the C compiler and the
  cards existed; the review measured 597 KiB and we chose to restate it rather
  than drop the compiler.)
- **Never `innerHTML` with data.** Build DOM with `h()` from `src/lib/dom.js`.
  Pasted code, URL parameters and pasted result codes are untrusted.
- **Accessible.** Every control reachable and operable by keyboard; visible
  focus; results announced via `announce()`; correct/incorrect never shown by
  colour alone (✓ / ✗ glyphs + text; blue/orange palette); projector digits
  ≥ 48 px.
- **Honest content.** Answers come from computation, never from hand-written
  keys. C cards state what the C standard says *and* what gcc -O0 on x86-64
  does. Assembly is labelled "this lab's compiler (gcc -O0 style)".
- **Explanations are short.** Each Why layer: ≤ 2 sentences in `say`.
  Diagnosis `detail`: ≤ 2 sentences. Plain words; define a term the first time.

## Layout

```
machine/
  index.html            app shell (loads css/*.css and src/main.js)
  CONTRACTS.md          this file
  css/core.css          design tokens + UI kit (owned by foundations)
  css/why.css           Why rail + shared parts styles (foundations)
  css/item.css          practice loop, bit grid, Why rail   (UI core)
  css/teacher.css       starter / teacher / set / board      (UI teacher)
  css/cards.css         cards / paste                        (UI cards)
  src/main.js           boot + hash router (owned by foundations)
  src/lib/dom.js        h(), svg(), clear(), announce(), copyText(), download()
  src/lib/store.js      localStorage wrapper (never throws)
  src/lib/rng.js        seeded PRNG + hashing
  src/lib/codec.js      base32, checksums, set codes, result tokens, queue URLs
  src/engine/bits.js    n-bit arithmetic with carries/flags (pure)
  src/engine/minic.js   Mini-C → x86-64 compiler, assembler, emulator (pure)
  src/learn/tagids.js   the fixed, ordered misconception id list (foundations)
  src/learn/spec.js     spec points + topic → item mapping (foundations)
  src/learn/tags.js     binary misconception texts + worked examples (items)
  src/learn/ctags.js    C/x86 misconception texts + worked examples (cards)
  src/learn/catalogue.js  merges tags.js + ctags.js (foundations)
  src/learn/items/*.js  item types: add, shift, twos, sadd, fa + index.js
  src/learn/cards.js    12 CS:APP cards
  src/learn/paste.js    paste-your-own-C: run, bisection, diagnosis, layers
  src/learn/scheduler.js  spaced review queue, fading, holdout
  src/learn/starter.js  teacher starter plan builder
  src/learn/study.js    crossover study arms + analysis
  src/learn/board.js    token aggregation for the teacher board
  src/ui/parts.js       buttons, seg, confidence, statusGlyph, callout, copyBox, tile (foundations)
  src/ui/why.js         renderWhy + renderLayer — every layer kind (foundations)
  src/ui/*.js           runner, bitgrid, session helpers (UI core)
  src/ui/views/*.js     one module per route
```

Everything under `src/engine/`, `src/learn/` and `src/lib/{rng,codec}.js` is
**pure ES modules**: no DOM, no `window`, no `localStorage`, deterministic given
an rng. Node tests import them directly (`tests/*.test.mjs`).

## Randomness

`src/lib/rng.js`:

```js
export function mulberry32(seed) → rng          // rng() ∈ [0,1)
export function hashStr(str) → uint32           // FNV-1a
export function randInt(rng, lo, hi) → int      // inclusive
export function pick(rng, arr), shuffle(rng, arr) (returns new array)
export function newSeed() → uint32              // crypto if available
```

Generators take an `rng`, never call `Math.random()` directly.

## Levels, spec points, topics

`level ∈ 'gcse' | 'alevel' | 'csapp'`.

`src/learn/spec.js` exports `SPECS` (ordered array) of:

```js
{ id: 'J277-1.2.4-add', board: 'OCR GCSE (J277)', code: '1.2.4', title: 'Binary addition and overflow',
  level: 'gcse', topic: 'add', also: 'AQA GCSE (8525): binary addition', make: { type: 'add', opts: {...} } }
```

and helpers `specById(id)`, `specsForLevel(level)`, `specsForTopic(topic)`.
Topics: `add | shift | twos | sadd | fa | c`.

## Misconception tags

`src/learn/tagids.js` exports `TAG_IDS` — a **fixed, ordered** array; index 0 is
`null` (no tag). Result tokens store indices, so **never reorder or remove**;
only append (max 31 entries including index 0).

`src/learn/tags.js` (binary, items owner) and `src/learn/ctags.js` (C, cards
owner) each export an object keyed by tag id:

```js
{
  label:   'Dropped a carry',                       // teacher board, ≤ 40 chars
  student: 'You didn't carry the 1 into the next column.',   // ≤ 2 sentences, second person
  fix:     'When a column adds up to 2 or 3, write the last bit and carry 1 left.', // 1 sentence
  worked(rng) → WorkedExample,
}
WorkedExample = { title: string, steps: [{ subgoal: string, text: string, layer?: Layer }] }  // 3–6 steps
```

`src/learn/catalogue.js` merges both into `TAGS` and exports
`tagIndex(id) → int`, `tagId(index) → id|null`, `tagLabel(id)`.

## Items (the practice unit)

An **item** is fully determined by `(type, params)`; both are JSON so items can
be re-created from URLs, queues and set codes. Each type module in
`src/learn/items/` exports:

```js
export const TYPE = 'add';                  // one of: add shift twos sadd fa card
export const TYPE_ID = 0;                   // add 0, shift 1, twos 2, sadd 3, fa 4, card 5
export function generate(rng, opts) → params          // opts: { level, width?, target?: tagId, ask? }
export function build(params) → Item                  // pure, deterministic
export function blank(item) → Answer                  // empty answer, all fields null
export function mark(item, answer) → Marking
export function diagnose(item, answer, marking, cpAnswers = []) → { next: Checkpoint|null, diagnosis: Diagnosis|null }
export function why(item, diagnosis, { level }) → Layer[]
export function variant(item, tagId, rng) → params    // new values that exercise tagId
export function encodeParams(params) → int[]          // small non-negative ints, for URLs/queues
export function decodeParams(ints) → params           // should throw on ints its generator never makes (review links are untrusted)
```

`src/learn/items/index.js` exports `ITEM_TYPES` (map TYPE → module),
`typeById(TYPE_ID)`, `makeItem(type, params)`, and
`itemForSpec(specId, rng, opts) → { type, params }`,
`itemForTag(tagId, rng, opts) → { type, params }`.

### Item

```js
Item = {
  type, params, level,
  spec: specId,
  prompt: string,                 // e.g. 'Add these 8-bit binary numbers. Fill in every carry.'
  show: { ... },                  // type-specific display data (operands as bit arrays, labels)
  fields: [Field],                // what the learner fills in, in order
  key: Answer,                    // the verified correct answer (computed, never typed by hand)
  family: 'add' | 'shift' | 'twos' | 'flags' | 'c',   // for study/holdout grouping
}
Field = { id, kind: 'bits'|'bit'|'choice'|'number'|'text'|'flags', label, width?, choices?, optional?, decimal? }
// decimal: a number field that accepts non-integers (a shift's "value" answer of 11.25 shows the ×2ⁿ myth)
// Before Check the UI requires every asked field to be answered (all result bits; a choice; a number;
// every flag). Empty carry boxes are allowed: they mean "no carry".
```

Bit arrays are **LSB-first** (`bits[0]` is bit 0). The UI displays MSB on the
left.

### Answer shapes per type

- **add** `params { w, a, b, ask }` (`w` 4–16, default 8; `a`,`b` unsigned;
  `ask: 'full' | 'result'`).
  `Answer { carries: (0|1|null)[w+1], result: (0|1|null)[w+1], overflow: 'yes'|'no'|null }`.
  `carries[i]` = carry INTO column `i`; index 0 is unused (always null);
  `carries[w]` = carry out of the top column. `result[w]` is the optional
  "extra" 9th-bit slot; leaving it empty is correct (writing it triggers
  `add_ninth_bit`). With `ask: 'result'`, carries are not asked or marked.
  GCSE overflow = carry out of the top column.
- **shift** `params { w, x, dir: 'L'|'R', k, kind: 'logical'|'arithmetic', askValue }`
  (generator `opts.kind` may also be `'mixed'`: pick per item).
  `Answer { bits: (0|1|null)[w], value: number|null }` (`value` only when `askValue`).
- **twos** `params { w, n, task: 'encode'|'decode'|'range' }`.
  encode → `{ bits }`; decode → `{ value }`; range → `{ min, max }`.
- **sadd** `params { w, a, b, op: '+'|'-', askFlags: string[] }` (a, b signed).
  `Answer { bits: (0|1|null)[w], flags: { CF?, OF?, SF?, ZF? } }` (0|1|null each).
- **fa** `params { a, b, cin, wires }` → `Answer { sum, cout, x1?, a1?, a2? }`.

Binary item notes (items owner):
- Every binary type's params may carry an optional `level` (encoded by
  `encodeParams`); `item.level` defaults per type when it is absent.
- Each binary type module also exports `TARGETS` (the tag ids `opts.target`
  can aim at). `generate` opts may include `avoid: params` (return different
  numbers) and per type `ask`, `kind`/`dir`/`askValue`, `task`, `op`/`askFlags`, `wires`.
  `itemForTag(tagId, rng, { type?, ...opts })` returns `null` for a tag no
  type practises; `opts.type` chooses e.g. `sadd`/`fa` for `add_*` tags.
- `add`: the result field has `width: w + 1, optionalIndex: w`. In `cells`,
  `null` means "not asked": `carries[0]`, all carries when `ask: 'result'`,
  and `result[w]` when left empty (`'extra'` when filled). An empty carry box
  counts as 0. `sadd`: `cells.flags` is a Status[] in `askFlags` order.
- Checkpoints from add/sadd also carry `column` (and `a, b, c` for the
  column-rule question); the `bits` checkpoint answer is `[sum, carryOut]` (LSB-first).
- Built items also carry `sim` (the engine's full result: carries, flags,
  lost bits) for UI use; it is not part of the JSON identity (`type, params`).

### Marking

```js
Marking = {
  correct: boolean,                            // every asked field right
  cells: { [fieldId]: Status | Status[] },     // Status: 'ok'|'bad'|'missing'|'extra'
  firstWrong: { field, index } | null,         // in *working order* (right-to-left for addition)
  score: { right, total },                     // cells right / cells asked
}
```

### Diagnosis and checkpoints

`diagnose` is called repeatedly. It returns the next checkpoint to ask, or the
final diagnosis. It must finish in **at most 3** checkpoints. When the answer
already shows the working (a full addition grid), return the diagnosis with no
checkpoints. When the learner only gave a result, use checkpoints to locate the
break (for addition: the carry into the first wrong column, then that column's
rule).

```js
Checkpoint = { id, prompt: string, input: { kind: 'bit'|'bits'|'number'|'choice', width?, choices? }, answer: any, accept?: any[] }
// accept: other answers that also count as right (e.g. the paper method's carry in a subtraction)
Diagnosis = {
  tag: tagId | null,                // null when correct or unclassifiable ('other' when wrong but unclassified)
  headline: string,                 // 'Your working first goes wrong in column 3.'
  detail: string,                   // ≤ 2 sentences, from TAGS[tag].student (+ specifics)
  focus: { column?, field?, index?, line?, event? },   // what Why layers should highlight
}
```

Binary items: when the first wrong cell in working order is **empty**, the
diagnosis has `tag: null` (nothing to classify) and a headline saying what was
left empty. A `null` checkpoint answer ("Not sure") is never taken as evidence
of a misconception.

### Why layers

`why()` returns an ordered array, shallow → deep. The UI shows one layer per
click. `say` is 1–2 sentences.

```js
Layer = { id, kind, title, say: string[], data }
```

Kinds and their `data`:

| kind | data |
|---|---|
| `line` | `{ src, line, note }` — the C source and the line in focus |
| `asm` | `{ rows: [{ addr, bytes: 'hex bytes', text, hot }], note }` |
| `regs` | `{ before: {name: value}, after: {name: value}, changed: [name], width }` |
| `flags` | `{ CF, ZF, SF, OF, why: { CF?, OF?, SF?, ZF? } }` (each why ≤ 1 sentence) |
| `columns` | `{ w, a, b, op, carries, result, highlight, dropped, signed, labels: { a, b, r } }` — an addition laid out in columns; `a`,`b`,`result` LSB-first bit arrays, `carries` as in Answer; `dropped` true when the carry out is lost; for subtraction `op: '-'` and `b` is already inverted with `carries[0] = 1` shown. Optional `base` (default 0): the register bit number of column 0, for an 8-bit window of a wider add (cards show bits 31–24 with `base: 24`); then `carries[0]` is the real carry arriving from bit `base − 1`, and `dropped` is only true when the window's top is the register's top bit |
| `column` | `{ k, a, b, cin, sum, cout }` — one column's rule |
| `adder` | `{ a, b, cin, x1, a1, a2, sum, cout }` — a full adder with live wire values (x1 = a⊕b, a1 = a·b, a2 = x1·cin) |
| `shift` | `{ w, before, after, dir, k, fill, lost: [bit indices that fell off] }` |
| `twos` | `{ w, steps: [{ label, bits }] }` — e.g. +5 → invert → add 1 |
| `text` | `{ }` — only `say` is shown |

GCSE layers stop at `column`; A-level and CS:APP may add `adder`.

## CS:APP cards and paste mode

`src/learn/cards.js` exports `CARDS` (12, ordered) and implements the item
interface for `TYPE = 'card'` (`params { id, v }`, `v` = variant seed, `v = 0`
is the canonical card). A built card item also has:

```js
item.card = { id, section: 'CS:APP 2.3.2', title, src, ask, std: { status: 'defined'|'implementation-defined'|'undefined', text }, gcc: string }
```

`ask.kind ∈ 'output' | 'value' | 'flags' | 'branch'`.

`src/learn/paste.js` exports `analyzePaste(src) → { prog, res, events }`,
`markOutput(res, predicted) → Marking`, and
`diagnosePaste(analysis, predicted, cpAnswers) → { next, diagnosis }` (bisection
over variable-write events, ≤ 3 checkpoints), `whyPaste(analysis, diagnosis) → Layer[]`.

Card details (cards owner):

- `CARDS[i] = { id, section: 'CS:APP 2.2.3', title, spec, tags: [tagId], ask: kind }`; `encodeParams` →
  `[cardIndex, v]`, `v` ∈ 0–9999. `generate` opts: `section` ('2.2' matches 2.2.x), `target`, `id`, `v`, `avoid`.
- One field per card. Answers: output → `{ output: string }` (field kind `text`, compared after
  trimming trailing whitespace per line and trailing newlines); value → `{ value: number }` (`number`,
  `ask.var` names the variable); flags → `{ flags: { CF, ZF, SF, OF } }` (`flags` field with
  `flags: ['CF','ZF','SF','OF']`; `cells.flags` is a Status[] in that order); branch → `{ branch: string }`
  (`choice`, `ask.choices` are the messages).
- `item.show = { src, lines, section, title, focusLine }`; `item.sim` = the engine run (`prog`, `res`, `vals`).
- Flags diagnoses carry `focus.flag`. Card checkpoints use input kinds `number`, `bit` and `choice`.
- `paste.js`: `analysis.events` is the list of variable writes in execution order
  `{ k, n (trace index), line, v, name, type, val, nth, times, surprise: { tag } | null, key }`;
  paste checkpoints carry `line` and `event` (= k); `diagnosis.focus = { line, event? }` where `event`
  indexes `analysis.events`. When the trace hits its limit, writes are rebuilt from `res.steps` and
  `finalVars` with `n: null, key: null` (traps found from `aluLog`); `final: true` marks a variable's
  end value (prompt "What value does x end up with?"). A checkpoint `answer` is a BigInt beyond ±2^53.
  Writes also carry `header`, `pass`, `entry`, `entries`, `finishes` and `printed`: a for-loop
  header's init or step is asked about only when that variable is printed or nothing else is left,
  as "What is i at the start of pass N of the loop on line L?" or "…when the loop on line L finishes?". paste.js also exports the layer kit the cards use (`asmLayer`, `regsLayer`,
  `flagsLayer`, `columnsLayer`, `adderLayer`, `shiftLayer`, `flagReasons`, `normOutput` …).
- `ctags.js` holds only `c_*` ids; `flags_*` stay in `tags.js`.

## Engine contract (`src/engine/minic.js`)

```js
export const LIMITS = { lines: 30, cols: 72, vars: 32, steps: 200000, output: 4000 }
export class CError extends Error { line; col; kind }     // kind: 'syntax'|'type'|'limit'|'runtime'
export function compile(src, { limits? = true }) → Program
export function run(prog, { maxSteps?, trace? = false, traceLimit? = 4000 }) → Result
```

```js
Program = { src, lines, vars: [{ id, name, type, d, size, line }], insts: [Inst], base }
Inst = { i, op, text, bytes: number[], addr, size, line, ctl?: 'init', alu?: { op, signed, width, swapped? } }
Result = {
  output, ret, exit, count,
  steps: [{ line, writes: [{ v, name, type, val }], out }],
  events: [{ n, i, line, text, before: Regs, after: Regs, flagsBefore, flagsAfter, a?, b?, r?, width? }],  // only with trace
  aluLog, finalVars,
}
```

Engine details (engine owner):

- `compile(src, { limits: false })` skips the 30-line / 72-column check (the Lab
  corpus has a long line); the variable limit always applies. Also exported:
  `TYPES` (name → `{ name, size, bits, signed, rank, min, max }`, BigInt
  min/max), `promote(t)`, `commonType(a, b)`, `wrapTo(v, t)`, `formatPrintf`,
  `encode`, `text`.
- `vars[].type` is one of `'char' 'signed char' 'unsigned char' 'short'
  'unsigned short' 'int' 'unsigned int' 'long' 'unsigned long'`.
- C values (`writes[].val`, `finalVars`, `aluLog` recs' `a b r`) are Numbers, or
  BigInts when a 64-bit value is beyond ±2^53. Event registers and `a b r` are
  always unsigned BigInt bit patterns. Events may also carry `write: { d, width,
  val, v }` (a stack store; `v` = var id) and, for div/idiv, `q` and `rem`; `b`
  is absent for `not`. `res.eventsTruncated` is true when `traceLimit` was hit.
- `Inst.alu = { op, signed, width, node, swapped? }`: `op` is the C operator (`'+'`,
  `'<'`, `'>>'`, `'++'`, `'neg'`, `'~'`, `'!'` …) in the type it was computed in.
  `swapped: true` marks gcc -O0's operand order for an unsigned `>` or `<=` with a
  non-constant right side (`cmp b, a`, then `setb`/`setae`, `jae`/`jb`): that cmp
  event's `a` and `b` are then the C operands b and a. `ctl: 'init'` marks a
  for-loop header's init instructions. Signed division by a literal −1 compiles to
  `neg` (so `INT_MIN / -1` wraps and `x % -1` is 0, as with gcc -O0); a −1 held in a
  variable still uses `idiv` and raises SIGFPE.
- CError kinds: `'syntax'` (unreadable or unsupported C), `'type'` (undeclared or
  redeclared names), `'limit'` (lines, columns, variables, printf values,
  output, 200 000 steps), `'runtime'` (divide error / SIGFPE, or a variable read
  before it has a value — gcc would show leftover memory there, not 0).

Types: `int, unsigned (unsigned int), char, signed char, unsigned char, short,
unsigned short, long, unsigned long` with C integer promotions and usual
arithmetic conversions, casts, `U`/`L`/`UL` suffixes, and gcc x86-64 behaviour
for implementation-defined cases (char is signed; narrowing keeps the low bits;
`>>` on signed is arithmetic). Semantics are verified against gcc; every
instruction's bytes against GNU as.

## Binary helpers (`src/engine/bits.js`)

```js
toBits(value, w) → (0|1)[]  (LSB-first, two's complement for negatives)
fromBits(bits, { signed }) → number
addBits(a, b, w, cin = 0) → { result: bits, carries: (0|1)[w+1] (carries[0] = cin), cout, value, CF, OF, SF, ZF }
subBits(a, b, w) → same shape, computed as a + ~b + 1 (CF = borrow = NOT carry out)
shiftBits(x, w, dir, k, kind) → { bits, lost: indices, fill }
toSigned(v, w), toUnsigned(v, w), range(w, signed) → { min, max }
```

## State, codes and study (`src/lib/codec.js`, `src/learn/scheduler.js`, `src/learn/study.js`, `src/learn/starter.js`, `src/learn/board.js`)

- **Base32** Crockford alphabet (`0-9A-Z` without I L O U), case-insensitive
  decode, `-` separators ignored.
- **Set code** (`#/set/<code>`): `{ v: 1, level, topics: bitmask(add shift twos sadd fa c), n: 5–15, seed, mode: 'normal'|'study'|'delayed', link?: setId }`
  → ≤ 14 chars. `setId = hash(code) & 0x3FF`.
- **Result token** (student pastes back): 12 chars as `XXXX-XXXX-XXXX`, 60 bits:
  version 2 · setId 10 · mode 2 (normal/study/delayed) · g1 right 4 · g1 total 4 ·
  g2 right 4 · g2 total 4 · arm 2 (0, 1, 2 = unknown, 3 = not a study set) ·
  top-3 tag indices 3×5 · CRC-13 over the 47 data bits → 60 bits.
  `g1/g2` = family A / family B in study and delayed sets; drill / holdout in
  normal sets. "Right" always means right **on the first attempt**; the set score
  is (g1 right + g2 right) / (g1 total + g2 total). The CRC must catch any
  single-character typo and any adjacent swap (bursts ≤ 13 bits).
- **Review queue URL** (`#/review/<q>`): the learner's due items encoded
  compactly (type id, encoded params, tag index, due day, stage, group).
- **Scheduler**: a miss → due in 2 days (stage 0); correct review → 7 days,
  then 21 days, then done; wrong review → back to 2 days. Pure functions over a
  plain state object; `store.js` persists it. Fading: after 2 correct in a row
  on a tag, Why is collapsed by default; after 2 misses on the same tag within a
  session, a worked example is shown before the next variant. **Holdout:** 15%
  of practice items (deterministic from session seed + index) get answer-only
  feedback; the scheduler records first-attempt review accuracy (≥ 7 days later)
  per group so drill vs holdout can be compared.
- **Study (crossover)**: families A = `add`, B = `shift`. Arm 0: full
  diagnosis+Why on A, answer-only on B; arm 1: the reverse. Arm is random per
  student (not self-chosen), stored locally per study set and carried in the
  token. A `delayed` set (≥ 7 days later, linked to the study set) gives
  answer-only transfer items from both families and records first-attempt
  accuracy per family. If the arm is not stored locally, the learner may paste
  last week's result code to recover it; otherwise the token marks arm unknown.
- **Starter plan**: `buildStarter(classState, today, rng) → [{ source: 'missed'|'spaced'|'new', spec, tag? }]`
  of 5 entries: 2 from the class's recent "most missed/split" taps, 2 from spec
  points taught 1–6 weeks ago, 1 new (most recently taught). Pure; the UI turns
  entries into items with `itemForSpec` / `itemForTag`.
- **Board**: `analyzeTokens(text, { setCode? }) → { rows, invalid, tagCounts, completion, meanScore, study }`
  where `study` (when study tokens exist) has per-arm per-family accuracy and the
  paired within-student difference (drill family − answer-only family) with a
  95% CI and n.

State API details (state owner). Days are **day numbers** (`dayNumber(date)`,
the local calendar day counted from 1970-01-01). Store keys (all under the `pm.` prefix):
`sched` (scheduler state); `classes` (array of class states); `sets` (the teacher's
made sets); `setprog.<code>` (a learner's progress in a set, keyed by the **full** set
code, not the 10-bit setId); `arm.<code>` (a study set's arm, or the arm a delayed set
recovered; the older `arm.<setId>` is read only as a fallback); `setindex` (the newest
100 set codes with progress, used for pruning and to find a delayed set's study
set); `cards.tried`; `paste.code` (the learner's own program), `paste.linked` (a
program opened from a share link, until it is edited or kept), `paste.code.prev`
(the program a kept link replaced). `forgetControl` removes every `pm.*` key.

```js
// src/lib/codec.js
encodeSet({ level, topics: ['add',…], n, seed, mode, link? }) → 'XXXXXXXXXXXXXX'   // 14 chars; seed kept to 30 bits
decodeSet(code) → { v, level, topics, n, seed, mode, link: setId|null, setId, code }  // throws Error(friendly message)
encodeToken({ setId, mode, g1: { right, total }, g2, arm?, tags: [tagId|index…] }) → 'XXXX-XXXX-XXXX'
decodeToken(str) → { v, setId, mode, g1, g2, arm, tags: [tagId…], right, total, score, code } | { error }
encodeQueue(entries) → string (Crockford chars only, CRC-checked)   // entries as in the scheduler, only
decodeQueue(q) → entries                // { type, params, tag, due, stage, group } are read; throws Error(friendly)
  // per-entry flags: stage·2 (drill), stage·2 + 1 (holdout), 6 + stage ('set'), so a set question
  // stays a set question on another device and never becomes drill/holdout evidence
MODES = ['normal','study','delayed'], ARM_UNKNOWN = 2, ARM_NONE = 3
// src/learn/scheduler.js — every function returns a NEW state (never mutates)
emptyState(); dayNumber(date?); dayToDate(day); toDay(day|Date) (RangeError otherwise); itemKey(type, params)
recordAttempt(state, { type: TYPE_ID|TYPE, params: int[] (encodeParams), correct, tag?: diagnosis tagId,
  target?: tagId the item aimed at, group?: 'drill'|'holdout'|'set', today, review?: bool }) → state
  // group 'set': a homework/study set question — spaced exactly like drill, but never counted in the
  // drill/holdout evidence (sets choose their own feedback). The set view passes 'set' for every slot.
  // session misses (fading().showWorked) count only the diagnosis `tag`: an empty or unclassified
  // answer on an item aimed at `target` is not a miss of `target`.
dueEntries(state, today) → Entry[]; activeEntries(state) → Entry[] (for encodeQueue); queueSummary(state, today) → { due, later, next: day|null }
Entry = { key, type: TYPE_ID, params: int[], tag: tagIndex, group: 'drill'|'holdout'|'set', stage: 0|1|2, due, miss, done: day|null, measured }
  // stored entries that no longer build, or have a negative due day, are dropped on load
mergeQueue(state, entries, today) → { state, added, skipped }   // skips entries whose params do not decode to the same ints, have w outside 4–16, or do not build; due capped at today + interval
  // never removes an entry already on the device: once the queue holds MAX_QUEUE (60) entries, new ones
  // are left out. added = entries actually kept; skipped = new entries left out because the queue is full
fading(state, tagId) → { collapseWhy, showWorked }; noteWorked(state, tagId) → state (after showing it)
resetSession(state, seed) → state; isHoldout(seed, index) → bool; reviewAccuracy(state) → { drill: {right,total}, holdout: {right,total} }   // 'set' entries never counted
// src/learn/study.js
FAMILY_TOPIC = { A: 'add', B: 'shift' }; studySpecs(level) → { A: specId, B: specId }
assignArm(seed) → 0|1; feedbackFor(arm, family, mode = 'study') → 'full'|'answerOnly'
recoverArm(tokenString, studySetId) → { arm: 0|1 } | { arm: null, error }   // studySetId (the set's link) required
// src/learn/sets.js
planSet(decodedSet, { arm }) → [{ i, spec, family: 'A'|'B'|null, group: 'drill'|'holdout', feedback, seed }]
  // item: itemForSpec(slot.spec, mulberry32(slot.seed), { level }); study sets need arm 0|1
summarizeSet(results /* per slot: { correct, tag } | null */, plan, { setId, mode, arm }) → encodeToken input
// src/learn/starter.js
newClass({ id, name, level }) → { v, id, name, level, taught: { specId: day }, taps: [{ day, spec, tag, result }] }
setTaught(cls, specId, day|null) → cls; recordTap(cls, { spec, tag?, result: 'got'|'split'|'missed', date: Date|day }) → cls
buildStarter(cls, today, rng) → 5 × { source, spec, tag?, note }   // note: one short line for the teacher
  // missed slots are filled first; the newest taught point is 'new' only while the class has no open
  // miss on it (otherwise it is a 'missed' entry and 'new' is the next-newest point without one)
// src/learn/board.js
rows: [{ line, code, setId, mode, g1, g2, arm, tags, right, total, score, dupOf: line|null }]
invalid: [{ line, text, error }]; tagCounts: [{ tag, index, label, count, of, unclassified? }]  (count = codes listing the tag)
  // 'other' (only in older codes: summarizeSet never lists it) sorts last with unclassified: true
completion: { codes, unique, duplicates, sets: [{ setId, count }], expected: n|null, finished: count|null }
study: null | { study: Block|null, delayed: Block|null }
Block = { n, unknownArm, arms: [{ arm, n, A: {right,total,acc}, B: {…} }] (arm 0, 1),
          diff: { n, mean, sd, se, df, lo, hi, dz, reading: 'invest'|'replicate'|'stop'|null,
                  noInterval: null|'tooFew'|'noSpread'|'oneArm' } | null }
  // diff = AB/BA crossover estimate (study.js crossoverStats): mean = average of the two arms'
  // mean (drill − answer-only) differences, so an easier family cannot bias it; sd = pooled
  // within-arm SD, df = n − 2. lo/hi/dz are null when noInterval is set (one arm empty,
  // df < 1, or every difference equal).
  // reading uses dz = mean / sd: ≥ 0.3 invest, < 0.1 stop, otherwise replicate; null when n < 10
  // also: set (decoded setCode) | null, setError | null. Duplicates are flagged (dupOf) but still
  // counted: two learners with the same results get the same code.
toCsv(result) → string (RFC 4180, CRLF; cells starting = + - @ are prefixed with ')
```

## UI contract

Routes (`src/main.js`), each a module in `src/ui/views/` exporting
`render(el, ctx)` and optionally `dispose()`:

```
#/                 home.js
#/practice/:topic  practice.js     (?level=gcse|alevel|csapp)
#/check            check.js        check my working
#/review           review.js       (#/review/:q loads a queue from the URL)
#/teacher          teacher.js      spec points taught, create sets
#/starter          starter.js      projector starter (?class=id)
#/set/:code        set.js          a homework or study set
#/board            board.js        paste result codes → misconception board
#/cards            cards.js        CS:APP card list
#/card/:id         card.js         one card (?v=variant)
#/paste            paste.js        paste your own C
```

`ctx = { params, query, nav(path), app }`. Every view renders exactly one
`<main class="page …" data-view="<route name>">` containing one `<h1>` (the
router focuses it after navigation; tests wait for `main[data-view]`). Views set
`aria-current="page"` on the matching `.topnav` link when relevant. Projector
views add `body.projector` (the router removes it on navigation). The query string before the hash
(`?t=teacher`) is preserved in every generated link (it lets a host count
per-teacher use from its access logs without us collecting anything).

Shared UI components (UI core owner). See also `UI-BRIEF.md` for every screen:

```js
// src/ui/runner.js — runs one item through the whole loop
mountItem(el, item, {
  mode: 'practice'|'starter'|'check'|'set',
  feedback: 'full'|'answerOnly',
  level, collapsedWhy: false, showWorked: false,
  progress: 'Question 3 of 10' | null,
  onDone(result),             // at Check (first attempt): { correct, confidence, tag, answer, marking, ms }
  onFinal(result),            // when the learner moves on: { ...onDone result, depth, checkpoints, diagnosis }
  onNext(kind),               // 'variant' | 'next'
  beforePrompt(el, item),     // optional hook (cards: the C snippet)
  afterReveal(el, { item, marking }),   // optional hook (cards: C standard / gcc labels)
}) → { destroy() }
// src/ui/why.js
renderWhy(el, layers, { level, startOpen: 0, onDepth(n) }) → { destroy() }
// src/ui/bitgrid.js
bitRow(opts) / addGrid(item, opts) — keyboard: 0/1 type, arrows move, Backspace clears;
                                     addition entry starts at bit 0 and moves left
// src/ui/parts.js
confidence(onChange), chip(text), button(label, opts), statusGlyph(status), keyHint(...)
```

### Built UI modules you can reuse (foundations owns these files — import, don't edit)

```js
// src/ui/runner.js
mountItem(el, item, opts)            // see above; opts.showSpec (default true), opts.variants (false hides "Try one like it"), opts.nextLabel
                                     // "Try one like it" only appears when the diagnosis tag is in the item module's TARGETS
                                     // on a miss the first Why layer opens by itself unless opts.collapsedWhy (fading)
                                     // card items get the snippet / C-standard / gcc hooks from ui/cardhooks.js automatically
checkpointInput(cp, onChange) → { el, focus(), disable() }   // renders a Checkpoint's input
parseWhole(text) → number | BigInt | null;  sameValue(a, b) → bool (BigInt-safe, arrays)
workedExample(tagInfo, item) → element;  moduleFor(item) → item-type module
// src/ui/session.js
runSession(holder, { total, seed, level, next(i, state) → { item, review?, group?, target? } | null, again(), endTitle?, againLabel?, showSpec?, variantsExtend? }) → { dispose() }
// variantsExtend: a variant is asked in addition to (not instead of) the planned items — reviews use it
// a miss is written to the scheduler at once on pagehide / tab hidden, so a reload never loses it
loadSched(), saveSched(state), reviewLink(state) → url | '', formatDay(day) → 'Tue 29 Sep'
// src/ui/why.js
renderWhy(el, layers, { level, startOpen, onDepth, firstLabel }) → { destroy, openNext, depth };  renderLayer(layer) → element
hexOf(v, width), signedOf(v, width)
// src/ui/bitgrid.js
bitRow(w, { values, label, dir, optionalIndex, onChange, cellLabel }) → { el, cells, focusStart(), lock(statuses, key) }
bitInput({ label, value, optional, onSet, onMove, small }); addGrid(item, answer, opts); enableGridNav(container)
// src/ui/parts.js
button, chip, seg, confidence, CONFIDENCE, statusGlyph, callout, copyBox, bitsText, keyHint, tile
// src/ui/nav.js
setNav('#/teacher')                  // marks the current top-nav link
// src/ui/forget.js
forgetControl({ onDone }) → element  // "Forget everything on this device" (removes every pm.* key)
// src/lib/dom.js
href(path), shareUrl(path)           // keep ONLY ?t=<teacher code> from the query; anything else is dropped
```

Files owned by foundations: `css/core.css`, `css/why.css`, `css/item.css`,
`src/main.js`, `src/lib/{dom,store,rng}.js`, `src/learn/{tagids,spec,catalogue}.js`,
`src/ui/{parts,why,bitgrid,runner,session,nav,forget}.js`,
`src/ui/views/{home,practice,check,review}.js`.

## CSS kit (`css/core.css`)

Use these before inventing new classes: `.btn` (`.primary`, `.ghost`,
`.small`), `.chip`, `.panel`, `.stack` (vertical gap), `.row` (horizontal gap),
`.muted`, `.kbd`, `.ok` / `.bad` (with glyphs), `.visually-hidden`, `.page`,
`.page-narrow`, `.lede`, `.grid-auto`. Colour tokens: `--ink`, `--ink-2`,
`--muted`, `--paper`, `--paper-2`, `--line`, `--accent`, `--ok` (blue),
`--bad` (orange), `--focus`, `--hl` (column highlight). Light by default,
dark via `prefers-color-scheme`, projector via `body.projector`.
