"""A wedged turn must cost minutes, not the whole cell.

`session_busy` cannot tell "working hard" from "wedged": a hung tool call
leaves the session BUSY indefinitely. The drive passes the WHOLE-RUN budget as
its idle timeout, so before this bound existed one stuck command burned the
entire cell — measured 2026-08-24, a cell sat silent for 40 minutes on course
for the full 90 because `pkill -f "npm start"` left the node server npm had
spawned holding the tool call's pipe open.

The bound must fire on a wedged turn WITHOUT firing on a slow one, or it trades
a lost cell for a falsified one.
"""

from __future__ import annotations

import pytest

from harness.serve_client import REASON_MODEL_SILENT, ServeClient, ServeClientError, tool_call_running


class _FakeDeltas:
    """The serve's streamed-delta count: flat, or climbing on every read."""

    def __init__(self, *, streaming: bool) -> None:
        self._streaming = streaming
        self._n = 0
        self.closed = False

    def count(self) -> int:
        if self._streaming:
            self._n += 1
        return self._n

    def close(self) -> None:
        self.closed = True


class _FakeClient(ServeClient):
    """Drives wait_idle_detailed off scripted busy/progress, with no clock wait."""

    def __init__(
        self, *, tokens=None, busy=True, raise_progress=False, advancing=False, streaming=False,
        tool_running=True,
    ):
        self.poll_interval = 0.0
        self._tokens = list(tokens or [])
        self._busy = busy
        self._raise_progress = raise_progress
        self._advancing = advancing
        self._streaming = streaming
        self._tool_running = tool_running
        self.progress_calls = 0
        self.deltas: _FakeDeltas | None = None

    def session_busy(self, session_id: str) -> bool:  # type: ignore[override]
        return self._busy

    def session_progress_token(self, session_id: str):  # type: ignore[override]
        self.progress_calls += 1
        if self._raise_progress:
            raise ServeClientError("probe down")
        if self._advancing:
            # Never runs dry: parts keep climbing, as they do while a turn
            # takes new steps and tool calls.
            return (5, 20 + self.progress_calls)
        if self._tokens:
            return self._tokens.pop(0)
        return (1, 1)

    def open_delta_counter(self, session_id: str):  # type: ignore[override]
        self.deltas = _FakeDeltas(streaming=self._streaming)
        return self.deltas

    def session_tool_running(self, session_id: str) -> bool:  # type: ignore[override]
        if self._tool_running is None:
            raise ServeClientError("probe down")
        return self._tool_running


def _wait(client, **kw):
    return client.wait_idle_detailed(
        "sid",
        timeout_s=kw.pop("timeout_s", 30.0),
        progress_interval_s=kw.pop("progress_interval_s", 0.0),
        **kw,
    )


class TestStallDetection:
    def test_a_wedged_turn_is_reported_stalled(self):
        # Same token forever: busy, but nothing is happening.
        c = _FakeClient(tokens=[(5, 20)] * 50)
        reached, reason = _wait(c, stall_timeout_s=0.0)
        assert reached is False
        assert reason == "stalled"

    def test_a_progressing_turn_is_never_called_stalled(self):
        # Parts keep growing, as they do while a turn takes new steps.
        c = _FakeClient(advancing=True)
        reached, reason = _wait(c, stall_timeout_s=0.0, timeout_s=0.25)
        assert reason == "timeout", (
            "a turn that keeps progressing must hit the budget, not the stall bound"
        )
        assert reached is False

    def test_a_thinking_model_is_never_called_stalled(self):
        # ONE block of thinking: the stored transcript sits still (its text is
        # stored only when the block ends) while tokens stream. Run 1790258326
        # killed exactly this, mid-sentence, as a 10-minute "stall".
        c = _FakeClient(tokens=[(5, 20)] * 500, streaming=True)
        reached, reason = _wait(c, stall_timeout_s=0.0, timeout_s=0.25)
        assert reason == "timeout", "streamed tokens are progress; only the budget ends this turn"
        assert reached is False

    def test_a_wedged_command_is_stalled(self):
        # No new parts, no streamed tokens, a command still running: the turn
        # wedged inside a tool call — the stall bound's reason to exist.
        c = _FakeClient(tokens=[(5, 20)] * 50, streaming=False, tool_running=True)
        reached, reason = _wait(c, stall_timeout_s=0.0)
        assert (reached, reason) == (False, "stalled")

    def test_silence_with_no_command_running_is_the_model_servers(self):
        # Nothing moved and no command is running: the model server sent
        # nothing. Telling the model "that command ran ten minutes" was false
        # (run 1790258326); this is ours, not a stall of the model's.
        c = _FakeClient(tokens=[(5, 20)] * 50, streaming=False, tool_running=False)
        reached, reason = _wait(c, stall_timeout_s=0.0)
        assert (reached, reason) == (False, REASON_MODEL_SILENT)

    def test_an_unreadable_session_at_the_bound_decides_nothing(self):
        # Whether a command is running cannot be seen: neither verdict is
        # evidence-backed, so the wait goes on (the budget ends it here).
        c = _FakeClient(tokens=[(5, 20)] * 500, streaming=False, tool_running=None)
        reached, reason = _wait(c, stall_timeout_s=0.0, timeout_s=0.2)
        assert (reached, reason) == (False, "timeout")

    def test_the_delta_stream_is_closed_on_every_exit(self):
        for c in (
            _FakeClient(tokens=[(5, 20)] * 50),  # stalled
            _FakeClient(tokens=[(5, 20)] * 50, busy=False),  # idle
            _FakeClient(tokens=[(5, 20)] * 500, streaming=True),  # timeout
        ):
            _wait(c, stall_timeout_s=0.0, timeout_s=0.1)
            assert c.deltas is not None and c.deltas.closed

    def test_no_stall_bound_opens_no_delta_stream(self):
        c = _FakeClient(tokens=[(5, 20)] * 50)
        _wait(c, timeout_s=0.05)
        assert c.deltas is None

    def test_idle_wins_over_everything(self):
        c = _FakeClient(tokens=[(5, 20)] * 50, busy=False)
        reached, reason = _wait(c, stall_timeout_s=0.0)
        assert (reached, reason) == (True, "idle")

    def test_without_a_stall_bound_behaviour_is_unchanged(self):
        # The old contract: busy until the budget expires.
        c = _FakeClient(tokens=[(5, 20)] * 50)
        reached, reason = _wait(c, timeout_s=0.2)
        assert (reached, reason) == (False, "timeout")
        assert c.progress_calls == 0, "no stall bound means no progress probing at all"

    def test_a_probe_outage_is_not_evidence_of_a_stall(self):
        # Losing sight of the session must not be read as the turn being stuck;
        # that would kill healthy cells during a transient serve fault.
        c = _FakeClient(tokens=[], raise_progress=True)
        reached, reason = _wait(c, stall_timeout_s=0.0, timeout_s=0.2)
        assert reason == "timeout"

    def test_wait_idle_still_returns_a_bool(self):
        c = _FakeClient(tokens=[(1, 1)] * 5, busy=False)
        assert c.wait_idle("sid", timeout_s=1.0) is True


