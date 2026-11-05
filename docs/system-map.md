# System map — bench

Condensed from the benchmark's full system inventory, remapped to the current
layout (`harness/`, `task/`, `grader/`, `images/`) and neutral naming. Full depth
lives in `RUNBOOK.md`, `ENV-VARS.md`, `LIVE-STREAM.md`, and the grader's own
docs.

---

## 1. What the benchmark is

`bench` measures whether a pluggable memory layer mitigates an LLM's
degradation. It runs one task — build a working backgammon game — repeatedly. A
**memory OFF** baseline builds from a stripped scaffold; a **memory ON** run is
the same task with what the memory layer captured on earlier runs re-injected. The measured
question: does re-injected memory reduce context growth, turn count, and gate
failures? The game is only the instrument; the subject under test is the memory
system.

## 2. Components

| Component | Path | Role |
|---|---|---|
| Harness | `harness/` | The Python measuring instrument: campaign sequencer + manifest, task adapters, scoring/scorecard, cell isolation, egress, image identity, blinding. |
| Task | `task/backgammon/` | The instrument's task: `scaffold/` (stubs the model builds from), `golden/` (reference solution, never shown), `prompts/` (chunked build prompts). |
| Grader | `grader/` | `report.mjs` + the gate suite (conformance / backend / frontend, plus `meta/` and `quarantine/`). The only component that sees the golden. |
| Control plane | `control/` | Node stdlib-only `server.mjs`, loopback :8718 — the only process that reads run files (`control/board/sources/`) or changes anything; assembles and pushes the board, spawns the harness — one cell per click, with a serial gate PER MODEL (§8) — each cell tracked in a durable launch record (`cell-registry.mjs`, §9). Plays a selected cell's game (loopback-bound, §10) and serves per-attempt screenshots (`routes/screenshot.mjs`, §10). |
| Dashboard | `dashboard/` | Container at :8717: serves the board page and relays `/api/*` to the control plane (`lib/control-relay.mjs`, incl. a binary passthrough for `/api/screenshot`); holds no run data. Renders the LIVE BUILD reconciliation panel (`panels/build.js`, §10). Optional LAN publish (`docker-compose.lan.yml`) with a peer check (`lib/net-policy.mjs`). |
| Images | `images/` | `worker/Dockerfile`, `grader/Dockerfile`, `sidecar/` (egress + loop-kill scanner + supervised shell). |
| Scripts | `scripts/` | Entrypoints: `run_cumulative.py` (canonical), `rebuild_worker_image.py`, `rebuild_grader_image.py`, `bench_preflight.py`. |
| Config | `config/` | `bench.env`; the bench-owned env surface is documented in `ENV-VARS.md`. |
| Tests | `tests/` | The harness's own pytest suite — grades the instrument, never the candidate. |

## 3. Run story

1. **Campaign (durable).** `scripts/run_cumulative.py` builds a
   `CumulativeSequencer` over a `CumulativeManifest`
   (`harness/cumulative/manifest.py:51`) — task, org, roster, config fingerprint,
   the append log (`schedule`, one entry per clicked cell, never precomputed) and
   the session records.
2. **Cell (executed).** One appended cell, driven once. The sequencer phase
   machine runs `PREPARE_FIXTURE → RUN_SESSION → DONE` (`HALTED_ON_GATE` on a
   gate failure). The worker container builds the task in chunks over ONE
   opencode serve session (`harness/adapters/challenge/serve.py`, §7).
