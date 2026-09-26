# Predict the Machine — UI brief

Read with `CONTRACTS.md`. This describes every screen, how it behaves, and the
tone. The product should feel like a calm, precise exam-prep instrument: paper
white, ink, one indigo accent; blue ✓ and orange ✗; monospace digits; no
decoration that doesn't explain something (research: irrelevant polish lowers
learning). Motion only for the carry ripple and panel reveals, ≤ 600 ms, and
none under reduced motion.

## Voice

- Second person, short, specific, kind: "Not quite — your working first goes
  wrong in column 3." Never "Wrong!", never exclamation marks on errors.
- Exam wording: *carry*, *overflow error*, *most significant bit*, *two's
  complement*, *logical shift*, *arithmetic shift*.
- Every number the learner sees is computed. Say where it came from once:
  "Checked against a real simulation" (binary) / "Same output as gcc -O0 on
  x86-64" (C).
- Privacy line wherever someone might worry: "Nothing you type leaves this
  device."

## Shared behaviour

- One `<main class="page …" data-view="…">` per view with one `<h1>`.
- Buttons ≥ 44 px tall. All controls work by keyboard; focus is always visible.
- After *Check*, announce the outcome with `announce()`.
- Correct/incorrect: glyph + colour + words, never colour alone.
- Phone (390 px): no horizontal page scroll; wide bit grids (> 10 bits) scroll
  inside their own container.
- Everything saved goes through `src/lib/store.js` (keys `pm.*`); never assume
  storage persists — offer the review link.

## The item runner (`src/ui/runner.js`)

Layout, top to bottom:

1. Spec chip (e.g. `OCR GCSE (J277) 1.2.4 · Binary addition`) and progress
   ("Question 3 of 10") on one row.
2. The prompt (`h2`).
3. The answer area for the item's `fields`:
   - **add / sadd**: the addition grid (`bitgrid.addGrid`) — a carry row of
     small cells above the operands, operand rows (read-only digits, with the
     denary value faintly at the right *after* reveal), a rule line, the result
     row, and one dashed extra cell on the left of the result labelled
     "extra bit?" (`result[w]`). Typing `0`/`1` fills a cell and moves **left**
     (you add right to left). Arrow keys move, Backspace clears and moves right,
     Tab leaves the grid. Column headers show bit numbers (7 … 0) in small type.
   - **bits** fields: a single row of cells (same keyboard rules; shifts fill
     left-to-right is fine for non-addition rows — state the direction in a
     hint).
   - **choice** (yes/no, which message prints): a segmented control.
   - **flags**: four labelled 0/1 toggles `CF ZF SF OF` (only the asked ones).
   - **number / text**: plain inputs; text uses monospace (program output).
