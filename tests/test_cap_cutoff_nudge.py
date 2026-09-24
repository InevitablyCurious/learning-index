"""WO-CUTOFF Part A: the cap cut-off — detection, wording, budget, context guard.

A turn that ends ``finish_reason=length`` WITH its output+reasoning AT/above
opencode's output cap (32,000) is not a provider truncation: the model ran
into the fixed per-response limit. The serve drive maps it to
``TURN_TERMINAL_CAP_CUTOFF``, nudges with the wording that matches HOW the
turn was cut (plain prose -> cap-cutoff.md; a tool part -> cut-off.md),
bounds the nudges with its OWN budget (``_MAX_CAP_CUTOFF_NUDGES``, separate
from the transport-recovery budget), and refuses to nudge when the next
full-cap response cannot fit the model's window. Every cut-off emits a
``length_cutoff`` notice on the live stream.

FAIL-BEFORE: against the pre-WO-CUTOFF code every one of these fails — a
``length`` finish was counted as a provider truncation unconditionally, the
drive ended WITHOUT a nudge (``truncated_no_signal`` is not recoverable), no
``length_cutoff`` notice existed, and ``_OpencodeRunStats`` carried
``truncations`` instead of ``cap_cutoffs``/``cap_cutoffs_nudged``
(AttributeError on the stats assertions).

Shared fakes: tests/_serve_drive_fakes.py.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from harness.adapters.challenge import ChallengeRunner
from harness.adapters.challenge.constants import (
    _CAP_CUTOFF_RECOVERY_NUDGE,
    _FINALIZE_RECOVERY_NUDGE,
    _MAX_CAP_CUTOFF_NUDGES,
    TURN_TERMINAL_CAP_CUTOFF,
    TURN_TERMINAL_TRUNCATED,
)
from harness.context_budget import OPENCODE_OUTPUT_TOKEN_CAP
from harness.live_stream import LiveStream
from tests._serve_drive_fakes import (
    TASK_DIR,
    _FakeCell,
    _FakeServeClient,
    _ZERO_METRICS,
    _make_runner,
)

_CAP = OPENCODE_OUTPUT_TOKEN_CAP
_PROMPT = "build the thing"


# ── transcript + metrics shapes ─────────────────────────────────────────────


def _cut_tokens(
    *, inp: int = 100, out: int = _CAP, reasoning: int = 0,
    cache_read: int = 0, cache_write: int = 0,
) -> dict[str, Any]:
    """info.tokens as opencode records them on a finished assistant message."""
    return {
        "input": inp,
        "output": out,
        "reasoning": reasoning,
        "cache": {"read": cache_read, "write": cache_write},
    }


def _length_at_cap(**token_kwargs: Any) -> dict[str, Any]:
    """A terminal-script entry: a ``length`` step-finish whose message tokens
    reached the cap — the shape ``extract_transcript_metrics`` counts as a
    ``cap_cutoffs`` hit (and the drive's own detection re-reads off the last
    assistant message)."""
    return {"step_finish": "length", "tokens": _cut_tokens(**token_kwargs)}


def _cum_read(
    *, turns: int, out: int, cap_cutoffs: int, inp: int = 100,
    provider_truncations: int = 0, last_finish: str | None = "length",
) -> dict[str, Any]:
    """A session-CUMULATIVE metrics read (the canned side of the fake; the
    windowed classification read is derived from the fake transcript through
    the REAL extractor)."""
    return {
        "turns": turns,
        "input_tokens": inp,
        "output_tokens": out,
        "reasoning_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "cost_usd": 0.0,
        "provider_truncations": provider_truncations,
        "cap_cutoffs": cap_cutoffs,
        "last_finish": last_finish,
        "error_parts": 0,
        "info_errors": 0,
        "guard_aborted_turns": 0,
        "finalize_timeouts": 0,
        "error_texts": [],
    }


# ── live-stream capture (the _records idiom from test_live_stream_notices) ──


def _records(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def _cutoff_notices(path: Path) -> list[dict]:
    return [r for r in _records(path) if r.get("event") == "length_cutoff"]


def _drive(
    runner: ChallengeRunner,
    client: _FakeServeClient,
    tmp_path: Path,
    *,
    phase: str = "feedback-1",
    session_id: str = "ses_cap",
):
    """Attach a live stream, drive ONE phase, return (stats, live_path)."""
    live_path = tmp_path / "live.jsonl"
    runner._live = LiveStream(live_path, run_id="r-cap")
    stats = runner._run_opencode_serve(
        active_cell=_FakeCell(),
        serve_client=client,
        session_id=session_id,
        prompt=_PROMPT,
        run_label="cell-cap",
        phase=phase,
        attempt=1,
    )
    return stats, live_path


def _nudge_file(name: str) -> str:
    """The nudge wording as it sits on disk, read exactly as PromptPack.text
    reads it (trailing newlines stripped, nothing else)."""
    return (TASK_DIR / "prompts" / "nudges" / name).read_text(
        encoding="utf-8"
    ).rstrip("\n")


def _make_runner_mode(tmp_path: Path, memory_mode: str) -> ChallengeRunner:
    """The shared _make_runner, arm-parameterized: the drive must not branch
    on memory_mode (RC-4), and this constructs both arms identically."""
    return ChallengeRunner(
        task_dir=TASK_DIR,
        work_root=tmp_path / "work-root",
        model="local-llm-proxy/qwen3.6-35b-a3b-bench",
        memory_mode=memory_mode,
        run_timeout_s=30,
        completion_grace_s=2,
        compact=False,
    )


class _ToolTurnServeClient(_FakeServeClient):
    """The shared fake appends text-only assistant messages. A cap cut-off on
    a TOOL turn needs a ``tool`` part on the cut message: the wording branch
    keys on ``message_has_tool_part`` of the LAST assistant message."""

    def send_prompt(self, session_id: str, prompt: str) -> None:
        super().send_prompt(session_id, prompt)
        for msg in reversed(self._messages):
            info = msg.get("info") if isinstance(msg, dict) else None
            if isinstance(info, dict) and info.get("role") == "assistant":
                msg["parts"].append(
                    {
                        "type": "tool",
                        "tool": "write",
                        "callID": "call_cap",
                        "state": {"status": "running"},
                    }
                )
                break


# ── 1. PROSE wording ────────────────────────────────────────────────────────


def test_prose_cap_cutoff_nudges_with_the_cap_cutoff_wording(
    tmp_path: Path,
) -> None:
    """A cut-off with NO tool part on the cut message gets the plain
    "take the next concrete step" nudge — NOT the write-in-chunks directive,
    which belongs to a tool call cut mid-write."""
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.assistant_terminal_script = [_length_at_cap()]
    client.metrics_script = [
        dict(_ZERO_METRICS),                          # phase baseline
        _cum_read(turns=1, out=_CAP, cap_cutoffs=1),  # the cut turn
        _cum_read(turns=2, out=_CAP, cap_cutoffs=1),  # post-nudge, clean
    ]

    stats, live_path = _drive(runner, client, tmp_path)

    sent = [text for _, text in client.sent_prompts]
    assert sent == [_PROMPT, _CAP_CUTOFF_RECOVERY_NUDGE]
    # The nudge IS the prompt-file wording, and the wording is pinned.
    assert _CAP_CUTOFF_RECOVERY_NUDGE == _nudge_file("cap-cutoff.md")
    assert _CAP_CUTOFF_RECOVERY_NUDGE == (
        "Your last message got cut off. Take the next concrete step."
    )

    assert stats.cap_cutoffs == 1
    assert stats.cap_cutoffs_nudged == 1
    assert stats.exit_code == 0
    assert stats.killed_reason is None

    # The anomaly carries the cap cut-off terminal and is retry-linked.
    (anomaly,) = stats.turn_anomalies
    assert anomaly["terminal"] == TURN_TERMINAL_CAP_CUTOFF
    assert anomaly["finish_reason"] == "length"
    assert anomaly["retried"] is True
    assert anomaly["retry_kind"] == "cap_cutoff_nudge"

    (notice,) = _cutoff_notices(live_path)
    assert notice["kind"] == "notice"
    assert notice["source"] == "harness"
    assert notice["level"] == "warn"  # recovering as designed, not an error
    assert notice["session_id"] == "ses_cap"
    assert notice["detail"] == {
        "phase": "feedback-1",
        "attempt": 1,
        "nudged": True,
        "reason": "nudged",
        "output_tokens": _CAP,
        "reasoning_tokens": 0,
        "cap": _CAP,
        "wording": "cap-cutoff",
    }


# ── 2. TOOL-CALL wording ────────────────────────────────────────────────────


def test_tool_turn_cap_cutoff_nudges_with_the_cut_off_wording(
    tmp_path: Path,
) -> None:
    """A cut-off WITH a tool part on the cut message gets the resume wording
    (cut-off.md) — the tool call was cut mid-flight, so the model is told to
    continue from where it left off."""
    runner = _make_runner(tmp_path)
    client = _ToolTurnServeClient()
    client.assistant_terminal_script = [_length_at_cap()]
    client.metrics_script = [
        dict(_ZERO_METRICS),
        _cum_read(turns=1, out=_CAP, cap_cutoffs=1),
        _cum_read(turns=2, out=_CAP, cap_cutoffs=1),
    ]

    stats, live_path = _drive(runner, client, tmp_path)

    sent = [text for _, text in client.sent_prompts]
    assert sent == [_PROMPT, _FINALIZE_RECOVERY_NUDGE]
    assert _FINALIZE_RECOVERY_NUDGE == _nudge_file("cut-off.md")
    # Pinned WITH its trailing space — the file carries it, PromptPack.text
    # strips only newlines, and the model reads every byte.
    assert _FINALIZE_RECOVERY_NUDGE == (
        "Your last message got cut off. Continue from where you left off. "
    )

    assert stats.cap_cutoffs == 1
    assert stats.cap_cutoffs_nudged == 1

    (notice,) = _cutoff_notices(live_path)
    assert notice["detail"]["wording"] == "cut-off"
    assert notice["detail"]["nudged"] is True
    assert notice["detail"]["reason"] == "nudged"


# ── 3. BUDGET EXHAUSTION ────────────────────────────────────────────────────


def test_cap_cutoff_nudge_budget_stops_at_two(tmp_path: Path) -> None:
    """A model that keeps running into the cap gets at most
    _MAX_CAP_CUTOFF_NUDGES nudges; the cut-off after that ends the drive
    UNNUDGED, said out loud as budget_spent (error, not warn — nothing
    recovers from here)."""
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.assistant_terminal_script = [_length_at_cap()] * 3
    client.metrics_script = [
        dict(_ZERO_METRICS),
        _cum_read(turns=1, out=_CAP, cap_cutoffs=1),
        _cum_read(turns=2, out=2 * _CAP, cap_cutoffs=2),
        _cum_read(turns=3, out=3 * _CAP, cap_cutoffs=3),
    ]

    stats, live_path = _drive(runner, client, tmp_path)

    assert _MAX_CAP_CUTOFF_NUDGES == 2
    # Three cut-offs, only TWO nudges — the budget is the cap cut-off's own,
    # and the third cut-off is counted, never nudged.
    assert stats.cap_cutoffs == 3
    assert stats.cap_cutoffs_nudged == 2
    sent = [text for _, text in client.sent_prompts]
    assert sent == [_PROMPT, _CAP_CUTOFF_RECOVERY_NUDGE, _CAP_CUTOFF_RECOVERY_NUDGE]

    notices = _cutoff_notices(live_path)
    assert [n["detail"]["reason"] for n in notices] == [
        "nudged",
        "nudged",
        "budget_spent",
    ]
    assert [n["detail"]["nudged"] for n in notices] == [True, True, False]
    assert [n["level"] for n in notices] == ["warn", "warn", "error"]

    # The third anomaly stays unretried — it ended the drive.
    assert [a["retried"] for a in stats.turn_anomalies] == [True, True, False]
    assert all(
        a["terminal"] == TURN_TERMINAL_CAP_CUTOFF for a in stats.turn_anomalies
    )


# ── 4. NO-CONTEXT-ROOM guard ────────────────────────────────────────────────


def test_no_nudge_when_the_next_full_cap_response_cannot_fit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Nudging is pointless when the last request's context plus ONE full-cap
    response cannot fit the model's window — the re-drive would run straight
    into the context wall. The cut-off is recorded and reported, never
    nudged."""
    # A tiny window via the serve module's own model_limits binding: the cut
    # turn's request context (9,000) + one full-cap response (32,000) does
    # not fit 40,000. (context_limit_tokens keeps the REAL registry binding,
    # so the CONTEXT EXHAUSTED line — 230,144 — is untouched and not tripped.)
    monkeypatch.setattr(
        "harness.adapters.challenge.serve.model_limits",
        lambda model: {"context": 40_000, "output": _CAP},
    )
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.assistant_terminal_script = [_length_at_cap(inp=9_000)]
    client.metrics_script = [
        dict(_ZERO_METRICS),
        _cum_read(turns=1, out=_CAP, cap_cutoffs=1, inp=9_000),
    ]

    stats, live_path = _drive(runner, client, tmp_path)

    # The nudge did NOT fire: the original prompt is the only one sent.
    assert [text for _, text in client.sent_prompts] == [_PROMPT]
    assert stats.cap_cutoffs == 1
    assert stats.cap_cutoffs_nudged == 0
    (anomaly,) = stats.turn_anomalies
    assert anomaly["terminal"] == TURN_TERMINAL_CAP_CUTOFF
    assert anomaly["retried"] is False
    assert anomaly["retry_kind"] is None

    (notice,) = _cutoff_notices(live_path)
    assert notice["level"] == "error"
    assert notice["detail"]["nudged"] is False
    assert notice["detail"]["reason"] == "no_context_room"
    assert notice["detail"]["cap"] == _CAP


