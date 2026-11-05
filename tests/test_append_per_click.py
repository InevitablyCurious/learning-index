"""Append-per-click: ONE click appends ONE cell to the campaign log.

A run's identity is its cell — arm, model, provider pin — not a position in a
schedule someone planned before the work existed. So nothing here counts
rounds: N cells of one configuration is N clicks, and an ON cell is ONE
measurement per trigger.

The append ordinal (``sequence_index``) is the log's length, which makes it
contiguous and 0-based for free — the invariant every cell address depends on
(``cell-<seq4>`` directories, the status stream, the results ledger). What this
file used to assert — OFF replicates planned contiguously per roster entry, an
ON budget pre-allocated as N slots — no longer describes anything: there is no
plan to have a shape.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from harness.cumulative.ordering import append_session
from harness.cumulative.sequencer import CumulativeSequencer
from harness.cumulative.types import RosterEntry


def roster(*models: str) -> list[RosterEntry]:
    return [
        RosterEntry(model=m, role="candidate", provider_pin=m.split("/")[0])
        for m in models
    ]


def test_each_append_takes_the_next_ordinal() -> None:
    entries = roster("p/a")
    log = []
    for expected in range(4):
        appended = append_session(entries, existing=log, memory_mode="off")
        assert appended.sequence_index == expected
        log.append(appended)

    # Contiguous and 0-based by construction, not by arithmetic.
    assert [s.sequence_index for s in log] == [0, 1, 2, 3]


def test_the_model_and_pin_come_from_the_roster_entry() -> None:
    entries = [
        RosterEntry(model="p/a", role="candidate", provider_pin="pinned-provider")
    ]

    appended = append_session(entries, existing=[], memory_mode="on")

    assert (appended.model, appended.provider_pin) == ("p/a", "pinned-provider")
    assert appended.roster_index == 0


def test_the_arm_is_the_callers_choice_at_click_time() -> None:
    off = append_session(roster("p/a"), existing=[], memory_mode="off")
    on = append_session(roster("p/a"), existing=[], memory_mode="on")

    assert (off.memory_mode, off.phase_group) == ("off", "off_baseline")
    assert (on.memory_mode, on.phase_group) == ("on", "on")
    # Nothing about the OFF cell constrains where an ON cell may go.
    both = append_session(roster("p/a"), existing=[off], memory_mode="on")
    assert both.sequence_index == 1


@pytest.mark.parametrize("bad", ["", "rounds", None, "both"])
def test_an_arm_that_is_not_off_or_on_fails_loudly(bad: Any) -> None:
    with pytest.raises(ValueError, match="memory_mode must be one of"):
        append_session(roster("p/a"), existing=[], memory_mode=bad)


def test_an_empty_roster_fails_loudly() -> None:
    with pytest.raises(ValueError, match="roster must not be empty"):
        append_session([], existing=[], memory_mode="off")


class _SeqRunner:
    """SessionRunner double: records the cells it was asked to run."""

    def __init__(self) -> None:
        self.ran: list[int] = []

    def prepare_fixture(self, session: Any) -> None:
        pass

    def run_session(self, session: Any) -> dict[str, Any]:
        self.ran.append(session.sequence_index)
        return {
            "problems_before": 3,
            "problems_final": ["problem-2"],
            "resolved_count": 1,
            "remaining_count": 2,
            "conformed": False,
            "attempts_to_green": 1,
            "turns": 2,
            "input_tokens": 10,
            "output_tokens": 20,
            "total_tokens": 30,
            "wall_seconds": 0.1,
            "wall_cost_usd": 0.0,
            "termination_reason": "gates_failed",
            "failed_gates": ["tests"],
        }


def _sequencer(tmp_path: Path, runner: _SeqRunner) -> CumulativeSequencer:
    return CumulativeSequencer(
        tmp_path / "manifest.json",
        runner=runner,
        roster=roster("p/a"),
        task="backgammon",
        org_id="org-append-test",
        config_fingerprint="cfg-append-test",
    )


def test_off_on_off_off_on_appends_five_cells_and_counts_three_off_two_on(
    tmp_path: Path,
) -> None:
    """The click sequence the campaign is actually driven by."""
    runner = _SeqRunner()
    sequencer = _sequencer(tmp_path, runner)
    arms = ["off", "on", "off", "off", "on"]

    for expected_index, arm in enumerate(arms):
        appended = sequencer.append_cell(arm)
        assert appended.sequence_index == expected_index
        assert appended.memory_mode == arm
        assert sequencer.step_until_done()["status"] == "done"

    assert runner.ran == [0, 1, 2, 3, 4]

    records = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))[
        "session_records"
    ]
    assert [record["sequence_index"] for record in records] == [0, 1, 2, 3, 4]
    assert [record["memory_mode"] for record in records] == arms
    assert {record["phase"] for record in records} == {"DONE"}

    off_cells = [record for record in records if record["memory_mode"] == "off"]
    on_cells = [record for record in records if record["memory_mode"] == "on"]
    assert (len(off_cells), len(on_cells)) == (3, 2)
    # An ON cell counts itself once: nothing pre-allocated a budget for it.
    assert len({record["sequence_index"] for record in on_cells}) == 2

    assert sequencer.state()["totals"] == {
        "sessions": 5,
        "completed": 5,
        "remaining": 0,
    }


def test_one_click_appends_exactly_one_cell(tmp_path: Path) -> None:
    runner = _SeqRunner()
    sequencer = _sequencer(tmp_path, runner)

    sequencer.append_cell("off")

    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    assert len(manifest["schedule"]) == 1
    assert len(manifest["session_records"]) == 1


def test_nothing_counts_rounds_so_a_long_on_arm_is_never_refused(
    tmp_path: Path,
) -> None:
    """An ON arm follows the standard method for ANY number of rounds.

    There is no plan whose length could cap the arm and no budget to run out
    of: each of these 64 clicks appends its own cell and runs it. 64 is far
    beyond any historical limit — the point is that no code path counts rounds.
    """
    runner = _SeqRunner()
    sequencer = _sequencer(tmp_path, runner)

    for expected_index in range(64):
        appended = sequencer.append_cell("on")
        assert appended.sequence_index == expected_index
        assert sequencer.step_until_done()["status"] == "done"

    assert runner.ran == list(range(64))
    assert sequencer.state()["totals"]["completed"] == 64
