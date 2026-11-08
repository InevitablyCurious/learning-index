"""Chunk-boundary compaction: the HARNESS fires it, once per build chunk.

Not a worker plugin. After each build chunk returns,
``_run_opencode_serve_chunked`` calls ``ServeClient.summarize`` with
``auto=False`` (no synthetic continue turn — the harness drives the next chunk
itself) and logs ``step=self-compact chunk=N status=compacted compactions=1``.
The call BLOCKS until the rewrite is done, so the next chunk's prompt lands in
the compacted window. There is no phase sentinel, no settle, and no
"no compaction evidence" abort: the component that owns the boundary compacts
at it.

What the harness still ACTS on is the relay loop guard killing a compaction.
opencode auto-retries those, so one kill is a self-sustaining storm: the drive
fails fast (``compaction_loop_killed``) instead of nudging a session that will
only compact again.

The other half of the cadence is the one worth guarding: REPAIR NEVER COMPACTS.
The troubleshooting transcript is the model's record of what it already tried;
the build's narration is spent context. Shared fakes:
tests/_serve_drive_fakes.py.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from harness.serve_client import ServeClient
from tests._serve_drive_fakes import (
    _LOOP_SIG,
    _ZERO_METRICS,
    _FakeCell,
    _FakeServeClient,
    _make_feedback_attempt_kwargs,
    _make_runner,
    _metrics,
)

# ── THE HARNESS COMPACTS THE BOUNDARY ───────────────────────────────────────


def test_the_harness_compacts_once_per_build_chunk(tmp_path: Path) -> None:
    """One summarize per chunk, in order, and the receipt says so.

    The cadence is the whole contract: build a chunk, compact, build the next.
    Both ends are pinned here — the WRITE (one ``summarize`` per chunk, with the
    run's own provider/model and ``auto=False``) and the RECORD (one
    ``status=compacted compactions=1`` line per chunk, so an operator reading
    the log sees the same count the session carries).
    """
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    client.metrics_script = [
        dict(_ZERO_METRICS),  # chunk-1 baseline
        _metrics(2, 10, 5),  # chunk-1 end
        _metrics(2, 10, 5),  # chunk-2 baseline
        _metrics(4, 20, 10),  # chunk-2 end
        _metrics(4, 20, 10),  # chunk-3 baseline
        _metrics(6, 30, 15),  # chunk-3 end
    ]
    lines: list[str] = []
    runner._progress = lines.append  # type: ignore[method-assign]

    stats = runner._run_opencode_serve_chunked(
        active_cell=_FakeCell(),
        serve_client=client,
        session_id="ses_cc",
        prompts=["CHUNK ONE", "CHUNK TWO", "CHUNK THREE"],
        run_label="cell-cc",
    )

    assert stats.exit_code == 0
    assert stats.turns == 6, "the compaction is a write, not a metered turn"
    assert (
        client.summarize_calls
        == [("ses_cc", "local-llm-proxy", "qwen3.6-35b-a3b-bench", False)] * 3
    ), "exactly one compaction per build chunk, never two"
    assert [line for line in lines if "step=self-compact" in line] == [
        f"PROGRESS run_label=cell-cc step=self-compact chunk={chunk} "
        f"status=compacted compactions=1"
        for chunk in (1, 2, 3)
    ]
    # And each one LANDED on the transcript — three finished compactions.
    assert client.completed_compactions_since("ses_cc", 0) == 3


def test_a_run_without_the_flag_never_summarizes(tmp_path: Path) -> None:
    """No flag, no write. The OFF path is what every cell that declined
    compaction runs, so it must stay byte-for-byte the drive it always was."""
    runner = _make_runner(tmp_path)
    assert runner.compact is False, "compaction defaults OFF"
    client = _FakeServeClient()
    client.metrics_script = [
        dict(_ZERO_METRICS),
        _metrics(2, 10, 5),
        _metrics(2, 10, 5),
        _metrics(4, 20, 10),
    ]

    stats = runner._run_opencode_serve_chunked(
        active_cell=_FakeCell(),
        serve_client=client,
        session_id="ses_off",
        prompts=["CHUNK ONE", "CHUNK TWO"],
        run_label="cell-off",
    )

    assert stats.exit_code == 0
    assert stats.turns == 4
    assert client.summarize_calls == []
    assert client.completed_compactions_since("ses_off", 0) == 0


def test_a_chunk_that_ran_out_of_room_is_not_compacted(tmp_path: Path) -> None:
    """A context too large to compact has nothing to compact.

    ``ContextOverflowError`` is the one genuine ending left: the request cannot
    be shrunk, so a ``summarize`` at that boundary would be a write into a
    session that can no longer take one. The build stops where it ran out.
    """
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    client.assistant_terminal_script = [
        {
            "info_error": "This model's maximum context length is 262144 tokens.",
            "error_name": "ContextOverflowError",
        }
    ]
    client.metrics_script = [
        dict(_ZERO_METRICS),  # chunk-1 baseline
        _metrics(2, 10, 5),  # chunk-1 end
    ]

    stats = runner._run_opencode_serve_chunked(
        active_cell=_FakeCell(),
        serve_client=client,
        session_id="ses_overflow",
        prompts=["CHUNK ONE", "CHUNK TWO"],
        run_label="cell-overflow",
    )

    assert stats.exit_code == 0
    assert stats.context_exhausted is True
    assert stats.killed_reason == "context_exhausted"
    assert client.summarize_calls == []
    assert len(client.sent_prompts) == 1, "the next chunk never starts"


def test_repair_attempts_never_compact(tmp_path: Path) -> None:
    """THE OTHER HALF OF THE CADENCE, and the one worth guarding.

    Compaction lives in the chunked BUILD driver only. The repair loop drives
    through `_run_cell_attempt`, which never summarized and never will — the
    troubleshooting transcript is the model's record of what it has already
    tried, and compacting it away is the failure the whole change exists to
    prevent.
    """
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

    assert client.summarize_calls == [], (
        "the flag is set, and every repair round still declined to compact"
    )
    for _, text in client.sent_prompts:
        assert "okp_compact_session" not in text, (
            "the repair phase must never ask for compaction, whatever the flag says"
        )
        assert "CHUNK FINISHED" not in text, (
            "the deleted completion marker must not reappear in any prompt"
        )


# ── THE ONE COMPACTION FAILURE THE HARNESS STILL ACTS ON ────────────────────


def test_a_guard_killed_compaction_fails_fast(tmp_path: Path) -> None:
    """FAIL-FAST (run 1788451466): a compaction the relay loop guard killed.

    opencode AUTO-RETRIES a loop-killed compaction, so this is not one lost
    rewrite — it is a storm. Nudging around it is exactly the 10-minute hang
    (compact-1 ok, compact-2 relay_loop_detected xN, nudged to the budget), and
    a nudge does not fire a compaction anyway. The drive aborts named.
    """
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    client.metrics_script = [
        dict(_ZERO_METRICS),
        _metrics(2, 10, 5),
    ]
    original_send = client.send_prompt

    def _killed_send(session_id: str, prompt: str) -> None:
        original_send(session_id, prompt)
        # The kill lands on the transcript during the drive's own turn — the
        # pre-drive classification watermark sees it.
        client._messages.append(
            {
                "info": {
                    "role": "assistant",
                    "agent": "compaction",
                    "summary": True,
                    "error": {
                        "name": "UnknownError",
                        "data": {"message": _LOOP_SIG},
                    },
                }
            }
        )

    client.send_prompt = _killed_send  # type: ignore[method-assign]

    stats = runner._run_opencode_serve_chunked(
        active_cell=_FakeCell(),
        serve_client=client,
        session_id="ses_loopkill",
        prompts=["ONLY CHUNK"],
        run_label="cell-loopkill",
    )

    assert stats.exit_code == 1
    assert stats.killed_reason == "compaction_loop_killed"
    assert stats.recovery_nudges == 0, (
        "the build-turn nudge path must not be consulted for a compaction kill"
    )
    assert client.summarize_calls == [], (
        "the chunk died inside its drive, so it never reached its boundary"
    )


# ── THE COMPLETION PREDICATE ────────────────────────────────────────────────
#
# A compaction counts as FINISHED only when the transcript says so: an
# assistant message flagged `summary`, a non-empty `finish` (written when the
# stream that rewrites the context returns) and no `info.error`. The
# `agent == "compaction"` arm is gone — the flag marks the rewrite, the finish
# proves it landed.
#
# WHY THE FINISH IS REQUIRED: a compaction killed by the process group carries
# summary=True, NO finish and NO error (the kill never reached the transcript),
# so an error-only receipt counted 68 killed compactions as successes in run
# 1788415430.


def _client_reading(messages: list[dict[str, Any]]) -> ServeClient:
    """The REAL predicate over a transcript built in the test."""
    client = ServeClient(base_url="http://unused")
    client.get_messages = lambda session_id: list(messages)  # type: ignore[method-assign]
    return client


@pytest.mark.parametrize(
    ("info", "counted"),
    [
        ({"role": "assistant", "summary": True, "finish": "stop"}, 1),
        # A process-group kill: the rewrite never returned, so no finish.
        ({"role": "assistant", "summary": True}, 0),
        # A relay kill: the error is kept in the transcript.
        (
            {
                "role": "assistant",
                "summary": True,
                "finish": "stop",
                "error": {"name": "UnknownError", "data": {"message": _LOOP_SIG}},
            },
            0,
        ),
        # `agent=compaction` alone no longer marks a rewrite.
        ({"role": "assistant", "agent": "compaction", "finish": "stop"}, 0),
    ],
    ids=["finished", "killed-no-finish", "errored", "agent-arm-is-gone"],
)
def test_completed_compactions_counts_only_a_finished_compaction(
    info: dict[str, Any], counted: int
) -> None:
    assert _client_reading([{"info": info}]).completed_compactions_since("s", 0) == (
        counted
    )


def test_the_watermark_excludes_compactions_before_it() -> None:
    """A compaction from an EARLIER chunk is not this chunk's evidence."""
    client = _client_reading(
        [
            {"info": {"role": "user"}},
            {"info": {"role": "assistant", "summary": True, "finish": "stop"}},
        ]
    )
    assert client.completed_compactions_since("s", 0) == 1
    assert client.completed_compactions_since("s", 2) == 0
    assert client.completed_compactions_since("s", 1) == 1
