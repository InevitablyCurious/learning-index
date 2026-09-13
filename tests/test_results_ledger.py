"""WO-43a: results-ledger record shape + append behavior.

Builds a synthetic scorecard (real RunManifest / ConvergencePoint to_dict()
shape) plus a real StatusStream of per-cell attempt records, then asserts the
emitted JSONL line's exact fields: the OFF cell carries arm=="off",
recall is None (not a dict of nulls), org_id is None; the ON cell carries a
populated recall sub-dict (the recall-yield fields of the published progress)
and its per-cell org_id. No metrics are invented: every value flows from the
same surfaces a real run publishes.
"""

from __future__ import annotations

import json
from pathlib import Path
import re
from typing import Any

from harness.cumulative.convergence import ConvergencePoint
from harness.cumulative.progress import progress_from_cell_result
from harness.cumulative.results_ledger import (
    RECALL_FIELDS,
    append_run_records,
    build_run_records,
    read_tree_id,
)
from harness.cumulative.run_artifacts import (
    RunManifest,
    StatusStream,
    default_status_stream_path,
)


def _manifest_to_dict() -> dict[str, Any]:
    return RunManifest(
        run_id="run-ledger-test",
        created_at="2026-08-29T12:00:00Z",
        served_model=None,
        requested_model="local/test-model",
        memory_mode="mixed",
        org_id="okp-org-0",
    ).to_dict()


def _point(sequence_index: int, session_fp: str) -> ConvergencePoint:
    return ConvergencePoint(
        sequence_index=sequence_index,
        session_fp=session_fp,
        problems_before=3,
        problems_after=1,
        resolved_count=2,
        remaining_count=1,
        full_green=True,
        attempts_to_green=2,
        turns=7,
        total_tokens=900,
        wall_seconds=12.5,
        wall_cost_usd=0.25,
        tool_calls=None,
        test_invocations=None,
        agentic_cycles=None,
    )


def _off_telemetry() -> dict[str, Any]:
    """BackgammonCellResult-shaped telemetry with NO recall fields (OFF cell)."""
    return {
        "problems_before": 3,
        "problems_final": ["problem-1"],
        "resolved_count": 2,
        "remaining_count": 1,
        "attempts_to_green": 2,
        "turns": 7,
        "input_tokens": 400,
        "output_tokens": 500,
        "total_tokens": 900,
        "wall_seconds": 12.5,
        "wall_cost_usd": 0.25,
        "verdict": "PASS",
        "termination_reason": "verdict_composed",
    }


def _on_telemetry() -> dict[str, Any]:
    """OFF telemetry plus the recall funnel an ON cell publishes."""
    return {
        **_off_telemetry(),
        "recall_fired_total": 4,
        "recall_returned_total": 3,
        "recall_returned_count_sum": 5,
        "no_keywords_count": 1,
        "injected_count": 2,
        "served_attempted": 3,
        "served_failed": 1,
        "served_confirmed": 2,
    }


def _write_attempt_records(
    manifest_path: Path,
    records: list[dict[str, Any]],
) -> str:
    stream_path = default_status_stream_path(str(manifest_path))
    stream = StatusStream(stream_path)
    for record in records:
        stream.append(record)
    return stream_path


def _scorecard(points: list[ConvergencePoint]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "manifest": _manifest_to_dict(),
        "convergence": {
            "schema_version": 1,
            "points": [point.to_dict() for point in points],
            "sessions_completed": len(points),
            "sessions_green": sum(1 for p in points if p.full_green),
            "resolved_total": 2,
            "tokens_total": sum(p.total_tokens for p in points),
            "wall_seconds_total": 12.5,
            "wall_cost_usd_total": 0.25,
            "trend_hash": "deadbeef",
        },
    }


def test_off_cell_record_shape(tmp_path: Path) -> None:
    manifest_path = tmp_path / "manifest.json"
    stream_path = _write_attempt_records(
        manifest_path,
        [
            {
                "type": "attempt",
                "sequence_index": 0,
                "memory_mode": "off",
                "org_id": "okp-org-0",
                "served_model": None,
                "verdict": "PASS",
                "gate_totals": {"passed": 4, "failed": 0},
                "session_fp": "fp-off-cell",
                "session_id": "ses-off-cell",
                "progress": progress_from_cell_result(_off_telemetry()).to_dict(),
            }
        ],
    )
    scorecard = _scorecard([_point(0, "fp-off-cell")])

    records = build_run_records(
        tree_id="1787310000",
        task="backgammon",
        scorecard=scorecard,
        status_stream_path=stream_path,
        timestamp="2026-08-29T13:00:00Z",
    )
    assert len(records) == 1
    record = records[0]
    assert record["tree_id"] == "1787310000"
    assert record["run_id"] == "run-ledger-test"
    assert record["task"] == "backgammon"
    assert record["org_id"] is None, "OFF baseline targets no memory org"
    assert record["model"] == "local/test-model"
    assert record["arm"] == "off"
    assert record["sequence_index"] == 0
    assert record["verdict"] == "PASS"
    assert record["attempts_to_green"] == 2
    assert record["problems_before"] == 3
    assert record["problems_after"] == 1
    assert record["full_green"] is True
    assert record["gate_totals"] == {"passed": 4, "failed": 0}
    assert record["turns"] == 7
    assert record["tokens"] == 900
    assert record["wall_seconds"] == 12.5
    assert record["wall_cost_usd"] == 0.25
    assert record["recall"] is None, "OFF recall is None, not a dict of nulls"
    assert record["session_fp"] == "fp-off-cell"
    assert record["session_id"] == "ses-off-cell"
    assert record["timestamp"] == "2026-08-29T13:00:00Z"


