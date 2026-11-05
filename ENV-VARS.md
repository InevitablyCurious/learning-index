# ENV-VARS.md — bench

Every env var on this repo's config surface, each row carrying the `file:line` that actually reads
it. Two directions are enforced: every row here has a reader, and every env var this repo reads has
a row. Counts below are counted from the tables in this file, never carried over from a previous
revision.

A **reader** is a line that consumes the variable — `os.environ[...]`, `os.environ.get(...)`,
`os.getenv(...)`, `process.env.X`, `env["X"]`, or a name resolved through a module constant
(`ENV_X = "X"` → `env.get(ENV_X)`) — resolved by hand, because a literal grep undercounts those.
Test fixtures and hard-coded task templates count as in-repo readers; a bare `grep` hit in prose,
a comment, or a `.md` does not.

Buckets:
- **read here** — a reader inside this repo. Split by whether the var is also described in another
  doc in this repo (RUNBOOK.md, docs/, LIVE-STREAM.md, CUSTOM-TOOLS.md, a component README).
- **external contract** — no reader in this repo; the reader is named, and is another TOKProject
  component (hub / client / dashboard / leader-signer) or a runtime (opencode, node, npm, apt,
  playwright). Vars in this bucket that this repo *sets* name the setter too.
- **dead** — documented here with no reader anywhere. Zero rows (see "Removed in this pass" for the
  names that were deleted and the evidence).

## Summary

| Bucket | Count |
|---|---|
| Read in this repo — documented elsewhere in this repo | 23 |
| Read in this repo — documented only here | 58 |
| **Total read in this repo** | **81** |
| External contract — read outside this repo | 36 |
| Documented here with no reader anywhere (dead) | 0 |
| **Total rows in this file** | **117** |

## Read in this repo — documented elsewhere in this repo (23)

| Name | Default | Controls | Reader |
|---|---|---|---|
| BENCH_LEADER_KEYSTORE | ~/.okp/bench/leader-keystore | leader keystore dir (org master-key envelope, shared by writer and readers) | harness/lifecycle/lconfig.py:40 |
| BENCH_LIVE_STREAM | (none) | live-stream path the harness exports and a backend joins | harness/live_stream.py:44 |
| BENCH_MCP_RECALL_URL | http://127.0.0.1:4550 | recall client endpoint | harness/config.py:231 |
| BENCH_MEMORY_COST_CMD | (none) | host command printing one JSON object of the memory system's running counters; read before and after each memory-ON cell | harness/memory_hooks.py:140 |
| BENCH_MEMORY_ENV | (none) | file of the memory plugin's own `NAME=value` settings, passed into memory-ON cells by name (values never in argv) | harness/memory_slot.py:90 |
| BENCH_MEMORY_READY_CMD | (none) | host command (`sh -c`, repo root) polled until it exits 0, so every memory-ON cell starts from memory that finished the cells before it | harness/memory_hooks.py:103 |
| BENCH_MEMORY_READY_TIMEOUT_S | 1800 | how long the ready command may keep failing before the next memory-ON cell is refused | harness/memory_hooks.py:75 |
| BENCH_MEMORY_UPSTREAM | (none) | the memory system's server as the egress sidecar reaches it (`scheme://host:port`); opens the sidecar's memory route for memory-ON cells | harness/memory_slot.py:53, images/sidecar/egress-sidecar.js:63 |
| BENCH_PLUGIN_DIR | (none) | THE one plugin pointer: absolute path to a memory plugin package baked into the worker image at /opt/bench-plugin. Unset ⇒ vanilla build, which refuses memory-ON cells | harness/worker_image.py:64 |
| BENCH_RECALL_MODE | prod | the run-context lever exported to a memory-ON cell; a measurement record, not a config this repo sets | harness/cumulative/run_context.py:74 |
| BENCH_RUNS_DIR | <bench>/runs | runs root | harness/lifecycle/lconfig.py:60 |
| BENCH_SKIP_CLEANUP | off | skip telemetry cleanup at the run entrypoint | scripts/run_cumulative/__init__.py:80 |
| BENCH_STATS_MANIFEST | (none) | run-stats manifest path (pluggable stats source) | control/runstats.mjs:387 |
| BENCH_TARGET | task/backgammon/golden | gates target dir | grader/report.mjs:83, grader/lib/harness.ts:65 |
| BENCH_TASK_DIR | task/backgammon | the challenge directory this process runs | harness/prompt_pack.py:83 |
| BENCH_TOOLS_URL | (none) | custom-tools service the board's drawer lists and runs; never consulted by preflight or a run — see CUSTOM-TOOLS.md | control/tools.mjs:26 |
| DEBUG_API | off | debug endpoints on task servers | task/backgammon/golden/src/server.ts:37 |
| LOCAL_LLM_PROXY_API_KEY | (none) | Local LLM Proxy (:4545) token — env export wins over the dotenv file | harness/spend_key.py:160 |
| OKP_DASH_ALLOWED_HOSTS | (none) | extra host names the board may be opened by, comma-separated; IPs and localhost always pass (DNS-rebinding guard) | dashboard/server.mjs:40 |
| OKP_DASH_CONTROL_URL | http://127.0.0.1:8718 | the same-origin relay's upstream control plane (always loopback) | dashboard/server.mjs:37 |
| OKP_DASH_HOST | 127.0.0.1 (image 0.0.0.0) | dashboard bind addr | dashboard/server.mjs:35 |
| OKP_DASH_PORT | 8717 | dashboard port | dashboard/server.mjs:36 |
| PORT | 8002 | port a task template's server binds; the harness adds the worker index to its base | task/backgammon/golden/src/server.ts:36 |

