"""The compactions-before-grade count INSIDE ``ServeClient.wait_idle_detailed``.

The drive tests (``tests/test_compaction_in_drive.py``) prove the drive hands the
wait a grade watermark and maps the wait's reason onto the turn result. They
drive a CANNED fake wait, so they say nothing about the wait's own behaviour.
This file drives the REAL ``wait_idle_detailed`` loop with only the two probes
it touches (``session_busy`` and, through ``completed_compactions_since``,
``get_messages``) scripted, and pins the four decisions that live there:

* a NEVER-IDLE session is still judged -- two completed compactions on the poll
  ticks end the wait at ``compactions_before_grade`` (the hole this closed: a
  model calling tools forever inside one agent turn never reaches a turn
  boundary, so a turn-end check never saw the compaction storm);
* a compaction landing just before idle is not missed (the final count before
  the idle return);
* BUILD never counts -- with no watermark, compactions in the transcript end
  nothing, however many there are;
* ONE compaction continues to the normal budget exit, a FAILED count read is
  logged and defers rather than deciding, and a KILLED compaction shape
  (``summary`` without ``finish``) never counts through the wait path either.
"""

from __future__ import annotations

import logging

import pytest

from harness.serve_client import (
    COMPACTIONS_BEFORE_GRADE_WAIT_REASON,
    ServeClient,
    ServeClientError,
)

# A compaction that actually COMPLETED: the receipt is the non-empty ``finish``
# the stream writes when the context rewrite returns. This is the shape
# ``completed_compactions_since`` counts.
_COMPLETED = {
    "info": {"role": "assistant", "summary": True, "finish": "stop"},
    "parts": [],
}
# Killed mid-stream by the relay's loop guard: flagged ``summary`` but never
# finished. 68 of 73 compaction-agent messages on run 1788415430 looked exactly
# like this, which is why the flag alone is not a receipt.
_KILLED = {"info": {"role": "assistant", "summary": True}, "parts": []}


class _WaitClient(ServeClient):
    """The REAL wait loop, with only its two probes scripted and no clock wait.

    ``wait_idle_detailed`` is called with ``stall_timeout_s=None``, so it never
    opens a delta counter and never probes progress or tool state: the loop's
    only calls into the client are ``session_busy`` on every tick and
    ``get_messages`` through the compaction count.
    """

    # Count on the FIRST busy tick instead of the fifth, so nothing depends on
    # the number of ticks the test happens to get through.
    COMPACTION_COUNT_POLL_INTERVAL = 1

    def __init__(self, *, busy: bool, messages: list[dict] | None = None) -> None:
        super().__init__("http://fake", poll_interval=0.0)
        self._busy = busy
        self._messages = list(messages or [])

    def session_busy(self, session_id: str) -> bool:  # type: ignore[override]
        return self._busy

    def get_messages(self, session_id: str) -> list[dict]:  # type: ignore[override]
        return list(self._messages)


class _UnreadableClient(_WaitClient):
    """Busy forever, and every transcript read fails at the transport."""

    def get_messages(self, session_id: str) -> list[dict]:  # type: ignore[override]
        raise ServeClientError("boom")


def test_two_compactions_while_busy_end_the_wait() -> None:
    """The never-idle case: the session never goes idle, the count still decides."""
    client = _WaitClient(busy=True, messages=[_COMPLETED, _COMPLETED])

    reached, reason = client.wait_idle_detailed(
        "sid", timeout_s=0.5, compaction_watermark=0
    )

    assert (reached, reason) == (False, COMPACTIONS_BEFORE_GRADE_WAIT_REASON)


def test_two_compactions_then_idle_end_the_wait() -> None:
    """A compaction landing just before idle is caught by the final count."""
    client = _WaitClient(busy=False, messages=[_COMPLETED, _COMPLETED])

    reached, reason = client.wait_idle_detailed(
        "sid", timeout_s=0.5, compaction_watermark=0
    )

    assert (reached, reason) == (False, COMPACTIONS_BEFORE_GRADE_WAIT_REASON)


def test_no_watermark_never_counts() -> None:
    """Build passes no watermark, so a compacting transcript ends nothing."""
    client = _WaitClient(busy=True, messages=[_COMPLETED, _COMPLETED, _COMPLETED])

    reached, reason = client.wait_idle_detailed("sid", timeout_s=0.2)

    assert (reached, reason) == (False, "timeout")


def test_one_compaction_does_not_end_the_wait() -> None:
    """One compaction is absorbed: the wait runs on to its own budget."""
    client = _WaitClient(busy=True, messages=[_COMPLETED])

    reached, reason = client.wait_idle_detailed(
        "sid", timeout_s=0.2, compaction_watermark=0
    )

    assert (reached, reason) == (False, "timeout")


def test_failed_read_does_not_end_the_wait(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A transport hiccup on the count defers to the next tick, never aborts."""
    client = _UnreadableClient(busy=True)

    with caplog.at_level(logging.WARNING, logger="harness.serve_client"):
        reached, reason = client.wait_idle_detailed(
            "sid", timeout_s=0.2, compaction_watermark=0
        )

    assert (reached, reason) == (False, "timeout")
    assert any(
        record.levelno >= logging.WARNING
        and "compaction count read" in record.getMessage()
        for record in caplog.records
    ), "a failed count read must leave a WARNING behind; it is otherwise invisible"


def test_killed_compaction_does_not_count() -> None:
    """``summary`` without ``finish`` is a killed rewrite, not a compaction."""
    client = _WaitClient(busy=True, messages=[_KILLED, _KILLED])

    reached, reason = client.wait_idle_detailed(
        "sid", timeout_s=0.2, compaction_watermark=0
    )

    assert (reached, reason) == (False, "timeout")
