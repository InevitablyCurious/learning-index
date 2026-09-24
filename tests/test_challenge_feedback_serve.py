"""WO-WATCH-1F: serve-driven feedback/repair attempt tests (WO-LI18 split).

``_run_cell_attempt`` over the serve session: feedback delivered via
send_prompt, send-error exit codes, no-session abort, and resume-truncation
evidence. Shared fakes: tests/_serve_drive_fakes.py.
"""

from __future__ import annotations

import json
import tempfile
import uuid
from pathlib import Path

import pytest

from harness.adapters.challenge import (
    TURN_TERMINAL_TRUNCATED,
    ServeTransportError,
)
from harness.serve_client import ServeClientError
from tests._serve_drive_fakes import (
    _FakeCell,
    _FakeServeClient,
    _make_feedback_attempt_kwargs,
    _make_runner,
)


def test_run_cell_attempt_serve_driven_feedback_delivered_via_prompt_async(
    tmp_path: Path,
) -> None:
    """WO-WATCH-1F: when a serve session is available, the FEEDBACK attempt is
    delivered over serve via ``send_prompt`` (prompt_async) to the persisted
    cell session id, completion from wait_idle, metering from the transcript,
    with the serve-driven phase ``feedback-N``."""
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.metrics_result = {
        "turns": 2,
        "input_tokens": 40,
        "output_tokens": 20,
        "reasoning_tokens": 5,
        "cost_usd": 0.003,
        "provider_truncations": 0,
        "error_parts": 0,
    }
    cell = _FakeCell()
    # Inject the serve session exactly as `_run_cell_impl` persists it.
    runner._serve_client = client
    runner._cell_session_id = "ses_cell_fb"
    events_path = tmp_path / "fb.events.jsonl"

    feedback = "fix [G02] B — do not explain, just edit."
    kwargs = _make_feedback_attempt_kwargs(
        feedback_text=feedback,
        phase="feedback-1",
        kill_hook=cell.kill_worker_processes,
    )
    stats = runner._run_cell_attempt(**kwargs)

    # Delivered to the persistent cell session id, never the container-side id.
    assert client.sent_prompts == [("ses_cell_fb", feedback)]
    assert stats.session_id == "ses_cell_fb"
    assert stats.exit_code == 0
    assert stats.killed_reason is None
    assert stats.turns == 2
    assert stats.input_tokens == 40
    assert stats.output_tokens == 20
    assert stats.reasoning_tokens == 5
    assert stats.cost_usd == 0.003
    # Serve-driven attempt cannot detect a zero-tool turn (transcript only).
    assert stats.zero_tool_turn_honest_fail is False
    assert stats.terminal_zero_tool_turn is False
    assert stats.zero_tool_resumes == 0
    assert stats.resume_count == 0
    assert cell.kill_calls == 0


def test_run_cell_attempt_serve_send_error_returns_exit1(
    tmp_path: Path,
) -> None:
    """WO-WATCH-1F: a send error over serve is caught internally by
    ``_run_opencode_serve`` (returns exit_code=1 stats, never raises); the
    transport decision is left to the caller. (This test formerly also
    carried a sentinel asserting the stdout path was NOT re-run — that
    transport was purged 2026-09-03, so the guarantee is structural.)"""
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.send_error = ServeClientError("POST ... prompt_async failed: boom")
    cell = _FakeCell()
    runner._serve_client = client
    runner._cell_session_id = "ses_cell_fb_err"

    feedback = "fix the gates"
    kwargs = _make_feedback_attempt_kwargs(
        feedback_text=feedback,
        phase="feedback-1",
        kill_hook=cell.kill_worker_processes,
    )
    stats = runner._run_cell_attempt(**kwargs)

    # `_run_opencode_serve` catches the send error internally and returns
    # exit_code=1 stats (never raises): the transport decision is left to the
    # caller. Assert the serve outcome.
    assert client.sent_prompts == [("ses_cell_fb_err", feedback)]
    assert stats.exit_code == 1
    assert stats.killed_reason is None
    assert stats.turns == 0
    assert cell.kill_calls == 0


