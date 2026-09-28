"""The regression complaint class: "these were working last time, broken now."

A check that PASSED the immediately-previous graded round and fails now is the
model's own fix undoing code that worked — a different event from an ordinary
complaint, so each channel heads its regressed labels with its own opener
(_REGRESSION_HEADER / _TEAM_REGRESSION_HEADER) BEFORE the ordinary complaint
list, and with `regressions` empty the message is byte-identical to the shape
without it.

Three sections:

A. The runner-side classification (`_regressed_checks`): what counts as
   "passed last round". The previous round's `failed_gates` carries EVERY
   non-passing check — failing, withheld, unevaluated, `[needs:]`-blocked,
   stage-unlocked — so absence from it is the only way to be a regression; a
   degraded previous round graded nothing, and unchanged code cannot regress.
B. The message shape, driven through the real player_view →
   _build_feedback_prompt pipeline (the helper pattern and the check IDs are
   the ones tests/test_challenge_feedback_channels.py proved resolve to
   failure overrides), never through a stubbed composer.
C. The two new openers clear the same grader-vocabulary bar every other
   model-facing line does (tests/test_challenge_constraints.py GROUP 3).
"""

from __future__ import annotations

import pytest

from harness.adapters.challenge import ChallengeRunner as R
from harness.adapters.challenge.constants import (
    _CONSTRAINTS,
    _FEEDBACK_HEADER_FIRST,
    _FEEDBACK_HEADER_REPEAT,
    _GRADER_DIR,
    _REGRESSION_HEADER,
    _TEAM_HEADER,
    _TEAM_HEADER_ALONE,
    _TEAM_REGRESSION_HEADER,
)
from harness.adapters.challenge.runner import _regressed_checks
from harness.adapters.challenge.stages import load_stages, player_view

STAGES = load_stages(_GRADER_DIR / "checks.json")

# REAL check strings, all stage 1, each with a feedback override — the
# single-system contract hard-fails on synthetic labels in the real pipeline.
PIP = "[G02] REQ-PIP — pip count"  # tester channel
INIT = "[G01] REQ-INIT — initial position"  # tester channel
DOM = "REQ-TESTID/dom"  # team channel (conformance)
CHECKER = "REQ-TESTID/checker"  # team channel (conformance)

# Section A drives `_regressed_checks` directly, which never consults an
# override, so a synthetic string is fine there.
HINT = "[F04] REQ-HINT — hint"


def _problem(check: str) -> dict[str, str]:
    return {"check": check, "expected": "present", "observed": "missing"}


def _infra(check: str) -> bool:
    return R._is_harness_infra_check(check)


def _feedback(
    problems: list[dict[str, str]],
    *,
    regressions: set[str] | None = None,
    repeat_complaints: set[str] | None = None,
):
    """The real path, exactly as the runner drives it (runner.py): stage the
    problems with player_view, then hand the builder the visible problems plus
    the withheld, unevaluated and regressed checks."""
    view = player_view(problems, STAGES, is_infra=_infra)
    msg = R._build_feedback_prompt(
        problems=view.visible,
        repeat_complaints=repeat_complaints or set(),
        withheld=view.withheld,
        unevaluated=view.unevaluated,
        regressions=regressions,
    )
    return view, msg


# ── SECTION A — _regressed_checks CLASSIFICATION ────────────────────────────


def test_pass_then_fail_is_regression() -> None:
    # The previous round graded (changed code, no degradation) and did not
    # carry the check in failed_gates: it passed, and now it is told failing.
    reports = [{"state_hash": "h0"}, {"state_hash": "h1"}]
    assert _regressed_checks(reports, [_problem(HINT)]) == {HINT}


def test_fail_then_pass_then_fail_is_regression() -> None:
    # Only the IMMEDIATELY-previous graded round matters: HINT failed two
    # rounds ago, passed last round, and fails again now — that is a
    # regression, whatever the round before it said.
    reports = [
        {"state_hash": "h0", "failed_gates": [HINT]},
        {"state_hash": "h1", "failed_gates": []},
        {"state_hash": "h2", "failed_gates": [HINT]},
    ]
    assert _regressed_checks(reports, [_problem(HINT)]) == {HINT}


