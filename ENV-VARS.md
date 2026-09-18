# ENV-VARS.md — bench

Config-surface reference (dead bucket re-verified and resolved). Every env var the code READS, cross-referenced against docs. Buckets: read+documented / read+undocumented / read by sibling/runtime (reclassified — was "dead", NOT deleted) / documented+unread (dead — none remain) / dead-and-undocumented.

## Summary
| Bucket | Count |
|---|---|
| read+documented | 36 |
| read+undocumented | 59 |
| read by sibling/runtime (reclassified) | 17 |
| documented+unread (dead) | 0 |
| dead-and-undocumented | 0 |
| total read | 93 |
| total documented | 51 |

## read+documented
| Name | Default | Controls | Override |
|---|---|---|---|
| BENCH_HOLD_UI | off | post-cell UI hold window | env BENCH_HOLD_UI=1 |
| BENCH_LEADER_MCP_URL | http://127.0.0.1:4550 | leader MCP endpoint | env |
| BENCH_LEADER_KEYSTORE | ~/.okp/bench/leader-keystore | leader keystore dir | env |
| BENCH_RUN_TIMEOUT_S | (optional) | run-level timeout | env |
| BENCH_SKIP_CLEANUP | off | skip telemetry cleanup | env =1 |
| LOCAL_LLM_PROXY_API_KEY | (none) | Local LLM Proxy (:4545) token | env or .env |
| BENCH_SPEND_DB_DSN | postgresql://spend_proxy:spend_proxy_dev@127.0.0.1:5440/spend_proxy | spend meter DB | env or .env |
| BENCH_LIVE_STREAM | (none) | live-stream path | env |
| BENCH_LIVE_STREAM_NS | (none) | stream namespace | env |
| BENCH_PLUGIN_DIR | (none) | THE one plugin pointer: absolute path to the plugin tree baked into the worker image at /opt/bench-plugin; unset ⇒ vanilla (no-plugin) build — read `harness/worker_image.py:49`, `scripts/rebuild_worker_image.py` | env or --plugin-dir |
| OKP_GUARD_BIN | {root}/okp-guard/target/release/okp-guard | YARA guard binary | env |
| BENCH_TARGET | task/backgammon/golden | gates target dir | env |
| DEBUG_API | off | debug endpoints on task servers | env =1 |
| REMOTE_VIEWING | disabled | LAN-access switch (disabled=enabled); invalid non-empty → refuse startup; read dashboard/lib/remote-viewing.mjs | env |
| OKP_DASH_HOST | 127.0.0.1 (image 0.0.0.0) | dashboard bind addr; with REMOTE_VIEWING=enabled must be a specific LAN IP | env or --host |
| OKP_DASH_PORT | 8717 | dashboard port | env or --port |
| OKP_DASH_BENCH_ROOT | .. (image /bench) | bench root | env |
| OKP_DASH_POLL_MS | 2000 | refresh cadence | env |
| OKP_DASH_OPENCODE_URL | http://127.0.0.1:8719 | live agent API | env |
| OKP_DASH_CONTROL_URL | http://127.0.0.1:8718 | the same-origin relay's upstream control plane (always loopback) | env |
| OKP_BIND_HOST | 127.0.0.1 | Docker publish host; with REMOTE_VIEWING=enabled must be a specific LAN IP, disabled refuses a wide publish — read by the dashboard process for fail-closed validation AND compose interpolation | env |
| OKP_DASH_SOURCE_<NAME> | per config | per-source toggle | env OKP_DASH_SOURCE_<NAME>=1/0 |
| OKP_DASH_HUBDB | off | enable hub-db source | env =1 |
| OKP_HUB_DB_HOST | okp-postgres | postgres host | env |
| OKP_HUB_DB_PORT | 5432 | postgres port | env |
| OKP_HUB_DB_USER | okp | postgres user | env |
| OKP_HUB_DB_NAME | okp_hub | postgres db | env |
| OKP_HUB_DB_PASSWORD | "" | postgres password (query-time) | env |
| OKP_LOG_DIR | ~/.okp/logs | plugin log dir | env |
| OKP_PLUGIN_PATH | (none) | plugin path baked into worker opencode.json | build-time env |
| BENCH_SELF_COMPACT | off | benchmark-native worker-side self-fire compaction (`images/worker/self-compact.ts`, baked into every worker image at /opt/bench/self-compact.ts) | env =1, exported by the harness per cell when launched with --compact |
| BENCH_COMPACT_PHASE_FILE | (none) | path to the A2 phase sentinel the compaction arm reads on every session.idle; only `build` may fire, and unset/unreadable never fires | env, set to /okp-compact/phase by the harness per cell when launched with --compact (read-only bind mount, both arms) |
| BENCH_DEV_MODE | (none) | dev-mode env pin (truthy = on, falsy = off; pinned ⇒ `settable:false`) — read `control/devmode.mjs:48-95` | env |
| BENCH_DEV_MODE_FILE | <bench>/config/devmode.json | dev-mode state file location — read `control/devmode.mjs:57-59` | env |
| BENCH_SEED_SNAPSHOT | (none) | pins the armed build-snapshot id (env pin ⇒ `settable:false`) — read `control/snapshots.mjs:252` | env |
| BENCH_SEED_SNAPSHOT_FILE | <bench>/config/armed-snapshot.json | armed-snapshot state file location — read `control/snapshots.mjs:241` | env |

