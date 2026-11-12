# Learning-Index

**A test bench for the systems around a model.** Hold the model and the task still, swap in one
layer — a harness, a memory system, an orchestration loop — and measure what it changes.

> **Status, 12 November 2026: proof of concept.** The bench runs a model with nothing swapped in,
> and its grader is being made trustworthy round by round. Nothing has yet been measured with a
> layer swapped in. Details: [where it stands](#where-it-stands).

## What it is designed to do

Most agent benchmarks rank models, or model-and-agent pairs. Learning-Index is built for the other
question: with the model held still, what is a given harness, memory system or orchestration loop
worth? It answers that the way a test bench does — every condition pinned but one, the same
measurement every time, and the result read against the same model's own baseline.

- **The model is pinned, and is its own control.** A series runs one model throughout. Its
  context window, speed and raw ability cancel out of its own result: deltas compare across
  models, scores never do.
- **The task is pinned.** One challenge — a complete backgammon game — built from the same written
  spec every run, from starting files frozen by hash.
- **The problem set is deterministic.** The grader runs what the agent built — its engine, its API,
  and a real browser playing it like a person — with the dice fixed for every check. A reference
  solution passes every check. No language model judges anything.
- **The model hears only human prose.** The spec says what a player expects. After each grade the
  agent hears the earliest problems a player would run into, in a player's words — never test
  names, expected values or code. Every line it is told must be true of the build it describes; a
  false line is the bench's fault, and is fixed before any result counts.
- **Every run is fingerprinted,** and compared only with runs whose fingerprint matches.
- **One layer varies.** Each run with a layer swapped in is measured against the average of the
  matching baseline runs — whether the app works, how far it got, and what it cost in tokens
  (cache included), turns and time. Everything else stays pinned.

What it is designed to answer, with the same model on the same task:

- **Harnesses.** Does a different agent harness get more of the app built, and what does it spend
  getting there?
- **Memory systems.** Does memory learned from the agent's own work make the next build better —
  and as it grows, where does it stop helping and start to hurt (its **index**)? When the job
  changes, does it adapt, or keep steering the agent the old way?
- **Orchestration loops.** Does a different loop around the model — how the work is split up, when
  the context is compacted, how problems are reported back — change what gets finished, and what
  it costs?

How a run is measured: [methodology](docs/methodology.md). What existing benchmarks measure, and
the closest project: [related work](docs/related-work.md). How it was built, and the choices behind
it: [notes from the operator](docs/operator-notes.md).

## Roadmap

1. **The instrument and its baseline.** Sealed agent cells, the deterministic grader, a control
   plane and a live board; a model building the challenge with nothing swapped in, every line it
   hears true. *Built; the baseline is being finished.*
2. **A replaceable harness.** opencode becomes one harness among several; the first replacement is
   Hermes Agent (Nous Research). Hermes keeps memory of its own, so the first thing to settle is a
   clean no-memory baseline for it. *Not started.*
3. **Memory systems.** Series of runs with a memory system learning from the agent's own work:
   does it help, and where does its index fall. The way in — opencode's plugin mechanism — and the
   first kit, [Honcho](https://github.com/plastic-labs/honcho), are built. *Not yet run.*
4. **Orchestration loops.** Swapping the loop around the model. Today the loop is the bench's own,
   and its settings (such as compaction between build steps) are part of each run's fingerprint;
   swapping in a different loop is *not built*.
5. **Memory under change.** The job changed on purpose — a preference, a way of working, a
   dependency — to see whether memory adapts. *Designed, not built.*
6. **More challenges.** The challenge format is open, with a template to start from; backgammon is
   the only challenge so far.

## Where it stands

As of 12 November 2026:

- **Works today:** one harness (opencode 1.18.20), one challenge, the grader (238 checks — the
  contract's shape, the engine and API, and a real browser — told in 19 stages, in the order a
  player meets them), local and cloud models, fingerprints, per-run cost records, and a
  development mode that pauses after every grade.
- **The baseline is not finished.** A local model (Qwen3.6-35B-A3B) builds the game in development
  mode. At every pause an operator plays the build and checks each line the model is about to
  hear; when a line is false, the grader is fixed and the run resumes from its last checkpoint.
  Its build now gets as far as stage 14 of 19 (the bar). Development runs are not measurements: a
  measured baseline runs start to finish, once the grader is frozen.
- **Nothing has been measured with a layer swapped in** — no memory system, no second harness, no
  other loop.

## How a run works

- **The unit is one run.** One click on Run launches one cell: a single opencode session that
  builds the challenge in seven phases, in order, then troubleshoots in that same session, round
  after round, until every check passes. The harness compacts the session itself between chunks,
  a launch choice stated before the run starts and part of its fingerprint, costing one model turn
  per chunk. There is no round cap and no time cap.
- **A chunk ends on the transport's verdict.** A chunk is complete when the session goes idle with
  exit 0, and nothing the model wrote is read to decide it. A non-zero exit ends the build there,
  and every later chunk is recorded not reached.
- **Two arms.** Baseline (OFF on the board): nothing swapped in; every baseline run is appended and
  averaged per fingerprint. Test (ON): the same model with the layer under test swapped in,
  measured against the average of the baselines that share its fingerprint.
- **Runs are serial per model.** One cell in flight per model; a different model may run beside it.
- **Dev mode pauses; normal mode does not.** In dev mode the run stops after every grade and once
  at the end, so the operator can play the app as it stands and read what the model is about to be
  told; each pause waits on a file sentinel, and releasing it continues the run. Normal mode runs
  straight through.
- **A cell that ran out of room is a result.** When the session grew too large to compact at all,
  the cell ends `context_exhausted` and is recorded as that — never restarted from a saved copy of
  an earlier run.
- **What is measured.** Every run writes a cost record — build, troubleshooting and total: tokens
  by kind including cache, turns, compactions, grades, wall time with paused time taken out, and
  peak context. A local model is measured in tokens only, because there is no price to state; a
  cloud cell also records what it cost. Beside it: whether the cell finished and what ended it,
  and, when a memory system is swapped in, what it delivered to the agent and its own background
  work.
- **No language model judges anything.** The grader runs the game: more than 200 checks, in the
  order a player meets them.

## The challenge: backgammon

Build a complete, playable backgammon game — a human against the computer — in Node and TypeScript
with no dependencies, in seven phases: the rules engine; the computer opponent; the server and its
API; the page in three layers — the board and its controls, then the pieces, then the gameplay;
and wiring it all together, until the whole game runs clean.

The grader runs more than 200 checks in three phases: the contract's shape, the engine and API, and
a real browser playing like a person. They fall into 19 stages, in the order a player meets
them — the first look at the board, starting a game, playing it out, and finishing it. After each round the agent hears about the earliest stage that fails,
as complaints a player would make, never as expected values. A reference solution, kept out of the
agent's reach, proves the challenge can be built.

Neither side has vision. The agent checks what it draws by driving a real browser and measuring
it; the grader judges what a player sees the same way.

## Keeping the grader honest

- **A false line is the benchmark's fault.** Every complaint told to the model must be true of the
  build it is told about. When one is not, the grader is fixed, the fix is proven against
  deliberately broken builds and a re-grade of every saved build, and the run is repeated.
- **Played by a person.** Every round's build is played side by side with the reference game. A
  player's correction becomes a requirement, a check, and a fresh baseline.
- **A stuck model is a result.** When every line told was true and the model still could not fix
  the problem, that is measured, not repaired.

The first milestone — three runs in a row in which every line told to the model was true — was
reached in September 2026.

## Plug something in

Today the one way in is opencode's own plugin mechanism; the bench adds no interface of its own.
Point `BENCH_PLUGIN_DIR` at the plugin package and rebuild the worker image, and each cell runs with
it OFF or ON. The first kit is the memory system [Honcho](https://github.com/plastic-labs/honcho),
which publishes an opencode plugin; it is in [memory-systems/honcho](memory-systems/honcho/), and
the guide takes it step by step: [docs/memory-systems.md](docs/memory-systems.md). Replacing the
harness itself is on the [roadmap](#roadmap).

## Add a challenge

A challenge is its own repository, selected with `BENCH_TASK_DIR`. It brings its build prompts, its
starting files, a reference solution and a grader. The grader's contract is two scripts —
`roster.mjs --out` lists every check without running any; `report.mjs --target --out` grades a
built candidate — plus one complaint per check, written the way a user would say it. The starting
files are frozen by hash, so a run refuses to start if they drift. Start from
[challenges/TEMPLATE](challenges/TEMPLATE/).

## Run it

One-time installs, two image builds, then a control plane and a board:

```bash
# 1. install the harness (once)
python -m venv .venv && . .venv/bin/activate && pip install -e '.[test]'

# 2. install the grader's test tools on the host (once); preflight refuses without them
(cd grader && npm ci)

# 3. build the worker and grader images (a run refuses without them)
#    set BENCH_PLUGIN_DIR=<abs path to plugin tree> first to install a plugin under test
.venv/bin/python scripts/rebuild_worker_image.py
.venv/bin/python scripts/rebuild_grader_image.py

# 4. preflight — prints GO with the exact launch command, or NO-GO naming the fix
.venv/bin/python scripts/bench_preflight.py --model <alias>

# 5. start the control plane (the only write-capable surface)
node control/server.mjs            # http://127.0.0.1:8718

# 6. start the read-only board (in another shell)
(cd dashboard && docker compose up -d)   # http://127.0.0.1:8717
```

Runs are started from the board: `[+ BASELINE]` for a baseline cell, `[+ run]` on a baseline row
for one with a layer swapped in. Full operations: [RUNBOOK.md](RUNBOOK.md).

## The board

A read-only live view at `http://127.0.0.1:8717`. It holds no data of its own: every panel reads
from the control plane on `:8718`, the only process that reads run files or changes anything. It
never overstates: it keeps "not measured", "not connected" and "measured, and zero" apart, computes
no difference between arms below three scored runs per arm, counts invalid runs as excluded rather
than as zero, and never treats memory delivered as an outcome.

Stopping a run keeps its tree and writes its cost record, and the cell is recorded stopped by hand.
The preview disappears only because its play container is removed and the cell's own build stops
with it: play containers are named from the run and the cell, so two never collide, and a finished
run's are cleaned up.

<details>
<summary>What each panel shows</summary>

| Panel | What it shows |
|---|---|
| **Runs strip** | One card per run, current and archived: status, problems before and after, peak context against the window, turns, loop and stall errors. Picks the cell the rest of the board shows. |
| **Gate wall** | Every check as a fixed square — passed, recovered, failed, not yet observed — with a card per check on hover. |
| **Baselines** | One row per model: every baseline on its fingerprint and the average the runs with a layer swapped in are measured against, with those runs nested beneath; a stats strip of scored, voided and unmeasured runs and error counts. |
| **Transfer curve** | Turns, tokens and wall time of the runs with a layer swapped in, against the baseline average, with stacked token bars; a line appears from two such runs. |
| **Learning** | A check-by-attempt matrix filling as the cell runs; the model's own account of its work beside the code-derived record of what it changed. |
| **Terminal mirror** | The running cell's terminal, live and read-only. |
| **Data feed** | The running cell's events — or a finished cell's frozen record — with filters, plus a backend feed beside it; a phase spine of one build and each grading round, with running token counters. |
| **Honesty rail** | Coverage, unresolved episodes, guard detections, recall overhead (p50/p95), turns burned, and memory serves labelled as delivery, not outcome. |
| **Recall** | Where a memory injection will be shown; today it shows its resting state. |
| **Hold / review** | When dev mode pauses a run, a link to play the built artifact and a release to continue. |
| **Challenges** | The challenges available to measure, ready or blocked with the reason. |
| **Startup feed** | The background processes behind a benchmark start, worst first, with reasons. |
| **Top bar and provenance strip** | Model, run state, stop, dev-mode mark, history link; policy, worker fingerprint, seed and source health. |
| **New baseline / new run** | The launch wizard: local or cloud, model, challenge, confirmation, preflight checklist. |
| **History page** (`/history`) | Every run with its checkpoints, the files each changed and side-by-side diffs; play any build; delete with confirmation. |
| **Settings drawer** | Refresh the worker, grader, control plane or board; custom tools; the machine share given to grading; dev mode; router credentials. |
| **Reset and restore** | Move all benchmark data into a backup and start clean, or bring a backup back — each with a preview and a confirmation. |

</details>

## Repository layout

```
harness/     Python measuring instrument — sequencer, manifest, adapters, scoring, cell isolation,
             egress, fingerprints, image identity.
task/        The backgammon challenge — starting files, reference solution (never shown), prompts.
challenges/  Where your own challenge repositories go, and TEMPLATE/ to start one.
grader/      The check suite (conformance / backend / frontend) — the only component that sees the
             reference.
control/     Node control plane — the only process that reads run files or changes anything.
dashboard/   The read-only board.
images/      Worker and grader Dockerfiles; the egress and loop-kill sidecar.
scripts/     Entrypoints: run_cumulative.py, image rebuilds, preflight.
config/      bench.env and the benchmark's environment settings (see ENV-VARS.md).
docs/        Methodology, related work, memory systems, the operator's notes, and the system map.
memory-systems/
             One kit per memory system: its settings and its ready and cost commands.
data/        How each arm's memory-extraction state is stored.
runs/        Run output (not tracked).
tests/       The harness's own test suite — it tests the instrument, never the candidate.
```

Inside the code, `bench` / `BENCH_` is the benchmark's neutral name: image names, the environment
prefix and the harness package. No memory system is named in the public surface; one enters only
through `BENCH_PLUGIN_DIR`.

## Licence

MIT — see [LICENSE](LICENSE).
