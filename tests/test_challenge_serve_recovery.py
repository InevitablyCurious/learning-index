"""WO-LOOPREC-1/WO-LOOPKILL-1/WO-FINALIZE-REC-1: serve-drive recovery tests.

Loop-guard kills (inline and marker-backed), stall nudges, provider-outage
recovery, recovery-budget exhaustion, nudge non-inflation and finalize-timeout
resume — every recovered-not-scored path. WO-LI18 split.
Shared fakes: tests/_serve_drive_fakes.py.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from harness.adapters.challenge import (
    _FINALIZE_RECOVERY_NUDGE,
    _LOOP_RECOVERY_NUDGE,
    _MAX_SERVE_RECOVERY_NUDGES,
    _STALL_RECOVERY_NUDGE,
    LOOP_KILL_MARKER_DIRNAME,
    TURN_TERMINAL_GUARD_ABORT,
    TURN_TERMINAL_STALLED,
    TURN_TERMINAL_TRANSPORT_ERROR,
    TURN_TERMINAL_TRUNCATED,
    _is_unrecovered_anomaly,
)
from tests._serve_drive_fakes import (
    _FIN_SIG,
    _FINALIZE_METRICS,
    _LOOP_METRICS,
    _LOOP_SIG,
    _ZERO_METRICS,
    _FakeCell,
    _FakeServeClient,
    _make_feedback_attempt_kwargs,
    _make_runner,
    _metrics,
    _write_loop_kill_marker,
)


def test_serve_drive_loop_guard_kill_recovers_with_anti_repetition_nudge(
    tmp_path: Path,
) -> None:
    """The 2026-08-10 defect, fixed: a loop kill on the serve path is classified
    guard_abort/loop_guard and re-driven with the anti-repetition nudge (never
    the original prompt) instead of counting the looped turn as completed work.
    """
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.assistant_terminal_script = [{"info_error": _LOOP_SIG}]
    client.metrics_script = [
        dict(_ZERO_METRICS),  # phase baseline
        dict(_LOOP_METRICS),  # loop-killed read
        _metrics(8, 160, 70, guard_aborted=1),  # post-nudge read (session-cumulative)
    ]
    cell = _FakeCell()

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_loop",
        prompt="fix the gates",
        run_label="cell-loop",
        phase="feedback-1",
    )

    sent = [text for _, text in client.sent_prompts]
    assert sent == ["fix the gates", _LOOP_RECOVERY_NUDGE]
    assert stats.exit_code == 0
    assert stats.killed_reason is None
    assert stats.recovery_nudges == 1
    # Looped turn + recovery turn both metered (delta vs baseline)…
    assert stats.output_tokens == 70
    # …but the guard-killed turn is EXCLUDED from scoring turns (WO-TURNACCT-1:
    # 8 metered - 1 guard-aborted), and the exclusion is carried, never silent.
    assert stats.turns == 7
    assert stats.guard_aborted_turns == 1
    assert len(stats.turn_anomalies) == 1
    anomaly = stats.turn_anomalies[0]
    assert anomaly["terminal"] == TURN_TERMINAL_GUARD_ABORT
    assert anomaly["reason"] == "loop_guard"
    # A harness-fired recovery is retry-linked — never retried:false.
    assert anomaly["retried"] is True
    assert anomaly["retry_kind"] == "harness_resume"
    assert cell.kill_calls == 0


def test_serve_drive_recovered_loop_kill_stale_error_not_reclassified(
    tmp_path: Path,
) -> None:
    """The 2026-08-10 live-cell defect: a guard-killed message's info.error
    persists in the transcript FOREVER, so every cumulative read after the
    kill still carries the signature (error_texts, info_errors,
    guard_aborted_turns). After a successful recovery nudge the phase MUST
    classify only the window produced since the nudge — re-reading the stale
    kill nudged an already-recovered drive again and again until
    loop_guard_exhausted killed the cell."""
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.assistant_terminal_script = [{"info_error": _LOOP_SIG}]
    stale_post_nudge = _metrics(8, 160, 70, guard_aborted=1)
    # The real post-recovery cumulative read: the kill's error text is STILL
    # there (the transcript never forgets), alongside the recovered work.
    stale_post_nudge.update(info_errors=1, error_texts=[_LOOP_SIG])
    client.metrics_script = [
        dict(_ZERO_METRICS),  # phase baseline
        dict(_LOOP_METRICS),  # loop-killed read
        stale_post_nudge,  # post-nudge read (stale error carried forward)
    ]
    cell = _FakeCell()

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_loop_stale",
        prompt="fix the gates",
        run_label="cell-loop-stale",
        phase="feedback-1",
    )

    sent = [text for _, text in client.sent_prompts]
    assert sent == ["fix the gates", _LOOP_RECOVERY_NUDGE]  # never a 3rd prompt
    assert stats.exit_code == 0
    assert stats.killed_reason is None
    assert stats.recovery_nudges == 1
    assert stats.turns == 7
    assert stats.guard_aborted_turns == 1
    assert len(stats.turn_anomalies) == 1
    assert stats.turn_anomalies[0]["terminal"] == TURN_TERMINAL_GUARD_ABORT
    assert cell.kill_calls == 0


# ---------------------------------------------------------------------------
# WO-LOOPKILL-1: marker-backed loop kills recover as guard aborts
# ---------------------------------------------------------------------------
def test_serve_drive_ignores_an_unknown_session_marker(tmp_path: Path) -> None:
    """REGRESSION (run 1788883142): loop-kill-unknown.json must not touch a drive.

    The sidecar writes that file for every request carrying no X-Session-Id
    header. Before the fix the reader globbed loop-kill-*.json, so opencode's
    replay of an already-recorded loop-kill error — served to the harness's own
    polls through the ingress forward — refreshed it continuously and aborted
    62 healthy turns across three phases until the run blew the per-benchmark
    error cap. A marker with no session identity is evidence about nothing.
    """
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.metrics_script = [
        dict(_ZERO_METRICS),  # phase baseline
        _metrics(5, 100, 40),  # a clean, completed turn
    ]
    worktree = tmp_path / "run-dir" / "cell-work"
    worktree.mkdir(parents=True)
    marker_dir = worktree.parent / LOOP_KILL_MARKER_DIRNAME
    marker_dir.mkdir()
    cell = _FakeCell()
    cell.config.worktree = str(worktree)
    # Unmistakably fresh, and — as the sidecar writes it — session-less.
    (marker_dir / "loop-kill-unknown.json").write_text(
        json.dumps(
            {
                "session_id": None,
                "timestamp": int(time.time() * 1000) + 60_000,
                "signature": _LOOP_SIG,
            }
        ),
        encoding="utf-8",
    )

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_healthy",
        prompt="fix the gates",
        run_label="cell-unknown-marker",
        phase="feedback-1",
    )

    # The turn ran to completion: no abort, no kill hook, no nudge, no anomaly.
    assert client.aborted_sessions == []
    assert cell.kill_calls == 0
    assert [text for _, text in client.sent_prompts] == ["fix the gates"]
    assert stats.recovery_nudges == 0
    assert stats.turn_anomalies == ()
    assert stats.killed_reason is None
    assert stats.exit_code == 0


def test_serve_drive_consumes_the_marker_so_the_redrive_survives(
    tmp_path: Path,
) -> None:
    """One marker ends ONE turn: the re-drive after the nudge must not die on it.

    The reader consumes the marker when it honours it. Without that, a marker
    that stops being refreshed still kills every later turn whose start
    precedes it — the latch that burned all 20 nudges in three phases.
    """
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.metrics_script = [
        dict(_ZERO_METRICS),  # phase baseline
        _metrics(5, 100, 40),  # marker-killed turn
        _metrics(8, 160, 70),  # the re-drive, which must NOT be killed
    ]
    worktree = tmp_path / "run-dir" / "cell-work"
    worktree.mkdir(parents=True)
    marker_dir = worktree.parent / LOOP_KILL_MARKER_DIRNAME
    marker_dir.mkdir()
    cell = _FakeCell()
    cell.config.worktree = str(worktree)
    marker = _write_loop_kill_marker(
        marker_dir, "ses_marker", ts_ms=int(time.time() * 1000) + 60_000
    )

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_marker",
        prompt="fix the gates",
        run_label="cell-marker-consume",
        phase="feedback-1",
    )

    assert not marker.exists(), "the honoured marker must be consumed"
    # Exactly ONE kill, then a re-drive that completed.
    assert stats.recovery_nudges == 1
    assert len(stats.turn_anomalies) == 1
    assert cell.kill_calls == 1
    assert stats.killed_reason is None
    assert stats.exit_code == 0


def test_serve_drive_marker_backed_loop_kill_recovers_as_guard_abort(
    tmp_path: Path,
) -> None:
    """WO-LOOPKILL-1: a wedged turn ended by a FRESH loop-kill marker is a
    RECOVERABLE guard abort, never the UNRECOVERABLE turn_stalled.

    The sidecar's guard killed the looping request mid-turn, so the transcript
    carries NO loop signature — the marker file is the only kill evidence. The
    drive must un-stick the turn exactly like a stall (abort + kill hook), then
    classify it guard_abort/loop_guard, re-drive with the anti-repetition
    nudge, and exclude the killed turn from scoring turns via
    guard_aborted_turns (the transcript-driven delta cannot see it).
    """
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    # No assistant_terminal_script: the transcript stays CLEAN — the
    # classifier finds nothing, and only the loop-kill MARKER FILE forces the
    # guard-abort terminal. That is the whole point. (This marker is the
    # sidecar's on-disk loop-kill record, unrelated to the deleted
    # model-emitted completion string.)
    client.metrics_script = [
        dict(_ZERO_METRICS),  # phase baseline
        _metrics(5, 100, 40),  # marker-killed turn read (no guard signature)
        _metrics(8, 160, 70),  # post-nudge read (transcript still clean)
    ]
    # A real cell shape: the worktree exists, so the marker dir is
    # <worktree>.parent/loop-kill-markers (the run dir docker_worker mounts).
    worktree = tmp_path / "run-dir" / "cell-work"
    worktree.mkdir(parents=True)
    marker_dir = worktree.parent / LOOP_KILL_MARKER_DIRNAME
    marker_dir.mkdir()
    cell = _FakeCell()
    cell.config.worktree = str(worktree)
    # Freshness contract: the marker must be >= the turn_start_ts_ms the drive
    # records at wait time. The whole drive runs in milliseconds, so a small
    # future buffer keeps "written during this turn" deterministic.
    _write_loop_kill_marker(
        marker_dir, "ses_marker", ts_ms=int(time.time() * 1000) + 60_000
    )

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_marker",
        prompt="fix the gates",
        run_label="cell-marker",
        phase="feedback-1",
    )

    # The waiter got the marker dir and the turn-start freshness bound.
    assert client.loop_kill_marker_dir == str(marker_dir)
    assert client.turn_start_ts_ms is not None
    # Un-stuck exactly like a stall…
    assert client.aborted_sessions == ["ses_marker"]
    assert cell.kill_calls == 1
    # …but RECOVERABLE: no stall kill, the drive re-drove with the nudge.
    assert stats.killed_reason is None
    assert stats.killed_reason != "turn_stalled"
    assert stats.exit_code == 0
    sent = [text for _, text in client.sent_prompts]
    assert sent == ["fix the gates", _LOOP_RECOVERY_NUDGE]
    assert stats.recovery_nudges == 1
    assert len(stats.turn_anomalies) == 1
    anomaly = stats.turn_anomalies[0]
    assert anomaly["terminal"] == TURN_TERMINAL_GUARD_ABORT
    assert anomaly["reason"] == "loop_guard"
    assert anomaly["retried"] is True
    assert anomaly["retry_kind"] == "harness_resume"
    # Accounting: the transcript's guard_aborted_turns delta is 0 (no
    # signature), so the marker kill itself must ride the exclusion —
    # 8 metered turns - 1 marker-backed guard abort = 7 scoring turns.
    assert stats.guard_aborted_turns == 1
    assert stats.turns == 7
    assert stats.output_tokens == 70


def test_serve_drive_stalled_turn_recovers_with_a_recovery_nudge(
    tmp_path: Path,
) -> None:
    """WO-21 STALL-RECOVERY regression: a stalled turn triggers a recovery
    nudge, never a terminal kill.

    End-to-end at the drive level: the watchdog ends the turn (abort + kill
    hook), the classifier forces the `turn_stalled` terminal, the recovery gate
    admits it, and the drive re-drives with `_STALL_RECOVERY_NUDGE` — the cell
    stays alive and the exit stays clean. Under the old terminal behaviour the
    cell died outright: 40 minutes lost, no verdict (2026-08-24).
    """
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    # One stall, then the nudged re-drive completes.
    client.wait_script = [(False, "stalled"), (True, "idle")]
    client.metrics_script = [
        dict(_ZERO_METRICS),  # phase baseline
        _metrics(5, 100, 40),  # stalled turn read
        _metrics(8, 160, 70),  # post-nudge read (session-cumulative)
    ]
    cell = _FakeCell()

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_stall_recover",
        prompt="build the game",
        run_label="cell-stall-recover",
        phase="initial",
    )

    # The stall nudge was ACTUALLY SENT — the recovery is a re-drive, not a
    # relabel — and the drive ended clean.
    sent = [text for _, text in client.sent_prompts]
    assert _STALL_RECOVERY_NUDGE in sent
    assert stats.recovery_nudges == 1
    assert stats.killed_reason is None
    assert stats.exit_code == 0


def test_serve_drive_stall_with_empty_marker_dir_still_recovers(
    tmp_path: Path,
) -> None:
    """WO-LOOPKILL-1 boundary under WO-21 STALL-RECOVERY: with the marker fast
    path WIRED (the dir is passed to the waiter) but NO marker file present, a
    stalled turn STILL recovers via the stall nudge. The marker is loop-kill
    evidence only — a stall never needed one to be recoverable, and the empty
    dir must not reclassify the stall as a guard abort either (that reclass
    requires a fresh marker, never the mere existence of the directory)."""
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    # Stall ONCE, then the nudged re-drive goes idle.
    client.wait_script = [(False, "stalled"), (True, "idle")]
    client.metrics_script = [
        dict(_ZERO_METRICS),  # phase baseline
        _metrics(5, 100, 40),  # stalled turn read (transcript clean)
        _metrics(8, 160, 70),  # post-nudge read (session-cumulative)
    ]
    worktree = tmp_path / "run-dir" / "cell-work"
    worktree.mkdir(parents=True)
    marker_dir = worktree.parent / LOOP_KILL_MARKER_DIRNAME
    marker_dir.mkdir()  # exists but EMPTY
    cell = _FakeCell()
    cell.config.worktree = str(worktree)

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_stall_nomarker",
        prompt="p",
        run_label="cell-stall-nomarker",
        phase="initial",
        timeout_s=10.0,
    )

    # The waiter got the marker dir — the boundary is genuinely exercised —
    # and found nothing in it.
    assert client.loop_kill_marker_dir == str(marker_dir)
    # The stall RECOVERS regardless: nudged, clean exit, no terminal kill.
    assert stats.recovery_nudges == 1
    assert stats.killed_reason is None
    assert stats.exit_code == 0
    assert stats.guard_aborted_turns == 0
    sent = [text for _, text in client.sent_prompts]
    # The STALL nudge — never the loop-kill nudge, which needs a fresh marker.
    assert sent == ["p", _STALL_RECOVERY_NUDGE]
    # One anomaly, recorded as the stall — NOT reclassified as a guard abort.
    assert len(stats.turn_anomalies) == 1
    assert stats.turn_anomalies[0]["terminal"] == TURN_TERMINAL_STALLED
    assert stats.turn_anomalies[0]["retried"] is True
    # Un-stuck exactly like any wedged turn.
    assert cell.kill_calls == 1
    assert client.aborted_sessions == ["ses_stall_nomarker"]


def test_serve_drive_stale_loop_error_from_prior_phase_not_reclassified(
    tmp_path: Path,
) -> None:
    """Cross-phase staleness: a kill classified and recovered in an earlier
    phase is still in the transcript when a LATER phase runs. The later
    phase's window starts at its own baseline, so the old kill cannot poison
    its classification."""
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.assistant_terminal_script = [{"info_error": _LOOP_SIG}]
    stale_end = _metrics(8, 160, 70, guard_aborted=1)
    stale_end.update(info_errors=1, error_texts=[_LOOP_SIG])
    client.metrics_script = [
        dict(_ZERO_METRICS),  # phase-1 baseline
        dict(_LOOP_METRICS),  # phase-1 loop-killed read
        stale_end,  # phase-1 post-nudge read
        stale_end,  # phase-2 baseline (cumulative: unchanged)
        _metrics(11, 200, 95, guard_aborted=1),  # phase-2 end (stale too, via window)
    ]
    cell = _FakeCell()

    first = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_stale_phase",
        prompt="chunk one",
        run_label="cell-stale-phase",
        phase="initial-chunk-1",
    )
    second = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_stale_phase",
        prompt="chunk two",
        run_label="cell-stale-phase",
        phase="initial-chunk-2",
    )

    assert first.exit_code == 0 and first.recovery_nudges == 1
    assert second.exit_code == 0
    assert second.killed_reason is None
    assert second.recovery_nudges == 0
    assert second.turn_anomalies == ()
    assert second.turns == 3
    assert [text for _, text in client.sent_prompts] == [
        "chunk one",
        _LOOP_RECOVERY_NUDGE,
        "chunk two",
    ]
    assert cell.kill_calls == 0


def test_serve_drive_loop_guard_nudges_recover_well_past_the_old_budget(
    tmp_path: Path,
) -> None:
    """A guard kill that keeps repeating is nudged through the burst and the
    phase recovers — 4 consecutive kills here, far past the pre-WO-NUDGE-INF-1
    budget of 2 that voided the 2026-08-10 run, and comfortably inside the
    terminating _MAX_SERVE_RECOVERY_NUDGES budget (WO-COMPACTION-RESTORE C5A).
    Recovery within the budget is never a bench-voiding fault."""
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.assistant_terminal_script = [
        {"info_error": _LOOP_SIG},
        {"info_error": _LOOP_SIG},
        {"info_error": _LOOP_SIG},
        {"info_error": _LOOP_SIG},
    ]
    client.metrics_script = [
        dict(_ZERO_METRICS),  # baseline
        dict(_LOOP_METRICS),  # loop kill -> nudge 1
        dict(_LOOP_METRICS),  # re-loops -> nudge 2 (old budget ended HERE)
        dict(_LOOP_METRICS),  # re-loops -> nudge 3
        dict(_LOOP_METRICS),  # re-loops -> nudge 4
        _metrics(9, 200, 90, guard_aborted=1),  # finally recovers
    ]
    cell = _FakeCell()

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_loop_x",
        prompt="fix the gates",
        run_label="cell-loop-x",
        phase="feedback-1",
    )

    # Four nudges past the old budget of 2, then a clean phase.
    assert stats.exit_code == 0
    assert stats.killed_reason is None
    assert stats.recovery_nudges == 4
    sent = [text for _, text in client.sent_prompts]
    assert sent == ["fix the gates"] + [_LOOP_RECOVERY_NUDGE] * 4
    # Every killed turn is retry-linked — none left dangling as an unretried
    # anomaly, which is what an exhaustion exit used to produce.
    assert len(stats.turn_anomalies) == 4
    assert all(a["retried"] is True for a in stats.turn_anomalies)
    assert all(a["retry_kind"] == "harness_resume" for a in stats.turn_anomalies)
    # Tokens stay fully metered across recovery (real burn shown).
    assert stats.output_tokens == 90
    # …and the nudges never inflate the measurement: 9 metered turns less the
    # excluded guard-killed turn.
    assert stats.turns == 8
    assert stats.guard_aborted_turns == 1


def test_serve_drive_recovery_budget_exhaustion_fails_closed(
    tmp_path: Path,
) -> None:
    """WO-COMPACTION-RESTORE C5A: a kill that repeats past the terminating
    _MAX_SERVE_RECOVERY_NUDGES budget stops being re-driven. The exhaustion
    surfaces through the SAME path a NON-recoverable terminal uses: the loop
    breaks, the drive ends, the kill that exhausted the budget stays
    UNRETRIED on the ledger (every nudged one before it stays retry-linked),
    and the phase is never killed over it. The 2026-09-02 compaction-looping
    incident rode this loop to 126+ recovery events with no exit; the budget
    is what makes that storm terminate."""
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    budget = _MAX_SERVE_RECOVERY_NUDGES
    # One drive per recovery nudge PLUS the original, every one loop-killed;
    # the kill after the budget is spent is never re-driven.
    client.assistant_terminal_script = [{"info_error": _LOOP_SIG}] * (budget + 1)
    client.metrics_script = [dict(_ZERO_METRICS)] + [
        dict(_LOOP_METRICS) for _ in range(budget + 1)
    ]
    cell = _FakeCell()

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_loop_exhaust",
        prompt="fix the gates",
        run_label="cell-loop-exhaust",
        phase="feedback-1",
    )

    # The drive ENDED at the budget instead of looping: exactly `budget`
    # re-drives were sent after the original prompt, then the loop broke.
    assert stats.recovery_nudges == budget
    sent = [text for _, text in client.sent_prompts]
    assert sent == ["fix the gates"] + [_LOOP_RECOVERY_NUDGE] * budget
    # Same shape as a non-recoverable terminal: the drive returns, the
    # exhausting kill is carried UNRETRIED (the ledger's visible seam), and
    # every kill that WAS nudged stays retry-linked.
    assert stats.exit_code == 0
    assert stats.killed_reason is None
    assert len(stats.turn_anomalies) == budget + 1
    assert all(a["retried"] is True for a in stats.turn_anomalies[:budget])
    last = stats.turn_anomalies[-1]
    assert last["retried"] is False
    assert last["retry_kind"] is None
    assert last["terminal"] == TURN_TERMINAL_GUARD_ABORT
    # The burned turns stay metered and excluded, exactly as within budget.
    assert stats.guard_aborted_turns == 1
    assert cell.kill_calls == 0


def test_serve_drive_nudges_never_inflate_scoring_turns(
    tmp_path: Path,
) -> None:
    """WO-NUDGE-INF-1: recovery nudging must not buy the model turns. Every
    recovered (guard- or finalize-killed) turn is subtracted from scoring turns,
    so a phase nudged N times scores exactly what an un-nudged phase scores —
    while its tokens stay on the meter."""
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.assistant_terminal_script = [
        {"info_error": _FIN_SIG},
        {"info_error": _LOOP_SIG},
    ]
    client.metrics_script = [
        dict(_ZERO_METRICS),  # baseline
        dict(_FINALIZE_METRICS),  # finalize kill -> nudge
        dict(_LOOP_METRICS),  # guard kill   -> nudge
        _metrics(10, 220, 100, guard_aborted=1, finalize=1),  # recovered
    ]
    cell = _FakeCell()

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_noinflate",
        prompt="fix the gates",
        run_label="cell-noinflate",
        phase="feedback-1",
    )

    assert stats.exit_code == 0
    assert stats.recovery_nudges == 2
    # 10 metered turns - 1 guard-killed - 1 finalize-killed = 8 scoring turns.
    assert stats.turns == 8
    assert stats.guard_aborted_turns == 1
    assert stats.finalize_timeout_turns == 1
    # Exclusions are reported, never silent; tokens are never hidden.
    assert stats.output_tokens == 100
    assert stats.input_tokens == 220


def test_run_cell_attempt_loop_guard_recovery_on_repair_leg(tmp_path: Path) -> None:
    """The repair leg (feedback attempt) gets the same recovery — RC-4: the
    drive is arm-identical regardless of phase."""
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.assistant_terminal_script = [{"info_error": _LOOP_SIG}]
    client.metrics_script = [
        dict(_ZERO_METRICS),  # baseline
        dict(_LOOP_METRICS),  # loop kill
        _metrics(7, 150, 60, guard_aborted=1),  # post-nudge
    ]
    cell = _FakeCell()
    runner._serve_client = client
    runner._cell_session_id = "ses_repair_loop"
    events_path = tmp_path / "fb-loop.events.jsonl"

    feedback = "These are still failing — fix the implementation so they pass."
    kwargs = _make_feedback_attempt_kwargs(
        feedback_text=feedback,
        phase="feedback-1",
        kill_hook=cell.kill_worker_processes,
    )
    stats = runner._run_cell_attempt(**kwargs)

    assert [text for _, text in client.sent_prompts] == [feedback, _LOOP_RECOVERY_NUDGE]
    assert stats.exit_code == 0
    assert stats.recovery_nudges == 1
    assert stats.turn_anomalies[0]["terminal"] == TURN_TERMINAL_GUARD_ABORT
    assert stats.turn_anomalies[0]["retried"] is True
    assert cell.kill_calls == 0


def test_serve_drive_provider_outage_is_recovered_not_scored(tmp_path: Path) -> None:
    """A provider outage is nudged past, waited out, and never counted against
    the model.

    Live 2026-08-24: the provider answered "The upstream provider is
    temporarily unavailable" and the turn simply died. Outages were not in the
    recoverable set, so the work in that turn was lost and the cell was scored
    as if the model had produced nothing.
    """
    from harness.adapters.challenge import _PROVIDER_RECOVERY_NUDGE

    runner = _make_runner(tmp_path)
    waits: list[float] = []
    runner._provider_backoff = lambda seconds: waits.append(seconds)  # never sleep

    live_error = (
        '{"name":"UnknownError","data":{"message":""The upstream provider is '
        'temporarily unavailable. Please try again later.""}}'
    )
    client = _FakeServeClient()
    client.assistant_terminal_script = [{"info_error": live_error}]
    outage = dict(_ZERO_METRICS)
    outage.update(info_errors=1, provider_truncations=1, error_texts=[live_error])
    client.metrics_script = [
        dict(_ZERO_METRICS),  # baseline
        outage,  # the provider goes away
        dict(_ZERO_METRICS, turns=3, output_tokens=120),  # recovered, real work
    ]
    cell = _FakeCell()

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_provider",
        prompt="fix the failures",
        run_label="cell-provider",
        phase="feedback-1",
    )

    # It was recovered rather than abandoned.
    assert stats.recovery_nudges == 1
    # It waited before asking again instead of hammering a downed provider.
    assert waits and waits[0] > 0
    # The model was nudged in plain language that says nothing about providers.
    assert any(
        prompt == _PROVIDER_RECOVERY_NUDGE for _sid, prompt in client.sent_prompts
    )
    # The turn is recorded, and recorded as retried — never silently dropped.
    outages = [a for a in stats.turn_anomalies if a["reason"] == "provider_unavailable"]
    assert len(outages) == 1
    assert outages[0]["retried"] is True
    # And the cell was not killed over someone else's downtime.
    assert cell.kill_calls == 0


def test_serve_drive_loop_recovery_zero_delta_stays_loud(tmp_path: Path) -> None:
    """A loop kill that produced nothing is recovered, but if the recovered
    phase STILL produced nothing the silent-phase guard fires — never nudged
    into looking healthy."""
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.assistant_terminal_script = [
        {"info_error": "relay_loop_detected n=40 limit=3"}
    ]
    loop_zero = dict(_ZERO_METRICS)
    loop_zero.update(
        info_errors=1,
        error_texts=["relay_loop_detected n=40 limit=3"],
    )
    client.metrics_script = [
        dict(_ZERO_METRICS),  # baseline
        loop_zero,  # loop kill, zero deltas
        dict(_ZERO_METRICS),  # post-nudge: clean, still zero
    ]
    cell = _FakeCell()

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_loop_silent",
        prompt="fix the gates",
        run_label="cell-loop-silent",
        phase="feedback-1",
    )

    assert stats.exit_code == 1
    assert stats.recovery_nudges == 1
    terminals = [a["terminal"] for a in stats.turn_anomalies]
    assert TURN_TERMINAL_GUARD_ABORT in terminals
    assert "silent_phase" in terminals
    assert cell.kill_calls == 0


def test_chunked_pass_loop_guard_recovery_inside_chunk(tmp_path: Path) -> None:
    """The building leg recovers in-chunk: the loop kill is nudged, the
    recovered drive completes, the chunk plan advances, and the chunk report
    carries the recovery-nudge + guard-excluded counts.

    This is also the 2026-08-10 live-cell incident replay: every cumulative
    read after the kill STILL carries the kill's error text (a persisted
    info.error never leaves the transcript). The post-nudge classification
    must read only the window produced since the nudge — never re-classify
    the stale kill (that misread nudged an already-recovered drive twice more
    and killed the cell loop_guard_exhausted)."""
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.assistant_terminal_script = [{"info_error": _LOOP_SIG}]
    stale_post_nudge = _metrics(6, 120, 50, guard_aborted=1)
    stale_post_nudge.update(info_errors=1, error_texts=[_LOOP_SIG])
    stale_chunk2_end = _metrics(9, 200, 90, guard_aborted=1)
    stale_chunk2_end.update(info_errors=1, error_texts=[_LOOP_SIG])
    client.metrics_script = [
        dict(_ZERO_METRICS),  # chunk-1 baseline
        dict(_LOOP_METRICS),  # chunk-1 loop-killed read
        stale_post_nudge,  # chunk-1 post-nudge read (stale error carried)
        _metrics(6, 120, 50, guard_aborted=1),  # chunk-2 baseline
        stale_chunk2_end,  # chunk-2 end read (stale error carried)
    ]
    client.assistant_texts = [
        # The killed chunk-1 drive persists no text (info_error shape above).
        "recovered work, carried on where I stopped",  # loop-recovery nudge
        "chunk two done",  # chunk-2 drive
    ]
    cell = _FakeCell()

    stats = runner._run_opencode_serve_chunked(
        active_cell=cell,
        serve_client=client,
        session_id="ses_chunk_loop",
        prompts=["CHUNK ONE", "CHUNK TWO"],
        run_label="cell-chunk-loop",
    )

    sent = [text for _, text in client.sent_prompts]
    assert sent == ["CHUNK ONE", _LOOP_RECOVERY_NUDGE, "CHUNK TWO"]
    assert stats.exit_code == 0
    assert stats.recovery_nudges == 1
    # Chunk 1: 6 metered - 1 guard-aborted = 5 scoring; chunk 2: 3 scoring.
    assert stats.turns == 8
    assert stats.guard_aborted_turns == 1
    assert stats.chunk_reports[0]["recovery_nudges"] == 1
    assert stats.chunk_reports[0]["guard_aborted_turns"] == 1
    assert stats.chunk_reports[0]["exit_code"] == 0
    assert stats.chunk_reports[1]["recovery_nudges"] == 0
    assert stats.chunk_reports[1]["exit_code"] == 0


# ---------------------------------------------------------------------------
# WO-FINALIZE-REC-1 (Walter 2026-08-10): finalize-watchdog kills get recovery
# too — with the RESUME nudge, never the anti-repetition nudge.
# WO-COMPACTION-RESTORE C5A: that recovery is bounded by
# _MAX_SERVE_RECOVERY_NUDGES and fails closed on exhaustion.
# ---------------------------------------------------------------------------
def test_serve_drive_finalize_timeout_recovers_with_resume_nudge(
    tmp_path: Path,
) -> None:
    """A relay finalize-watchdog kill is classified
    transport_error/stream_finalize_timeout and re-driven with the resume
    nudge (the turn was cut off, NOT looping — the anti-repetition nudge
    would be the wrong instruction). The killed turn is excluded from scoring
    turns (WO-NUDGE-INF-1), exactly as a guard-killed turn is."""
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.assistant_terminal_script = [{"info_error": _FIN_SIG}]
    client.metrics_script = [
        dict(_ZERO_METRICS),  # phase baseline
        dict(_FINALIZE_METRICS),  # finalize-killed read
        _metrics(8, 160, 70, finalize=1),  # post-nudge read (session-cumulative)
    ]
    cell = _FakeCell()

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_fin",
        prompt="fix the gates",
        run_label="cell-fin",
        phase="feedback-1",
    )

    sent = [text for _, text in client.sent_prompts]
    assert sent == ["fix the gates", _FINALIZE_RECOVERY_NUDGE]
    assert stats.exit_code == 0
    assert stats.killed_reason is None
    assert stats.recovery_nudges == 1
    # WO-NUDGE-INF-1: the finalize-killed turn is EXCLUDED from scoring turns
    # (8 metered - 1 finalize-killed), so recovery cannot inflate the
    # measurement; the exclusion is carried, never silent.
    assert stats.turns == 7
    assert stats.finalize_timeout_turns == 1
    assert stats.guard_aborted_turns == 0
    assert len(stats.turn_anomalies) == 1
    anomaly = stats.turn_anomalies[0]
    assert anomaly["terminal"] == TURN_TERMINAL_TRANSPORT_ERROR
    assert anomaly["reason"] == "stream_finalize_timeout"
    assert anomaly["retried"] is True
    assert anomaly["retry_kind"] == "harness_resume"
    assert _is_unrecovered_anomaly(anomaly) is False  # recovered → not unrecovered
    assert (
        _is_unrecovered_anomaly(
            {"terminal": TURN_TERMINAL_TRUNCATED, "reason": "stream-incomplete"}
        )
        is True
    )  # a non-recoverable class still counts
    assert cell.kill_calls == 0


def test_serve_drive_finalize_timeout_burst_recovers_within_budget(
    tmp_path: Path,
) -> None:
    """Replays the 2026-08-11 incident: phase initial-chunk-6 took THREE
    consecutive finalize kills. Under the pre-WO-NUDGE-INF-1 budget of 2 the
    third exhausted recovery -> stream_finalize_exhausted -> gates ran on
    partial work and the run died. Inside the terminating
    _MAX_SERVE_RECOVERY_NUDGES budget (WO-COMPACTION-RESTORE C5A) the third
    kill is nudged like the first and the phase recovers."""
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.assistant_terminal_script = [
        {"info_error": _FIN_SIG},
        {"info_error": _FIN_SIG},
        {"info_error": _FIN_SIG},
    ]
    client.metrics_script = [
        dict(_ZERO_METRICS),  # baseline
        dict(_FINALIZE_METRICS),  # kill 1 -> nudge 1
        dict(_FINALIZE_METRICS),  # kill 2 -> nudge 2 (old budget ended HERE)
        dict(_FINALIZE_METRICS),  # kill 3 -> nudge 3 (was: exhausted, exit 1)
        _metrics(9, 200, 90, finalize=1),  # recovers
    ]
    cell = _FakeCell()

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_fin_x",
        prompt="fix the gates",
        run_label="cell-fin-x",
        phase="initial-chunk-6",
    )

    assert stats.exit_code == 0
    assert stats.killed_reason is None
    assert stats.recovery_nudges == 3
    assert len(stats.turn_anomalies) == 3
    assert all(a["reason"] == "stream_finalize_timeout" for a in stats.turn_anomalies)
    assert all(a["retried"] is True for a in stats.turn_anomalies)
    # True burn is never hidden, and the nudges bought no scoring turns.
    assert stats.output_tokens == 90
    assert stats.turns == 8
    assert stats.finalize_timeout_turns == 1


def test_the_models_own_terminals_are_not_instrument_anomalies() -> None:
    """Run 1790258326: three cap cut-offs read as three stream (instrument)
    errors on the board beside the same three CUT-OFFS. A cut-off is the model
    running into the fixed output cap — model behaviour, like a loop-guard kill
    or a stall; each has its own slot and none is the instrument breaking."""
    from harness.adapters.challenge import _is_instrument_anomaly
    from harness.adapters.challenge.constants import TURN_TERMINAL_CAP_CUTOFF

    for terminal in (
        TURN_TERMINAL_GUARD_ABORT,
        TURN_TERMINAL_STALLED,
        TURN_TERMINAL_CAP_CUTOFF,
    ):
        assert (
            _is_instrument_anomaly(
                {"terminal": terminal, "reason": "stream-incomplete"}
            )
            is False
        )
    for terminal in (TURN_TERMINAL_TRANSPORT_ERROR, TURN_TERMINAL_TRUNCATED):
        assert (
            _is_instrument_anomaly(
                {"terminal": terminal, "reason": "stream-incomplete"}
            )
            is True
        )


def test_serve_drive_model_silence_is_ours_and_gets_the_connection_line(
    tmp_path: Path,
) -> None:
    """Run 1790258326 told a thinking model "That command ran ten minutes, so I
    cancelled it" — no command was running. When the stall bound fires with no
    command running, the wait says model_silent: the turn is ended the same way
    as a stall, recorded as a transport error of OURS (reason model_silent,
    recovered like a provider outage — Jerry, 2026-09-24) and re-driven with the
    existing connection line, never the stall line."""
    from harness.adapters.challenge import (
        _PROVIDER_RECOVERY_NUDGE,
        _is_instrument_anomaly,
    )
    from harness.serve_client import REASON_MODEL_SILENT

    runner = _make_runner(tmp_path)
    waits: list[float] = []
    runner._provider_backoff = lambda seconds: waits.append(seconds)  # never sleep
    client = _FakeServeClient()
    client.wait_script = [(False, REASON_MODEL_SILENT), (True, "idle")]
    client.metrics_script = [
        dict(_ZERO_METRICS),  # phase baseline
        _metrics(5, 100, 40),  # silent turn read
        _metrics(8, 160, 70),  # post-nudge read (session-cumulative)
    ]
    cell = _FakeCell()

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_silent",
        prompt="build the game",
        run_label="cell-silent",
        phase="initial",
    )

    sent = [text for _, text in client.sent_prompts]
    assert _PROVIDER_RECOVERY_NUDGE in sent
    assert _STALL_RECOVERY_NUDGE not in sent, (
        "no command ran; the stall line would be false"
    )
    assert stats.recovery_nudges == 1
    assert stats.killed_reason is None
    assert stats.exit_code == 0
    assert len(waits) == 1, "held off like any provider outage before asking again"
    (anomaly,) = stats.turn_anomalies
    assert anomaly["terminal"] == TURN_TERMINAL_TRANSPORT_ERROR
    assert anomaly["reason"] == REASON_MODEL_SILENT
    assert anomaly["retried"] is True
    assert _is_instrument_anomaly(anomaly) is True, "the model server's silence is ours"
    assert _is_unrecovered_anomaly(anomaly) is False, "recovered: never a void"
