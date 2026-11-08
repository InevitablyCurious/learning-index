"""WO-LIVE-02: the pure per-turn token arithmetic behind ``turn.tokens``.

Every case here is a bill. A wrong total or an unclamped negative misstates
spend, so these pin the mapping, the clamp, and the "nothing observed" case
explicitly.
"""

from __future__ import annotations

from harness.adapters.challenge.token_metrics import (
    TOKEN_FIELDS,
    compute_delta,
    has_token_data,
    metrics_to_cumulative,
)


def _full_metrics() -> dict:
    return {
        "turns": 3,
        "input_tokens": 10_000,
        "output_tokens": 5_000,
        "reasoning_tokens": 2_000,
        "cache_read_tokens": 80_000,
        "cache_write_tokens": 0,
        "cost_usd": 0.42,
    }


def test_token_fields_are_the_canonical_five_in_order() -> None:
    assert TOKEN_FIELDS == ("input", "output", "reasoning", "cache_read", "cache_write")


def test_metrics_to_cumulative_maps_the_five_and_totals_them() -> None:
    assert metrics_to_cumulative(_full_metrics()) == {
        "input": 10_000,
        "output": 5_000,
        "reasoning": 2_000,
        "cache_read": 80_000,
        "cache_write": 0,
        "total": 97_000,
    }


def test_metrics_to_cumulative_treats_missing_and_none_as_zero() -> None:
    cur = metrics_to_cumulative(
        {
            "output_tokens": 123,
            "reasoning_tokens": None,
            "cache_read_tokens": 5_000,
        }
    )
    assert cur == {
        "input": 0,
        "output": 123,
        "reasoning": 0,
        "cache_read": 5_000,
        "cache_write": 0,
        "total": 5_123,
    }


def test_metrics_to_cumulative_of_none_is_all_zero() -> None:
    assert metrics_to_cumulative(None)["total"] == 0


def test_has_token_data_is_false_for_unobservable_reads() -> None:
    assert has_token_data(None) is False
    assert has_token_data({}) is False
    assert has_token_data({"turns": 2, "cost_usd": 0.1}) is False
    assert has_token_data({"input_tokens": None, "output_tokens": None}) is False
    assert has_token_data({"output_tokens": 0}) is True
    assert has_token_data(_full_metrics()) is True


def test_compute_delta_fresh_session_equals_cumulative() -> None:
    cur = metrics_to_cumulative(_full_metrics())
    assert compute_delta(None, cur) == cur
    assert compute_delta(None, cur)["total"] == 97_000


def test_compute_delta_is_the_positive_increment_per_field() -> None:
    prev = {
        "input": 10_000,
        "output": 5_000,
        "reasoning": 2_000,
        "cache_read": 80_000,
        "cache_write": 0,
        "total": 97_000,
    }
    cur = {
        "input": 10_000,
        "output": 5_123,
        "reasoning": 2_045,
        "cache_read": 85_000,
        "cache_write": 0,
        "total": 102_168,
    }
    assert compute_delta(prev, cur) == {
        "input": 0,
        "output": 123,
        "reasoning": 45,
        "cache_read": 5_000,
        "cache_write": 0,
        "total": 5_168,
    }


def test_compute_delta_clamps_a_backwards_counter_to_zero() -> None:
    # A compaction reset the counters: cur is BELOW prev. Nothing new is
    # billable, and a negative bar would be nonsense.
    prev = {
        "input": 40_000,
        "output": 9_000,
        "reasoning": 3_000,
        "cache_read": 120_000,
        "cache_write": 7,
        "total": 172_007,
    }
    cur = {
        "input": 1_000,
        "output": 200,
        "reasoning": 3_500,
        "cache_read": 10_000,
        "cache_write": 0,
        "total": 14_700,
    }
    assert compute_delta(prev, cur) == {
        "input": 0,
        "output": 0,
        "reasoning": 500,
        "cache_read": 0,
        "cache_write": 0,
        "total": 500,
    }


