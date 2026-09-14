"""WO-WATCH-1E: hermetic unit tests for BackgammonRunner._run_opencode_serve.

No live server, no docker, no model. A fake ``ServeClient`` stub drives the
serve-drive path and the returned ``_OpencodeRunStats`` is asserted field by
field. ``active_cell`` is a lightweight stand-in exposing ``kill_worker_processes``
(the only ``DockerCell`` surface ``_run_opencode_serve`` touches).
"""

from __future__ import annotations

import json
import tempfile
import time
import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from harness.adapters.backgammon import (
    compact_phase_for,
    _FINALIZE_RECOVERY_NUDGE,
    _LOOP_RECOVERY_NUDGE,
    _MAX_SERVE_RECOVERY_NUDGES,
    _STALL_RECOVERY_NUDGE,
    _is_unrecovered_anomaly,
    BackgammonRunner,
    LOOP_KILL_MARKER_DIRNAME,
    ServeTransportError,
    TURN_TERMINAL_GUARD_ABORT,
    TURN_TERMINAL_OBSERVATION_LOST,
    TURN_TERMINAL_STALLED,
    TURN_TERMINAL_TRANSPORT_ERROR,
    TURN_TERMINAL_TRUNCATED,
    bench_session_title,
)
from harness.serve_client import (
    LOOP_KILL_WAIT_REASON,
    ServeClientError,
    extract_transcript_metrics,
    read_loop_kill_marker,
)


TASK_DIR = (Path(__file__).resolve().parents[1] / "task" / "backgammon").resolve()


class _FakeCell:
    """Stand-in for a DockerCell on the serve-drive path.

    Carries a ``config`` with the A2 phase-sentinel directory ONLY. A real cell
    config has far more, but this path touches exactly two things: the sentinel
    directory (which the drive publishes the phase to before every prompt) and
    ``worktree`` (deliberately ABSENT here, so the truncation-evidence fallback
    to the temp dir stays exercised — see the evidence-path test).
    """

    def __init__(self, compact_phase_dir: Path | None = None) -> None:
        self.kill_calls = 0
        self.config = SimpleNamespace(
            compact_phase_host_path=Path(
                compact_phase_dir or tempfile.mkdtemp(prefix="compact-phase-")
            )
        )

    def kill_worker_processes(self) -> None:
        self.kill_calls += 1

    def compact_phase(self) -> str | None:
        """The phase value this cell's worker would currently read, or None."""
        sentinel = Path(self.config.compact_phase_host_path) / "phase"
        return sentinel.read_text(encoding="utf-8").strip() if sentinel.is_file() else None


