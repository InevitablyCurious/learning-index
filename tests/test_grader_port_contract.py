"""BENCH_PORT end to end: the harness→grader port-assignability boundary.

The grader derives its OWN serve port inside the container:
``PORT = (BENCH_PORT ?? 8002) + WORKER_INDEX`` (grader/lib/harness.ts:54-55).
Because grading runs under ``--network none``, that port is per-cell-internal
and cannot collide cross-cell. The harness's only lever is the worker-count
knobs (``BENCH_WORKER_TARGET`` / ``BENCH_WORKERS``), which scale the grader's
own worker pool and therefore its WORKER_INDEX offsets.

The contract pinned here: ``gate_argv`` threads the worker-count knobs and
NEVER assigns or forwards a host serve port for grading. A ``-p``/``--publish``
or a ``BENCH_PORT``/``BENCH_SERVE_HOST_PORT`` env threaded by the harness would
mean concurrent cells could collide on a host-assigned grading port — fail
loud, never degrade silently.

Pure argv-construction assertions: no docker, no containers.
"""

from __future__ import annotations

from pathlib import Path

from harness.grader_run import gate_argv


def _contains_pair(argv: list[str], left: str, right: str) -> bool:
    for idx, item in enumerate(argv[:-1]):
        if item == left and argv[idx + 1] == right:
            return True
    return False


def _argv_with_knobs(tmp_path: Path) -> list[str]:
    return gate_argv(
        worktree=tmp_path / "tree",
        report_path=tmp_path / "cell" / "attempt-1-report.json",
        roster_path=None,
        attempt=1,
        worker_target=0.5,
        workers=4,
    )


def test_gate_argv_threads_worker_count_knobs(tmp_path: Path) -> None:
    """The knobs that drive the grader's per-worker port offset ARE threaded.

    WORKER_INDEX (the grader's port offset) spans exactly the worker pool the
    harness sizes, so these two env tokens are the harness's only port-adjacent
    input.
    """
    argv = _argv_with_knobs(tmp_path)

    assert _contains_pair(argv, "-e", "BENCH_WORKER_TARGET=0.5"), (
        "worker_target must reach the grader as -e BENCH_WORKER_TARGET=<n>"
    )
    assert _contains_pair(argv, "-e", "BENCH_WORKERS=4"), (
        "workers must reach the grader as -e BENCH_WORKERS=<n>"
    )


def test_gate_argv_never_threads_a_host_serve_port(tmp_path: Path) -> None:
    """The grader owns its serve port; the harness must never assign one.

    Asserted in the worst case (worker knobs passed): even then, no publish
    flag and no port env may appear anywhere in the argv.
    """
    argv = _argv_with_knobs(tmp_path)

    # No host port publication, in either flag spelling.
    assert "-p" not in argv, "the grader must never publish a host port"
    assert "--publish" not in argv, "the grader must never publish a host port"
    assert not any(a.startswith("-p") for a in argv), (
        "no -p<port> shorthand either: grading is --network none, a published "
        "port would make concurrent cells collide on the host"
    )

    # No port env threaded — neither the grader's own BENCH_PORT nor the
    # per-cell live-view BENCH_SERVE_HOST_PORT (which scopes the CELL's serve,
    # never the grader's). Both the `KEY=VAL` and bare-`KEY` (inherit-from-host)
    # spellings are pinned absent.
    for port_env in ("BENCH_PORT", "BENCH_SERVE_HOST_PORT"):
        assert port_env not in argv, (
            f"-e {port_env} (bare inherit form) must never be threaded into the grader"
        )
        assert not any(a.startswith(f"{port_env}=") for a in argv), (
            f"-e {port_env}=... must never be threaded into the grader: it "
            "derives its serve port itself as (BENCH_PORT ?? 8002) + "
            "WORKER_INDEX inside --network none"
        )
