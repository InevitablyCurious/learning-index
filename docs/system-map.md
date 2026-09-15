# System map — bench

Condensed from the benchmark's full system inventory, remapped to the current
layout (`harness/`, `task/`, `grader/`, `images/`) and neutral naming. Full depth
lives in `RUNBOOK.md`, `ENV-VARS.md`, `LIVE-STREAM.md`, and the grader's own
docs.

---

## 1. What the benchmark is

`bench` measures whether a pluggable memory layer mitigates an LLM's
degradation. It runs one task — build a working backgammon game — repeatedly. A
**memory OFF** baseline builds from a stripped scaffold; a **memory ON** run
seeds the same task with what a prior run's memory layer captured. The measured
question: does re-injected memory reduce context growth, turn count, and gate
failures? The game is only the instrument; the subject under test is the memory
system.

## 2. Components

| Component | Path | Role |
|---|---|---|
| Harness | `harness/` | The Python measuring instrument: campaign sequencer + manifest, task adapters, scoring/scorecard, cell isolation, egress, image identity, blinding. |
| Task | `task/backgammon/` | The instrument's task: `scaffold/` (stubs the model builds from), `golden/` (reference solution, never shown), `prompts/` (chunked build prompts). |
| Grader | `grader/` | `report.mjs` + the gate suite (conformance / backend / frontend, plus `meta/` and `quarantine/`). The only component that sees the golden. |
| Control plane | `control/` | Node stdlib-only `server.mjs` — the only write-capable surface; spawns the harness, one run at a time. |
| Dashboard | `dashboard/` | Read-only board (containerized) at :8717; renders, never acts. |
| Images | `images/` | `worker/Dockerfile`, `grader/Dockerfile`, `sidecar/` (egress + loop-kill scanner + supervised shell). |
| Scripts | `scripts/` | Entrypoints: `run_cumulative.py` (canonical), `rebuild_worker_image.py`, `rebuild_grader_image.py`, `bench_preflight.py`. |
| Config | `config/` | `bench.env`; the bench-owned env surface is documented in `ENV-VARS.md`. |
| Tests | `tests/` | The harness's own pytest suite — grades the instrument, never the candidate. |

## 3. Run story

1. **Campaign (durable).** `scripts/run_cumulative.py` builds a
   `CumulativeSequencer` over a `CumulativeManifest`
   (`harness/cumulative/manifest.py`) — schema, roster, seed, config fingerprint,
   schedule, session records.
2. **Cell (executed).** One scheduled session per cell. The sequencer phase
   machine runs `PREPARE_FIXTURE → RUN_SESSION → DONE` (`HALTED_ON_GATE` on a
   gate failure). The worker container builds the task in chunks via a chunked
   opencode serve drive (`harness/adapters/backgammon.py`).
3. **Grading.** `harness/grader_run.py` runs the candidate's worktree through
   `bench-grader:v1` (`grader/`, `ENTRYPOINT ["node", "report.mjs"]`), read-only
   and `--network none`, producing `report.json` (verdict, problems, failed
   gates).
4. **Scorecard.** `run_artifacts.build_scorecard` aggregates the write-once
   manifest + append-only status stream into `manifest.scorecard.json` per cell.

The **control plane** (`control/server.mjs`, binds 127.0.0.1:8718, no shell, one
run at a time) spawns the entrypoint
`.venv/bin/python scripts/run_cumulative.py run --mode <arm>` and observes
read-only. The board (`:8717`) is a separate, read-only viewer.

## 4. Memory story — OFF vs ON

opencode IS the socket: the benchmark defines NO memory-system interface, NO
registry, and NO adapter. The only integration surface is ONE "which plugin"
pointer plus a README.

- **Schedule** (`harness/cumulative/ordering.py`): a full OFF baseline in roster
  order, then a seeded ON schedule. Every model is its own control.
- **OFF arm.** No plugin — the worker image is built VANILLA (`BENCH_PLUGIN_DIR`
  unset), so no memory is captured or written. The per-model floor the ON arm is
  measured against.
- **ON arm.** The worker image is built with a plugin tree: `BENCH_PLUGIN_DIR`,
  an absolute path to a real npm package built outside this repo, baked in at
  `/opt/bench-plugin` (`images/worker/Dockerfile`). The plugin captures learnings
  during the build; on a later cell it recalls prior memories over the recall
  seam (`BENCH_MCP_RECALL_URL`), guards them, and reinjects them into the system
  prompt. A standing record mandate can be supplied through the generic
  `BENCH_AGENTS_AUX_FILE` directive seam. The OFF/ON toggle (`memory_mode`
  off/on) is the only memory-mode distinction.
- **The harness reinjects nothing.** Capture, recall, and reinjection belong to
  the plugin; the benchmark only schedules the arms and measures the Δ.

The plugin and any recall store it talks to live **outside** this repo; the
benchmark names no backend and is agnostic to which plugin is plugged in.

## 5. The four balance properties (where they're enforced)

1. **No answer sheet.** Gates, golden, and grader are absent from the worker's
   image and filesystem by construction (the worker build context is
   `images/worker/` — only its Dockerfile plus the sidecar and plugin contexts;
   `grader/` and `task/backgammon/golden/` are never in it). `harness/blinding.py`
   is a shared vocabulary scanner, not the enforcer.
2. **No internet.** `harness/egress.py` declares `bench-internal`; the worker
   cell runs `--internal` with a fixed sidecar allowlist (4545/8443/4550/4440);
   the grader runs `--network none`.
3. **Full tooling.** `images/worker/Dockerfile`: Node 22.12.0, opencode + SDK,
   Playwright 1.48.0 + Chromium, git / ca-certificates / procps / curl. Only the
   answer is withheld.
4. **One-way observability.** Host→cell SSE + sidecar ingress; the cell cannot
   reach out (permission denies, no outbound route).
