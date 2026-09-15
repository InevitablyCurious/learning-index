"""Canonical primary scored cumulative benchmark CLI.

This script is **THE** canonical primary scored cumulative path for Okp.
`scripts/run_aider_solve.py` (Path C) and `scripts/backgammon_scored_ladder.py`
are diagnostic/historical paths and are **not** the active primary path.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any, Callable

from harness import config
from harness.cumulative.progress import progress_from_cell_result
from harness.process_reaper import (
    ProcessReaper,
    run_reaper_unconditional,
)
from harness.snapshot import SnapshotError

# Re-imported INTO this namespace so the conductor functions below resolve their
# bare-name calls here — which is what makes ``monkeypatch.setattr(run_cumulative,
# "_build_context", ...)`` reach ``_handle_run`` (its __globals__ is this module).
from .context import (
    CliContext,
    _append_results_ledger,
    _build_context,
    _current_session_or_raise,
)
from .paths import (
    DEFAULT_MANIFEST_PATH,
    DEFAULT_ON_BUDGET,
    DEFAULT_ORG_ID,
    DEFAULT_PROXY_RUNS_DIR,
    DEFAULT_SEED,
    DEFAULT_TASK_LABEL,
    GATE_ROSTER_TIMEOUT_S,
    PROMPTS_DIR,
    REPO_ROOT,
    PathLayout,
    _mode_dir,
    _prune_runs_retention,
    _resolve_manifest_layout,
    _runs_root_from_args,
    _utc_now_iso,
)
from .roster import (
    _apply_model_override,
    _build_roster,
    _compose_cloud_slug,
    _normalize_model_slug,
    _provider_pin_from_model,
)
from .runner import (
    RealSessionRunner,
    _NoopSessionRunner,
    _SessionRunState,
    _build_real_runner,
    _read_proxy_served_identity,
    _resolve_positive_int_env,
)
from .template import (
    FROZEN_TASK_TEMPLATE_HASH,
    compute_task_template_hash,
    verify_task_template_frozen,
)

IS_PRIMARY_SCORED_PATH = True
_LOG = logging.getLogger("run_cumulative")


def _handle_run(args: argparse.Namespace) -> int:
    # Fail-open telemetry retention (data/ is a retention layer, never a source
    # of truth; a cleanup failure must never stop a run). Skip with
    # BENCH_SKIP_CLEANUP=1.
    try:
        if os.environ.get("BENCH_SKIP_CLEANUP", "") != "1":
            from cleanup_data import run_cleanup  # noqa: PLC0415 -- fail-open

            _removed = run_cleanup()
            _LOG.info("run_cumulative telemetry cleanup done; removed=%s", _removed)
    except Exception as _cleanup_exc:  # noqa: BLE001 -- fail-open, never break a run
        _LOG.warning(
            "run_cumulative telemetry cleanup failed (fail-open): %r", _cleanup_exc
        )

    validated_mode = str(getattr(args, "mode", "") or "").strip().lower() or None
    validated_org = str(getattr(args, "org", "") or "").strip()
    if validated_mode == "on" and not validated_org:
        raise RuntimeError(
            "--mode on requires --org <org>: an ON cell needs a target org. "
            "Pass --org <org> (provisioned by the production dashboard) or use --mode off."
        )

    context = _build_context(args, require_runtime=True)
    session = _current_session_or_raise(context.sequencer)
    mode_arg = str(getattr(args, "mode", "") or "").strip().lower() or None
    if mode_arg is not None and mode_arg != str(session.memory_mode):
        raise RuntimeError(
            f"--mode {mode_arg} requested but current cell is memory_mode={session.memory_mode}"
        )

    try:
        result = context.sequencer.step_until_done()
    except SnapshotError as exc:
        # WO-SNAP-04: an operator-facing refusal, not a bug. A refused seed
        # snapshot (absent, unreadable, model mismatch) ABORTS the run — it
        # never falls back to a scaffold build — and the operator gets one
        # clean line on stderr instead of a traceback. (Corpus-provenance
        # drift is not a refusal: D-SNAP-DEVMODE-EXCEPTIONS demoted it to a
        # reported warning.)
        # Exit 2 distinguishes the clean refusal from a crash (1). The
        # reaper/predicate/retention finally in main() runs on this path too.
        print(f"SEED SNAPSHOT REFUSED: {exc}", file=sys.stderr)
        return 2
    # step_until_done returns status:done (with convergence) or
    # status:halted_on_gate (measurement gate descriptor); gate failures
    # raise. Print the descriptor as-is.
    _print_json(result)
    # WO-43a: recompute the manifest layout for the ledger append — CliContext
    # carries only the sequencer, so `layout` is not in this scope. Pure
    # path resolution (mkdir lives in _build_context), so recomputing is safe.
    layout = _resolve_manifest_layout(
        str(getattr(args, "manifest", None) or DEFAULT_MANIFEST_PATH)
    )
    if result.get("status") == "done":
        # WO-43a: append the completed run's scored-cell records to the
        # HOST-side results ledger. The printed `result` carries only
        # {status, convergence}; the schema fields come from the scorecard
        # (run-manifest + status stream — the same authoritative seam the
        # done state itself sources from) and `runs/active-tree.json`.
        _append_results_ledger(args, layout)
    return 0


def _handle_state(args: argparse.Namespace) -> int:
    context = _build_context(args, require_runtime=False)
    _print_json(context.sequencer.state())
    return 0


def assert_primary_path() -> None:
    """Raise if this module is not marked as the canonical primary path."""

    if IS_PRIMARY_SCORED_PATH is not True:
        raise AssertionError("run_cumulative.py lost primary-path marker")

    primary_recall_mode = str(config.RunConfig().primary_recall_mode).strip().lower()
    if primary_recall_mode != "prod":
        raise AssertionError(
            "run_cumulative.py primary scored path requires RunConfig.primary_recall_mode='prod' "
            "(declared consumer policy; no hidden env auto-accept)"
        )


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run/state coordinator CLI for cumulative benchmark sequencing.",
    )
    parser.add_argument(
        "--manifest",
        default=str(DEFAULT_MANIFEST_PATH),
        help=(
            "Path to cumulative manifest JSON "
            f"(default: {DEFAULT_MANIFEST_PATH.as_posix()})."
        ),
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=DEFAULT_SEED,
        help=f"Deterministic schedule seed (default: {DEFAULT_SEED}).",
    )
    parser.add_argument(
        "--on-budget",
        type=int,
        default=DEFAULT_ON_BUDGET,
        help=f"ON-phase session budget (default: {DEFAULT_ON_BUDGET}).",
    )
    parser.add_argument(
        "--task",
        default=DEFAULT_TASK_LABEL,
        help="Logical task label used in manifest validation.",
    )
    parser.add_argument(
        "--org",
        default=None,
        help=(
            "Org id for the run; the org is provisioned by the "
            "production dashboard, not the bench. Required for ON cells "
            "(--mode on), no default."
        ),
    )
    parser.add_argument(
        "--roster-model",
        default=None,
        help=(
            "Optional case-insensitive model substring filter for roster selection "
            "(smoke/diagnostic aid; canonical benchmark runs unfiltered)."
        ),
    )
    parser.add_argument(
        "--model",
        default=None,
        help=(
            "Pin the run's subject to a named proxy bench alias present in "
            "WORKER_MODEL_REGISTRY (e.g. qwen3.6-35b-a3b-bench). The proxy makes "
            "that exact model resident on the first request (exclusive load on "
            "call); identity is still observed from API responses and recorded "
            "(RC-7). Omit to keep the neutral auto-resident slug. Changing the "
            "model changes the roster hash, which invalidates an existing "
            "manifest by design: archive runs/cumulative and rerun (RUNBOOK §0)."
        ),
    )
    parser.add_argument(
        "--seed-snapshot",
        dest="seed_snapshot",
        default=None,
        help=(
            "DEV-MODE seeding flag: start every cell from the captured "
            "snapshot <id> (under <runs>/snapshots/, runs root resolved via "
            "BENCH_RUNS_DIR else the repo's runs/) instead of the task "
            "scaffold, skipping the chunked build. The snapshot must have "
            "been authored by this run's model; a model mismatch (or an "
            "absent or unreadable snapshot) refuses the run outright (exit 2, "
            "'SEED SNAPSHOT REFUSED') and never falls back to a scaffold "
            "build. Corpus-identity drift does NOT refuse: the seed proceeds "
            "and the drift is reported as a warning. Seeded cells are "
            "recorded with dev_mode=true and are not comparable to unseeded "
            "floors."
        ),
    )
    parser.add_argument(
        "--cloud",
        action="store_true",
        default=False,
        help="Route the cell directly to a cloud provider (OrcaRouter) instead of the local relay proxy.",
    )
    parser.add_argument(
        "--router",
        default=None,
        help="Cloud router id for the composed model slug (default: orcarouter). Only used with --cloud.",
    )
    parser.add_argument(
        "--provider",
        default=None,
        help="Cloud vendor id (e.g. deepseek) — the '{provider}/{model}' key inside the OrcaRouter provider block. Only used with --cloud.",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser(
        "run",
        help="Build/resume manifest and step every scheduled session to done.",
    )
    run_parser.add_argument(
        "--mode",
        choices=["on", "off"],
        default=None,
        help=(
            "Validate the current cell's memory_mode matches on/off; errors if "
            "it does not. Does NOT restructure the schedule."
        ),
    )
    run_parser.add_argument(
        "--proxy-base-url",
        default=None,
        help=(
            "Explicit model base URL baked into worker container opencode.json "
            "(local mode only; cloud mode always uses the egress sidecar). "
            "Default resolves via BENCH_WORKER_SPEND_PROXY_BASE_URL "
            "env/.env, else the cell's per-run egress sidecar "
            "http://okp-egress-<hash>:4545/v1 derived from the run label."
        ),
    )
    run_parser.add_argument("--proxy-token-file", default=None)
    # ── CHUNK-BOUNDARY COMPACTION ───────────────────────────────────────────
    #
    # EXPLICIT ON BOTH SIDES, WITH NO DEFAULT HERE. The default belongs to the
    # control plane, which knows the model's context window and states its
    # choice in the confirmation the operator reads before START. If this flag
    # carried a default of its own there would be two rules deciding the same
    # thing, and the one the operator confirmed would not necessarily be the one
    # that ran. Omitting both flags leaves compaction OFF — the pre-2026-09-02
    # behaviour — so a hand-typed CLI invocation never acquires six extra model
    # turns it did not ask for.
    compact_group = run_parser.add_mutually_exclusive_group()
    compact_group.add_argument(
        "--compact",
        dest="compact",
        action="store_true",
        default=False,
        help=(
            "Compact the session at each chunk boundary (after every CHUNK "
            "FINISHED, including the last) and never during the repair phase. "
            "Trades spent build narration for room the troubleshooting phase "
            "needs. Costs one model turn per chunk, metered into the cell "
            "totals and reported separately."
        ),
    )
    compact_group.add_argument(
        "--no-compact",
        dest="compact",
        action="store_false",
        help="Run the build with no compaction at any boundary.",
    )

    # PLAN BEFORE WORK — a benchmark run-condition, off by default.
    #
    # OFF is the honest default because turning it on CHANGES WHAT THE AGENT
    # DOES: an agent made to plan before it edits may simply perform better, for
    # reasons that have nothing to do with memory. A run with it and a run
    # without it are not comparable, and the OFF floor has to be re-established
    # after a change. Nothing enforces it harness-side — a plugin honours the
    # exported REQUIRE_TODOS, or nothing happens.
    todos_group = run_parser.add_mutually_exclusive_group()
    todos_group.add_argument(
        "--require-todos",
        dest="require_todos",
        action="store_true",
        default=False,
        help=(
            "Refuse mutating tools until the agent has written a todo list "
            "(reading stays open). Requires a memory plugin that honours "
            "REQUIRE_TODOS; the harness only declares the condition."
        ),
    )
    todos_group.add_argument(
        "--no-require-todos",
        dest="require_todos",
        action="store_false",
        help="Let the agent work without planning first (the default).",
    )

    # ── MACHINE SHARE FOR GRADING ──────────────────────────────────────────
    #
    # NOT a measurement variable, unlike everything around it: it changes how
    # many test workers the GRADING container starts once the model is done,
    # and the gates and verdicts are identical either way. Held to that by
    # scripts/verify_worker_parity.py, which grades the golden at one worker
    # and at the maximum and requires them to agree gate for gate.
    #
    # A FRACTION, not a count: the container reads its own limits and works the
    # count out, so the same value fits any machine and nobody's hardware ends
    # up written into the code. The share is of what is FREE at grading time.
    run_parser.add_argument(
        "--grader-worker-target",
        dest="grader_worker_target",
        type=float,
        default=None,
        metavar="FRACTION",
        help=(
            "Share (0-1] of the grading container's FREE cpu and memory to use "
            "for test workers. Unset leaves the container's own default."
        ),
    )

    subparsers.add_parser("state", help="Print cumulative sequencer state summary.")

    return parser


def _print_json(payload: Any) -> None:
    print(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    )


def _discover_bench_ports() -> list[int]:
    """Ports the BENCH itself publishes and must clear at teardown.

    Only the live-view serve host port qualifies (RunConfig.serve_host_port,
    default 8719) — one persistent `opencode serve` per cell (WO-WATCH-1E),
    asserted clear so a leaked serve is caught. The hub (:4440) and MCP recall
    client (:4550) are STANDING infra owned outside the bench (card §7: the
    hub is the ONE hub, normally already running); asserting them clear was a
    guaranteed false alarm on every run (2026-08-09).
    """
    rc = config.RunConfig()
    if rc.serve_host_port > 0:
        return [rc.serve_host_port]
    return []


def _emit_predicate_outcomes(args: argparse.Namespace) -> str:
    """Publish this run's graded gates as predicate outcome records.

    Rides the same unconditional exit path as the reaper and the retention
    prune, so a run that dies halfway still publishes the gates it DID grade.
    Non-fatal by construction: emission failing must never change a run's
    outcome, and a run that produced no graded gates simply has nothing to say.
    """
    try:
        from harness.outcomes.predicate_emitter import emit_for_run

        manifest = Path(str(getattr(args, "manifest", None) or DEFAULT_MANIFEST_PATH))
        run_dir = manifest.expanduser().resolve().parent
        if not (run_dir / "manifest.status.jsonl").is_file():
            return f"skipped: no status stream under {run_dir}"
        summary = emit_for_run(run_dir)
        return (
            f"wrote={summary['records_written']} "
            f"counts={summary['counts']} "
            f"binding={summary['state_binding_counts']} "
            f"out={summary['out_path']}"
        )
    except Exception as exc:  # noqa: BLE001 - never fail a run over telemetry
        return f"failed: {type(exc).__name__}: {exc}"


def main() -> int:
    assert_primary_path()
    parser = _build_arg_parser()
    args = parser.parse_args()

    # R-37 no-silent-ops: configure root logging so harness PROGRESS lines are
    # actually emitted on the run/resume paths. Without this, no basicConfig
    # exists, so every _LOG.info (including the adapter's worker-nonzero
    # stderr_tail diagnostics) was silently dropped. Logs go to stderr;
    # machine-readable results stay on stdout (_print_json).
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    handlers: dict[str, Callable[[argparse.Namespace], int]] = {
        "run": _handle_run,
        "state": _handle_state,
    }
    handler = handlers.get(str(args.command))
    if handler is None:
        raise RuntimeError(f"unsupported command: {args.command!r}")

    # RC-6 / D-NO-REAPER: the reaper runs UNCONDITIONALLY on every exit path of
    # a MUTATING command — normal return, exception (failure), and
    # KeyboardInterrupt (operator interrupt). A silent reaper is not a reaper.
    # It is a safety net wrapper only: it must not alter the handler's return
    # value or exit code. Read-only commands (state) spawn no workers and are
    # never reaped — a read-only `state` must not tear anything down
    # (2026-08-09: it ran a compose down against an unrelated project).
    mutating = {"run"}
    if str(args.command) not in mutating:
        return handler(args)
    try:
        run_label = getattr(args, "task", None) or "bench"
        bench_ports = _discover_bench_ports()
        reaper = ProcessReaper(run_label=run_label, bench_ports=bench_ports)
        return handler(args)
    finally:
        _LOG.info("process_reaper: unconditional reap entering finally")
        report = run_reaper_unconditional(reaper)
        _LOG.info(
            "process_reaper: run_label=%s killed_count=%d ports=%s "
            "cell_containers_removed=%s ok=%s",
            report.run_label,
            report.killed_count,
            report.ports,
            report.cell_containers_removed,
            report.ok,
        )
        _LOG.info("predicate_outcomes: %s", _emit_predicate_outcomes(args))
        # Runs/ retention prune (Walter 2026-08-10): rides the same
        # unconditional exit path as the reaper, so every early-cancelled
        # run's predecessor debris is bounded at latest+1 while the failed
        # run's own logs survive for post-mortem. Non-fatal by construction.
        _LOG.info(
            "runs_retention: %s", _prune_runs_retention(_runs_root_from_args(args))
        )
