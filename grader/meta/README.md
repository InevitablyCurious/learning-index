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

## The gate census — never counted from `checks.json`

The graded-check denominator is whatever `grader/roster.mjs` `enumerateGates()`
returns: **184 gates** on 2026-09-29 — conformance **68** · backend **49** ·
frontend **67** (it was 125 on 2026-09-19). Read the number from a fresh roster,
never from this line.

Never count the gate inventory from `grader/checks.json` `checks` keys, nor from
unique bracket tokens in the gate suite. Both undercount: **many gates exist only
as `{x}`-template expansions in `setup` plus multi-test backend tokens**, so
`checks.json` keys (which enumerate the `REQ-*` wrapper tokens) and bracket-token
counting each miss the template-expanded and per-test gates. The true denominator
is the roster's own enumeration — call `enumerateGates()`, never
`Object.keys(checks.json)`.

This is the same error class as the 2026-08-30 move described above: the
denominator was answering "how many tests exist" instead of "how many gates grade
the candidate". `checks.json` is the mirror/wiring surface for complaint text,
not a gate census.

## Roster freshness — regenerate before a mutation re-grade (2026-09-24)

A gate-roster file's **mtime is not its capture time**: date it by the internal
`captured_at` field, never by `ls`. During the WO-INTEGRITY-FIX re-acceptance the
brief's literal `gate-roster.json` was stale at 134 gates while the live grader
enumerated 145 — a stale roster silently folds the new gates into
`unmatched_results` and degrades `gate_totals.total` without erroring. (Earned by
the re-acceptance orchestrator; report `WO-INTEGRITY-FIX.md` HARD-WON "measure-first".)

**Rule:** before any mutation re-grade, REGENERATE the roster against the current
grader source (`node grader/roster.mjs --out <path> --force`) and assert
`gate_roster.available == true` AND `gate_totals.total != null` on every graded
report. Rank competing roster artifacts by their JSON `captured_at` (and `total`),
never by file mtime.

## Reading a report.mjs `--out` JSON (2026-09-29)

Two traps in the machine-readable report, earned the hard way (WO-GOLDEN-V2-B3).

**`gate_results[].id` is a short token only when it is unique.** A gate_result's
`id` is the short bracket token (`"G01"`, `"F04"`) only when that token names
exactly one enumerable test. A token shared by several tests — `G03` appears in
both `gates-01-08` and `server-path-integrity`, `G10`/`G12` cover several — and
every `[CONF]` (all conformance gates share the `[CONF]` token) fall back to a
deterministic slug built from the full title (`roster.mjs` `assignIds`: `unique ?
g.gate_token : slugFor(phase, file, full_name)`), and the report carries that id
(`gate-results.mjs` `id: gate.id`). So `gate_results.find(x => x.id === 'G03')`
returns `undefined` even when G03 is the sole failing gate — its entry is keyed by
full title. To confirm a specific gate, match by short token when unique, else by
full-title substring (server-path-integrity G03/G10/G13 and all `[CONF]`).

**`--target` is CWD-relative and never fails fast on a missing dir.** `report.mjs`
resolves `--target` via `path.resolve(targetArg || …)` with no existence check
(`report.mjs:82-84`), so a relative `--target` run from `grader/` points at
`Learning-Index/<path>` — and if that dir does not exist it silently grades a
ghost and writes a full, well-formed FAIL report instead of erroring (earned: a
relative run produced `gate_totals {pass:0, fail:131, not_run:48}` against a
nonexistent target). Always pass an ABSOLUTE `--target`, or confirm the
`[report] … target=` log line resolves to a real dir before trusting any verdict.

## Frontend-check guidance — gate on the screen, never the server turn poll (2026-09-29)

Any frontend check measuring on-screen artifacts of the computer's turn must gate
on the on-screen records themselves (poll the page's own probe), never on a
server turn-state poll alone. (Earned by WO-GOLDEN-V2-B3 chunk 2; HARD-WON
"server/client turn desync".)

**The desync.** On a computer turn the golden server flips `game.turn = HUMAN`
inside `aiPlayDice` (`task/backgammon/golden/src/server.ts:416`) ~2 s BEFORE the
page finishes animating the computer's dice and moves — the server turn poll and
the on-screen records are out of phase by ~2 s.

**Why it matters.** A literal "poll `turn==='white'`, then read the on-screen
probe" would have read `moves=[]` and failed the golden's own must-pass
criterion. Trace: `runAi` (`task/backgammon/golden/public/app.js:487-507`) calls
`/api/ai` first, then `sleep(520)` + `renderDice` + `sleep(1000)` + a
`sleep(500)`-per-move loop, so the dice and moves land ~1.5-2 s after the
`/api/ai` response — while `actionAi` (`server.ts:356`) → `aiPlayDice` had
already set `game.turn = HUMAN` (`server.ts:416`) before that response returned.
F62 therefore records every frame the page draws — the visible dice, the
black pieces' centres against the board, and where those pieces are tagged
(`data-loc`) — and judges the pacing from those frames, waiting until the pieces
on screen have moved and held still; the state poll only says the turn happened.
Moves are timed from the tags, and from the drawing only when the tags show
fewer than two: slides with little rest between them read as one move in the
drawing (a legitimate 400 ms pace failed that way). And nothing is recorded until
the page has settled, with the dice at the click read at the click itself — a
baseline taken from the last recorded frame could predate the page drawing the
player's dice, which let a page that never showed the computer's roll pass. (Its first cut watched the reference's own
class names and one container, which a page drawn another way would fail.)

## Authoring a failure/complaint line — single-spaced (2026-09-29)

A `failures/*.md` complaint is one line, and it must be **single-spaced**. The mirror test compares a whitespace-normalized JSON (`harness/adapters/challenge/feedback.py` `load_feedback_overrides` — `" ".join(str(...).split())`) against the raw `.md` bytes (`load_feedback_overrides_from_failures` — `read_text().rstrip("\n")`), so an internal double space (or a tab/newline) in a `.md` line desyncs the two copies and fails `test_the_json_mirror_matches_the_md_runtime_source`. Write the complaint sentence with single spaces only.

## Mutation-proof grading — `;` between mutations, never `&&` (2026-09-29)

`report.mjs` exits 1 on any FAIL verdict (`report.mjs:541` sets the verdict, `:584` `process.exit(1)`), so `&&`-chaining several mutation grades kills the chain at the first intentionally-broken mutation and the later grades silently never run. Chain each per-mutation `roster && report` pair with `;` BETWEEN mutations — never `&&` — whenever any target is expected to FAIL.