def test_fail_then_fail_is_not_regression() -> None:
    # It never worked: an ordinary complaint, not a regression.
    reports = [
        {"state_hash": "h0", "failed_gates": [HINT]},
        {"state_hash": "h1", "failed_gates": [HINT]},
    ]
    assert _regressed_checks(reports, [_problem(HINT)]) == set()


def test_unchanged_code_is_not_regression() -> None:
    # Identical state_hash: the same code cannot have regressed against
    # itself, whatever the two grade reports disagree about.
    reports = [
        {"state_hash": "same", "failed_gates": []},
        {"state_hash": "same", "failed_gates": [HINT]},
    ]
    assert _regressed_checks(reports, [_problem(HINT)]) == set()


def test_first_round_is_not_regression() -> None:
    # No previous round, nothing "was working": never a regression.
    reports = [{"state_hash": "h0", "failed_gates": []}]
    assert _regressed_checks(reports, [_problem(HINT)]) == set()


@pytest.mark.parametrize("flag", ["gate_timeout", "instrument_fault"])
def test_degraded_previous_round_is_not_regression(flag: str) -> None:
    # A degraded previous round graded nothing, so nothing is KNOWN to have
    # worked; its empty failed_gates must not read as a clean round.
    reports = [
        {"state_hash": "h0", "failed_gates": [], flag: True},
        {"state_hash": "h1", "failed_gates": [HINT]},
    ]
    assert _regressed_checks(reports, [_problem(HINT)]) == set()


def test_previous_withheld_or_unevaluated_is_not_regression() -> None:
    # The previous round's failed_gates carries EVERY non-passing check —
    # failing, withheld, unevaluated, `[needs:]`-blocked, stage-unlocked —
    # so absence from it is the ONLY way a check can be known to have passed
    # last round, and so the only way it can regress now. A check that sat in
    # prev failed_gates in any of those states is not a regression even
    # though it is visible (told) this round.
    reports = [
        {"state_hash": "h0", "failed_gates": [HINT]},
        {"state_hash": "h1", "failed_gates": []},
    ]
    assert _regressed_checks(reports, [_problem(HINT)]) == set()


# ── SECTION B — MESSAGE SHAPE (REAL PIPELINE) ───────────────────────────────


def test_regression_opener_heads_the_tester_list() -> None:
    view, msg = _feedback([_problem(PIP), _problem(INIT)], regressions={PIP})
    assert [p["check"] for p in view.visible] == [PIP, INIT]
    assert _REGRESSION_HEADER in msg
    assert msg.index(_REGRESSION_HEADER) < msg.index(_FEEDBACK_HEADER_FIRST), (
        "the regression opener heads the tester's message, before the "
        "ordinary complaint list's header"
    )
    # Two sightings by the same person, not one list with a divider: both
    # the regressed list and the ordinary list are numbered from 1.
    assert f"1) {R._humanize_check(PIP)}" in msg
    assert f"1) {R._humanize_check(INIT)}" in msg


def test_regression_only_emits_no_ordinary_header() -> None:
    # The ordinary header heads the ordinary list — with every tester
    # complaint regressed there is no ordinary list, so no ordinary header
    # (and no filler: the tester is not standing on nothing).
    _, msg = _feedback([_problem(PIP)], regressions={PIP})
    assert _REGRESSION_HEADER in msg
    assert _FEEDBACK_HEADER_FIRST not in msg
    assert _FEEDBACK_HEADER_REPEAT not in msg


def test_regression_uses_first_sighting_line_not_repeat() -> None:
    # A regression is always a FIRST sighting: the code that passed last
    # round was never complained about, so the "still" repeat line would be
    # a lie about history.
    _, msg = _feedback([_problem(PIP)], regressions={PIP})
    first = R._humanize_check(PIP)
    repeat = R._told_label({"check": PIP}, pass_kind="repeat")[0]
    assert first != repeat, "the fixture gate must carry two distinct lines"
    assert first in msg
    assert repeat not in msg


