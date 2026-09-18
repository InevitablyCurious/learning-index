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
    assert "after the last change" in detail


def test_a_control_plane_older_than_the_source_is_stale_and_names_the_fix() -> None:
    """THE EXACT SHAPE OF THE COMPACTION LAUNCH: source edited at 21:55, process
    up since 11:27, run at 22:48."""
    ok, detail = _preflight().control_plane_freshness_verdict(
        started_at=_iso(-3600),
        newest_mtime=dt.datetime.now(dt.timezone.utc).timestamp(),
        newest_path="control/server.mjs",
    )
    assert ok is False
    assert "control/server.mjs changed" in detail
    assert "Refresh control plane" in detail, "a failure must name its button"


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
    assert "needs a refresh" in detail
    assert "Refresh control plane" in detail


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


# ── the board ────────────────────────────────────────────────────────────────


def _board_dir(tmp_path: Path) -> Path:
    (tmp_path / "panels").mkdir()
    (tmp_path / "server.mjs").write_text("server")
    (tmp_path / "panels" / "tools.js").write_text("tools")
    return tmp_path


def _sha(text: str) -> str:
    import hashlib

    return hashlib.sha256(text.encode()).hexdigest()


def test_a_board_serving_the_files_on_disk_is_fresh(tmp_path: Path) -> None:
    served = {"server.mjs": _sha("server"), "panels/tools.js": _sha("tools")}
    ok, detail = _preflight().board_freshness_verdict(served, _board_dir(tmp_path))
    assert ok is True, detail


def test_a_board_behind_the_disk_names_the_file_and_the_button(tmp_path: Path) -> None:
    served = {"server.mjs": _sha("server"), "panels/tools.js": _sha("old tools")}
    ok, detail = _preflight().board_freshness_verdict(served, _board_dir(tmp_path))
    assert ok is False
    assert "dashboard/panels/tools.js" in detail
    assert "Refresh board" in detail


def test_a_board_that_reports_no_files_predates_the_report(tmp_path: Path) -> None:
    ok, detail = _preflight().board_freshness_verdict(None, _board_dir(tmp_path))
    assert ok is False
    assert "Refresh board" in detail


def test_the_board_actually_serves_its_file_report() -> None:
    src = (REPO / "dashboard" / "server.mjs").read_text(encoding="utf-8")
    assert "started_at: STARTED_AT, files: FILES" in src