class _FakeServeClient:
    """Stub that records calls and serves canned responses."""

    def __init__(self) -> None:
        self.sent_prompts: list[tuple[str, str]] = []
        self.aborted_sessions: list[str] = []
        self.abort_error: Exception | None = None
        self.wait_result: bool = True
        # Per-drive wait shapes for wait_idle_detailed, popped one per call
        # (the same script idiom as metrics_script / assistant_terminal_script):
        # each entry is the (idle, wait_reason) pair the waiter returns, so a
        # test can script "stall ONCE, then recover after the nudge" with
        # [(False, "stalled"), (True, "idle")]. Empty (the default) falls
        # through to wait_result — every existing case unchanged.
        self.wait_script: list[tuple[bool, str]] = []
        # Settle-only wait override: the chunk-boundary settle waits via the
        # BARE wait_idle (the drive waits via wait_idle_detailed), so a test
        # can fail the settle's wait without failing the build turn's wait.
        # None means "fall through to wait_result".
        self.settle_wait_result: bool | None = None
        self.wait_timeout_s: float | None = None
        self.busy_result: bool = True
        self.busy_grace_s: float | None = None
        self.metrics_result: dict[str, Any] | None = None
        self.metrics_script: list[dict[str, Any]] = []
        self.metrics_baseline: dict[str, Any] = {}
        self._baseline_served: bool = False
        self.assistant_texts: list[str | list[str]] = []
        # Per-drive terminal shapes (popped one per send_prompt, default None):
        # {"info_error": ...}  -> a relay-killed turn as opencode 1.18.x
        #                         persists it (bare step-start, no text, the
        #                         signature in info.error.data.message);
        # {"step_finish": r}   -> the appended assistant message also carries a
        #                         step-finish part with reason r (truncation);
        # {"error_part": ...}  -> the appended assistant message also carries
        #                         an error part (transport error_event).
        # The canned metrics_script drives the CUMULATIVE reads; the windowed
        # classification read (metrics(since=...)) is derived from _messages
        # through the REAL extractor, so anomaly surfaces must exist here.
        self.assistant_terminal_script: list[dict[str, str] | None] = []
        self.send_error: Exception | None = None
        self.metrics_error: Exception | None = None
        # Compaction is fired by the WORKER plugin (never by the harness), so
        # the fake models what the harness can actually observe: whether a
        # compaction generation appears on the transcript, and whether it
        # completed ("ok") or was killed by the relay's loop guard ("killed").
        # None means the plugin never fired at all.
        self.compaction_on_idle: str | None = None  # None | "ok" | "killed"
        # REAL TIMELINE: the plugin fires on the boundary drive's session.idle
        # DURING the drive (not after it), so the compaction is already in the
        # transcript when the drive returns and the settle runs. When True, the
        # compaction message is appended in send_prompt (during the drive) and
        # the settle's wait_busy reports already-idle. This is the shape the
        # post-drive-watermark bug (run 1788450605) missed: a fresh watermark
        # taken after the drive sits past the compaction and reads zero.
        self.compaction_during_drive: bool = False
        # Fails every non-windowed read EXCEPT the phase baseline. The baseline
        # read now aborts the phase outright (there is no degrade-to-cumulative
        # path any more), so a test that needs the POST-drive transcript read to
        # fail — the real D-SERVE-MESSAGE-500 shape — must let the baseline
        # through first.
        self.metrics_error_after_baseline: Exception | None = None
        # A growable message list, read via get_messages. Each send_prompt
        # appends a user message plus one (or a batch of) assistant messages,
        # mirroring the real serve session. The TEXT is incidental — nothing in
        # the harness reads it any more (WO-MARKER-RIP) — but a realistic
        # transcript is what the metrics extractor walks.
        self._messages: list[dict[str, Any]] = []
        # Set when a prompt was just sent and not yet waited on: the NEXT
        # wait_busy is the drive's busy grace (build turn only — the plugin
        # fires at session.idle, after the turn). A wait_busy with no prompt
        # pending is the chunk-boundary settle's wait.
        self._drive_busy_pending: bool = False
        self.poll_interval: float = 0.0

    def send_prompt(self, session_id: str, prompt: str) -> None:
        self.sent_prompts.append((session_id, prompt))
        if self.send_error is not None:
            raise self.send_error
        self._drive_busy_pending = True
        self._messages.append(
            {
                "info": {
                    "role": "user",
                    "model": {
                        "providerID": "local-llm-proxy",
                        "modelID": "kimi/kimi-k3",
                    },
                },
                "parts": [{"type": "text", "text": prompt}],
            }
        )
        terminal = (
            self.assistant_terminal_script.pop(0)
            if self.assistant_terminal_script
            else None
        )
        if terminal and terminal.get("info_error"):
            # Killed turn: no scripted text is consumed — a real kill persists
            # no assistant text (opencode 1.18.x writes the error, not a part).
            info: dict[str, Any] = {
                "role": "assistant",
                "error": {
                    "name": "UnknownError",
                    "data": {"message": terminal["info_error"]},
                },
            }
            self._messages.append({"info": info, "parts": [{"type": "step-start"}]})
            return
        scripted = (
            self.assistant_texts.pop(0) if self.assistant_texts else "chunk work done"
        )
        batch = scripted if isinstance(scripted, list) else [scripted]
        for text in batch:
            parts: list[dict[str, Any]] = [{"type": "text", "text": text}]
            if terminal and terminal.get("step_finish"):
                parts.append({"type": "step-finish", "reason": terminal["step_finish"]})
            if terminal and terminal.get("error_part"):
                parts.append({"type": "error", "message": terminal["error_part"]})
            self._messages.append(
                {
                    "info": {"role": "assistant"},
                    "parts": parts,
                }
            )
        if self.compaction_during_drive and self.compaction_on_idle is not None:
            info: dict[str, Any] = {
                "role": "assistant",
                "agent": "compaction",
                "summary": True,
            }
            if self.compaction_on_idle == "killed":
                info["error"] = {
                    "name": "UnknownError",
                    "data": {"message": "relay: generation loop detected (abc123)"},
                }
            self._messages.append({"info": info, "parts": [{"type": "step-start"}]})

    def get_messages(self, session_id: str) -> list[dict[str, Any]]:
        return list(self._messages)

    def wait_busy(self, session_id: str, *, timeout_s: float) -> bool:
        self.busy_grace_s = timeout_s
        if self.compaction_on_idle is None:
            return getattr(self, "busy_result", False)
        if self._drive_busy_pending:
            # The drive's busy grace for the prompt just sent: the plugin fires
            # only at session.idle AFTER the turn completes, so no compaction
            # generation is busy here — only the build turn is.
            self._drive_busy_pending = False
            return True
        if self.compaction_during_drive:
            # The compaction already completed during the drive; the session is
            # idle by the time the settle runs. No new compaction is appended.
            return False
        # The settle's wait: the plugin saw the build sentinel on idle and
        # fired — a compaction message lands on the transcript.
        info: dict[str, Any] = {"role": "assistant", "agent": "compaction", "summary": True}
        if self.compaction_on_idle == "killed":
            # MEASURED SHAPE (run 1788415430): a guard-killed compaction still
            # carries summary=True. That is why the receipt keys on the ERROR.
            info["error"] = {
                "name": "UnknownError",
                "data": {"message": "relay: generation loop detected (abc123)"},
            }
        self._messages.append({"info": info, "parts": [{"type": "step-start"}]})
        return True

    def completed_compactions_since(self, session_id: str, watermark: int) -> int:
        found = 0
        for msg in self._messages[watermark:]:
            info = msg.get("info") if isinstance(msg, dict) else None
            if not isinstance(info, dict) or info.get("role") != "assistant":
                continue
            if (info.get("agent") == "compaction" or info.get("summary") is True) and not info.get("error"):
                found += 1
        return found

    def guard_killed_compactions_since(self, session_id: str, watermark: int) -> int:
        found = 0
        for msg in self._messages[watermark:]:
            info = msg.get("info") if isinstance(msg, dict) else None
            if not isinstance(info, dict) or info.get("role") != "assistant":
                continue
            if not (info.get("agent") == "compaction" or info.get("summary") is True):
                continue
            err = info.get("error") if isinstance(info.get("error"), dict) else None
            if not err:
                continue
            err_data = err.get("data") if isinstance(err.get("data"), dict) else {}
            err_text = str(err_data.get("message") or err.get("message") or "").lower()
            if "relay_loop_detected" in err_text or "generation loop detected" in err_text:
                found += 1
        return found

    def session_busy(self, session_id: str) -> bool:
        return False

    def abort(self, session_id: str) -> None:
        self.aborted_sessions.append(session_id)
        if self.abort_error is not None:
            raise self.abort_error

    def wait_idle(self, session_id: str, *, timeout_s: float, **kwargs) -> bool:
        self.wait_timeout_s = timeout_s
        if self.settle_wait_result is not None:
            return self.settle_wait_result
        return self.wait_result

    def wait_idle_detailed(
        self,
        session_id: str,
        *,
        timeout_s: float,
        stall_timeout_s: float | None = None,
        loop_kill_marker_dir: str | None = None,
        turn_start_ts_ms: int | None = None,
        **kwargs,
    ) -> tuple[bool, str]:
        # Mirrors the real client: the drive needs to tell an exhausted budget
        # apart from a turn that stopped progressing. `wait_script` scripts the
        # per-call shapes (a one-shot stall included); the static fallback keys
        # on wait_result, and a False wait_result stays the original
        # run_timeout behaviour. The DRIVE wait keys on wait_result directly
        # (never settle_wait_result, which belongs to the bare wait_idle the
        # chunk-boundary settle uses).
        self.stall_timeout_s = stall_timeout_s
        self.wait_timeout_s = timeout_s
        self.loop_kill_marker_dir = loop_kill_marker_dir
        self.turn_start_ts_ms = turn_start_ts_ms
        # WO-LOOPKILL-1: mirrors the real client's marker fast path (a fresh
        # marker for THIS session ends the wait immediately with loop_killed)
        # through the REAL reader, consume included. Consumption is no longer
        # the fake's job: the reader owns it, so one marker ends one turn here
        # exactly as it does in production.
        if loop_kill_marker_dir is not None and read_loop_kill_marker(
            loop_kill_marker_dir,
            turn_start_ts_ms,
            session_id=session_id,
            consume=True,
        ):
            return False, LOOP_KILL_WAIT_REASON
        # Scripted shapes win over the static flags: one entry per detailed
        # wait, so a one-shot stall followed by a clean re-drive is scriptable
        # (the marker fast path above still comes first, mirroring the real
        # client — a fresh marker ends the wait before any script is consulted).
        if self.wait_script:
            return self.wait_script.pop(0)
        if self.wait_result:
            return True, "idle"
        return False, "timeout"

    def metrics(self, session_id: str, *, since: int | None = None) -> dict[str, Any]:
        if since is not None:
            # The windowed classification read NEVER consults the canned
            # script: it is derived from the fake transcript through the real
            # extractor, so a persisted kill stays visible (and windowed-out)
            # exactly as the opencode serve transcript behaves.
            return extract_transcript_metrics(self._messages[since:])
        if self.metrics_error is not None:
            raise self.metrics_error
        if self.metrics_error_after_baseline is not None:
            if not self._baseline_served:
                self._baseline_served = True
                return self.metrics_baseline
            raise self.metrics_error_after_baseline
        if self.metrics_script:
            return self.metrics_script.pop(0)
        # The serve-drive captures a baseline BEFORE sending the prompt and
        # meters deltas against it; the default baseline is an empty session
        # (all zeros), so single-phase tests keep absolute-value assertions.
        if not self._baseline_served:
            self._baseline_served = True
            return self.metrics_baseline
        return self.metrics_result


