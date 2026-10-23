"""Slow integration proof for ``harness.play_container`` against real Docker.

WHY THIS FILE EXISTS
--------------------
``tests/test_play_container.py`` proves the module's *argv*: the tokens it would
hand to ``docker run``. That is the shape of the recipe, not the behaviour of it.
Every claim the module makes lives in Docker's interpretation of those tokens:

* the forwarder is dual-homed, so ``-p`` on an ``--internal``-only container
  (which Docker silently drops) actually publishes ``127.0.0.1:<port>:8002``;
* the ``--internal`` network means the candidate has no route to the host or the
  internet — a claim only a real connection attempt from inside the container
  can settle;
* ``--read-only`` with the worktree mounted ``:ro`` and a writable ``/tmp``
  tmpfs means the candidate can build a fresh copy under ``/tmp/app`` but cannot
  write back into ``/candidate``;
* ``stop()`` re-checks by exact name, so "nothing left behind" is two empty
  ``docker ps`` results and a network that no longer inspects.

This test boots the GOLDEN candidate — the known-good artifact, so a failure
here is the harness's, never a model's — and asserts each of those facts from
inside the running containers.

Run it explicitly (``slow`` is deselected by the default addopts, and the fixed
host port band is why it must not share a process pool with other docker tests):

    .venv/bin/python -m pytest -q -n 0 -m slow tests/test_play_container_integration.py
"""

from __future__ import annotations

import os
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

import pytest

from harness.adapters.docker_worker import docker_available
from harness.grader_image import IMAGE, image_digest
from harness.play_container import start, stop

GOLDEN = Path(__file__).resolve().parents[1] / "task" / "backgammon" / "golden"

_DOCKER_OK, _DOCKER_DETAIL = docker_available()
REQUIRES_DOCKER = pytest.mark.skipif(
    not _DOCKER_OK,
    reason=f"docker unavailable: {_DOCKER_DETAIL}",
)

#: Generous: the candidate copies its tree and boots TypeScript inside the
#: container, which is 1-3s on an idle machine but not on a loaded one.
BOOT_DEADLINE_S = 15.0

#: Per-connection probe budget. Long enough for an internal-network blackhole to
#: distinguish "refused/failed" from "silently dropped", short enough that three
#: probes do not dominate the test.
CONNECT_PROBE_TIMEOUT_MS = 1500

#: Exit 1 on CONNECTED, 0 on BLOCKED — so a bare returncode check alone already
#: fails a candidate that reached the network. Args are ``<port> <host>``, in
#: ``net.connect``'s own order.
CONNECT_PROBE_SCRIPT = (
    "const net=require('node:net');"
    "const s=net.connect(Number(process.argv[1]),process.argv[2]);"
    "const done=(msg,code)=>{console.log(msg);process.exit(code);};"
    "s.on('connect',()=>done('CONNECTED',1));"
    "s.on('error',()=>done('BLOCKED',0));"
    "setTimeout(()=>done('BLOCKED',0)," + str(CONNECT_PROBE_TIMEOUT_MS) + ");"
)


def _docker(*args: str) -> subprocess.CompletedProcess[str]:
    """Bare ``docker`` with no environment overrides — the operator's own CLI."""
    return subprocess.run(
        ["docker", *args],
        capture_output=True,
        text=True,
        check=False,
    )


def _require_grader_image() -> None:
    # Skip, as REQUIRES_DOCKER does: CI has docker but never builds the grader
    # image, and a fresh clone has not built it yet. The reason names the fix in
    # the -ra summary; play_container.start refuses without the image anyway.
    if image_digest(IMAGE) is None:
        pytest.skip(
            f"grader image {IMAGE} not built or built unsanctioned. Build with: "
            ".venv/bin/python scripts/rebuild_grader_image.py"
        )


def _wait_for_http(host_port: int, path: str, candidate: str) -> int:
    """Poll ``127.0.0.1:<host_port><path>`` until it answers, or fail loudly.

    TCP first, then HTTP: a forwarder that accepts and then answers nothing is a
    different defect from a port that was never published, and the timeout
    message has to say which one happened.
    """
    url = f"http://127.0.0.1:{host_port}{path}"
    deadline = time.monotonic() + BOOT_DEADLINE_S
    last = "no attempt completed"
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", host_port), timeout=2.0):
                pass
            with urllib.request.urlopen(url, timeout=3.0) as response:
                return int(response.status)
        except OSError as exc:
            last = f"{type(exc).__name__}: {exc}"
            time.sleep(0.5)
    logs = _docker("logs", "--tail", "40", candidate)
    raise AssertionError(
        f"{url} did not answer within {BOOT_DEADLINE_S}s ({last}). "
        f"candidate logs: {(logs.stdout or '') + (logs.stderr or '')!r}"
    )


