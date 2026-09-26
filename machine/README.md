# Predict the Machine

A practice-and-diagnosis tool for **fixed-width integer arithmetic**, from GCSE
binary addition to what C really does on x86-64. It's built for use inside
courses: a teacher projects a starter or sets homework, and students practise
and come back for reviews.

Every question runs the same loop:

1. **Predict.** The learner fills in their working (every carry, the result,
   the flags) and says how sure they are.
2. **Verify.** A simulation of the hardware computes the answer. No answer
   key is typed by hand.
3. **Find the break.** We name the *first* column, bit or line where the
   learner's model and the machine part ways. If they gave only a result, up
   to 3 checkpoint questions locate it.
4. **Why? ↓** goes one layer deeper per click, with at most two sentences
   each: line of C → instruction and bytes → registers → flags → bit columns →
   the full adder's gates with live values.
5. **Practise.** "Try one like it" generates a fresh question aimed at the
   same misconception. After two misses on it, a worked example with subgoal
   labels comes first.
6. **Return.** Misses come back after 2, 7 and 21 days, or in the class's
   next starter.

## Who it's for

| | Topics | Where the layers earn their keep |
|---|---|---|
| **GCSE** (OCR J277 1.2.4, AQA 8525) | 8-bit addition, overflow, shifts | the exact column where a carry was dropped; the 9th bit that has nowhere to go |
| **A-level** (OCR H446 1.4.1/1.4.3, AQA 7517) | two's complement, signed overflow, logical vs arithmetic shifts, full adders | "OF = the carry into the sign bit ≠ the carry out", shown on the gates |
| **CS:APP** chapters 2–3 | 12 cards: conversions, promotion, truncation, overflow, shifts, division, condition codes, `jl` vs `jb`; paste your own C | each card states what the **C standard** says (defined / implementation-defined / undefined) *and* what **gcc -O0 on x86-64** does |

## Screens

- **Practise:** 10-question sessions per topic, with spaced reviews first.
- **Check my working:** type in a homework or past-paper question and your
  own working.
- **Review:** the spaced queue, with a bookmarkable review link.
- **C on x86-64:** the CS:APP cards and "paste your own C".
- **Teachers:**
  - **projector starter:** 5 questions built from what the class missed and
    what was taught 1–6 weeks ago, with a carry-ripple reveal and class taps;
  - **homework and study sets:** shared as a link; students paste a result
    code back into the teacher's own Classroom or Teams assignment;
  - **class board:** decodes those codes into a misconception map and a CSV.

## Privacy and security

- **No network:** a CSP with `connect-src 'none'`, and no CDN, fonts,
  analytics or accounts.
- **Local storage only:** everything a learner or teacher types stays in
  their browser (`localStorage`, keys `pm.*`).
- **Pupil data:** teachers get evidence of completion through result codes
  that students paste into the teacher's *own* assignment. We never hold pupil
  data.
- **Untrusted input:** pasted code, URL fragments and result codes are never
  parsed as HTML. The DOM is built with text nodes only (`src/lib/dom.js`).
- **Per-teacher counts:** the only per-teacher signal is the optional `?t=`
  code in the query string, which a static host sees in its access logs.
- **School filters:** new domains are often "uncategorised" in UK school web
  filters. Submit the host for categorisation (Smoothwall, Lightspeed,
  Netsweeper, Securly) before a pilot.

## Running it

It's static ES modules, so serve the repository over HTTP (modules don't load
from `file://`):

```sh
python3 -m http.server 8000      # from the repository root
# open http://localhost:8000/machine/
```

Any static host works. The whole app is about 0.6 MB (about 0.2 MB gzipped) with no dependencies, and
it runs on a £200 Chromebook with no GPU.

## How it's built

- `CONTRACTS.md`: module contracts (items, diagnosis, Why layers, engine,
  codes, scheduler, study).
- `UI-BRIEF.md`: every screen, its behaviour and tone.
- `REQUIREMENTS.md`: each requirement, the code that meets it and the tests
  that check it.
- `src/engine/`:
  - `minic.js`: C → x86-64 compiler, assembler and emulator with all C
    integer types.
  - `bits.js`: n-bit arithmetic with every carry and flag.
- `src/learn/`:
  - item types (`items/`), the 12 CS:APP cards, paste mode;
  - the misconception catalogue (31 tags);
  - codes, scheduler, study design, starter planner, board analytics.
- `src/ui/`: the item runner, bit grid, Why rail, sessions, and one module per
  screen.

## What's verified, and how

The test runner is `tests/`:

- **Engine semantics:** 85 programs, plus a differential fuzzer over random
  typed programs, match `gcc -O0 -fwrapv` in output and exit code.
- **Instruction bytes:** every instruction's bytes match the GNU assembler.
- **CS:APP cards:** every card and 100 variants of each agree with gcc. Every
  instruction a card's gcc text names was checked against gcc's real
  assembly. Flags after `cmp` were checked on the real CPU.
- **Binary arithmetic:** `bits.js` matches the x86-64 ALU for every 8-bit
  case.
- **Diagnosis:** a simulated "buggy student" for each binary misconception is
  diagnosed with its own tag. Mixed and partial answers are tagged by the
  first error in working order. "Not sure" is never taken as evidence.
- **Codes:**
  - result codes detect every single-character typo and adjacent swap;
  - review links survive round trips;
  - the study analysis uses the AB/BA crossover estimator, with coverage
    checked in simulation.
- **Browser tests** cover the loop, checkpoints, reviews, XSS via routes and
  pasted code, the no-network rule, the size budget and phone layouts.

## Honest limits

- **Paste mode's C** is a subset: integer types only; no pointers, arrays,
  floats, structs or functions other than `main`; up to 30 lines of 72
  characters.
- **The assembly** is this lab's compiler in gcc -O0 style, not gcc's own.
  Values match gcc; the instruction choice can differ (gcc turns division by
  a constant into shifts).
- **Undefined behaviour:** the emulator shows what the hardware does (for
  example, `INT_MAX + 1` wraps). The cards label such cases undefined
  behaviour rather than teaching them as C.
- **Nothing here proves that anyone learns more.** That is what
  `docs/validation-plan.md` is for: pre-registered experiments with a
  decision date.
