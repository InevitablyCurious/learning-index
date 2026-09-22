"""Reaper port scoping: `_discover_bench_ports()` must resolve the ALLOCATED port.

`main()` (the canonical production entry) calls `resolve_serve_host_port()` at
process entry, BEFORE `_discover_bench_ports()` feeds the reaper. With N
concurrent cells (separate processes) each cell allocates its own free port, so
the reaper asserts THAT port — never a fixed 8719 shared by every cell. A
pinned BENCH_SERVE_HOST_PORT is honored exactly.

Pure tests: no docker, no serve, no network beyond the OS port allocation.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import run_cumulative  # noqa: E402
from harness.free_port import resolve_serve_host_port  # noqa: E402

DEFAULT_SERVE_PORT = 8719


def test_discover_bench_ports_returns_the_allocated_port_when_unpinned(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("BENCH_SERVE_HOST_PORT", raising=False)
    allocated = resolve_serve_host_port()
    assert run_cumulative._discover_bench_ports() == [
        int(os.environ["BENCH_SERVE_HOST_PORT"])
    ]
    assert allocated != DEFAULT_SERVE_PORT


def test_discover_bench_ports_honors_a_pinned_port(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BENCH_SERVE_HOST_PORT", "18433")
    assert run_cumulative._discover_bench_ports() == [18433]


def test_discover_bench_ports_allocates_on_zero_sentinel(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BENCH_SERVE_HOST_PORT", "0")
    resolve_serve_host_port()
    resolved = int(os.environ["BENCH_SERVE_HOST_PORT"])
    assert run_cumulative._discover_bench_ports() == [resolved]
    assert resolved != DEFAULT_SERVE_PORT