def _make_runner(tmp_path: Path, *, compact: bool = False) -> BackgammonRunner:
    return BackgammonRunner(
        task_dir=TASK_DIR,
        work_root=tmp_path / "work-root",
        model="local-llm-proxy/kimi/kimi-k3",
        memory_mode="off",
        run_timeout_s=30,
        completion_grace_s=2,
        compact=compact,
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
        "truncations": 0,
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
    assert stats.truncations == 0
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
        "truncations": 0,
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
    from harness.adapters.backgammon import _HARNESS_LIMIT_REASONS

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
        "truncations": 0,
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
        "truncations": 0,
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
        "truncations": 0,
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
        "truncations": 1,
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
        "truncations": 0,
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


def _make_feedback_attempt_kwargs(
    *,
    feedback_text: str,
    phase: str,
    kill_hook: Any,
    active_cell: Any = None,
) -> dict[str, Any]:
    """Assemble the dispatch kwargs for ``_run_cell_attempt``.

    Serve is the ONLY transport, so these kwargs carry no worktree, env or
    stdout argv any more — there is nothing left to deliver an attempt with
    except the session."""
    return {
        "active_cell": active_cell if active_cell is not None else _FakeCell(),
        "run_label": "cell-fb",
        "phase": phase,
        "prior_cost_usd": 0.0,
        "kill_hook": kill_hook,
        "stdin_text": feedback_text,
    }


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
        "truncations": 0,
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
    ``classify_transport_anomaly`` returning a terminal; here ``truncations: 1``
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
        "truncations": 1,
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


_ZERO_METRICS = {
    "turns": 0,
    "input_tokens": 0,
    "output_tokens": 0,
    "reasoning_tokens": 0,
    "cost_usd": 0.0,
    "truncations": 0,
    "error_parts": 0,
}


def _metrics(
    turns: int,
    inp: int,
    out: int,
    guard_aborted: int = 0,
    finalize: int = 0,
) -> dict[str, Any]:
    # Session-CUMULATIVE read: the kill counts persist in the transcript, so a
    # post-recovery read carries them forward (a real session never forgets).
    return {
        "turns": turns,
        "input_tokens": inp,
        "output_tokens": out,
        "reasoning_tokens": 0,
        "cost_usd": 0.0,
        "truncations": 0,
        "error_parts": 0,
        "guard_aborted_turns": guard_aborted,
        "finalize_timeouts": finalize,
    }


def test_chunked_pass_sends_all_chunks_in_order_and_meters_deltas(
    tmp_path: Path,
) -> None:
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    # Per chunk: baseline (pre-send) then end-of-phase metrics. Baseline for
    # chunk 2 is the cumulative after chunk 1 (session metrics are cumulative).
    client.metrics_script = [
        dict(_ZERO_METRICS),  # chunk-1 baseline
        _metrics(2, 10, 5),  # chunk-1 end
        _metrics(2, 10, 5),  # chunk-2 baseline
        _metrics(5, 40, 15),  # chunk-2 end
    ]
    cell = _FakeCell()

    stats = runner._run_opencode_serve_chunked(
        active_cell=cell,
        serve_client=client,
        session_id="ses_chunks",
        prompts=["CHUNK ONE", "CHUNK TWO"],
        run_label="cell-chunks",
    )

    assert [text for _, text in client.sent_prompts] == ["CHUNK ONE", "CHUNK TWO"]
    assert stats.exit_code == 0
    assert stats.turns == 5  # 2 + 3, deltas summed across chunks
    assert stats.input_tokens == 40  # 10 + 30
    assert stats.output_tokens == 15  # 5 + 10
    assert len(stats.chunk_reports) == 2
    # Each chunk is ONE prompt: a clean drive advances, and nothing re-reads
    # what the model wrote to decide that (WO-MARKER-RIP).
    assert all(r["exit_code"] == 0 for r in stats.chunk_reports)
    assert all(r["recovery_nudges"] == 0 for r in stats.chunk_reports)
    assert all("marker" not in r for r in stats.chunk_reports)


def test_chunked_build_writes_one_sidecar_entry_per_chunk(tmp_path: Path) -> None:
    """A multi-chunk build must record ONE sidecar entry per chunk (kind="chunk",
    attempt=1, verbatim per-chunk text) — not a single joined entry. Regression
    guard for WO-CHUNK-01: chunks 2..N were previously missing from the sidecar."""
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    prompts = ["CHUNK ONE", "CHUNK TWO", "CHUNK THREE"]
    # 2 metrics reads per chunk (baseline + end), cumulative across the session.
    client.metrics_script = [
        dict(_ZERO_METRICS),  # chunk-1 baseline
        _metrics(1, 10, 5),  # chunk-1 end
        _metrics(1, 10, 5),  # chunk-2 baseline
        _metrics(2, 20, 10),  # chunk-2 end
        _metrics(2, 20, 10),  # chunk-3 baseline
        _metrics(3, 30, 15),  # chunk-3 end
    ]
    cell = _FakeCell()
    sidecar_path = tmp_path / "worktree.user-events.jsonl"

    stats = runner._run_opencode_serve_chunked(
        active_cell=cell,
        serve_client=client,
        session_id="ses_sidecar_chunks",
        prompts=prompts,
        run_label="cell-sidecar-chunks",
        sidecar_path=sidecar_path,
    )

    rows = [
        json.loads(line)
        for line in sidecar_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert stats.exit_code == 0
    assert len(rows) == 3
    assert [r["kind"] for r in rows] == ["chunk", "chunk", "chunk"]
    assert [r["text"] for r in rows] == prompts
    assert all(r["attempt"] == 1 for r in rows)
    assert [r["chars"] for r in rows] == [len(p) for p in prompts]
    assert all(r["text_fp"] for r in rows)


def test_compaction_off_fires_no_compaction_at_all(tmp_path: Path) -> None:
    """With compaction OFF, nothing compacts — no summarize call, no compaction
    part, no compaction accounting.

    Descended from the W1 acceptance test, which asserted the same thing
    unconditionally because the drive had no compaction of any kind. Chunk-
    boundary compaction (2026-09-02) is opt-in and defaults off, so the
    invariant is now conditional on the flag rather than absolute — and the OFF
    path has to stay exactly what it was, or every cell that declined
    compaction silently changed scale."""
    runner = _make_runner(tmp_path)
    assert runner.compact is False, "compaction must default OFF"
    client = _FakeServeClient()
    client.metrics_script = [
        dict(_ZERO_METRICS),  # chunk-1 baseline
        _metrics(2, 10, 5),  # chunk-1 end
        _metrics(2, 10, 5),  # chunk-2 baseline
        _metrics(5, 40, 15),  # chunk-2 end
    ]
    cell = _FakeCell()

    stats = runner._run_opencode_serve_chunked(
        active_cell=cell,
        serve_client=client,
        session_id="ses_zero_compact",
        prompts=["CHUNK ONE", "CHUNK TWO"],
        run_label="cell-zero-compact",
    )

    assert stats.exit_code == 0
    assert not any(
        part.get("type") == "compaction"
        for msg in client.get_messages("ses_zero_compact")
        for part in (msg.get("parts") or [])
    )
    assert client.compaction_on_idle is None


def test_serve_drive_zero_delta_phase_is_loud_not_clean_zero(tmp_path: Path) -> None:
    """A phase that ends with the SAME cumulative metrics as its baseline
    produced nothing (discarded message / dead stream) — loud exit 1 with a
    silent_phase anomaly, never a clean zero-turn ok (2026-08-09 feedback void).
    """
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    stale = _metrics(6, 23354, 24822)
    client.metrics_baseline = dict(stale)
    client.metrics_result = dict(stale)
    cell = _FakeCell()

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_stale",
        prompt="fix the 47 problems",
        run_label="cell-stale",
        phase="feedback-1",
    )

    assert stats.exit_code == 1
    assert stats.turns == 0
    assert stats.input_tokens == 0
    assert any(a["terminal"] == "silent_phase" for a in stats.turn_anomalies)
    assert cell.kill_calls == 0


# ---------------------------------------------------------------------------
# WO-LOOPREC-1: loop-guard recovery on the serve path
# ---------------------------------------------------------------------------
def test_chunk_prompts_carry_the_write_chunking_directive() -> None:
    """Walter 2026-08-10: the finalize kills were oversized single generations
    (whole-file writes); every chunk prompt must carry the write-in-chunks
    directive — a prompt edit that drops it re-opens the
    stream_finalize_exhausted cell death.

    ONE NUMBER, THREE VOICES. The same ~150 lines appears in the chunk prompts,
    in the seeded AGENTS.md and in the recovery nudges. It used to be ~150 in
    two of them and ~200-400 in AGENTS.md, which handed the model two limits
    from two directions and made the standing one dead weight.
    """
    from harness.adapters.backgammon import _WORKER_AGENTS_MD, _WRITE_CHUNKING_DIRECTIVE

    for index in range(1, 7):
        text = (TASK_DIR / "prompts" / f"chunk-0{index}.md").read_text(encoding="utf-8")
        assert "~150 lines" in text, f"chunk-0{index}.md lost the chunking directive"
    assert "150 lines" in _WORKER_AGENTS_MD, "AGENTS.md must state the same limit"
    assert "200-400" not in _WORKER_AGENTS_MD, (
        "AGENTS.md must not state a SECOND, larger write limit"
    )
    assert "150 lines" in _WRITE_CHUNKING_DIRECTIVE


def test_no_prompt_asks_the_model_to_print_a_completion_string() -> None:
    """WO-MARKER-RIP. The corpus asks for work, never for a sign-off.

    The string leaked past the phase it was scoped to — repair rounds run in
    the same session and the model kept printing it — and it stood in for an
    event (session idle) the harness already observes directly.
    """
    for index in range(1, 7):
        text = (TASK_DIR / "prompts" / f"chunk-0{index}.md").read_text(encoding="utf-8")
        assert "CHUNK FINISHED" not in text, (
            f"chunk-0{index}.md still asks for the deleted completion marker"
        )


_LOOP_SIG = "relay: generation loop detected (<request-id>)"
_FIN_SIG = (
    "relay: upstream completed but the stream did not finalize "
    "within 30000ms (<request-id>)"
)

_LOOP_METRICS = {
    # The guard-killed read as the persisted transcript reports it: the relay
    # loop signature survives in info.error text (opencode 1.18.x writes NO
    # error part), and the looped turn's tokens are metered.
    "turns": 5,
    "input_tokens": 100,
    "output_tokens": 40,
    "reasoning_tokens": 10,
    "cost_usd": 0.0,
    "truncations": 0,
    "error_parts": 0,
    "info_errors": 1,
    "guard_aborted_turns": 1,
    "finalize_timeouts": 0,
    "error_texts": [
        # Live-observed shape (2026-08-10 runs); per-request trace id elided.
        _LOOP_SIG
    ],
}

_FINALIZE_METRICS = {
    # The relay 30s stream-finalize watchdog kill (WO-FINALIZE-REC-1): the
    # turn's tokens burned, the kill text lands in info.error, and the turn is
    # EXCLUDED from scoring turns (WO-NUDGE-INF-1 — same treatment as a guard
    # kill, so recovery can never inflate the measurement).
    "turns": 5,
    "input_tokens": 100,
    "output_tokens": 40,
    "reasoning_tokens": 10,
    "cost_usd": 0.0,
    "truncations": 0,
    "error_parts": 0,
    "info_errors": 1,
    "guard_aborted_turns": 0,
    "finalize_timeouts": 1,
    "error_texts": [_FIN_SIG],
}


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
def _write_loop_kill_marker(marker_dir: Path, session_id: str, *, ts_ms: int) -> Path:
    """Drop a marker file in the egress sidecar's shape (loop-kill-scanner.cjs):
    ``loop-kill-<sid>.json`` carrying an epoch-MILLISECONDS timestamp."""
    path = marker_dir / f"loop-kill-{session_id}.json"
    path.write_text(
        json.dumps(
            {
                "session_id": session_id,
                "timestamp": ts_ms,
                "signature": _LOOP_SIG,
            }
        ),
        encoding="utf-8",
    )
    return path


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
    from harness.adapters.backgammon import _PROVIDER_RECOVERY_NUDGE

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
    outage.update(info_errors=1, truncations=1, error_texts=[live_error])
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
    assert _is_unrecovered_anomaly(
        {"terminal": TURN_TERMINAL_TRUNCATED, "reason": "stream-incomplete"}
    ) is True  # a non-recoverable class still counts
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


# ── CHUNK-BOUNDARY COMPACTION ───────────────────────────────────────────────
#
# The cadence is: build a chunk, see its marker, compact — six times — and then
# leave the repair loop entirely alone. Build narration is spent context; the
# model has already committed that work to files. Repair transcript is not:
# there the transcript IS the working memory, and compacting it away costs the
# model the record of what it has already tried.


def test_the_harness_waits_for_the_agents_compaction_and_continues(
    tmp_path: Path,
) -> None:
    """The harness OBSERVES compaction; it does not issue it.

    The plugin sees the build phase sentinel on session.idle and fires its
    own summarize, and all the harness does at the chunk boundary is hold the
    next prompt back until the session settles and require a completed
    compaction part. A settled wait with a landed compaction part is the
    fail-closed success condition — the drive continues, and the totals meter
    the build turns only (the settle observes, it does not meter).
    """
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    client.compaction_on_idle = "ok"
    client.metrics_script = [
        dict(_ZERO_METRICS),  # chunk baseline
        _metrics(2, 10, 5),  # chunk end
    ]

    stats = runner._run_opencode_serve_chunked(
        active_cell=_FakeCell(),
        serve_client=client,
        session_id="ses_cc",
        prompts=["ONLY CHUNK"],
        run_label="cell-cc",
    )

    assert stats.exit_code == 0
    # Totals carry the build turns; the settle's wait landed without raising.
    assert stats.turns == 2
    assert stats.input_tokens == 10
    assert stats.output_tokens == 5


def test_a_compaction_that_completed_during_the_drive_is_still_detected(
    tmp_path: Path,
) -> None:
    """REGRESSION (run 1788450605): the plugin fires on the marker's session.idle
    DURING the drive, so the compaction completes before the drive returns and
    its message is already in the transcript when the settle runs. A settle
    that takes a FRESH watermark (post-drive) sits past that compaction and
    reads zero, aborting a cell whose compaction actually worked. Detection
    must use the PRE-DRIVE watermark.
    """
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    client.compaction_on_idle = "ok"
    client.compaction_during_drive = True
    client.metrics_script = [
        dict(_ZERO_METRICS),
        _metrics(2, 10, 5),
    ]

    stats = runner._run_opencode_serve_chunked(
        active_cell=_FakeCell(),
        serve_client=client,
        session_id="ses_during_drive",
        prompts=["ONLY CHUNK"],
        run_label="cell-during-drive",
    )

    assert stats.exit_code == 0
    assert stats.turns == 2


def test_a_guard_killed_compaction_during_the_drive_fails_fast(
    tmp_path: Path,
) -> None:
    """FAIL-FAST (run 1788451466): the worker's own compaction was loop-killed by
    the relay, and opencode AUTO-RETRIES it (compaction_restores). The harness
    must abort named (compaction_loop_killed), NOT nudge around opencode's
    retry storm — the harness does not drive compaction, so a recovery nudge is
    meaningless there, and nudging is exactly the 10-minute hang.
    """
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    client.compaction_on_idle = "killed"
    client.compaction_during_drive = True
    client.metrics_script = [
        dict(_ZERO_METRICS),
        _metrics(2, 10, 5),
    ]

    stats = runner._run_opencode_serve_chunked(
        active_cell=_FakeCell(),
        serve_client=client,
        session_id="ses_loopkill",
        prompts=["ONLY CHUNK"],
        run_label="cell-loopkill",
    )

    assert stats.exit_code == 1
    assert stats.killed_reason == "compaction_loop_killed"
    # The build-turn nudge path must NOT have been consulted for the compaction
    # kill: no recovery nudge was issued.
    assert stats.recovery_nudges == 0


def test_a_guard_killed_compaction_is_no_compaction_evidence_and_aborts(
    tmp_path: Path,
) -> None:
    """THE BUG THIS RECEIPT REPLACED (run 1788415430, 2026-09-03), now fail-closed.

    68 of 73 compactions were killed mid-stream by the relay's loop guard, and
    every one still carried `summary: true`. A receipt that trusted that flag
    reported 68 successful compactions where none had occurred. The receipt
    keys on the ERROR, which is the only thing that separates the 5 that
    completed from the 68 that did not — and a killed compaction lands zero
    completed parts, which is no_compaction_evidence: the cell ABORTS. The
    harness never fires a substitute summarize and never continues uncompacted.
    """
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    client.compaction_on_idle = "killed"
    client.metrics_script = [
        dict(_ZERO_METRICS),
        _metrics(2, 10, 5),
    ]

    with pytest.raises(ServeTransportError) as excinfo:
        runner._run_opencode_serve_chunked(
            active_cell=_FakeCell(),
            serve_client=client,
            session_id="ses_killed",
            prompts=["ONLY CHUNK"],
            run_label="cell-killed",
        )

    assert "no_compaction_evidence" in str(excinfo.value)


def test_a_compaction_that_does_not_settle_aborts_the_cell(
    tmp_path: Path,
) -> None:
    """Fail-closed: the bounded wait is a ceiling, not a fallback.

    The plugin fired, but the session never settled idle within the bounded
    wait — the next chunk would queue behind a generation still running.
    That is no_compaction_evidence: the cell aborts rather than sending the
    next prompt into it.
    """
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    client.compaction_on_idle = "ok"
    client.settle_wait_result = False  # the settle's wait never sees idle
    client.metrics_script = [
        dict(_ZERO_METRICS),
        _metrics(2, 10, 5),
    ]

    with pytest.raises(ServeTransportError) as excinfo:
        runner._run_opencode_serve_chunked(
            active_cell=_FakeCell(),
            serve_client=client,
            session_id="ses_nosettle",
            prompts=["ONLY CHUNK"],
            run_label="cell-nosettle",
        )

    assert "no_compaction_evidence" in str(excinfo.value)


def test_a_chunk_boundary_with_no_compaction_fire_aborts_the_cell(
    tmp_path: Path,
) -> None:
    """Fail-closed: the flag arms the worker's self-fire; if nothing fires,
    the boundary has no compaction evidence and the cell aborts.

    The session never goes busy in the grace window (the plugin did not
    fire), so zero compaction parts land — no_compaction_evidence. The
    harness never fires a substitute summarize.
    """
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    client.compaction_on_idle = None  # the plugin never fired
    client.busy_result = False        # session never goes busy
    # busy_result=False also takes the drive through the never-busy raced-turn
    # path, which reads an extra `early` metrics snapshot — hence three entries.
    client.metrics_script = [
        dict(_ZERO_METRICS),
        _metrics(2, 10, 5),
        _metrics(2, 10, 5),
    ]

    with pytest.raises(ServeTransportError) as excinfo:
        runner._run_opencode_serve_chunked(
            active_cell=_FakeCell(),
            serve_client=client,
            session_id="ses_nofire",
            prompts=["ONLY CHUNK"],
            run_label="cell-nofire",
        )

    assert "no_compaction_evidence" in str(excinfo.value)


def test_the_compact_flag_leaves_the_chunk_prompts_untouched(
    tmp_path: Path,
) -> None:
    """The driver-fired arm is gone: compact=True arms only the worker plugin.

    The chunk prompts carry no compaction instruction and no tool-call
    scripting whatever the flag. Since WO-MARKER-RIP they ask the model for
    nothing about compaction at all — not even indirectly: the plugin arms off
    the harness's phase sentinel, which the model never sees.

    The on-disk FILE is unchanged by the flag. The harness appends nothing to a
    build chunk (2026-09-08 reversal: the do-not-capture note and its splice are
    gone), so the assertion is file-only, and no compaction instruction is
    injected below.
    """
    runner = _make_runner(tmp_path, compact=True)
    chunks = runner._load_chunk_prompts()
    assert len(chunks) == 6
    for index, chunk in enumerate(chunks, start=1):
        on_disk = (TASK_DIR / "prompts" / f"chunk-{index:02d}.md").read_text(
            encoding="utf-8"
        )
        assert chunk == on_disk
        assert "okp_compact_session" not in chunk


def test_repair_attempts_never_compact(tmp_path: Path) -> None:
    """THE OTHER HALF OF THE CADENCE, and the one worth guarding.

    Compaction lives in the chunked BUILD driver only. The repair loop drives
    through `_run_cell_attempt`, which must never compact however the flag is
    set — the troubleshooting transcript is the model's record of what it has
    already tried, and compacting it away is the failure this whole change
    exists to prevent."""
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    runner._serve_client = client
    runner._cell_session_id = "ses_repair"
    # Two reads per phase (baseline, then end-of-phase), two phases.
    client.metrics_script = [
        dict(_ZERO_METRICS),
        _metrics(1, 5, 2),
        _metrics(1, 5, 2),
        _metrics(2, 9, 4),
    ]

    cell = _FakeCell()
    for phase in ("feedback-1", "feedback-2"):
        runner._run_cell_attempt(
            **_make_feedback_attempt_kwargs(
                feedback_text=f"repair text for {phase}",
                phase=phase,
                kill_hook=cell.kill_worker_processes,
                active_cell=cell,
            )
        )
        # A2: the sentinel is what holds the line. It used to be paired with
        # a prompt-text guard that was necessary but never sufficient, because
        # the model printed the arming string on its own during repair.
        assert cell.compact_phase() == "repair", (
            f"phase {phase} left the worker's compaction arm reading "
            f"{cell.compact_phase()!r} — a repair round must never be armed"
        )

    # No prompt carries a compaction instruction any more — the driver-fired
    # suffix is deleted, and the worker plugin arms only off the harness's
    # phase sentinel. The guard stays: a repair prompt must never ask for
    # compaction, whatever the flag says.
    for _, text in client.sent_prompts:
        assert "okp_compact_session" not in text, (
            "the repair phase must never ask for compaction, whatever the flag says"
        )
        assert "CHUNK FINISHED" not in text, (
            "the deleted completion marker must not reappear in any prompt"
        )


# ── A2 PHASE SENTINEL — NOW THE WHOLE COMPACTION GATE ───────────────────────
#
# Run 1788462647 fired a self-compaction ~80s before the end of `feedback-2`.
# The arm keyed off CHUNK FINISHED, which the MODEL emits — the instruction
# lived only in the chunk prompts, but repair runs in the same session and the
# convention survived every compaction, so the model kept printing it while
# fixing gate failures. Nothing in the scoring path could see it.
#
# WO-MARKER-RIP deleted that condition outright, so the sentinel is no longer
# one gate of two: it is the only thing standing between an idle and a
# compaction, and these tests pin it as such. The HARNESS declares the phase,
# and it declares it before every prompt.


def test_compact_phase_classification_covers_every_phase_the_harness_drives() -> None:
    """Build is the initial pass and its chunks; everything else is repair."""
    for build_phase in ("initial", "initial-chunk-1", "initial-chunk-6"):
        assert compact_phase_for(build_phase) == "build", build_phase

    for repair_phase in ("feedback-1", "feedback-2"):
        assert compact_phase_for(repair_phase) == "repair", repair_phase


def test_exactly_one_drive_per_chunk_is_flagged_build() -> None:
    """The plugin's six-fire budget assumes six qualifying idles. This is it.

    A recovery nudge re-drive is held CONDITIONALLY (WO-25): it is published
    `repair` only when this chunk has already had its compaction, so the nudge
    can never spend a second fire; when the chunk has NOT compacted (the
    plugin gated the death), the normal phase is republished — `build` for a
    chunk — so the re-drive's completion can serve as the chunk's one real
    boundary. Either way a chunk spends at most one qualifying idle.
    """
    with_record = [
        "initial-chunk-3",
        "initial-chunk-3-record-3",
    ]
    flagged = [
        p for p in with_record if compact_phase_for(p, record_turn_enabled=True) == "build"
    ]
    assert flagged == ["initial-chunk-3-record-3"]

    without_record = ["initial-chunk-3"]
    flagged_off = [
        p
        for p in without_record
        if compact_phase_for(p, record_turn_enabled=False) == "build"
    ]
    assert flagged_off == ["initial-chunk-3"]


def test_an_unknown_phase_name_is_treated_as_repair() -> None:
    """Fail-closed on classification too.

    A phase nobody has reasoned about is not a proven-safe compaction point,
    and the cost of the two mistakes is not symmetric: refusing to compact at a
    real boundary aborts the cell loudly on no_compaction_evidence, while
    compacting at a phantom one corrupts a cell that still scores.
    """
    assert compact_phase_for("some-future-phase") == "repair"
    assert compact_phase_for("") == "repair"


def test_build_chunks_publish_the_build_phase_before_each_prompt(
    tmp_path: Path,
) -> None:
    """The chunked driver leaves the arm ENABLED — the other half of the pin.

    Without this, a fix that simply never publishes `build` would satisfy every
    repair-side assertion above while silently disarming compaction entirely.
    """
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    client.metrics_script = [dict(_ZERO_METRICS), _metrics(1, 5, 2)]
    cell = _FakeCell()

    # The sentinel must be readable as `build` at the moment each prompt is
    # sent, not merely at the end of the drive.
    seen: list[str | None] = []
    original_send = client.send_prompt

    def _recording_send(*args: Any, **kwargs: Any) -> Any:
        seen.append(cell.compact_phase())
        return original_send(*args, **kwargs)

    client.send_prompt = _recording_send  # type: ignore[method-assign]

    runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_build",
        prompt="chunk one",
        run_label="cell-build",
        phase="initial-chunk-1",
    )

    assert seen == ["build"]
    assert cell.compact_phase() == "build"


