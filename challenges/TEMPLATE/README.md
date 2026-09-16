# <your challenge>

Copy this directory, make it a git repo, fill it in, and point the benchmark at
it with `BENCH_TASK_DIR=/path/to/this/directory`.

The worked example is `task/backgammon/` in the benchmark repo. Read it beside
this; everything below exists there in finished form.

## What you provide

| Folder | What it is |
|---|---|
| `prompts/` | Every word the model reads. See below. |
| `scaffold/` | The folder the model starts in — the stubs, the start command, nothing else. Copied into the cell at the start of every run. |
| `golden/` | Your own working solution. It is never given to the model; it proves the challenge is buildable and keeps the grading suite honest. |
| `grader/` | A test suite that can list its own checks, run them against a candidate, and report each as pass or fail. |

## prompts/

| File | Reaches the model as |
|---|---|
| `agents.md` | Standing notes, in front of the model for the whole session. Keep it short — it is resent on every turn. |
| `chunk-01.md` … | The build steps, in filename order. One task per step. |
| `repair/opener.md` | Opens every repair message: how you checked, so the model cannot blame a stale page. |
| `repair/first-round.md` | Heading for the first list of problems. |
| `repair/repeat-round.md` | Heading when problems are still there after a fix attempt. |
| `repair/fixed-one.md` / `fixed-many.md` | Opens the list of problems that are now gone. |
| `repair/team-header.md` / `team-note.md` | Optional second voice, for checks a different kind of user would hit. |
| `nudges/write-limit.md` | The write-size limit, written once and reused. |
| `nudges/cut-off.md`, `loop.md`, `stall.md`, `connection.md` | What the user says when the benchmark has to interrupt: a reply that got cut off, going in circles, a command that ran too long, a dropped connection. Use `{write_limit}` to include the limit above. |

Two rules for everything in `prompts/`:

1. **Never say it is a test.** No mention of benchmarks, graders, gates or
   scoring. A model that knows it is being measured is not the model you meant
   to measure.
2. **Give what a test needs, not what a developer should know.** Exact names,
   shapes and addresses your grading suite depends on: yes. The rules of the
   domain, the design, the algorithm: no — that is the thing being measured.

## grader/

The benchmark needs three things from your suite:

- **A roster.** It can list every check it would run, before running any.
- **Per-check results.** Each check reports pass or fail against the candidate.
- **One complaint sentence per check, in two flavours** — first time seen, and
  seen again — written the way a user would say it, never the way a test would.
  This is what the repair rounds are made of, and it is where a weak challenge
  shows.

The example's suite lives in the benchmark repo (`grader/`) and its sentences in
`grader/feedback.json`.

## Not yet

The benchmark still resolves some of this by convention rather than from a
manifest in this folder, and its adapter is still named after the example
challenge. Both are being worked on; when they land, this README gains the
manifest and loses the caveat.
