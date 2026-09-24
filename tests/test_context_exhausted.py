"""CONTEXT EXHAUSTED: a session out of room stops the cell instead of compacting.

Three of four Learning-Index runs had repair rounds summarised by opencode's
own automatic compaction. It is now off in the worker config, and reaching the
limit ends the cell as ``context_exhausted`` (harness/context_budget.py).
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


def test_sizes_and_overflow_errors_are_read_from_messages() -> None:
    messages = [
        {"info": {"role": "assistant", "tokens": {"input": 10, "output": 5, "cache": {"read": 100, "write": 0}}}},
        {"info": {"role": "user"}},
    ]
    assert latest_context_tokens(messages) == 115
    assert context_exhausted(messages, 200) == (False, 115)
    assert context_exhausted(messages, 115) == (True, 115)
    overflow = messages + [{"info": {"role": "assistant", "error": {"name": "ContextOverflowError"}}}]
    assert context_exhausted(overflow, 10_000_000)[0] is True


def test_the_worker_never_compacts_on_its_own() -> None:
    config = build_worker_opencode_config(
        model=QWEN, reasoning_effort=None, proxy_base_url=None, gates_dir="/g", golden_dir="/x"
    )
    assert config["compaction"] == {"auto": False}


# ── the drive ───────────────────────────────────────────────────────────────


def _drive(runner: ChallengeRunner, client: _FakeServeClient, phase: str = "feedback-1") -> _OpencodeRunStats:
    return runner._run_opencode_serve(
        active_cell=_FakeCell(),
        serve_client=client,
        session_id="ses_ctx",
        prompt="fix these",
        run_label="cell-ctx",
        phase=phase,
        timeout_s=60.0,
    )


def _client(metrics: dict[str, Any] | None = None) -> _FakeServeClient:
    client = _FakeServeClient()
    client.metrics_result = metrics or {
        "turns": 3, "input_tokens": 100, "output_tokens": 50, "reasoning_tokens": 0,
        "cost_usd": 0.0, "provider_truncations": 0, "error_parts": 0,
    }
    return client


def test_a_turn_that_ends_past_the_line_stops_the_phase_without_a_nudge(tmp_path: Path) -> None:
    runner = _make_runner(tmp_path)
    client = _client()
    client.assistant_terminal_script = [{"tokens": {"input": 480, "output": 500, "cache": {"read": 229_300, "write": 0}}}]
    stats = _drive(runner, client)
    assert stats.context_exhausted is True
    assert stats.killed_reason == CONTEXT_EXHAUSTED
    assert stats.exit_code == 0
    assert stats.context_tokens == 230_280
    assert stats.context_limit_tokens == 230_144
    assert len(client.sent_prompts) == 1, "a session out of room is never nudged"
    assert stats.turn_anomalies == (), "running out of room is a result, not an instrument anomaly"


def test_a_turn_under_the_line_is_untouched(tmp_path: Path) -> None:
    runner = _make_runner(tmp_path)
    client = _client()
    client.assistant_terminal_script = [{"tokens": {"input": 480, "output": 500, "cache": {"read": 228_000, "write": 0}}}]
    stats = _drive(runner, client)
    assert stats.context_exhausted is False
    assert stats.killed_reason is None


def test_an_overflowed_request_stops_instead_of_being_retried_as_a_transport_error(tmp_path: Path) -> None:
    runner = _make_runner(tmp_path)
    client = _client()
    client.assistant_terminal_script = [
        {"info_error": "This model's maximum context length is 262144 tokens.", "error_name": "ContextOverflowError"}
    ]
    stats = _drive(runner, client)
    assert stats.context_exhausted is True
    assert len(client.sent_prompts) == 1


def test_running_out_mid_turn_aborts_the_session(tmp_path: Path) -> None:
    runner = _make_runner(tmp_path)
    client = _client()
    client.wait_script = [(False, CONTEXT_EXHAUSTED)]
    stats = _drive(runner, client)
    assert stats.context_exhausted is True
    assert client.aborted_sessions == ["ses_ctx"]
    assert stats.exit_code == 0


def test_the_real_waiter_ends_a_turn_that_crosses_the_line() -> None:
    class Busy(ServeClient):
        def __init__(self) -> None:
            super().__init__(base_url="http://unused")
            self.poll_interval = 0.0

        def session_busy(self, session_id: str) -> bool:
            return True

        def get_messages(self, session_id: str) -> list:
            return [{"info": {"role": "assistant", "tokens": {"total": 240_000}}}]

    idle, reason = Busy().wait_idle_detailed(
        "s", timeout_s=5, progress_interval_s=0.0, context_limit_tokens=230_144
    )
    assert (idle, reason) == (False, CONTEXT_EXHAUSTED)


# ── the cell ────────────────────────────────────────────────────────────────


def _stats(**over: Any) -> _OpencodeRunStats:
    base: dict[str, Any] = {"input_tokens": 10, "output_tokens": 20, "reasoning_tokens": 5, "turns": 1,
                             "session_id": "sess-1", "killed_reason": None, "exit_code": 0, "cost_usd": 0.0}
    base.update(over)
    return _OpencodeRunStats(**base)


def _cell(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, exhaust_phase: str) -> tuple[Any, dict[str, int], list[str]]:
    from tests.test_challenge_budget_stop import REAL_CHECK, _patch_fake_docker
    from tests.test_challenge_budget_stop import _make_runner as make

    runner = make(tmp_path, max_attempts=5)
    _patch_fake_docker(monkeypatch)
    monkeypatch.setattr(runner, "_load_chunk_prompts", lambda *a, **k: ["CHUNK ONE", "CHUNK TWO"])
    grades = {"count": 0}

    def _gate(**kwargs: Any) -> dict[str, Any]:
        grades["count"] += 1
        return {"verdict": "FAIL", "conformed": True, "problems": [{"check": REAL_CHECK}], "failed_gates": [REAL_CHECK]}

    monkeypatch.setattr(runner, "_run_gate_report", _gate)
    phases: list[str] = []

    def _serve(**kwargs: Any) -> _OpencodeRunStats:
        phases.append(kwargs["phase"])
        if kwargs["phase"] == exhaust_phase:
            return _stats(killed_reason=CONTEXT_EXHAUSTED, context_exhausted=True,
                          context_tokens=231_000, context_limit_tokens=230_144)
        return _stats()

    monkeypatch.setattr(runner, "_run_opencode_serve", _serve)
    result = runner._run_cell_impl(run_label="ctx", run_dir=tmp_path / "ctx", task_id="backgammon")
    return result, grades, phases


def test_running_out_in_a_repair_round_stops_the_run_and_keeps_the_last_grade(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    result, grades, phases = _cell(monkeypatch, tmp_path, "feedback-2")
    assert result.termination_reason == CONTEXT_EXHAUSTED
    assert result.attempts_to_green == "CONTEXT_EXHAUSTED"
    assert result.verdict == "FAIL"
    assert grades["count"] == 2, "rounds graded before the stop stand; nothing after it runs"
    assert phases[-1] == "feedback-2"


def test_running_out_during_the_build_stops_the_run_and_grades_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    result, grades, phases = _cell(monkeypatch, tmp_path, "initial-chunk-1")
    assert result.termination_reason == CONTEXT_EXHAUSTED
    assert grades["count"] == 0
    assert phases == ["initial-chunk-1"], "the next build step never starts"
