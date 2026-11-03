"""An `[untold]` check is scored as failing, told to no one, and excuses no other check."""

from pathlib import Path

from harness.adapters.challenge.stages import load_stages, player_view

CHECKS = Path(__file__).resolve().parents[1] / "grader" / "checks.json"


def test_an_untold_check_is_scored_but_never_told():
    stages = load_stages(CHECKS)
    words = {
        "check": "[G12] REQ-CUBE-AI — the cube functions answer in the build prompt's words",
        "observed": "AssertionError: [untold] the take function does not take (board, player, difficulty)",
    }
    offer = {
        "check": "[G24] REQ-CUBE-ACCEPT — accepting the computer's double makes the cube 2",
        "observed": "AssertionError: [needs: G12 F49] the computer never offered a double",
    }
    view = player_view([words, offer], stages, is_infra=lambda c: False)
    assert words["check"] in view.unevaluated
    # G12 failing only on its words does not hold G24 back.
    assert [p["check"] for p in view.visible] == [offer["check"]]
