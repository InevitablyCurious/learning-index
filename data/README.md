# bench telemetry sink (`data/`)

This directory is the host-side, retained home for run telemetry produced by the
The Open Knowledge Project plugin during a bench campaign.

## Purpose
The plugin writes its funnel counters and error log into state dirs that are
torn down with the cell: ON-arm cells write their state inside the worktree
under `.okp/state`, while OFF-arm cells write to a blind mount OUTSIDE the
worktree (host `<cell>/extraction-state`, container `/okp-state`), so the
blinded cell's extraction state never lands inside the worktree its model
reads. `data/` gives the campaign a durable, timestamped, auto-cleaned home
for per-cell observable recall surface (funnel snapshot + plugin log) so it
survives teardown and disk stays bounded.

## Layout
- `data/cells/` — one subdirectory per cell, named `<unix_ts>-<run_label>/`,
  holding that cell's exported `funnel-snapshot.json` and `plugin-errors.log`.
- `data/extract/` — extraction-stage telemetry artifacts (**placeholder** — no producer writes here today; the in-session extraction capture lives in the per-cell state dir at `insession/master.json`, exported into `data/cells/<ts>-<run_label>/insession/`).

## How data propagates
At cell end the harness copies the cell's `funnel-snapshot.json` and the
worktree's `.okp/logs/okp-plugin-errors.log` into
`data/cells/<unix_ts>-<run_label>/` (`_export_cell_telemetry` in
`harness/adapters/backgammon.py`), before the container is torn down. The
funnel snapshot is read from the worktree's `.okp/state` for ON cells and
from the blind mount (`<cell>/extraction-state`) for OFF cells. It runs
for BOTH arms — OFF is the baseline ON is compared against. Fail-open: a missing
surface is a no-op, an unwritable sink is logged and swallowed; export never fails
a cell.

## Retention
Entries directly under `data/cells/` and `data/extract/` older than **7 days**
are deleted by `scripts/cleanup_data.py`, which is wired fail-open into the run
entrypoint (`scripts/run_cumulative.py::_handle_run`). Retention runs at the
start of each run and can be skipped with `OKP_BENCH_SKIP_CLEANUP=1`.

## Source of truth
`data/` is a TELEMETRY/RETENTION layer only — NEVER a competing source of truth.
`runs/` remains the authoritative source for the run manifest and status stream.
This directory never touches or duplicates `runs/` content — with ONE deliberate
exception: on tree reset, the control plane archives
`data/results-ledger.jsonl` into `runs/backups/<ts>/` alongside the tree and
starts a fresh empty ledger (`control/server.mjs`).