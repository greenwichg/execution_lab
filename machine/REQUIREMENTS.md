# Requirements and where they are met

Each requirement from the product direction is listed with the code that
meets it and the tests that check it. Test files are in `tests/` (the
number is the file prefix; test names are quoted in part).

## The learning loop

| # | Requirement | Where | Checked by |
|---|---|---|---|
| R1 | The learner predicts (all their working) and says how sure they are | `ui/runner.js`: every asked field must be filled before Check, and confidence is required | 14 "check my working"; 14 "practice" (a blank grid is refused) |
| R2 | The answer comes from a simulation, never a hand-typed key | `engine/bits.js`, `engine/minic.js` | 11 "agrees with the x86-64 ALU for every 8-bit add, sub and shift"; 10 gcc and GNU as corpora; 10b fuzzer; 13 "flags … match the real CPU" |
| R3 | Feedback names the *first* break in working order | each item's `diagnose` | 11b "mixed misconceptions are tagged by the first error in working order"; 14 "diagnosis names the first break" |
| R4 | A result-only answer is located with ≤ 3 checkpoint questions; "Not sure" is not evidence | `diagnose` checkpoint flows; runner `askCheckpoint` | 11 "checkpoint flows: ≤ 3 questions"; 11b "Not sure never produces a named misconception"; 14 "result-only answers"; 13 "paste: bisection … ≤ 3 checkpoints"; 14b "binary #4" (paper-method carries accepted) |
| R5 | Why ↓ opens one layer per click, ≤ 2 sentences: line → asm → registers/flags → columns → full adder; GCSE stops at the column rule | `ui/why.js`, each item's `why` | 11 "why layers follow the contract order"; 11b "GCSE never sees gates"; 14 "GCSE Why stops at the column rule" and "A-level Why goes down to the full adder" |
| R6 | "Try one like it" aims a new question at the same misconception | each item's `variant`; `ui/session.js` | 11 "variant(item, tag) gives new numbers that the same buggy student gets wrong"; 14b "bugs #4/#5/#8" |
| R7 | Misses come back after 2, 7 and 21 days, with a bookmarkable review link | `learn/scheduler.js`, `lib/codec.js`, `ui/views/review.js` | 12 "a miss comes back after 2, then 7, then 21 days"; 12b DST and boundary tests; 14 "review link restores them elsewhere"; 14b "security #1" (a big link never crowds out your own reviews) |
| R8 | A worked example with subgoal labels after 2 misses of one misconception | `scheduler.fading`, `ui/session.js` | 12 "worked example after 2 misses in a session"; 12b "an empty or unclassified answer … is not a second miss" |
| R9 | Fading: the Why rail starts collapsed after 2 right in a row | `scheduler.fading`, runner `collapsedWhy` | 12 "Why collapses after 2 correct in a row" |
| R10 | 15% of practice questions are a holdout (answer only) to measure whether the explaining helps | `scheduler.isHoldout`, `views/practice.js`, the review page's evidence panel | 12 "holdout: 15% ± 2%"; 12b "set questions … never count as drill/holdout evidence" |

## Teachers

| # | Requirement | Where | Checked by |
|---|---|---|---|
| T1 | A projector starter with a carry-ripple reveal; class taps; keyboard only | `views/starter.js`, `ui/reveal.js` | 15 "starter on a projector"; 15b "reveal: every carry … matches the engine" and "starter on projectors: big high-contrast digits, keyboard only" |
| T2 | The starter plan: 2 missed + 2 spaced (taught 1–6 weeks ago) + 1 new | `learn/starter.js` | 12 "starter: 2 missed/split, 2 taught 1–6 weeks ago, 1 most recently taught"; 12b "missed slots come first" |
| T3 | Spec points (OCR, AQA, CS:APP) with taught dates | `learn/spec.js`, `views/teacher.js` | 15 "teacher: class, taught date" |
| T4 | Homework and study sets as links; students return a result code with a checksum | `learn/sets.js`, `lib/codec.js`, `views/set.js` | 12 "EVERY single-character substitution and EVERY adjacent swap … is detected"; 15 "a normal set"; 15b "sets on a Chromebook" |
| T5 | The class board: misconception map, worked examples, CSV | `learn/board.js`, `views/board.js` | 12 "board: pasted text in any shape" and "CSV is RFC 4180"; 15 "board"; 15b "board worked example overlay: keyboard trap both ways" |
| T6 | A crossover study (arms, delayed set, arm recovery) | `learn/study.js` | 12 "the 95% CI covers the true effect"; 12b "the crossover CI stays unbiased"; 15 "study set assigns and stores the arm; delayed set recovers it" |

