# Quarantine — tests excluded from grading

## The rule

**If a test is ever determined to be flaky, it is excluded from the grading
suite. Period.**

Canonical, set 2026-09-11. Not "investigated", not "retried", not "marked as
known-flaky and averaged out". Removed from the graded set until it is made
deterministic.

## Why the rule is that absolute

A gate that flips on byte-identical code does not just add noise to itself. It
moves `resolved_count`, and `resolved_count` is the convergence signal `06`
reads as DIFFICULTY — the thing the benchmark exists to measure. So one flaky
gate manufactures and erases repair curves, and nothing downstream can separate
its movement from a real one. A number that is sometimes wrong, in a direction
nobody can predict, is worse than a number that is absent: absence is visible
and gets accounted for, noise gets averaged into a conclusion.

The benchmark's whole claim is that the same model, on the same corpus, produces
a comparable measurement. A gate that disagrees with itself breaks that claim
directly.

## What quarantining does and does not mean

- It does **not** say the requirement is unimportant.
- It says **this test cannot measure it reliably**, so it must not be allowed
  to vote.
- The requirement it covered is now **unmeasured**, and each file below states
  that in its own header. An honest gap beats a dishonest measurement.

## What is in here

| gate | requirement | evidence | what is now unmeasured |
|---|---|---|---|
| `G15-req-complete.test.ts` | `REQ-COMPLETE` — a full game reaches a winner with no server exceptions | `02`: passed once in seven runs. 2026-09-11 in the grading container at one worker: failed once, then passed five times on the same candidate with the same command | "plays all the way to a winner with zero exceptions" is asserted nowhere; G13/G14 and the frontend win gates still cover turn flow, AI legality and the win screen |

## How something leaves quarantine

Not by being moved back. By being made deterministic, and then shown to be.

For G15 specifically the flaw is in the assertion: its bound is
`iterations <= 500` against an AI that is free to play badly, so it conflates
"finishes" with "finishes efficiently" and a correct-but-weak engine fails it by
chance. Re-admitting it means bounding the game by the engine's own legal-move
exhaustion, or driving it with scripted dice that provably terminate — and then
demonstrating it green across repeated runs on identical code.

## Running these

They are excluded from grading by construction: `vitest.config.ts` includes only
`backend/**`, `report.mjs` walks only `backend/`, and `roster.mjs` enumerates
neither. They are kept runnable so the work to fix one starts from something
that executes:

```
npx vitest run --config vitest.quarantine.config.ts
```
