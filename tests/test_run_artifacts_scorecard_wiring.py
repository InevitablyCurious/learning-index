"""WO-STRIP-2a chunk C9c: scorecard wiring against a real tmp manifest.

Exercises the REAL ``CumulativeSequencer`` with a FAKE ``SessionRunner``
against a real tmp manifest path. The campaign is measurement-only now — every
session walks PREPARE_FIXTURE -> RUN_SESSION and there are no extract,
coordinator-review, leader-commit, or index-ready stages — so the fake runner
publishes the same write-once run-manifest + append-only attempt records the
real ``RealSessionRunner`` writes. This proves:

1. ``step_until_done``'s done state sources standings from ``build_scorecard``
   (run-manifest + status stream only) and the run artifacts are created
   alongside the mutable manifest.
2. The done state falls back to the mutable manifest when the run-manifest /
   status stream are missing.

The WO-NIGHT2-1a chunk C (3-state scorecard) and WO-NIGHT2-1b chunk 2
(VOID-INSTRUMENT classification) tests below exercise ``build_scorecard``
directly on the real surface and are kept unchanged.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from harness.cumulative.progress import progress_from_cell_result
from harness.cumulative.sequencer import CumulativeSequencer
from harness.cumulative.run_artifacts import (
    RunManifest,
    StatusStream,
    build_scorecard,
    default_run_manifest_path,
    default_scorecard_path,
    default_status_stream_path,
    write_run_manifest,
    write_scorecard,
)
from harness.cumulative.types import RosterEntry, SessionRecord


def _cell_telemetry() -> dict[str, Any]:
    """ChallengeCellResult-shaped telemetry accepted by progress_from_cell_result."""
    return {
        "problems_before": 3,
        "problems_final": ["problem-2", "problem-3"],
        "resolved_count": 1,
        "remaining_count": 2,
        "conformed": False,
        "attempts_to_green": 1,
        "turns": 2,
        "input_tokens": 10,
        "output_tokens": 20,
        "total_tokens": 30,
        "wall_seconds": 0.1,
        "wall_cost_usd": 0.0,
        "termination_reason": "attempt_ceiling_reached",
        "failed_gates": ["tests"],
    }


class FakeRunner:
    """SessionRunner double that publishes the run artifacts like the real runner.

    In a real run ``RealSessionRunner`` writes the write-once run-manifest and
    the terminal per-attempt record (with ``progress`` == the cell's final
    ProgressVector). ``emit_artifacts=False`` simulates a run that died before
    publishing anything, exercising the done-state fallback.
    """

    def __init__(self, *, manifest_path: Path, emit_artifacts: bool = True) -> None:
        self.manifest_path = manifest_path
        self.emit_artifacts = emit_artifacts

    def prepare_fixture(self, session: SessionRecord) -> None:
        return None

    def run_session(self, session: SessionRecord) -> dict[str, Any]:
        telemetry = _cell_telemetry()
        if self.emit_artifacts:
            self._publish_run_manifest_once(session)
            self._append_attempt_record(session, telemetry)
        return telemetry

    def _publish_run_manifest_once(self, session: SessionRecord) -> None:
        run_manifest_path = default_run_manifest_path(self.manifest_path)
        if Path(run_manifest_path).exists():
            return
        write_run_manifest(
            run_manifest_path,
            RunManifest(
                run_id="run-wiring-test",
                created_at="2026-08-05T12:00:00Z",
                served_model=None,
                requested_model=str(session.model),
                memory_mode=str(session.memory_mode),
                org_id=str(session.org_id),
            ),
        )

    def _append_attempt_record(
        self, session: SessionRecord, telemetry: dict[str, Any]
    ) -> None:
        StatusStream(default_status_stream_path(self.manifest_path)).append(
            {
                "type": "attempt",
                "schema_version": 1,
                "sequence_index": session.sequence_index,
                "memory_mode": str(session.memory_mode),
                "org_id": str(session.org_id),
                "progress": progress_from_cell_result(telemetry).to_dict(),
                "session_fp": str(session.session_fp),
                "session_id": session.session_id,
            }
        )


def _make_sequencer(
    tmp_path: Path,
    *,
    runner: FakeRunner,
) -> CumulativeSequencer:
    manifest_path = tmp_path / "manifest.json"
    return CumulativeSequencer(
        manifest_path,
        runner=runner,
        roster=[
            RosterEntry(
                model="openrouter/model-a",
                role="assistant",
                provider_pin="openrouter",
                config_identity={"slot": 1},
            )
        ],
        seed=17,
        task="backgammon",
        org_id="org-wiring-test",
        config_fingerprint="cfg-wiring-test",
        on_budget=1,
    )


def test_done_state_sources_scorecard_and_creates_artifacts(tmp_path: Path) -> None:
    runner = FakeRunner(manifest_path=tmp_path / "manifest.json")
    sequencer = _make_sequencer(tmp_path, runner=runner)

    # Drive the collapsed stage machine to completion; the fake runner
    # publishes the run-manifest + attempt records a real run writes.
    done = sequencer.step_until_done()
    assert done["status"] == "done"

    # The run artifacts sit as siblings of the mutable manifest: the
    # write-once run-manifest and the append-only status stream.
    assert default_run_manifest_path(tmp_path / "manifest.json") == str(
        tmp_path / "manifest.run-manifest.json"
    )
    assert Path(default_run_manifest_path(tmp_path / "manifest.json")).is_file()
    assert Path(default_status_stream_path(tmp_path / "manifest.json")).is_file()

    convergence = done["convergence"]
    assert convergence["sessions_completed"] >= 1
    assert isinstance(convergence["trend_hash"], str)
    assert len(convergence["trend_hash"]) == 8
    int(convergence["trend_hash"], 16)

    # Convergence equals the scorecard's reconstructed trend (built from the
    # run-manifest + status stream only).
    scorecard = build_scorecard(tmp_path / "manifest.json")
    assert scorecard["convergence"] == convergence

    # The scorecard reads the attempt record's terminal progress (equal to the
    # cell's final progress stored in the mutable manifest), so the standings
    # match despite the mutable manifest never being read by the scorecard.
    assert scorecard["stream_records"] >= 1
    assert scorecard["scored_sessions"] >= 1


def test_done_state_falls_back_when_artifacts_missing(tmp_path: Path) -> None:
    runner = FakeRunner(manifest_path=tmp_path / "manifest.json", emit_artifacts=False)
    sequencer = _make_sequencer(tmp_path, runner=runner)

    # Artifacts deliberately absent: run-manifest + status stream never created.
    assert not Path(default_run_manifest_path(tmp_path / "manifest.json")).exists()
    assert not Path(default_status_stream_path(tmp_path / "manifest.json")).exists()

    # The done state must fall back to the mutable manifest without raising.
    done = sequencer.step_until_done()
    assert done["status"] == "done"
    assert isinstance(done["convergence"], dict)
    assert "trend_hash" in done["convergence"]
    assert "sessions_completed" in done["convergence"]


# --- WO-NIGHT2-1a chunk C: 3-state scorecard (scored-pass / scored-fail / ---
# --- not-scored-with-reason) via the fail-closed delivery gate.         ---


def _write_scored_attempt(
    stream: StatusStream,
    *,
    sequence_index: int,
    session_fp: str,
    session_id: str,
    full_green: bool,
) -> None:
    stream.append(
        {
            "type": "attempt",
            "schema_version": 1,
            "sequence_index": sequence_index,
            "memory_mode": "on",
            "org_id": "org-1",
            "progress": {
                "problems_before": 3,
                "problems_after": 1 if full_green else 2,
                "resolved_count": 2 if full_green else 1,
                "remaining_count": 1,
                "full_green": full_green,
                "attempts_to_green": 1,
                "turns": 2,
                "total_tokens": 1000,
                "wall_seconds": 1.0,
                "wall_cost_usd": 0.0,
            },
            "session_fp": session_fp,
            "session_id": session_id,
        }
    )


def _write_delivery(
    stream: StatusStream,
    *,
    sequence_index: int,
    delivery_state: str,
    not_scored_reason: str,
    memory_mode: str = "on",
) -> None:
    stream.append(
        {
            "type": "delivery",
            "schema_version": 1,
            "sequence_index": sequence_index,
            "memory_mode": memory_mode,
            "org_id": "org-1",
            "delivery_state": delivery_state,
            "not_scored_reason": not_scored_reason,
        }
    )


def _write_scorecard_manifest(tmp_path: Path) -> Path:
    run_manifest_path = default_run_manifest_path(tmp_path / "manifest.json")
    write_run_manifest(
        run_manifest_path,
        RunManifest(
            run_id="run-chunk-c",
            created_at="2026-08-06T00:00:00Z",
            served_model=None,
            requested_model="model-a",
            memory_mode="on",
            org_id="org-1",
        ),
    )
    return tmp_path / "manifest.json"


def test_not_scored_cell_excluded_from_scorecard(tmp_path: Path) -> None:
    manifest_path = _write_scorecard_manifest(tmp_path)
    stream = StatusStream(default_status_stream_path(manifest_path))

    # Cell 0: scored (green). Cell 1: scored (fail). Cell 2: attempt EXISTS
    # (from run_session) BUT is excluded by an unverified delivery record.
    _write_scored_attempt(
        stream, sequence_index=0, session_fp="fp-0", session_id="s-0", full_green=True
    )
    _write_scored_attempt(
        stream, sequence_index=1, session_fp="fp-1", session_id="s-1", full_green=False
    )
    _write_scored_attempt(
        stream, sequence_index=2, session_fp="fp-2", session_id="s-2", full_green=True
    )
    _write_delivery(
        stream,
        sequence_index=2,
        delivery_state="unverified",
        not_scored_reason="delivery proof absent after timeout",
        memory_mode="on",
    )

    scorecard = build_scorecard(manifest_path)

    # Cell 2 is EXCLUDED from the scored set despite its attempt record.
    assert scorecard["scored_sessions"] == 2
    assert scorecard["stream_records"] == 4
    assert [p["sequence_index"] for p in scorecard["convergence"]["points"]] == [0, 1]

    # Distinct not-scored-with-reason outcome carries the reason.
    assert scorecard["not_scored"] == [
        {
            "sequence_index": 2,
            "memory_mode": "on",
            "not_scored_reason": "delivery proof absent after timeout",
        }
    ]

    # scored-pass / scored-fail reflect the reduced scored set only.
    assert scorecard["scored_pass"] == 1  # cell 0 green
    assert scorecard["scored_fail"] == 1  # cell 1 fail


def test_no_delivery_record_scores_all_as_today(tmp_path: Path) -> None:
    manifest_path = _write_scorecard_manifest(tmp_path)
    stream = StatusStream(default_status_stream_path(manifest_path))

    _write_scored_attempt(
        stream, sequence_index=0, session_fp="fp-0", session_id="s-0", full_green=True
    )
    _write_scored_attempt(
        stream, sequence_index=1, session_fp="fp-1", session_id="s-1", full_green=False
    )

    scorecard = build_scorecard(manifest_path)

    # No behavior change: all attempt cells are scored, not_scored is empty.
    assert scorecard["scored_sessions"] == 2
    assert scorecard["not_scored"] == []
    assert scorecard["scored_pass"] == 1
    assert scorecard["scored_fail"] == 1
    assert scorecard["convergence"]["sessions_completed"] == 2


def test_verified_delivery_does_not_exclude(tmp_path: Path) -> None:
    manifest_path = _write_scorecard_manifest(tmp_path)
    stream = StatusStream(default_status_stream_path(manifest_path))

    _write_scored_attempt(
        stream, sequence_index=0, session_fp="fp-0", session_id="s-0", full_green=True
    )
    _write_delivery(
        stream,
        sequence_index=0,
        delivery_state="verified",
        not_scored_reason="",
    )

    scorecard = build_scorecard(manifest_path)

    # Only the fail-closed "unverified" disposition excludes a cell.
    assert scorecard["scored_sessions"] == 1
    assert scorecard["not_scored"] == []
    assert scorecard["scored_pass"] == 1
    assert scorecard["convergence"]["sessions_completed"] == 1


def test_mixed_stream_outcome_counts_consistent_with_convergence(
    tmp_path: Path,
) -> None:
    manifest_path = _write_scorecard_manifest(tmp_path)
    stream = StatusStream(default_status_stream_path(manifest_path))

    _write_scored_attempt(
        stream, sequence_index=0, session_fp="fp-0", session_id="s-0", full_green=True
    )
    _write_scored_attempt(
        stream, sequence_index=1, session_fp="fp-1", session_id="s-1", full_green=False
    )
    _write_scored_attempt(
        stream, sequence_index=2, session_fp="fp-2", session_id="s-2", full_green=True
    )
    _write_delivery(
        stream,
        sequence_index=2,
        delivery_state="unverified",
        not_scored_reason="delivery proof absent",
    )

    scorecard = build_scorecard(manifest_path)
    convergence = scorecard["convergence"]

    reduced = scorecard["scored_sessions"]
    assert scorecard["scored_pass"] + scorecard["scored_fail"] == reduced
    assert scorecard["scored_pass"] == convergence["sessions_green"]
    assert scorecard["scored_fail"] == (
        convergence["sessions_completed"] - convergence["sessions_green"]
    )


# --- WO-NIGHT2-1b chunk 2: scorecard-level VOID-INSTRUMENT classification ---
# --- tests locking the card's contract (RUNBOOK rule 5.10). Recording-level ---
# --- assertion at test_run_cumulative_run_artifacts.py:284 is PRESERVED; the ---
# --- classification contract (truncated cell -> void_instrument, not scored) ---
# --- is asserted here end-to-end through build_scorecard on the REAL surface. ---


def _write_truncated_attempt(
    stream: StatusStream,
    *,
    sequence_index: int,
    session_fp: str,
    session_id: str,
    full_green: bool,
    memory_mode: str = "on",
    terminal_reason: str | None = None,
    provider_truncations: int = 0,
    truncated_turns: int = 0,
    instrument_anomaly_turns: int | None = None,
    unrecovered_anomaly_turns: int | None = None,
    terminal_outcome: bool | None = None,
) -> None:
    """Mirror ``_write_scored_attempt`` but with the per-attempt truncation
    fields that the scorecard's VOID-INSTRUMENT signal reads.

    Defaults carry NO truncation signal (``terminal_reason``/``provider_truncations``/
    ``truncated_turns`` absent or zero) so a caller may also use it for a plain
    non-truncated non-green cell.

    ``unrecovered_anomaly_turns`` is what the void rule actually reads (WO-I2,
    2026-09-07): the producer-stated count of anomalies the harness did NOT
    recover. ``instrument_anomaly_turns`` (non-guard anomalies, recovered ones
    included) stays on the record as data but is no longer the void signal;
    ``truncated_turns`` counts ALL anomalies including loop-guard aborts, which
    are model behaviour and void nothing. Both default down the chain
    (``unrecovered_anomaly_turns`` → ``instrument_anomaly_turns`` →
    ``truncated_turns``) so every existing caller keeps meaning "a genuine
    instrument failure" and still voids — pass ``unrecovered_anomaly_turns=0``
    explicitly to write the recovered-anomaly case, where the harness caught
    and recovered every anomaly.
    """
    if instrument_anomaly_turns is None:
        instrument_anomaly_turns = truncated_turns
    if unrecovered_anomaly_turns is None:
        unrecovered_anomaly_turns = instrument_anomaly_turns
    record: dict[str, Any] = {
        "type": "attempt",
        "schema_version": 1,
        "sequence_index": sequence_index,
        "memory_mode": memory_mode,
        "org_id": "org-1",
        "progress": {
            "problems_before": 3,
            "problems_after": 1 if full_green else 2,
            "resolved_count": 2 if full_green else 1,
            "remaining_count": 1,
            "full_green": full_green,
            "attempts_to_green": 1,
            "turns": 2,
            "total_tokens": 1000,
            "wall_seconds": 1.0,
            "wall_cost_usd": 0.0,
        },
        "session_fp": session_fp,
        "session_id": session_id,
    }
    if terminal_reason is not None:
        record["terminal_reason"] = terminal_reason
    if provider_truncations:
        record["provider_truncations"] = provider_truncations
    if truncated_turns:
        record["truncated_turns"] = truncated_turns
    if instrument_anomaly_turns:
        record["instrument_anomaly_turns"] = instrument_anomaly_turns
    if unrecovered_anomaly_turns:
        record["unrecovered_anomaly_turns"] = unrecovered_anomaly_turns
    if terminal_outcome is not None:
        record["terminal_outcome"] = terminal_outcome
    stream.append(record)


def test_truncated_cell_classified_void_instrument_not_scored(tmp_path: Path) -> None:
    manifest_path = _write_scorecard_manifest(tmp_path)
    stream = StatusStream(default_status_stream_path(manifest_path))

    # Single cell whose terminal attempt is non-green AND died of a transport
    # truncation (full_green=False, terminal_reason="transport_incomplete",
    # truncated_turns=1) — the VOID-INSTRUMENT class per rule 5.10.
    _write_truncated_attempt(
        stream,
        sequence_index=0,
        session_fp="fp-0",
        session_id="s-0",
        full_green=False,
        terminal_reason="transport_incomplete",
        truncated_turns=1,
        terminal_outcome=False,
    )

    scorecard = build_scorecard(manifest_path)

    # Classified VOID-INSTRUMENT with the provider_truncation reason.
    assert scorecard["void_instrument"] == [
        {
            "sequence_index": 0,
            "memory_mode": "on",
            "void_reason": "provider_truncation",
        }
    ]
    assert scorecard["void_instrument"][0]["sequence_index"] == 0
    assert scorecard["void_instrument"][0]["memory_mode"] == "on"
    assert scorecard["void_instrument"][0]["void_reason"] == "provider_truncation"

    # EXCLUDED from the scored set entirely.
    assert scorecard["scored_sessions"] == 0
    assert scorecard["scored_pass"] == 0
    assert scorecard["scored_fail"] == 0
    assert scorecard["convergence"]["sessions_completed"] == 0
    # And NOT mislabelled as a delivery-gate not_scored cell.
    assert scorecard["not_scored"] == []


def test_cell_measured_blind_is_void_instrument_never_a_capability_fail(
    tmp_path: Path,
) -> None:
    """D-SERVE-MESSAGE-500 end-to-end: a blind cell must not be published as FAIL.

    On 2026-08-11 a single HTTP 500 on GET /session/{id}/message ended a cell
    32 minutes in. Gates then ran against a worktree the harness had never
    observed and returned 43 problems. Published as-is that reads as a
    capability FAIL; it is an instrument failure. This pins the distinction on
    the real scorecard surface.
    """
    manifest_path = _write_scorecard_manifest(tmp_path)
    stream = StatusStream(default_status_stream_path(manifest_path))

    record: dict[str, Any] = {
        "type": "attempt",
        "schema_version": 1,
        "sequence_index": 0,
        "memory_mode": "off",
        "org_id": "org-1",
        "terminal_reason": "harness_error",
        # The signal the drive loop now emits when it loses the transcript.
        "observation_lost_turns": 1,
        "progress": {
            "problems_before": None,
            "problems_after": 43,
            "resolved_count": None,
            "remaining_count": 43,
            "full_green": False,
            "turns": 65,
            "total_tokens": 85635,
            "wall_seconds": 1922.87,
            "wall_cost_usd": 0.0,
        },
        "session_fp": "e5037b4b",
        "session_id": "ses_blind",
    }
    stream.append(record)

    scorecard = build_scorecard(manifest_path)

    assert scorecard["void_instrument"][0]["sequence_index"] == 0
    assert scorecard["scored_sessions"] == 0, "a blind cell is never scored"
    assert scorecard["scored_fail"] == 0, (
        "the 43 gate problems must NOT surface as a capability FAIL"
    )


def test_green_with_truncation_still_scored_pass(tmp_path: Path) -> None:
    manifest_path = _write_scorecard_manifest(tmp_path)
    stream = StatusStream(default_status_stream_path(manifest_path))

    # Some turns truncated but the cell still reached green: NOT void, scored PASS.
    _write_truncated_attempt(
        stream,
        sequence_index=0,
        session_fp="fp-0",
        session_id="s-0",
        full_green=True,
        truncated_turns=1,
        terminal_outcome=False,
    )

    scorecard = build_scorecard(manifest_path)

    assert scorecard["void_instrument"] == []
    assert scorecard["scored_sessions"] == 1
    assert scorecard["scored_pass"] == 1
    assert scorecard["scored_fail"] == 0
    assert scorecard["convergence"]["sessions_completed"] == 1


def test_non_green_without_truncation_still_scored_fail(tmp_path: Path) -> None:
    manifest_path = _write_scorecard_manifest(tmp_path)
    stream = StatusStream(default_status_stream_path(manifest_path))

    # Genuine capability failure: non-green terminal attempt with NO truncation
    # signal (all truncation fields absent) — still scored FAIL, not void.
    _write_truncated_attempt(
        stream,
        sequence_index=0,
        session_fp="fp-0",
        session_id="s-0",
        full_green=False,
        terminal_outcome=False,
    )

    scorecard = build_scorecard(manifest_path)

    assert scorecard["void_instrument"] == []
    assert scorecard["scored_sessions"] == 1
    assert scorecard["scored_pass"] == 0
    assert scorecard["scored_fail"] == 1
    assert scorecard["convergence"]["sessions_completed"] == 1


def test_truncation_void_symmetric_across_memory_modes(tmp_path: Path) -> None:
    manifest_path = _write_scorecard_manifest(tmp_path)
    stream = StatusStream(default_status_stream_path(manifest_path))

    # The SAME truncated cell (non-green + transport_incomplete) once under the
    # ON arm and once under the OFF arm. The classification branches on no mode
    # flag, so both land in void_instrument identically.
    _write_truncated_attempt(
        stream,
        sequence_index=0,
        session_fp="fp-0",
        session_id="s-0",
        full_green=False,
        memory_mode="on",
        terminal_reason="transport_incomplete",
        terminal_outcome=False,
    )
    _write_truncated_attempt(
        stream,
        sequence_index=1,
        session_fp="fp-1",
        session_id="s-1",
        full_green=False,
        memory_mode="off",
        terminal_reason="transport_incomplete",
        terminal_outcome=False,
    )

    scorecard = build_scorecard(manifest_path)

    # Both cells voided identically, differing only in their memory_mode label.
    assert scorecard["void_instrument"] == [
        {
            "sequence_index": 0,
            "memory_mode": "on",
            "void_reason": "provider_truncation",
        },
        {
            "sequence_index": 1,
            "memory_mode": "off",
            "void_reason": "provider_truncation",
        },
    ]
    assert scorecard["scored_sessions"] == 0
    assert scorecard["scored_pass"] == 0
    assert scorecard["scored_fail"] == 0


# --- the scorecard as a PUBLISHED ARTIFACT (instrumentation plan, Track A2) ---
# --- The scored/void split existed only in memory, inside a process about to ---
# --- exit. A consumer that cannot read it must either go without or re-derive ---
# --- the VOID-INSTRUMENT rule, and a second implementation of the scoring ---
# --- rule is how the two paths come to disagree. So the producer publishes. ---


def test_write_scorecard_publishes_the_same_dict_build_scorecard_returns(
    tmp_path: Path,
) -> None:
    manifest_path = _write_scorecard_manifest(tmp_path)
    stream = StatusStream(default_status_stream_path(manifest_path))
    _write_scored_attempt(
        stream,
        sequence_index=0,
        session_fp="fp-pub-0",
        session_id="ses-pub-0",
        full_green=True,
    )

    written = write_scorecard(manifest_path)

    assert written == default_scorecard_path(manifest_path)
    assert Path(written).exists()
    # THE ARTIFACT IS THE AUTHORITY'S OWN ANSWER, not a re-shaping of it. If the
    # published file could differ from what the authority computes, a consumer
    # reading the file is back to deriving.
    assert json.loads(Path(written).read_text(encoding="utf-8")) == build_scorecard(
        manifest_path
    )


def test_published_scorecard_carries_the_void_split_a_consumer_needs(
    tmp_path: Path,
) -> None:
    manifest_path = _write_scorecard_manifest(tmp_path)
    stream = StatusStream(default_status_stream_path(manifest_path))
    # One cell that scored, one voided by provider truncation.
    _write_scored_attempt(
        stream,
        sequence_index=0,
        session_fp="fp-pub-a",
        session_id="ses-pub-a",
        full_green=True,
    )
    _write_truncated_attempt(
        stream,
        sequence_index=1,
        session_fp="fp-pub-b",
        session_id="ses-pub-b",
        full_green=False,
        truncated_turns=1,
    )

    payload = json.loads(
        Path(write_scorecard(manifest_path)).read_text(encoding="utf-8")
    )

    # These two numbers are exactly what the board's SCORED and VOIDED slots
    # read. A voided cell and a cell that has not finished were previously
    # indistinguishable on screen; this is the fact that separates them.
    assert payload["scored_sessions"] == 1
    assert [v["sequence_index"] for v in payload["void_instrument"]] == [1]
    assert payload["void_instrument"][0]["void_reason"] == "provider_truncation"


def test_write_scorecard_republishes_as_the_stream_grows(tmp_path: Path) -> None:
    # NOT WRITE-ONCE, unlike the run manifest beside it. The scorecard is derived
    # from artifacts that grow per cell, and it is published after each one so the
    # board tracks the campaign instead of learning everything at the end.
    manifest_path = _write_scorecard_manifest(tmp_path)
    stream = StatusStream(default_status_stream_path(manifest_path))

    _write_scored_attempt(
        stream,
        sequence_index=0,
        session_fp="fp-grow-0",
        session_id="ses-grow-0",
        full_green=True,
    )
    first = json.loads(Path(write_scorecard(manifest_path)).read_text(encoding="utf-8"))
    assert first["scored_sessions"] == 1

    _write_scored_attempt(
        stream,
        sequence_index=1,
        session_fp="fp-grow-1",
        session_id="ses-grow-1",
        full_green=False,
    )
    second = json.loads(
        Path(write_scorecard(manifest_path)).read_text(encoding="utf-8")
    )
    assert second["scored_sessions"] == 2


def test_write_scorecard_never_raises_and_never_costs_the_run(tmp_path: Path) -> None:
    # INSTRUMENTATION-ONLY. There is no run manifest here, so build_scorecard
    # cannot succeed. The contract is that this reports None and the caller --
    # which is on the per-cell hot path -- carries on.
    missing = tmp_path / "no-such-run" / "manifest.json"
    assert write_scorecard(missing) is None
    assert not Path(default_scorecard_path(missing)).exists()


def test_write_scorecard_leaves_no_temp_file_behind(tmp_path: Path) -> None:
    # A poller reads this file while a cell is finishing, so it is replaced
    # atomically. The temp files that makes necessary must not accumulate beside
    # the run's artifacts.
    manifest_path = _write_scorecard_manifest(tmp_path)
    stream = StatusStream(default_status_stream_path(manifest_path))
    _write_scored_attempt(
        stream,
        sequence_index=0,
        session_fp="fp-tmp-0",
        session_id="ses-tmp-0",
        full_green=True,
    )

    write_scorecard(manifest_path)
    write_scorecard(manifest_path)

    leftovers = [p.name for p in tmp_path.iterdir() if p.name.startswith(".")]
    assert leftovers == []


def test_a_looping_model_is_scored_not_voided(tmp_path: Path) -> None:
    """A loop-guard abort is model behaviour, not a broken instrument.

    THE DEFECT THIS PINS (measured, run 1788599410). The cell completed five
    graded attempts and finished at 39/53 — and was voided. All three of its
    "truncations" were ``terminal: guard_abort, reason: loop_guard``, each with
    ``finish_reason: "tool-calls"`` (a clean finish, not ``length``),
    ``truncations_seen: 0``, ``provider_truncations: 0``, and ``retried: true``.
    Nothing had truncated anything; the harness caught a looping model, nudged
    it, and the run carried on.

    The rule read ``truncated_turns``, which is ``len(turn_anomalies)`` — every
    anomaly, guard aborts included — under a comment claiming it was "a
    provider-side truncation signal". Jerry's ruling, 2026-09-05: nudging on a
    loop is model behaviour and must not be a void classifier. A model that
    loops during troubleshooting is a capability observation, and one of the
    more interesting ones this bench can make; voiding the cell deletes it.

    Since WO-I2 (2026-09-07) the void leg reads ``unrecovered_anomaly_turns``,
    so the loop-guard case is modelled by ``truncated_turns=3`` with
    ``unrecovered_anomaly_turns=0``: every anomaly was a recovered
    ``guard_abort``, which the producer never counts as unrecovered (and never
    counts in ``instrument_anomaly_turns`` either).
    """
    manifest_path = _write_scorecard_manifest(tmp_path)
    stream = StatusStream(default_status_stream_path(manifest_path))

    # Anomalous turns, but every one of them a recovered loop-guard abort: no
    # unrecovered instrument failure among them.
    _write_truncated_attempt(
        stream,
        sequence_index=0,
        session_fp="fp-loop",
        session_id="ses-loop",
        full_green=False,
        truncated_turns=3,
        instrument_anomaly_turns=0,
        unrecovered_anomaly_turns=0,
        terminal_reason="attempt_ceiling_reached",
        terminal_outcome=True,
    )

    payload = json.loads(
        Path(write_scorecard(manifest_path)).read_text(encoding="utf-8")
    )
    assert payload["void_instrument"] == [], "a looping model must not void the cell"
    assert payload["scored_sessions"] == 1, "the measurement must survive"


def test_a_real_unrecovered_anomaly_still_voids(tmp_path: Path) -> None:
    """The other half of the ruling: only RECOVERED anomalies stopped voiding.

    A NON-recoverable anomaly — e.g. a ``transport_error``/``error_event`` the
    harness could not retry away — is an instrument failure and is counted by
    ``unrecovered_anomaly_turns`` (WO-I2, 2026-09-07), so a cell whose terminal
    attempt carries one is voided exactly as before. Narrowing the signal must
    not have disarmed it.
    """
    manifest_path = _write_scorecard_manifest(tmp_path)
    stream = StatusStream(default_status_stream_path(manifest_path))

    _write_truncated_attempt(
        stream,
        sequence_index=0,
        session_fp="fp-trunc",
        session_id="ses-trunc",
        full_green=False,
        truncated_turns=3,
        unrecovered_anomaly_turns=1,
        terminal_outcome=True,
    )

    payload = json.loads(
        Path(write_scorecard(manifest_path)).read_text(encoding="utf-8")
    )
    assert [v["sequence_index"] for v in payload["void_instrument"]] == [0]
    assert payload["scored_sessions"] == 0


def test_a_recovered_anomaly_is_scored_not_voided(tmp_path: Path) -> None:
    """A RECOVERED instrument anomaly is a harness success, not a void.

    The pin WO-I2 adds beyond the loop-guard case: an anomaly in a RECOVERABLE
    class (``guard_abort``, ``provider_unavailable``,
    ``stream_finalize_timeout``) never voids REGARDLESS of retry status — the
    producer states the complement directly as ``unrecovered_anomaly_turns``
    and the void leg reads ONLY that. Here a non-green terminal attempt carries
    one anomalous turn the harness recovered (``instrument_anomaly_turns=1``,
    ``unrecovered_anomaly_turns=0``): the measurement is intact, so the cell is
    scored as a genuine FAIL, never voided. Under the old
    ``instrument_anomaly_turns`` leg this cell WOULD have been voided — that
    regression is what this test pins.
    """
    manifest_path = _write_scorecard_manifest(tmp_path)
    stream = StatusStream(default_status_stream_path(manifest_path))

    _write_truncated_attempt(
        stream,
        sequence_index=0,
        session_fp="fp-recovered",
        session_id="ses-recovered",
        full_green=False,
        truncated_turns=1,
        instrument_anomaly_turns=1,
        unrecovered_anomaly_turns=0,
        terminal_reason="attempt_ceiling_reached",
        terminal_outcome=True,
    )

    payload = json.loads(
        Path(write_scorecard(manifest_path)).read_text(encoding="utf-8")
    )
    assert payload["void_instrument"] == [], (
        "a recovered anomaly must not void the cell"
    )
    assert payload["scored_sessions"] == 1, "the measurement must survive"


def test_an_instrument_fault_cell_is_void_and_says_so(tmp_path: Path) -> None:
    # Jerry, 2026-09-23: a grading pass that measured nothing twice on the same
    # code ends the cell as the instrument's failure — void, never scored.
    manifest_path = _write_scorecard_manifest(tmp_path)
    stream = StatusStream(default_status_stream_path(manifest_path))
    _write_truncated_attempt(
        stream,
        sequence_index=0,
        session_fp="fp-0",
        session_id="s-0",
        full_green=False,
        terminal_reason="instrument_fault",
        unrecovered_anomaly_turns=0,
        terminal_outcome=False,
    )
    scorecard = build_scorecard(manifest_path)
    assert scorecard["void_instrument"] == [
        {"sequence_index": 0, "memory_mode": "on", "void_reason": "instrument_fault"}
    ]