class TestProgressToken:
    def test_counts_messages_and_parts(self, monkeypatch):
        c = _FakeClient(tokens=[])
        monkeypatch.setattr(
            ServeClient,
            "get_messages",
            lambda self, sid: [{"parts": [1, 2, 3]}, {"parts": [4]}, "junk"],
        )
        assert ServeClient.session_progress_token(c, "sid") == (3, 4)

    def test_survives_a_malformed_payload(self, monkeypatch):
        c = _FakeClient(tokens=[])
        monkeypatch.setattr(ServeClient, "get_messages", lambda self, sid: None)
        assert ServeClient.session_progress_token(c, "sid") == (0, 0)


class TestStallIsNotAModelFailure:
    def test_turn_stalled_is_a_harness_limit(self):
        from harness.adapters.challenge import _HARNESS_LIMIT_REASONS

        assert "turn_stalled" in _HARNESS_LIMIT_REASONS, (
            "a wedged tool call is the harness losing the turn, not the model "
            "failing the task; scoring it as capability would be a false negative"
        )

    def test_stall_bound_is_far_below_the_run_budget(self):
        from harness.adapters.challenge import (
            DEFAULT_RUN_TIMEOUT_S,
            DEFAULT_TURN_STALL_TIMEOUT_S,
        )

        assert DEFAULT_TURN_STALL_TIMEOUT_S < DEFAULT_RUN_TIMEOUT_S / 4, (
            "a stall bound near the run budget saves nothing — the point is that "
            "a wedged turn costs minutes instead of the cell"
        )

    def test_the_drive_asks_for_the_stall_bound(self):
        from pathlib import Path

        src = (
            Path(__file__).resolve().parents[1] / "harness" / "adapters" / "challenge" / "serve.py"
        ).read_text(encoding="utf-8")
        assert "stall_timeout_s=DEFAULT_TURN_STALL_TIMEOUT_S" in src
        # Layout belongs to the formatter; the canary is the semantic mapping:
        # a stalled turn is now a recoverable harness-raised terminal
        # (TURN_TERMINAL_STALLED), still never a model failure.
        assert "terminal, reason = TURN_TERMINAL_STALLED, REASON_TOOL_CALL_TIMEOUT" in src


class TestToolCallRunning:
    @staticmethod
    def _assistant(*parts):
        return {"info": {"role": "assistant"}, "parts": list(parts)}

    def test_a_pending_or_running_tool_part_is_running(self):
        for status in ("pending", "running"):
            msgs = [self._assistant({"type": "step-start"}, {"type": "tool", "state": {"status": status}})]
            assert tool_call_running(msgs) is True

    def test_thinking_or_a_finished_tool_is_not(self):
        # R7's stalled turns: a step-start and one reasoning part, no tool.
        assert tool_call_running([self._assistant({"type": "step-start"}, {"type": "reasoning", "text": ""})]) is False
        assert tool_call_running([self._assistant({"type": "tool", "state": {"status": "completed"}})]) is False
        assert tool_call_running([self._assistant({"type": "tool", "state": {"status": "error"}})]) is False
        assert tool_call_running([]) is False

    def test_only_the_newest_assistant_message_counts(self):
        older = self._assistant({"type": "tool", "state": {"status": "running"}})
        newer = self._assistant({"type": "reasoning", "text": ""})
        user = {"info": {"role": "user"}, "parts": [{"type": "text", "text": "hi"}]}
        assert tool_call_running([older, newer, user]) is False
