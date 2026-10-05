"""Host-side commands that ask the memory system about itself, around each ON cell.

A memory system keeps working after a cell ends: Honcho, for one, turns the
cell's messages into memories in a background queue. Two commands from the
operator's environment let the benchmark see that work without knowing which
memory system it is. Both run on the host, through ``sh -c``, with the
operator's environment:

- BENCH_MEMORY_READY_CMD exits 0 once the memory system has finished
  processing what it was given. It is polled before each memory-ON cell, so
  every cell starts from memory that has digested every earlier cell, and
  again after it, so the cell's own processing is counted against it. Waiting
  happens outside the cell's wall time. A memory system that never became
  ready stops the next cell (MemoryNotReady) instead of letting it start
  against half-digested memory.
- BENCH_MEMORY_COST_CMD prints one JSON object of running counters, e.g.
  ``{"input_tokens": 1200, "output_tokens": 300}``. It is read before and
  after each memory-ON cell; the difference is the memory system's own cost
  for that cell (harness/adapters/challenge/memory_record.py).

Unset, neither runs. The settings file (BENCH_MEMORY_ENV) is in the same
environment, so a command can read which space the plugin writes to from it.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from collections.abc import Callable, Mapping
from typing import Any

ENV_MEMORY_READY_CMD = "BENCH_MEMORY_READY_CMD"
ENV_MEMORY_READY_TIMEOUT = "BENCH_MEMORY_READY_TIMEOUT_S"
ENV_MEMORY_COST_CMD = "BENCH_MEMORY_COST_CMD"

#: How long a memory system may take to become ready before the next cell is
#: refused. Background processing on a local model can take minutes.
DEFAULT_READY_TIMEOUT_S = 1800.0
READY_POLL_S = 5.0
#: One poll or one counter read; a command that hangs is a failed poll.
COMMAND_TIMEOUT_S = 60.0

Runner = Callable[..., subprocess.CompletedProcess]


class MemoryNotReady(RuntimeError):
    """The memory system did not finish its background work in time."""


def _env(env: Mapping[str, str] | None) -> Mapping[str, str]:
    return env if env is not None else os.environ


def _run(command: str, run: Runner) -> subprocess.CompletedProcess:
    return run(
        ["sh", "-c", command],
        capture_output=True,
        text=True,
        timeout=COMMAND_TIMEOUT_S,
        check=False,
    )


def _tail(completed: subprocess.CompletedProcess) -> str:
    text = (completed.stderr or completed.stdout or "").strip()
    return text[-300:]


def ready_timeout_s(env: Mapping[str, str] | None = None) -> float:
    raw = _env(env).get(ENV_MEMORY_READY_TIMEOUT, "").strip()
    if not raw:
        return DEFAULT_READY_TIMEOUT_S
    try:
        value = float(raw)
    except ValueError:
        raise ValueError(
            f"{ENV_MEMORY_READY_TIMEOUT}={raw!r} is not a number"
        ) from None
    if value <= 0:
        raise ValueError(f"{ENV_MEMORY_READY_TIMEOUT}={raw!r} must be positive")
    return value


def wait_until_ready(
    env: Mapping[str, str] | None = None,
    *,
    raise_on_timeout: bool = True,
    run: Runner = subprocess.run,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, Any] | None:
    """Poll BENCH_MEMORY_READY_CMD until it exits 0; None when it is unset.

    Returns what the wait was, for the cell's record: ``ready``, ``waited_s``,
    ``polls``, and on a timeout the last thing the command said. Raises
    MemoryNotReady on a timeout unless ``raise_on_timeout`` is False.
    """
    command = _env(env).get(ENV_MEMORY_READY_CMD, "").strip()
    if not command:
        return None
    timeout = ready_timeout_s(env)
    start = clock()
    polls = 0
    while True:
        polls += 1
        try:
            completed = _run(command, run)
            ok, said = completed.returncode == 0, _tail(completed)
        except subprocess.TimeoutExpired:
            ok, said = False, f"no answer in {COMMAND_TIMEOUT_S:.0f}s"
        waited = round(clock() - start, 1)
        if ok:
            return {"ready": True, "waited_s": waited, "polls": polls}
        if waited >= timeout:
            record = {"ready": False, "waited_s": waited, "polls": polls, "last": said}
            if raise_on_timeout:
                raise MemoryNotReady(
                    f"the memory system was not ready after {waited:.0f}s "
                    f"({ENV_MEMORY_READY_CMD}={command!r}; last: {said or 'no output'}). "
                    f"Check it, or raise {ENV_MEMORY_READY_TIMEOUT}."
                )
            return record
        sleep(READY_POLL_S)


def read_cost(
    env: Mapping[str, str] | None = None, *, run: Runner = subprocess.run
) -> dict[str, Any] | None:
    """The memory system's running counters from BENCH_MEMORY_COST_CMD.

    None when the command is unset. A command that fails or prints something
    other than a JSON object of numbers returns ``{"error": ...}``: the cell
    is not stopped for a measurement it could not take, and the record says so.
    """
    command = _env(env).get(ENV_MEMORY_COST_CMD, "").strip()
    if not command:
        return None
    try:
        completed = _run(command, run)
    except subprocess.TimeoutExpired:
        return {"error": f"no answer in {COMMAND_TIMEOUT_S:.0f}s"}
    if completed.returncode != 0:
        return {"error": f"exit {completed.returncode}: {_tail(completed)}"}
    try:
        counters = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return {"error": f"not JSON: {completed.stdout.strip()[:200]!r}"}
    if not isinstance(counters, dict) or not all(
        isinstance(v, (int, float)) and not isinstance(v, bool)
        for v in counters.values()
    ):
        return {"error": "not a JSON object of numbers"}
    return {"counters": counters}


def cost_delta(
    before: Mapping[str, Any] | None, after: Mapping[str, Any] | None
) -> dict[str, Any] | None:
    """What the counters grew by over the cell; None when either read is missing.

    A counter that went down means the memory system restarted mid-cell, so
    its growth is unknown: it is left out and named under ``reset``.
    """
    if not before or not after or "counters" not in before or "counters" not in after:
        return None
    grew: dict[str, float] = {}
    reset: list[str] = []
    for name, value in after["counters"].items():
        if name not in before["counters"]:
            continue
        diff = value - before["counters"][name]
        if diff < 0:
            reset.append(name)
        else:
            grew[name] = diff
    result: dict[str, Any] = {"counters": grew}
    if reset:
        result["reset"] = sorted(reset)
    return result
