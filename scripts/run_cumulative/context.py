"""CLI context assembly: CliContext, _build_context, session/ledger helpers.

Split out of ``scripts/run_cumulative.py`` (LI-14). These are re-imported into
the package facade (``__init__.py``) so ``_handle_run``'s bare-name calls
resolve there and ``monkeypatch.setattr(run_cumulative, "_build_context", ...)``
reaches ``_handle_run``.
"""

from __future__ import annotations

import argparse
import logging
from typing import NamedTuple

from harness import config
from harness.cumulative.run_artifacts import (
    build_scorecard,
    default_status_stream_path,
)
from harness.cumulative.run_context import collect_run_context, compare_run_context
from harness.cumulative.results_ledger import append_run_records, read_tree_id
from harness.cumulative.sequencer import CumulativeSequencer
from harness.cumulative.types import SessionRecord

from .paths import (
    DEFAULT_ORG_ID,
    PROMPTS_DIR,
    REPO_ROOT,
    PathLayout,
    _resolve_manifest_layout,
)
from .roster import _build_roster, _compose_cloud_slug
from .runner import _NoopSessionRunner, _build_real_runner
from .template import compute_task_template_hash

_LOG = logging.getLogger("run_cumulative")


class CliContext(NamedTuple):
    sequencer: CumulativeSequencer


def _build_context(args: argparse.Namespace, *, require_runtime: bool) -> CliContext:
    # Card §2: --org is first-class; when omitted, every command falls back to
    # the campaign default org. Centralised here so all subcommands (run,
    # state, ...) resolve identically — previously str(None) reached
    # the sequencer and `state` without --org died on a false org-drift error
    # (2026-08-09). The ON-cell requirement (--mode on requires an explicit
    # --org) is enforced in _handle_run BEFORE this fallback is applied.
    if not str(getattr(args, "org", "") or "").strip():
        args.org = DEFAULT_ORG_ID
    layout = _resolve_manifest_layout(str(args.manifest))
    layout.runs_dir.mkdir(parents=True, exist_ok=True)

    roster_model_filter = str(getattr(args, "roster_model", "") or "").strip() or None
    model_override = str(getattr(args, "model", "") or "").strip() or None
    cloud_slug = _compose_cloud_slug(args)
    roster, _ = _build_roster(
        roster_model=roster_model_filter,
        model_override=model_override,
        cloud_slug=cloud_slug,
    )
    config_fingerprint = config.ladder_roster_fingerprint()

    if require_runtime:
        runner = _build_real_runner(args, layout, cloud_slug=cloud_slug)
    else:
        runner = _NoopSessionRunner()

    # THE ROSTER FOR THE LIVE STREAM'S `run.start`, stamped where the roster
    # actually is. The adapter grades ONE cell and has no idea what campaign it
    # belongs to — same reason `_cell_seq` is stamped rather than constructed.
    # An attribute, so a runner that predates the live stream still works, and
    # `_NoopSessionRunner` takes it just as happily.
    runner._campaign_roster = [
        str(getattr(entry, "model", "") or "") for entry in (roster or [])
    ] or None

    current_run_context = collect_run_context()

    sequencer = CumulativeSequencer(
        manifest_path=str(layout.manifest_path),
        runner=runner,
        roster=roster,
        seed=int(args.seed),
        task=str(args.task),
        org_id=str(args.org),
        config_fingerprint=config_fingerprint,
        on_budget=int(args.on_budget),
        run_context=current_run_context,
        chunk_plan_hash=compute_task_template_hash(PROMPTS_DIR)
        or "",
        sequence_index=args.sequence_index,
    )
    recorded_run_context = getattr(getattr(sequencer, "_manifest"), "run_context", None)
    drift = compare_run_context(recorded_run_context, current_run_context)
    if drift:
        _LOG.warning("op=run_context.drift differing_keys=%s", ",".join(drift))
    return CliContext(
        sequencer=sequencer,
    )


def _current_session_or_raise(sequencer: CumulativeSequencer) -> SessionRecord:
    session = sequencer.current_session()
    if session is None:
        raise RuntimeError("sequencer is done; no current session")
    return session


def _append_results_ledger(args: argparse.Namespace, layout: PathLayout) -> None:
    """Fail-open host-side ledger append for one terminal-complete run.

    The ledger is instrumentation. A failure appends no records and logs —
    it never breaks a finished run.
    """
    bench_root = REPO_ROOT
    try:
        scorecard = build_scorecard(str(layout.manifest_path))
        count = len(
            append_run_records(
                bench_root=bench_root,
                tree_id=read_tree_id(bench_root),
                task=str(args.task),
                scorecard=scorecard,
                status_stream_path=default_status_stream_path(
                    str(layout.manifest_path)
                ),
            )
        )
    except Exception as exc:  # noqa: BLE001 -- fail-open, never break a finished run
        _LOG.error(
            "run_cumulative.results_ledger_append_failed error_type=%s",
            type(exc).__name__,
        )
        return
    _LOG.info(
        "run_cumulative.results_ledger_appended records=%d run_id=%s",
        count,
        str((scorecard.get("manifest") or {}).get("run_id") if scorecard else ""),
    )
