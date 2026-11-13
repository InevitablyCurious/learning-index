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
            "observed": "AssertionError: expected 'double' to be 'no-double'",
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
            "observed": "AssertionError: [untold] a cube answer outside double / no-double",
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
            "observed": "AssertionError: [untold] a",
        },
        {
            "check": "[G19] REQ-BEAROFF-GATE — x",
            "observed": "AssertionError: [untold] b",
        },
    ]
    respec = ChallengeRunner._respec_for(failing, [], None, stages)
    assert len(respec) == 1 and "allInHome" in respec[0]
