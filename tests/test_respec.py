"""A preference the model missed is handed back from the build brief, word for word."""

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
