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
| Control plane | `control/` | Node stdlib-only `server.mjs`, loopback :8718 — the only process that reads run files (`control/board/sources/`) or changes anything; assembles and pushes the board, spawns the harness, N concurrent cells at a time, each tracked in a durable launch record (`cell-registry.mjs`, §9). Plays a selected cell's game (loopback-bound, §10) and serves per-attempt screenshots (`routes/screenshot.mjs`, §10). |
| Dashboard | `dashboard/` | Container at :8717: serves the board page and relays `/api/*` to the control plane (`lib/control-relay.mjs`, incl. a binary passthrough for `/api/screenshot`); holds no run data. Renders the LIVE BUILD reconciliation panel (`panels/build.js`, §10). Optional LAN publish (`docker-compose.lan.yml`) with a peer check (`lib/net-policy.mjs`). |
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
read-only. Every cell it spawns is written at launch as a durable launch
record (`runs/<treeId>/launches/<run_id>.json`, §9), so a control-plane restart
re-adopts running cells instead of losing their pids. The board (`:8717`) is a
separate, read-only viewer.

## 4. Memory story — OFF vs ON

opencode IS the socket: the benchmark defines NO memory-system interface, NO
registry, and NO adapter. The integration surface is ONE "which plugin" pointer
plus a few run-time settings a memory system with a server needs
(docs/memory-systems.md).

- **Schedule** (`harness/cumulative/ordering.py`): a full OFF baseline in roster
  order, then a seeded ON schedule. Every model is its own control.
- **One image, both arms.** The memory plugin (`BENCH_PLUGIN_DIR`, any opencode
  plugin package) is baked into the worker image at `/opt/bench-plugin`
  (`images/worker/Dockerfile`); both arms run on that same image, and both start
  from the same worktree.
- **OFF arm.** The cell's opencode config lists no memory plugin, and the cell
  gets no memory route and no memory settings, so nothing is captured or
  recalled. The per-model floor the ON arm is measured against — and since
  2026-09-22 that floor is **not one run**: it is the operator's chosen run out
  of an N-cell batch, reported as the **median problem count over scored runs**
  (see §8).
- **ON arm.** The cell's opencode config lists the baked plugin; the cell gets a
  route to the memory system's server through its egress sidecar
  (`BENCH_MEMORY_UPSTREAM`) and the plugin's own settings (`BENCH_MEMORY_ENV`).
  Around the cell, outside its wall time, the harness waits for the memory system
  to finish its background work and reads its running cost
  (`BENCH_MEMORY_READY_CMD`, `BENCH_MEMORY_COST_CMD`). The OFF/ON toggle
  (`memory_mode` off/on) is the only memory-mode distinction.
