"""A told complaint is reported fixed only when the grade proves it is gone.

A test stops at its first failing assertion. When a check still fails, a
complaint the model was told is gone only if every way the check fails now is
asked AFTER every ask of the told complaint, outside any loop they share (run
1793479392 round 3: the collision was fixed, the check failed on uneven pieces
asked after it, and the model never heard its fix worked).
"""

from __future__ import annotations

from harness.adapters.challenge.constants import _GRADER_DIR
from harness.adapters.challenge.stages import (
    aspect_order,
    asked_after,
    told_complaints_fixed,
)

ORDER = aspect_order(_GRADER_DIR)
F87 = "[F87] REQ-LAYOUT — the board keeps its shape as the window changes"
F31 = "[F31] REQ-GEOMETRY — checkers over their own points"


def test_an_aspect_asked_later_in_its_own_loop_proves_the_earlier_one() -> None:
    assert asked_after(ORDER, "F87", "uneven", "overlap")
    assert not asked_after(ORDER, "F87", "overlap", "uneven")


def test_an_aspect_asked_twice_is_proved_only_after_its_last_ask() -> None:
    # G03 asks "doublemoves" more than once, with "plainmoves" between two of
    # those asks: plainmoves does not come after doublemoves' last ask.
    assert not asked_after(ORDER, "G03", "plainmoves", "doublemoves")
    # F87 counts leftover bars (stale) early and compares the picture (changed)
    # last: the picture is asked after the count.
    assert asked_after(ORDER, "F87", "changed", "stale")
    assert not asked_after(ORDER, "F87", "stale", "changed")


def test_aspects_asked_piece_by_piece_in_one_loop_prove_nothing_about_each_other() -> (
    None
):
    assert not asked_after(ORDER, "F31", "past", "up")
    assert not asked_after(ORDER, "F31", "up", "past")
    assert asked_after(ORDER, "F31", "rim", "up")


def test_comments_naming_an_aspect_are_not_asks() -> None:
    # F31's comment "[aspect: offboard] FIRST" sits above the real ask.
    offboard = ORDER["F31"]["offboard"]
    assert len(offboard) == 1


def test_a_passing_check_fixes_every_complaint_told_for_it() -> None:
    told = [(F87, "overlap")]
    assert told_complaints_fixed(told, [], ORDER) == told


def test_a_check_failing_later_fixes_the_told_complaint() -> None:
    told = [(F87, "overlap")]
    assert told_complaints_fixed(told, [(F87, "uneven")], ORDER) == told


def test_a_check_failing_earlier_or_the_same_way_fixes_nothing() -> None:
    assert told_complaints_fixed([(F87, "uneven")], [(F87, "overlap")], ORDER) == []
    assert told_complaints_fixed([(F87, "overlap")], [(F87, "overlap")], ORDER) == []


def test_one_earlier_failure_among_several_keeps_the_complaint_open() -> None:
    assert (
        told_complaints_fixed(
            [(F87, "overlap")], [(F87, "uneven"), (F87, "stale")], ORDER
        )
        == []
    )


def test_a_general_line_or_an_unaspected_failure_is_never_called_fixed_while_failing() -> (
    None
):
    assert told_complaints_fixed([(F87, None)], [(F87, "ratio")], ORDER) == []
    assert told_complaints_fixed([(F87, "overlap")], [(F87, None)], ORDER) == []


def test_a_loop_shared_with_the_told_complaint_keeps_it_open() -> None:
    assert told_complaints_fixed([(F31, "up")], [(F31, "past")], ORDER) == []
    assert told_complaints_fixed([(F31, "up")], [(F31, "rim")], ORDER) == [(F31, "up")]


def test_a_sibling_check_of_the_same_gate_keeps_its_line_open() -> None:
    # Run 1793662415 round 3: one G12 check passed while another G12 check still
    # told the same line; the model heard it fixed and still broken at once.
    accepts = (
        "[G12] REQ-CUBE-AI — accepts near-even cube offers across all difficulties"
    )
    window = "[G12] REQ-CUBE-AI — offers only inside hard window, never when blocked/easy/too-good"
    assert told_complaints_fixed([(accepts, None)], [(window, None)], ORDER) == []
    assert told_complaints_fixed([(accepts, None)], [(F87, None)], ORDER) == [
        (accepts, None)
    ]