def test_recovery_nudge_holds_ONLY_when_this_chunk_already_compacted(
    tmp_path: Path,
) -> None:
    """The hold is evidence-based, because both blanket answers are wrong.

    IT USED TO HOLD UNCONDITIONALLY, on the reasoning that "the boundary idle
    already fired at the loop-kill abort that triggered the nudge". That was
    true ONLY BECAUSE OF A DEFECT: the worker plugin fired its summarize on the
    idle a DYING stream emits, which is not a boundary at all.

    That defect is fixed in the plugin (it now refuses to summarize a turn a
    `session.error` killed), so on a gated death NOTHING fires — and holding
    then left the sentinel on `repair` through the chunk's real boundary, so
    `_settle_after_chunk` aborted the cell with `no_compaction_evidence`.
    Measured: run 1789127719, chunk 5, two nudges, cell dead.

    Never holding is equally wrong: the plugin's gate keys on `session.error`,
    and a turn that simply stops with no signal does not emit one. That death
    DOES compact, and an unheld re-drive would spend a second fire — the
    chunk-4 double-fire that exhausted the six-per-session budget by chunk 6.

    So the harness asks: has this chunk already had its compaction?
    """
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    client.assistant_terminal_script = [{"info_error": _LOOP_SIG}]
    client.metrics_script = [
        dict(_ZERO_METRICS),  # phase baseline
        dict(_LOOP_METRICS),  # loop-killed read
        _metrics(8, 160, 70, guard_aborted=1),  # post-nudge read
    ]
    cell = _FakeCell()

    seen: list[str | None] = []
    original_send = client.send_prompt

    def _recording_send(*args: Any, **kwargs: Any) -> Any:
        seen.append(cell.compact_phase())
        result = original_send(*args, **kwargs)
        # THE DEATH COMPACTED — an ungated death, the case the hold exists for.
        # Appended DURING the first drive, because "already compacted" is
        # measured from the drive's own baseline: a message present before the
        # drive started is not this chunk's compaction.
        if len(seen) == 1:
            client._messages.append(
                {"info": {"role": "assistant", "agent": "compaction", "summary": True}}
            )
        return result

    client.send_prompt = _recording_send  # type: ignore[method-assign]

    runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_nudge_hold",
        prompt="chunk three",
        run_label="cell-nudge-hold",
        phase="initial-chunk-3",
    )

    assert seen[0] == "build", "the chunk's first drive is the boundary candidate"
    assert seen[1] == "repair", (
        "this chunk already compacted, so the re-drive must be HELD — an "
        "unheld one spends a second fire against the six-per-session budget"
    )


