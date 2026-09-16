# bench

**A benchmark for measuring whether a memory system mitigates an LLM's
degradation over repeated learn-then-reinject runs of the same task.**

`bench` runs one task — build a working backgammon game — over and over with the
same model. A **memory OFF** baseline run has the model build from a stripped
scaffold; a **memory ON** run seeds the same task with what a prior run's memory
layer captured and stored. The measured question is whether re-injected memory
reduces context growth, turn count, and gate failures — against that model's own
floor, never against other models. The game is only the instrument; the subject
under test is the memory system.

## The four balance properties

1. **No answer sheet the model can see** — the gates, the golden reference, and
   the grader are absent from the worker's image and filesystem by construction,
   not hidden behind a filter.
2. **No internet** — the worker cell attaches only an internal Docker network
   with a fixed port allowlist; the grader runs `--network none`.
3. **Full runtime tooling** — Node, Playwright, Chromium, and git are all
   present in the worker image; only the answer is withheld.
4. **One-way observability** — the host looks in (SSE + sidecar ingress); the
   model cannot look out.

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
#    set BENCH_PLUGIN_DIR=<abs path to plugin tree> first to bake a plugin in
#    (the memory ON arm); unset, the worker build is vanilla (memory OFF).
.venv/bin/python scripts/rebuild_worker_image.py
.venv/bin/python scripts/rebuild_grader_image.py

# 4. preflight — prints GO with the exact launch command, or NO-GO naming the fix
.venv/bin/python scripts/bench_preflight.py --model <alias>

# 5. start the control plane (the only write-capable surface)
node control/server.mjs            # http://127.0.0.1:8718

# 6. start the read-only board (in another shell)
(cd dashboard && docker compose up -d)   # http://127.0.0.1:8717
```

Runs are started from the board (or `POST /api/run/start`). Each cell spawns the
canonical entrypoint `.venv/bin/python scripts/run_cumulative.py run --mode
off|on` — argv only, never a shell. `RUNBOOK.md` is the operative run card.

## Plug in a memory plugin

opencode IS the socket. Any memory system bolts on through opencode's own
plugin mechanism; the benchmark defines NO memory-system interface, NO
registry, and NO adapter. The entire integration surface is ONE "which
plugin" pointer plus this README:

- **`BENCH_PLUGIN_DIR`** — an absolute path to a plugin tree (a real npm
  package, built outside this repo). When it is set, the worker image build
  bakes that tree in, installed generically at `/opt/bench-plugin`; when it is
  unset, the build is VANILLA — no plugin at all. That is the whole memory
  ON/OFF distinction: the ON arm runs an image built with the plugin, the OFF
  baseline loads none.

The plugin tree does the memory system's work: capture learnings during the
build, then recall and reinject them into later cells. The harness itself
reinjects nothing; it measures the OFF/ON contrast.

**The plugin is built outside this repo** and supplied to a build via
`BENCH_PLUGIN_DIR`; nothing in this repo's public surface needs to know its
name.

## Custom tools

The board's tool drawer lists the benchmark's own tools and, optionally, tools
served by a separate custom-tools service — for example a memory system's own
operations. Point `BENCH_TOOLS_URL` at that service; unset, the drawer shows only
the benchmark's tools. The benchmark never consults the service for preflight or
for a run, so it runs the same whether the service is healthy, broken or absent.
The contract is in [CUSTOM-TOOLS.md](./CUSTOM-TOOLS.md).

## Repository layout

```
harness/    Python measuring instrument — sequencer, manifest, adapters, scoring,
            cell isolation, egress, image identity.
task/       The backgammon task — scaffold (stubs), golden (never shown), prompts.
grader/     report.mjs + the gate suite (conformance/backend/frontend) — the only
            component that sees the golden.
control/    Node control plane (server.mjs) — the only write-capable surface.
dashboard/  Read-only board (containerized) at :8717.
images/     worker/, grader/ Dockerfiles + sidecar/ (egress + loop-kill).
scripts/    Entrypoints: run_cumulative.py, rebuild_*_image.py, *_preflight.py.
config/     bench.env and the bench-owned env surface (see ENV-VARS.md).
tests/      The harness's own pytest suite — grades the instrument, not the candidate.
```

## Naming

`bench` / `BENCH_` / `bench-*` is the benchmark's own neutral identity — the
image names (`bench-worker:v1`, `bench-grader:<challenge>`), the env prefix, and the
harness package. Backend-specific tokens are deliberately absent from the
public surface: a memory plugin enters the tree only at build time, through
the `BENCH_PLUGIN_DIR` pointer, and the benchmark is generic over whatever
plugin an operator installs.

## Licence

MIT — see [LICENSE](./LICENSE).
