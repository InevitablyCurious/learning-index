"""Append-only HOST-side results ledger for completed scored runs.

WO-43a: after a cumulative run reaches terminal-complete (``step_until_done``
returning ``status == "done"``), ONE JSONL record is appended per completed
scored cell (ConvergencePoint) to ``<bench_root>/data/results-ledger.jsonl``.

Invariants:
- Append-only: never truncates, rewrites, or compacts prior lines. Records
  accumulate across runs; ``run_id`` + ``sequence_index`` are the join keys.
- HOST-side ONLY: the ledger lives under ``data/`` OUTSIDE ``runs/`` and must
  NEVER be mounted into a cell or proxied by the egress sidecar
  (``harness/egress.py``) — in-cell code must never see scored results.
- Results are data, never committed (gitignored in okp-bench/.gitignore).
- Torn-line-safe writer, matching ``StatusStream.append``: compact sorted-key
  JSON + newline, flush + fsync per record; readers skip unparseable lines.
- None-honest: a field is None when its source does not carry it — never
  zero-filled (``tree_id`` on the legacy flat layout, ``org_id``/``recall``
  on OFF cells, ``gate_totals``/``verdict`` when the stream lacks the record).
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import re
from typing import Any, Mapping

from .run_artifacts import StatusStream

_LOG = logging.getLogger(__name__)

LEDGER_RELATIVE_PATH = ("data", "results-ledger.jsonl")

# The recall-yield subset of the status-stream ``progress`` dict
# (ProgressVector.to_dict fields). Fixed tuple: no invented metrics — the
# ledger mirrors exactly what the cell published.
RECALL_FIELDS = (
    "recall_fired_total",
    "recall_returned_total",
    "recall_returned_count_sum",
    "no_keywords_count",
    "served_attempted",
    "served_failed",
    "served_confirmed",
    "recall_return_rate",
    "inject_yield",
    "serve_success_rate",
)


def utc_now_iso() -> str:
    """House UTC timestamp: second precision, ``Z`` suffix."""
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def read_tree_id(bench_root: str | os.PathLike[str]) -> str | None:
    """Read ``runs/active-tree.json``'s ``active`` id READ-ONLY.

    Mirrors ``scripts/bench_preflight.py:_read_tree_pointer``: an ABSENT
    pointer is the legacy flat layout (returns None — honest absence); a
    present-but-unreadable or malformed one raises, never guesses, so a
    corrupt pointer cannot stamp ambiguous tree ids onto records.
    """
    pointer = Path(bench_root) / "runs" / "active-tree.json"
    if not pointer.exists():
        return None
    try:
        raw = json.loads(pointer.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"active-tree.json present but unreadable: {exc}") from exc
    active = raw.get("active") if isinstance(raw, Mapping) else None
    active = str(active) if active is not None else ""
    if not re.fullmatch(r"\d{9,11}", active):
        raise ValueError(f"active={active!r} is not a unix-seconds tree id")
    return active


def build_run_records(
    tree_id: str | None,
    task: str,
    scorecard: Mapping[str, Any],
    status_stream_path: str | os.PathLike[str],
    *,
    timestamp: str | None = None,
) -> list[dict[str, Any]]:
    """Build the ledger records for one completed run. Pure — no fs writes.

    Joins each scored convergence point (the cells that entered the trend) to
    that cell's LAST ``type=="attempt"`` record in the status stream, which
    carries the final verdict/gate_totals for the cell. A point with no
    attempt record is skipped with a warning (it cannot be attributed to an
    arm), never synthesized.
    """
    manifest = scorecard.get("manifest")
    if not isinstance(manifest, Mapping):
        raise ValueError("scorecard manifest missing or not an object")
    convergence = scorecard.get("convergence")
    points = convergence.get("points") if isinstance(convergence, Mapping) else None
    if not isinstance(points, list):
        raise ValueError("scorecard convergence.points missing or not a list")

    # Last attempt record per cell: later records overwrite earlier ones, so
    # the survivor is the cell's terminal attempt.
    attempt_by_seq: dict[int, Mapping[str, Any]] = {}
    for record in StatusStream(status_stream_path).records():
        if record.get("type") != "attempt":
            continue
        seq = record.get("sequence_index")
        if seq is None:
            continue
        attempt_by_seq[int(seq)] = record

    run_id = manifest.get("run_id")
    model = manifest.get("requested_model") or manifest.get("served_model")

    built: list[dict[str, Any]] = []
    for point in points:
        if not isinstance(point, Mapping):
            continue
        seq_raw = point.get("sequence_index")
        if seq_raw is None:
            continue
        seq = int(seq_raw)
        attempt = attempt_by_seq.get(seq)
        if attempt is None:
            _LOG.warning(
                "results_ledger.no_attempt_record sequence_index=%d run_id=%s",
                seq,
                run_id,
            )
            continue
        arm = str(attempt.get("memory_mode") or "")
        progress = attempt.get("progress")
        progress = progress if isinstance(progress, Mapping) else None
        built.append(
            {
                "tree_id": tree_id,
                "run_id": run_id,
                "task": task,
                # Per-cell org: null on the OFF baseline by definition (the
                # OFF arm targets no memory org); the stream's org_id on ON.
                "org_id": attempt.get("org_id") if arm == "on" else None,
                "model": model,
                "arm": arm,
                "sequence_index": seq,
                "verdict": attempt.get("verdict"),
                "attempts_to_green": point.get("attempts_to_green"),
                "problems_before": point.get("problems_before"),
                "problems_after": point.get("problems_after"),
                "full_green": bool(point.get("full_green", False)),
                "gate_totals": attempt.get("gate_totals"),
                "turns": point.get("turns"),
                "tokens": point.get("total_tokens"),
                "wall_seconds": point.get("wall_seconds"),
                "wall_cost_usd": point.get("wall_cost_usd"),
                # recall: the recall-yield sub-dict on an ON cell; None (not a
                # dict of nulls) on an OFF cell — OFF progress carries these
                # fields as None by construction.
                "recall": (
                    {field: progress.get(field) for field in RECALL_FIELDS}
                    if arm == "on" and progress is not None
                    else None
                ),
                "session_fp": point.get("session_fp"),
                "session_id": attempt.get("session_id"),
                "timestamp": timestamp if timestamp is not None else utc_now_iso(),
            }
        )
    return built


def append_run_records(
    bench_root: str | os.PathLike[str],
    tree_id: str | None,
    task: str,
    scorecard: Mapping[str, Any],
    status_stream_path: str | os.PathLike[str],
) -> list[dict[str, Any]]:
    """Build the run's records and append them to the host-side ledger.

    House torn-line-safe append (``StatusStream.append`` pattern): one compact
    sorted-key JSON line per record, append-mode open, flush + fsync each.
    """
    records = build_run_records(
        tree_id=tree_id,
        task=task,
        scorecard=scorecard,
        status_stream_path=status_stream_path,
    )
    ledger_path = Path(bench_root).joinpath(*LEDGER_RELATIVE_PATH)
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    for record in records:
        line = json.dumps(record, sort_keys=True, separators=(",", ":"))
        with open(ledger_path, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
            handle.flush()
            os.fsync(handle.fileno())
    return records


__all__ = [
    "LEDGER_RELATIVE_PATH",
    "RECALL_FIELDS",
    "append_run_records",
    "build_run_records",
    "read_tree_id",
    "utc_now_iso",
]
