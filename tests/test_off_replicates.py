"""N cells of one configuration are N sessions in the schedule.

A baseline is the MEDIAN of N runs, because one run was never a baseline:
identical prompts and identical model produced 23, 25 and 62 problems on this
task. The schedule used to hold one OFF session per rostered model, so the
control plane could allocate indices 0..N-1 against it and every cell after the
first died seconds in on `sequence_index N out of range`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from harness.cumulative.manifest import roster_hash
from harness.cumulative.ordering import build_off_order, build_schedule
from harness.cumulative.sequencer import CumulativeSequencer
from harness.cumulative.types import RosterEntry


def roster(*models: str) -> list[RosterEntry]:
    return [
        RosterEntry(model=m, role="candidate", provider_pin=m.split("/")[0])
        for m in models
    ]


def test_one_replicate_is_the_old_behaviour() -> None:
    sessions = build_off_order(roster("p/a", "p/b"))
    assert [s.sequence_index for s in sessions] == [0, 1]
    assert [s.model for s in sessions] == ["p/a", "p/b"]


def test_replicates_are_the_same_cell_repeated() -> None:
    sessions = build_off_order(roster("p/a"), replicates=4)
    assert len(sessions) == 4
    # Same configuration throughout — only the index differs.
    assert {s.model for s in sessions} == {"p/a"}
    assert {s.memory_mode for s in sessions} == {"off"}
    assert [s.sequence_index for s in sessions] == [0, 1, 2, 3]


def test_replicates_are_contiguous_per_model() -> None:
    sessions = build_off_order(roster("p/a", "p/b"), replicates=3)
    assert [s.model for s in sessions] == ["p/a"] * 3 + ["p/b"] * 3
    # sequence_index is the position in the schedule: explicit-index mode
    # selects session_records[i] and requires that identity.
    assert [s.sequence_index for s in sessions] == list(range(6))
    assert [s.roster_index for s in sessions] == [0, 0, 0, 1, 1, 1]


@pytest.mark.parametrize("bad", [0, -1, 1.5, True, None, "4"])
def test_a_replicate_count_that_is_not_a_positive_integer_fails_loudly(bad) -> None:
    # Never clamped to 1: a batch that silently ran once would report a median
    # over a single sample, which is the defect this exists to remove.
    with pytest.raises(ValueError):
        build_off_order(roster("p/a"), replicates=bad)


def test_only_the_off_arm_replicates() -> None:
    """An ON cell is ONE measurement against the floor, every time.

    Replicating it would average away exactly what the benchmark exists to
    observe — the difference memory makes on a single run.
    """
    sched = build_schedule(
        roster("p/a"), seed=1, roster_hash="h", on_budget=2, off_replicates=3
    )
    off = [s for s in sched if s.memory_mode == "off"]
    on = [s for s in sched if s.memory_mode == "on"]
    assert len(off) == 3, "three OFF replicates"
    assert len(on) == 2, "the ON budget is untouched by off_replicates"
    # Indices stay contiguous across the join, ON continuing after OFF.
    assert [s.sequence_index for s in sched] == list(range(5))


def test_the_batch_is_big_enough_for_a_median_to_mean_anything() -> None:
    # Not a rule the code enforces — the operator decides what N is worth
    # gathering. This pins that the schedule can express the N they choose.
    for n in (2, 4, 8):
        assert len(build_off_order(roster("p/a"), replicates=n)) == n


class _SeqRunner:
    """SessionRunner double: records the sessions it was asked to run."""

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


def test_a_memory_on_plan_has_no_length_limit(tmp_path: Path) -> None:
    """An ON arm follows the standard method for ANY number of rounds.

    The plan a memory-ON cell is handed is not capped: the schedule builder
    emits one ON slot per unit of the operator's budget, and the sequencer
    walks a plan of that length to done on a fresh manifest without a range or
    drift refusal. 64 is far beyond any historical limit — the point is that
    nothing in the plan path counts rounds.
    """
    on_budget = 64
    entries = roster("p/a")

    schedule = build_schedule(
        entries,
        seed=1,
        roster_hash=roster_hash(entries),
        on_budget=on_budget,
        off_replicates=3,
    )

    assert len(schedule) == on_budget + 3, "three OFF replicates + the ON budget"
    on_slots = [s for s in schedule if s.memory_mode == "on"]
    assert len(on_slots) == on_budget
    assert all(s.phase_group == "on" for s in on_slots)
    # Contiguous and in order across the join: the sequencer selects by index.
    assert [s.sequence_index for s in schedule] == list(range(on_budget + 3))

    runner = _SeqRunner()
    sequencer = CumulativeSequencer(
        tmp_path / "manifest.json",
        runner=runner,
        roster=entries,
        seed=1,
        task="backgammon",
        org_id="org-no-plan-cap",
        config_fingerprint="cfg-no-plan-cap",
        on_budget=on_budget,
        off_replicates=3,
    )

    done = sequencer.step_until_done()

    assert done["status"] == "done"
    assert runner.ran == list(range(on_budget + 3))
