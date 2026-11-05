# Learning-Index

**An open benchmark for AI agent memory.** For one model, in one harness, on one challenge, it
measures whether a memory system makes the agent's work better, where growing memory turns from
helping to hurting, and what the memory does when the job changes.

> **Status: proof of concept.** The no-memory baseline runs today, on a local model or a cloud
> endpoint. There are no memory-on results yet — see [where things stand](#where-things-stand).

How it was built, and the choices behind it: [notes from the operator](docs/operator-notes.md).

## Why it exists

People change what they want, and memory turns each change into confident wrong advice: a fix
replayed against code it no longer fits, an old preference overriding a new instruction. Memory
products say they handle this. Nothing can check that claim in real agent work: memory benchmarks
ask questions about conversations, and the few that test stale memory use quizzes or memories
written by hand.

Learning-Index measures it where it happens. An agent builds real software again and again, with
and without a memory system, and the grader runs what it builds. Because the challenge is
configurable, the job can also be changed on purpose, to see how the memory copes.

## The questions

1. **Does a memory system make the agent's work better?**
2. **As memory keeps growing, is there a point where it stops helping and starts to hurt?** That
   point is the memory system's **index**.
3. **When the job changes — a preference, a way of working, a dependency — does the memory adapt,
   or keep steering the agent the old way?**

The proof of concept answers questions 1 and 2. Question 3 is why the benchmark exists. How each is
measured: [methodology](docs/methodology.md).

## How it works

- **Everything but memory is fixed.** One harness (opencode, version pinned), one challenge (a
  backgammon game) and one deterministic grader, and each model is its own control: its context
  window, its speed and its raw ability cancel out of its own result. Every run is fingerprinted,
  and a run is compared only with baselines whose fingerprint matches.
- **The unit is one run.** One click on Run launches one cell: a single opencode session that
  builds the challenge in five chunks, in order, then troubleshoots in that same session, round
  after round, until every check passes. The harness compacts the session itself between chunks,
  a launch choice stated before the run starts and part of its fingerprint, costing one model turn
  per chunk. There is no round cap and no time cap.
- **A chunk ends on the transport's verdict.** A chunk is complete when the session goes idle with
  exit 0, and nothing the model wrote is read to decide it. A non-zero exit ends the build there,
  and every later chunk is recorded not reached.
- **Two arms.** OFF: every click in OFF mode is a baseline, appended and averaged per fingerprint.
  ON: the same model with a memory system reading and learning, measured against the average of the
  baselines that share its fingerprint.
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
  cloud cell also records what it cost. Beside it: whether the cell finished and what ended it, the
  memory delivered to the agent, and the memory system's own background work.
- **No language model judges anything.** The grader runs the game: more than 150 checks, in the
  order a player meets them.

## What's different

- **Judged by running the work,** not by answering questions about it.
- **Memory learned from the agent's own work,** over a long series, against the same model's
  no-memory baseline.
- **Memory priced in tokens,** including the context it adds on every turn and its own background
  work.
- **Open on both sides:** any memory system plugs in unchanged, and anyone can add a challenge.

What existing benchmarks measure, and the closest project: [related work](docs/related-work.md).

## Where things stand

| | |
|---|---|
| **Built** | The instrument: sealed agent cells, a deterministic grader, a control plane and a live board. One challenge (backgammon). Memory-off baselines with a local model. |
| **In progress** | The memory-off baseline: making every line told to the model true of the build it describes, and the problems it hears match what a tester would report. Preparing the first memory system, Honcho. |
| **Next** | Memory-on series (questions 1 and 2). Then memory under change (question 3). |

## The challenge: backgammon

Build a complete, playable backgammon game — a human against the computer — in Node and TypeScript
with no dependencies, in five steps: the rules engine; the computer opponent; the server and its
API; an animated board page; and integration, until the whole game runs clean.

The grader runs more than 150 checks in three phases: the contract's shape, the engine and API, and
a real browser playing like a person. They fall into seven stages, in the order a player meets
them — the game opens; rolling and moving; hitting and the bar; bearing off; winning; the doubling
cube; playing the computer. After each round the agent hears about the earliest stage that fails,
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

## Plug in a memory system

A memory system plugs into opencode through opencode's own plugin mechanism; the benchmark adds no
memory interface of its own. Point `BENCH_PLUGIN_DIR` at the plugin package and rebuild the worker
image, and each cell runs with memory OFF or ON. The first system is
[Honcho](https://github.com/plastic-labs/honcho), which publishes an opencode plugin; its kit is in
[memory-systems/honcho](memory-systems/honcho/). The guide, with Honcho step by step:
[docs/memory-systems.md](docs/memory-systems.md).

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
#    set BENCH_PLUGIN_DIR=<abs path to plugin tree> first to install a memory plugin
.venv/bin/python scripts/rebuild_worker_image.py
.venv/bin/python scripts/rebuild_grader_image.py

# 4. preflight — prints GO with the exact launch command, or NO-GO naming the fix
.venv/bin/python scripts/bench_preflight.py --model <alias>

# 5. start the control plane (the only write-capable surface)
node control/server.mjs            # http://127.0.0.1:8718

# 6. start the read-only board (in another shell)
(cd dashboard && docker compose up -d)   # http://127.0.0.1:8717
```

Runs are started from the board: `[+ BASELINE]` for a memory-off cell, `[+ run]` on a baseline row
for a memory-on one. Full operations: [RUNBOOK.md](RUNBOOK.md).

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
| **Baselines** | One row per model: every memory-off baseline on its fingerprint and the average the memory-on runs are measured against, with those runs nested beneath; a stats strip of scored, voided and unmeasured runs and error counts. |
| **Transfer curve** | Memory-on runs' turns, tokens and wall time against the baseline average, with stacked token bars; a line appears from two memory-on runs. |
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

## Why opencode

A memory benchmark needs a harness that adds nothing of its own to what is measured. opencode is
open source (MIT) and pinned in the worker image; it works with any OpenAI-compatible endpoint,
local models included; it exposes each session over HTTP, so the benchmark can drive a build step
by step while an operator watches live; and memory systems plug in through its own plugin
mechanism. It keeps no memory of its own between sessions, so a no-memory run is a clean control.
Its automatic context compaction stays at opencode's own default, never forced off: where a run
asks for it, the harness compacts the session once after each build chunk and counts only the
compactions that finish, and in troubleshooting a cell is ended only when two compactions complete
before one grade.

<details>
<summary>Why not another harness</summary>

| Harness | Why it was not chosen |
|---|---|
| **pi** (Mario Zechner) | The closest alternative: open source, model-agnostic and deliberately minimal. The benchmark is built on two things opencode provides natively — `opencode serve`, which exposes every session over HTTP with a live event stream, and a plugin mechanism memory systems are written against. pi also leaves out MCP by design, while many memory systems ship as MCP servers. pi is the natural second harness to support. |
| **Hermes Agent** (Nous Research) | Learning is its core feature: it keeps persistent memory, writes its own reusable skills from experience and searches its past sessions. Its no-memory run is not a clean control; it belongs among the systems under test. |
| **Claude Code** (Anthropic) | Closed source and built for Anthropic's models. It ships its own memory — CLAUDE.md files and an automatic memory — so a memory-off run is never clean. |
| **Cursor** | A closed-source editor that routes models through its own service, indexes the codebase for retrieval and keeps its own rules and memories. |
| **Codex CLI** (OpenAI) | Open source, but built for OpenAI's models first, so other models would run at a disadvantage: a harness-versus-model confound. |
| **Gemini CLI** (Google) | Open source, but built around Gemini models, and it ships a memory tool the model can call to save facts across sessions. |
| **Aider** | A pair-programming tool driven one request at a time rather than an autonomous loop. By default it adds its own ranked map of the repository to every request, and it has no plugin surface for a memory system. |

Also weighed: OpenHands, which injects its own knowledge snippets and condenses context on its own
platform, and Goose, which ships a memory extension.

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
