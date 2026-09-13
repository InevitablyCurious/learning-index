"""Supervised-shell: a backgrounded child must NOT outlive the command.

THE MEASURED DEFECT. opencode's bash tool runs ``shell -c "<command>"`` and
waits for EOF on the stdout pipe. A command that backgrounds a child
(``node … &``) leaves that child holding the pipe open after the command
exits, so EOF never arrives and the turn stalls until the ~600s watchdog
aborts it. ``docker/worker/supervised-shell.js`` is the fix: it runs the
command in its own process group (detached spawn → setsid) and SIGKILLs the
ENTIRE group when the command exits — on NORMAL exit as well as on timeout.

These tests spawn the wrapper as a real subprocess (via ``node``, matching
``bench/adapters/docker_worker.py``'s sidecar invocation) and assert the
observable contract: pass-through output/exit codes, the group reap on
normal exit (the essential fix — ``subprocess.run`` itself only returns once
the orphan releases the pipe), and the 124 + marker-file timeout path. They
clean up after themselves: no orphan is left on the test host.
"""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

#: The real wrapper, not a fixture — these tests exercise the shipped file.
WRAPPER = (
    Path(__file__).resolve().parent.parent / "docker" / "worker" / "supervised-shell.js"
)


def _run(
    args: list[str], *, timeout: float = 15, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    """Run the wrapper as a real subprocess: ``node supervised-shell.js <args>``."""
    environ = os.environ.copy()
    if env:
        environ.update(env)
    return subprocess.run(
        ["node", str(WRAPPER), *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        env=environ,
    )


def test_passthrough_output_and_exit_zero() -> None:
    """A plain command's stdout passes through byte-transparently; exit 0."""
    result = _run(["-c", "echo hello"])
    assert result.returncode == 0
    assert result.stdout.strip() == "hello"


def test_passthrough_nonzero_exit() -> None:
    """The command's exit code is mirrored, not swallowed."""
    result = _run(["-c", "exit 7"])
    assert result.returncode == 7


def test_background_child_is_reaped_on_normal_exit() -> None:
    """THE ESSENTIAL FIX: a backgrounded child dies with the foreground command.

    ``sleep 60 &`` inherits the stdout pipe; without the group reap, this
    ``subprocess.run`` could not even return within its timeout (no EOF while
    the orphan holds the pipe) — the exact production stall. After the wrapper
    exits 0, the reported child PID must be GONE.
    """
    result = _run(["-c", 'sleep 60 & echo "child=$!"; echo done'])
    assert result.returncode == 0
    assert "done" in result.stdout

    pid: int | None = None
    for line in result.stdout.splitlines():
        if line.startswith("child="):
            pid = int(line.split("=", 1)[1])
    assert pid is not None, f"no child=<pid> line in stdout: {result.stdout!r}"

    try:
        deadline = time.monotonic() + 5.0
        while True:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return  # gone — the group was reaped on normal exit
            except PermissionError:
                pass  # exists but not ours to signal — treat as still alive
            if time.monotonic() >= deadline:
                raise AssertionError(
                    f"background child {pid} still alive 5s after the wrapper "
                    "exited — the process group was NOT reaped on normal exit"
                )
            time.sleep(0.1)
    finally:
        # Safety net for the failure path: never leave an orphan on the host.
        try:
            os.kill(pid, 9)
        except (ProcessLookupError, PermissionError):
            pass


def test_timeout_kills_hanging_command_and_writes_marker(tmp_path: Path) -> None:
    """Timeout path: exit 124, group killed, ONE forensic marker written.

    The wrapper cuts at 2s (BENCH_TOOL_TIMEOUT_S); subprocess.run's 30s
    ceiling is only a safety net well above it — and returning at all proves
    the hanging ``sleep 120`` released the stdout pipe (was killed).
    """
    marker_dir = tmp_path / "markers"
    result = _run(
        ["-c", "sleep 120"],
        timeout=30,
        env={
            "BENCH_TOOL_TIMEOUT_S": "2",
            "BENCH_TOOL_TIMEOUT_MARKER_DIR": str(marker_dir),
        },
    )
    assert result.returncode == 124

    markers = sorted(marker_dir.glob("timeout-*"))
    assert len(markers) == 1, f"expected exactly one marker file, got {markers}"
    content = markers[0].read_text(encoding="utf-8")
    assert content[:1].isdigit(), f"marker must start with unix seconds: {content!r}"
    assert "sleep 120" in content, f"marker must name the command: {content!r}"