3. **Grading.** `harness/grader_run.py` runs the candidate's worktree through
   `bench-grader:<challenge>` (the challenge's gate suite, `ENTRYPOINT ["node", "report.mjs"]`), read-only
   and `--network none`, producing `report.json` (verdict, problems, failed
   gates).
4. **Scorecard.** `run_artifacts.build_scorecard` aggregates the write-once
   manifest + append-only status stream into `manifest.scorecard.json` per cell.

The **control plane** (`control/server.mjs`, binds 127.0.0.1:8718, no shell, one
cell per click) spawns the entrypoint
`.venv/bin/python scripts/run_cumulative.py run --mode <arm>` and observes
read-only. A second cell for the SAME model is refused while the first is in
flight (`lib/validate.mjs:62`, the serial gate of §8); a cell on a different
model may run alongside it. Every cell it spawns is written at launch as a durable launch
record (`runs/<treeId>/launches/<run_id>.json`, §9), so a control-plane restart
re-adopts running cells instead of losing their pids. The board (`:8717`) is a
separate, read-only viewer.

## 4. Memory story — OFF vs ON

opencode IS the socket: the benchmark defines NO memory-system interface, NO
registry, and NO adapter. The integration surface is ONE "which plugin" pointer
plus a few run-time settings a memory system with a server needs
(docs/memory-systems.md).

- **One click, one cell** (`harness/cumulative/ordering.py` `append_session`): one
  click appends ONE cell, in the arm picked on the click. Nothing is precomputed —
  a cell's identity is its own (arm, model, config fingerprint), never a position
  in a planned schedule. Every model is its own control.
- **One image, both arms.** The memory plugin (`BENCH_PLUGIN_DIR`, any opencode
  plugin package) is baked into the worker image at `/opt/bench-plugin`
  (`images/worker/Dockerfile`); both arms run on that same image, and both start
  from the same worktree.
- **OFF arm.** The arm is picked on the click, and that run has no memory at all:
  its opencode config lists no memory plugin, and the cell gets no memory route
  and no memory settings, so nothing is captured or recalled. Every completed,
  non-void OFF cell is one more baseline for its fingerprint, and the floor the
  ON arm is measured against is the **average** over every baseline sharing that
  fingerprint (§8) — never one picked run, never a median of a chosen batch.
- **ON arm.** The cell's opencode config lists the baked plugin; the cell gets a
  route to the memory system's server through its egress sidecar
  (`BENCH_MEMORY_UPSTREAM`) and the plugin's own settings (`BENCH_MEMORY_ENV`).
  Around the cell, outside its wall time, the harness waits for the memory system
  to finish its background work and reads its running cost
  (`BENCH_MEMORY_READY_CMD`, `BENCH_MEMORY_COST_CMD`). The OFF/ON toggle
  (`memory_mode` off/on) is the only memory-mode distinction.
- **The harness reinjects nothing.** Capture, recall, and reinjection belong to
  the plugin; the benchmark only runs the arms and measures the Δ, from
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
3. **Full tooling.** `images/worker/Dockerfile`: Node 22.23.4, opencode + SDK,
   Playwright 1.64.1 + Chromium, git / ca-certificates / procps / curl. Only the
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

## 7. What one run is

**One click on Run is one run.** The control plane spawns the harness for one
cell, the harness appends exactly one cell to the campaign's log
(`append_session`, `harness/cumulative/ordering.py:34`), and that cell is ONE
opencode session from first prompt to last grade: every build chunk and every
repair round drives the same `session_id` (`runner.py:2451`), so nothing restarts
the model's history halfway.

**The build is five chunk prompts inside that one session.**
`task/backgammon/prompts/chunk-01..05.md` are driven one per user message, in
order (`serve.py:1293`); with compaction on for the run the harness compacts the
session once at each chunk boundary (`serve.py:1361` `_compact_after_chunk`), so
the next chunk's prompt goes into the compacted session.

**A chunk is over when the session goes idle.** That is the transport's verdict,
not the model's: a drive returns when the session goes IDLE, and a non-zero exit
ends the whole build there with every later chunk reported `not_reached`
(`serve.py:1182`, `:1331`). Nothing the model writes is read for a boundary: the
old marker string was a self-report standing in for an event the transport
already reports, and it is gone from the prompts and the harness alike
(`serve.py:1187-1191`).

**Troubleshooting runs in that same session, uncapped.** After the build the
session is graded; while checks fail the harness sends ONE feedback message per
round and grades again — `for attempt in itertools.count(1)`
(`runner.py:1333`) — with no round cap and no time cap, until every check passes.
opencode's own auto-compaction stays on at its vanilla default in this phase; the
harness fires no compaction of its own here.

| Phase | Who compacts | Caps |
|---|---|---|
| build | the harness, once per chunk boundary (`serve.py:1361`) | none — five prompts are the plan, not a limit |
| troubleshooting | opencode auto-compaction, vanilla default | none (`runner.py:1333`) |

**One abort does end a run: two compactions before one grade.** In troubleshooting
only, `compactions_since_grade >= 2` ends the cell as `compactions_before_grade`
(`runner.py:2010`, constant `:160`): one compaction is a repair round rebuilding
its context and carrying on, two with no grade between them is a round rewriting
context instead of code. `cost.json` stamps that outcome `aborted_compaction`
(`scripts/run_cumulative/runner.py:241`).

**Endings are recorded by name.** `gates_green` is a pass; `context_exhausted` is
a real ending — the session grew past what the model could compact at all
(`runner.py:2042`) — and it is never repaired by starting a second session on a
saved copy of the code. A dead worker, an instrument fault and an operator stop
end a cell too, each on its own name.

**Dev mode pauses; normal mode never does.** `control/devmode.mjs` resolves the
control plane's own mode (environment → state file → off) and the route passes
`--pause-after-grade` when it is on (`routes/run.mjs:220`); the harness then holds
after every graded round and once at run end (`runner.py:1902`, `:2081`), booting
the artifact in the grader image so a person can play what the grader judged and
read the lines the model is about to be told. Release is operator-explicit:
`touch <run_dir>/RELEASE_HOLD` (`constants.py:110-114`). Paused seconds are
excluded from wall time and recorded beside it (`paused_seconds`,
`runner.py:2264`).

**Stopping a run keeps its tree.** The launch record is ended `stopped by
operator` and the run stays on disk with its `cost.json`; what disappears is the
preview, because the play container is removed and the live-build loop feeding it
stops with the run (`control/livebuild.mjs:38-46`). A build a person started by
hand is left alone.

**Cell identity and the live-view port.** A 12-hex `run_identity` (uuid4, once
per process, `scripts/run_cumulative/__init__.py:436`) suffixes the worker
container (`bench-cell-{label}-{run_identity}`, `runner.py:944`) and keys the
session-DB volume, the egress sidecar (`okp-egress-{sha256(...)[:12]}`,
`harness/egress.py:62`) and the grader container
(`bench-grade-{run_identity}-{cell}-{stem}`, `harness/grader_run.py:81`); the
reaper filter is anchored, never a substring sweep. Each cell's live-view serve
gets its own free host port (`harness/free_port.py:30`), which rides the
`cell.start` record and is surfaced by the board; the fixed `:8719` is retired.

## 8. Baselines, fingerprint and cost

**Every click is one more baseline; the floor is an average.** `control/baselines.mjs`
is the one owner of "does model X have a baseline, and what it cost": every
completed, non-void OFF cell is one baseline for its fingerprint, and the numbers
an ON cell is measured against are the AVERAGE over every baseline sharing that
fingerprint (`fingerprintBaselines`, `control/baselines.mjs:1148`; the averaged
fields are `context_peak`, `wall_seconds`, `turns` and the five token kinds,
`:1114-1123`). A field absent in every cell averages to null, never 0, and a void
cell (it measured the harness, not the model) is no baseline — that verdict is the
harness's own `cost.json` `void.is_void` stamp. No run is picked: the newest
completed OFF cell only names the row on the card (`:929-940`), and choosing one
cell WAS the old measuring method.

**A cell's fingerprint has 14 inputs, recorded at the cell when it starts.**
`control/batch.mjs:44` `FINGERPRINT_INPUTS` is the contract — prompts tree,
grader, model, challenge, compaction, scaffold, golden, worker image, then the
harness code, source commit, dirty bit, worker source digest, opencode version and
grader image — and `harness/fingerprint.py:104` writes `fingerprint.json` beside
the cell's live stream. An input nobody could read is ABSENT, never a placeholder,
so a later change to it reads "not recorded" rather than as a match.

**`chunk_plan_hash` hashes the WHOLE prompts tree, not the build steps.** The
"build prompts" input is `chunk_plan_hash` = `dir_hash(task_dir / "prompts")`
(`harness/fingerprint.py:41-60`, no `chunk-*.md` filter), so adding or editing ANY
prompt file — a repair opener, a nudge, a `failures/` line — moves the hash for
the whole tree and voids a batch recorded on the old one as superseded, naming
`chunk_plan_hash` (`verifyAgainstCurrentCode`, `control/baselines.mjs:772-788`).
Before touching a prompt file, check what is pinned to it.

**`cost.json` prices every exit, in two phases.** `scripts/run_cumulative/runner.py:246`
`_cost_record` writes it on EVERY exit — passed, failed, stopped, aborted,
crashed — because the cells that burn spend without producing a measurement are
exactly the ones an operator needs priced.

| Key | What it carries |
|---|---|
| `build`, `troubleshooting` | tokens by kind (`input`, `output`, `reasoning`, `cache_read`, `cache_write`), `turns`, `compactions`, `grades` (`total`/`passed`/`failed`), `wall_seconds` minus paused, `context_peak` |
| `total` | additive fields summed, `context_peak` maxed, `grades` merged — never a fabricated zero |
| `outcome`, `paused_seconds`, `void` | how the cell ended, operator-pause time, the instrument verdict |

**Tokens are the cost of every cell; dollars exist only for cloud models.**
`cost_usd` rides each phase and `total`, and is ABSENT (never `0.0`) on a local
model, where spend is not a property of the run; `total.cost_usd` is emitted only
when every observed phase carries it, since a sum across a priced and an unpriced
phase is neither (`_total_phase`, `scripts/run_cumulative/runner.py:179-207`).

**The serial gate is per model.** `inFlightModels()` (the live-cell ledger, §9)
feeds `lib/validate.mjs:62`: a second start for a model already in flight is
refused `run_in_flight` — "this model is serial" — while another model may be in
flight beside it. One click launches exactly ONE cell; `/api/run/start` reads no
cell count and has no batch to pre-flight (`routes/run.mjs`).

### Hard-won notes (charted from the control-plane workstream)

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
- **contention covariates are visibility, never a gate** — the six that ride records
  (`http_429_count`, `http_402_count`, `retry_count`, `upstream_error_count`,
  `max_request_ms`, `median_request_ms`, `harness/cumulative/progress.py:91-105`)
  are never fingerprinted and never scored on.
- **`baselines.mjs` `int()` null→0** — folding nullable telemetry through bare `int()`
  fabricates 0 for "not measured"; use the `measuredInt` guard.
- **`session_records: []` before population** — the manifest hits disk empty
  (`manifest.py:224`) before the sequencer fills it; a JS mirror of the index bound must
  treat `[]` as absent (Python truthiness).
- **cellDirForRun is `/^memory/i`-only** (`runstate.mjs:291`) — pre-arm-layout `sessions/`
  cells are unresolvable and keyed reads yield empty, even though `runstate.mjs:164`
  (`runDirOf`, defined `:159`) recognizes `sessions/` in its run-dir regex (the two
  disagree in one file).
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
cell's run dir from its argv (`--manifest <campaign>/manifest.json`) via
`parseHarnessArgv`, which returns `sequence_index: null` by design — the harness
assigns it at append, so it is never on the command line (`runstate.mjs:99-107`) —
and only a `run_cumulative.py` command line
counts as a harness (the pid-reuse guard). Liveness = pid-in-scan, plus the PER-CELL
heartbeat (`cellHeartbeatAge`, the cell's own `live.jsonl`) — never a run_dir-wide mtime
proxy.

**STOP from the same enumeration.** `stopAll`/`planStop` (`lib/lifecycle.mjs`) plan from
`readRunState`; a stopped cell is recorded `ended "stopped by operator"` (signal SIGINT),
NEVER deleted. `sweepDocker` derives container names from the run's own launch log; with
no log it derives nothing and sweeps nothing (it never guesses).

**Cleanup folded in.** `run-ledger` evict-on-finish bounds the Map; the SIGKILLed-harness
wedge (a log+run_dir with `finished:false` blocking its model via `lib/validate.mjs:62`
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
feedback (`GET /api/feedback?run_dir=<arm-level>`), with an attempt tab per
attempt the run actually reports (`observedAttempts`, `dashboard/panels/build.js:287-295`
— never a configured cap) plus `live`; a numbered tab swaps the viewport to
`GET /api/screenshot`, `live` frames the running play app.

**Play-able pair.** Every `board.runs` card now carries `benchmark_id` + `cell`
(cell-level path) alongside `run_dir`/`sequence_index` (15 keys), so the
dashboard can `POST /api/play/start {run, cell}` straight from a card. Archived
rows carry `benchmark_id:"backups"` (a literal — never the inner `tree_id`).

**Play containment.** The untrusted app never runs on the host. Play, the live
build's auto-play and the hold-review OPEN all go through `harness/play_container.py`
(the control plane calls its CLI): the candidate runs in the grader image as uid
1000 on a per-session `--internal` network (no internet, no host gateway), with a
read-only worktree copied into tmpfs, no host env, files or Docker socket, caps
dropped and a 6 h lifetime; a forwarder container publishes `127.0.0.1:<port>`
only. Supersedes the host spawn with `loopback-shim.mjs` (removed 2026-10-23).

**Play containers are named per (run, cell).** The session identity is
`<run>::<cell>` (`control/play.mjs:227`), hashed into every container and network
name (`harness/play_container.py:104-117`), so two runs can never share one;
`reap` finds them by the `okp.play=1` label and `except_names` protects the
sessions still running (`:594-603`). Starting a build reaps every other one, and a
finished run's build is stopped by the live-build loop that started it
(`control/livebuild.mjs:38-46`) — which is why a stopped run's preview vanishes
while its tree stays.

**Per-attempt screenshots.** The grader captures a non-gating viewport PNG once
per graded attempt (`attempt-<N>-board.png`, 1280×800, best-effort — absent is
normal) into the cell dir. `GET
/api/screenshot?run_dir=&sequence_index=&attempt=<N>` streams it as `image/png`
(`no-store`), 404 JSON on absence (no fallback), and any attempt int ≥ 1 is
accepted — there is no round maximum (`control/routes/screenshot.mjs:12`).
`board.max_attempts` is a top-level constant that is **null**: no cap, and
consumers derive the observed count (`control/board/contract.mjs:27`).

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
- **`attempt.end` carries more than the board renders.** The producer emits
  `told`/`withheld`/`unevaluated` plus `failed`, `stage`, `stage_name`, `verdict`,
  `conformed`, `render_blocked`, `context_peak`, `context_window`
  (`runner.py:1563-1580`); the board's live-stream source maps the verdict, the
  stage, `withheld`/`told`/`unevaluated` and `render_blocked`
  (`live-stream.mjs:148-162`), and leaves `conformed`, `context_peak` and
  `context_window` to raw `live.jsonl` / `manifest.status.jsonl`. (`told` is
  emitted directly, NOT derived: `failed` counts failing checks, `told` counts
  checks shown to the model.)
- **`max_attempts` is null, not a number.** There is no attempt cap and no env
  knob for one: the board's `max_attempts` is a null constant
  (`control/board/contract.mjs:27`) and every
  consumer derives the observed count from the run's own attempts
  (`dashboard/panels/build.js:287-295`; the harness states `max_attempts=None`
  on the pause events, `runner.py:2376`). A reader that treats
  null as a number invents a cap the run never had.
- **`cellDirForRun` does no containment** (`runstate.mjs:287` joins `runsRoot` +
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