4. **How sure are you?** — segmented: *Guessing · Fairly sure · Certain*.
   Required before Check (the Check button explains why it's disabled).
5. **Check answer** (primary). Enter submits when focus is not in a text area.

After Check the whole answer **locks**. Each asked cell shows ✓ or ✗; wrong
cells show the correct value in small type underneath; a lost carry-out is
drawn struck through. Then:

- **Full feedback**
  - Correct: a blue callout, "Correct." plus one sentence of the key fact
    (from the first Why layer's first sentence).
  - Wrong, and `diagnose()` asks a checkpoint: an orange callout "Let's find
    where it went wrong." with the checkpoint question and its input, then the
    next one (≤ 3), then the diagnosis.
  - Diagnosis: orange callout — bold headline + detail.
  - **Why? ↓** button (collapsed when `collapsedWhy`), then the Why rail.
  - Worked example (when `showWorked`): shown *before* moving on, as a numbered
    list of bold subgoals with one line each.
  - Buttons: wrong → **Try one like it** (primary, variant of the same tag) and
    *Next question*; right → **Next question**.
- **Answer-only feedback** (holdout, study, delayed): cells marked and the
  correct answer shown, one neutral line "Here is the correct answer." and
  **Next question**. No diagnosis, no Why, no variant.

`onDone` fires once, at Check, with the first-attempt result; `onFinal` fires
when the learner moves on, adding checkpoint answers, the diagnosis and the
Why depth they reached.

## Why rail (`src/ui/why.js`)

A vertical rail: each opened layer is a card joined to the previous one by a
thin line, with a small caps title (*Bit columns*, *Column 3*, *Full adder*,
*Instruction*, *Registers*, *Flags*), the visual, and the `say` sentences.
Under the newest card: **Deeper ↓** (or "That's the deepest layer for this
level."). Opening a layer scrolls it into view gently and moves focus to its
title.

Visuals per kind (HTML unless it's a circuit):

- `columns`: a monospace grid like the exam layout; the focus column in a soft
  yellow band; carries small above; the dropped carry-out struck through with
  "lost (worth 256)"; denary labels at the right. Subtraction shows `+ NOT b`
  and the initial carry 1.
- `column`: one column as an equation in boxes: `1 + 1 + 1 = 3 = 11₂ → write 1,
  carry 1`.
- `adder` (SVG): a full adder — XOR(A,B)=x1, XOR(x1,Cin)=Sum, AND(A,B)=a1,
  AND(x1,Cin)=a2, OR(a1,a2)=Cout — with standard gate shapes, each wire labelled
  with its live value and drawn thick+accent for 1, thin+muted for 0 (the label
  carries the meaning, not the colour). viewBox ≈ 560×260, scales down on phones.
- `shift`: before and after rows with arrows; bits that fall off go into a
  struck-through "lost" tray; fill bits outlined.
- `twos`: labelled rows (+5 → invert → add 1 = −5).
- `flags`: four tiles CF ZF SF OF with the value and its one-line reason.
- `regs`: a table register | before | after (hex and signed decimal), changed
  rows marked ▶.
- `asm`: a table address | bytes | instruction, the key instruction marked ▶.
- `line`: the C source with line numbers and the focus line highlighted.

## Screens

**Home `#/`** — h1 "Predict the Machine". Lede: "Predict what the computer
will do. Check it against a real simulation. Find exactly where your thinking
broke — then go one layer deeper." Three level panels (GCSE, A-level, C on
x86-64) listing their topics as links. A row: *Review due (N)*, *Check my
working*, *For teachers*. Footer: privacy line + "The original film: Code
Execution Lab" (`../index.html`).

**Practice `#/practice/:topic?level=`** — a 10-question session. Starts with
up to 2 due reviews for this topic, then new items; after a miss, "Try one like
it" gives a variant for the same tag. ~15% holdout items get answer-only
feedback (don't label them). Fading and worked examples from the scheduler.
End screen: first-attempt score; a small calibration table (Guessing / Fairly
sure / Certain × right / wrong) with one sentence ("You were certain 4 times
and right 3 times."); misconceptions met with their one-line `fix`; the review
link (copy button) and when the next reviews are due; *Another 10* / *Home*.

**Check my working `#/check`** — the learner types their own question and
working: addition (two binary numbers up to 16 bits, their carries, result,
overflow), a shift, or a two's complement conversion. Same marking, diagnosis
and Why as practice.

**Review `#/review` and `#/review/:q`** — imports a queue from the URL
("Added 6 questions from your link."), shows how many are due today and later,
runs the due items, and always shows the bookmarkable review link with a copy
button: "Bookmark this. It brings your reviews back even if this device
forgets."

**Teacher `#/teacher`** — "For teachers". Local classes (add / rename /
delete). Spec points with *Taught on* dates. Today's starter preview (5 lines
with where each comes from) and **Project starter**. **Set homework**: level,
topics, 5–15 questions, mode (Normal · Study: practice · Study: delayed, which
links to an earlier study set) → a link with a copy button and the
instructions for students. A list of sets created on this device. A link to the
board. A short, honest note on the study design and the holdout.

**Starter `#/starter?class=`** — projector mode (`body.projector`). One
question at a time, huge: operands as big bit rows, "Answer on your
whiteboards." **Reveal** (Space) runs the ripple: carries appear right to left
(~120 ms per column), then result bits, then the lost carry struck through and
"Overflow error: the answer needs 9 bits." Then three big buttons **Most got
it (1) · Split (2) · Most missed (3)** that record a tap, **Why ↓** (W) for the
rail at projector size, **Next** (→). Esc leaves. End screen names what comes
back next time.

**Set `#/set/:code`** — a bad code gets a clear, kind error. Intro: number of
questions, about how long, "When you finish you'll get a result code to paste
into your assignment. Your answers stay on this device." Study sets assign the
arm silently; delayed sets offer an optional "paste last week's result code"
box when no arm is stored. Progress survives a reload. End: the result code
huge in monospace with **Copy**, plus how to hand it in.

**Board `#/board`** — "Class board". A textarea for pasted result codes (a
whole spreadsheet column is fine) and **Analyse**. Results: tiles (codes,
valid, mean first-attempt score), misconceptions sorted by how many students
("Dropped a carry — 9 of 28") each with **Project a worked example** (opens the
worked example in projector mode), the rows table, invalid lines with reasons,
the study panel when study codes are present (per-arm per-family accuracy, the
paired difference with its 95% CI and n, and the pre-registered reading: ≥ 0.3
invest, < 0.1 stop, between → replicate), and **Download CSV**. All
local — say so.

**Cards `#/cards`** — CS:APP cards grouped by section; each tile shows the
title, section, and the C-standard status chip (*defined* ·
*implementation-defined* · *undefined*).

**Card `#/card/:id?v=`** — the C snippet (safe syntax colouring, line
numbers), the question, the input for its `ask.kind`, confidence, **Check**.
Reveal: what the machine did ("Same output as gcc -O0 on x86-64"), then two
labelled lines — **C standard:** status + text, **gcc -O0 on x86-64:** text —
then diagnosis and the Why rail (line → instruction → registers → flags →
columns → adder). **Another like it** (new variant) and **Next card**.

**Paste `#/paste`** — "Paste your own C". A code area with line numbers, a
few examples, "What will it print?", confidence, **Run and check**. Compile
errors show the line and column. A wrong prediction runs the bisection
checkpoints ("What is `total` after line 4 the 3rd time?"), then the diagnosis
and the Why rail for the statement where the model broke. The code is kept on
this device; a share link carries the code in the URL fragment.