def test_recovery_nudge_is_NOT_held_when_nothing_compacted(tmp_path: Path) -> None:
    """A gated death leaves the re-drive free to be the chunk's real boundary.

    This is the case that killed run 1789127719. The plugin correctly refused to
    summarize the turn the stream killed, so no compaction landed — and the old
    unconditional hold then made the genuine boundary unable to compact either,
    which `_settle_after_chunk` turns into a cell abort.

    WO-25 makes this a REAL regression, not an absence-of-write: in the live
    system the loop-kill sidecar writes `repair` over the sentinel at its kill,
    so a harness that merely SKIPPED the hold would still leave the boundary
    disarmed — the restore has to be an ACTIVE republish of `build`. The
    injection below simulates the sidecar (literal `repair` into the sentinel
    file, after the kill lands and before the recovery probe), and the drive
    runs through the chunked path so the boundary is real: the plugin fires
    once at the settle (`compaction_on_idle="ok"`) and the settle's evidence
    check is what makes exit_code 0 mean "the boundary compacted".
    """
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    client.assistant_terminal_script = [{"info_error": _LOOP_SIG}]
    client.compaction_on_idle = "ok"
    client.metrics_script = [
        dict(_ZERO_METRICS),
        dict(_LOOP_METRICS),
        _metrics(8, 160, 70, guard_aborted=1),
    ]
    # No compaction message DURING the drive: the plugin gated the death, as it
    # now does. The only compaction lands at the boundary settle, below.
    cell = _FakeCell()
    sentinel = Path(cell.config.compact_phase_host_path) / "phase"

    seen: list[str | None] = []
    original_send = client.send_prompt

    def _recording_send(*args: Any, **kwargs: Any) -> Any:
        seen.append(cell.compact_phase())
        result = original_send(*args, **kwargs)
        if len(seen) == 1:
            # THE SIDECAR, SIMULATED: the loop-kill sidecar writes `repair` at
            # its kill so the dying stream's own idle cannot fire a compaction.
            # Written AFTER the kill message landed (inside the first drive)
            # and BEFORE the recovery probe re-drives — the exact window in
            # which the harness must actively restore `build`.
            sentinel.write_text("repair\n", encoding="utf-8")
        return result

    client.send_prompt = _recording_send  # type: ignore[method-assign]

    # The hold probe reads `completed_compactions_since` immediately before it
    # republishes; the boundary settle reads it again after the fire. Recording
    # (sentinel, count) at each call pins BOTH ends: the probe must see the
    # sidecar's `repair` with zero compactions (fail open -> republish build),
    # and the settle must see `build` with exactly one compaction landed.
    probe_views: list[tuple[str | None, int]] = []
    original_count = client.completed_compactions_since

    def _recording_count(session_id: str, watermark: int) -> int:
        count = original_count(session_id, watermark)
        probe_views.append((cell.compact_phase(), count))
        return count

    client.completed_compactions_since = _recording_count  # type: ignore[method-assign]

    stats = runner._run_opencode_serve_chunked(
        active_cell=cell,
        serve_client=client,
        session_id="ses_nudge_free",
        prompts=["chunk three"],
        run_label="cell-nudge-free",
    )

    assert seen[0] == "build", "the chunk's first drive is the boundary candidate"
    assert seen[1] == "build", (
        "the sidecar wrote `repair` at the kill and nothing compacted, so the "
        "probe must ACTIVELY republish `build` — the re-drive's completion IS "
        "this chunk's one real boundary. Holding (or merely skipping the write "
        "and leaving the sidecar's `repair` in place) is what aborted run "
        "1789127719 with no_compaction_evidence"
    )
    # NO PREMATURE FIRE: at the probe the sentinel still reads the sidecar's
    # `repair` and zero compactions have landed. BOUNDARY FIRE: at the settle
    # the sentinel reads `build` and exactly one compaction has landed.
    assert probe_views == [("repair", 0), ("build", 1)]
    # The settle counted the fire (>=1 compaction) and the chunk spent exactly
    # one of the six-per-session budget — never two.
    assert stats.exit_code == 0
    assert stats.recovery_nudges == 1
    assert client.completed_compactions_since("ses_nudge_free", 0) == 1


