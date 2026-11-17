"""WHO TELLS WHAT (Jerry, 2026-11-17): the software team does the heavy lifting.

A check that looks at the code underneath (grader/checks.json "looks": "code") is
told by the team, by where it looks — never a hand list. The player says only what
a person sees and does on the page; a page check, or one of its aspects, that the
team tells instead is listed in grader/voices.json (what no player sees, and exact
measurements quoted with the grader's own numbers).
"""

import json
import re
from pathlib import Path

from harness.adapters.challenge import ChallengeRunner as R

ROOT = Path(__file__).resolve().parents[1]
GRADER = ROOT / "grader"
CHECKS = json.loads((GRADER / "checks.json").read_text(encoding="utf-8"))["checks"]
LINES = json.loads((GRADER / "feedback.json").read_text(encoding="utf-8"))["gates"]
VOICES = json.loads((GRADER / "voices.json").read_text(encoding="utf-8"))["team"]
_TEST = re.compile(r"""^\s*(?:it|test)\(\s*["'`]\[([A-Z]+[0-9]+)\]""", re.M)
_FIRST_PERSON = re.compile(r"\b(I|I'm|I've|I'd|i|me|my|mine|myself)\b")


def _where_each_check_looks() -> dict[str, str]:
    looks: dict[str, set[str]] = {}
    for path in [*GRADER.glob("backend/**/*.ts"), *GRADER.glob("frontend/*.spec.ts")]:
        kind = "code" if "backend" in path.parts else "page"
        for m in _TEST.finditer(path.read_text(encoding="utf-8")):
            looks.setdefault(m.group(1), set()).add(kind)
    return {
        gate: ("page" if "page" in kinds else "code") for gate, kinds in looks.items()
    }


def test_every_check_says_where_it_looks_and_it_is_true() -> None:
    found = _where_each_check_looks()
    gates = {k for k in CHECKS if re.match(r"^[A-Z]+[0-9]+$", k)}
    assert gates == set(found), (
        f"checks without a test, or tests without a check: {sorted(gates ^ set(found))}"
    )
    wrong = {
        g: (CHECKS[g].get("looks"), found[g])
        for g in gates
        if CHECKS[g].get("looks") != found[g]
    }
    assert not wrong, (
        f"checks.json 'looks' disagrees with where the check's test lives: {wrong}"
    )


def test_a_check_of_the_code_underneath_is_the_teams() -> None:
    for gate, entry in CHECKS.items():
        if entry.get("looks") == "code":
            assert R.feedback_channel(f"[{gate}] x") == "team", gate


def test_every_team_listed_key_has_its_lines_and_is_a_page_check() -> None:
    for key in VOICES:
        assert key in LINES, f"grader/voices.json names {key}, which has no line"
        assert CHECKS[key.split(".")[0]].get("looks") == "page", (
            f"{key} looks at the code — it is the team's already; list only page checks here"
        )


def test_no_team_line_speaks_as_the_player() -> None:
    team_keys = set(VOICES)
    for key, line in LINES.items():
        gate = key.split(".")[0]
        if not re.match(r"^[A-Z]+[0-9]+$", gate):
            continue
        aspect = key.split(".", 1)[1] if "." in key else None
        if R.feedback_channel(f"[{gate}] x", aspect) != "team" and key not in team_keys:
            continue
        for kind in ("first", "repeat"):
            found = _FIRST_PERSON.findall(line[kind])
            assert not found, (
                f"{key}/{kind} is told by the team but speaks as the player ({found}): {line[kind]}"
            )


def test_a_check_that_did_not_finish_is_told_to_no_one() -> None:
    from pathlib import Path as _P

    from harness.adapters.challenge.stages import load_stages, player_view

    stages = load_stages(_P(GRADER / "checks.json"))
    for observed in (
        "Test timeout of 30000ms exceeded.",
        "AssertionError: Test timed out in 60000ms.",
        "Error: STACK_TRACE_ERROR",
    ):
        view = player_view(
            [{"check": "[F33] REQ-DOUBLES — a double", "observed": observed}],
            stages,
            is_infra=lambda c: False,
        )
        assert not view.visible, observed
        assert view.unevaluated == ["[F33] REQ-DOUBLES — a double"], observed