# ── the emitter, end to end through the hermetic serve drive ────────────────
# The pure math above only matters if the drive actually publishes it. These
# drive the REAL `_run_opencode_serve` against the shared fake serve client and
# read the bytes that landed in live.jsonl.


def _turn_records(path):
    import json

    if not path.exists():
        return []
    rows = [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    return [r for r in rows if r.get("kind") == "turn.tokens"]


def _run_one_turn(tmp_path, runner, client, session_id):
    from tests._serve_drive_fakes import _FakeCell

    return runner._run_opencode_serve(
        active_cell=_FakeCell(),
        serve_client=client,
        session_id=session_id,
        prompt="build the game",
        run_label="cell-tok",
        phase="initial-chunk-1",
        phase_label={
            "phase_index": 3,
            "phase_name": "Layer 2 — pieces",
            "phase_kind": "build",
        },
    )


def test_drive_emits_one_turn_tokens_with_the_contracted_shape(tmp_path) -> None:
    from harness.live_stream import LiveStream
    from tests._serve_drive_fakes import _FakeServeClient, _make_runner

    runner = _make_runner(tmp_path)
    runner._cell_seq = 0
    live_path = tmp_path / "live.jsonl"
    runner._live = LiveStream(live_path, run_id="run-tok")

    client = _FakeServeClient()
    client.metrics_result = _full_metrics()
    _run_one_turn(tmp_path, runner, client, "ses_tok")

    records = _turn_records(live_path)
    assert len(records) == 1, "one completed turn -> exactly one turn.tokens"
    rec = records[0]
    assert rec["cell_seq"] == 0
    assert rec["phase_index"] == 3
    assert rec["phase_name"] == "Layer 2 — pieces"
    assert rec["phase_kind"] == "build"
    # First turn of the session: delta IS the cumulative reading.
    assert rec["delta"] == {
        "input": 10_000,
        "output": 5_000,
        "reasoning": 2_000,
        "cache_read": 80_000,
        "cache_write": 0,
        "total": 97_000,
    }
    assert rec["cumulative"] == rec["delta"]


def test_drive_emits_the_increment_between_two_turns_of_one_session(tmp_path) -> None:
    from harness.live_stream import LiveStream
    from tests._serve_drive_fakes import _FakeServeClient, _make_runner

    runner = _make_runner(tmp_path)
    runner._cell_seq = 1
    live_path = tmp_path / "live.jsonl"
    runner._live = LiveStream(live_path, run_id="run-tok")

    client = _FakeServeClient()
    client.metrics_result = _full_metrics()
    _run_one_turn(tmp_path, runner, client, "ses_tok2")

    # The next turn of the SAME session: only the cache read and output grew.
    client.metrics_result = dict(_full_metrics())
    client.metrics_result.update(
        output_tokens=5_123, reasoning_tokens=2_045, cache_read_tokens=85_000
    )
    _run_one_turn(tmp_path, runner, client, "ses_tok2")

    records = _turn_records(live_path)
    assert len(records) == 2
    assert records[1]["delta"] == {
        "input": 0,
        "output": 123,
        "reasoning": 45,
        "cache_read": 5_000,
        "cache_write": 0,
        "total": 5_168,
    }
    assert records[1]["cumulative"]["total"] == 102_168


def test_drive_emits_nothing_when_the_observation_was_lost(tmp_path) -> None:
    from harness.live_stream import LiveStream
    from harness.serve_client import ServeClientError
    from tests._serve_drive_fakes import _FakeServeClient, _make_runner

    runner = _make_runner(tmp_path)
    live_path = tmp_path / "live.jsonl"
    runner._live = LiveStream(live_path, run_id="run-tok")

    client = _FakeServeClient()
    client.metrics_baseline = _full_metrics()
    client.metrics_error_after_baseline = ServeClientError("HTTP Error 500")
    _run_one_turn(tmp_path, runner, client, "ses_lost")

    assert _turn_records(live_path) == [], (
        "an unobservable turn must emit NOTHING, never a fabricated zero"
    )
