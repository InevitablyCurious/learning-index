"""WO-WATCH-1E: truncation/transport evidence records are self-documenting
and correlation-ready against the local proxy's own ``runs/*.jsonl`` log.

The harness cannot see the proxy's internal trace id at capture time, so every
real truncation/transport-error writes a correlation record (timestamp window +
attempt id + session id + stream counters) that a human or future step matches
against the proxy log by ``ts`` within the recorded window. These tests are
fully hermetic and exercise the pure evidence builder directly — the builder
is live (the serve-drive recovery seam writes evidence through
``_write_truncation_evidence``). The stdout-path end-to-end tests were removed
2026-09-03: they drove the dead stdout subprocess transport and were purged
with it.
"""

from __future__ import annotations

from harness.adapters.challenge import (
    TURN_TERMINAL_TRANSPORT_ERROR,
    TURN_TERMINAL_TRUNCATED,
    _build_truncation_evidence,
    _iso_utc,
)


REQUIRED_FIELDS = {
    "attempt_id",
    "run_label",
    "phase",
    "terminal",
    "reason",
    "ts_start_epoch_ms",
    "ts_end_epoch_ms",
    "wall_seconds",
    "session_id",
    "received_bytes",
    "received_lines",
    "last_event_type",
    "last_event_ts",
    "finish_reason",
    "output_tokens_received",
    "input_tokens_received",
    "reasoning_tokens_received",
    "truncations_seen",
    "correlation",
}


def test_build_truncation_evidence_all_required_fields_with_match_key() -> None:
    ts_start = 1_700_000_000_000
    ts_end = 1_700_000_042_000
    record = _build_truncation_evidence(
        attempt_id="attempt-abc123def456",
        run_label="bk-01",
        phase="initial",
        terminal=TURN_TERMINAL_TRUNCATED,
        reason="stream-incomplete",
        ts_start_epoch_ms=ts_start,
        ts_end_epoch_ms=ts_end,
        wall_seconds=42.0,
        session_id="sess-xyz",
        received_bytes=1234,
        received_lines=57,
        last_event_type="step_finish",
        last_event_ts=1_700_000_040_000,
        finish_reason="stream-incomplete",
        output_tokens_received=300,
        input_tokens_received=1200,
        reasoning_tokens_received=10,
        truncations_seen=1,
    )

    assert set(record.keys()) == REQUIRED_FIELDS
    assert record["attempt_id"] == "attempt-abc123def456"
    assert record["run_label"] == "bk-01"
    assert record["phase"] == "initial"
    assert record["terminal"] == TURN_TERMINAL_TRUNCATED
    assert record["reason"] == "stream-incomplete"
    assert record["ts_start_epoch_ms"] == ts_start
    assert record["ts_end_epoch_ms"] == ts_end
    assert record["wall_seconds"] == 42.0
    assert record["session_id"] == "sess-xyz"
    assert record["received_bytes"] == 1234
    assert record["received_lines"] == 57
    assert record["last_event_type"] == "step_finish"
    assert record["last_event_ts"] == 1_700_000_040_000
    assert record["finish_reason"] == "stream-incomplete"
    assert record["output_tokens_received"] == 300
    assert record["input_tokens_received"] == 1200
    assert record["reasoning_tokens_received"] == 10
    assert record["truncations_seen"] == 1

    corr = record["correlation"]
    assert corr["proxy_log_dir"] == "runs"
    # ts_window is derived from the epoch-ms fields, in UTC ISO form.
    assert corr["ts_window_utc"] == [_iso_utc(ts_start), _iso_utc(ts_end)]
    assert corr["match_key"] == "bk-01|attempt-abc123def456|sess-xyz"
    # The recorded window must actually bracket the anomaly so a human can line
    # it up against the proxy rows by ts.
    assert _iso_utc(ts_start) <= _iso_utc(ts_end)


def test_build_truncation_evidence_none_session_and_missing_attempt() -> None:
    record = _build_truncation_evidence(
        attempt_id=None,
        run_label="bk-02",
        phase="resume",
        terminal=TURN_TERMINAL_TRANSPORT_ERROR,
        reason="error_event",
        ts_start_epoch_ms=None,
        ts_end_epoch_ms=1_700_000_100_000,
        wall_seconds=None,
        session_id=None,
        received_bytes=None,
        received_lines=None,
        last_event_type=None,
        last_event_ts=None,
        finish_reason=None,
        output_tokens_received=0,
        input_tokens_received=0,
        reasoning_tokens_received=0,
        truncations_seen=0,
    )
    assert record["attempt_id"] is None
    assert record["session_id"] is None
    assert record["ts_start_epoch_ms"] is None
    assert record["wall_seconds"] is None
    assert record["received_bytes"] is None
    assert record["received_lines"] is None
    # Window still has a concrete end; start stays None (unknown).
    assert record["correlation"]["ts_window_utc"][1] == _iso_utc(1_700_000_100_000)
    assert record["correlation"]["ts_window_utc"][0] is None
    assert record["correlation"]["match_key"] == "bk-02|none|none"
    assert record["finish_reason"] is None
