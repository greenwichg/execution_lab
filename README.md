# Execution Lab

Two things live here.

## Predict the Machine — `machine/`

The product: a practice-and-diagnosis tool for fixed-width integer arithmetic,
from GCSE binary addition to C on x86-64 (CS:APP chapters 2–3).

The loop:

1. **Predict:** fill in your working.
2. **Verify:** it is checked against a real simulation.
3. **Find the break:** see the exact column or line where your thinking broke.
4. **Why? ↓:** go one layer deeper at a time, down to the gates.
5. **Practise:** try one like it.
6. **Return:** what you missed comes back in 2, 7 and 21 days.

For teachers there is a projector starter, homework sets and a class board.
No accounts, and nothing leaves the device.

See [`machine/README.md`](machine/README.md). To run it, serve the repository
root (`python3 -m http.server 8000`) and open `/machine/`.

## Code Execution Lab — `index.html`

The original single-file 3D film. It follows `y = x + 3` (or your own small
program) from source code through the compiler, machine code, memory, CPU,
ALU, logic gates and transistors, down to silicon, with narration. It is kept
as a showcase. Predict the Machine is where the learning happens: the research
behind it is clear that watching alone teaches little.

`tools/render-film/` renders the narrated film to an MP4 for landing pages
and outreach.

## Also here

- **`tests/`:** Node and Playwright tests for both. See
  [`tests/README.md`](tests/README.md).
- **`docs/validation-plan.md`:** the pre-registered experiments and decision
  date for Predict the Machine.
- **`tools/e0/`:** the E0 desk study: do free LLMs already find where a
  student's working broke?
- **`tools/voice/`:** how the Lab's narration voice was generated.
