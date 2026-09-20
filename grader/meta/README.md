# `meta/` — the grader's own tests. NOT gates.

Every file in here tests the GRADER: `lib/acceptance.ts`, the negative-control
fixtures in `fixtures/`, and the golden reference. None of them imports the
candidate's code, and none of them can fail because of anything the model under
test wrote.

## Why they were moved out of `backend/` (2026-08-30)

They used to live in `backend/`, which meant `backendTestFiles()` globbed them,
`vitest list backend` enumerated them, and the roster counted them as gates. The
suite total was 71; **18 of those 71 passed against a target directory that did
not exist**:

    BENCH_TARGET=/tmp/does-not-exist npx vitest run \
      backend/acceptance.test.ts backend/behavior-fixtures.test.ts \
      backend/negative-controls.test.ts
    → 18 passed (18)

So the gate wall's floor was 18/71 (~25%), not 0, and a scorecard reading
"67/71" was really "49 of the 53 gates that grade anything". `tiers.json`
labelled all 18 `core`, so nothing on the board hinted at it. The denominator
was not wrong by accident — it was answering "how many tests are there" when
the question is "how many gates grade the candidate".

## The rule

A file under `grader/` grades the candidate **iff** it reaches the target — via
`loadEngine()`, `startServer()`, or an HTTP/Playwright call against :8002.
Everything else belongs here. This is a path convention, not a list, for the
same reason `tiers.json` gives: a list drifts silently the moment a file is
renamed.

These tests still matter and still run — they are what stops a grading
predicate from rotting into one that accepts anything. They just are not
measurements of the model.

## Running them

    npm run test:meta

They are excluded from `vitest.config.ts` (which the graded backend phase uses)
and from the roster, so `report.mjs` never sees them.

## The gate census — 125, never counted from `checks.json` (2026-09-19)

The graded-check denominator is **125 gates** — conformance **67** · backend
**37** · frontend **21** — as enumerated by `grader/roster.mjs`
`enumerateGates()`.

Never count the gate inventory from `grader/checks.json` `checks` keys, nor from
unique bracket tokens in the gate suite. Both undercount: **66 of the 125 exist
only as `{x}`-template expansions in `setup` plus multi-test backend tokens**, so
`checks.json` keys (which enumerate the `REQ-*` wrapper tokens) and bracket-token
counting each miss the template-expanded and per-test gates. The true denominator
is the roster's own enumeration — call `enumerateGates()`, never
`Object.keys(checks.json)`.

This is the same error class as the 2026-08-30 move described above: the
denominator was answering "how many tests exist" instead of "how many gates grade
the candidate". `checks.json` is the mirror/wiring surface for complaint text,
not a gate census.
