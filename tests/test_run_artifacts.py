"""Unit tests for bench.cumulative.run_artifacts (WO-RUNSTATUS-1 chunk A)."""

from __future__ import annotations

from dataclasses import replace

import pytest

from bench.cumulative.run_artifacts import (
    RUN_ARTIFACTS_SCHEMA_VERSION,
    RunManifest,
    StatusStream,
    build_scorecard,
    default_run_manifest_path,
    default_status_stream_path,
    load_run_manifest,
    write_run_manifest,
)


def _manifest() -> RunManifest:
    return RunManifest(
        run_id="run-abc",
        created_at="2026-08-05T00:00:00Z",
        served_model="qwen3.6-35b-bench",
        requested_model="local-llm-proxy/qwen3.6-35b-bench",
        memory_mode="on",
        org_id="org-1",
        source_commit="deadbeef1234",
        worker_image_fingerprint={"sha256": "abcd1234"},
        seed=42,
        template_hash="tpl-1",
        roster_fingerprint="rost-1",
    )


def _progress(*, full_green: bool, resolved: int, total_tokens: int) -> dict:
    return {
        "problems_before": 5,
        "problems_after": 2,
        "resolved_count": resolved,
        "remaining_count": 1,
        "full_green": full_green,
        "attempts_to_green": 1,
        "turns": 10,
        "total_tokens": total_tokens,
        "wall_seconds": 12.5,
        "wall_cost_usd": 0.0,
        "tool_calls": 20,
        "test_invocations": 5,
        "agentic_cycles": 3,
    }


def _status_record(
    *,
    sequence_index: int,
    session_fp: str,
    session_id: str,
    progress: dict | None,
    verdict: str = "pass",
) -> dict:
    return {
        "type": "attempt",
        "schema_version": 1,
        "sequence_index": sequence_index,
        "memory_mode": "on",
        "org_id": "org-1",
        "served_model": {
            "model": "local-llm-proxy/qwen3.6-35b-bench",
            "upstream_model": "qwen3.6-35b",
        },
        "verdict": verdict,
        "termination_reason": "green",
        "attempts_to_green": 1,
        "progress": progress,
        "work_input_tokens": 1000,
        "work_output_tokens": 2000,
        "work_total_tokens": 3000,
        "injected_block_est_tokens": 500,
        "injected_count": 1,
        "injected_block_chars": 4096,
        "consumer_injected_count": 1,
        "extraction_state": "invoked_completed",
        "extraction_candidate_count": 3,
        "terminal_outcome": True,
        "terminal_reason": "all_green",
        "session_fp": session_fp,
        "session_id": session_id,
    }


def test_write_run_manifest_writes_once_and_second_write_raises(tmp_path) -> None:
    path = tmp_path / "manifest.json"
    first = _manifest()

    write_run_manifest(path, first)
    original = path.read_text(encoding="utf-8")

    second = replace(_manifest(), run_id="run-differs")

    with pytest.raises(FileExistsError):
        write_run_manifest(path, second)

    # First content unchanged.
    assert path.read_text(encoding="utf-8") == original
    assert "run-abc" in original
    assert "run-differs" not in path.read_text(encoding="utf-8")


def test_load_run_manifest_round_trips_all_fields(tmp_path) -> None:
    path = tmp_path / "manifest.json"
    original = _manifest()
    write_run_manifest(path, original)

    loaded = load_run_manifest(path)

    assert loaded.to_dict() == original.to_dict()
    assert loaded.run_id == "run-abc"
    assert loaded.created_at == "2026-08-05T00:00:00Z"
    assert loaded.served_model == "qwen3.6-35b-bench"
    assert loaded.requested_model == "local-llm-proxy/qwen3.6-35b-bench"
    assert loaded.memory_mode == "on"
    assert loaded.org_id == "org-1"
    assert loaded.source_commit == "deadbeef1234"
    assert loaded.worker_image_fingerprint == {"sha256": "abcd1234"}
    assert loaded.seed == 42
    assert loaded.template_hash == "tpl-1"
    assert loaded.roster_fingerprint == "rost-1"


