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

`06` and `08` load the compiler and story builder straight out of `index.html` (between the `// @@MINIC-BEGIN/END` and `// @@STORY-BEGIN/END` markers), so they run in plain Node in about a second: `node --test 06-minic.test.cjs 08-story.test.cjs`.

Screenshots and reports land in `tests/artifacts/` (git-ignored). Tests that check timing use `?norender`, which runs the clocks, HUD and audio without WebGL drawing, so software-rendered CI machines still run in real time.