def test_the_room_check_counts_the_cut_output_too(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The cut output is in the context the nudge's answer must fit beside.
    Request side 20,000 + a 32,000 cut = 52,000 held; one more full-cap answer
    needs 84,000 — over an 80,000 window. The request-side-only check
    (20,000 + 32,000 = 52,000) nudged straight into the wall. The phase's
    context peak is the same held size, prompt + output."""
    monkeypatch.setattr(
        "harness.adapters.challenge.serve.model_limits",
        lambda model: {"context": 80_000, "output": _CAP},
    )
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.assistant_terminal_script = [_length_at_cap(inp=20_000)]
    client.metrics_script = [
        dict(_ZERO_METRICS),
        _cum_read(turns=1, out=_CAP, cap_cutoffs=1, inp=20_000),
    ]

    stats, live_path = _drive(runner, client, tmp_path)

    assert [text for _, text in client.sent_prompts] == [_PROMPT]
    (notice,) = _cutoff_notices(live_path)
    assert notice["detail"]["reason"] == "no_context_room"
    assert stats.context_peak_tokens == 20_000 + _CAP
    assert runner._cell_context_peak == 20_000 + _CAP, "maxed into the cell's peak for cell.end"


# ── 5. BELOW-CAP does NOT fire ──────────────────────────────────────────────


def test_length_below_the_cap_stays_a_provider_truncation(
    tmp_path: Path,
) -> None:
    """A ``length`` finish BELOW the cap is the provider stopping short — a
    genuine provider truncation. It is NOT a cap cut-off: no nudge, no
    length_cutoff notice, and the terminal stays the provider truncation."""
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.assistant_terminal_script = [
        {"step_finish": "length", "tokens": _cut_tokens(out=5_000)}
    ]
    client.metrics_script = [
        dict(_ZERO_METRICS),
        _cum_read(
            turns=1, out=5_000, cap_cutoffs=0, provider_truncations=1
        ),
    ]

    stats, live_path = _drive(runner, client, tmp_path)

    assert _cutoff_notices(live_path) == []
    assert [text for _, text in client.sent_prompts] == [_PROMPT]
    assert stats.provider_truncations == 1
    assert stats.cap_cutoffs == 0
    (anomaly,) = stats.turn_anomalies
    assert anomaly["terminal"] == TURN_TERMINAL_TRUNCATED
    assert anomaly["finish_reason"] == "length"
    assert anomaly["retried"] is False


# ── 6. ARM / BUILD-PATH PARITY ──────────────────────────────────────────────


@pytest.mark.parametrize("phase", ["initial-chunk-1", "feedback-1"])
@pytest.mark.parametrize("memory_mode", ["off", "on"])
def test_cap_cutoff_behaviour_is_identical_across_arms_and_paths(
    tmp_path: Path, phase: str, memory_mode: str
) -> None:
    """RC-4: there is NO arm branch and NO build/repair branch. The identical
    cut-off produces the identical nudge, stats and notice under the build
    path (initial-chunk-1) and the repair path (feedback-1), under
    memory_mode off and on. This pins the absence."""
    runner = _make_runner_mode(tmp_path, memory_mode)
    client = _FakeServeClient()
    client.assistant_terminal_script = [_length_at_cap()]
    client.metrics_script = [
        dict(_ZERO_METRICS),
        _cum_read(turns=1, out=_CAP, cap_cutoffs=1),
        _cum_read(turns=2, out=_CAP, cap_cutoffs=1),
    ]

    stats, live_path = _drive(runner, client, tmp_path, phase=phase)

    sent = [text for _, text in client.sent_prompts]
    assert sent == [_PROMPT, _CAP_CUTOFF_RECOVERY_NUDGE]
    assert stats.cap_cutoffs == 1
    assert stats.cap_cutoffs_nudged == 1
    assert stats.exit_code == 0
    assert stats.killed_reason is None
    (anomaly,) = stats.turn_anomalies
    assert anomaly["terminal"] == TURN_TERMINAL_CAP_CUTOFF
    assert anomaly["retry_kind"] == "cap_cutoff_nudge"
    (notice,) = _cutoff_notices(live_path)
    assert notice["detail"] == {
        "phase": phase,
        "attempt": 1,
        "nudged": True,
        "reason": "nudged",
        "output_tokens": _CAP,
        "reasoning_tokens": 0,
        "cap": _CAP,
        "wording": "cap-cutoff",
    }


def test_an_unreadable_session_fails_loud_never_scores_the_cut_as_a_provider_truncation(
    tmp_path: Path,
) -> None:
    """The cap check reads the cut message's token counts from the session. If
    that read fails, the cut must not be scored as 0 tokens — that makes it a
    provider truncation and voids the cell over OUR cap. It aborts loudly."""
    from harness.adapters.challenge.exceptions import ServeTransportError
    from harness.serve_transport import ServeClientError

    class _UnreadableAfterSend(_FakeServeClient):
        sent = False

        def send_prompt(self, session_id: str, prompt: str) -> None:
            super().send_prompt(session_id, prompt)
            self.sent = True

        def get_messages(self, session_id: str):  # type: ignore[override]
            if self.sent:
                raise ServeClientError("session read failed")
            return super().get_messages(session_id)

    runner = _make_runner(tmp_path)
    client = _UnreadableAfterSend()
    client.assistant_terminal_script = [_length_at_cap()]
    client.metrics_script = [dict(_ZERO_METRICS), _cum_read(turns=1, out=_CAP, cap_cutoffs=1)]
    with pytest.raises(ServeTransportError, match="cap cut-off"):
        _drive(runner, client, tmp_path)
