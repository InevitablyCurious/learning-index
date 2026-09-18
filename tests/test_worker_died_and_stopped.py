"""A dead worker ends the run at once; a board Stop is recorded as stopped.

Run 1789712833: the model killed every process in its container, the serve
stopped answering, and the harness counted each failed probe as "still busy"
for the whole 90-minute budget. Runs 1789710421 and 1789711588 were stopped
from the board and recorded as harness_error, which voids them.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from harness.adapters.challenge import _OpencodeRunStats
from harness.serve_client import WORKER_DIED, ServeClient, ServeClientError
from tests._serve_drive_fakes import _FakeCell, _FakeServeClient, _make_runner


class _Unreachable(ServeClient):
    def __init__(self) -> None:
        super().__init__(base_url="http://unused")
        self.poll_interval = 0.0

    def session_busy(self, session_id: str) -> bool:
        raise ServeClientError("502 Bad Gateway")


def test_a_dead_worker_ends_the_wait_at_once() -> None:
    idle, reason = _Unreachable().wait_idle_detailed("s", timeout_s=30, worker_alive=lambda: False)
    assert (idle, reason) == (False, WORKER_DIED)


def test_an_unreachable_but_live_worker_is_still_waited_on() -> None:
    idle, reason = _Unreachable().wait_idle_detailed("s", timeout_s=0.2, worker_alive=lambda: True)
    assert (idle, reason) == (False, "timeout")


class _DeadCell(_FakeCell):
    def worker_state(self) -> dict[str, Any]:
        return {"running": False, "exit_code": 143, "detail": "exited"}


def test_the_drive_stops_on_a_dead_worker_without_nudging(tmp_path: Path) -> None:
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.metrics_result = {"turns": 1, "input_tokens": 1, "output_tokens": 1, "reasoning_tokens": 0,
                             "cost_usd": 0.0, "truncations": 0, "error_parts": 0}
    client.wait_script = [(False, WORKER_DIED)]
    stats = runner._run_opencode_serve(
        active_cell=_DeadCell(), serve_client=client, session_id="s", prompt="fix",
        run_label="cell", phase="feedback-2", timeout_s=60.0,
    )
    assert stats.killed_reason == WORKER_DIED
    assert stats.exit_code == 1
    assert len(client.sent_prompts) == 1
    assert client.aborted_sessions == [], "nothing to abort in a container that is gone"


def _stats(**over: Any) -> _OpencodeRunStats:
    base: dict[str, Any] = {"input_tokens": 1, "output_tokens": 1, "reasoning_tokens": 0, "turns": 1,
                            "session_id": "sess-1", "killed_reason": None, "exit_code": 0, "cost_usd": 0.0}
    base.update(over)
    return _OpencodeRunStats(**base)


def test_a_worker_that_dies_in_a_repair_round_ends_the_cell_keeping_the_last_grade(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from tests.test_challenge_budget_stop import REAL_CHECK, _make_runner as make, _patch_fake_docker

    runner = make(tmp_path, max_attempts=5)
    _patch_fake_docker(monkeypatch)
    monkeypatch.setattr(runner, "_load_chunk_prompts", lambda *a, **k: ["CHUNK"])
    grades = {"n": 0}

    def _gate(**kwargs: Any) -> dict[str, Any]:
        grades["n"] += 1
        return {"verdict": "FAIL", "conformed": True, "problems": [{"check": REAL_CHECK}], "failed_gates": [REAL_CHECK]}

    monkeypatch.setattr(runner, "_run_gate_report", _gate)
    monkeypatch.setattr(
        runner, "_run_opencode_serve",
        lambda **kw: _stats(killed_reason=WORKER_DIED, exit_code=1) if kw["phase"] == "feedback-2" else _stats(),
    )
    result = runner._run_cell_impl(run_label="dead", run_dir=tmp_path / "dead", task_id="backgammon")
    assert result.termination_reason == WORKER_DIED
    assert result.attempts_to_green == "WORKER_DIED"
    assert grades["n"] == 2


def test_a_board_stop_is_recorded_as_stopped_not_as_a_harness_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    runner = _make_runner(tmp_path)

    def _interrupted(**kwargs: Any) -> None:
        raise KeyboardInterrupt

    monkeypatch.setattr(runner, "_run_cell_impl", _interrupted)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    with pytest.raises(KeyboardInterrupt):
        runner.run_cell("stopped", run_dir, "backgammon")
    ends = [json.loads(line) for line in (run_dir / "live.jsonl").read_text().splitlines()
            if '"cell.end"' in line]
    assert ends[-1]["terminal_reason"] == "stopped"
    assert ends[-1]["terminal_exception"] == "KeyboardInterrupt"
