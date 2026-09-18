# The Open Knowledge Project Bench Dashboard

A live instrument for the Open Knowledge memory benchmark. Wall-dominant board, Midnight
phosphor palette, built to be read at a glance on a stream and to survive a
skeptical engineer reading it closely.

```bash
docker compose up -d          # → http://localhost:8717
```

In Docker Desktop it appears as `learning-index-dashboard` with 8717 as a
clickable link and a health dot that goes green once the board assembles.

Host mode still works and needs no install — Node 18+ stdlib only:

```bash
node server.mjs               # → http://127.0.0.1:8717
node server.mjs --help
```

**No dependencies. No build step. No `npm install`.** If this ever needs a
package manager to start, something has been added that should not have been.
The tests run on the stdlib runner for the same reason:

```bash
cd bench/dashboard && node --test
```

**One vendored library, and it is stated rather than hidden.** `vendor/` holds
xterm.js 6.0.0 — MIT, zero runtime dependencies — as the prebuilt UMD bundle the
package ships, loaded from `index.html` with a plain `<script src>`. Nothing
resolves it at runtime, nothing compiles it, and there is still no
`package.json`, so the invariant above holds in full. It is here because the
TUI mirror was hand-painting terminal frames as inline-styled `<span>`s and got
four things wrong at once that all failed silently — the cell size, the font it
claimed to measure, every colour on screen, and the cost of redrawing it. A
terminal emulator is not a thing to keep re-deriving. See `panels/tui.js`.

The bench repo is mounted **read-only** at `/bench`. That `:ro` is not
decoration: run artifacts under `runs/` are the authoritative record of a
measurement, and a read-only mount makes "the dashboard corrupted a run"
structurally impossible rather than merely unlikely.

There is **no mock mode**. The board renders whatever the artifacts carry,
including nothing — the empty states are designed for exactly that.

---

## What it measures, and what it refuses to claim

Three claims, three artifacts, never merged:

| Artifact | Claims | Does **not** claim |
|---|---|---|
| serve | a memory was injected into context | that it helped |
| outcome | the episode resolved, or didn't | that the memory caused it |
| **arm delta** | memory-on resolves more than control | — this is the only causal surface |

The two arms differ in exactly one thing — the worker image's build state:
**control (OFF) = no plugin** (vanilla build, `BENCH_PLUGIN_DIR` unset);
**memory-on (ON) = the plugin tree `BENCH_PLUGIN_DIR` names**, baked in at
build time. The board never renders a backend name, by design: the benchmark
defines no memory-system interface and names no backend.

Consequences that are enforced in code, not by convention:

- **A serve count is never a success metric.** Serves live in the honesty rail
  labelled *delivery, not outcome*, and that box is deliberately the quietest.
- **No delta below `min_cells_per_arm` (3).** The hero renders `COLLECTING`
  with the real cell counts instead. A single-sample number (n=1) is not
  meaningful.
- **Only VALID cells enter the delta**, and `cells` counts scored cells only.
  A void-instrument cell (RUNBOOK rule 5.10 — provider-side truncation on a
  non-green terminal attempt) or a single-attempt cell is excluded and counted
  in `arm_delta.<arm>.excluded`, never scored as a measured 0%. Both used to
  contribute 0 to the numerator and their full gate count to the denominator,
  which manufactured apparent lift for the memory arm the moment the threshold
  unlocked. `contract.mjs::cellValidity` MIRRORS the scorecard's canonical rule
  in `harness/cumulative/run_artifacts.py` — if that rule moves, this moves
  with it. Pinned by `arm-delta-validity.test.mjs`.
- **No confidence interval over gate counts, ever.** Gates cluster within cell —
  68 gates from one cell are not 68 independent samples. The standing note says
  so permanently.
- **Outcome is tri-state** (`worked` / `didnt_work` / `unobserved`). Silence is
  not a vote, and `unobserved` is styled as a third state, never as failure.
- **Memories render as four labelled atomic fields** (`implement`, `context`,
  `dnd`, `stack`). Never collapsed into one blob. A null `dnd` shows as null.
- **The gate-mode label is permanent and derived**, read from the recorded
  `L4_OKP_RECALL_MODE` lever — never hardcoded. In benchmark mode the
  approval gate auto-approves and the board says so next to the recall panel.
- **`bench-mock/self-declared`** renders permanently as plain label text. Never
  a badge, never a tier.

Not present, because they do not exist upstream: verification tiers,
ablation receipts, shadow recall. If you see one, it is a bug.

### The stats strip — BENCHMARK vs CUSTOM (a topology note)

