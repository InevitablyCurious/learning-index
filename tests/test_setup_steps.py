"""A `[setup]` step waits on the checks it names; failing with them passed, it is a grader alarm.

Jerry, 2026-11-23: "an untold check should never be untold". The contract items the
old `[untold]` marker hid are conformance told by the team (G40); what is left are a
check's setup steps — the game accepting a listed move, a roll played out — which
other checks judge. Their failure is either the owner's (told by the owner) or the
grader's own (an alarm that stops the cell), never a line to the model.
"""

import re
from pathlib import Path

from harness.adapters.challenge.stages import load_stages, met_failures, player_view

ROOT = Path(__file__).resolve().parents[1]
CHECKS = ROOT / "grader" / "checks.json"
GRADER = ROOT / "grader"

STEP = {
    "check": "[G25] REQ-AI-TURN — the computer plays its whole roll",
    "observed": "AssertionError: [setup] [needs: F25] the game refused every move it listed",
}
OWNER = {
    "check": "[F25] REQ-MOVE — a listed move is accepted",
    "observed": "Error: the game refused the move 13→8",
}
OTHER = {
    "check": "[G24] REQ-CUBE-ACCEPT — accepting the computer's double makes the cube 2",
    "observed": "AssertionError: [aspect: owner] the taken cube was not the player's",
}


def test_a_setup_step_whose_owner_failed_waits_on_the_owner() -> None:
    view = player_view([STEP, OWNER], load_stages(CHECKS), is_infra=lambda c: False)
    assert STEP["check"] in view.unevaluated
    assert view.alarms == []
    assert OWNER["check"] in [p["check"] for p in view.visible]


def test_a_setup_step_that_fails_alone_is_a_grader_alarm_never_told() -> None:
    view = player_view([STEP, OTHER], load_stages(CHECKS), is_infra=lambda c: False)
    assert view.alarms == [STEP["check"]]
    assert STEP["check"] not in [p["check"] for p in view.visible]
    assert STEP["check"] not in view.withheld


def test_a_setup_step_excuses_no_other_check() -> None:
    # A setup step reaches no one, so it cannot hold back a check that waits on it.
    waiting = {
        "check": "[G30] REQ-AI-HIGHER-DIE — x",
        "observed": "AssertionError: [needs: G25] the computer passed without moving",
    }
    assert "G25" not in met_failures([STEP])
    view = player_view([STEP, waiting], load_stages(CHECKS), is_infra=lambda c: False)
    assert waiting["check"] in [p["check"] for p in view.visible]


_ASSERT_WITH_SETUP = re.compile(r"""["'`]([^"'`]*\[setup\][^"'`]*)["'`]""")


def test_every_setup_step_names_the_checks_it_waits_on() -> None:
    # A step with no owner has no check to wait on: every failure would be an alarm.
    found = 0
    for path in [*GRADER.glob("backend/**/*.ts"), *GRADER.glob("frontend/*.ts")]:
        for line in path.read_text(encoding="utf-8").splitlines():
            code = line.split("//", 1)[0]
            for message in _ASSERT_WITH_SETUP.findall(code):
                found += 1
                assert "[needs: " in message, f"{path.name}: {message!r}"
    assert found >= 6, f"the scan found {found} setup steps"


def test_no_untold_marker_is_left() -> None:
    for path in [*GRADER.glob("backend/**/*.ts"), *GRADER.glob("frontend/*.ts")]:
        for line in path.read_text(encoding="utf-8").splitlines():
            assert "[untold]" not in line.split("//", 1)[0], (
                f"{path.name}: {line.strip()}"
            )