def test_team_regression_uses_team_opener() -> None:
    # The team's regressions head its section under the team's OWN regression
    # opener; with only the regression there is no ordinary team list, so the
    # "Also, my software team is trying to integrate…" header never appears.
    _, msg = _feedback([_problem(DOM)], regressions={DOM})
    assert _TEAM_REGRESSION_HEADER in msg
    assert _TEAM_HEADER not in msg


def test_team_regression_then_ordinary_uses_also() -> None:
    _, msg = _feedback([_problem(DOM), _problem(CHECKER)], regressions={DOM})
    assert _TEAM_REGRESSION_HEADER in msg
    assert _TEAM_HEADER in msg
    assert msg.index(_TEAM_REGRESSION_HEADER) < msg.index(_TEAM_HEADER), (
        "the team's regressed list heads its section, the ordinary list follows"
    )
    # _TEAM_HEADER_ALONE is only for a team opening cold; with the regression
    # list ahead of the ordinary one, the "Also," variant is correct.
    assert _TEAM_HEADER_ALONE not in msg


def test_tester_silent_plus_team_regression() -> None:
    """The silent-tester scenario of test_challenge_feedback_channels.py::
    test_a_tester_whose_checks_went_unevaluated_does_not_claim_a_clean_look —
    every player check stopped behind the team's finding — with the team's
    one visible finding told as a regression."""
    skipped = "never evaluated — an earlier step failed and skipped it"
    view, msg = _feedback(
        [
            {"check": "conformance:REQ-TESTID/testid.board", "observed": skipped},
            {"check": "conformance:REQ-RENDER/checker", "observed": skipped},
            {"check": DOM, "observed": "missing"},
        ],
        regressions={DOM},
    )
    assert [p["check"] for p in view.visible] == [DOM]
    assert "conformance:REQ-RENDER/checker" in view.unevaluated
    # The tester says nothing at all — not even the clean-look filler.
    assert "Nothing jumped out" not in msg
    assert _FEEDBACK_HEADER_FIRST not in msg
    # The team opens on its regression, so neither team header variant for an
    # ordinary list appears.
    assert _TEAM_HEADER_ALONE not in msg
    assert _TEAM_REGRESSION_HEADER in msg
    assert f"1) {R._humanize_check(DOM)}" in msg, "the team regression line is present"


def test_keep_list_still_last() -> None:
    # The integration surface closes EVERY repair message variant, regression
    # openers included — exactly once, as the last paragraph.
    for problems, regressions in (
        ([_problem(PIP), _problem(INIT)], {PIP}),
        ([_problem(DOM), _problem(CHECKER)], {DOM}),
    ):
        _, msg = _feedback(problems, regressions=regressions)
        assert msg.endswith(_CONSTRAINTS)
        assert msg.count(_CONSTRAINTS) == 1


def test_no_regression_is_silent() -> None:
    # With `regressions` empty or absent the message is byte-identical to the
    # shape without the feature, and the regression opener never appears.
    _, none_msg = _feedback([_problem(PIP)], regressions=None)
    _, empty_msg = _feedback([_problem(PIP)], regressions=set())
    assert none_msg == empty_msg
    assert _REGRESSION_HEADER not in none_msg


# ── SECTION C — GRADER-VOCABULARY GUARD OVER THE TWO NEW OPENERS ────────────
#
# The same forbidden terms the existing voice guards use
# (tests/test_challenge_constraints.py::_GRADER_VOCABULARY). The openers are
# model-facing text like every other line the repair message carries: a model
# that can tell it is being measured is not the model this run is measuring.

_GRADER_VOCABULARY = (
    "conformance",
    "pre-gate",
    "gate",
    "harness",
    "benchmark",
    "grader",
    "test suite",
    "assertion",
    "expected value",
    "pass/fail",
)


def test_regression_openers_are_not_the_graders_vocabulary() -> None:
    for text in (_REGRESSION_HEADER, _TEAM_REGRESSION_HEADER):
        lowered = text.lower()
        for word in _GRADER_VOCABULARY:
            assert word not in lowered, (
                f"the regression opener says {word!r} — that is the harness's "
                "vocabulary, not a customer's, and it tells the model it is "
                "being measured"
            )
        assert "REQ-" not in text, (
            "the regression opener names a requirement id — that is the "
            "grader talking, the same tell the failure-line guards reject"
        )
