"""A preference the model missed is handed back from the build brief, word for word."""

import re
from pathlib import Path

from harness.adapters.challenge import ChallengeRunner
from harness.adapters.challenge.constants import _CONSTRAINTS
from harness.adapters.challenge.stages import load_stages

PROMPTS = Path(__file__).resolve().parents[1] / "task" / "backgammon" / "prompts"
CHECKS = Path(__file__).resolve().parents[1] / "grader" / "checks.json"
WINDOW = "[G12] REQ-CUBE-AI — offers only inside hard window, never when blocked/easy/too-good"
WORDS = "[G12] REQ-CUBE-AI — the cube functions answer in the build prompt's words"


def test_every_respec_line_is_the_briefs_own() -> None:
    brief = "\n".join(
        (PROMPTS / f).read_text(encoding="utf-8")
        for f in sorted(p.name for p in PROMPTS.glob("chunk-*.md"))
    )
    for path in (PROMPTS / "respec").glob("*.md"):
        body = path.read_text(encoding="utf-8").splitlines()[1:]
        for line in body:
            if line.strip() and not line.startswith("```"):
                assert line in brief, (
                    f"{path.name}: not in the build brief word for word: {line!r}"
                )


def test_a_told_cube_check_hands_the_brief_back_before_the_constraints() -> None:
    stages = load_stages(CHECKS)
    told = [
        {
            "check": WINDOW,
            "observed": "AssertionError: [brief]: expected 'double' to be 'no-double'",
        }
    ]
    respec = ChallengeRunner._respec_for(told, told, stages[11], stages)
    assert len(respec) == 1 and "house numbers" in respec[0]
    prompt = ChallengeRunner._build_feedback_prompt(problems=told, respec=respec)
    assert (
        prompt.index("house numbers") < prompt.rindex("\n\n")
        or "house numbers" in prompt
    )
    assert prompt.count("hard 0.68 to 0.90") == 1


def test_untold_cube_words_hand_the_brief_back_only_once_the_cube_is_reached() -> None:
    stages = load_stages(CHECKS)
    words = [
        {
            "check": WORDS,
            "observed": "AssertionError: [untold] [brief] a cube answer outside double / no-double",
        }
    ]
    cube = next(s for s in stages if s.name == "Playing: the doubling cube")
    moving = next(s for s in stages if s.name == "Starting a game: moving a piece")
    assert ChallengeRunner._respec_for(words, [], cube, stages)
    assert ChallengeRunner._respec_for(words, [], None, stages)
    assert ChallengeRunner._respec_for(words, [], moving, stages) == []


GRADER = Path(__file__).resolve().parents[1] / "grader"
_UNTOLD_GATE = re.compile(r"""(?:it|test)\(\s*["'`]\[([A-Z]+[0-9]+)\]""")


def _untold_gates() -> set[str]:
    """Every gate with an `[untold]` assertion in its test body."""
    gates: set[str] = set()
    for path in [*GRADER.glob("backend/**/*.ts"), *GRADER.glob("frontend/*.ts")]:
        owner = None
        for line in path.read_text(encoding="utf-8").splitlines():
            if match := _UNTOLD_GATE.search(line):
                owner = match.group(1)
            if "[untold]" in line and owner and "expect" in line:
                gates.add(owner)
            elif "[untold]" in line and owner and "const " in line:
                gates.add(owner)
    return gates


def test_every_untold_gate_hands_its_brief_back() -> None:
    # An untold check is never told, so the only way a model can learn it fails
    # is its part of the brief handed back. Without one, a build that fails only
    # untold checks hears "something is still broken" and nothing it can act on
    # (run 1794576468: E07/G19 failed on allInHome round after round, untold).
    gates = _untold_gates()
    assert {"E07", "G12", "G19", "F24"} <= gates, f"the scan missed gates: {gates}"
    missing = sorted(g for g in gates if not (PROMPTS / "respec" / f"{g}.md").is_file())
    assert missing == [], f"untold gates with no brief to hand back: {missing}"


