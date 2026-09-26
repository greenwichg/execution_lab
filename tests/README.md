# Tests

Browser tests for `index.html` in headless Chromium (Playwright). three.js is served from `node_modules`, so the tests need no network.

```sh
cd tests
npm install            # playwright + three (browsers: use an existing Playwright Chromium install)
npm test               # all *.test.cjs files, one after another
npm run test:journey   # the whole narrated film in real time, with a timing + mix report
RENDER=1 node journey.cjs   # …also rendering, one screenshot per narration line
RECORD=1 node journey.cjs   # …also recording the final mix to artifacts/journey-mix.webm
```

| File | Covers |
|---|---|
| `01-silent.test.cjs` | silent autoplay (`?autoplay`) never creates an AudioContext; the original 84.6 s cut, captions and deep links (`?t`, `?paused`, `?manual`) still work |
| `02-narration-data.test.cjs` | every line has a decoded clip with matching text; the schedule is ordered, never overlaps, and respects its anchors; the film cut is monotone, never faster than 1×, and invertible; stage targets never land mid-sentence; subtitle, card and panel state |
| `03-audio-transport.test.cjs` | audio graph started by the Begin click; picture/sound sync per frame; pause/resume mid-word; M mute and persistence; C subtitles; scrub (silent while dragging, sentence-boundary release); stage jump with travel sound; speed ≠ 1×; hidden-tab auto-pause and drift-free resume; carry-pulse timing; restart; no console errors |
| `04-fallback.test.cjs` | undecodable voice, no Web Audio, blocked output, "Watch silently" → later "Turn on sound", a missing clip |
| `05-responsive.test.cjs` | gate, subtitles and speaker menu at 1920×1080, 1366×768, a 768×1024 tablet and a 390×844 phone; no overlaps, no horizontal scroll |
| `06-minic.test.cjs` | the editor's Mini-C compiler against the real toolchain: every program in `programs.cjs` gives the same output and exit code as `gcc -O0 -fwrapv`, every instruction's bytes match the GNU assembler; friendly compile and runtime errors (skipped without gcc/as) |
| `07-editor.test.cjs` | the code editor: E / button / Escape, typing never triggers film shortcuts, errors with line + column, examples, the "operation to follow" picker; Run & Explain rebuilds the film for the program (RUN segment, EXECUTION panel, generated narration, personalised HUD) and back to the demo; speech narration holds the film at a sentence end until the voice finishes; `?code=…&run`; GPU memory stays flat over repeated rebuilds |
| `08-story.test.cjs` | the story builder (Node only, no browser): for every program and every operation it can follow, the story has no gaps, its bytes are the instruction's bytes, the ALU board, the adder inputs and the gate-level simulation agree bit for bit, and every narration anchor is a real beat |

### Predict the Machine (`machine/`)

| File | Covers |
|---|---|
| `10-engine.test.mjs` | the typed Mini-C engine: 85 programs (all C integer types, promotions, conversions, casts, unsigned jumps, shifts, division, printf length modifiers) match `gcc -O0 -fwrapv`; every instruction's bytes match GNU as; errors; trace events |
| `10b-engine-fuzz.test.mjs` | a seeded differential fuzzer: random typed programs vs gcc and GNU as; every traced ALU event re-checked against x86 rules |
| `11-items.test.mjs` | binary items (add, shift, two's complement, signed add/sub + flags, full adder): keys from `bits.js` (checked against the real x86 ALU for every 8-bit case); a simulated buggy student per misconception is diagnosed with its own tag; checkpoints ≤ 3; variants; Why layers |
| `11b-items-adversarial.test.mjs` | exhaustive arithmetic, diagnosis honesty (false positives/negatives, mixed and partial answers), learner-facing language, generator realism, damaged links |
| `12-state.test.mjs` / `12b-state-adversarial.test.mjs` | set codes, result codes (every single-character typo and adjacent swap detected), review links, the 2/7/21-day scheduler, 15% holdout, study arms, set planning, starter planning, board analytics (AB/BA crossover estimate with simulated coverage) |
| `13-cards.test.mjs` | the 12 CS:APP cards × 100 variants vs gcc; every gcc claim vs gcc's real assembly; flags vs the real CPU; classic wrong answers → tags; paste-mode bisection |
| `14-machine-core.test.cjs` | the learner loop in the browser: grid typed in working order, confidence required, diagnosis, GCSE vs A-level Why depth, checkpoints, practice → review queue → review link on a fresh device, the ladder, XSS via routes, no foreign requests, strict CSP, size budget (≤ 560 KB per screen, ≤ 650 KB in all), phone layout |
| `14b-machine-review-fixes.test.cjs` | regressions from the final review: signed sums labelled in two's complement, a miss survives a reload, reviews ask every due item after a variant, big review links need consent and never evict your own reviews, skip link and page titles, one tab stop per grid, links keep only `?t=`, "Forget everything", decimal shift values, paper-method checkpoint carries |
| `15-machine-teacher.test.cjs` (+ `15b`) | teacher view, projector starter (keyboard, reveal, taps), homework/study/delayed sets and result codes, the board (junk, duplicates, worked-example overlay, CSV) |
| `16-machine-cards.test.cjs` (+ `16b`) | every CS:APP card end to end, labels, Why depth, variants, paste mode (checkpoints, errors, share links, XSS), phone layout |
| `17-e0.test.mjs` | the E0 desk-study generator and scorer (`tools/e0/`) |

`06` and `08` load the compiler and story builder straight out of `index.html` (between the `// @@MINIC-BEGIN/END` and `// @@STORY-BEGIN/END` markers), so they run in plain Node in about a second: `node --test 06-minic.test.cjs 08-story.test.cjs`.

Screenshots and reports land in `tests/artifacts/` (git-ignored). Tests that check timing use `?norender`, which runs the clocks, HUD and audio without WebGL drawing, so software-rendered CI machines still run in real time.