def _exec(candidate: str, *argv: str) -> subprocess.CompletedProcess[str]:
    return _docker("exec", candidate, *argv)


def _assert_blocked(candidate: str, host: str, port: int) -> None:
    result = _exec(candidate, "node", "-e", CONNECT_PROBE_SCRIPT, str(port), host)
    assert result.returncode == 0, (
        f"candidate reached {host}:{port} from inside the play container — "
        f"stdout={result.stdout!r} stderr={result.stderr!r}"
    )
    assert "BLOCKED" in result.stdout, (
        f"expected BLOCKED from the {host}:{port} probe, got {result.stdout!r} "
        f"(stderr={result.stderr!r})"
    )


def _assert_stop_left_nothing(stopped: dict) -> None:
    assert stopped["ok"] is True, stopped
    assert stopped["lingering"] == [], stopped
    for key in ("candidate", "forwarder"):
        listed = _docker(
            "ps",
            "-a",
            "--filter",
            f"name=^{stopped[key]}$",
            "--format",
            "{{.Names}}",
        )
        assert listed.returncode == 0, (
            f"docker ps failed for {stopped[key]}: {listed.stderr!r}"
        )
        assert listed.stdout.strip() == "", (
            f"{key} container {stopped[key]} survived stop(): {listed.stdout!r}"
        )
    network = _docker("network", "inspect", stopped["network"])
    assert network.returncode != 0, (
        f"network {stopped['network']} survived stop(): {network.stdout!r}"
    )


@pytest.mark.slow
@REQUIRES_DOCKER
@pytest.mark.timeout(300)
def test_golden_boots_isolated_and_stops_clean() -> None:
    """The whole play-time contract, asserted against the running containers."""
    _require_grader_image()

    name = f"itest-{os.getpid()}-{int(time.time())}"

    try:
        started = start(
            name=name,
            worktree=str(GOLDEN),
            owner="control",
            cell="itest-cell",
        )

        # ── 1. start() publishes a loopback URL ─────────────────────────────
        assert started["ok"] is True, started
        assert isinstance(started["host_port"], int), started
        assert started["url"].startswith("http://localhost:"), started
        candidate = started["candidate"]
        host_port = started["host_port"]

        # ── 2. the forwarder really publishes it, and the candidate answers ─
        assert _wait_for_http(host_port, "/health", candidate) == 200
        assert _wait_for_http(host_port, "/", candidate) == 200

        # ── 3a. no host gateway, no internet, from INSIDE the candidate ─────
        for host, port in (
            ("host.docker.internal", 8718),
            ("host.docker.internal", 4545),
            ("1.1.1.1", 443),
        ):
            _assert_blocked(candidate, host, port)

        # ── 3b. no host filesystem ─────────────────────────────────────────
        host_key = _exec(
            candidate,
            "sh",
            "-c",
            "test -e /Users/jerrysmith/.ssh/id_ed25519 && echo PRESENT || echo ABSENT",
        )
        assert "ABSENT" in host_key.stdout, host_key.stdout
        assert "PRESENT" not in host_key.stdout, host_key.stdout

        home = _exec(candidate, "sh", "-c", "ls /home")
        assert "jerrysmith" not in home.stdout, home.stdout

        # ── 3c. the /tmp/app copy is the candidate's writable tree ─────────
        probe = _exec(
            candidate,
            "sh",
            "-c",
            "echo ok > /tmp/app/write-probe && cat /tmp/app/write-probe",
        )
        assert probe.returncode == 0, (
            f"/tmp/app is not writable: {probe.stdout!r} {probe.stderr!r}"
        )
        assert "ok" in probe.stdout, probe.stdout

        # ── 3d. the /candidate mount is read-only ──────────────────────────
        read_only = _exec(candidate, "sh", "-c", "echo x > /candidate/write-probe")
        assert read_only.returncode != 0, (
            "/candidate accepted a write — the worktree mount is not read-only: "
            f"stdout={read_only.stdout!r} stderr={read_only.stderr!r}"
        )
    finally:
        # Runs on a failed start() and on any assertion: `stop` recomputes every
        # name from the identity string alone, so a half-created session still
        # gets torn down rather than leaking a network.
        _assert_stop_left_nothing(stop(name))
