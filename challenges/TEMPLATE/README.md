# <your challenge>

Copy this directory, make it a git repo, fill it in, and point the benchmark at
it with `BENCH_TASK_DIR=/path/to/this/directory`.

The worked example is `task/backgammon/` in the benchmark repo. Read it beside
this; everything below exists there in finished form.

## What you provide

| File / folder | What it is |
|---|---|
| `challenge.json` | What your challenge declares about itself: its name, the sentence describing it, the language and stack, the port the app answers on, where the grading suite is, its phases, the test commands to count, and which build step fills in which stub file. The benchmark reads this instead of assuming the example's values. |
| `prompts/` | Every word the model reads. See below. |
| `scaffold/` | The folder the model starts in — the stubs, the start command, nothing else. Copied into the cell at the start of every run. |
| `golden/` | Your own working solution. It is never given to the model; it proves the challenge is buildable and keeps the grading suite honest. |
| `grader/` | A test suite that can list its own checks, run them against a candidate, and report each as pass or fail. |

## prompts/

| File | Reaches the model as |
|---|---|
| `agents.md` | Standing notes, in front of the model for the whole session. Keep it short — it is resent on every turn. |
| `chunk-01.md` … | The build steps, in filename order. One task per step. |
| `repair/opener.md` | Opens every repair message: how you checked, stated as a plain fact. |
| `repair/first-round.md` | Heading for the first list of problems. |
| `repair/repeat-round.md` | Heading when problems are still there after a fix attempt. |
| `repair/no-change.md` | Put first when the model's last round changed no code at all. |
| `repair/fixed-one.md` / `fixed-many.md` | Opens the list of problems that are now gone. |
| `repair/team-header.md` / `team-note.md` | Optional second voice, for checks a different kind of user would hit. |
| `nudges/write-limit.md` | The write-size limit, written once and reused. |
| `nudges/cut-off.md`, `loop.md`, `stall.md`, `connection.md` | What the user says when the benchmark has to interrupt: a reply that got cut off, going in circles, a command that ran too long, a dropped connection. Use `{write_limit}` to include the limit above. |

### Rules for anything the model reads

These come from runs where one added line changed how the model behaved.

1. **Say what to do, not why things fail.** An explanation such as "a running server keeps the old code" gets reused as an excuse about the user.
2. **Never name an excuse to prevent it.** Writing "not a stale page, not the cache, not a hard refresh" puts those words in the model's mouth.
3. **Read each new line next to the repair messages.** If the model could use it to explain why the user still sees a problem, rewrite it.
4. **Change one model-facing thing per run**, so a change in behavior points to one cause.

Two rules for everything in `prompts/`:

1. **Never say it is a test.** No mention of benchmarks, graders, gates or
   scoring. A model that knows it is being measured is not the model you meant
   to measure.
2. **Give what a test needs, not what a developer should know.** Exact names,
   shapes and addresses your grading suite depends on: yes. The rules of the
   domain, the design, the algorithm: no — that is the thing being measured.

## grader/

Two scripts, by name, are the contract:

- `roster.mjs --out <file>` — list every check you would run, without running
  any of them.
- `report.mjs --target <dir> --out <file>` — run them against a built candidate
  and report each check as pass or fail. The grading image runs this one.

The benchmark needs three things from your suite:

- **A roster.** It can list every check it would run, before running any.
- **Per-check results.** Each check reports pass or fail against the candidate.
- **One complaint sentence per check, in two flavours** — first time seen, and
  seen again — written the way a user would say it, never the way a test would.
  This is what the repair rounds are made of, and it is where a weak challenge
  shows.

The example's suite lives in the benchmark repo (`grader/`) and its sentences in
`grader/feedback.json`.

## Freeze your starting files

Once `scaffold/` settles, record its fingerprint so two runs of your challenge
are comparable:

```
BENCH_TASK_DIR=$(pwd) python3 <benchmark>/scripts/freeze_challenge.py --write
```

That writes `scaffold_hash` into `challenge.json`. A run refuses to start
without it, and refuses again if the starting files change afterwards — change
them deliberately, then re-freeze.

## Still to come

The example's grading suite lives in the benchmark repo (`grader/`) rather than
in its own folder, and its `grader_dir` points there. A challenge of your own
keeps its suite inside itself, which is what the `grader_dir` default in this
template does.