## Read in this repo — documented only here (58)

| Name | Default | Controls | Reader |
|---|---|---|---|
| BENCH_ALLOW_MISSING_RUN_CONTEXT | off | tolerate a missing run context instead of failing the cell | harness/cumulative/run_context.py:119 |
| BENCH_ATTEMPT | (none) | attempt number the board screenshot lands under | grader/capture/board-capture.spec.ts:39 |
| BENCH_CAPTURE_DIR | (none) | board screenshot output dir | grader/capture/board-capture.spec.ts:40 |
| BENCH_CLOUD_KEY_FILE | config/cloud.env | cloud key file (dotenv `ORCAROUTER_API_KEY=`) | harness/spend_key.py:297 |
| BENCH_DATA_DIR | <repo>/data | telemetry sink | harness/adapters/challenge/telemetry.py:166 |
| BENCH_DEV_MODE | (none) | dev-mode env pin (truthy = on, falsy = off; pinned ⇒ `settable:false`) | control/devmode.mjs:37 |
| BENCH_DEV_MODE_FILE | <bench>/config/devmode.json | dev-mode state file location | control/devmode.mjs:21 |
| BENCH_DOTENV | <bench>/.env | dotenv path override | harness/spend_key.py:100 |
| BENCH_ENV_FILE | config/bench.env | durable env file path | harness/benv.py:37 |
| BENCH_EXPLORATION_FRACTION | 0.10 | share of context spent exploring, per cell | harness/cumulative/run_context.py:63 |
| BENCH_HUB_URL | http://127.0.0.1:4440 | hub endpoint | harness/config.py:226 |
| BENCH_LAUNCHD_LABEL | (none) | the launchd job the control plane runs as; set, the board's Refresh control plane button may restart it | control/tools.mjs:36 |
| BENCH_LEADER_MCP_URL | http://127.0.0.1:4550 | leader MCP endpoint | harness/lifecycle/lconfig.py:36 |
| BENCH_LEADER_SEED_HEX | "" | leader identity seed | harness/lifecycle/lconfig.py:45 |
| BENCH_LEADER_SIGNER_DIR | <bench>/scaffold/leader-signer (STALE — the tree lives at dev/benchmark/leader-signer; the code default is stale too) | signer dir | harness/lifecycle/lconfig.py:55 |
| BENCH_MAX_STEPS_PER_ATTEMPT | (none → no cap) | max steps/attempt; must be a positive integer when set | scripts/run_cumulative/runner.py:522 |
| BENCH_NOTICES | (none) | run-scoped notices file the harness appends to and the board reads | harness/live_stream.py:499 (set per run at control/routes/run.mjs:276) |
| BENCH_ORG_ID | "" | org selector pin (a pre-provisioned org; data only, no mint/verify/fund) | harness/lifecycle/lconfig.py:52 |
| BENCH_PORT | 8002 | base port for the gates' task servers; the worker index is added | grader/lib/harness.ts:55 |
| BENCH_PROXY_CHECKPOINT | (none) | proxy checkpoint path for pricing | harness/adapters/challenge/pricing.py:124 |
| BENCH_REASONING_EFFORT | (none) | worker reasoning effort (opt-in via arg or this) | harness/adapters/challenge/runner.py:427 |
| BENCH_ROOT | <bench>/.. | workspace-root anchor. **Written, never read here**: `benv.py` exports it for child processes; no reader in this repo (harness/benv.py:43) | harness/benv.py:43 |
| BENCH_RUNNER_TIMEOUT_MS | 900000 | per-runner deadline inside a graded suite | grader/report.mjs:225 |
| BENCH_SERVE_CONTAINER_PORT | 4096 | container serve port | harness/adapters/challenge/runner.py:440 |
| BENCH_SERVE_HOST_PORT | (unset → free loopback port allocated and exported; positive int → pin) | host-published live-view serve port. `harness/free_port.py` allocates per run-instance when unset/`""`/`"0"`/`"auto"`; the fixed 8719 is retired (2026-09-22), though `harness/config.py:238` and the challenge runner still fall back to it if nothing resolved the port first | harness/free_port.py:39 |
| BENCH_SPEND_DB_DSN | postgresql://spend_proxy:spend_proxy_dev@127.0.0.1:5440/spend_proxy | spend meter DB (env wins over the dotenv file) | harness/spend_key.py:203 |
| BENCH_SUITE_BUDGET_MS | 3300000 | whole-suite budget, deliberately below the harness watchdog so a report is always written | grader/report.mjs:246 |
| BENCH_TOOL_TIMEOUT_MARKER_DIR | (none → no marker) | dir where the supervised shell writes its timeout marker | images/sidecar/supervised-shell.js:57 |
| BENCH_TOOL_TIMEOUT_S | 90 | per-tool timeout for the supervised shell (positive finite seconds) | images/sidecar/supervised-shell.js:52 |
| BENCH_TURN_STALL_TIMEOUT_S | 600 | turn stall detector bound | harness/adapters/challenge/constants.py:96 |
| BENCH_WORKER_CPUS | 8 | docker cpu cap | harness/adapters/docker_worker.py:47 |
| BENCH_WORKER_MEMORY | 4g | docker mem cap | harness/adapters/docker_worker.py:46 |
| BENCH_WORKER_PIDS_LIMIT | 512 | docker pids cap | harness/adapters/docker_worker.py:45 |
| BENCH_WORKER_SPEND_PROXY_BASE_URL | egress-derived | worker-side proxy URL (operator override wins) | harness/spend_key.py:252 |
| BENCH_WORKER_TARGET | 0.7 | target fraction of cpu/memory the grader's worker pool uses | grader/lib/workers.mjs:137 |
| BENCH_WORKERS | (unset → derived from cpu/memory × BENCH_WORKER_TARGET) | forced grader worker count | grader/lib/workers.mjs:145 |
| BENCH_RETRIEVAL_TEMPERATURE | 0.7 | retrieval temperature recorded in the cell's run context | harness/cumulative/run_context.py:79 |
| BENCH_RETRIEVAL_NEW_MEM_BOOST_MULT | 0.5 | new-memory boost multiplier in the run context | harness/cumulative/run_context.py:82 |
| BENCH_RETRIEVAL_NEW_MEM_BOOST_WINDOW | 30 | new-memory boost window | harness/cumulative/run_context.py:85 |
| BENCH_RETRIEVAL_OPEN_LOOP_FRACTION | 0.0 | open-loop retrieval fraction | harness/cumulative/run_context.py:89 |
| BENCH_RETRIEVAL_COUNTERFACTUAL_LOGGING | false | counterfactual retrieval logging flag | harness/cumulative/run_context.py:92 |
| OKP_CONTROL_BENCH_ROOT | control/.. | control-plane bench root | control/state.mjs:26 |
| OKP_CONTROL_PORT | 8718 | control-plane port | control/state.mjs:25 |
| OKP_CONTROL_PROXY_URL | http://127.0.0.1:4545 | model proxy: the control roster AND the harness model list (`GET /v1/models`) | control/state.mjs:27, harness/model_catalog.py:42 |
| OKP_CONTROL_PYTHON | null (control) / <bench>/.venv/bin/python (tool jobs) | python binary the control plane spawns | control/state.mjs:29, control/tools.mjs:31 |
| OKP_CONTROL_RUNTIME_URL | http://127.0.0.1:1234 | LM Studio runtime | control/state.mjs:28 |
| OKP_DASHBOARD_CONFIG | ~/.config/okp/dashboard.json | dashboard shared-config path (router keys, extraction settings) | control/routers.mjs:39, harness/spend_key.py:48 |
| OKP_INGRESS_CELL_HOST | (none) | egress ingress cell alias (open code-host ingress route) | images/sidecar/egress-sidecar.js:101 |
| OKP_INGRESS_PORT | 4096 | egress ingress port | images/sidecar/egress-sidecar.js:102 |
| OKP_LOOP_KILL_MARKER_DIR | "" | where the egress sidecar writes its loop-kill markers | images/sidecar/egress-sidecar.js:38 |
| OKP_PLAY_MAX_S | 21600 | hard lifetime for a play container | harness/play_container.py:484 |
| OKP_PROXY_RUNS_DIR | ~/.okp/proxy-runs | relay-proxy identity logs | scripts/run_cumulative/runner.py:335 |
| ORCAROUTER_API_KEY | (none) | cloud-router key (env wins over config/cloud.env) | harness/spend_key.py:324 |
| SEAM_RUNS_ROOT | (none) | live-stream seam check: runs root the probe reads | scripts/preflight/live.py:60 |
| SLOT_RUNS_ROOT | (none) | runs root handed to the campaign-subject probe | scripts/preflight/campaign.py:21 |
| SLOT_SUBJECT | (none) | JSON campaign subject handed to the campaign-subject probe | scripts/preflight/campaign.py:22 |
| TEST_PARALLEL_INDEX | 0 | Playwright worker index, 0-based (first choice of the gate port offset) | grader/lib/harness.ts:48 |
| VITEST_POOL_ID | 1 | Vitest pool id, 1-based (fallback worker index, minus one) | grader/lib/harness.ts:50 |

