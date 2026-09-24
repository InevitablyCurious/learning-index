"""WO-WATCH-1E: hermetic unit tests for ChallengeRunner._run_opencode_serve.

No live server, no docker, no model. A fake ``ServeClient`` stub drives the
serve-drive path and the returned ``_OpencodeRunStats`` is asserted field by
field. ``active_cell`` is a lightweight stand-in exposing ``kill_worker_processes``
(the only ``DockerCell`` surface ``_run_opencode_serve`` touches).

WO-LI18 split scope: the core serve-drive contract (happy path, timeout,
stall, transport/truncation anomalies, metering truth) plus the
bench-session-title format. Shared fakes: tests/_serve_drive_fakes.py.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from harness.adapters.challenge import (
    _STALL_RECOVERY_NUDGE,
    TURN_TERMINAL_OBSERVATION_LOST,
    TURN_TERMINAL_STALLED,
    TURN_TERMINAL_TRANSPORT_ERROR,
    TURN_TERMINAL_TRUNCATED,
    ServeTransportError,
    bench_session_title,
)
from harness.serve_client import ServeClientError
from tests._serve_drive_fakes import (
    _ZERO_METRICS,
    _FakeCell,
    _FakeServeClient,
    _make_runner,
    _metrics,
)


def test_serve_drive_happy_path(tmp_path: Path) -> None:
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.metrics_result = {
        "turns": 4,
        "input_tokens": 100,
        "output_tokens": 50,
        "reasoning_tokens": 25,
        "cost_usd": 0.012,
        "provider_truncations": 0,
        "error_parts": 0,
    }
    cell = _FakeCell()

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_live_1",
        prompt="build the game",
        run_label="cell-1",
        phase="initial",
        timeout_s=123.0,
    )

    assert client.sent_prompts == [("ses_live_1", "build the game")]
    assert client.wait_timeout_s == 123.0
    assert stats.exit_code == 0
    assert stats.killed_reason is None
    assert stats.session_id == "ses_live_1"
    assert stats.turns == 4
    assert stats.input_tokens == 100
    assert stats.output_tokens == 50
    assert stats.reasoning_tokens == 25
    assert stats.cost_usd == 0.012
    assert stats.provider_truncations == 0
    assert stats.turn_anomalies == ()
    assert stats.zero_tool_turn_honest_fail is False
    assert stats.resume_count == 0
    assert stats.unmetered_turns == 0
    assert stats.unmetered_turn_wall_s == 0.0
    assert stats.budget_stop_detected is False
    assert cell.kill_calls == 0


def test_serve_drive_timeout_calls_kill_hook(tmp_path: Path) -> None:
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.wait_result = False
    client.metrics_result = {
        "turns": 2,
        "input_tokens": 60,
        "output_tokens": 30,
        "reasoning_tokens": 10,
        "cost_usd": 0.0,
        "provider_truncations": 0,
        "error_parts": 0,
    }
    cell = _FakeCell()

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_timeout",
        prompt="p",
        run_label="cell-2",
        phase="initial",
        timeout_s=10.0,
    )

    assert cell.kill_calls == 1
    assert client.aborted_sessions == ["ses_timeout"]
    assert stats.killed_reason == "run_timeout"
    assert stats.exit_code == 1
    assert stats.turns == 2


def test_serve_drive_stalled_turn_recovers_with_stall_nudge(
    tmp_path: Path,
) -> None:
    """A wedged turn is RECOVERED, not killed: `turn_stalled` rides the nudge.

    WO-21 STALL-RECOVERY (operator ruling 2026-09-11): a stall is the harness's
    own watchdog saying one command stopped progressing — the same shape as a
    loop kill, so it rides the same recoverable path. The turn is un-stuck
    (abort + kill hook), carried as a `turn_stalled` anomaly with retried=True,
    and the drive re-drives with the stall nudge; killed_reason/exit_code stay
    clean. The old terminal behaviour ended the cell outright — that is what
    cost a live cell 40 minutes on 2026-08-24, with no verdict at all. The
    distinction from `run_timeout` still holds: run_timeout (the whole budget
    exhausted) remains terminal; only the single wedged turn recovers.
    """
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    # Stall ONCE, then the nudged re-drive goes idle.
    client.wait_script = [(False, "stalled"), (True, "idle")]
    client.metrics_script = [
        dict(_ZERO_METRICS),  # phase baseline
        _metrics(5, 100, 40),  # stalled turn read (transcript clean — no signature)
        _metrics(8, 160, 70),  # post-nudge read (session-cumulative)
    ]
    cell = _FakeCell()

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_stalled",
        prompt="p",
        run_label="cell-stall",
        phase="initial",
        timeout_s=10.0,
    )

    # RECOVERED: clean exit, exactly one nudge, no guard abort.
    assert stats.killed_reason is None
    assert stats.exit_code == 0
    assert stats.recovery_nudges == 1
    assert stats.guard_aborted_turns == 0
    sent = [text for _, text in client.sent_prompts]
    assert sent == ["p", _STALL_RECOVERY_NUDGE]
    # The stall is carried as an anomaly record — never silent — and the record
    # is retry-linked, exactly like a recovered loop kill.
    assert len(stats.turn_anomalies) == 1
    record = stats.turn_anomalies[0]
    assert record["terminal"] == TURN_TERMINAL_STALLED
    assert record["reason"] == "tool_call_exceeded_stall_timeout"
    assert record["retried"] is True
    # The turn was genuinely un-stuck, not merely relabelled.
    assert cell.kill_calls == 1
    assert client.aborted_sessions == ["ses_stalled"]
    # And the drive actually asked for a stall bound.
    assert client.stall_timeout_s is not None
    assert client.stall_timeout_s > 0
    # WO-LOOPKILL-1: no worktree on the fake cell -> no marker dir -> the stall
    # recovery rides the watchdog alone; no marker was involved.
    assert client.loop_kill_marker_dir is None


def test_serve_drive_stall_is_not_scored_as_a_model_failure(tmp_path: Path) -> None:
    from harness.adapters.challenge import _HARNESS_LIMIT_REASONS

    assert "turn_stalled" in _HARNESS_LIMIT_REASONS


def test_serve_drive_timeout_abort_failure_still_timeout(tmp_path: Path) -> None:
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.wait_result = False
    client.abort_error = ServeClientError("POST .../abort failed: boom")
    client.metrics_result = {
        "turns": 1,
        "input_tokens": 10,
        "output_tokens": 5,
        "reasoning_tokens": 0,
        "cost_usd": 0.0,
        "provider_truncations": 0,
        "error_parts": 0,
    }
    cell = _FakeCell()

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_timeout_abortfail",
        prompt="p",
        run_label="cell-7",
        phase="initial",
        timeout_s=10.0,
    )

    assert client.aborted_sessions == ["ses_timeout_abortfail"]
    assert cell.kill_calls == 1
    assert stats.killed_reason == "run_timeout"
    assert stats.exit_code == 1
    assert stats.turns == 1


def test_serve_drive_send_error_returns_exit1_no_raise(tmp_path: Path) -> None:
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.send_error = ServeClientError("POST ... failed: boom")
    cell = _FakeCell()

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_senderr",
        prompt="p",
        run_label="cell-3",
        phase="initial",
    )

    assert stats.exit_code == 1
    assert stats.killed_reason is None
    assert stats.turns == 0
    assert stats.input_tokens == 0
    assert stats.output_tokens == 0
    assert stats.cost_usd == 0.0
    assert cell.kill_calls == 0


def test_serve_drive_never_busy_is_loud_exit1_not_clean_zero(tmp_path: Path) -> None:
    """A prompt the serve never picks up must NOT meter as a clean 0-turn ok.

    Regression guard for the 2026-08-09 void: prompt_async is fire-and-forget
    and a bare wait_idle raced the serve's busy flag, returning a false idle
    in milliseconds — turns=0/input=0/output=0 while gates ran against a
    worktree the model was still writing. The drive must first confirm busy
    (wait_busy) and treat never-busy-with-empty-transcript as a loud exit 1.
    """
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.busy_result = False
    client.metrics_result = {
        "turns": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "reasoning_tokens": 0,
        "cost_usd": 0.0,
        "provider_truncations": 0,
        "error_parts": 0,
    }
    cell = _FakeCell()

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_neverbusy",
        prompt="p",
        run_label="cell-nb",
        phase="initial",
    )

    assert stats.exit_code == 1
    assert stats.killed_reason is None
    assert stats.turns == 0
    # Never went busy => the idle wait and the abort/kill path never ran.
    assert client.wait_timeout_s is None
    assert client.aborted_sessions == []
    assert cell.kill_calls == 0


def test_serve_drive_busy_window_raced_turn_is_metered_not_voided(
    tmp_path: Path,
) -> None:
    """A turn that completes entirely inside the busy-grace window is metered.

    If wait_busy never observes busy but the transcript already carries turns,
    the work is real — meter it, never void it.
    """
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.busy_result = False
    client.metrics_result = {
        "turns": 2,
        "input_tokens": 40,
        "output_tokens": 20,
        "reasoning_tokens": 5,
        "cost_usd": 0.0,
        "provider_truncations": 0,
        "error_parts": 0,
    }
    cell = _FakeCell()

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_raced",
        prompt="p",
        run_label="cell-race",
        phase="initial",
    )

    assert stats.exit_code == 0
    assert stats.killed_reason is None
    assert stats.turns == 2
    assert stats.input_tokens == 40
    assert stats.output_tokens == 20
    assert cell.kill_calls == 0


def test_serve_drive_truncation_produces_anomaly(tmp_path: Path) -> None:
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.assistant_terminal_script = [{"step_finish": "stream-incomplete"}]
    client.metrics_result = {
        "turns": 3,
        "input_tokens": 90,
        "output_tokens": 40,
        "reasoning_tokens": 15,
        "cost_usd": 0.0,
        "provider_truncations": 1,
        "error_parts": 0,
    }
    cell = _FakeCell()

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_trunc",
        prompt="p",
        run_label="cell-4",
        phase="initial",
    )

    assert stats.exit_code == 0
    assert len(stats.turn_anomalies) == 1
    anomaly = stats.turn_anomalies[0]
    assert anomaly["terminal"] == TURN_TERMINAL_TRUNCATED
    assert anomaly["reason"] == "stream-incomplete"
    assert anomaly["session_id"] == "ses_trunc"
    assert anomaly["turn_index"] == 3
    assert anomaly["phase"] == "initial"
    assert anomaly["tool_uses"] == 0
    assert anomaly["file_writes"] == 0


def test_serve_drive_transport_error_produces_anomaly(tmp_path: Path) -> None:
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.assistant_terminal_script = [{"error_part": "relay: stream boom"}]
    client.metrics_result = {
        "turns": 1,
        "input_tokens": 10,
        "output_tokens": 5,
        "reasoning_tokens": 0,
        "cost_usd": 0.0,
        "provider_truncations": 0,
        "error_parts": 1,
    }
    cell = _FakeCell()

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_tperr",
        prompt="p",
        run_label="cell-5",
        phase="initial",
    )

    assert len(stats.turn_anomalies) == 1
    anomaly = stats.turn_anomalies[0]
    assert anomaly["terminal"] == TURN_TERMINAL_TRANSPORT_ERROR
    assert anomaly["reason"] == "error_event"


def test_serve_drive_baseline_metrics_error_aborts_never_degrades(
    tmp_path: Path,
) -> None:
    """A phase that cannot read its baseline ABORTS — it never falls back to
    reporting session-CUMULATIVE totals as its own.

    The old behaviour set ``baseline = None`` and carried on, so a phase that
    cost a few thousand tokens published the whole session's running total under
    its own name and nothing on the record said the number was a different kind
    of number. One transport, one metering discipline: an unmeterable phase is a
    failed cell, not a differently-metered one."""
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.metrics_error = ServeClientError("GET ... failed: boom")
    cell = _FakeCell()

    with pytest.raises(ServeTransportError) as excinfo:
        runner._run_opencode_serve(
            active_cell=cell,
            serve_client=client,
            session_id="ses_merr",
            prompt="p",
            run_label="cell-6",
            phase="initial",
        )

    assert "baseline" in str(excinfo.value)
    assert cell.kill_calls == 0


def test_serve_drive_lost_observation_is_recorded_never_silently_clean(
    tmp_path: Path,
) -> None:
    """D-SERVE-MESSAGE-500: a blind phase must declare itself, not read clean.

    When the transcript read fails past serve_client's transient retries, the
    classification window is empty — so ``classify_transport_anomaly`` returns
    (None, None) and, before this fix, the phase fell through recording NO
    anomaly at all. The cell then ran gates against a worktree nobody had
    observed and reported 43 "problems" as if they were a capability result
    (the 2026-08-11 void). The phase must instead carry an explicit
    observation_lost terminal so the cell is gated VOID-INSTRUMENT.
    """
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.metrics_error_after_baseline = ServeClientError(
        "GET /session/ses_x/message failed: HTTP Error 500: Internal Server Error"
    )
    cell = _FakeCell()

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_obs",
        prompt="p",
        run_label="cell-obs",
        phase="initial-chunk-4",
    )

    assert stats.exit_code == 1
    assert stats.observation_lost_turns == 1, "the blind phase must be counted"
    terminals = [a["terminal"] for a in stats.turn_anomalies]
    assert TURN_TERMINAL_OBSERVATION_LOST in terminals, (
        "a phase the harness could not observe must never look like a clean phase"
    )
    lost = next(
        a
        for a in stats.turn_anomalies
        if a["terminal"] == TURN_TERMINAL_OBSERVATION_LOST
    )
    assert lost["tokens_unmetered"] is True, "unobserved tokens are not metered truth"


def test_bench_session_title_format_is_deterministic(tmp_path: Path) -> None:
    """WO-STRIP-2b: ``bench-<org>-<arm>-<cell_ts>``, identifiably."""
    title = bench_session_title("okp-org-0", "off", 1786777435)
    assert title == "bench-okp-org-0-off-1786777435"
    assert bench_session_title("okp-org-0", "on", 1786777435) == (
        "bench-okp-org-0-on-1786777435"
    )


def test_bench_session_title_sanitizes_and_falls_back(tmp_path: Path) -> None:
    """org_id is folded to [A-Za-z0-9-]; empty/none -> literal ``org``."""
    assert bench_session_title("okp/org_0", "off", 1786777435) == (
        "bench-okp-org-0-off-1786777435"
    )
    assert bench_session_title("", "on", 7) == "bench-org-on-7"
    assert bench_session_title(None, "off", 7) == "bench-org-off-7"