def test_status_stream_append_read_and_reopen_keeps_prior_lines(tmp_path) -> None:
    path = tmp_path / "manifest.status.jsonl"
    stream = StatusStream(path)

    rec1 = _status_record(
        sequence_index=0,
        session_fp="fp-0",
        session_id="s-0",
        progress=_progress(full_green=True, resolved=3, total_tokens=3000),
    )
    rec2 = _status_record(
        sequence_index=1,
        session_fp="fp-1",
        session_id="s-1",
        progress=_progress(full_green=False, resolved=1, total_tokens=1000),
    )

    stream.append(rec1)
    stream.append(rec2)

    all_records = stream.records()
    assert len(all_records) == 2
    assert all_records[0]["sequence_index"] == 0
    assert all_records[1]["sequence_index"] == 1

    # Reopen a fresh handle and append; prior lines must survive.
    reopened = StatusStream(path)
    rec3 = _status_record(
        sequence_index=2,
        session_fp="fp-2",
        session_id="s-2",
        progress=_progress(full_green=True, resolved=5, total_tokens=5000),
    )
    reopened.append(rec3)

    all_records = reopened.records()
    assert len(all_records) == 3
    assert [r["sequence_index"] for r in all_records] == [0, 1, 2]


def test_status_stream_skips_unparseable_lines_keeps_valid_ones(tmp_path) -> None:
    path = tmp_path / "manifest.status.jsonl"
    stream = StatusStream(path)

    rec = _status_record(
        sequence_index=0,
        session_fp="fp-0",
        session_id="s-0",
        progress=_progress(full_green=True, resolved=3, total_tokens=3000),
    )
    stream.append(rec)

    # Simulate a partial/corrupt trailing line left by a mid-write crash
    # (newline-terminated so the following append lands on its own line).
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(
            '{"type": "attempt", "sequence_index": 1, "progress": {"full_green": t\n'
        )  # invalid JSON

    stream.append(
        _status_record(
            sequence_index=2,
            session_fp="fp-2",
            session_id="s-2",
            progress=_progress(full_green=True, resolved=5, total_tokens=5000),
        )
    )

    all_records = stream.records()
    # The garbage line is skipped; the valid records before and after remain.
    assert len(all_records) == 2
    assert [r["sequence_index"] for r in all_records] == [0, 2]


def test_default_paths_derive_sibling_names(tmp_path) -> None:
    manifest_path = str(tmp_path / "runs" / "cumulative" / "manifest.json")

    assert default_run_manifest_path(manifest_path) == str(
        tmp_path / "runs" / "cumulative" / "manifest.run-manifest.json"
    )
    assert default_status_stream_path(manifest_path) == str(
        tmp_path / "runs" / "cumulative" / "manifest.status.jsonl"
    )


def test_build_scorecard_reads_only_manifest_and_stream(tmp_path) -> None:
    run_dir = tmp_path / "runs" / "cumulative"
    mutable_manifest_path = run_dir / "manifest.json"  # deliberately absent
    run_manifest_path = run_dir / "manifest.run-manifest.json"

    # Two cells, two attempts each; terminal attempt carries non-None progress.
    stream = StatusStream(run_dir / "manifest.status.jsonl")
    stream.append(
        _status_record(
            sequence_index=0,
            session_fp="fp-0",
            session_id="s-0",
            progress=None,
            verdict="pending",
        )
    )
    stream.append(
        _status_record(
            sequence_index=0,
            session_fp="fp-0",
            session_id="s-0",
            progress=_progress(full_green=True, resolved=3, total_tokens=3000),
        )
    )
    stream.append(
        _status_record(
            sequence_index=1,
            session_fp="fp-1",
            session_id="s-1",
            progress=None,
            verdict="pending",
        )
    )
    stream.append(
        _status_record(
            sequence_index=1,
            session_fp="fp-1",
            session_id="s-1",
            progress=_progress(full_green=False, resolved=1, total_tokens=1000),
        )
    )

    manifest = _manifest()
    write_run_manifest(run_manifest_path, manifest)

    scorecard = build_scorecard(mutable_manifest_path)

    assert scorecard["schema_version"] == RUN_ARTIFACTS_SCHEMA_VERSION
    assert scorecard["manifest"]["run_id"] == "run-abc"
    assert scorecard["manifest"]["org_id"] == "org-1"
    assert scorecard["manifest"]["memory_mode"] == "on"
    assert scorecard["stream_records"] == 4
    assert scorecard["scored_sessions"] == 2

    convergence = scorecard["convergence"]
    assert convergence["sessions_completed"] == 2
    assert isinstance(convergence["trend_hash"], str)
    assert len(convergence["trend_hash"]) == 8
    int(convergence["trend_hash"], 16)  # stable 8-hex string

    # The mutable manifest path was never created / touched.
    assert not mutable_manifest_path.exists()


