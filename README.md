# bench

**A benchmark for measuring the information delta of a memory system.**

Not how clever a model is. Not pass@1. This measures how much a memory system's
accumulated knowledge is actually worth to a given model on a controlled task —
and the point at which more knowledge stops being worth anything.

## The idea

Memory systems are not interchangeable. Most store **preferences** ("this user
indents with tabs"). Some store preferences plus solutions. Very few store
**durable solutions** — knowledge about a hard problem that transfers to a later
attempt and changes how that attempt goes.

The Open Knowledge Project records knowledge as durable solutions, so the
benchmark measures the thing that category is *for*: does carrying a solved
problem forward make the next attempt measurably better?

A preference-store measured this way will show a flat delta. That is a correct
result, not a broken run.

## What "information delta" means

Run the **same model** at the **same task**, over and over, giving it more
accumulated knowledge each time. Early iterations get better. At some point they
stop getting better and start getting worse — more knowledge becomes more
noise to carry.

**That turning point is the information delta** for that model on that memory
system. It is the answer this benchmark exists to produce.

## The loop

```
OFF   run the task with no memory
      -> the baseline, and the raw material

EXTRACT
      harvest what the session learned as durable knowledge:
      negative (do-NOT-do: the dead ends, the things that broke)
      positive (do-this: what worked and is worth repeating)
      every record carries what was done, why, and grounded evidence

ON    same model, same task, knowledge injected
      -> did it get better?

           less context used?   fewer turns?
           faster?              better results?

      still improving  -> run ON again with the larger corpus
      degrading        -> STOP. That is the delta.
```

The knowledge is **failures-to-green**: the struggle from a failing state to a
passing one, captured from the session record rather than authored by hand.

## Why this is a fair measurement

**Every model is its own control.** The same model runs both arms, so anything
constant about that model — its context window, its speed, its raw ability —
cancels out of its own delta. There is one OFF baseline per model in the roster,
and an ON schedule that deliberately repeats models.

This is why the benchmark does **not** compare models against each other on raw
score. It compares *deltas*. "Model A scored higher than model B" is not a result
this instrument produces. "Model A saturated after four iterations, model B after
seven" is.

**The injected block is fixed, not proportional.** Memory is injected under a
fixed character budget (currently 8,000 characters, roughly 2,000 tokens),
identical for every model. A model with a million-token window and a model with
two hundred thousand receive the same injection. Window size does not buy a model
more memory.

Together these are why the model picker offers **every** model the provider
lists, including narrow-context ones. A narrow window does not bias a
self-paired delta. What it risks is the run hitting the provider's context
ceiling mid-cell — a runnability caveat, surfaced as a badge on the model, not a
reason to hide it. (OpenCode fires emergency compaction at 95% so the provider
does not hard-error; compaction is not enabled here by default, and a compacted
run measures something different.)

## Substrate-neutral by intent

The design goal is that **anyone can plug in any provider and any memory system**
and measure the same thing.

- **Provider** — the model roster is generated from a provider catalogue.
  OrcaRouter is pinned as the default so a public checkout runs without
  configuration, but it is a default, not a requirement.
- **Memory system** — recall reaches the worker over a URL seam
  (`OKP_BENCH_MCP_RECALL_URL`), so a different memory system can answer instead.
  **Today that means implementing this project's recall contract.** The former
  `MemoryBackend` adapter abstraction is retired (removed in the 2026-09-03
  cleanup), so the seam is wider than an adapter interface. This is the largest gap between the stated
  goal and the current implementation, and it is stated here rather than implied.

## What the instrument records

Per session, in the convergence trend:

| Signal | Reads on |
|---|---|
| `total_tokens` | less context? |
| `turns`, `agentic_cycles`, `tool_calls` | fewer turns? |
| `wall_seconds`, `wall_cost_usd` | faster, cheaper? |
| `full_green`, `attempts_to_green`, `resolved_count` | better results? |

The trend is **derived read-only** — it is computed from checkpointed session
records and never mutates them. It reports the curve; today an operator reads the
turn off it. There is no automatic stop when results degrade.

## How you drive it

**One command, then the browser.** From `dev/`:

```bash
make up
```

That starts the stack, the bench dashboard, the control plane and the bench MCP,
and prints the board's URL. It is idempotent and **non-destructive** — every step
no-ops if that piece is already running.

> `make redeploy` is a different thing: it **wipes** the chain, database and
> vector store before rebuilding. Reach for it when you mean it. Never reach for
> it to restart a service mid-campaign.

Everything else happens on the board at `http://127.0.0.1:7717`: setting a router
key, choosing a model, starting a cell, stopping one, resetting the tree,
re-commissioning the MCP, rebuilding the worker image.

### Two services, two trust levels

This split is deliberate and load-bearing:

| | Port | What it is |
|---|---|---|
| **Board** | 7717 | A container. GET-only, the bench mounted read-only, no Docker socket, unprivileged user. |
| **Control plane** | 7718 | A host process. The only thing that can change anything — it spawns the harness, which drives Docker. |

Those are kernel-enforced properties, not conventions. Run artifacts *are* the
measurement, so "the dashboard corrupted a run" is made impossible rather than
unlikely. The board renders; the control plane acts; your browser talks to both.

**Do not merge them.** Putting run controls in the read-only viewer would destroy
the guarantee. Containerising the control plane would mean handing a container
the Docker socket — effectively host root — which is the same guarantee lost from
the other direction. This is the same shape Jupyter, MLflow and Dagster use: a
local daemon owns execution, the browser is the interface.

### The board is the interface

If something can only be done from a terminal, that is a defect. An operator sent
to a shell for one capability ends up running everything from there, and the
board stops being trusted. Concretely, all of these are on the board:

- **Routers** — set or replace a router API key. Shows `NO API KEY SET` with every
  location that was checked, rather than a disabled button with no reason.
- **Preflight** — the same GO/NO-GO the CLI prints, rendered from the same script.
- **Stop cell** — abort a run in flight. The harness is interrupted so it tears
  down its own worker, sidecar and volume. A stopped cell writes no progress, so
  it is excluded from the convergence trend and can never be read as a result.
- **Operations** — re-commission the bench MCP, rebuild the worker image. Both
  refuse while a cell is live, because changing the substrate mid-measurement
  produces a result that looks valid and is not.

## Build-snapshot reuse — a development feature

Every baseline run **automatically captures** its finished worktree as a build
snapshot the moment attempt 1's grade lands (`capture_snapshot`,
`bench/snapshot.py`; boundary at `bench/adapters/backgammon.py:3079-3080`). The
snapshot is the whole worktree, verdict-blind — the gate tally rides along as
identity metadata, never a selection filter.

