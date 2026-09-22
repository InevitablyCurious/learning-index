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
| Control plane | `control/` | Node stdlib-only `server.mjs`, loopback :8718 — the only process that reads run files (`control/board/sources/`) or changes anything; assembles and pushes the board, spawns the harness, N concurrent cells at a time. |
| Dashboard | `dashboard/` | Container at :8717: serves the board page and relays `/api/*` to the control plane (`lib/control-relay.mjs`); holds no run data. Optional LAN publish (`docker-compose.lan.yml`) with a peer check (`lib/net-policy.mjs`). |
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
   opencode serve drive (`harness/adapters/challenge/serve.py`).
3. **Grading.** `harness/grader_run.py` runs the candidate's worktree through
   `bench-grader:<challenge>` (the challenge's gate suite, `ENTRYPOINT ["node", "report.mjs"]`), read-only
   and `--network none`, producing `report.json` (verdict, problems, failed
   gates).
4. **Scorecard.** `run_artifacts.build_scorecard` aggregates the write-once
   manifest + append-only status stream into `manifest.scorecard.json` per cell.

The **control plane** (`control/server.mjs`, binds 127.0.0.1:8718, no shell, N
concurrent cells at a time) spawns the entrypoint
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
  measured against — and since 2026-09-22 that floor is **not one run**: it is the
  operator's chosen run out of an N-cell batch, reported as the **median problem
  count over scored runs** (see §8).
- **ON arm.** The worker image is built with a plugin tree: `BENCH_PLUGIN_DIR`,
  an absolute path to a real npm package built outside this repo, baked in at
  `/opt/bench-plugin` (`images/worker/Dockerfile`). The plugin captures learnings
  during the build; on a later cell it recalls prior memories over the recall
  seam (`BENCH_MCP_RECALL_URL`), guards them, and reinjects them into the system
  prompt. The OFF/ON toggle (`memory_mode` off/on) is the only memory-mode
  distinction.
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

## 6. Dashboard testing conventions

- **Source-pin tests.** Some tests READ source files and `assert.match` on
  them (`control/board/restart-recovery.test.mjs`, `event-window.test.mjs`,
  `dashboard/dom-patch.test.mjs`), so a wording change in a file a test merely
  reads can fail it. For the dashboard/board suite, grep the tests for `read("…")`
  before editing; for the **control-plane** suite, the pins use
  `readFileSync(join(…, "routes", "run.mjs"))` — grep `readFileSync(join` (and the
  join-segment form `"routes", "run.mjs"`), not `read("`, or you will undercount
  the files that pin a route/lib file.
- **`dashboard/check/board-check.mjs`** is the end-to-end check: it runs on
  every `dashboard/redeploy.sh` against 127.0.0.1 and the LAN address.

## 7. Build snapshots — the dev-mode chain

Snapshots are **dev-mode tooling, never a measurement surface**: a worktree is
copied to `runs/snapshots/<id>/{tree/,snapshot.json}` (`capture_snapshot`,
`harness/snapshot.py`) so a later cell can seed from it and skip the build. Full
procedure in RUNBOOK §18.

**Two capture triggers.** (1) **Attempt-1 build-completion** — every baseline
captures its finished worktree at the first grade boundary
(`harness/adapters/challenge/runner.py:1602-1603`). (2) **End-of-run chaining**
— a *seeded* run that exhausts its attempts promotes its final worktree to a new
snapshot (`_capture_end_of_run_snapshot`, `runner.py:565`), gated on
`_seed_snapshot_tree is not None` (`runner.py:1641-1642`), so a dev-mode chain
carries its accumulated fixes forward instead of discarding them.

**The depth field is `snapshot_depth`, never `cell_seq`.** `snapshot.json` carries
`cell_seq` (the authoring cell's per-campaign `sequence_index` — 0 for the first
cell), which is NOT a chain depth and must never be read as "n". The depth field
is `snapshot_depth`: the attempt-1 capture omits it (read as 1 by default), while
the end-of-run capture writes `seed_depth + 1` (`runner.py:595`). The control
plane exposes `snapshot_depth ?? 1` and drops `cell_seq` (`control/snapshots.mjs:89`).

**The run→snapshot join key is end-of-run-only.** `produced_snapshot_id` on
`manifest.session_records[]` (`harness/cumulative/types.py:582`) is populated ONLY
by the end-of-run capture (`runner.py:629`), never the attempt-1 capture — so a
normal unseeded baseline reports null even though its snapshot exists on disk. It
is the durable link the run-delete path consumes.

**The manifest is campaign-nested, not at run root.** The manifest holding
`session_records[].produced_snapshot_id` lives at
`<runs_root>/<treeId>/<substrate>/<router>/<provider>/<model>/manifest.json`
(`control/campaign.mjs:72-73`); archives nest deeper under
`runs/backups/<newTreeId>/<oldTreeId>/<…>/manifest.json`.

**Cleanup asymmetry.** Run deletion hard-deletes the snapshot(s) its manifest
names via `produced_snapshot_id` (no cascade). A RESET does **not** sweep
`runs/snapshots/` — `isBenchmarkData` has no `snapshots` case
(`control/tree.mjs:271-296`), so snapshots survive a reset with no recorded
owner.

## 8. Concurrency + median baselines (2026-09-22)

Landed as eight commits (`2ed2a73`…`08efbb2`, rollback `3ca2693`). Supersedes the
single-cell model: the control plane runs N concurrent cells, and a model's floor
is the median of a batch, not one run.

**Cell identity.** A 12-hex `run_identity` (uuid4, once per process at
`scripts/run_cumulative/__init__.py`) suffixes the worker container
(`bench-cell-{label}-{run_identity}`) and keys the session-DB volume, the egress
sidecar (`okp-egress-{sha256(run_identity)[:12]}`), and the grader container
(`bench-grade-{run_identity}-{cell}-{stem}`). The reaper filter is anchored
(`name=-{run_identity}$`), never a substring sweep; the sidecar gained a
stale-name `docker rm -f` guard.

**Live-view port.** Each cell's live-view serve gets its own free host port
(`harness/free_port.py::resolve_serve_host_port`, allocated before the reaper reads
it); the port rides the `cell.start` record and is surfaced by the board. The fixed
`:8719` is retired.

**N-concurrent control plane.** `control/run-ledger.mjs` (N-slot run registry),
`readRunState` returns `runs[]`, launch is gated **per model** (`models-ledger.mjs`
`inFlightModels`), and `allocateSequenceIndex` is atomic. `/api/run/start` accepts
`concurrency` N (default 1) and pre-flights all N before spawning.

**Batch baseline.** `control/batch.mjs` computes the median of scored runs (voids
excluded, never counted as failures) over a fingerprint of 8 inputs (build prompts,
grader, model, challenge, compaction, scaffold, golden, worker image); the operator
picks the artifact run and the record stores its signed deviation from the median.
`control/baselines.mjs` no longer picks `scorable[length-1]`.

**Contention covariates.** The 7 covariates (`http_429_count`, `http_402_count`,
`retry_count`, `upstream_error_count`, `wall_near_timeout`, `max_request_ms`,
`median_request_ms`) are surfaced on scored + batch records; the missing-telemetry
seam was un-blinded (they left `CONSTRUCTION_DEFERRED_TELEMETRY_SEAMS`). Visibility
only — never fingerprinted, never a gate.

**⚠ NOT YET MEASURED.** The N=1-vs-N=8 contention measurement (CONCURRENCY-SPEC §8)
has not been run — whether the load-fragile in-gate timers (`pregate.ts:563` 250 ms,
`core.spec.ts:54` 1.5 s, `gates-13-16.test.ts:372` 6 s) fire more often under load.
"Verified concurrency safety" is not yet a measured claim.

### Hard-won notes (charted from the concurrency workstream)

- **run_id is triple-overloaded** — control-plane ledger uuid (`run-ledger.mjs:34`,
  in-memory only) · harness live-stream `run_label` = `cumulative-{seq:04d}-{arm}-{model}`
  (`scripts/run_cumulative/runner.py:878`) · harness `manifest.run_id` = manifest
  parent-dir basename (`scripts/run_cumulative/runner.py:516`). Durable feed identity is
  `(run_dir, sequence_index)`; `run_id` is live-only.
- **serve fields are HEAD-only** — `serve_host_port`/`serve_url` live only in the
  `cell.start` record at the HEAD of `live.jsonl`; the tail readers (`backend-feed.mjs`
  256 KB, `live-stream.mjs` 512 KB) miss them on long streams. Read via
  `runstate.mjs::cellServeUrl` (head-anchored), never the tail.
- **checkpoint-clobber** — a cell with explicit `--sequence-index` rewrites the whole
  manifest on every checkpoint (`sequencer.py:323-325`), so a control-plane bump of
  `current_index` in a shared manifest is clobbered; the sequence cursor must stay
  in-memory/sidecar.
- **assembleBatch wipes selection** — `batch.mjs` `assembleBatch` sets `selection: null`
  and `assembleBatchForCells` writes it unconditionally; callers must `readBatch` first
  and assemble only when absent (`baselines.mjs` does).
- **`baselines.mjs` `int()` null→0** — folding nullable telemetry through bare `int()`
  fabricates 0 for "not measured"; use the `measuredInt` guard.
- **`session_records: []` before population** — the manifest hits disk empty
  (`manifest.py:224`) before the sequencer fills it; a JS mirror of the index bound must
  treat `[]` as absent (Python truthiness).
- **cellDirForRun is `/^memory/i`-only** (`runstate.mjs:258`) — pre-arm-layout `sessions/`
  cells are unresolvable and keyed reads yield empty, even though `runstate.mjs:132`
  recognizes `sessions/` in its run-dir regex (the two disagree in one file).
- **gate PROGRESS ↔ sequence_index link is the `-sNNNN.log` filename** — the cell dir
  holds `live.jsonl`, not the `step=gate-` text `readGateActivity` parses; keyed gate
  reads depend on the launch-log `-sNNNN.log` suffix.
- **BENCH_RUNS_DIR two roots** — the live run root can be redirected by `BENCH_RUNS_DIR`
  (`runner.py:473/592`); `Learning-Index/runs/active-tree.json` can point at an empty
  tree while a cell runs elsewhere. Read the live root from the env, never `runs/` directly.
- **rundelete's live-tree guard is a global boolean** (`rundelete.mjs:185`, fed by
  `routes/tree.mjs:313/331`) — deliberately not per-model (deleting a live tree is a global
  act); its only test calls `planRunDelete` directly (no route-level test).
- **wall_seconds spans grading** (`runner.py:829`→`:1350`→`:1966`) — a combined
  GPU+CPU-contention number, not inference time.
- **"REQ-RESPONSIVE/*" is a whole-file runner-deadline stall check**
  (`grader/lib/stall.mjs:26-53`, threshold `grader/report.mjs:290`), not a per-gate latency
  assertion — and the grader container is launched in `harness/grader_run.py::gate_argv`,
  not `harness/grader_image.py` (which only builds/digests).
- **agent-events sink has no per-run identity on the write side** — the `pending` buffer
  (`agent-events.mjs:75`) chooses its destination at flush time via `getRunDir()`, so its
  "not mis-filed" guarantee holds only with one live run; the read side gained `session_id`
  filtering but the per-cell event ring is deferred.
- **"roster" names three unrelated things** — `grader/roster.mjs` (gate enumeration), the
  control-plane model roster (`control/roster.mjs`), and the run arm/mode (`arm` on/off in
  `control/lib/validate.mjs`). Name the file when citing "roster".