## External contract — read outside this repo (36)

No line in this repo reads these. Each row names the actual reader; where this repo *sets* the var
(Dockerfiles, cell env), the setter is named too, so the hand-off is visible.

### Read by another TOKProject component

| Name | Default | Controls | Reader (outside this repo) |
|---|---|---|---|
| QDRANT_API_KEY | (REQUIRED — panics if unset, and if shorter than 32 chars) | Qdrant embedding-store auth (hub) | hub/internal/config/config.go:46 |
| OKP_ENV | local | base-URL switch (`production` picks the production base) | hub/dashboard/lib/config.ts:23 |
| OKP_CHAIN_ID | okp-local-1 | chain id | hub/dashboard/lib/config.ts:69 |
| OKP_CHAIN_RPC | http://localhost:26657 | chain RPC | hub/dashboard/lib/config.ts:70 |
| OKP_CHAIN_REST | http://localhost:1317 | chain REST | hub/dashboard/lib/config.ts:71 |
| OKP_SOCIAL_GRAPH_URL | http://localhost:4471 | social-graph endpoint | hub/dashboard/lib/config.ts:72 |
| OKP_BECH32_PREFIX | okp | bech32 prefix | hub/dashboard/lib/config.ts:73 |
| OKP_COIN_DENOM | TOKN | display denom | hub/dashboard/lib/config.ts:74 |
| OKP_COIN_MIN_DENOM | utokn | base denom | hub/dashboard/lib/config.ts:75 |
| OKP_MCP_HTTP_ONLY | "1" (set by the plugin's spawn) | MCP detached HTTP-only mode | client/packages/core/src/server.ts:307 (set at client/packages/plugin/plugins/plugin.ts:1322) |
| OKP_BENCH_ENDPOINTS | off — '1' enables | bench HTTP endpoints on the MCP server | client/packages/core/src/http-server.ts:106 |
| OKP_GUARD_BIN | {workspace}/guard/target/release/okp-guard | YARA guard binary | client/packages/core/src/guard.ts:20 |
| OKP_KEYSTORE_PATH | ~/.okp/keys | client keystore dir (the org master-key envelope) | client/packages/core/src/key-store.ts:55 |
| OKP_PLUGIN_DEBUG | off | plugin debug logging | client/packages/plugin/plugins/plugin.ts:622 |
| OKP_ROOT | derived | plugin okp root | client/packages/plugin/plugins/plugin.ts:424 |
| OKP_GSTV_SENSORS | enabled | GSTV sensor toggle | client/packages/plugin/plugins/plugin.ts:494 |
| OKP_EPOCH | (none) | epoch fingerprint in the MCP auto-start log line (log-only) | client/packages/plugin/plugins/plugin.ts:1361 |
| OKP_AGENT_KEY | (none) | agent key fingerprint in the MCP auto-start log line (log-only) | client/packages/plugin/plugins/plugin.ts:1361 |
| OKP_AGENT_PRIVATE_KEY | (none) | agent key fallback fingerprint, same log line (log-only) | client/packages/plugin/plugins/plugin.ts:1361 |
| OKP_LOG_DIR | ~/.okp/logs | log dir for the dashboard logger and the plugin | hub/dashboard/lib/logger.ts:79 (mirrored in-repo at tests/fixtures/logger.js:72) |
| NODE_ENV | production (image) | logger gating (test mode) | hub/dashboard/lib/logger.ts:89, client/packages/core/src/logger.ts:89 (set at dashboard/Dockerfile:29) |
| OPENCODE_DB_PATH | ~/.local/share/opencode/opencode.db | opencode session-db path for session-title pickup | hub/dashboard/lib/opencode-session-events.ts:7 |
| OPENCODE_CONFIG_DIR | falls to XDG_CONFIG_HOME then ~/.config/opencode | where the installer writes opencode.json | client/packages/plugin/bin/install-opencode.ts:178 (set per cell at harness/adapters/docker_worker.py:1404) |
| XDG_CONFIG_HOME | ~/.config | installer config-dir fallback | client/packages/plugin/bin/install-opencode.ts:181 (set at images/worker/Dockerfile:42, harness/adapters/docker_worker.py:1398) |
| OKP_ENGINE_PATH | (none) | plugin engine-path override baked at install time | client/packages/plugin/bin/install-opencode.ts:199 |
| OKP_IDENTITY_SEED_HEX | (none) | leader-signer identity seed | dev/benchmark/leader-signer/src/cli.ts:78 |

### Read by a runtime (set in this repo's images or cell env)

| Name | Default | Controls | Reader |
|---|---|---|---|
| BENCH_LIVE_STREAM_NS | (none) | stream namespace stamped on every record. **Written here, never read here**: the harness puts it in the cell env | harness/live_stream.py:247 exports it (name defined at harness/live_stream.py:134, `ENV_NS`); the live-stream backend, outside this repo, reads it |
| OPENCODE_CONFIG | (none) | opencode binary config file | opencode runtime (set at images/worker/Dockerfile:44) |
| NODE_PATH | /usr/local/lib/node_modules | global node_modules resolution | node runtime (set at images/worker/Dockerfile:75) |
| PLAYWRIGHT_BROWSERS_PATH | /opt/ms-playwright | browser install root | playwright runtime (set at images/worker/Dockerfile:50, images/grader/Dockerfile:36) |
| NPM_CONFIG_UPDATE_NOTIFIER | false | npm update-notifier toggle | npm runtime (set at images/worker/Dockerfile:45, images/grader/Dockerfile:35) |
| NPM_CONFIG_FETCH_RETRIES | 0 | npm fetch retry count | npm runtime (set at images/worker/Dockerfile:46) |
| NPM_CONFIG_FETCH_TIMEOUT | 5000 | npm fetch timeout | npm runtime (set at images/worker/Dockerfile:47) |
| NPM_CONFIG_FETCH_RETRY_MINTIMEOUT | 1000 | npm retry min backoff | npm runtime (set at images/worker/Dockerfile:48) |
| NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT | 1000 | npm retry max backoff | npm runtime (set at images/worker/Dockerfile:49) |
| DEBIAN_FRONTEND | noninteractive | apt non-interactive mode | apt runtime (set at images/worker/Dockerfile:41, images/grader/Dockerfile:34) |

## Removed in this pass (7 rows — no reader anywhere)

Each name was grepped with `grep -rw` across the repo (excluding `node_modules` `.venv` `dist`
`build` `.git` `runs` `vendor` `__pycache__`); the evidence column records where the only surviving
mentions were.

| Name | Evidence it has no reader |
|---|---|
| BENCH_RUN_TIMEOUT_S | 0 hits outside this file. Nothing reads a run-level timeout. |
| BENCH_MAX_ATTEMPTS | 0 code hits. The only mention is prose in docs/system-map.md:385 asserting it is "env-only" — stale; the attempt count is not read from env. |
| BENCH_SEED_SNAPSHOT | `control/snapshots.mjs` does not exist (no snapshots module in `control/`). Only prose: RUNBOOK.md:1841, RUNBOOK.md:1873. |
| BENCH_SEED_SNAPSHOT_FILE | Same missing module. Only prose: RUNBOOK.md:1874. |
| BENCH_CONTINUOUS_FILE | `control/continuous.mjs` does not exist. Only prose: RUNBOOK.md:1934. |
| KEEP_WORK | 0 hits in this repo; the only match left in the tree is this table's own row. |
| OPENROUTER_API_KEY | 0 hits in this repo. Its only sibling reader is a Go test skip-gate (hub/internal/embed/embed_test.go:160), which is not a config consumer, and the SWE-ContextBench solve it was documented for is still an unimplemented seam here (harness/runner.py:25). |

Five further names the change request expected to find as rows are **not table rows and never were**:
`BENCH_SELF_COMPACT`, `BENCH_COMPACT_PHASE_FILE`, `BENCH_HOLD_UI`, `BENCH_SPEND_PROXY_BASE_URL` and
`BENCH_MCP_SEED`. They appear only as deletion prose (RUNBOOK.md, code comments) or in the notes
below — never as a row, so there was nothing to remove. They remain deleted.

## Notes

- **Honcho settings are not env vars.** `HONCHO_*` names are read from the memory system's settings
  file through the `memory.env` map (memory-systems/honcho/hooks.py:48-53), not from process env, so
  they are documented in docs/memory-systems.md and are deliberately absent here.
- **Scope of "read in this repo".** Test-runner and shell globals that no bench code configures are
  excluded: `VITEST` (tests/fixtures/logger.js:81), `PYTEST_XDIST_WORKER`
  (tests/test_docker_isolation.py:156), `BENCH_WALK_TS` (tests/test_predicate_emitter.py:34),
  `GRANDCHILD_PIDFILE` (grader/meta/runner-kill.test.ts:32), `HOME` (control/routers.mjs:40), and
  `BUILD_ARTIFACTSTAGINGDIRECTORY` (vendored dashboard/vendor/xterm.js). They are runtime/third-party
  internals, not bench config.
- `BENCH_ROOT` is the one row here that is written but never read in this repo: `harness/benv.py:43`
  exports it for child processes. It is kept because the export is a real contract with those
  children, and the row says so rather than implying a reader.
- `OKP_MCP_SEED` stays out of the register: it has zero occurrences in any code here. RUNBOOK.md:1154
  attributes a *different* var, `BENCH_MCP_SEED`, to `okp-meta/scripts/lib.sh`; this repo mentions
  `BENCH_MCP_SEED` only in a comment (config/bench.env:7), which is not a reader either.
- `OKP_MCP_URL` is a naming-drift ghost of `OKP_MCP_HTTP_URL`, which is read at
  dev/benchmark/leader-signer/vendor/config.ts:95 (moved from the retired `bench/scaffold/leader-signer/`).
  The stale prose reference in RUNBOOK.md was renamed to the live name; neither name is bench config.
- Backend-env removal (2026-09, memory-backend registry retirement): `OKP_RECALL_MODE`,
  `OKP_ANSWERER_POLICY`, `OKP_INSESSION_EXTRACTION`, `OKP_STATE_DIR`, `OKP_SERVED_MEMORIES_PATH`,
  `OKP_MANAGED_IDENTITY` and `OKP_PLUGIN_PATH` have no reader in any code file here (`grep -rlw`
  returns nothing) and stay struck — they
  are the PLUGIN's own env surface, owned where the plugin is built. Likewise `OKP_HUB_URL` (the
  plugin's and the hub dashboard's own var, read at hub/dashboard/lib/config.ts:68 and
  client/packages/plugin/plugins/plugin.ts:1361): nothing in this repo reads or sets it, so it is not
  part of this register. The bench's plugin-facing vars remain `BENCH_PLUGIN_DIR`, the memory set
  (`BENCH_MEMORY_UPSTREAM`, `BENCH_MEMORY_ENV`, `BENCH_MEMORY_READY_CMD`,
  `BENCH_MEMORY_READY_TIMEOUT_S`, `BENCH_MEMORY_COST_CMD`), and `OKP_LOG_DIR`.
- `BENCH_SPEND_PROXY_BASE_URL` was removed earlier (2026-09-04): its resolver was deleted in the
  OpenRouter-proxy cleanup (WO-CLEAN-08) and nothing reads the name; `harness/spend_key.py:248` only
  warns that it must never leak into a cell. The live worker-side var is
  `BENCH_WORKER_SPEND_PROXY_BASE_URL` (a row above).