def test_run_cell_attempt_without_serve_session_aborts(tmp_path: Path) -> None:
    """No serve session means NO CELL — there is no second way to deliver an
    attempt.

    This used to route the attempt to the stdout subprocess path. That made a
    single cell able to deliver some attempts over serve and others as a
    subprocess while reporting one set of numbers for both, and the only trace
    was one PROGRESS line an operator had to be watching for. The benchmark runs
    exactly one way; when it cannot, it says so and stops."""
    runner = _make_runner(tmp_path)
    # `_serve_client` may be set while the session id is not — the shape a
    # failed create_session used to leave behind.
    runner._serve_client = _FakeServeClient()
    runner._cell_session_id = None

    kwargs = _make_feedback_attempt_kwargs(
        feedback_text="fix the gates",
        phase="feedback-2",
        kill_hook=_FakeCell().kill_worker_processes,
    )

    with pytest.raises(ServeTransportError) as excinfo:
        runner._run_cell_attempt(**kwargs)

    assert "feedback-2" in str(excinfo.value)
    assert "one transport" in str(excinfo.value)

def test_run_cell_attempt_serve_driven_resume_truncation_writes_evidence(
    tmp_path: Path,
) -> None:
    """WO-WATCH-1F ITEM 2 (b): the truncation capture fires on a RESUME attempt
    as it does on an initial one — proven by a deliberately induced truncation
    on a RESUME (serve-drive phase ``feedback-1``, attempt 2), not by
    inspection. The serve-path evidence write is gated on
    ``classify_transport_anomaly`` returning a terminal; here ``provider_truncations: 1``
    forces ``(TERMINAL_TRUNCATED, "stream-incomplete")``, so the anomaly entry
    AND the truncation-evidence.jsonl record must both be produced. A hermetic
    ``_FakeCell`` has no ``.config`` worktree, so the evidence falls back to
    the system temp dir."""
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
    # Unique per-run cell session id (uuid) + run_label keep the evidence line
    # unambiguous in the shared, ever-appending temp file across test runs.
    cell_session_id = f"ses_cell_resume_trunc_{uuid.uuid4().hex[:8]}"
    runner._serve_client = client
    runner._cell_session_id = cell_session_id
    events_path = tmp_path / "fb-resume-trunc.events.jsonl"

    feedback = "resume: the truncated turn needs a corrective edit."
    kwargs = _make_feedback_attempt_kwargs(
        feedback_text=feedback,
        phase="feedback-1",
        kill_hook=cell.kill_worker_processes,
    )
    kwargs["run_label"] = "cell-resume-trunc"
    stats = runner._run_cell_attempt(**kwargs)

    # 1) The stats carry the truncated anomaly for the RESUME phase.
    assert stats.session_id == cell_session_id
    assert stats.exit_code == 0
    assert len(stats.turn_anomalies) == 1
    anomaly = stats.turn_anomalies[0]
    assert anomaly["terminal"] == TURN_TERMINAL_TRUNCATED
    assert anomaly["reason"] == "stream-incomplete"
    assert anomaly["phase"] == "feedback-1"
    assert anomaly["session_id"] == cell_session_id

    # 2) The truncation evidence capture FIRED: a record for THIS resume attempt
    #    was appended to the temp-dir evidence file.
    evidence_path = Path(tempfile.gettempdir()) / "truncation-evidence.jsonl"
    assert evidence_path.exists()
    lines = [
        json.loads(ln)
        for ln in evidence_path.read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    matches = [
        rec
        for rec in lines
        if rec.get("phase") == "feedback-1" and rec.get("session_id") == cell_session_id
    ]
    assert len(matches) == 1, (
        f"expected exactly one resume-trunc evidence record, got {len(matches)}"
    )
    rec = matches[0]
    assert rec["terminal"] == TURN_TERMINAL_TRUNCATED
    assert rec["reason"] == "stream-incomplete"
    assert rec["session_id"] == cell_session_id
    assert rec["run_label"] == "cell-resume-trunc"
    corr = rec["correlation"]
    ts_window = corr["ts_window_utc"]
    assert isinstance(ts_window, list) and len(ts_window) == 2
    assert all(isinstance(t, str) and t for t in ts_window)
    # First element may be None when ts_start is missing; end must be ISO UTC.
    assert ts_window[1].endswith("+00:00") or ts_window[1].endswith("Z")
    # match_key is "{run_label}|{attempt_id}|{session_id}" (the serve path always
    # carries a real attempt_id, so it is never "none").
    assert corr["match_key"].startswith("cell-resume-trunc|")
    assert "cell-resume-trunc" in corr["match_key"]
    assert corr["match_key"].endswith(f"|{cell_session_id}")
    assert cell.kill_calls == 0
