"""The operator's ready and cost commands for the memory system (harness/memory_hooks.py)."""

from __future__ import annotations

import subprocess

import pytest

from harness.memory_hooks import (
    ENV_MEMORY_COST_CMD,
    ENV_MEMORY_READY_CMD,
    ENV_MEMORY_READY_TIMEOUT,
    MemoryNotReady,
    cost_delta,
    read_cost,
    ready_timeout_s,
    wait_until_ready,
)


class _Script:
    """A fake `run` that answers each call from a list, and a clock it advances."""

    def __init__(self, answers: list[object], step_s: float = 5.0) -> None:
        self.answers = list(answers)
        self.calls: list[list[str]] = []
        self.now = 0.0
        self.step_s = step_s

    def run(self, argv: list[str], **_kwargs: object) -> subprocess.CompletedProcess:
        self.calls.append(argv)
        answer = self.answers.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        returncode, stdout = answer
        return subprocess.CompletedProcess(argv, returncode, stdout=stdout, stderr="")

    def sleep(self, seconds: float) -> None:
        self.now += seconds

    def clock(self) -> float:
        return self.now


def _wait(script: _Script, env: dict[str, str], **kwargs: object):
    return wait_until_ready(
        env, run=script.run, sleep=script.sleep, clock=script.clock, **kwargs
    )


def test_no_ready_command_means_no_wait() -> None:
    assert wait_until_ready({}) is None


def test_the_ready_command_is_polled_until_it_exits_zero() -> None:
    script = _Script([(1, "pending 3"), (1, "pending 1"), (0, "")])
    record = _wait(script, {ENV_MEMORY_READY_CMD: "honcho-ready"})
    assert record == {"ready": True, "waited_s": 10.0, "polls": 3}
    assert script.calls[0] == ["sh", "-c", "honcho-ready"]


def test_a_memory_system_that_stays_busy_stops_the_next_cell() -> None:
    script = _Script([(1, "pending 3")] * 3)
    env = {ENV_MEMORY_READY_CMD: "honcho-ready", ENV_MEMORY_READY_TIMEOUT: "10"}
    with pytest.raises(MemoryNotReady, match="not ready after 10s.*pending 3"):
        _wait(script, env)


def test_after_a_cell_a_timeout_is_recorded_not_raised() -> None:
    script = _Script([(1, "pending 3")] * 3)
    env = {ENV_MEMORY_READY_CMD: "honcho-ready", ENV_MEMORY_READY_TIMEOUT: "10"}
    record = _wait(script, env, raise_on_timeout=False)
    assert record == {"ready": False, "waited_s": 10.0, "polls": 3, "last": "pending 3"}


def test_a_ready_command_that_hangs_is_a_failed_poll() -> None:
    script = _Script([subprocess.TimeoutExpired("sh", 60), (0, "")])
    record = _wait(script, {ENV_MEMORY_READY_CMD: "honcho-ready"})
    assert record == {"ready": True, "waited_s": 5.0, "polls": 2}


@pytest.mark.parametrize("raw", ["soon", "0", "-5"])
def test_a_bad_ready_timeout_is_refused(raw: str) -> None:
    with pytest.raises(ValueError, match=ENV_MEMORY_READY_TIMEOUT):
        ready_timeout_s({ENV_MEMORY_READY_TIMEOUT: raw})


def test_the_ready_command_runs_through_the_shell() -> None:
    assert wait_until_ready({ENV_MEMORY_READY_CMD: "test 1 -eq 1"}) == {
        "ready": True,
        "waited_s": 0.0,
        "polls": 1,
    }


def test_no_cost_command_means_no_cost() -> None:
    assert read_cost({}) is None


def test_the_cost_command_prints_running_counters() -> None:
    env = {
        ENV_MEMORY_COST_CMD: """echo '{"input_tokens": 1200, "output_tokens": 300.5}'"""
    }
    assert read_cost(env) == {
        "counters": {"input_tokens": 1200, "output_tokens": 300.5}
    }


@pytest.mark.parametrize(
    "command,error",
    [
        ("exit 3", "exit 3"),
        ("echo not-json", "not JSON"),
        ("""echo '[1, 2]'""", "not a JSON object of numbers"),
        ("""echo '{"tokens": "many"}'""", "not a JSON object of numbers"),
        ("""echo '{"ok": true}'""", "not a JSON object of numbers"),
    ],
)
def test_a_cost_that_cannot_be_read_is_recorded_as_an_error(
    command: str, error: str
) -> None:
    result = read_cost({ENV_MEMORY_COST_CMD: command})
    assert set(result) == {"error"}
    assert error in result["error"]


def test_the_cost_of_a_cell_is_what_the_counters_grew_by() -> None:
    before = {"counters": {"input_tokens": 1000, "output_tokens": 200}}
    after = {"counters": {"input_tokens": 1500, "output_tokens": 260, "new": 4}}
    assert cost_delta(before, after) == {
        "counters": {"input_tokens": 500, "output_tokens": 60}
    }


def test_a_counter_that_went_down_is_named_not_guessed() -> None:
    before = {"counters": {"input_tokens": 1000, "output_tokens": 200}}
    after = {"counters": {"input_tokens": 40, "output_tokens": 260}}
    assert cost_delta(before, after) == {
        "counters": {"output_tokens": 60},
        "reset": ["input_tokens"],
    }


@pytest.mark.parametrize(
    "before,after",
    [
        (None, {"counters": {"a": 1}}),
        ({"counters": {"a": 1}}, None),
        ({"error": "exit 1"}, {"counters": {"a": 1}}),
    ],
)
def test_a_missing_read_leaves_the_cost_unknown(before, after) -> None:
    assert cost_delta(before, after) is None
