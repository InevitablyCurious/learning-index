"""Notices: the record on which a PROCESS reports about itself.

Two writers, one envelope. ``LiveStream.notice`` is cell-scoped and lands in that
cell's ``live.jsonl``; ``run_notice`` is run-scoped, for harness work that spans
cells, and lands in the same file the control plane writes. Both exist because
every other core kind marks a step of the RUN, and nothing carried what the
machinery had to say about itself.
"""

from __future__ import annotations

import json
from pathlib import Path

from harness.live_stream import (
    CORE_KINDS,
    ENV_NOTICES,
    NOTICE_LEVELS,
    NOTICE_SOURCES,
    LiveStream,
    run_notice,
)


def _records(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def test_notice_is_a_core_kind() -> None:
    assert "notice" in CORE_KINDS


def test_external_services_are_never_notice_sources() -> None:
    """A source is WHO IS SPEAKING, not who the notice is about.

    The relay serves monotonic counters over HTTP and announces nothing, so it
    can never be the speaker. Its observations are reported by their observer,
    under ``control``. A row in a silent service's voice is fabrication however
    accurate its number is, and this is what stops the convenient chip being
    added later.
    """
    for outside in ("relay", "proxy", "opencode", "okp", "hub", "mcp"):
        assert outside not in NOTICE_SOURCES


def test_cell_notice_carries_both_axes_and_drops_a_null_detail(tmp_path: Path) -> None:
    stream = tmp_path / "live.jsonl"
    live = LiveStream(stream, run_id="r1")

    live.notice("gates", "worker_died_mid_file", level="error", detail={"measured": 3})
    live.notice("harness", "phase_opened")

    died, opened = _records(stream)
    assert (died["kind"], died["source"], died["event"], died["level"]) == (
        "notice",
        "gates",
        "worker_died_mid_file",
        "error",
    )
    assert died["detail"] == {"measured": 3}
    assert died["run_id"] == "r1"

    # `info` is the default, and it is STATED rather than guessed from the event
    # name -- otherwise renaming an event would silently change its severity.
    assert opened["level"] == "info"
    # A null on the wire cannot be told apart from "this producer does not set
    # that field". Absence is a state on every stream here.
    assert "detail" not in opened


def test_every_declared_source_and_level_round_trips(tmp_path: Path) -> None:
    stream = tmp_path / "live.jsonl"
    live = LiveStream(stream)
    for source in NOTICE_SOURCES:
        for level in NOTICE_LEVELS:
            live.notice(source, "probe", level=level)

    seen = _records(stream)
    assert len(seen) == len(NOTICE_SOURCES) * len(NOTICE_LEVELS)
    assert {r["source"] for r in seen} == set(NOTICE_SOURCES)
    assert {r["level"] for r in seen} == set(NOTICE_LEVELS)


def test_an_unwritable_stream_costs_a_row_and_never_the_run(tmp_path: Path) -> None:
    """Telemetry about a failure must not become a second failure.

    These calls sit on the cell's hot path -- inside the transport-recovery
    branch that decides whether to re-drive a turn -- where raising would turn a
    missing feed row into a failed measurement.
    """
    # A missing parent is created on demand, so that would not fail. Force a
    # genuine one: a path whose own parent is a FILE, which can never be made
    # into a directory.
    blocker = tmp_path / "blocker"
    blocker.write_text("not a directory", encoding="utf-8")
    live = LiveStream(blocker / "live.jsonl")
    assert live.notice("harness", "turn_truncated_retried", level="warn") is False


def test_run_notice_needs_the_seam_and_is_silent_without_it(tmp_path: Path) -> None:
    """Unset means no telemetry is wanted -- carry on, do not error.

    A CLI-launched harness has no control plane to export the seam and must run
    identically without one.
    """
    assert run_notice("sequencer", "scorecard_missing", env={}) is False


def test_run_notice_writes_the_same_envelope_as_the_cell_stream(tmp_path: Path) -> None:
    """The run-scoped and cell-scoped writers agree on shape.

    They land in different files because their facts have different lifetimes,
    but a reader must not need to know which writer produced a line in order to
    read it.
    """
    target = tmp_path / "cell.log.notices.jsonl"
    env = {ENV_NOTICES: str(target)}

    assert run_notice(
        "sequencer",
        "scorecard_missing",
        level="error",
        detail={"fell_back_to": "mutable_manifest", "void_gate_applied": False},
        env=env,
    )

    (rec,) = _records(target)
    assert rec["kind"] == "notice"
    assert rec["v"] == 1
    assert rec["source"] == "sequencer"
    assert rec["level"] == "error"
    # THE FACT THAT MATTERS: the standings came from the path that cannot void
    # anything, so a truncated cell counts as a data point there.
    assert rec["detail"]["void_gate_applied"] is False


def test_run_notice_resolves_the_seam_per_call(tmp_path: Path) -> None:
    """Never cached: the harness is long-lived across a campaign, and a cached
    absent path would keep a whole run silent after a late export."""
    target = tmp_path / "late.notices.jsonl"
    assert run_notice("harness", "early", env={}) is False
    assert run_notice("harness", "late", env={ENV_NOTICES: str(target)}) is True
    assert [r["event"] for r in _records(target)] == ["late"]