def test_stall_writes_repair_before_its_abort_and_restores_build_at_the_boundary(
    tmp_path: Path,
) -> None:
    """WO-25 stall regression, BOTH halves in one drive.

    (a) NO PREMATURE FIRE. A stall has no sidecar — unlike the loop kill,
        nothing outside the harness disarms the fault's own idle. The abort
        that un-sticks the turn publishes a session.idle the worker plugin
        sees, so the harness must write `repair` BEFORE the abort/kill: with
        the sentinel still on `build`, that idle would fire a mid-stall
        compaction — a truncated turn's summarize the six-fire budget cannot
        spare.
    (b) RESTORE. The recovery probe then finds zero compactions since the
        drive's own watermark and must fail open — republish `build` — so the
        nudged re-drive's completion, this chunk's one real boundary, can
        fire. Evidenced end-to-end through the chunked settle: the plugin
        fires once (`compaction_on_idle="ok"`), the settle counts it
        (exit_code == 0), and exactly one compaction lands.
    """
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    # Stall ONCE, then the nudged re-drive goes idle.
    client.wait_script = [(False, "stalled"), (True, "idle")]
    client.compaction_on_idle = "ok"
    client.metrics_script = [
        dict(_ZERO_METRICS),  # phase baseline
        _metrics(5, 100, 40),  # stalled turn read (transcript clean — no signature)
        _metrics(8, 160, 70),  # post-nudge read (session-cumulative)
    ]
    cell = _FakeCell()

    seen: list[str | None] = []
    original_send = client.send_prompt

    def _recording_send(*args: Any, **kwargs: Any) -> Any:
        seen.append(cell.compact_phase())
        return original_send(*args, **kwargs)

    client.send_prompt = _recording_send  # type: ignore[method-assign]

    # The sentinel AS THE PLUGIN SEES IT at the stall's own abort idle: the
    # production order is publish-repair -> abort -> kill, so reading inside a
    # wrapped abort observes the exact moment the dying turn goes idle.
    at_abort: list[tuple[str | None, int]] = []
    original_abort = client.abort

    def _recording_abort(session_id: str) -> None:
        at_abort.append(
            (cell.compact_phase(), client.completed_compactions_since(session_id, 0))
        )
        return original_abort(session_id)

    client.abort = _recording_abort  # type: ignore[method-assign]

    stats = runner._run_opencode_serve_chunked(
        active_cell=cell,
        serve_client=client,
        session_id="ses_stall_boundary",
        prompts=["ONLY CHUNK"],
        run_label="cell-stall-boundary",
    )

    # (a) No premature fire: the abort idle reads `repair` — never `build` —
    #     and nothing had compacted at that point.
    assert at_abort == [("repair", 0)], (
        "the stall's abort publishes its own session.idle; the harness must "
        "write `repair` BEFORE the abort/kill so the plugin cannot fire a "
        "mid-stall compaction on it (a stall has no sidecar to do this)"
    )
    # (b) Restore: the first drive is the boundary candidate, and the recovery
    #     probe republishes `build` over the stall hold for the re-drive.
    assert seen == ["build", "build"], (
        "nothing compacted before the nudge, so the probe must fail open and "
        "restore `build` — holding the re-drive on `repair` strands the real "
        "boundary and _settle_after_chunk aborts with no_compaction_evidence"
    )
    # The boundary fired, the settle counted it (>=1 compaction), and the chunk
    # spent EXACTLY one fire of the six-per-session budget.
    assert stats.exit_code == 0
    assert stats.recovery_nudges == 1
    assert client.completed_compactions_since("ses_stall_boundary", 0) == 1
    # The stall was genuinely un-stuck (kill hook ran), not merely relabelled.
    assert cell.kill_calls == 1


