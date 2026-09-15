"""The control plane must not be able to run a benchmark with stale code.

MEASURED FAILURE (2026-09-02). Chunk-boundary compaction shipped, the operator
launched from the board, and no cell compacted. The flag was present in
`control/server.mjs`, absent from the argv the RUNNING control plane built, and
nothing said so: `make control-start` is a deliberate no-op when :8718 is
already listening, so `make up` never restarts it and the process had been up
since before the edit. The run completed looking entirely normal and measured
something other than what was configured.

This is the same class of defect as a stale worker image — code that is on disk
but not in the process — and it gets the same instrument: compare what is
running against what is on disk, and refuse rather than proceed.
"""

from __future__ import annotations

import datetime as dt
import importlib.util
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]


def _preflight():
    spec = importlib.util.spec_from_file_location(
        "bench_preflight", REPO / "scripts" / "bench_preflight.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _iso(offset_s: float) -> str:
    return (
        dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=offset_s)
    ).isoformat().replace("+00:00", "Z")


def test_a_control_plane_started_after_the_source_is_fresh() -> None:
    verdict = _preflight().control_plane_freshness_verdict(
        started_at=_iso(0),
        newest_mtime=(dt.datetime.now(dt.timezone.utc).timestamp() - 3600),
        newest_path="control/server.mjs",
    )
    ok, detail = verdict
    assert ok is True
    assert "no restart needed" in detail


def test_a_control_plane_older_than_the_source_is_stale_and_names_the_fix() -> None:
    """THE EXACT SHAPE OF THE COMPACTION LAUNCH: source edited at 21:55, process
    up since 11:27, run at 22:48."""
    ok, detail = _preflight().control_plane_freshness_verdict(
        started_at=_iso(-3600),
        newest_mtime=dt.datetime.now(dt.timezone.utc).timestamp(),
        newest_path="control/server.mjs",
    )
    assert ok is False
    assert "control/server.mjs is NEWER" in detail
    assert "restart the control plane" in detail, "a failure must name its remedy"


def test_a_control_plane_with_no_started_at_is_stale_by_definition() -> None:
    """It cannot be newer than the source that introduced the field it lacks.

    This is the case that actually fired when the check was first run: the
    process answered /api/health but predated the freshness field entirely.
    """
    ok, detail = _preflight().control_plane_freshness_verdict(
        started_at="",
        newest_mtime=0.0,
        newest_path="control/server.mjs",
    )
    assert ok is False
    assert "DEFINITELY stale" in detail
    assert "restart the control plane" in detail


def test_the_check_is_blocking() -> None:
    """Fail loud and abort. A run launched from a process that is not this code
    is a quietly-different experiment, which is the one thing the bench refuses
    to produce — so this stops the launch rather than warning past it."""
    module = _preflight()
    check = module.Check()
    module.control_plane_freshness_verdict  # present
    check.add("control plane", False, "stale")
    assert check.blocking_failures, "a stale control plane must block the launch"


def test_the_control_plane_actually_serves_started_at() -> None:
    """The check reads a field the server must publish; pin both ends.

    Since LI-14 phase 2 the /api/health handler — and the PROCESS_STARTED_AT
    stamp it serves — live in control/routes/meta.mjs, which the entrypoint
    parses at startup, so the stamp is still taken at process load.
    """
    src = (REPO / "control" / "routes" / "meta.mjs").read_text(encoding="utf-8")
    assert "const PROCESS_STARTED_AT = new Date().toISOString();" in src
    assert "started_at: PROCESS_STARTED_AT," in src