The run-summary stats strip (the ledger panel's head) has two zones, never
merged, both served by `GET /api/stats` (`control/runstats.mjs`):

- **BENCHMARK** — native, six slots: `scored` / `voided` / `unmeasured`, then
  `loop_errors` / `stream_errors` / `stalled_errors` reading the run scorecard's
  `error_totals` (`guard_aborted_turns` / `finalize_timeout_turns` /
  `stalled_turns`).
- **CUSTOM** — manifest-driven (`BENCH_STATS_MANIFEST`); now empty.

The CUSTOM zone's old "LOOP ERRORS" slot was the **relay's** shared, monotonic,
unfiltered loop-guard kill counter (`relay-loop-fires`, delta-scoped over ALL
relay traffic — compaction streams, other cells, the operator's sessions), NOT
the harness's per-run `guard_aborted_turns`. It was retired 2026-09-08
(`dev/bench-stats.json` `"stats": []`) because a per-run dashboard must not show
a machine-wide counter. The only place loop+stream genuinely merged into one
number was the honesty rail's `recovered_turns` (`guard_aborted_turns +
finalize_timeout_turns`) — a separate display, untouched.

---

## Three kinds of nothing

The board distinguishes these everywhere, because collapsing them is how a
dashboard starts lying:

| State | Means |
|---|---|
| `unobserved` | not measured yet |
| `unwired` | the source that would carry it is not connected |
| `0` | measured, and the answer is zero — a real result |

Most of a real run is null. The empty states are designed, not incidental.

---

## Architecture

```
contract.mjs          the versioned JSON contract + null-safe helpers
server.mjs            zero-dep HTTP server: peer guard → static GET → dashboard
                      GET APIs → same-origin control relay → 404
lib/
  net-policy.mjs      peer classifier (loopback/private/link-local trusted) +
                      same-origin check
  control-relay.mjs   exact METHOD/path allowlist relay to the loopback control
                      plane (origin gate on POSTs, 64KB cap, never logs bodies)
Dockerfile            single stage — there is nothing to build
docker-compose.yml    read-only mount, loopback-or-specific publish, opt-in hub-db
sources/
  _runtime.mjs        module isolation: timeouts, tail-bounded reads, merge
  run-manifest.mjs    provenance: policy anchor, levers, org, model
  status-stream.mjs   AUTHORITATIVE — gates, arm, verdict
  run-log.mjs         the live pulse between attempt records
  live-stream.mjs     the cell's live.jsonl — the during-the-run surface
  learning.mjs        in-session extraction capture: matrix, claims, ledger
  funnel-cells.mjs    plugin funnel counters      (ON cells only)
  plugin-log.mjs      recall latency p50/p95      (ON cells only)
  results-ledger.mjs  completed scored cells across runs (append-only JSONL)
  stack-ledger.mjs    longitudinal transfer curve; spans run directories
  opencode-serve.mjs  live token burn             (opt-in, host API)
  control-plane.mjs   roster, run control, event feed (relayed, same-origin)
  hub-db.mjs          candidate relevance/standing (opt-in, DISABLED default)
index.html + board.js + panels/   the board
```

### Configuration

Env vars override the config file, so the container is reconfigured with
`docker run -e …` or a compose `environment:` block — never a rebuild:

| Var | Default | Purpose |
|---|---|---|
| `OKP_DASH_HOST` | `127.0.0.1` (image: `0.0.0.0`) | host-process bind address (`--host` overrides) |
| `OKP_DASH_PORT` | `8717` | port |
| `OKP_DASH_BENCH_ROOT` | `..` (image: `/bench`) | bench repo root |
| `OKP_DASH_POLL_MS` | `2000` | refresh cadence |
| `OKP_DASH_OPENCODE_URL` | `http://127.0.0.1:8719` | live agent API |
| `OKP_DASH_CONTROL_URL` | `http://127.0.0.1:8718` | the relay's upstream control plane (always loopback) |
| `OKP_DASH_SOURCE_<NAME>` | — | force a source on/off |
| `OKP_DASH_HUBDB` | off | enable the hub-db source |
| `OKP_HUB_DB_{HOST,PORT,USER,NAME,PASSWORD}` | — | hub postgres |

The password is read from the environment at query time. It is never written to
config, never logged, and never returned by `/api/health`.

### Remote viewing

The board always answers on this machine at `http://127.0.0.1:8717`. To also
reach it from a phone or tablet on the same network, add two lines to
`dashboard/.env` (compose reads that file on every command) and redeploy:

```
COMPOSE_FILE=docker-compose.yml:docker-compose.lan.yml
LAN_ADDRESS=192.168.50.140
```

Then open `http://192.168.50.140:8717/` on the device. Delete the two lines and
redeploy to turn it off. If the machine's LAN address changes (reserve it on
the router), the redeploy fails loudly rather than publishing somewhere else.

Every board request is same-origin: the dashboard relays `/api/*` to the
control plane, which never leaves this machine's loopback (:8718).

### Checking the board

`./redeploy.sh` ends by running `check/board-check.mjs`: a real browser opens
the board on every address it is published on, clicks through every panel, tab
and dialog that changes nothing, and fails the deploy if a page errors, a
request fails, or a panel never asks for its data. Writes are blocked during
the check. Run it alone with `node check/board-check.mjs [url ...]`.

### Adding a source

Drop a file in `sources/` exporting `id`, `fields`, `describe()` and
`async read(ctx)` returning `{ ok, patch, provenance, reason? }`, then register
it in `dashboard.config.json`. The merge is additive: `null` never overwrites a
value, so enabling a source can only add information.

**A source cannot take the board down.** Each read is isolated behind a 2s
timeout and a try/catch. A module that throws, hangs, is absent, or fails to
import is reported `unwired` with a reason, and its fields stay null — which is
already a designed UI state.

### Preserved subtrees — who owns each panel

Some panels own their subtree and the DOM-morpher must not touch it. The
`#sc-events` and `#sc-backend` feed boxes (and the xterm TUI terminal) carry a
`data-preserve` attribute; `dom.js::patchElement` (`dom.js:160-169`) syncs the
container's own attributes, then returns at `dom.js:165` **before** recursing
into the children of a preserved node.

Consequence for anyone adding an expand/collapse inside the feed: the app's
standard recipe — toggle a module-state variable, then call `render()` — can
never paint it there. A board-wide `render()` emits an empty preserve box, the
patch skips its children, and `paintFeed`'s staleness signature does not key on
expansion state (and its freshness gate needs a genuinely new `seq`). So the
event feed's click-to-expand is painted by the subtree's owner (`live.js`):
`expandedSeq` module state toggled in a delegated handler bound once on
`#sc-events`, and only the affected row is repainted in place via `outerHTML`
(`rerenderRow`). Both paintFeed paths (append + stale-rebuild) render through
`evRow`, so a rebuild reproduces the expansion. If a preserved subtree needs a
new interaction, give it to its owner — do not add it to the board-wide render
path. (Contrast: the non-preserved ledger legitimately uses toggle-state-then-
`render()` at `board.js:687-688`.)

---

## Safety

Written to be run by anyone, out of the box, without wrecking their machine:

- **Read-only.** Nothing opens a file for write. The bench mount is `:ro`, so
  this is enforced by the kernel, not by good intentions.
- **Runs as a non-root user** (`node`, uid 1000) with no writable state.
- **The docker socket is never mounted.** `hub-db` connects to postgres over
  TCP. Handing a read-only dashboard control of the host docker daemon in order
  to read four tables is an absurd trade, so it isn't made.
- **Loopback-only by default; LAN access is opt-in** (see Remote viewing).
  Verified surface
  when exposed: `POST → 405`, traversal → `404`, non-allowlisted file → `404`,
  `touch /bench/…` → `Read-only file system`, container `uid=1000(node)`.
  Anyone already on the LAN can read gate ids, token counts and run metadata —
  no plaintext, no keys.
- **Tail-bounded reads** (256KB). A six-hour log costs the same as a fresh one.
- **Fixed static allowlist** — no dynamic path resolution, so traversal is
  impossible by construction.
- **`hub-db` ships disabled.** You do not need a database, docker, or any part
  of the Open Knowledge stack for the board to come up.
- **No CDN, no webfont fetch.** The board renders offline.
- **Privacy:** memory plaintext, raw queries and full CIDs never reach the
  board. `query_log.query_text` is never selected. Everything rendered is
  assumed public forever.

### What remote viewing trusts

It is a network boundary, not a login. The board publishes on one LAN address,
and refuses requests whose source address is public (`lib/net-policy.mjs`) —
but anyone who can reach that address is trusted, and in a container the
source the board sees is Docker's own gateway, so the publish address is the
real boundary. Writes must also be same-origin (no cross-site posts).

A **play preview** runs the built game on a separate port bound to every
interface with no checks, for as long as it runs.

---

## Palette — Midnight (why)

Arm identity is the spine of the board, so the two accents must survive stream
compression. Midnight is the one sanctioned Open Knowledge theme that is not a
single-hue ramp — it ships two accents on the same surface:

| Token | Hex | Role |
|---|---|---|
| `--accent` | `#82aaff` | **ARM A · memory on** |
| `--num` | `#f78c6c` | **ARM B · control** |
| `--danger` | `#ff6b6b` | failing gate — **never** an arm |
| `--check` | `#5ad27a` | resolved gate — **never** an arm |

The two arm accents differ in **luminance as well as hue** (L\*≈70 vs ≈68 with
opposed hue), so they survive 4:2:0 chroma subsampling at 720p, stay distinct in
greyscale, and read for viewers with red-green colour vision deficiency. Arm
identity is additionally carried in **words** (`MEMORY ON` / `CONTROL`), so the
board never depends on colour alone. Those words name the arms' only
distinction: `CONTROL` = the vanilla image (no plugin); `MEMORY ON` = the image
built with the plugin `BENCH_PLUGIN_DIR` points at.

Red and green are reserved for gate verdicts. An arm accent that reads as a
verdict is a lie.

## Type & motion

JetBrains Mono, system-loaded (no network). 14px floor, tabular figures
anywhere a number updates in place. No information requires hover.

**No ambient animation.** The board is up for hours; constant motion is
exhausting and reads as filler. State changes announce once (200ms) and settle.
The entire motion budget goes to the recall-moment takeover. `prefers-reduced-motion`
is honoured.

---

## Deliberate deviation: vanilla JS, not React

This is intentionally dependency-free vanilla JS rather than a single-file
React app, with the component structure preserved (pure render functions over
one state object). React from a CDN would make the board a blank page the
moment the network hiccups — unacceptable on a live stream, for zero benefit.
The contract still sits at the top of `index.html` as a comment.
