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

One-time install, two image builds, then a control plane and a board:

```bash
# 1. install the harness (once)
python -m venv .venv && . .venv/bin/activate && pip install -e '.[test]'

# 2. build the worker and grader images (a run refuses without them)
.venv/bin/python scripts/rebuild_worker_image.py
.venv/bin/python scripts/rebuild_grader_image.py

# 3. preflight — prints GO with the exact launch command, or NO-GO naming the fix
.venv/bin/python scripts/bench_preflight.py --model <alias>

# 4. start the control plane (the only write-capable surface)
node control/server.mjs            # http://127.0.0.1:7718

# 5. start the read-only board (in another shell)
(cd dashboard && docker compose up -d)   # http://127.0.0.1:7717
```

Runs are started from the board (or `POST /api/run/start`). Each cell spawns the
canonical entrypoint `.venv/bin/python scripts/run_cumulative.py run --mode
off|on` — argv only, never a shell. `RUNBOOK.md` is the operative run card.

## Plug in a memory backend

The benchmark is memory-agnostic. A memory system registers as one row in
`control/memory-backends.mjs`:

```js
{ id, label, blurb, env() }
```

- `id` — what the board and preflight agree to call it.
- `label` — what an operator reads.
- `blurb` — one line describing it.
- `env()` — a function returning the run environment the backend needs. It
  resolves the backend's plugin directory (`BENCH_PLUGIN_DIR`) and its standing
  record mandate (`BENCH_AGENTS_AUX_FILE`) from the operator's own installation,
  and may return `{}` when the values cannot be resolved — that is a preflight
  refusal, never an error here.

The plugin tree does the backend's work: capture learnings during the build,
then recall and reinject them into later cells over the `BENCH_MCP_RECALL_URL`
seam. The harness itself reinjects nothing; it measures the OFF/ON contrast.

**The reference backend is OKP/TOKP, and it lives outside this repo.** It is
supplied to a build via `BENCH_PLUGIN_DIR`; nothing in this repo's public
surface needs to know its name.

## Repository layout

```
harness/    Python measuring instrument — sequencer, manifest, adapters, scoring,
            cell isolation, egress, image identity.
task/       The backgammon task — scaffold (stubs), golden (never shown), prompts.
grader/     report.mjs + the gate suite (conformance/backend/frontend) — the only
            component that sees the golden.
control/    Node control plane (server.mjs) — the only write-capable surface.
dashboard/  Read-only board (containerized) at :7717.
images/     worker/, grader/ Dockerfiles + sidecar/ (egress + loop-kill).
scripts/    Entrypoints: run_cumulative.py, rebuild_*_image.py, *_preflight.py.
config/     bench.env and the bench-owned env surface (see ENV-VARS.md).
tests/      The harness's own pytest suite — grades the instrument, not the candidate.
```

## Naming

`bench` / `BENCH_` / `bench-*` is the benchmark's own neutral identity — the
image names (`bench-worker:v1`, `bench-grader:v1`), the env prefix, and the
harness package. Backend-specific tokens (`okp`, `tokp`) are deliberately absent
from the public surface: the one place a backend's name enters the tree is its
registry row in `control/memory-backends.mjs`, and even that is generic over
whatever backend an operator installs.

## Licence

MIT — see [LICENSE](./LICENSE).