def test_a_non_compacting_run_publishes_no_sentinel_at_all(tmp_path: Path) -> None:
    """No flag, no file. The sentinel is compaction's own machinery; a run that
    never compacts must not grow a directory it does not use."""
    runner = _make_runner(tmp_path, compact=False)
    client = _FakeServeClient()
    client.metrics_script = [dict(_ZERO_METRICS), _metrics(1, 5, 2)]
    cell = _FakeCell()

    runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_plain",
        prompt="chunk one",
        run_label="cell-plain",
        phase="initial-chunk-1",
    )

    assert cell.compact_phase() is None


def test_a_compacting_cell_with_no_sentinel_path_aborts_rather_than_drives(
    tmp_path: Path,
) -> None:
    """If the phase cannot be published, the worker keeps reading the PREVIOUS
    phase — at the build->repair transition that is the stale `build` that let
    the repair-round compaction through. Abort instead."""
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    cell = _FakeCell()
    cell.config.compact_phase_host_path = None

    with pytest.raises(ServeTransportError, match="phase sentinel"):
        runner._run_opencode_serve(
            active_cell=cell,
            serve_client=client,
            session_id="ses_nopath",
            prompt="chunk one",
            run_label="cell-nopath",
            phase="initial-chunk-1",
        )


def test_the_sentinel_is_rewritten_on_the_build_to_repair_transition(
    tmp_path: Path,
) -> None:
    """The transition itself, in one cell, through the real drive path."""
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    client.metrics_script = [
        dict(_ZERO_METRICS),
        _metrics(1, 5, 2),
        _metrics(1, 5, 2),
        _metrics(2, 9, 4),
    ]
    cell = _FakeCell()

    runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_txn",
        prompt="chunk six",
        run_label="cell-txn",
        phase="initial-chunk-6",
    )
    assert cell.compact_phase() == "build"

    runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_txn",
        prompt="the dice never reroll",
        run_label="cell-txn",
        phase="feedback-1",
    )
    assert cell.compact_phase() == "repair"