def test_build_scorecard_carries_snapshot_honesty_fields_from_the_stream(
    tmp_path,
) -> None:
    """WO-SNAP-03 half A: the scorecard path passes the four declared fields.

    Top-level keys on a status-stream record must survive the
    ``_ScoredSession`` carrier into ``ConvergencePoint.from_session_record``
    and out through the published point dict; a record without the keys
    scores as unseeded defaults (None/False/None/False).
    """
    run_dir = tmp_path / "runs" / "cumulative"
    mutable_manifest_path = run_dir / "manifest.json"  # deliberately absent
    skipped_build_cost = {
        "turns": 4,
        "total_tokens": 1200,
        "wall_seconds": 30.5,
        "wall_cost_usd": 0.25,
    }

    stream = StatusStream(run_dir / "manifest.status.jsonl")
    stream.append(
        {
            **_status_record(
                sequence_index=0,
                session_fp="fp-0",
                session_id="s-0",
                progress=_progress(full_green=True, resolved=3, total_tokens=3000),
            ),
            "seeded_from_snapshot": "snap-abc123",
            "build_phase_ran": False,
            "skipped_build_cost": dict(skipped_build_cost),
            "dev_mode": False,
        }
    )
    stream.append(
        _status_record(
            sequence_index=1,
            session_fp="fp-1",
            session_id="s-1",
            progress=_progress(full_green=False, resolved=1, total_tokens=1000),
        )
    )
    write_run_manifest(run_dir / "manifest.run-manifest.json", _manifest())

    scorecard = build_scorecard(mutable_manifest_path)

    points = scorecard["convergence"]["points"]
    assert len(points) == 2
    seeded_point = next(p for p in points if p["sequence_index"] == 0)
    assert seeded_point["seeded_from_snapshot"] == "snap-abc123"
    assert seeded_point["build_phase_ran"] is False
    assert seeded_point["skipped_build_cost"] == skipped_build_cost
    assert seeded_point["dev_mode"] is False
    bare_point = next(p for p in points if p["sequence_index"] == 1)
    assert bare_point["seeded_from_snapshot"] is None
    assert bare_point["build_phase_ran"] is False
    assert bare_point["skipped_build_cost"] is None
    assert bare_point["dev_mode"] is False


def test_build_scorecard_aggregates_error_totals_over_best_by_cell(tmp_path) -> None:
    """WO-ERRDATA-C5: the scorecard carries per-run error-type totals.

    ``error_totals`` sums the three whole-cell counters over the
    ``best_by_cell`` selection — ONE terminal record per cell — so the
    dashboard footer reads run-level totals, never per-attempt duplicates.
    """
    run_dir = tmp_path / "runs" / "cumulative"
    mutable_manifest_path = run_dir / "manifest.json"  # deliberately absent
    run_manifest_path = run_dir / "manifest.run-manifest.json"

    stream = StatusStream(run_dir / "manifest.status.jsonl")
    rec0 = _status_record(
        sequence_index=0,
        session_fp="fp-0",
        session_id="s-0",
        progress=_progress(full_green=True, resolved=3, total_tokens=3000),
    )
    rec0["guard_aborted_turns"] = 2
    rec0["finalize_timeout_turns"] = 1
    # Every anomalous turn EXCEPT the loop guard's — so it CONTAINS the
    # finalize-timeout above. This is what STREAM ERRORS reads: the slot used to
    # read the narrow subset and stayed 0 through a run whose stream died.
    rec0["instrument_anomaly_turns"] = 4
    rec0["stalled_turns"] = 0
    stream.append(rec0)

    rec1 = _status_record(
        sequence_index=1,
        session_fp="fp-1",
        session_id="s-1",
        progress=_progress(full_green=True, resolved=5, total_tokens=5000),
    )
    rec1["guard_aborted_turns"] = 3
    rec1["finalize_timeout_turns"] = 0
    rec1["instrument_anomaly_turns"] = 2
    rec1["stalled_turns"] = 1
    stream.append(rec1)

    write_run_manifest(run_manifest_path, _manifest())

    scorecard = build_scorecard(mutable_manifest_path)

    assert scorecard["error_totals"] == {
        "guard_aborted_turns": 5,
        "finalize_timeout_turns": 1,
        "stalled_turns": 1,
        "instrument_anomaly_turns": 6,
    }
    # The mutable manifest path was never created / touched.
    assert not mutable_manifest_path.exists()


