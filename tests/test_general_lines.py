"""General lines: the whole picture for a part when it is wrong, details when it is close.

Jerry, 2026-11-11/12. A part of the board (triangles, bar, off tray, pieces) has
one GENERAL line that states what it should look like. It is told only while
one of the part's BIG findings fails; when only details are off, each finding
tells its own line. And a general line is never reported fixed while anything
it covers still fails — the round that put "That fixed it — the pieces aren't
set out right" above "The pieces still aren't set out right".
"""

from __future__ import annotations

from pathlib import Path

from harness.adapters.challenge import ChallengeRunner as R
from harness.adapters.challenge import load_feedback_overrides_from_failures
from harness.adapters.challenge.feedback import TOLD_LINE_CAP, load_general_lines

PROMPTS = Path(__file__).resolve().parents[1] / "task" / "backgammon" / "prompts"
GENERAL = load_general_lines(PROMPTS)
PIECES = GENERAL["pieces"]


def _problem(check: str, aspect: str | None = None) -> dict[str, str]:
    observed = f"Error: [aspect: {aspect}] x" if aspect else "Error: x"
    return {"check": check, "observed": observed}


ON_THE_WRONG_POINT = _problem("[F31] REQ-GEOMETRY — checkers over their own points")
OFF_CENTRE = _problem("[F31] REQ-GEOMETRY — checkers over their own points", "side")
CUT_OFF = _problem("[F43] REQ-GEOMETRY — every piece shows", "clipped")
SPREAD = _problem("[F71] REQ-GEOMETRY — a point keeps an even pitch", "spreadtop")


def _list(problems: list[dict[str, str]], **kw: object) -> str:
    return R._build_feedback_prompt(problems=problems, **kw)


def test_every_part_is_complete_and_fits_the_delivery_cap() -> None:
    assert set(GENERAL) == {"triangles", "bar", "tray", "pieces"}
    for part, spec in GENERAL.items():
        assert spec["first"] and spec["repeat"], part
        assert (
            len(spec["first"]) <= TOLD_LINE_CAP and len(spec["repeat"]) <= TOLD_LINE_CAP
        ), part
        assert spec["big"] <= spec["members"], (
            f"{part}: a big finding that isn't a member"
        )


def test_every_member_keeps_its_own_specific_line() -> None:
    # When the picture is close a member is told its own line, so it must have one.
    lines = load_feedback_overrides_from_failures(PROMPTS)
    for part, spec in GENERAL.items():
        missing = sorted(
            k
            for k in spec["members"]
            if k not in lines and k.split(".")[0] not in lines
        )
        assert not missing, f"{part}: no specific line for {missing}"


def test_a_part_whose_picture_is_wrong_is_told_once_as_its_general_line() -> None:
    msg = _list([ON_THE_WRONG_POINT, CUT_OFF, SPREAD])
    assert msg.count(PIECES["first"]) == 1
    assert "cut off" not in msg.replace(PIECES["first"], "")


def test_a_part_that_is_close_is_told_its_details_not_the_general_line() -> None:
    msg = _list([CUT_OFF])
    assert PIECES["first"] not in msg and PIECES["repeat"] not in msg
    assert "cut off" in msg


def test_a_general_line_is_never_fixed_while_its_part_still_fails() -> None:
    told = {"a": PIECES["first"], "b": PIECES["first"]}
    # One of its findings passes, another still fails: nothing is fixed.
    assert (
        R._build_pass_verdict(newly_passing=["a"], told=told, still_failing=["[F43] x"])
        == ""
    )
    # Everything it covers passes: now it is fixed, quoted whole.
    verdict = R._build_pass_verdict(
        newly_passing=["a", "b"], told=told, still_failing=["[F87] x"]
    )
    assert PIECES["first"] in verdict and "…" not in verdict


def test_a_big_finding_held_back_for_a_smaller_one_still_calls_the_general_line() -> (
    None
):
    # Told: cut off and spread apart. Found but held back ([needs: F43]): the
    # pieces are on the wrong points. The picture is wrong, so the general line.
    msg = _list([CUT_OFF, SPREAD], found=[ON_THE_WRONG_POINT, CUT_OFF, SPREAD])
    assert msg.count(PIECES["first"]) == 1


def test_a_piece_off_centre_is_a_detail_with_jerrys_line() -> None:
    # Jerry, 2026-11-12: a close board whose stacks sit 13 px left of centre.
    msg = _list([OFF_CENTRE])
    assert PIECES["first"] not in msg
    assert "do not sit perfectly on center of their point" in msg
