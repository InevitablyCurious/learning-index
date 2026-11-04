"""In-drive compactions-before-grade: the abort now fires WHILE the drive runs.

The rule (harness/adapters/challenge/runner.py COMPACTIONS_BEFORE_GRADE) used to
be checked only after a troubleshoot drive returned. A model that compacts
across recovered turns inside one drive never returns, so the check never ran.
The count now lives INSIDE ``ServeClient.wait_idle_detailed``: the drive hands
the wait the grade watermark, the wait counts COMPLETED compactions since it on
its own poll ticks (and once more before it returns idle), and at the second one
it returns ``compactions_before_grade``. The drive maps that reason to
``compactions_since_grade = 2`` (harness/adapters/challenge/serve.py); the
runner maps that signal to the terminal. The wait reports a count only at the
threshold, so the drive emits 2 or nothing — a single compaction is absorbed by
the wait and never surfaces as 1. These tests drive the REAL
``_run_opencode_serve`` / ``_run_cell_attempt`` / ``_run_opencode_serve_chunked``
with a fake serve client whose ``compactions_per_send`` injects finished
compactions DURING a running drive (one entry popped per turn), never pre-loaded
before it returns.
"""

from __future__ import annotations

from pathlib import Path

from tests._serve_drive_fakes import (
    _LOOP_METRICS,
    _LOOP_SIG,
    _ZERO_METRICS,
    _FakeCell,
    _FakeServeClient,
    _make_feedback_attempt_kwargs,
    _make_runner,
    _metrics,
)


def test_two_compactions_inside_one_running_drive_end_it(tmp_path: Path) -> None:
    """Two finished compactions appearing inside ONE feedback turn end the drive
    with the count carried on ``compactions_since_grade``: exit clean, no worker
    kill, no re-drive."""
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.compactions_per_send = [2]
    client.metrics_script = [dict(_ZERO_METRICS), _metrics(2, 10, 5)]
    runner._serve_client = client
    runner._cell_session_id = "ses_a"
    cell = _FakeCell()

    stats = runner._run_cell_attempt(
        **_make_feedback_attempt_kwargs(
            feedback_text="fix the gates",
            phase="feedback-1",
            kill_hook=cell.kill_worker_processes,
            active_cell=cell,
            compaction_watermark=0,
        )
    )

    assert stats.compactions_since_grade == 2
    assert stats.exit_code == 0
    assert stats.killed_reason is None
    assert len(client.sent_prompts) == 1, (
        "the drive ends at the second compaction, no re-drive"
    )


def test_two_compactions_across_recovered_turns_end_the_drive(
    tmp_path: Path,
) -> None:
    """The "drive never returns" case: one compaction per recovered turn aborts
    at the SECOND, after exactly one recovery nudge, instead of nudging the whole
    budget."""
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    # Turn 1 is a relay loop-guard kill (recoverable) that ALSO compacted once;
    # turn 2 compacts once more -> the in-wait count ends the drive at the
    # second, BEFORE turn 2 would be classified and nudged again.
    client.assistant_terminal_script = [{"info_error": _LOOP_SIG}]
    client.compactions_per_send = [1, 1]
    client.metrics_script = [
        dict(_ZERO_METRICS),  # phase baseline
        dict(_LOOP_METRICS),  # turn 1 loop-killed read
        _metrics(8, 160, 70, guard_aborted=1),  # turn 2 read
    ]
    runner._serve_client = client
    runner._cell_session_id = "ses_recover"
    cell = _FakeCell()

    stats = runner._run_cell_attempt(
        **_make_feedback_attempt_kwargs(
            feedback_text="fix the gates",
            phase="feedback-1",
            kill_hook=cell.kill_worker_processes,
            active_cell=cell,
            compaction_watermark=0,
        )
    )

    assert stats.compactions_since_grade == 2
    assert stats.recovery_nudges == 1, "one nudge happened; the abort stops the second"
    assert len(client.sent_prompts) == 2, (
        "turn 1 + turn 2 only — the old path would keep nudging"
    )
    assert stats.killed_reason is None
    assert stats.exit_code == 0


def test_build_phase_compactions_never_count_or_end_the_build(
    tmp_path: Path,
) -> None:
    """A build drive that compacts twice mid-chunk (and the harness's own
    summarize) never counts and never ends the build: the chunked driver passes
    no watermark."""
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    client.compactions_per_send = [2]
    client.metrics_script = [dict(_ZERO_METRICS), _metrics(2, 10, 5)]

    stats = runner._run_opencode_serve_chunked(
        active_cell=_FakeCell(),
        serve_client=client,
        session_id="ses_build",
        prompts=["ONLY CHUNK"],
        run_label="cell-build",
    )

    assert stats.exit_code == 0
    assert stats.killed_reason is None
    assert stats.compactions_since_grade == 0, (
        "the build passes no watermark, so it never counts"
    )
    assert len(client.sent_prompts) == 1, (
        "the build chunk completes; it is not ended by compaction"
    )
    assert len(client.summarize_calls) == 1, (
        "the harness's own once-per-chunk summarize still fires"
    )


def test_one_compaction_does_not_end_the_drive(tmp_path: Path) -> None:
    """ONE compaction is healthy recovery: the wait absorbs it (its count only
    surfaces at the threshold) and the drive completes normally, never ending
    the cell."""
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.compactions_per_send = [1]
    client.metrics_script = [dict(_ZERO_METRICS), _metrics(2, 10, 5)]
    runner._serve_client = client
    runner._cell_session_id = "ses_c"
    cell = _FakeCell()

    stats = runner._run_cell_attempt(
        **_make_feedback_attempt_kwargs(
            feedback_text="fix the gates",
            phase="feedback-1",
            kill_hook=cell.kill_worker_processes,
            active_cell=cell,
            compaction_watermark=0,
        )
    )

    assert stats.compactions_since_grade == 0, (
        "the wait never reports an under-threshold count; 0 or 2, never 1"
    )
    assert stats.exit_code == 0
    assert stats.killed_reason is None
