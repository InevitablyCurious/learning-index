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

from harness.serve_client import ServeClient, ServeClientError


class _FakeClient(ServeClient):
    """Drives wait_idle_detailed off scripted busy/progress, with no clock wait."""

    def __init__(
        self, *, tokens=None, busy=True, raise_progress=False, advancing=False
    ):
        self.poll_interval = 0.0
        self._tokens = list(tokens or [])
        self._busy = busy
        self._raise_progress = raise_progress
        self._advancing = advancing
        self.progress_calls = 0

    def session_busy(self, session_id: str) -> bool:  # type: ignore[override]
        return self._busy

    def session_progress_token(self, session_id: str):  # type: ignore[override]
        self.progress_calls += 1
        if self._raise_progress:
            raise ServeClientError("probe down")
        if self._advancing:
            # Never runs dry: parts keep climbing, as they do while a
            # generation streams.
            return (5, 20 + self.progress_calls)
        if self._tokens:
            return self._tokens.pop(0)
        return (1, 1)


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
        # Parts keep growing, as they do while a generation streams.
        c = _FakeClient(advancing=True)
        reached, reason = _wait(c, stall_timeout_s=0.0, timeout_s=0.25)
        assert reason == "timeout", (
            "a turn that keeps progressing must hit the budget, not the stall bound"
        )
        assert reached is False

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
