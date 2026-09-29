# Learning-Index

**An open benchmark for the question memory benchmarks skip: what is a memory system actually worth to an AI coding
agent doing real work — what does it cost to build up, what does it save, and when does more of it stop helping?**

## Preface — why an open benchmark

Benchmarks are how we come to understand what a system can do. For language models they are the window into how an
agent performs on a particular slice of work — and that window has narrowed. A handful of shared benchmarks and
leaderboards now set the terms on which models are compared, what data gets inspected, and what counts as progress.
When a measure becomes the target it stops being a good measure (Goodhart's law): effort flows toward the score,
benchmark items leak into training data, results saturate, and the number drifts away from the behaviour it was
meant to reveal. The labs that build frontier models end up optimising for what a few benchmarks happen to measure.

That runs against what benchmarking is for. The useful question is rarely "which model is best?" It is "how well
does this agent perform, inside harness X, on challenge Y?" — asked across many harnesses and many kinds of
challenge, with every variable in plain view. Those variables should be set by anyone and judged by everyone. A rich
understanding of agentic work comes from many specific, inspectable measurements, not from one number owned by a few.

Learning-Index is built that way. Anyone can design a challenge and plug it in; anyone can plug in a memory system;
every run records the conditions it ran under, and every result can be replayed and inspected — down to the software
the agent built and the words it was told.

## What it is

Learning-Index has one model build the same working software, again and again, under controlled and fingerprinted
conditions. Runs without memory set that model's own floor. Runs with memory show what the memory changes: the
tokens the agent spends (including the cost of re-reading injected memory on every turn), how large its context
grows, how many turns it takes, and how many problems remain. The software is only the instrument; the subject
under test is the memory system.

---

## Status — Phase 1: building the benchmark framework

| | |
|---|---|
| **Built** | The measuring instrument: a harness that runs sealed agent sessions, a grader, a control plane and a live board. One worked challenge (backgammon). Memory-off baselines with a local model. |
| **In progress** | Making the grader's feedback trustworthy — every line told to the model must be true of the build it is told about. Reviewing the reference game by play and updating it to the player's standard. |
| **Next** | Memory-on series with pluggable memory systems, grouped per system. Series that change the challenge between runs — preferences, working style, dependency versions — to test how memory copes with drift. |

Open defects are tracked in the defect register in [RUNBOOK.md](./RUNBOOK.md).

---

## What the experiment measures

**Design.** One model, one challenge, repeated. A batch of memory-OFF runs gives the model's floor: the median
problem count over its scored runs, with the operator's chosen run recorded against that median. Memory-ON runs then
repeat the same challenge while memory accumulates. Every model is compared only with itself — never with another
model.

**Signals per run.** Tokens in all five categories opencode reports — input, output, reasoning (already counted inside
output), cache read and cache write — summed into one total; turns; peak context against the model's window; wall time; attempts;
and the graded problems left at the end.

**Goals.**

1. **The cost of memory against what it buys.** Memory is never free. Extracting and storing it costs tokens, and
   injected memory makes every prompt bigger — a prompt the agent re-reads on every turn, billed as cache reads. The
   benchmark prices that growth against what it buys: fewer turns, a smaller context, fewer failures.
2. **Context and turn reduction across repeated runs.** Whether an agent that repeats the same challenge with memory
   needs less context and fewer turns to reach the same result — measured, never assumed.
3. **An information depreciation index.** As memory accumulates run over run, each new piece is worth less, and past
   some point accumulated memory can start to hurt. The transfer curve follows each run against the floor to find
   where the return turns; the same series run across memory systems and their configurations gives an index of how
   fast each one's accumulated information depreciates.
4. **Honest attribution.** A memory that was delivered is not a memory that helped. Only the difference between the
   arms is causal; no difference is claimed until each arm has at least three scored runs; invalid runs are counted
   as excluded, never scored as zero.

---

## Why existing memory benchmarks do not measure this

Memory for AI agents is now a product category, and the leading systems publish benchmark results. Those results
share one shape: **they test whether a memory can answer questions about a long conversation.** None follows an
agent through repeated real work and prices what the memory costs, saves, and loses as it grows.

### How the leading systems evaluate themselves

| System | Published evaluation | What is scored |
|---|---|---|
| **Mem0** — *Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory* (arXiv:2504.19413, 2025) | LoCoMo | Answers to questions about long multi-session conversations (LLM-as-a-judge, F1, BLEU-1), plus retrieval latency and the tokens memory adds to each question, against full-context and retrieval baselines |
| **Zep** (and its Graphiti knowledge-graph engine) — *Zep: A Temporal Knowledge Graph Architecture for Agent Memory* (arXiv:2501.13956, 2025) | Deep Memory Retrieval (DMR, introduced by MemGPT) and LongMemEval | Question-answering accuracy and response latency against full-context baselines |
| **Letta** (the MemGPT team) — *MemGPT: Towards LLMs as Operating Systems* (arXiv:2310.08560, 2023) | Multi-Session Chat (deep memory retrieval, conversation openers), multi-document question answering, nested key-value retrieval | How accurately facts are recalled across sessions and documents |

The shared benchmarks are conversational too:

- **LoCoMo** (arXiv:2402.17753, 2024) — very long, many-session conversations between two personas; questions test
  single-hop, multi-hop, temporal, open-domain and adversarial recall.
- **LongMemEval** (arXiv:2410.10813, 2024) — questions over long chat histories testing information extraction,
  multi-session reasoning, temporal reasoning, knowledge updates and abstention.
- **MemoryAgentBench** (arXiv:2507.05257, 2025) — incremental multi-turn interactions testing accurate retrieval,
  test-time learning, long-range understanding and conflict resolution.

Even on this shared ground the numbers are contested. In 2025 Zep publicly disputed how Mem0's paper had configured
Zep on LoCoMo, and Letta reported that an agent given nothing but file-search tools scores competitively on LoCoMo —
evidence that the benchmark rewards retrieval, not memory.

The closest work on agents that learn from their own history comes from research, not from memory products:
**Reflexion** (arXiv:2303.11366, 2023) has an agent retry the same task — coding problems among them — carrying its
own written reflections forward; **ExpeL** (arXiv:2308.10144, 2023) distils reusable insights from past tasks;
**Agent Workflow Memory** (arXiv:2409.07429, 2024) reuses workflows induced from past web tasks. These report whether
success rises. They do not report what the carried-over knowledge costs, or when it stops paying.

### What none of them measures

| Dimension | Conversational memory benchmarks | Experience-reuse research | Learning-Index |
|---|---|---|---|
| Cost of accruing memory over a series of runs | not measured | not measured | per-run token cost measured; series plotted on the transfer curve |
| Memory's recurring cost inside a working agent — injected text re-read every turn, billed as cache reads | per-question token counts at most | not measured | measured (cache read and write in the total) |
| Context growth and turn count of an agent doing real work, run over run | not measured | not measured | measured |
| Repeated runs of the same task by the same model, against its own no-memory floor | not measured | success rate only | the design |
| The point where more memory stops paying off, or starts to hurt | not measured | not measured | the aim of the series (instrument in progress) |
| Success judged by executing the work, not by answering questions about it | no — question answering | yes, on its own tasks | yes — a grader runs the built software |
| Real-work drift: preferences, working style, dependencies, false fixes, negative-knowledge deviations | knowledge updates and conflicting facts, in conversation only | not measured | designed for; not yet built |

### Why they did not measure it (our analysis)

1. **The products were built for conversational personalisation**, so the natural test is recall: can the system
   answer a question about what the user said?
2. **Question-answering benchmarks are cheap, static and reproducible** — a fixed dataset, a scoring script, one
   number. Following an agent through many full working runs is slow, costly and noisy, and needs a sealed
   environment plus a grader that executes the work.
3. **A memory vendor controls retrieval, not the agent.** It can report what its API returns per question; what that
   text costs once an agent re-reads it on every turn depends on the harness, so it falls outside vendor benchmarks.
4. **Measuring decay takes long series of repeated runs by the same model**, and the answer can be that memory hurts —
   a result a vendor benchmark has no reason to look for.
5. **Knowledge about real work is conditional.** A fix is true for one dependency version, one environment, one user's
   current preference. Only executing the work reveals that a stored "fix" has quietly expired; a question-answering
   item cannot express it.

### What real work adds

Memory architecture is vast, and every design makes choices these benchmarks never exercise. Five of the conditions
a memory serving a working agent has to survive — among many more:

- **Preference drift.** What the user wanted last month is wrong today. A memory that appends instead of superseding
  turns yesterday's instruction into today's contradiction.
- **Working-style drift.** How the user works — test-first or prototype-first, their commit and review habits —
  changes. Procedural memory learned from the old style keeps steering the agent the old way.
- **Dependency drift.** A fix holds for a version range. Coding knowledge has preconditions — library versions,
  environment, configuration — and a memory that stores the fix without its preconditions cannot tell when it has
  expired; applied to the next version, it is a regression delivered with confidence.
- **The false-fix dichotomy.** Memory learns from outcomes, and outcomes are binary: the error went away, or it did
  not. A change that suppresses a symptom and a change that removes its cause produce the same outcome, so a memory
  that records "this fixed it" cannot tell a mask from a repair — and replays the mask with the confidence of a
  verified solution. A passing test is evidence, not a diagnosis.
- **Negative-knowledge consensus deviation.** "X doesn't work here" is among the most valuable things a memory can
  hold, and the hardest to keep true. When a stored prohibition departs from what other sources, newer evidence or
  common practice now say — because it was wrong, was local, or was overtaken by an upstream change — the agent
  keeps avoiding what now works. And a prohibition is self-sealing: an agent that obeys it never produces the
  evidence that would overturn it.

Conversational benchmarks touch the first of these as a changed fact in a chat; none puts any of them in front of an
agent doing real work. Learning-Index is built to: the model repeats the same task under fingerprinted conditions,
and a challenge is its own repository that can change between runs of a series. Series that introduce these changes
are the next phase; they are not built yet.

---

## Why opencode

A memory benchmark needs a harness that adds nothing of its own to what is being measured. opencode is a plain,
vanilla harness: it gives the model tools and a working loop, and it does not learn — no built-in memory, no notes
carried between sessions, no retrieval index over the codebase. Whatever the agent carries from one run to the next
arrives through the memory system under test, or not at all. That makes opencode's no-memory run a clean floor, and
the same harness fits every model used for agentic work.

It meets the other conditions a fair memory benchmark needs:

- **Open source (MIT).** Every line between the model and its work can be read, and the benchmark pins one opencode
  version into the worker image, so the harness itself is a fixed, fingerprinted variable.
- **Model-agnostic.** opencode works with many providers and any OpenAI-compatible endpoint, local models included,
  so every model runs in the same harness and each is compared only with itself.
- **Client and server.** `opencode serve` exposes each session over HTTP: the harness drives the build step by step
  through the API and reads every event and token count, while an operator can `opencode attach` to watch live.
- **Plugins.** A memory system plugs in through opencode's own plugin mechanism, without forking the harness — which
  is why the benchmark needs no memory adapter of its own.
- **Nothing hidden.** The benchmark switches opencode's automatic context compaction off, so running out of context
  is observed, not silently summarised away.

### Why not another harness

| Harness | Why it was not chosen |
|---|---|
| **pi** (Mario Zechner) | The closest alternative: open source, model-agnostic and deliberately minimal — a small system prompt, a handful of tools, no built-in memory. The benchmark is built on two things opencode provides natively: `opencode serve`, which exposes every session over HTTP with a live event stream so the harness can drive the build while an operator attaches from another terminal, and a plugin mechanism memory systems are written against. pi also leaves out MCP by design, while many memory systems ship as MCP servers. pi is the natural second harness to support. |
| **Hermes Agent** (Nous Research) | Learning is its core feature: it keeps persistent memory, writes its own reusable skills from experience and searches its past sessions. That makes it a memory system with a harness around it — its no-memory run is not a floor. It belongs among the systems under test, not under them. |
| **Claude Code** (Anthropic) | Closed source and built for Anthropic's models. It ships its own memory — CLAUDE.md files loaded into every session, and an automatic memory that saves what it learns across sessions — so a memory-off run is never clean. |
| **Cursor** | A closed-source editor that routes models through its own service. It indexes the codebase for retrieval and keeps its own rules and memories, so the product, not the memory under test, decides what the model sees. |
| **Codex CLI** (OpenAI) | Open source, but built for OpenAI's models first — its prompts and patch-based editing are tuned to them — so other models would run at a disadvantage: a harness-versus-model confound the benchmark exists to avoid. |
| **Gemini CLI** (Google) | Open source, but built around Gemini models, and it ships a memory tool the model can call to save facts across sessions — native learning that would contaminate the floor. |
| **Aider** | Open source and model-agnostic, but a pair-programming tool driven one request at a time rather than an autonomous agent loop. By default it adds its own ranked map of the repository to every request — a retrieval layer that would blur what memory adds — and it has no plugin surface for a memory system. |

Also weighed: OpenHands, which injects its own knowledge snippets and condenses context on its own sandbox platform,
and Goose, which ships a memory extension.

## What the system provides

**The benchmark is the adapter.** Anyone can design a challenge and plug it in — the benchmark supplies the sealed
runtime, the repetition, the grading loop and the board; the challenge supplies the task. A challenge is its own
repository, selected with `BENCH_TASK_DIR`. It declares
itself in `challenge.json` and brings its build prompts, a starting scaffold, a reference solution and a grader. The
grader's contract is two scripts — `roster.mjs --out` lists every check without running any, `report.mjs --target
--out` grades a built candidate — plus one complaint per check, written the way a user would say it. The starting
files are frozen by hash, so a run refuses to start if they drift. Backgammon ships as the worked example; see
[challenges/](./challenges/).

**A direct view of the model's session.** Every running cell writes an `opencode attach http://127.0.0.1:<port> --session
<id>` command (in its `live-view.txt`) that opens the model's live opencode session in your own terminal, and the
board mirrors the running terminal read-only (a 40×130 grid drawn with xterm.js).

**An agent without vision, and every tool it needs to see.** The model never sees a picture of what it builds. To
check a board it cannot look at, it has to use the tools in its cell: drive a real browser with Playwright, read the
page's structure and computed styles, click like a player and measure what changed. The cell carries everything the
agent needs — Node 22, opencode, Playwright with Chromium, and git — in one prebuilt worker image shared by every run
and every challenge; the challenge is mounted in, never baked, so a new challenge needs no new image. Withheld by construction: the reference solution
and the grader never enter the worker's build context, the cell's network is internal with a fixed allowlist, and
grading runs with no network at all.

**Grading built to tell the truth.** A reference solution proves each challenge is buildable, and the grading image is
only built when it passes every check. Failures reach the model as complaints a person would make — for the earliest
stage that fails, and never for a step whose cause another check already reports. Every change to the grader is proven
against deliberately broken builds before it ships.

**Controlled repetition.** Snapshots let a run start from a finished build instead of rebuilding, and a run that ends
stuck can hand its final build to the next (a chain). Every cell records a fingerprint of the eight inputs that make
runs comparable — build prompts, grader, model, challenge, compaction, scaffold, reference solution, worker image — so
a floor is only ever compared with runs made under the same conditions. Several cells can run at once; each is
tracked in a durable launch record that survives a control-plane restart.

**Operations.** A preflight that answers GO with the exact launch command, or NO-GO naming the fix. Costly or destructive
acts — start, stop, reset, restore, delete — take a preview and a confirmation. A reset moves all benchmark data into
backups, and any backup can be restored. Any past build can be played again from the history page. A separate
custom-tools service can add tools to the board's drawer. The board can be opened from other devices on the local
network. Each run's live stream (`runs/<run>/live.jsonl`) is a published contract that any memory backend can read.

### The board

A read-only live instrument at `http://127.0.0.1:8717`. It holds no data of its own: every panel reads from the control
plane on `:8718`, the only process that reads run files or changes anything.

| Panel | What it shows |
|---|---|
| **Runs strip** | One card per run, current and archived: status, problems before and after, peak context against the window, turns, loop and stall errors. Picks the cell the rest of the board shows. |
| **Gate wall** | Every check as a fixed square — passed, recovered, failed, not yet observed — with a card per check on hover. |
| **Baselines** | One row per memory-off batch: its median and spread, the chosen floor run, its cells, and the memory-on runs measured against it; a stats strip of scored, voided and unmeasured runs and error counts. |
| **Transfer curve** | Memory-on runs' turns, tokens and wall time against the floor, with stacked token bars; a line appears from two memory-on runs. |
| **Learning** | A check-by-attempt matrix filling as the cell runs; the model's own account of its work beside the code-derived record of what it changed. |
| **Terminal mirror** | The running cell's terminal, live and read-only. |
| **Data feed** | The running cell's events — or a finished cell's frozen record — with filters, plus a backend feed beside it; a phase spine of one build and each grading round, with running token counters. |
| **Honesty rail** | Coverage, unresolved episodes, guard detections, recall overhead (p50/p95), turns burned, and memory serves labelled as delivery, not outcome. |
| **Recall** | Where a memory injection will be shown; today it shows its resting state (the moment of recall is designed, not yet built). |
| **Hold / review** | When a run ends on hold, a link to test the built artifact and a release. |
| **Challenges** | The challenges available to measure, ready or blocked with the reason. |
| **Startup feed** | The background processes behind a benchmark start, worst first, with reasons. |
| **Top bar and provenance strip** | Model, run state, stop, dev-mode mark, history link; policy, worker fingerprint, seed and source health. |
| **New baseline / new run** | The launch wizard: local or cloud, model, optional seed snapshot, challenge, confirmation, preflight checklist. |
| **History page** (`/history`) | Every run with its checkpoints, the files each changed and side-by-side diffs; play any build; delete with confirmation. |
| **Settings drawer** | Refresh the worker, grader, control plane or board; custom tools; the machine share given to grading; dev mode; router credentials. |
| **Reset and restore** | Move all benchmark data into a backup and start clean, or bring a backup back — each with a preview and a confirmation. |

The board is assembled under rules that refuse to overstate. It separates three kinds of nothing — *unobserved* (not measured yet), *unwired* (the
source is not connected) and *0* (measured, and zero) — and never collapses them. It computes no difference between
the arms below three scored runs per arm, counts invalid runs as excluded rather than as zero, never treats a memory
serve as an outcome, and never puts a confidence interval over check counts (checks cluster within a run; 68 checks
from one run are not 68 samples).

---

## The backgammon challenge

**Task.** Build a complete, playable backgammon game — a human against the computer — in Node and TypeScript with no
dependencies, in five build steps:

1. the rules engine;
2. the computer opponent (position evaluation, move choice, win probability, doubling decisions);
3. the server and its API;
4. an animated board page with exact automation hooks;
5. integration, until the whole game runs clean.

**Reference solution.** A complete working game kept outside the agent's reach. It proves the challenge can be built,
keeps the grader honest, and sets the timing baseline for the checks.

**What is graded.** More than 150 checks in three phases, run against the built software:

- **Conformance** — the contract's shape: routes, response fields, page hooks.
- **Backend** — the engine and the API: legal moves, hitting, the bar, bearing off, the dice, the cube, scoring, turn
  flow, the computer's play.
- **Frontend** — a real browser acting like a player: what the board shows, where it is drawn, and what clicking does.

Neither side has vision. The agent must verify what it draws by measuring it, and the grader judges what a player sees
the same way — from where things are drawn, their shapes, and what a click does.

**In the order a player meets them.** Checks fall into seven stages — 1 The game opens · 2 Rolling and moving ·
3 Hitting and the bar · 4 Bearing off · 5 Winning · 6 The doubling cube · 7 Playing the computer. After each attempt
the model hears about the earliest stage that fails, and nothing later.

**How a failure reaches the model.** Each check carries a complaint written as a player would say it, in two
flavours: the first time it is seen, and when it is still there after a fix. A second voice covers what only an
integrating team would notice. Rounds open by naming what was fixed and what broke that had been working, and every
message ends with the outside surface to keep exactly as it is — element tags, routes, response fields. A run ends
when every check passes, when its attempts run out, or when the model runs out of context.

**Scoring.** Every run is scored, as a pass or a fail, unless it is voided — a failed ending that coincides with a
provider-side truncation or a grading-instrument fault — or unmeasured, when its memory delivery could not be
verified. Voided and unmeasured runs are listed, never counted.

---

## How we iterate

Phase 1 runs as a tight loop, with September 2026 alone accounting for about 235 commits:

1. **Run a memory-off baseline** of one local model; it builds the game in five steps, then repairs it round by round
   from the complaints.
2. **Play every round's build** from the history page the way a person would, side by side with the reference game —
   playing it is the only check on whether the grading tells the truth.
3. **Audit every line told to the model.** Is it true of the build it was told about?
4. **A false line is the benchmark's fault.** Fix the grader, prove the fix against deliberately broken builds and a
   full re-grade of every saved build, then rerun the same starting snapshot.
5. **A stuck model, with every line true, is a result.** Chain the next run from that run's end snapshot.
6. **Review the reference by play.** A player's corrections become new requirements, new checks and a fresh baseline.

The first finish line — three runs in a row where every line told to the model was true — was reached in September
2026.

---

## Quickstart

One-time installs, two image builds, then a control plane and a board:

```bash
# 1. install the harness (once)
python -m venv .venv && . .venv/bin/activate && pip install -e '.[test]'

# 2. install the grader's test tools on the host (once). Every run lists the
#    gate suite on the host at cell start, and the board's gate wall does the
#    same; without these the list comes back empty. Preflight refuses until
#    they are installed.
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

Runs are started from the board. Each cell spawns the canonical entrypoint `.venv/bin/python
scripts/run_cumulative.py run --mode off|on` — argv only, never a shell. [RUNBOOK.md](./RUNBOOK.md) is the operative
run card.

## Plug in a memory system

Two adapters, never confused: challenges plug into the benchmark; memory systems plug into opencode. A memory system
plugs in through opencode's own plugin mechanism, and the benchmark adds no memory interface, registry or adapter of
its own. `BENCH_PLUGIN_DIR` names an absolute path to a plugin tree (a
real npm package built outside this repo), which the worker image build installs; each cell then runs with memory OFF
(the floor) or ON. The plugin does the memory system's work — capture during the build, recall and reinjection in
later runs. The harness reinjects nothing; it measures the contrast.

## Custom tools

The board's drawer lists the benchmark's own tools and, optionally, tools served by a separate custom-tools service —
for example a memory system's own operations. Point `BENCH_TOOLS_URL` at that service; unset, the drawer shows only the
benchmark's tools. The benchmark never consults the service for preflight or for a run, so it runs the same whether
the service is healthy, broken or absent. The contract is in [CUSTOM-TOOLS.md](./CUSTOM-TOOLS.md).

## Repository layout

```
harness/     Python measuring instrument — sequencer, manifest, adapters, scoring, cell isolation, egress,
             fingerprints, image identity.
task/        The backgammon challenge — scaffold (stubs), golden (reference, never shown), prompts.
challenges/  Where your own challenge repositories go, and TEMPLATE/ to start one.
grader/      report.mjs + roster.mjs and the check suite (conformance / backend / frontend) — the only component that
             sees the reference.
control/     Node control plane (server.mjs) — the only process that reads run files or changes anything.
dashboard/   The read-only board at :8717.
images/      worker/ and grader/ Dockerfiles, sidecar/ (egress + loop-kill).
scripts/     Entrypoints: run_cumulative.py, rebuild_*_image.py, *_preflight.py.
config/      bench.env and the bench-owned environment surface (see ENV-VARS.md).
docs/        The system map.
data/        How each arm's memory-extraction state is stored (see data/README.md).
runs/        Run output (not tracked).
tests/       The harness's own test suite — grades the instrument, never the candidate.
```

## Naming

The project is **Learning-Index**. Inside it, `bench` / `BENCH_` / `bench-*` is the benchmark's neutral identity —
image names (`bench-worker:v1`, `bench-grader:<challenge>`), the environment prefix and the harness package. The benchmark
names no memory backend in its public surface: a memory system enters only at build time, through the
`BENCH_PLUGIN_DIR` pointer.

## Licence

MIT — see [LICENSE](./LICENSE).