## read+undocumented
| Name | Default | Controls | Override |
|---|---|---|---|
| BENCH_HUB_URL | http://127.0.0.1:4440 | hub endpoint | env |
| BENCH_MCP_RECALL_URL | http://127.0.0.1:4550 (host) / http://host.docker.internal:4550 (worker) | recall client | env |
| BENCH_SERVE_HOST_PORT | 8719 | host-published serve port | env |
| BENCH_SERVE_CONTAINER_PORT | 4096 | container serve port | env |
| BENCH_ENV_FILE | config/bench.env | durable env file path | env |
| BENCH_ROOT | <bench>/.. | workspace-root anchor | env |
| BENCH_LEADER_SEED_HEX | "" | leader identity seed | env |
| BENCH_ORG_ID | "" | org selector pin | env |
| BENCH_LEADER_SIGNER_DIR | scaffold/leader-signer (STALE — dir moved to dev/benchmark/leader-signer; code default in lconfig.py:57-58 is stale too) | signer dir | env |
| BENCH_RUNS_DIR | <bench>/runs | runs root | env |
| BENCH_MAX_ATTEMPTS | 5 | max attempts/cell | env |
| BENCH_MAX_STEPS_PER_ATTEMPT | (optional) | max steps/attempt | env |
| BENCH_TURN_STALL_TIMEOUT_S | 600 | turn stall detector | env |
| BENCH_PROXY_CHECKPOINT | (none) | proxy checkpoint path | env |
| BENCH_REASONING_EFFORT | (none) | worker reasoning effort | env |
| BENCH_WORKER_PIDS_LIMIT | 512 | docker pids cap | env |
| BENCH_WORKER_MEMORY | 4g | docker mem cap | env |
| BENCH_WORKER_CPUS | 8 | docker cpu cap | env |
| BENCH_DATA_DIR | <repo>/data | telemetry sink | env |
| OKP_PROXY_RUNS_DIR | ~/.okp/proxy-runs | relay-proxy identity logs | env |
| BENCH_ALLOW_MISSING_RUN_CONTEXT | off | tolerate missing run context | env =1 |
| BENCH_DOTENV | <bench>/.env | dotenv path override | env |
| BENCH_WORKER_SPEND_PROXY_BASE_URL | egress-derived | worker proxy URL | env |
| BENCH_CLOUD_KEY_FILE | config/cloud.env | cloud key file | env |
| ORCAROUTER_API_KEY | (none) | cloud router key | env or config/cloud.env |
| OPENROUTER_API_KEY | (none) | temp-injected for SWE-ContextBench solve | env |
| KEEP_WORK | off | preserve SWE-CB workdir | env |
| SEAM_RUNS_ROOT | (none) | live-stream seam check | env |
| OKP_INGRESS_CELL_HOST | (none) | egress ingress cell alias | env (set by harness) |
| OKP_INGRESS_PORT | 4096 | egress ingress port | env |
| OKP_CONTROL_PORT | 8718 | control-plane port | env |
| OKP_CONTROL_BENCH_ROOT | .. | control bench root | env |
| OKP_CONTROL_PROXY_URL | http://127.0.0.1:4545 | model proxy: the control roster AND the harness model list (`GET /v1/models`) | env |
| OKP_CONTROL_RUNTIME_URL | http://127.0.0.1:1234 | LM Studio runtime | env |
| OKP_CONTROL_SERVE_URL | http://127.0.0.1:8719 | serve API | env |
| OKP_CONTROL_PYTHON | null | python binary | env |
| OKP_DASH_RUNS_ROOT | <benchRoot>/runs | dashboard runs root | env |
| OKP_DASH_CONTAINER | unset (compose: "1") | internal marker: container-mode, so the fail-closed bind treats OKP_BIND_HOST as the publish host | set by docker-compose/Dockerfile |
| OKP_IDENTITY_SEED_HEX | (none) | leader-signer seed | env or --seed-hex |
| OKP_ENV | local | base-URL switch | env =production |
| OKP_CHAIN_ID | okp-local-1 | chain id | env |
| OKP_CHAIN_RPC | http://localhost:26657 | chain RPC | env |
| OKP_CHAIN_REST | http://localhost:1317 | chain REST | env |
| OKP_SOCIAL_GRAPH_URL | http://localhost:4471 | social-graph | env |
| OKP_BECH32_PREFIX | okp | bech32 | env |
| OKP_COIN_DENOM | TOKN | denom | env |
| OKP_COIN_MIN_DENOM | utokn | min denom | env |
| OKP_ROOT | derived | plugin okp root | env |
| OKP_GSTV_SENSORS | enabled | GSTV sensor toggle | env =0/false/off |
| OKP_PLUGIN_DEBUG | off | plugin debug logging | env =1 |
| OKP_AGENT_KEY | (none) | agent key fp (log-only) | env |
| OKP_AGENT_PRIVATE_KEY | (none) | agent key fallback fp (log-only) | env |
| OKP_EPOCH | (none) | epoch fp (log-only) | env |
| BENCH_TOOLS_URL | (none) | address of a custom-tools service whose tools the board's drawer lists and runs; never consulted by preflight or a run — see CUSTOM-TOOLS.md (control/tools.mjs) | env |
| BENCH_STATS_MANIFEST | (none) | run-stats manifest path (control/runstats.mjs:182) | env |
| OKP_DASHBOARD_CONFIG | (none) | dashboard shared-config path (control/routers.mjs:71 + harness/spend_key.py:48) | env |

