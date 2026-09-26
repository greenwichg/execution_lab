# E0: do free LLMs already find where a student's working broke?

This is the desk study **E0** from [`docs/validation-plan.md`](../../docs/validation-plan.md).
Predict the Machine claims to find the *first* place a learner's working broke
and to name the misconception behind it. If free chatbots already do that for
almost every student, "verified" is not a reason to use us, and we should compete
on workflow instead (assigning, marking cell by cell, the class misconception map).

## The rule (pre-registered on 26 September 2026)

> If free-tier models identify the first wrong column or step in **≥ 95%** of
> attempts, we drop "verified" from the schools pitch and compete on workflow.
> We keep it for the university route only if the gap holds on the x86 items.

How `score.mjs` applies it:

- The rate is `column_ok` over all 200 attempts, **per model**, on the point
  estimate. Exactly 95% counts as reaching it. The Wilson 95% interval is shown
  next to it, but it does not change the verdict.
- The rule fires if **any one** free-tier model reaches 95%: a student only
  needs one of them.
- "The x86 items" are the 30 C cards and the CS:APP flags questions. If the
  schools rule fires, "verified" stays for the university route only if every
  model stays below 95% on those items.
- Do not decide on partial data. The report says so when a model has fewer
  than 200 replies.

## Run it

Node 18 or later. No dependencies, no network, no API keys.

```sh
node tools/e0/generate.mjs                  # seed 20260926, writes tools/e0/out/
node tools/e0/generate.mjs --seed 7 --out /tmp/e0
node tools/e0/score.mjs tools/e0/out/e0-scoring.csv
node tools/e0/score.mjs tools/e0/out/e0-scoring.csv --rater tools/e0/out/e0-rater-sample.csv
```

`generate.mjs` writes three files. The same seed always gives the same bytes, so
generate once, before collecting anything, and keep the files with the results.

| File | What it holds |
|---|---|
| `e0-items.jsonl` | One attempt per line: question, the learner's answer and checkpoint replies, and the key (correct answer, first wrong column or step in words, tag, tag label, our own diagnosis) |
| `e0-prompts.txt` | The 200 student messages, each between `======== E0-001 · copy from the next line ========` and `======== E0-001 · end ========` |
| `e0-scoring.csv` | `id, model, response, answer_ok, column_ok, misconception_ok, rater`: one row per attempt per model (`--models` changes the list), to fill in |

## What is in the set

| Family | Items | Tags |
|---|---|---|
| 8-bit addition with working (carries row, answer, overflow yes/no) | 70 | every `add_*`, 10 each |
| 8-bit addition, result only | 20 | `add_or`, `add_no_carry`, `add_three_ones`, `add_overflow_missed`, `add_ninth_bit` |
| Shifts (logical and arithmetic, GCSE and A level) | 30 | every `shift_*`, 5 each |
| Two's complement (encode, decode, range) | 25 | every `twos_*` |
| Signed add/subtract with flags (A level "overflow?" and CS:APP CF ZF SF OF) | 25 | every `flags_*` |
| C on x86-64 (the CS:APP cards, with a classic wrong answer) | 30 | every `c_*` |

Each attempt is made the way the app would see it. The item comes from the item
module's own `generate(rng, { target })`. The learner holds exactly one
misconception, using the modules' `misconceive` / `misconceptions` helpers or a
card's classic wrong answer. Then the app's own `mark()` and `diagnose()` run, with
every checkpoint answered as that learner would. **An attempt is kept only if our
diagnosis returns the tag it was built for**, so the key is the app's verdict,
computed, never typed by hand.

The messages read like a 15 to 19 year old: the question, the working written out
plainly, then "where did I go wrong?". They never name the misconception or hint
at it (`tests/17-e0.test.mjs` checks for tag names, labels and hint words).

## Collecting replies (by hand)

1. Use the **free tier** of ChatGPT, Claude and Gemini in a browser, with the
   default model and default settings. Turn off custom instructions and memory,
   or use an account that has never used them: they are not defaults.
2. Start a **new chat for every message**, so earlier attempts cannot help.
3. Paste the text between the two marker lines only. Do not add anything.
4. Copy the **whole reply** into the `response` cell for that `id` and `model`.
   Note the date and the model name the site shows, in a separate log.
5. Never put an API key, a login or a cookie anywhere in this repository. This
   study is about what a student gets for free in a browser, so there is nothing
   here that calls a model.

## Scoring

`score.mjs` scores each reply against its key:

- **answer_ok**: the reply gives the right value of every part the student got
  wrong: the bit pattern (spacing, `0b`, `_` and subscripts are ignored), the
  number, overflow yes or no, the flag values, or what the C program prints. When
  only the working was wrong (a misplaced carry row), the reply must state the
  right answer.
- **column_ok**: the reply points at the first wrong column or step. For
  additions this must happen in a sentence that says something is wrong, so a
  reply that walks through every column is not credited for naming them all. It
  accepts "bit 3", "the 8s column", "2³ place", "the 4th column from the right",
  "the leftmost bit". "Bit N" is read as counting from 0 on the right; "column 3"
  or "the 3rd bit" on its own is ambiguous and is not counted. For shifts and
  two's complement the step can also be named in words (the gap, the bits that
  fall off, the +1). For C it is the line or its operation.
- **misconception_ok**: keyword and phrase rules per tag (for example
  `add_or`: "treated 1 + 1 as 1", "OR"; `c_truncating_division`: "truncates",
  "toward zero").

**Automatic scoring is a first pass.** Keyword rules miss unusual phrasings and
sometimes credit a reply that happens to use the right words. So:

1. `score.mjs` writes `e0-rater-sample.csv`: a random 20% of each model's replies
   (reproducible with `--seed`), without the automatic scores, with the key beside
   each reply. A second person fills in `answer_ok`, `column_ok`,
   `misconception_ok` (1 or 0) and their name in `rater`. They can hide the
   `model` column to rate blind. The file is never overwritten once it exists.
2. Run `score.mjs` again with `--rater` pointing at that file. The report gives
   Cohen's kappa between the rules and each rater (and between raters, if there
   are two), and `e0-disagreements.csv` lists every cell where they differ.
3. **Where the rules and a human disagree, the human decides.** Human scores
   replace the automatic ones in the rates. If two humans disagree, add a row
   with `rater` set to `final` to settle it.

Outputs: the report on screen and in `e0-report.txt`; `e0-scored.csv` with the
automatic and final scores for every reply.

## Privacy

No student data is involved. Every attempt is synthetic, generated from a seed.
The only things that leave this computer are the synthetic messages you paste
into the chatbots yourself. Do not paste anything else into them, and do not store
anything but the replies.

## Known limits

- For C, each snippet has one operation, so `column_ok` is close to "talks about
  the right line". The report shows `misconception_ok` on the x86 items next to it.
- Location words are matched in English only, and "bit N" assumes counting from 0.
- A reply that gives the answer only in denary does not get `answer_ok` for a
  question that asks for bits.
- The student messages are fixed text. Real students also make slips, skip the
  working, and type less tidily, so this is a best case for the chatbots.
