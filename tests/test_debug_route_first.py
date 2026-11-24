"""The debug route is conformance: what it refused, and whether a seeded turn plays like
a played one, is told first, by the team (Jerry, 2026-11-23).

WO-LI-SEAM-CHART (2026-11-24): of the 35 corpus builds whose route refused a setup, none
was ever told so — the refusal sat at its gate's own moment, behind earlier symptoms,
while one refusal broke 23 checks on average.
"""

from pathlib import Path

from harness.adapters.challenge.stages import load_stages, player_view, stage_of

CHECKS = Path(__file__).resolve().parents[1] / "grader" / "checks.json"

REFUSED = {
    "check": "[G24] REQ-CUBE-ACCEPT — accepting the computer's double makes the cube 2",
    "observed": "Error: SETUP REFUSED: /api/debug/state did not take cube (sent turn, cube)",
}
SYMPTOM = {
    "check": "[G31] REQ-OPENING — the opening roll decides who goes first",
    "observed": "AssertionError: [aspect: numbers] after a 3-5 opening the computer moved 6 pips, not 8",
}


def test_a_refused_setup_is_told_at_the_first_moment_ahead_of_later_symptoms() -> None:
    stages = load_stages(CHECKS)
    first = min(s.number for s in stages)
    assert (
        stage_of(REFUSED["check"], stages).number
        > stage_of(SYMPTOM["check"], stages).number
    )
    view = player_view([SYMPTOM, REFUSED], stages, is_infra=lambda c: False)
    assert view.stage is not None and view.stage.number == first
    assert [p["check"] for p in view.visible] == [REFUSED["check"]]
    assert view.withheld == [SYMPTOM["check"]]


def test_the_route_behaviour_checks_sit_at_the_first_moment() -> None:
    stages = load_stages(CHECKS)
    first = min(s.number for s in stages)
    for check in ("[G35] x", "[G28] x", "REQ-DEBUG/debug.roll"):
        assert stage_of(check, stages).number == first, check


def test_one_refusal_of_each_kind_is_told_the_rest_wait() -> None:
    # A route that ignores the dice queue refused 23 rolls in one build, and the
    # model read 23 lines saying so (WO-LI-SEAM-PROOF, 2026-11-24).
    stages = load_stages(CHECKS)
    rolls = [
        {
            "check": f"[{gate}] x",
            "observed": f"Error: SETUP REFUSED: /api/debug/roll did not take dice (sent {a}, {b}) [rolled 1, 1]",
        }
        for gate, a, b in (("G24", 3, 5), ("G13", 6, 5), ("G25", 2, 1))
    ]
    view = player_view([*rolls, REFUSED], stages, is_infra=lambda c: False)
    told = [p["check"] for p in view.visible]
    assert (
        told.count(
            "[G24] REQ-CUBE-ACCEPT — accepting the computer's double makes the cube 2"
        )
        == 1
    )
    roll_told = [c for c in told if c in {"[G24] x", "[G13] x", "[G25] x"}]
    assert len(roll_told) == 1
    assert roll_told[0] == min(
        roll_told
        + [c for c in view.unevaluated if c in {"[G24] x", "[G13] x", "[G25] x"}],
        key=lambda c: stage_of(c, stages).number,
    )
    assert sorted(view.unevaluated) == sorted(
        {"[G24] x", "[G13] x", "[G25] x"} - set(roll_told)
    )