## read by sibling/runtime (reclassified — was "dead", NOT deleted)
Re-verified: none of these has a bench-code reader, but each IS read — either by a sibling TOKProject component (hub / client / dashboard) or by an external runtime (docker compose interpolation, opencode, node/npm, playwright, apt). Not bench-surface config; kept off the deletion list.

| Name | Default | Controls | Reader |
|---|---|---|---|
| QDRANT_API_KEY | (REQUIRED — panic if unset) | Qdrant embedding-store auth (hub) | hub/internal/config/config.go:46 — REQUIRED, panics if unset; the bench.env "code default" claim was a false comment, since removed |
| OKP_MCP_HTTP_ONLY | "1" (set by plugin spawn) | MCP detached HTTP-only mode | client/packages/core (server.ts:268) |
| OKP_BENCH_ENDPOINTS | off — '1' enables | bench HTTP endpoints on the MCP server | client/packages/core (http-server.ts:96) |
| OPENCODE_DB_PATH | ~/.local/share/opencode/opencode.db | opencode session-db path for session-title pickup | hub/dashboard (opencode-session-events.ts:7) |
| NODE_ENV | production (image) | test-mode logger gating | hub/dashboard (logger.ts:89) + client/packages/core (logger.ts:89) |
| XDG_CONFIG_HOME | ~/.config | installer config-dir fallback | client/packages/plugin (install-opencode.ts:173) |
| OPENCODE_CONFIG_DIR | (falls to XDG_CONFIG_HOME then ~/.config/opencode) | where installer writes opencode.json | client/packages/plugin (install-opencode.ts:170) |