def test_on_cell_recall_populated(tmp_path: Path) -> None:
    manifest_path = tmp_path / "manifest.json"
    stream_path = _write_attempt_records(
        manifest_path,
        [
            {
                "type": "attempt",
                "sequence_index": 1,
                "memory_mode": "on",
                "org_id": "org-on-target",
                "served_model": "served/test-model",
                "verdict": "PASS",
                "gate_totals": {"passed": 4, "failed": 0},
                "session_fp": "fp-on-cell",
                "session_id": "ses-on-cell",
                "progress": progress_from_cell_result(_on_telemetry()).to_dict(),
            }
        ],
    )
    scorecard = _scorecard([_point(1, "fp-on-cell")])

    records = build_run_records(
        tree_id=None,
        task="backgammon",
        scorecard=scorecard,
        status_stream_path=stream_path,
        timestamp="2026-08-29T13:00:00Z",
    )
    assert len(records) == 1
    record = records[0]
    assert record["arm"] == "on"
    assert record["org_id"] == "org-on-target"
    assert record["tree_id"] is None, "legacy flat layout has no tree pointer"
    recall = record["recall"]
    assert isinstance(recall, dict)
    assert set(recall) == set(RECALL_FIELDS)
    assert recall["recall_fired_total"] == 4
    assert recall["recall_returned_total"] == 3
    assert recall["recall_returned_count_sum"] == 5
    assert recall["no_keywords_count"] == 1
    assert recall["served_attempted"] == 3
    assert recall["served_failed"] == 1
    assert recall["served_confirmed"] == 2
    assert recall["recall_return_rate"] == 0.75
    assert recall["inject_yield"] == 0.4
    assert recall["serve_success_rate"] == 2 / 3
    assert record["model"] == "local/test-model", "requested_model wins over served"


def test_append_writes_jsonl_accumulates_and_preserves_torn_line(
    tmp_path: Path,
) -> None:
    manifest_path = tmp_path / "manifest.json"
    stream_path = _write_attempt_records(
        manifest_path,
        [
            {
                "type": "attempt",
                "sequence_index": 0,
                "memory_mode": "off",
                "org_id": "okp-org-0",
                "verdict": "PASS",
                "session_fp": "fp-off-cell",
                "session_id": "ses-off-cell",
                "progress": progress_from_cell_result(_off_telemetry()).to_dict(),
            }
        ],
    )
    scorecard = _scorecard([_point(0, "fp-off-cell")])
    ledger_path = tmp_path / "data" / "results-ledger.jsonl"

    first = append_run_records(
        bench_root=tmp_path,
        tree_id="1787310000",
        task="backgammon",
        scorecard=scorecard,
        status_stream_path=stream_path,
    )
    assert first and ledger_path.exists()
    lines = ledger_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    # Canonical compact sorted-key JSON, one object per line.
    decoded = json.loads(lines[0])
    assert decoded["arm"] == "off"
    assert lines[0] == json.dumps(decoded, sort_keys=True, separators=(",", ":"))
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", decoded["timestamp"])

    # A run that died mid-write leaves a torn (unparseable) line; the next
    # run's records still append after it and nothing prior is rewritten.
    with open(ledger_path, "a", encoding="utf-8") as handle:
        handle.write('{"run_id": "torn"\n')  # newline landed, JSON did not
    second = append_run_records(
        bench_root=tmp_path,
        tree_id="1787310000",
        task="backgammon",
        scorecard=scorecard,
        status_stream_path=stream_path,
    )
    assert second
    lines_after = ledger_path.read_text(encoding="utf-8").splitlines()
    assert len(lines_after) == 3
    assert lines_after[0] == lines[0], "append-only: prior line byte-identical"
    assert json.loads(lines_after[2])["run_id"] == "run-ledger-test"
    # Reader tolerance (StatusStream.records semantics): the torn line is
    # skipped, the good records on either side of it survive.
    parsed = []
    for raw in lines_after:
        try:
            parsed.append(json.loads(raw))
        except json.JSONDecodeError:
            continue
    assert len(parsed) == 2
    assert all(r["run_id"] == "run-ledger-test" for r in parsed)


def test_point_without_attempt_record_is_skipped(tmp_path: Path) -> None:
    manifest_path = tmp_path / "manifest.json"
    stream_path = _write_attempt_records(manifest_path, [])
    scorecard = _scorecard([_point(0, "fp-unattributed")])

    records = build_run_records(
        tree_id=None,
        task="backgammon",
        scorecard=scorecard,
        status_stream_path=stream_path,
    )
    assert records == [], "a cell with no attempt record cannot be attributed"


def test_read_tree_id_absent_none_malformed_raises(tmp_path: Path) -> None:
    assert read_tree_id(tmp_path) is None, "absent pointer = legacy flat layout"
    (tmp_path / "runs").mkdir()
    (tmp_path / "runs" / "active-tree.json").write_text(
        json.dumps({"active": "not-a-tree-id"}), encoding="utf-8"
    )
    try:
        read_tree_id(tmp_path)
    except ValueError as exc:
        assert "not a unix-seconds tree id" in str(exc)
    else:
        raise AssertionError("malformed pointer must raise, never guess")
