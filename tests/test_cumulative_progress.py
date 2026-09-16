from __future__ import annotations

import json
from pathlib import Path
import sqlite3
from typing import Any

import pytest

from harness.adapters.challenge import (
    TRUNCATED_STEP_FINISH_REASONS,
    TURN_TERMINAL_GUARD_ABORT,
    TURN_TERMINAL_TRANSPORT_ERROR,
    TURN_TERMINAL_TRUNCATED,
    ChallengeCellResult,
    ChallengeRunner,
    _OpencodeRunStats,
)
from harness.adapters.docker_worker import ImageFingerprint
from harness.cumulative.convergence import (
    CONVERGENCE_SCHEMA_VERSION,
    ConvergencePoint,
    build_convergence_trend,
)
from harness.cumulative.manifest import CumulativeManifest, roster_hash
from harness.cumulative.progress import progress_from_cell_result
from harness.cumulative.types import (
    ProgressVector,
    RosterEntry,
    ScheduledSession,
    SessionRecord,
)


TASK_DIR = (Path(__file__).resolve().parents[1] / "task" / "backgammon").resolve()


def _make_runner(tmp_path: Path) -> ChallengeRunner:
    return ChallengeRunner(
        task_dir=TASK_DIR,
        work_root=tmp_path / "work-root",
        model="openrouter/anthropic/claude-opus-4.8",
        progress=lambda _line: None,
    )


def _write_jsonl(path: Path, entries: list[dict[str, Any] | str]) -> Path:
    rendered: list[str] = []
    for entry in entries:
        if isinstance(entry, str):
            rendered.append(entry)
        else:
            rendered.append(json.dumps(entry, separators=(",", ":")))
    path.write_text("\n".join(rendered) + "\n", encoding="utf-8")
    return path


def _tool_part(tool: str) -> dict[str, Any]:
    """One `part` row as the exported session DB actually stores it.

    Shape verified against a real cell's `opencode.db`: the tool NAME and the
    `state` sit at the top level of the part, not nested under a `part` key
    (that was the old stdout transport's event envelope).
    """
    return {
        "type": "tool",
        "tool": tool,
        "callID": f"call-{tool}",
        "state": {"status": "completed"},
    }


def _bash_tool_part(command: str) -> dict[str, Any]:
    return {
        "type": "tool",
        "tool": "bash",
        "callID": "call-bash",
        "state": {"status": "completed", "input": {"command": command}},
    }