- **The harness reinjects nothing.** Capture, recall, and reinjection belong to
  the plugin; the benchmark only schedules the arms and measures the Δ, from
  outside the memory system (each cell's `memory.json`).

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
by the end-of-run capture (`_capture_end_of_run_snapshot`, at the attempt ceiling
or out of context, seeded or fresh), never the attempt-1 capture — so a baseline
that passed reports null even though its build snapshot exists on disk. It is the
durable link the run-delete path consumes, and the snapshot continuous mode
chains from (`control/continuous.mjs`, RUNBOOK §19).

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

**N-concurrent control plane.** `control/run-ledger.mjs` (the in-memory live-cell
cache over the durable cell registry — see §9), `readRunState` returns `runs[]`,
launch is gated **per model** (`inFlightModels` in `run-ledger.mjs`, consumed by
`lib/validate.mjs:65`), and `allocateSequenceIndex` is atomic. `/api/run/start`
accepts `concurrency` N (default 1) and pre-flights all N before spawning.

**Batch baseline.** `control/batch.mjs` computes the median of scored runs (voids
excluded, never counted as failures) over a fingerprint of 8 inputs (build prompts,
grader, model, challenge, compaction, scaffold, golden, worker image); the operator
picks the artifact run and the record stores its signed deviation from the median.
`control/baselines.mjs` no longer picks `scorable[length-1]`.

**`chunk_plan_hash` hashes the WHOLE prompts tree, not the build steps.** The
"build prompts" fingerprint input is `chunk_plan_hash` = `dir_hash(task_dir / "prompts")`
(`harness/fingerprint.py:75`); `dir_hash` walks every regular file recursively
(`harness/fingerprint.py:41-60`, no `chunk-*.md` filter). So adding or editing ANY
prompt file — a repair opener, a nudge, a `failures/` line — silently moves
`chunk_plan_hash` for the whole tree, and a pinned batch/campaign is voided as
superseded naming `chunk_plan_hash` (`control/baselines.mjs:550-555`). Before
touching a prompt file, check whether a live campaign or OFF baseline is pinned to it.

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

- **run_id is triple-overloaded** — control-plane launch-record id, now DURABLE
  (it names the launch record `runs/<treeId>/launches/<run_id>.json`,
  `cell-registry.mjs:60-62`) · harness live-stream `run_label` =
  `cumulative-{seq:04d}-{arm}-{model}` (`scripts/run_cumulative/runner.py:878`) ·
  harness `manifest.run_id` = manifest parent-dir basename
  (`scripts/run_cumulative/runner.py:516`). Durable feed identity is still
  `(run_dir, sequence_index)` (the per-cell key that survives a restart); `run_id`
  is durable too — the record's filename.
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
- **cellDirForRun is `/^memory/i`-only** (`runstate.mjs:307`) — pre-arm-layout `sessions/`
  cells are unresolvable and keyed reads yield empty, even though `runstate.mjs:180`
  (`runDirOf`) recognizes `sessions/` in its run-dir regex (the two disagree in one file).
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

## 9. Durable cell registry (2026-09-23)

Commit `859e492` (`feat(control): durable cell registry — launch records + ledger cache +
process-scan enumeration`). The control plane's knowledge of cells no longer comes from
launch-log files — it comes from durable per-cell launch records. A launch log is now
diagnostics only: it can be deleted, and the cell stays visible and stoppable.

**Launch records.** One JSON per launched cell at
`runs/<treeId>/launches/<run_id>.json` (flat fallback `runs/launches/` for a non-tree
run_dir), written atomically (tmp+rename) by the control plane at spawn INTO THE ACTIVE
TREE, so a RESET archives them with the tree (`tree.mjs` `isBenchmarkData("launches")` →
true). Nothing ever deletes a record. Schema: `run_id, sequence_index, model, arm, kind,
org, context, manifest_arg, pid, started_at, log_path, run_dir, finished, terminal_status,
terminal_ok, ended{at, code, signal, reason, log_tail}` (`control/cell-registry.mjs`).

**Ledger-as-cache.** `control/run-ledger.mjs` is now a LIVE-ONLY CACHE: the Map holds only
`finished === false` records, hydrated at startup (`initLedger`, called first from
`state.mjs` `initState`) and written through to disk on every change. A finished/ended cell
lives on disk, not in memory — that is the bound on the module's state.
`markRunFinished`/`unregisterRun` are gone, replaced by
`recordCellEnded(runId, runDir, {reason,…})`, which durably merges the end and evicts the
cache slot. `evictRun` is a pure cache delete.

**Every exit recorded.** `routes/run.mjs` attaches `child.on("exit")` between spawn and
`unref`, capturing code/signal/log-tail → `recordCellEnded`. A startup death records
`"startup failed"`. A record whose pid is gone with no observed exit reconciles to
`ended "exit not observed"` (`runstate.mjs`); a failed `ps` scan ends nothing
(indeterminate). A vanishing log NEVER ends a record.

**Enumeration = records + process scan.** `readRunState` (`runstate.mjs`) enumerates from
the durable records — the live set via `liveRuns()` (the cache) and the ended set via
`listRecords()` (disk) — plus ONE `ps` scan (`findHarnessProcs`). The scan recovers a
cell's address from its argv (`--manifest <campaign>/manifest.json`,
`--sequence-index N`) via `parseHarnessArgv`; only a `run_cumulative.py` command line
counts as a harness (the pid-reuse guard). Liveness = pid-in-scan, plus the PER-CELL
heartbeat (`cellHeartbeatAge`, the cell's own `live.jsonl`) — never a run_dir-wide mtime
proxy.

**STOP from the same enumeration.** `stopAll`/`planStop` (`lib/lifecycle.mjs`) plan from
`readRunState`; a stopped cell is recorded `ended "stopped by operator"` (signal SIGINT),
NEVER deleted. `sweepDocker` derives container names from the run's own launch log; with
no log it derives nothing and sweeps nothing (it never guesses).

**Cleanup folded in.** `run-ledger` evict-on-finish bounds the Map; the SIGKILLed-harness
wedge (a log+run_dir with `finished:false` blocking its model via `lib/validate.mjs:65`
`inFlightModels`) is fixed by process reconciliation; `backend-feed.mjs` `errorScans` is
FIFO-capped at 256 paths.

**Live-verified 2026-09-23.** Broken tree archived; N=2 cells survived launch-log deletion +
a control-plane restart and stayed `live_count:2`; STOP then cleaned them (zero leftover
containers/volumes) with both recorded ended-not-dropped.

### Hard-won (live reproduction)

- **Model slug resolution** — bench slugs resolve against the LIVE proxy catalog
  (`Local LLM Proxy/config/models.yaml`, `GET :4545/v1/models`), never in-repo mirrors
  (the `bench/` mirror's `roster.mjs`/`config.py` lag and omit aliases).
- **Two-step API** — launch/stop/reset are all `POST /api/*/preview` (mints a `token`)
  then `POST /api/*` with `{"confirm": token}`.
- **Launch-log location** — the `.log` and its `.log.notices.jsonl` sidecar live at the
  RUN-TREE ROOT (`runs/<tree>/off-cell-<stamp>-s<NNNN>.log`), keyed off the record's
  `log_path`; NOT inside `run_dir`.
- **Module rename** — the design report cited `control/launches.mjs`; the committed module
  is `control/cell-registry.mjs` (same module, renamed).

## 10. Dashboard reconciliation view + play/screenshot serving (2026-10-02)

Landed as three commits (`91ceeb1`/`7304e7a`/`7d765fe`, pushed to `origin/main`).

**Reconciliation view.** The dashboard top is now TRANSFER CURVE (left) + LIVE
BUILD panel (right) in `.axes-row` (`minmax(0,1fr) minmax(0,1.25fr)`), with the
GATE WALL moved to a full-width block below them. LIVE BUILD
(`dashboard/panels/build.js`) shows a `data-preserve` sandboxed iframe of the
played game (lazy-boot via `POST /api/play/start`) plus the numbered "user prose"
feedback (`GET /api/feedback?run_dir=<arm-level>`), with attempt-snapshot tabs
`1..max_attempts` + `live` that swap the viewport to `GET /api/screenshot`.

**Play-able pair.** Every `board.runs` card now carries `benchmark_id` + `cell`
(cell-level path) alongside `run_dir`/`sequence_index` (15 keys), so the
dashboard can `POST /api/play/start {run, cell}` straight from a card. Archived
rows carry `benchmark_id:"backups"` (a literal — never the inner `tree_id`).

**Play-server hardening.** The untrusted app hardcodes `server.listen(PORT)` (no
host, reads only `PORT`), so there is no env/arg lever; the control plane
preloads `control/lib/loopback-shim.mjs` via `node --import`, which patches
`net.Server.prototype.listen` to splice `"127.0.0.1"` into host-less
`listen(port[, cb])` calls. The play server is now loopback-bound — supersedes
the prior "binds all interfaces" posture (see SECURITY.md).

**Per-attempt screenshots.** The grader captures a non-gating viewport PNG once
per graded attempt (`attempt-<N>-board.png`, 1280×800, best-effort — absent is
normal) into the cell dir. New `GET
/api/screenshot?run_dir=&sequence_index=&attempt=<N>` streams it as `image/png`
(`no-store`), 404 JSON on absence (no fallback), attempt bound 1..10.
`board.max_attempts` is exposed as a top-level constant (5).

**Three "serve/view" things — do not conflate.** `serve_url`/`serve_host_port` =
the cell's opencode AGENT attach endpoint (`opencode attach`); `POST
/api/play/start`'s `url` = the built backgammon app on a fresh free OS port;
`GET /api/run-view` = the per-cell DATA view (JSON, not an app). Only the play
registry (`runs/servers/<pid>.json` → `GET /api/play`) holds a real app URL.
None is an iframe embed; the LIVE BUILD panel's iframe is the one embed, and it
points at the play `url`.

### Hard-won (charted from the reconciliation workstream)

- **Live data is per-cell only.** `board.by_cell["<run_dir>::<seq>"].live` is the
  only populated live source; top-level `board.live` (`contract.mjs`) is an
  always-empty default no board-wide source populates. Panels must read
  `view.live` (client overlay) or `board.by_cell[key].live` — never `board.live`.
- **`attempt.end` carries `told`/`withheld`/`unevaluated`** (plus `failed`,
  `stage`, `stage_name`, `verdict`, `conformed`, `context_peak`,
  `context_window`; `runner.py:1647-1664`) but the board's live-stream source
  maps only `verdict`/`failed`/`stage`/`stage_name`/`withheld`
  (`live-stream.mjs:141-155`) — `told` and `unevaluated` exist only in raw
  `live.jsonl` / `manifest.status.jsonl`. (`told` is emitted directly, NOT
  derived: `failed` counts failing checks, `told` counts checks shown to the
  model.)
- **`max_attempts` is not persisted per-run.** Env-only (`BENCH_MAX_ATTEMPTS`,
  default 5, hard ceiling 10, `harness/config.py:213` / `constants.py:311`); no
  writer puts `RunConfig.to_dict()` in the run tree, so the board exposes a
  constant 5. A per-run value needs a harness write.
- **`cellDirForRun` does no containment** (`runstate.mjs:285` joins `runsRoot` +
  `runDir` directly). Pair it with `resolveRunDir` (`wall.mjs:41-56`) first —
  never call `cellDirForRun` on raw wire input (path-traversal).
- **Two parallel control planes.** Learning-Index `:8718` (live) vs the stale
  `bench/` fork on `:7718` (dashboard `:7717`). Resolve endpoints by port;
  `bench/` is not the live line.
- **`GET /api/wall` / `GET /api/feedback` with no `?run_dir=`** fall back to
  `DEFAULT_RUN_DIR="cumulative"` (`wall.mjs:34`) when no cell is live — a dir
  that does not exist — so they report the enumerated suite with zero outcomes /
  `unwired:["user-events"]`. Always pass the arm-level `run_dir` +
  `sequence_index`.
