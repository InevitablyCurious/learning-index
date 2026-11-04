"""CONTEXT EXHAUSTED: only a context too large to compact ends a cell.

Automatic compaction is ON (opencode's default, and the worker config no
longer writes a `compaction` key at all). A session that reaches its token
threshold compacts and keeps going — in troubleshooting, and at each build
chunk boundary, where the HARNESS fires its own ``summarize``.

So the token line is no longer a verdict. ``context_exhausted`` reports True
only for the one genuine residual: ``ContextOverflowError``, a request too
large to compact at all, which no nudge and no summarize can clear
(harness/context_budget.py). The line is still computed and recorded — an
operator wants to know how close a run ran — and the waiter never decides
anything about the context for the same reason.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from harness.adapters.challenge import ChallengeRunner, _OpencodeRunStats
from harness.adapters.challenge.worker_config import build_worker_opencode_config
from harness.context_budget import (
    CONTEXT_EXHAUSTED,
    context_exhausted,
    context_limit_tokens,
    latest_context_tokens,
)
from harness.serve_client import ServeClient
from tests._serve_drive_fakes import _FakeCell, _FakeServeClient, _make_runner

QWEN = "local-llm-proxy/qwen3.6-35b-a3b-bench"


# ── the line ────────────────────────────────────────────────────────────────


def test_the_line_is_where_opencode_compacted_in_run_1789580246() -> None:
    limit = context_limit_tokens(QWEN)
    assert limit == 262_144 - 32_000
    # Measured: a turn at 229,535 did not compact; the next at 230,340 did.
    assert 229_535 < limit <= 230_340


def test_an_output_cap_moves_the_line_like_it_moves_opencodes() -> None:
    assert context_limit_tokens(QWEN, output_token_max=16_000) == 262_144 - 16_000


def test_a_model_with_no_declared_limit_refuses_rather_than_runs_unguarded() -> None:
    with pytest.raises(ValueError):
        context_limit_tokens("local-llm-proxy/not-a-model")


def test_only_an_overflow_error_ends_a_cell_never_the_token_line() -> None:
    """Sizes are read off the messages; the LIMIT decides nothing.

    A turn at or past the limit with no overflow error is a turn opencode can
    compact — ``(False, size)``. Only ``ContextOverflowError`` (too large to
    compact) reports True, whatever limit is passed (or none at all).
    """
    messages = [
        {
            "info": {
                "role": "assistant",
                "tokens": {
                    "input": 10,
                    "output": 5,
                    "cache": {"read": 100, "write": 0},
                },
            }
        },
        {"info": {"role": "user"}},
    ]
    assert latest_context_tokens(messages) == 115
    assert context_exhausted(messages, 200) == (False, 115)
    # AT and PAST the line: still not an ending — this is the inversion.
    assert context_exhausted(messages, 115) == (False, 115)
    assert context_exhausted(messages, 10) == (False, 115)
    overflow = messages + [
        {"info": {"role": "assistant", "error": {"name": "ContextOverflowError"}}}
    ]
    assert context_exhausted(overflow, 10_000_000) == (True, 115)
    assert context_exhausted(overflow) == (True, 115)


def test_the_worker_config_leaves_auto_compaction_at_opencodes_default() -> None:
    """No `compaction` key: the engine's own default (ON) is left alone.

    The benchmark does not switch compaction off and does not force it on from
    the worker side either — the build's compaction is the harness's own
    ``summarize`` call, which needs no config. And the memory plugin is the only
    plugin listed: the worker-fired self-compact plugin is gone with the
    sentinel it armed on.
    """
    config = build_worker_opencode_config(
        model=QWEN,
        reasoning_effort=None,
        proxy_base_url=None,
        gates_dir="/g",
        golden_dir="/x",
        plugin_entry="/opt/okp/memory-plugin.js",
    )
    assert "compaction" not in config, (
        "auto-compaction stays at opencode's default (ON); writing a compaction "
        "block is what the old threshold-ends-the-cell world needed"
    )
    assert config["plugin"] == ["/opt/okp/memory-plugin.js"], (
        "the memory plugin is the only plugin listed — no worker self-compact plugin"
    )
    assert "plugin" not in build_worker_opencode_config(
        model=QWEN,
        reasoning_effort=None,
        proxy_base_url=None,
        gates_dir="/g",
        golden_dir="/x",
    ), "a memory-OFF cell lists no plugin at all"


# ── the drive ───────────────────────────────────────────────────────────────


def _drive(
    runner: ChallengeRunner, client: _FakeServeClient, phase: str = "feedback-1"
) -> _OpencodeRunStats:
    return runner._run_opencode_serve(
        active_cell=_FakeCell(),
        serve_client=client,
        session_id="ses_ctx",
        prompt="fix these",
        run_label="cell-ctx",
        phase=phase,
    )


def _client(metrics: dict[str, Any] | None = None) -> _FakeServeClient:
    client = _FakeServeClient()
    client.metrics_result = metrics or {
        "turns": 3,
        "input_tokens": 100,
        "output_tokens": 50,
        "reasoning_tokens": 0,
        "cost_usd": 0.0,
        "provider_truncations": 0,
        "error_parts": 0,
    }
    return client


def test_a_turn_that_ends_past_the_line_no_longer_stops_the_phase(
    tmp_path: Path,
) -> None:
    """The inversion, at the drive: a saturated turn is not an ending.

    This is the shape that used to end the cell (a turn at 230,280 against the
    230,144 line). With auto-compaction on, the session compacts and continues,
    so the turn ends clean, nothing is nudged, and the size is still MEASURED —
    the peak is recorded for the operator, it just no longer decides anything.
    """
    runner = _make_runner(tmp_path)
    client = _client()
    client.assistant_terminal_script = [
        {
            "tokens": {
                "input": 480,
                "output": 500,
                "cache": {"read": 229_300, "write": 0},
            }
        }
    ]
    stats = _drive(runner, client)
    assert stats.context_exhausted is False
    assert stats.killed_reason is None
    assert stats.exit_code == 0
    assert stats.context_peak_tokens == 230_280, (
        "the size is still measured and recorded; it just does not end the cell"
    )
    assert stats.context_limit_tokens == 230_144
    assert len(client.sent_prompts) == 1, "no nudge, no re-drive"
    assert stats.turn_anomalies == (), (
        "running out of room is a result, not an instrument anomaly"
    )


def test_a_turn_under_the_line_is_untouched(tmp_path: Path) -> None:
    runner = _make_runner(tmp_path)
    client = _client()
    client.assistant_terminal_script = [
        {
            "tokens": {
                "input": 480,
                "output": 500,
                "cache": {"read": 228_000, "write": 0},
            }
        }
    ]
    stats = _drive(runner, client)
    assert stats.context_exhausted is False
    assert stats.killed_reason is None


def test_an_overflowed_request_stops_instead_of_being_retried_as_a_transport_error(
    tmp_path: Path,
) -> None:
    runner = _make_runner(tmp_path)
    client = _client()
    client.assistant_terminal_script = [
        {
            "info_error": "This model's maximum context length is 262144 tokens.",
            "error_name": "ContextOverflowError",
        }
    ]
    stats = _drive(runner, client)
    assert stats.context_exhausted is True
    assert len(client.sent_prompts) == 1


def test_the_waiter_never_ends_a_turn_for_a_full_context() -> None:
    """A FULL CONTEXT IS NOT A REASON TO STOP WAITING.

    The waiter ends on idle, the budget or a stall — never on a token count. A
    session at its threshold compacts and continues, and a turn that cannot be
    compacted ends by itself carrying ``ContextOverflowError``. So a saturated,
    busy session simply keeps waiting until the explicit wait deadline expires.
    """

    class Busy(ServeClient):
        def __init__(self) -> None:
            super().__init__(base_url="http://unused")
            self.poll_interval = 0.0

        def session_busy(self, session_id: str) -> bool:
            return True

        def get_messages(self, session_id: str) -> list:
            return [{"info": {"role": "assistant", "tokens": {"total": 240_000}}}]

    idle, reason = Busy().wait_idle_detailed("s", timeout_s=0.05)
    assert (idle, reason) == (False, "timeout"), (
        "CONTEXT_EXHAUSTED is not a wait outcome any more"
    )


# ── the cell ────────────────────────────────────────────────────────────────


def _stats(**over: Any) -> _OpencodeRunStats:
    base: dict[str, Any] = {
        "input_tokens": 10,
        "output_tokens": 20,
        "reasoning_tokens": 5,
        "turns": 1,
        "session_id": "sess-1",
        "killed_reason": None,
        "exit_code": 0,
        "cost_usd": 0.0,
    }
    base.update(over)
    return _OpencodeRunStats(**base)


def _cell(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, exhaust_phase: str
) -> tuple[Any, dict[str, int], list[str]]:
    from tests.test_challenge_budget_stop import REAL_CHECK, _patch_fake_docker
    from tests.test_challenge_budget_stop import _make_runner as make

    runner = make(tmp_path)
    _patch_fake_docker(monkeypatch)
    monkeypatch.setattr(
        runner, "_load_chunk_prompts", lambda *a, **k: ["CHUNK ONE", "CHUNK TWO"]
    )
    grades = {"count": 0}

    def _gate(**kwargs: Any) -> dict[str, Any]:
        grades["count"] += 1
        return {
            "verdict": "FAIL",
            "conformed": True,
            "problems": [{"check": REAL_CHECK}],
            "failed_gates": [REAL_CHECK],
        }

    monkeypatch.setattr(runner, "_run_gate_report", _gate)
    phases: list[str] = []

    def _serve(**kwargs: Any) -> _OpencodeRunStats:
        phases.append(kwargs["phase"])
        if kwargs["phase"] == exhaust_phase:
            return _stats(
                killed_reason=CONTEXT_EXHAUSTED,
                context_exhausted=True,
                context_tokens=231_000,
                context_limit_tokens=230_144,
            )
        return _stats()

    monkeypatch.setattr(runner, "_run_opencode_serve", _serve)
    result = runner._run_cell_impl(
        run_label="ctx", run_dir=tmp_path / "ctx", task_id="backgammon"
    )
    return result, grades, phases


def test_running_out_in_a_repair_round_stops_the_run_and_keeps_the_last_grade(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    result, grades, phases = _cell(monkeypatch, tmp_path, "feedback-2")
    assert result.termination_reason == CONTEXT_EXHAUSTED
    assert result.attempts_to_green == "CONTEXT_EXHAUSTED"
    assert result.verdict == "FAIL"
    assert grades["count"] == 2, (
        "rounds graded before the stop stand; nothing after it runs"
    )
    assert phases[-1] == "feedback-2"


def test_running_out_during_the_build_stops_the_run_and_grades_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    result, grades, phases = _cell(monkeypatch, tmp_path, "initial-chunk-1")
    assert result.termination_reason == CONTEXT_EXHAUSTED
    assert grades["count"] == 0
    assert phases == ["initial-chunk-1"], "the next build step never starts"


def test_the_peak_is_counted_as_opencode_counts_it() -> None:
    """Run 1790258326: the card said peak 192,334 — the REQUEST side of the
    07:27 cut-off — while opencode's TUI showed 256,688 when the cell ended.
    The peak is prompt + output, the size the out-of-room check compares and
    the TUI shows; an aborted turn (no tokens) is not a zero."""
    from harness.context_budget import max_context_tokens

    def msg(total: int | None = None, **tokens: object) -> dict:
        body = {**tokens, **({"total": total} if total is not None else {})}
        return {"info": {"role": "assistant", "tokens": body}}

    cut = msg(
        total=224_334,
        input=65_358,
        output=32_000,
        reasoning=0,
        cache={"read": 126_976, "write": 0},
    )
    killed = msg(input=0, output=0, reasoning=0, cache={"read": 0, "write": 0})
    last = msg(
        total=256_688,
        input=68_093,
        output=179,
        reasoning=0,
        cache={"read": 188_416, "write": 0},
    )
    user = {"info": {"role": "user"}}
    assert max_context_tokens([user, cut, killed, last, killed]) == 256_688
    assert max_context_tokens([user, killed]) is None, "absent, never 0"
    assert max_context_tokens([]) is None