Reusing one is a **development** capability behind a dev-mode toggle that is
control-plane state, never browser state: `GET`/`POST /api/devmode`
(`control/server.mjs:1076`, `:1086`), resolved env → state file → default OFF
(`control/devmode.mjs:75-162`). A topbar marker shows while it is on.

Seeding a cell from a snapshot skips the build and starts at the first
troubleshooting round (`--seed-snapshot <id>`,
`scripts/run_cumulative.py:1878`; board step "Seed from a build snapshot?",
`dashboard/panels/create.js:630`). The confirm frame carries the load-bearing
caution — **"SEEDED FROM A BUILD SNAPSHOT — NOT A SCORABLE FLOOR"**
(`dashboard/panels/snapshot.js:268`).

**A seeded cell is never a scorable floor.** It folds `scorable:false` with a
stated reason (`control/baselines.mjs:467`, `:501-519`) and is excluded from the
transfer curve's baseline (`dashboard/sources/stack-ledger.mjs:198`). It is a
fast-iteration tool, not a measurement.

Dev-mode validity exception: a snapshot whose `source_commit` / corpus identity
drifted from the running corpus **seeds anyway**, the drift reported as a warning
rather than a refusal (`bench/snapshot.py:192-208`). Absent, unreadable, or
model-mismatched snapshots still refuse loudly and never fall back to a scaffold
build.

## Running it

`RUNBOOK.md` is the operative document for actually running a campaign — ports,
preflight, launch, wipe, and the rules that bind a scored run. Start there.

Quick check that the harness itself is sound:

```bash
python -m venv .venv && . .venv/bin/activate && pip install -e '.[test]'
python -m pytest -q
```

Preflight before any real run — it checks ports, asserts the bench identity at
the seam, and prints either GO with the exact launch command or NO-GO naming the
fix:

```bash
.venv/bin/python scripts/bench_preflight.py --model <alias>
```

## Integrity commitments

- **Self-paired.** Both arms of a comparison are the same model on the same
  fixture. A delta between two different models is not a result.
- **Delivery-verified.** With `require_delivery_verification`, an ON cell whose
  memory delivery cannot be confirmed is `not_scored` — never scored as a null
  result.
- **Reproducible.** The RNG seed is pinned; scorecards embed the full config,
  seed, harness version and a timestamp manifest.
- **Honest absence.** Unavailable means `None`, never silently zero. A missing
  measurement is excluded from aggregates rather than counted as nothing.
- **Generated, not hand-kept.** The provider roster mirrored into the control
  plane is generated (`scripts/sync_cloud_roster.py`). A hand-maintained mirror
  drifted once already, offering models that had been withdrawn upstream.

## Licence

MIT — see [LICENSE](./LICENSE).
