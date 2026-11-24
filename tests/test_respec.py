"""A preference the model missed is handed back from the build brief, word for word."""

import re
from pathlib import Path

from harness.adapters.challenge import ChallengeRunner
from harness.adapters.challenge.constants import _CONSTRAINTS

PROMPTS = Path(__file__).resolve().parents[1] / "task" / "backgammon" / "prompts"
WINDOW = "[G12] REQ-CUBE-AI — offers only inside hard window, never when blocked/easy/too-good"


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
    told = [
        {
            "check": WINDOW,
            "observed": "AssertionError: [brief]: expected 'double' to be 'no-double'",
        }
    ]
    respec = ChallengeRunner._respec_for(told)
    assert len(respec) == 1 and "house numbers" in respec[0]
    prompt = ChallengeRunner._build_feedback_prompt(problems=told, respec=respec)
    assert (
        prompt.index("house numbers") < prompt.rindex("\n\n")
        or "house numbers" in prompt
    )
    assert prompt.count("hard 0.68 to 0.90") == 1


GRADER = Path(__file__).resolve().parents[1] / "grader"
_GATE = re.compile(r"""(?:it|test)\(\s*["'`]\[([A-Z]+[0-9]+)\]""")


def test_a_shared_excerpt_is_handed_back_once() -> None:
    told = [
        {
            "check": "[F24] REQ-TURN — stuck turn state",
            "observed": "Error: [aspect: stuckstate] [brief] [needs: G06] a turn stuck on the bar answered turnOver false",
        },
        {
            "check": "[G13] REQ-PASS — no legal move passes the turn",
            "observed": "AssertionError: [aspect: stuckstate] [brief] [needs: G06] a turn stuck on the bar answered turnOver false",
        },
    ]
    respec = ChallengeRunner._respec_for(told)
    assert len(respec) == 1 and "turnOver" in respec[0]


def test_a_finding_its_excerpt_does_not_explain_hands_nothing_back() -> None:
    # Run 1795104147: G08 caught a 5 bearing off the 3 while a piece sat on 5;
    # its allInHome assertion had passed, and the model was told "the engine's
    # all-home check still isn't following the build brief". In the corpus the
    # scoring excerpt came back for a debug endpoint that refused the position.
    overshoot = {
        "check": "[G08] REQ-BEAROFF — bear-off incl overshoot",
        "observed": "AssertionError: expected [ '3-25-5', '5-25-5' ] to not include '3-25-5'",
    }
    refused = {
        "check": "[G10] REQ-WINCLASS — x",
        "observed": "Error: SETUP REFUSED: /api/debug/state did not take points",
    }
    assert ChallengeRunner._respec_for([overshoot, refused]) == []
    gammon = {
        "check": "[G10] REQ-WINCLASS — x",
        "observed": "AssertionError: [brief] [aspect: gammon]: expected { won: true, type: 'single' }",
    }
    assert len(ChallengeRunner._respec_for([gammon])) == 1


_BRIEF_LINE = re.compile(r"\[brief\]")


def _brief_gates() -> set[str]:
    """Every gate with a `[brief]` assertion in its test body."""
    gates: set[str] = set()
    for path in [*GRADER.glob("backend/**/*.ts"), *GRADER.glob("frontend/*.ts")]:
        owner = None
        for line in path.read_text(encoding="utf-8").splitlines():
            if match := _GATE.search(line):
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
