"""PLAYER ORDER: the model hears only the earliest failing stage's problems.

Every check the grader can report must have a stage — which stage it is in
decides whether the model hears about it (harness/adapters/challenge/stages.py).
"""

from __future__ import annotations

import json

import pytest

from harness.adapters.challenge import ChallengeRunner
from harness.adapters.challenge.constants import _GRADER_DIR
from harness.adapters.challenge.feedback import gate_tokens_in_suite
from harness.adapters.challenge.stages import (
    UnstagedCheckError,
    load_stages,
    player_view,
    stage_of,
)

STAGES = load_stages(_GRADER_DIR / "checks.json")


def _infra(check: str) -> bool:
    return ChallengeRunner._is_harness_infra_check(check)


def test_every_gate_token_in_the_suite_has_a_stage() -> None:
    for token in sorted(gate_tokens_in_suite(_GRADER_DIR)):
        if token == "CONF":
            continue
        stage_of(f"[{token}] x", STAGES)


def test_every_complaint_key_and_every_drawn_or_tagged_element_has_a_stage() -> None:
    keys = [k for k in json.loads((_GRADER_DIR / "feedback.json").read_text())["gates"] if k != "CONF"]
    for label in ("point", "checker", "bar", "off-tray", "die"):
        keys += [f"REQ-RENDER/{label}", f"REQ-TESTID/{label}"]
    keys += ["REQ-TESTID/testid.anything", "REQ-STATE/state.anything"]
    for key in keys:
        check = key if key.startswith("REQ-") else f"[{key}] x"
        stage_of(check, STAGES)


def test_the_most_specific_key_wins() -> None:
    assert stage_of("conformance:REQ-TESTID/die — dice tagged", STAGES).number == 3
    assert stage_of("conformance:REQ-TESTID/testid.board — tagged", STAGES).number == 1


def test_an_undeclared_check_is_refused_not_guessed() -> None:
    with pytest.raises(UnstagedCheckError):
        stage_of("[Z99] nothing", STAGES)


def test_only_the_earliest_failing_stage_is_told() -> None:
    problems = [
        {"check": "[G08] REQ-BEAROFF — bear-off"},  # stage 5
        {"check": "[G01] REQ-INIT — initial position"},  # stage 2
        {"check": "[F06] REQ-PIPUI — pips on screen"},  # stage 2
        {"check": "[G14] REQ-AISTRENGTH — hard beats easy"},  # stage 8
    ]
    view = player_view(problems, STAGES, is_infra=_infra)
    assert view.stage is not None and view.stage.number == 2
    assert [p["check"][:5] for p in view.visible] == ["[G01]", "[F06]"]
    assert len(view.withheld) == 2


def test_a_clean_stage_unlocks_the_next_failing_one_skipping_clean_stages() -> None:
    view = player_view([{"check": "[G10] REQ-WINCLASS — x"}, {"check": "[G14] x"}], STAGES, is_infra=_infra)
    assert view.stage is not None and view.stage.number == 6


def test_runner_deaths_are_never_staged_or_told() -> None:
    view = player_view([{"check": "backend:runner backend/gates-13-16.test.ts"}], STAGES, is_infra=_infra)
    assert view.stage is None and view.visible == [] and view.withheld == []