| NODE_PATH | /usr/local/lib/node_modules | global node_modules resolution | node runtime |
| OPENCODE_CONFIG | (none) | opencode binary config file | opencode binary runtime |
| PLAYWRIGHT_BROWSERS_PATH | /opt/ms-playwright | browser install root | playwright runtime |
| DEBIAN_FRONTEND | noninteractive | apt non-interactive mode | apt runtime |
| NPM_CONFIG_UPDATE_NOTIFIER | (various) | npm update-notifier toggle | npm runtime |
| NPM_CONFIG_FETCH_RETRIES | (various) | npm fetch retry count | npm runtime |
| NPM_CONFIG_FETCH_TIMEOUT | (various) | npm fetch timeout | npm runtime |
| NPM_CONFIG_FETCH_RETRY_MINTIMEOUT | (various) | npm retry min backoff | npm runtime |
| NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT | (various) | npm retry max backoff | npm runtime |
| OKP_ENGINE_PATH | (none) | plugin engine-path override baked at install time | plugin installer, built outside this repo (install-opencode.ts:191) |

## dead-and-undocumented
none

## Notes
- `OKP_MCP_SEED` was removed from this register: its old note ("read by okp-meta/scripts/lib.sh") was wrong — that script reads `BENCH_MCP_SEED`, a different, live var. As named, `OKP_MCP_SEED` is a drift-ghost with zero occurrences anywhere and was deleted.
- `OKP_MCP_URL` was removed: a naming-drift ghost of `OKP_MCP_HTTP_URL` (read at `dev/benchmark/leader-signer/vendor/config.ts:96` — moved from the retired `bench/scaffold/leader-signer/`). The bench-doc prose reference in RUNBOOK.md was renamed to the live name.
- Backend-env removal (2026-09, memory-backend registry retirement): `OKP_RECALL_MODE`, `OKP_MCP_HTTP_URL`, `OKP_ANSWERER_POLICY`, `OKP_INSESSION_EXTRACTION`, `OKP_STATE_DIR`, `OKP_HUB_URL`, `OKP_SERVED_MEMORIES_PATH`, and `OKP_MANAGED_IDENTITY` were struck from this register — no bench-code reader or setter remains (the harness no longer injects them per cell; the vestigial `DockerCellConfig` field contracts were removed too (LI-17)). They are the PLUGIN's own env surface now, owned and documented where the plugin is built (outside this repo). The bench's only plugin-facing vars are `BENCH_PLUGIN_DIR` (the one pointer), plus the flagged compaction/build set kept above (`BENCH_SELF_COMPACT`, `BENCH_COMPACT_PHASE_FILE`, `OKP_PLUGIN_PATH`, `OKP_LOG_DIR`). `OKP_RECALL_MODE` survives in bench code ONLY as the run-context lever `L4_OKP_RECALL_MODE`, read from the operator-supplied `BENCH_RECALL_MODE` env (default `prod`) — a measurement record, not a config this repo sets.
- `BENCH_SPEND_PROXY_BASE_URL` was removed from the register (2026-09-04): the resolver `resolve_spend_proxy_base_url` was deleted in the OpenRouter-proxy cleanup (WO-CLEAN-08); nothing reads this var. The live worker-side var is `BENCH_WORKER_SPEND_PROXY_BASE_URL` (still listed above). The stale `.env.example` line referencing it was removed too.