def _write_session_db(path: Path, parts: list[Any]) -> Path:
    """Build a minimal session DB carrying just the `part` rows under test."""
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    try:
        conn.execute("CREATE TABLE part (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
        for i, part in enumerate(parts):
            raw = part if isinstance(part, str) else json.dumps(part, separators=(",", ":"))
            conn.execute("INSERT INTO part (id, data) VALUES (?, ?)", (f"prt-{i}", raw))
        conn.commit()
    finally:
        conn.close()
    return path


def _session_record(
    sequence_index: int,
    *,
    progress: dict[str, Any] | None,
    session_id: str | None = None,
) -> SessionRecord:
    sid = session_id or f"sess-{sequence_index}"
    return SessionRecord(
        sequence_index=sequence_index,
        model="openrouter/model-a",
        provider_pin="openrouter",
        memory_mode="on",
        phase_group="on",
        phase="DONE",
        session_id=sid,
        org_id="org-progress-test",
        extraction_job_id=f"job-{sequence_index}",
        session_fp=SessionRecord.session_fp_of(sid),
        candidate_refs=[],
        extraction_candidate_count=0,
        progress=progress,
    )


def test_extract_event_counts_counts_all_tool_calls_with_noise(tmp_path: Path) -> None:
    runner = _make_runner(tmp_path)
    db = _write_session_db(
        tmp_path / "mixed" / "opencode.db",
        [
            {"type": "step-start"},
            _tool_part("bash"),
            _tool_part("read"),
            _tool_part("edit"),
            _tool_part("todowrite"),
            _tool_part("bash"),
            {"type": "step-finish", "reason": "stop"},
            {"type": "text", "text": "noise"},
        ],
    )

    tool_calls, test_invocations = runner._extract_event_counts(db)

    assert tool_calls == 5
    assert test_invocations == 0


def test_extract_event_counts_empty_and_non_tool_only_are_honest_zero(
    tmp_path: Path,
) -> None:
    """A DB that IS readable and holds no tool call is a real zero.

    This is the distinction the re-point exists to preserve: zero tool calls is
    a measurement; an unreadable source is not (see the missing/corrupt test).
    """
    runner = _make_runner(tmp_path)

    empty_db = _write_session_db(tmp_path / "empty" / "opencode.db", [])
    assert runner._extract_event_counts(empty_db) == (0, 0)

    non_tool_only = _write_session_db(
        tmp_path / "non-tool" / "opencode.db",
        [
            {"type": "step-start"},
            {"type": "step-finish", "reason": "stop"},
            {"type": "text", "text": "no tool usage"},
        ],
    )
    assert runner._extract_event_counts(non_tool_only) == (0, 0)


def test_extract_event_counts_test_invocations_and_case_sensitivity(
    tmp_path: Path,
) -> None:
    runner = _make_runner(tmp_path)
    db = _write_session_db(
        tmp_path / "tests" / "opencode.db",
        [
            _bash_tool_part("npx vitest run"),
            _bash_tool_part("node report.mjs --target x"),
            _bash_tool_part("npm test"),
            _bash_tool_part("ls -la"),
            _bash_tool_part("node src/server.ts"),
            _bash_tool_part("NPX VITEST"),
            _tool_part("read"),
        ],
    )

    tool_calls, test_invocations = runner._extract_event_counts(db)

    assert tool_calls == 7
    assert test_invocations == 3


def test_extract_event_counts_handles_corruption_and_missing_paths(
    tmp_path: Path,
) -> None:
    runner = _make_runner(tmp_path)
    malformed = _write_session_db(
        tmp_path / "corrupt" / "opencode.db",
        [
            _bash_tool_part("npm test"),
            "this-is-not-json",
            '["not", "an", "object"]',
            {"type": "tool"},
            {"type": "step-finish"},
            _tool_part("edit"),
        ],
    )

    tool_calls, test_invocations = runner._extract_event_counts(malformed)
    assert tool_calls == 3
    assert test_invocations == 1

    # ABSENCE IS NOT ZERO. Each of these is a source that could not be read, and
    # must stay distinguishable from the honest-zero case above.
    missing_path = tmp_path / "gone" / "opencode.db"
    assert runner._extract_event_counts(missing_path) == (None, None)

    directory_path = tmp_path / "db-dir"
    directory_path.mkdir()
    assert runner._extract_event_counts(directory_path) == (None, None)

    not_a_db = tmp_path / "garbage" / "opencode.db"
    not_a_db.parent.mkdir(parents=True, exist_ok=True)
    not_a_db.write_text("this is not a sqlite file\n", encoding="utf-8")
    assert runner._extract_event_counts(not_a_db) == (None, None)


def test_extract_agentic_cycles_counts_distinct_attempts(tmp_path: Path) -> None:
    runner = _make_runner(tmp_path)
    user_events = _write_jsonl(
        tmp_path / "attempts.user-events.jsonl",
        [
            {"type": "user", "attempt": 1, "text": "initial"},
            {"type": "user", "attempt": 2, "text": "feedback-1"},
            {"type": "user", "attempt": 2, "text": "duplicate-attempt"},
            {"type": "user", "attempt": 3, "text": "feedback-2"},
            {"type": "text", "part": {"text": "noise"}},
        ],
    )

    assert runner._extract_agentic_cycles(user_events) == 3

    single_attempt = _write_jsonl(
        tmp_path / "single.user-events.jsonl",
        [{"type": "user", "attempt": 1, "text": "only-once"}],
    )
    assert runner._extract_agentic_cycles(single_attempt) == 1


def test_extract_agentic_cycles_fallback_corruption_and_missing(tmp_path: Path) -> None:
    runner = _make_runner(tmp_path)
    fallback_events = _write_jsonl(
        tmp_path / "fallback.user-events.jsonl",
        [
            {"type": "user", "text": "no-attempt-1"},
            {"type": "user", "text": "no-attempt-2"},
            "not-json",
            {"type": "user", "attempt": "bad", "text": "invalid-attempt-value"},
            {"type": "step_finish", "part": {}},
        ],
    )
    assert runner._extract_agentic_cycles(fallback_events) == 3

    missing_sidecar = tmp_path / "missing.user-events.jsonl"
    assert runner._extract_agentic_cycles(missing_sidecar) is None


def test_progress_from_cell_result_maps_problem_and_telemetry_math() -> None:
    result = ChallengeCellResult(
        verdict="FAIL",
        attempts_to_green=2,
        termination_reason="attempt_ceiling_reached",
        conformed=False,
        input_tokens=101,
        output_tokens=203,
        turns=7,
        wall_seconds=4.5,
        delivery="N/A",
        failed_gates=["tests"],
        problems_final=[{}, {}, {}],
        attempt_reports=[],
        worktree="/tmp/worktree",
        session_id="sess-progress",
        memory_mode="on",
        model="openrouter/anthropic/claude-opus-4.8",
        wall_cost_usd=0.42,
        tool_calls=11,
        test_invocations=3,
        agentic_cycles=4,
        problems_before=5,
    )

    progress = progress_from_cell_result(result)

    assert progress.problems_after == 3
    assert progress.resolved_count == 2
    assert progress.remaining_count == 3
    assert progress.tool_calls == 11
    assert progress.test_invocations == 3
    assert progress.agentic_cycles == 4
    assert progress.attempts_to_green == 2


def test_progress_from_cell_result_preserves_none_for_nullable_fields() -> None:
    result = ChallengeCellResult(
        verdict="FAIL",
        attempts_to_green="FAIL",
        termination_reason="attempt_ceiling_reached",
        conformed=False,
        input_tokens=0,
        output_tokens=0,
        turns=0,
        wall_seconds=0.0,
        delivery="N/A",
        failed_gates=[],
        problems_final=[{}, {}, {}],
        attempt_reports=[],
        worktree="/tmp/worktree",
        session_id="sess-progress-none",
        memory_mode="on",
        model="openrouter/anthropic/claude-opus-4.8",
        wall_cost_usd=0.0,
        tool_calls=None,
        test_invocations=None,
        agentic_cycles=None,
        problems_before=None,
    )

    progress = progress_from_cell_result(result)

    assert progress.problems_before is None
    assert progress.resolved_count is None
    assert progress.remaining_count == 3
    assert progress.attempts_to_green is None
    assert progress.tool_calls is None
    assert progress.test_invocations is None
    assert progress.agentic_cycles is None
    assert progress.turns == 0
    assert "resolved_count" in progress.missing_telemetry_seams


def test_progress_vector_construction_does_not_report_late_populated_seams() -> None:
    progress = ProgressVector(
        problems_before=3,
        problems_after=1,
        resolved_count=2,
        remaining_count=1,
        attempts_to_green=1,
        injected_count=2,
        injected_block_chars=120,
        injected_block_est_tokens=30,
        recall_fired_total=2,
        recall_returned_total=2,
        recall_returned_count_sum=2,
        no_keywords_count=0,
        served_attempted=2,
        served_failed=0,
        served_confirmed=2,
        tool_calls=4,
        test_invocations=1,
        agentic_cycles=1,
        memory_mode="on",
    )

    assert "consumer_injected_count" not in progress.missing_telemetry_seams
    assert "extraction_candidate_count" not in progress.missing_telemetry_seams
    assert "accepted_count" not in progress.missing_telemetry_seams
    assert "http_429_count" not in progress.missing_telemetry_seams


def test_progress_vector_to_dict_reports_unresolved_late_on_seams() -> None:
    progress = ProgressVector(
        problems_before=1,
        problems_after=0,
        resolved_count=1,
        remaining_count=0,
        attempts_to_green=1,
        injected_count=1,
        injected_block_chars=80,
        injected_block_est_tokens=20,
        recall_fired_total=1,
        recall_returned_total=1,
        recall_returned_count_sum=1,
        no_keywords_count=0,
        served_attempted=1,
        served_failed=0,
        served_confirmed=1,
        tool_calls=2,
        test_invocations=1,
        agentic_cycles=1,
        memory_mode="on",
    )

    seams = progress.to_dict()["missing_telemetry_seams"]

    assert "consumer_injected_count" in seams
    assert "accepted_count" in seams
    assert "extraction_candidate_count" in seams


def test_progress_vector_still_reports_genuinely_absent_immediate_seam() -> None:
    progress = ProgressVector(
        problems_before=None, tool_calls=1, agentic_cycles=1, memory_mode="on"
    )

    assert "problems_before" in progress.missing_telemetry_seams
    assert "tool_calls" not in progress.missing_telemetry_seams


def test_progress_vector_off_phase_does_not_report_on_only_seams() -> None:
    progress = ProgressVector(memory_mode="off")
    seams = progress.to_dict()["missing_telemetry_seams"]

    assert "injected_count" not in seams
    assert "consumer_injected_count" not in seams
    assert "accepted_count" not in seams


def test_progress_from_cell_result_maps_injected_block_fields_when_present() -> None:
    result = ChallengeCellResult(
        verdict="PASS",
        attempts_to_green=0,
        termination_reason="gates_green",
        conformed=True,
        input_tokens=10,
        output_tokens=20,
        turns=1,
        wall_seconds=1.0,
        delivery="YES",
        failed_gates=[],
        problems_final=[],
        attempt_reports=[],
        worktree="/tmp/worktree",
        session_id="sess-block-present",
        memory_mode="on",
        model="openrouter/anthropic/claude-opus-4.8",
        injected_block_chars=2400,
        injected_block_est_tokens=600,
    )

    progress = progress_from_cell_result(result)

    assert progress.injected_block_chars == 2400
    assert progress.injected_block_est_tokens == 600
    assert "injected_block_chars" not in progress.missing_telemetry_seams
    assert "injected_block_est_tokens" not in progress.missing_telemetry_seams


def test_progress_from_cell_result_persists_worker_image_fingerprint() -> None:
    result = ChallengeCellResult(
        verdict="PASS",
        attempts_to_green=0,
        termination_reason="gates_green",
        conformed=True,
        input_tokens=10,
        output_tokens=20,
        turns=1,
        wall_seconds=1.0,
        delivery="N/A",
        failed_gates=[],
        problems_final=[],
        attempt_reports=[],
        worktree="/tmp/worktree",
        session_id="sess-image-fp",
        memory_mode="off",
        model="openrouter/anthropic/claude-opus-4.8",
        worker_image_fingerprint=ImageFingerprint(
            image_id="sha256:unit-test-image",
            created="2026-07-31T01:25:11Z",
        ),
    )

    payload = progress_from_cell_result(result).to_dict()

    assert payload["worker_image_id"] == "sha256:unit-test-image"
    assert payload["worker_image_created"] == "2026-07-31T01:25:11Z"


def test_progress_from_cell_result_preserves_none_for_injected_block_fields() -> None:
    result = ChallengeCellResult(
        verdict="PASS",
        attempts_to_green=0,
        termination_reason="gates_green",
        conformed=True,
        input_tokens=10,
        output_tokens=20,
        turns=1,
        wall_seconds=1.0,
        delivery="YES",
        failed_gates=[],
        problems_final=[],
        attempt_reports=[],
        worktree="/tmp/worktree",
        session_id="sess-block-missing",
        memory_mode="off",
        model="openrouter/anthropic/claude-opus-4.8",
        injected_block_chars=None,
        injected_block_est_tokens=None,
    )

    progress = progress_from_cell_result(result)

    assert progress.injected_block_chars is None
    assert progress.injected_block_est_tokens is None
    assert "injected_block_chars" not in progress.missing_telemetry_seams
    assert "injected_block_est_tokens" not in progress.missing_telemetry_seams


def test_progress_vector_serde_round_trip_with_new_fields() -> None:
    vector = ProgressVector(
        problems_before=9,
        problems_after=4,
        resolved_count=5,
        remaining_count=4,
        full_green=True,
        attempts_to_green=1,
        turns=12,
        input_tokens=120,
        output_tokens=180,
        total_tokens=300,
        wall_seconds=6.0,
        wall_cost_usd=1.25,
        injected_block_chars=2400,
        injected_block_est_tokens=600,
        tool_calls=22,
        test_invocations=5,
        agentic_cycles=3,
        missing_telemetry_seams=[],
    )

    payload = vector.to_dict()
    restored = ProgressVector.from_dict(payload)

    assert restored.to_dict() == payload
    assert restored.injected_block_chars == 2400
    assert restored.injected_block_est_tokens == 600
    assert restored.tool_calls == 22
    assert restored.test_invocations == 5
    assert restored.agentic_cycles == 3


def test_progress_vector_from_dict_coerces_garbage_to_none_and_normalizes_seams() -> (
    None
):
    restored = ProgressVector.from_dict(
        {
            "problems_before": None,
            "problems_after": None,
            "resolved_count": None,
            "remaining_count": None,
            "attempts_to_green": None,
            "turns": "0",
            "input_tokens": "0",
            "output_tokens": "0",
            "total_tokens": "0",
            "wall_seconds": "0.0",
            "wall_cost_usd": "0.0",
            "injected_block_chars": "2400",
            "injected_block_est_tokens": "600",
            "tool_calls": None,
            "test_invocations": None,
            "agentic_cycles": None,
            "missing_telemetry_seams": ["custom-seam"],
        }
    )

    assert restored.tool_calls is None
    assert restored.test_invocations is None
    assert restored.agentic_cycles is None
    assert restored.injected_block_chars == 2400
    assert restored.injected_block_est_tokens == 600
    assert "injected_block_chars" not in restored.missing_telemetry_seams
    assert "injected_block_est_tokens" not in restored.missing_telemetry_seams
    assert "tool_calls" in restored.missing_telemetry_seams
    assert "agentic_cycles" in restored.missing_telemetry_seams
    assert "custom-seam" in restored.missing_telemetry_seams

    normalized = ProgressVector(
        tool_calls=None, agentic_cycles=2, missing_telemetry_seams=[]
    )
    assert "tool_calls" in normalized.missing_telemetry_seams
    assert "agentic_cycles" not in normalized.missing_telemetry_seams


def test_progress_vector_from_dict_rejects_corrupt_injected_block_fields() -> None:
    payload = {
        "problems_before": None,
        "problems_after": None,
        "resolved_count": None,
        "remaining_count": None,
        "attempts_to_green": None,
        "turns": "0",
        "input_tokens": "0",
        "output_tokens": "0",
        "total_tokens": "0",
        "wall_seconds": "0.0",
        "wall_cost_usd": "0.0",
        "injected_block_chars": "bad",
        "injected_block_est_tokens": "600",
        "tool_calls": None,
        "test_invocations": None,
        "agentic_cycles": None,
        "missing_telemetry_seams": [],
    }

    with pytest.raises(ValueError):
        ProgressVector.from_dict(payload)


def test_build_convergence_trend_math_hash_and_dict_shape() -> None:
    progress_a = ProgressVector(
        resolved_count=2,
        full_green=True,
        total_tokens=100,
        wall_seconds=1.5,
        wall_cost_usd=0.10,
        tool_calls=4,
        test_invocations=1,
        agentic_cycles=1,
    ).to_dict()
    progress_b = ProgressVector(
        resolved_count=1,
        full_green=False,
        total_tokens=200,
        wall_seconds=2.0,
        wall_cost_usd=0.20,
        tool_calls=8,
        test_invocations=2,
        agentic_cycles=2,
    ).to_dict()
    progress_c = ProgressVector(
        resolved_count=None,
        full_green=True,
        total_tokens=300,
        wall_seconds=3.0,
        wall_cost_usd=0.30,
        tool_calls=9,
        test_invocations=3,
        agentic_cycles=3,
    ).to_dict()

    records = [
        _session_record(2, progress=progress_b),
        _session_record(0, progress=progress_a),
        _session_record(1, progress=progress_c),
        _session_record(3, progress=None),
    ]

    trend = build_convergence_trend(records)
    trend2 = build_convergence_trend(records)

    assert [point.sequence_index for point in trend.points] == [0, 1, 2]
    assert trend.sessions_completed == 3
    assert trend.sessions_green == 2
    assert trend.resolved_total == 3
    assert trend.tokens_total == 600
    assert trend.wall_seconds_total == 6.5
    assert trend.wall_cost_usd_total == 0.60
    assert trend.trend_hash == trend2.trend_hash

    changed_records = [
        _session_record(2, progress=progress_b),
        _session_record(0, progress={**progress_a, "total_tokens": 101}),
        _session_record(1, progress=progress_c),
    ]
    changed_trend = build_convergence_trend(changed_records)
    assert changed_trend.trend_hash != trend.trend_hash

    rendered = trend.to_dict()
    assert rendered["schema_version"] == CONVERGENCE_SCHEMA_VERSION
    assert rendered["trend_hash"] == trend.trend_hash


def test_build_convergence_trend_resolved_total_none_when_all_missing() -> None:
    records = [
        _session_record(0, progress=ProgressVector(resolved_count=None).to_dict()),
        _session_record(1, progress=ProgressVector(resolved_count=None).to_dict()),
    ]

    trend = build_convergence_trend(records)

    assert trend.sessions_completed == 2
    assert trend.resolved_total is None


def test_snapshot_honesty_fields_lockstep_and_reach_the_convergence_point() -> None:
    """WO-SNAP-03 half A: the four declared honesty fields are schema+plumbing.

    Defaults declare an unseeded cell; ``SessionRecord.to_dict``/``from_dict``
    preserve the fields in lockstep (and a pre-field checkpoint reads as
    unseeded defaults); ``ConvergencePoint.from_session_record`` reads them
    from the record's TOP-LEVEL attributes, never from ``record.progress``.
    """
    skipped_build_cost = {
        "turns": 4,
        "total_tokens": 1200,
        "wall_seconds": 30.5,
        "wall_cost_usd": 0.25,
    }

    unseeded = _session_record(0, progress=None)
    assert unseeded.seeded_from_snapshot is None
    assert unseeded.build_phase_ran is False
    assert unseeded.skipped_build_cost is None
    assert unseeded.dev_mode is False

    seeded = SessionRecord(
        sequence_index=1,
        model="openrouter/model-a",
        provider_pin="openrouter",
        memory_mode="on",
        phase_group="on",
        phase="DONE",
        session_id="sess-seeded",
        session_fp=SessionRecord.session_fp_of("sess-seeded"),
        progress=ProgressVector(full_green=True, resolved_count=1).to_dict(),
        seeded_from_snapshot="snap-abc123",
        build_phase_ran=False,
        skipped_build_cost=dict(skipped_build_cost),
        dev_mode=False,
    )

    restored = SessionRecord.from_dict(seeded.to_dict())
    assert restored.seeded_from_snapshot == "snap-abc123"
    assert restored.build_phase_ran is False
    assert restored.skipped_build_cost == skipped_build_cost
    assert restored.dev_mode is False

    # A checkpoint written before the fields existed reads as unseeded defaults.
    legacy_payload = seeded.to_dict()
    for key in (
        "seeded_from_snapshot",
        "build_phase_ran",
        "skipped_build_cost",
        "dev_mode",
    ):
        del legacy_payload[key]
    legacy = SessionRecord.from_dict(legacy_payload)
    assert legacy.seeded_from_snapshot is None
    assert legacy.build_phase_ran is False
    assert legacy.skipped_build_cost is None
    assert legacy.dev_mode is False

    point = ConvergencePoint.from_session_record(seeded)
    assert point is not None
    assert point.seeded_from_snapshot == "snap-abc123"
    assert point.build_phase_ran is False
    assert point.skipped_build_cost == skipped_build_cost
    assert point.dev_mode is False

    unseeded_point = ConvergencePoint.from_session_record(
        _session_record(2, progress=ProgressVector(full_green=False).to_dict())
    )
    assert unseeded_point is not None
    assert unseeded_point.seeded_from_snapshot is None
    assert unseeded_point.build_phase_ran is False
    assert unseeded_point.skipped_build_cost is None
    assert unseeded_point.dev_mode is False


def test_manifest_session_records_support_done_state_equivalent_convergence() -> None:
    roster = [
        RosterEntry(
            model="openrouter/model-a",
            role="assistant",
            provider_pin="openrouter",
            config_identity={"slot": 1},
        )
    ]
    schedule = [
        ScheduledSession(
            sequence_index=0,
            model="openrouter/model-a",
            provider_pin="openrouter",
            memory_mode="on",
            phase_group="on",
            roster_index=0,
        )
    ]
    records = [
        _session_record(
            0, progress=ProgressVector(full_green=True, resolved_count=1).to_dict()
        ),
        _session_record(
            1, progress=ProgressVector(full_green=False, resolved_count=0).to_dict()
        ),
    ]
    manifest = CumulativeManifest(
        created_at="2026-07-24T00:00:00Z",
        task="backgammon",
        org_id="org-progress-test",
        roster=roster,
        roster_hash=roster_hash(roster),
        seed=17,
        config_fingerprint="cfg-progress-test",
        schedule=schedule,
        session_records=records,
        current_index=2,
        updated_at="2026-07-24T00:00:01Z",
    )

    convergence = build_convergence_trend(manifest.session_records).to_dict()

    assert convergence["sessions_completed"] == 2
    assert convergence["sessions_green"] == 1
    assert convergence["resolved_total"] == 1
    assert isinstance(convergence["trend_hash"], str)
    assert len(convergence["trend_hash"]) == 8


def _make_backgammon_cell_result(**overrides: Any) -> ChallengeCellResult:
    base: dict[str, Any] = {
        "verdict": "PASS",
        "attempts_to_green": 1,
        "termination_reason": "gates_green",
        "conformed": True,
        "input_tokens": 10,
        "output_tokens": 20,
        "turns": 2,
        "wall_seconds": 1.5,
        "delivery": "YES",
        "failed_gates": [],
        "problems_final": [],
        "attempt_reports": [],
        "worktree": "/tmp/worktree",
        "session_id": "sess-recall-funnel",
        "memory_mode": "on",
        "model": "openrouter/anthropic/claude-opus-4.8",
    }
    base.update(overrides)
    return ChallengeCellResult(**base)


def test_progress_from_cell_result_derives_full_green_from_verdict() -> None:
    # full_green must reflect the aggregate verdict (all three phases), NOT the
    # conformance phase alone — the fork #33 green-wash: conformance-green +
    # backend-fail used to score full_green=True with verdict="FAIL".
    green_wash = _make_backgammon_cell_result(verdict="FAIL", conformed=True)
    assert progress_from_cell_result(green_wash).full_green is False

    # verdict wins over conformed in both directions.
    pass_no_conform = _make_backgammon_cell_result(verdict="PASS", conformed=False)
    assert progress_from_cell_result(pass_no_conform).full_green is True

    budget_stop = _make_backgammon_cell_result(verdict="BUDGET_STOP", conformed=False)
    assert progress_from_cell_result(budget_stop).full_green is False


def test_progress_from_cell_result_full_green_from_mapping_verdict() -> None:
    # progress_from_cell_result also accepts plain mappings; verdict lookup
    # must work there too, and a missing verdict must never read green.
    assert (
        progress_from_cell_result({"verdict": "PASS", "conformed": False}).full_green
        is True
    )
    assert (
        progress_from_cell_result({"verdict": "FAIL", "conformed": True}).full_green
        is False
    )
    assert progress_from_cell_result({"conformed": True}).full_green is False


def test_progress_from_cell_result_maps_all_recall_serve_telemetry_fields() -> None:
    result = _make_backgammon_cell_result(
        recall_fired_total=5,
        recall_returned_total=4,
        recall_returned_count_sum=9,
        no_keywords_count=1,
        served_attempted=4,
        served_failed=1,
        served_confirmed=3,
    )

    progress = progress_from_cell_result(result)

    assert progress.recall_fired_total == 5
    assert progress.recall_returned_total == 4
    assert progress.recall_returned_count_sum == 9
    assert progress.no_keywords_count == 1
    assert progress.served_attempted == 4
    assert progress.served_failed == 1
    assert progress.served_confirmed == 3


def test_progress_from_cell_result_computes_recall_funnel_ratios() -> None:
    result = _make_backgammon_cell_result(
        recall_fired_total=4,
        recall_returned_total=3,
        recall_returned_count_sum=6,
        injected_count=3,
        served_attempted=4,
        served_confirmed=3,
        served_failed=1,
    )

    progress = progress_from_cell_result(result)

    assert progress.recall_return_rate == pytest.approx(0.75)
    assert progress.inject_yield == pytest.approx(0.5)
    assert progress.serve_success_rate == pytest.approx(0.75)


def test_progress_from_cell_result_ratio_fields_are_none_with_zero_denominators() -> (
    None
):
    result = _make_backgammon_cell_result(
        recall_fired_total=0,
        recall_returned_total=0,
        recall_returned_count_sum=0,
        injected_count=0,
        served_attempted=0,
        served_confirmed=0,
    )

    progress = progress_from_cell_result(result)

    assert progress.recall_return_rate is None
    assert progress.inject_yield is None
    assert progress.serve_success_rate is None


def test_progress_from_cell_result_coalesces_injected_count_result_then_cell() -> None:
    result_value = _make_backgammon_cell_result(injected_count=7)
    progress_value = progress_from_cell_result(result_value)
    assert progress_value.injected_count == 7

    fallback_result = _make_backgammon_cell_result(injected_count=None)
    fallback_progress = progress_from_cell_result(
        fallback_result,
        cell={"injection_count": 5},
    )
    assert fallback_progress.injected_count == 5


def test_progress_from_cell_result_preserves_none_and_registers_funnel_seams_only() -> (
    None
):
    result = _make_backgammon_cell_result(
        recall_fired_total=None,
        recall_returned_total=None,
        recall_returned_count_sum=None,
        no_keywords_count=None,
        injected_count=0,
        served_attempted=None,
        served_failed=None,
        served_confirmed=None,
    )

    progress = progress_from_cell_result(result)

    assert progress.recall_fired_total is None
    assert progress.recall_returned_total is None
    assert progress.recall_returned_count_sum is None
    assert progress.no_keywords_count is None
    assert progress.injected_count == 0
    assert progress.served_attempted is None
    assert progress.served_failed is None
    assert progress.served_confirmed is None

    assert "recall_fired_total" in progress.missing_telemetry_seams
    assert "recall_returned_total" in progress.missing_telemetry_seams
    assert "recall_returned_count_sum" in progress.missing_telemetry_seams
    assert "no_keywords_count" in progress.missing_telemetry_seams
    assert "injected_count" not in progress.missing_telemetry_seams
    assert "served_attempted" in progress.missing_telemetry_seams
    assert "served_failed" in progress.missing_telemetry_seams
    assert "served_confirmed" in progress.missing_telemetry_seams

    assert progress.recall_return_rate is None
    assert progress.inject_yield is None
    assert progress.serve_success_rate is None
    assert "recall_return_rate" not in progress.missing_telemetry_seams
    assert "inject_yield" not in progress.missing_telemetry_seams
    assert "serve_success_rate" not in progress.missing_telemetry_seams


def test_progress_vector_round_trip_preserves_recall_funnel_fields() -> None:
    vector = ProgressVector(
        recall_fired_total=8,
        recall_returned_total=6,
        recall_returned_count_sum=12,
        no_keywords_count=2,
        injected_count=4,
        served_attempted=5,
        served_failed=1,
        served_confirmed=4,
        recall_return_rate=0.75,
        inject_yield=4 / 12,
        serve_success_rate=0.8,
        missing_telemetry_seams=[],
    )

    payload = vector.to_dict()
    restored = ProgressVector.from_dict(payload)

    assert restored.to_dict() == payload
    assert restored.recall_fired_total == 8
    assert restored.recall_returned_total == 6
    assert restored.recall_returned_count_sum == 12
    assert restored.no_keywords_count == 2
    assert restored.injected_count == 4
    assert restored.served_attempted == 5
    assert restored.served_failed == 1
    assert restored.served_confirmed == 4


# ── the dropped-connection detector ──────────────────────────────────────────
#
# It had NO test, which is part of how it went silently dead: its input file
# stopped being written in the serve-only migration, the read swallowed the
# missing file and returned False, and a real transport stoppage was scored as
# a plain failure instead of being resumed. It now reads the anomaly records the
# live serve transport already produces, so these pin the mapping.


def _anomaly(terminal: str, *, finish_reason: str | None = None) -> dict[str, Any]:
    return {
        "phase": "initial",
        "turn_index": 3,
        "terminal": terminal,
        "reason": "",
        "finish_reason": finish_reason,
    }


def _stats(*anomalies: dict[str, Any]) -> _OpencodeRunStats:
    return _OpencodeRunStats(
        input_tokens=10,
        output_tokens=10,
        reasoning_tokens=0,
        turns=1,
        session_id="sess-x",
        killed_reason=None,
        exit_code=1,
        cost_usd=0.0,
        turn_anomalies=tuple(anomalies),
    )


def test_detect_stream_incomplete_fires_on_transport_and_guard_terminals() -> None:
    assert ChallengeRunner._detect_stream_incomplete(
        _stats(_anomaly(TURN_TERMINAL_TRANSPORT_ERROR))
    )
    assert ChallengeRunner._detect_stream_incomplete(
        _stats(_anomaly(TURN_TERMINAL_GUARD_ABORT))
    )


@pytest.mark.parametrize("reason", sorted(TRUNCATED_STEP_FINISH_REASONS))
def test_detect_stream_incomplete_fires_on_a_truncated_turn(reason: str) -> None:
    assert ChallengeRunner._detect_stream_incomplete(
        _stats(_anomaly(TURN_TERMINAL_TRUNCATED, finish_reason=reason))
    )


def test_detect_stream_incomplete_ignores_an_output_cap() -> None:
    """`length` is the model hitting its output ceiling, NOT a dead stream.

    serve_client counts it as a truncation and this module does not. Treating it
    as a transport stoppage would resume on a capability limit, widening what
    counts as an instrument failure — a scoring change instrumentation does not
    get to make on its own.
    """
    assert not ChallengeRunner._detect_stream_incomplete(
        _stats(_anomaly(TURN_TERMINAL_TRUNCATED, finish_reason="length"))
    )
    assert "length" not in TRUNCATED_STEP_FINISH_REASONS


def test_detect_stream_incomplete_is_false_when_nothing_went_wrong() -> None:
    assert not ChallengeRunner._detect_stream_incomplete(_stats())
    assert not ChallengeRunner._detect_stream_incomplete(
        _stats(_anomaly("silent_phase"))
    )
