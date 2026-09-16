from __future__ import annotations

from pathlib import Path

import pytest

from harness.adapters.challenge import (
    _EXCUSE_ELIMINATOR,
    ChallengeRunner,
    MissingFeedbackOverrideError,
    load_feedback_overrides,
)

FEEDBACK = (
    Path(__file__).resolve().parents[1]
    / "grader"
    / "feedback.json"
)


def _override(token: str, kind: str = "first") -> str:
    return load_feedback_overrides(FEEDBACK)[token][kind]


def test_build_pass_verdict_lists_what_is_no_longer_happening() -> None:
    # WO-FEEDBACK-VOICE-3: grader identity is STRIPPED from delivered text. A
    # user does not say "[G01]". Under the single-system contract every item is
    # a real gate resolving to its human-written symptom line. The tokens survive
    # in `failed_gates` and the roster, which is where anything that needs to
    # address a gate precisely reads them.
    assert ChallengeRunner._build_pass_verdict(newly_passing=[]) == ""

    # A FIXED complaint is named by the gate's FIRST line: the player is
    # referring back to what they originally reported.
    e07 = _override("E07")
    g07 = _override("G07")

    single = ChallengeRunner._build_pass_verdict(
        newly_passing=["[E07] REQ-ALLINHOME-BAR — bar not all home"]
    )
    assert single == (
        f"That fixed it — I'm not running into this any more:\n\n1) {e07}"
    )
    assert "[E07]" not in single and "REQ-" not in single

    multi = ChallengeRunner._build_pass_verdict(
        newly_passing=[
            "[E07] REQ-ALLINHOME-BAR — bar not all home",
            "[G07] REQ-HIT — hit to bar",
        ]
    )
    assert multi == (
        f"That fixed it — I'm not running into these any more:\n\n1) {e07}\n2) {g07}"
    )
    assert "[E" not in multi and "REQ-" not in multi

    # THE SENTENCE THIS REPLACED was "That fixed it — {symptom} works now",
    # which rendered as "That fixed it — Sometimes the same die gets used twice
    # in one turn works now." — a symptom describes the PROBLEM, so appending
    # "works now" to one says the opposite of what it means.
    assert "works now" not in multi and "all pass now" not in multi


def test_build_pass_verdict_bounds_a_mass_pass() -> None:
    """Naming what got fixed is the signal that stops the model undoing it, so
    the list is generous — but a mass pass must not turn one message into a
    wall of text."""
    from harness.adapters.challenge import _PASS_VERDICT_MAX_LISTED

    gates = [f"[F{i:02d}] REQ-X — frontend gate {i}" for i in range(1, 15)]
    assert len(gates) > _PASS_VERDICT_MAX_LISTED
    verdict = ChallengeRunner._build_pass_verdict(newly_passing=gates)

    numbered = [ln for ln in verdict.splitlines() if ln[:1].isdigit()]
    assert len(numbered) == _PASS_VERDICT_MAX_LISTED
    remaining = len(gates) - _PASS_VERDICT_MAX_LISTED
    assert f"({remaining} other things I mentioned look fine now too.)" in verdict


def test_build_pass_verdict_hard_fails_on_an_uncovered_gate() -> None:
    """A pass-verdict item with no override is a misconfigured benchmark, not a
    thing to route around — it would otherwise leak the gate's title."""
    with pytest.raises(MissingFeedbackOverrideError):
        ChallengeRunner._build_pass_verdict(
            newly_passing=["[ZZ9] REQ-NOTHING — some gate"]
        )


def test_build_feedback_prompt_openers_and_invariants() -> None:
    g01 = _override("G01")
    g02 = _override("G02")
    g03 = _override("G03")

    FIRST = (
        "I've checked your work thoroughly, and I want to list the issues that "
        "I've encountered while playing the game:"
    )
    AGAIN = (
        "I've checked your resolution for the problems that were given before, "
        "played the game in full again, and I'm still seeing these problems:"
    )

    # THE EXCUSE ELIMINATOR (2026-09-04): every failure verdict OPENS with the
    # clean-browser fact, so the model cannot deflect to a stale page or a
    # hard-refresh. The opener follows it, and the numbered complaints last.
    first = ChallengeRunner._build_feedback_prompt(
        checks=["[G01] REQ-INIT — initial position"]
    )
    assert first.startswith(_EXCUSE_ELIMINATOR)
    assert FIRST in first
    assert f"1) {g01}" in first
    assert "REQ-INIT" not in first and "[G01]" not in first

    # THE OPENER IS KEYED ON PRIOR FEEDBACK, not on whether anything newly
    # passed. A second round where nothing improved must still open by
    # referring back to what was already reported. The eliminator is the only
    # shared opening paragraph — the opener itself still distinguishes the two.
    again = ChallengeRunner._build_feedback_prompt(
        checks=["[G01] REQ-INIT — initial position"], had_prior_feedback=True
    )
    assert again.startswith(_EXCUSE_ELIMINATOR)
    assert AGAIN in again
    assert FIRST not in again, "the repeat verdict must not use the first-report opener"

    # Dedup: two checks sharing a token resolve to the same line and collapse to
    # one numbered item, and the numbering stays contiguous across the drop.
    prompt = ChallengeRunner._build_feedback_prompt(
        checks=[
            "[G01] REQ-INIT — initial position\nignored second line",
            "[G01] REQ-INIT — same gate, duplicate",
            "[G02] REQ-PIP — pip count",
            "[G03] REQ-DICE — dice to moves",
        ],
        had_prior_feedback=False,
    )
    lines = prompt.splitlines()
    assert lines[0] == _EXCUSE_ELIMINATOR
    assert lines[1] == ""
    assert lines[2] == FIRST
    assert lines[3] == ""
    assert lines[4:] == [f"1) {g01}", f"2) {g02}", f"3) {g03}"]

    empty = ChallengeRunner._build_feedback_prompt(checks=[])
    assert empty == (
        f"{_EXCUSE_ELIMINATOR}\n"
        "\n"
        f"{FIRST}\n"
        "\n"
        "1) Something is still broken but I couldn't pin down what it was."
    )