# ── THE TOKEN TOTAL COUNTS EVERY TOKEN (2026-09-11) ─────────────────────────
#
# It used to be `input + output`. Measured on run 1789076475, one real cell:
#
#     work_input_tokens         70,634
#     work_output_tokens       107,486
#     work_cache_read_tokens 9,977,856   <- dropped
#     work_total_tokens        178,120   <- what the benchmark scored on
#
# 98% of the tokens the provider actually processed were invisible to the number
# the measurement uses. And the omission fell exactly where it does most damage:
# memory makes the prompt BIGGER, a bigger prompt is re-read every turn, and
# re-reads land in cache read. So the token axis made injected memory look FREE,
# when pricing memory is the one question this benchmark exists to answer.


def test_total_tokens_counts_the_cache_not_just_input_and_output() -> None:
    from bench.cumulative.progress import progress_from_cell_result

    class _Result:
        input_tokens = 70_634
        output_tokens = 107_486
        reasoning_tokens = 0
        cache_read_tokens = 9_977_856
        cache_write_tokens = 0

    progress = progress_from_cell_result(_Result())
    assert progress.total_tokens == 70_634 + 107_486 + 9_977_856, (
        "the total must carry the cache figures — without them a cached run "
        "under-reports by ~100x and memory appears to cost nothing"
    )
    # The split stays recoverable: this replaces neither half.
    assert progress.input_tokens == 70_634
    assert progress.output_tokens == 107_486


def test_reasoning_is_not_added_twice() -> None:
    # `output_tokens` has ALWAYS carried reasoning folded inside it, so
    # `reasoning_tokens` is the recoverable SHARE of output, never a fifth
    # addend. Adding it again would inflate every reasoning model's total.
    from bench.cumulative.progress import progress_from_cell_result

    class _Result:
        input_tokens = 100
        output_tokens = 500  # includes the 300 below
        reasoning_tokens = 300
        cache_read_tokens = 0
        cache_write_tokens = 0

    assert progress_from_cell_result(_Result()).total_tokens == 600


def test_a_provider_without_caching_totals_exactly_as_before() -> None:
    # The change must not move the number for a provider that reports no cache
    # — otherwise it would look like a measurement shift where none happened.
    from bench.cumulative.progress import progress_from_cell_result

    class _Result:
        input_tokens = 1_000
        output_tokens = 2_000
        reasoning_tokens = 0
        cache_read_tokens = 0
        cache_write_tokens = 0

    assert progress_from_cell_result(_Result()).total_tokens == 3_000


def test_a_missing_half_still_yields_no_total() -> None:
    # Unchanged discipline: a sum built from a half-measured cell is a guess
    # dressed as a measurement, and on a lower-is-better axis it would read as
    # an excellent result.
    from bench.cumulative.progress import progress_from_cell_result

    class _Result:
        input_tokens = 1_000
        output_tokens = None
        reasoning_tokens = 0
        cache_read_tokens = 500
        cache_write_tokens = 0

    assert progress_from_cell_result(_Result()).total_tokens is None