## C on x86-64 (CS:APP)

| # | Requirement | Where | Checked by |
|---|---|---|---|
| U1 | 12 cards, each labelled with the C standard's verdict and what gcc -O0 on x86-64 does | `learn/cards.js`, `views/cards.js` | 13 "every card and variant: the engine … agree with gcc"; 13 "every instruction a card's gcc text names is in gcc -O0's real assembly"; 16b "nothing leaks before Check" |
| U2 | A typed engine (all C integer types, promotions, conversions) | `engine/minic.js` | 10 "types: promotions, usual arithmetic conversions"; 10b differential fuzzer |
| U3 | Paste your own C; a wrong prediction is bisected to the first diverging write | `learn/paste.js`, `views/paste.js` | 13 "paste: bisection finds a planted divergence in ≤ 3 checkpoints"; 16 "paste: wrong prediction → checkpoints → diagnosis → Why" |
| U4 | Card Why layers show the 32-bit columns that matter (bits 31–24) | `ui/why.js` (`base`), `learn/cards.js` | 13 "Why layers: well-formed, shallow → deep, real bytes, honest columns" |

## The film

The cinematic Lab (`/index.html`) is kept out of the learning path. The home
page links to it once and says it loads third-party assets. Two renders come
from `tools/render-film/`: the narrated film (`render.cjs`) and a short
"200 + 65 = 9" projector clip (`reveal-clip.cjs`). The MP4s are build outputs
and are not committed.

## Constraints

| Constraint | Where | Checked by |
|---|---|---|
| No network: CSP `connect-src 'none'`; no CDN, fonts or analytics | `index.html` | 14 "home: loads with no network beyond this origin, a strict CSP" |
| No three.js or audio in the product; small enough for a £200 Chromebook: ≤ 560 KB JS+CSS per screen, ≤ 650 KB for the whole app | `index.html`, `CONTRACTS.md` | 14 "home: … a small payload" (fresh-loads 10 routes) |
| No `innerHTML`: text is only ever inserted as text nodes | `lib/dom.js` (`h()` throws on `html`) | 14 "route text is never parsed as HTML"; 16 and 16b paste safety and bidi |
| Accessible: labelled controls, keyboard only, one tab stop per grid, forced colours, skip link | `ui/bitgrid.js`, `ui/parts.js`, `css/` | 14b "a11y #1/#11" and "a11y #6"; 15b "every control is labelled"; 16b "cards by keyboard only" |
| Phones and projectors | `css/` | 14 "phones: no horizontal page scroll"; 15 and 16 phone tests; 15b projector sizes |
| No accounts, no streaks; data stays on the device, and learners can wipe it | `lib/store.js`, `ui/forget.js` | 14b "security #5: Forget everything … removes every pm.* key" |
| Links carry only `?t=` | `lib/dom.js` `keptQuery` | 14b "security #3" |

## Validation

| Step | Where | Checked by |
|---|---|---|
| E0: can the diagnosis match what students write? A 200-item set, a scoring rule and κ | `tools/e0/` | 17 (generation, scoring rules, Wilson intervals, κ, the pre-registered rule) |
| E1–E4 with a decision date (Fri 18 Dec 2026) | `docs/validation-plan.md` | not code |

## Known limits

- **Paste mode's C** is a subset: integers only, `main` only, up to 30 lines.
- **Assembly** is gcc -O0 *style*; the values always match gcc, but the
  instruction choice can differ.
- **Paste bisection** chooses which write to ask about by heuristics. It is
  tested on planted divergences, not on real students' programs.
- **The film page** still loads fonts and three.js from CDNs. It sits outside
  the product's CSP.
- **Nothing here proves learning.** That is what E0–E4 are for.