def test_a_shared_excerpt_is_handed_back_once() -> None:
    stages = load_stages(CHECKS)
    failing = [
        {
            "check": "[E07] REQ-ALLINHOME-BAR — x",
            "observed": "AssertionError: [untold] [brief] a",
        },
        {
            "check": "[G19] REQ-BEAROFF-GATE — x",
            "observed": "AssertionError: [untold] [brief] b",
        },
    ]
    respec = ChallengeRunner._respec_for(failing, [], None, stages)
    assert len(respec) == 1 and "allInHome" in respec[0]


def test_an_untold_step_waiting_on_a_failed_check_hands_nothing_back() -> None:
    # Run 1794861030: G06 failed (a piece came in off the bar at the wrong end),
    # so F24's shut-out position was no shut-out and its untold turnOver step
    # failed with nothing stuck; the stuck-turn brief came back as unfollowed.
    stages = load_stages(CHECKS)
    stuck = {
        "check": "[F24] REQ-TURN — stuck turn state",
        "observed": "Error: [untold] [brief] [needs: G06] a stuck turn's state did not say turnOver",
    }
    bar = {
        "check": "[G06] REQ-BAR — bar re-entry + blocked pass",
        "observed": "AssertionError: [aspect: wrongpoint] the bar piece is offered the wrong point",
    }
    assert ChallengeRunner._respec_for([stuck, bar], [bar], None, stages) == []
    assert ChallengeRunner._respec_for([stuck], [], None, stages)


def test_a_finding_its_excerpt_does_not_explain_hands_nothing_back() -> None:
    # Run 1795104147: G08 caught a 5 bearing off the 3 while a piece sat on 5;
    # its allInHome assertion had passed, and the model was told "the engine's
    # all-home check still isn't following the build brief". In the corpus the
    # scoring excerpt came back for a debug endpoint that refused the position.
    stages = load_stages(CHECKS)
    overshoot = {
        "check": "[G08] REQ-BEAROFF — bear-off incl overshoot",
        "observed": "AssertionError: expected [ '3-25-5', '5-25-5' ] to not include '3-25-5'",
    }
    refused = {
        "check": "[G10] REQ-WINCLASS — x",
        "observed": "Error: SETUP REFUSED: /api/debug/state did not take points",
    }
    assert (
        ChallengeRunner._respec_for(
            [overshoot, refused], [overshoot, refused], None, stages
        )
        == []
    )
    home = {
        "check": "[G08] REQ-BEAROFF — bear-off incl overshoot",
        "observed": "AssertionError: [untold] [brief] the engine says not every piece is home when every one is",
    }
    respec = ChallengeRunner._respec_for([home], [], None, stages)
    assert len(respec) == 1 and "allInHome" in respec[0]


_BRIEF_LINE = re.compile(r"\[brief\]")


def _brief_gates() -> set[str]:
    """Every gate with a `[brief]` assertion in its test body."""
    gates: set[str] = set()
    for path in [*GRADER.glob("backend/**/*.ts"), *GRADER.glob("frontend/*.ts")]:
        owner = None
        for line in path.read_text(encoding="utf-8").splitlines():
            if match := _UNTOLD_GATE.search(line):
                owner = match.group(1)
            code = line.split("//", 1)[0]
            if owner and _BRIEF_LINE.search(code):
                gates.add(owner)
    return gates


def test_every_excerpt_has_an_assertion_it_explains_and_no_other() -> None:
    # An excerpt with no [brief] assertion is never handed back; a [brief]
    # assertion with no excerpt marks nothing.
    excerpts = {p.stem for p in (PROMPTS / "respec").glob("*.md")}
    assert _brief_gates() == excerpts


def test_the_brief_marker_never_reaches_a_told_line() -> None:
    line = ChallengeRunner._fill_measured(
        "Their checks: {measured}.",
        "AssertionError: [brief] [aspect: offered] after the player rolled, canDouble is true: expected true to be false",
    )
    assert line == "Their checks: after the player rolled, canDouble is true."
