"""N cells of one configuration are N sessions in the schedule.

A baseline is the MEDIAN of N runs, because one run was never a baseline:
identical prompts and identical model produced 23, 25 and 62 problems on this
task. The schedule used to hold one OFF session per rostered model, so the
control plane could allocate indices 0..N-1 against it and every cell after the
first died seconds in on `sequence_index N out of range`.
"""

from __future__ import annotations

import pytest

from harness.cumulative.ordering import build_off_order, build_schedule
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
