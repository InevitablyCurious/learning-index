"""The v2 cost record's WIRE contract: identity, measured wall, price, nulls.

WHY A THIRD COST FILE. ``test_cost_record.py`` follows a cell through the
writer's endings (the artifact always lands, absent never becomes zero) and
``test_cost_labels.py`` pins the derivation's phase arithmetic (labels decide,
build + troubleshooting recombine into the roll-ups). Both predate SCHEMA 2 and
say nothing about the fields v2 added: ``schema_version``, ``system_epoch``,
``price`` / ``cost_usd``, and the twice-measured wall. A ledger consumer reads
those, so each invariant gets its own test here rather than a wider assertion in
a file about something else.

THE ONE AXIS. ``measured_wall_seconds`` is the clock MINUS operator pauses, and
the compaction positions are offsets on THAT axis, not on the raw clock. A
position that kept the pause would point at a different moment than the phase
walls it is plotted beside, so :func:`test_compaction_positions_on_measured_axis`
measures a cell with a known 10s hold: a raw offset would read 29.0s and the
contract is 19.0s.

NULL IS NOT ZERO. A local model has no dollars and an unrecorded field has no
value; both are ``None``. ``0`` would read as "priced at nothing" / "measured as
nothing" in every aggregate, which is a measurement nobody took.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from tests import cost_fixture

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))
from run_cumulative import runner as runner_mod
from run_cumulative.cost_from_disk import derive_cost_from_disk, derive_cost_meta

#: The local bench model the harness serves through the proxy. Its cost is real
#: but it is not dollars, so its price row is ``None``.
LOCAL_MODEL = "local-llm-proxy/qwen3.6-35b-a3b-bench"
#: Phase 4 of the real plan — the first layer. The index is the label's.
LAYER_INDEX = 4
LAYER_PHASE = "Layer 1 — board and controls"


def test_compaction_positions_on_measured_axis(tmp_path: Path) -> None:
    """A compaction lands inside its phase ON THE PAUSE-EXCLUDED AXIS.

    The stream holds one 10s pause (3000 → 13000) and the compaction happens at
    30000, i.e. 29s after ``cell.start`` on the raw clock. On the measured axis
    that is 19s — the hold is time the cell did not spend working, so subtracting
    it is what lets a position be compared with the phase walls, which are net of
    the same holds. The record also carries the cell's identity and both walls,
    because a reader needs them to know WHICH instrument and model produced it.
    """
    run_dir = tmp_path / "cell-0000"
    run_dir.mkdir()
    cost_fixture.write_live(
        run_dir,
        [
            {"v": 1, "ts": 1_000, "kind": "cell.start", "model": LOCAL_MODEL},
            {
                "v": 1,
                "ts": 2_000,
                "kind": "phase.start",
                "phase_index": LAYER_INDEX,
                "phase_name": LAYER_PHASE,
                "phase_kind": "build",
                "phase_layer": 1,
            },
            {"v": 1, "ts": 3_000, "kind": "pause.start"},
            {"v": 1, "ts": 13_000, "kind": "pause.end"},
            {
                "v": 1,
                "ts": 30_000,
                "kind": "compaction",
                "phase_index": LAYER_INDEX,
                "phase_name": LAYER_PHASE,
                "phase_kind": "build",
            },
            {
                "v": 1,
                "ts": 160_000,
                "kind": "cell.end",
                "terminal_reason": "stopped",
            },
        ],
    )

    meta = derive_cost_meta(run_dir)
    assert meta["compactions"]["count"] == 1
    (position,) = meta["compactions"]["positions"]
    assert position["phase_index"] == LAYER_INDEX
    assert position["phase_kind"] == "build"
    assert position["ts"] == 30_000
    # (30000 - 1000 - 10000) / 1000: the 10s hold is removed from the axis.
    assert position["measured_offset_s"] == 19.0

    # The clock ran 159s; the cell worked 149s of it.
    assert meta["cell_wall_seconds"] == 159.0
    assert meta["measured_wall_seconds"] == 149.0

    # Identity is read off the record that published it, never inferred.
    assert meta["model"] == LOCAL_MODEL
    assert meta["provider"] == "local-llm-proxy"
    assert meta["terminal_reason"] == "stopped"


def test_price_null_for_local_model(tmp_path: Path) -> None:
    """A local model's price is ``None``, and the v2 record says so at the top.

    ``_price_for`` is the only place a price row is attached. A local model is
    served on this machine: its cost is real but it is not dollars, so a zeroed
    row would claim a measured price of nothing. The remote table is honoured
    unchanged — that row is asserted too, so "always None" cannot pass this.
    """
    assert runner_mod._price_for(LOCAL_MODEL) is None
    assert runner_mod._price_for(None) is None
    assert runner_mod._price_for("z-ai/glm-5.2") == {
        "input": 1.4,
        "output": 4.4,
        "cache_read": 0.26,
        "cache_write": 1.4,
    }

    run_dir = tmp_path / "cell-0000"
    run_dir.mkdir()
    cost_fixture.write_live(
        run_dir,
        [
            {"v": 1, "ts": 1_000, "kind": "cell.start", "model": LOCAL_MODEL},
            {
                "v": 1,
                "ts": 61_000,
                "kind": "cell.end",
                "terminal_reason": "gates_green",
            },
        ],
    )
    record = runner_mod._cost_record(
        outcome="passed", run_dir=run_dir, void={"is_void": False, "reason": None}
    )
    assert record["price"] is None
    assert record["cost_usd"] is None
    assert record["schema_version"] == 2
    assert record["system_epoch"] == "2026-11-08"
    assert record["provider"] == "local-llm-proxy"


def test_a_v2_record_always_carries_all_fourteen_keys(tmp_path: Path) -> None:
    """The v2 shape is FIXED: every key is present even when its value is null.

    A missing key means "not observed" to one reader and "this schema has no such
    field" to another; the schema version is what tells them apart, so a v2
    record states its nulls instead of relying on absence.
    """
    run_dir = tmp_path / "cell-0000"
    run_dir.mkdir()
    record = runner_mod._cost_record(
        outcome="crashed", run_dir=run_dir, void={"is_void": True, "reason": "crashed"}
    )
    assert set(record) == {
        "schema_version",
        "system_epoch",
        "model",
        "provider",
        "outcome",
        "terminal_reason",
        "void",
        "cell_wall_seconds",
        "measured_wall_seconds",
        "paused_seconds",
        "price",
        "cost_usd",
        "phases",
        "compactions",
    }


def test_unknown_values_are_null_not_zero(tmp_path: Path) -> None:
    """A field the stream never recorded is ``None``; only a count is really 0.

    Empty cell dir: no model, provider, terminal reason, wall or pause was
    observed, and a local cell has no dollars. Each of those is ``None`` — a
    ``0`` would be indistinguishable from "measured as zero" in every aggregate.
    ``compactions.count`` is the one genuine zero: no compaction record exists.
    """
    run_dir = tmp_path / "cell-0000"
    run_dir.mkdir()

    record = runner_mod._cost_record(
        outcome="crashed", run_dir=run_dir, void={"is_void": True, "reason": "crashed"}
    )
    assert record["model"] is None
    assert record["provider"] is None
    assert record["terminal_reason"] is None
    assert record["cell_wall_seconds"] is None
    assert record["measured_wall_seconds"] is None
    assert record["paused_seconds"] is None
    assert record["price"] is None
    assert record["cost_usd"] is None
    assert record["phases"] == {}
    assert record["compactions"] == {"count": 0, "positions": []}


def test_cost_meta_without_compaction_event_still_parses(tmp_path: Path) -> None:
    """A stream with no ``compaction`` record parses: the writer never needs one.

    The event was added with the v2 record, and the stream is appended while a
    cell runs, so an existing ``live.jsonl`` may simply contain none — a cell
    that never compacted, or a tail cut before the first one. Neither reader may
    depend on the event: both must produce their full shape, with the compaction
    list empty and the phases still derived.
    """
    run_dir = tmp_path / "cell-0000"
    run_dir.mkdir()
    cost_fixture.write_live(
        run_dir,
        [
            {"v": 1, "ts": 1_000, "kind": "cell.start", "model": LOCAL_MODEL},
            {
                "v": 1,
                "ts": 2_000,
                "kind": "phase.start",
                "phase_index": LAYER_INDEX,
                "phase_name": LAYER_PHASE,
                "phase_kind": "build",
                "phase_layer": 1,
            },
            {
                "v": 1,
                "ts": 20_000,
                "kind": "attempt.end",
                "attempt": 1,
                "phase_index": LAYER_INDEX,
                "phase_name": LAYER_PHASE,
                "phase_kind": "build",
                "phase_layer": 1,
            },
            {
                "v": 1,
                "ts": 160_000,
                "kind": "cell.end",
                "terminal_reason": "stopped",
            },
        ],
    )

    meta = derive_cost_meta(run_dir)
    assert meta["compactions"] == {"count": 0, "positions": []}
    # The rest of the record is unaffected: identity and walls still resolve.
    assert meta["model"] == LOCAL_MODEL
    assert meta["cell_wall_seconds"] == 159.0

    derived = derive_cost_from_disk(run_dir)
    phases: dict[str, Any] = derived["phases"]
    assert str(LAYER_INDEX) in phases["by_phase"]
    # No session DB and no grade, so wall is the only thing observed — the
    # phase's two spans fold into its build, net of the (empty) pause booking.
    assert phases["by_phase"][str(LAYER_INDEX)]["build"]["wall_seconds"] == 158.0
