"""Feedback voice, gradient, and the gate-timeout disposition (WO-FEEDBACK-1).

These pin the three properties that decide what the benchmark actually measures:

* the model hears a PERSON, not a grader (no `[G05]`, no `conformance:`);
* a repeated failure returns NEW information, so the loop has a gradient;
* a killed gate is recorded as a killed gate, never as a model failure.

The artifacts keep the grader ids in every case — the humanising is a property
of the delivered TEXT only, and a test that let it leak into `failed_gates`
would be pinning the wrong thing.
"""

from __future__ import annotations

import json

import pytest

from harness.adapters.challenge import ChallengeRunner


def _told(checks):
    """What the runner records as told for each check (runner.py told_first_label)."""
    from harness.adapters.challenge import ChallengeRunner as _R

    return {
        c: _R._told_label({"check": c}, pass_kind="first")[0]
        for c in checks
        if not _R._is_harness_infra_check(c)
    }



# ── voice ────────────────────────────────────────────────────────────────────


def test_grader_identity_is_stripped_from_delivered_text() -> None:
    """SINGLE-SYSTEM (WO-FEEDBACK-VOICE-3): the model hears the human-written
    symptom line, never the test title. A user does not say "[G05] REQ-HIGHER-DIE"."""
    from harness.adapters.challenge import load_feedback_overrides_from_failures
    from pathlib import Path

    overrides = load_feedback_overrides_from_failures(
        Path(__file__).resolve().parents[1] / "task" / "backgammon" / "prompts"
    )
    # A covered gate resolves to its human-written override, and no grader
    # identity leaks into the delivered text.
    for check, token in (
        ("[G05] REQ-HIGHER-DIE — use higher die", "G05"),
        ("[F01] REQ-RENDER — page loads, no console errors", "F01"),
        ("[E01] REQ-DOUBLES — doubles are played as four plies", "E01"),
    ):
        text = ChallengeRunner._humanize_check(check)
        assert text == overrides[token]["first"]
        assert "[G05]" not in text and "REQ-" not in text and "F01" not in text
    # Conformance carries a phase namespace and a slashed REQ token. It resolves
    # to ITS OWN line when one exists (2026-09-05) — previously every one of the
    # ~34 checks fell through to the broad CONF override, which is how eleven
    # distinct findings were delivered as the single sentence "The game doesn't
    # seem to start up correctly at all".
    conf = ChallengeRunner._humanize_check(
        'conformance:REQ-TESTID/checker — board renders 30 data-testid "checker" elements'
    )
    assert conf == overrides["REQ-TESTID/checker"]["first"]
    assert conf != overrides["CONF"]["first"], "a specific line must beat the catch-all"

    # THE INVARIANT THIS TEST IS NAMED FOR, unchanged and now checked on both
    # channels: whatever resolves, no grader identity reaches the model.
    for check in (
        'conformance:REQ-TESTID/checker — board renders 30 data-testid "checker" elements',
        "conformance:REQ-STATE/state.winType — /api/state carries winType",
        "conformance:REQ-RENDER/die — the dice are shown after a roll",
        "conformance:REQ-BIND/boot — server boots and listens on :8002",
    ):
        text = ChallengeRunner._humanize_check(check)
        assert "REQ-" not in text and "conformance:" not in text and "data-testid" not in text

    # The broad CONF override survives as the CATCH-ALL for a conformance check
    # with no line of its own, and no longer claims a boot failure — REQ-BIND/boot
    # owns that, and CONF claiming it was the original defect.
    unknown = ChallengeRunner._humanize_check("conformance:REQ-FUTURE/something.new — a check added later")
    assert unknown == overrides["CONF"]["first"]


def test_humanize_hard_fails_on_an_uncovered_gate() -> None:
    """SINGLE-SYSTEM (WO-FEEDBACK-VOICE-3): there is NO title-derived fallback.
    A gate with no override RAISES `MissingFeedbackOverrideError` — a leaky
    title-derived line is worse than no line, because it answers the question
    the gate exists to ask."""
    from harness.adapters.challenge import MissingFeedbackOverrideError

    with pytest.raises(MissingFeedbackOverrideError):
        ChallengeRunner._humanize_check("[ZZ9] REQ-NOTHING — some synthetic gate")
    with pytest.raises(MissingFeedbackOverrideError):
        ChallengeRunner._humanize_check("frontend:boot")
    with pytest.raises(MissingFeedbackOverrideError):
        ChallengeRunner._humanize_check("something plain")
    with pytest.raises(MissingFeedbackOverrideError):
        ChallengeRunner._humanize_check("")


def test_pass_verdict_no_longer_truncates_mid_word() -> None:
    """The old 80-char hard slice cut mid-phrase and left a dangling space —
    a tell that no human wrote the line."""
    long_gate = (
        "[G10] REQ-WINCLASS — classifies backgammon when the loser still has a checker "
        "sitting on the bar at the moment the winner bears off the final checker"
    )
    out = ChallengeRunner._build_pass_verdict(newly_passing=[long_gate], told=_told([long_gate]))
    assert "[G10]" not in out
    assert "REQ-WINCLASS" not in out
    assert not out.rstrip("…").endswith(" "), (
        "must not end on a dangling mid-word space"
    )
    assert out.startswith("That fixed it —")


# ── gradient ─────────────────────────────────────────────────────────────────


def _problems() -> list[dict[str, str]]:
    return [
        {
            "check": "[G05] REQ-HIGHER-DIE — use higher die",
            "expected": "higher die used",
            "observed": "AssertionError: expected 2 to be 4 // Object.is equality",
        },
        {
            "check": "[F14] REQ-ANIM — animation present",
            "expected": "gate passes",
            "observed": "expected false to be true",
        },
    ]


def test_first_failure_is_the_players_first_report() -> None:
    """Inferring the implementation from the symptom is the thing being
    measured; handing over the assertion answers it for free. The first report
    is the player's `first` line — the surface and the wrongness, never the
    rule — under the opener that says this is their first pass. Every failure
    verdict now also opens with the excuse eliminator (the clean-browser fact),
    which precedes the opener."""
    from harness.adapters.challenge import _EXCUSE_ELIMINATOR

    text = ChallengeRunner._build_feedback_prompt(
        problems=_problems(), repeat_complaints=set()
    )
    assert text.startswith(_EXCUSE_ELIMINATOR)
    assert (
        "I've checked your work thoroughly, and I want to list the issues that "
        "I've encountered while playing the game:" in text
    )
    assert "let me move with the smaller number even though the bigger one had a move too" in text
    assert "pieces don't animate when they move" in text
    # Grader vocabulary a player would never use.
    assert "FAILING" not in text
    # And the old bullet glue, which only existed to chain bullets together.
    assert "\n- " not in text and "also the" not in text


def test_repeat_failure_returns_new_information() -> None:
    """THE GRADIENT. Attempt N and N+1 must not produce identical text, or a
    failed fix teaches the model nothing and it cannot tell 'closer' from 'no
    change' across the attempt ceiling.

    The new information is the same person's SECOND SIGHTING of the same fault,
    not the grader's assertion — see `test_the_graders_assertion_never_reaches_the_model`.
    """
    from harness.adapters.challenge import _EXCUSE_ELIMINATOR

    problems = _problems()
    first = ChallengeRunner._build_feedback_prompt(
        problems=problems, repeat_complaints=set()
    )
    repeat = ChallengeRunner._build_feedback_prompt(
        problems=problems,
        repeat_complaints={p["check"] for p in problems},
    )
    assert first != repeat, "a repeated failure must not return identical text"
    # The excuse eliminator is identical on both — it is a constant fact about
    # grading, not a sighting — and the repeat opener follows it.
    assert repeat.startswith(_EXCUSE_ELIMINATOR)
    assert (
        "I've checked your resolution for the problems that were given before, "
        "played the game in full again, and I'm still seeing these problems:" in repeat
    )
    assert (
        "I've checked your work thoroughly, and I want to list the issues that "
        "I've encountered while playing the game:" not in repeat
    )
    # Every listed line changed — each gate swapped to its own second sighting.
    first_items = [ln for ln in first.splitlines() if ln[:2] in ("1)", "2)")]
    repeat_items = [ln for ln in repeat.splitlines() if ln[:2] in ("1)", "2)")]
    assert len(first_items) == len(repeat_items) == 2
    assert all(a != b for a, b in zip(first_items, repeat_items))


def test_the_graders_assertion_never_reaches_the_model() -> None:
    """THE LEAK THAT WAS REMOVED (2026-09-02).

    The repeat gradient used to append one sanitised line of the grader's own
    assertion. It carried real information and it stated the RULE — the single
    thing `feedback.json` exists to withhold — so a gate could answer itself and
    the loop measured attempt count rather than capability. `observed` is now
    read by nothing in the prompt path; this pins that, including the host paths
    the old sanitiser existed to strip.
    """
    problems = [
        {
            "check": "[E08] REQ-SEQ-DEDUP — sequences are distinct by resulting board",
            "observed": (
                "AssertionError: expected 4 to be 2 // Object.is equality at "
                "/Users/x/bench/grader/backend/edge/edge-gates.test.ts:171:23"
            ),
        }
    ]
    for repeats in (set(), {problems[0]["check"]}):
        text = ChallengeRunner._build_feedback_prompt(
            problems=problems, repeat_complaints=repeats
        )
        assert "expected 4 to be 2" not in text, "the assertion reached the model"
        assert "AssertionError" not in text
        assert "Object.is equality" not in text
        assert "/Users/" not in text
        assert "edge-gates.test.ts" not in text
        assert "I'm still seeing:" not in text


def test_repeat_matching_is_keyed_on_the_raw_gate_id() -> None:
    """Humanised labels are lossy; the repeat set must match on the same strings
    `failed_gates` carries or the gradient silently never fires."""
    problems = _problems()
    # The HUMANISED label, deliberately — this must NOT be treated as a repeat.
    text = ChallengeRunner._build_feedback_prompt(
        problems=problems, repeat_complaints={"use higher die"}
    )
    # A repeat that failed to match leaves every gate on its FIRST line.
    assert "let me move with the smaller number even though the bigger one had a move too" in text
    assert "while the bigger one also had a move" not in text


def test_empty_checks_never_claims_a_clean_run() -> None:
    text = ChallengeRunner._build_feedback_prompt(problems=[], repeat_complaints=set())
    assert "1) Something is still broken" in text, (
        "a FAIL verdict with no itemised checks is still a failure"
    )


def test_legacy_checks_kwarg_still_works() -> None:
    """Older callers pass a bare list; they must keep working unchanged. The
    label is the human-written override, not the title."""
    text = ChallengeRunner._build_feedback_prompt(
        checks=["[G01] REQ-INIT — initial position"]
    )
    assert "1) When i start a new game the setup isn't how a real game starts" in text


# ── harness-infra check names are not gates ──────────────────────────────────


def test_runner_death_check_does_not_abort_feedback_composition() -> None:
    """MEASURED CAMPAIGN CRASH (run 1788122095, 2026-08-30). The gates-13-16
    backend runner was killed externally (SIGTERM); report.mjs correctly
    recorded `backend:runner backend/gates-13-16.test.ts` alongside the real
    [F12] failure. That check name then reached `_build_feedback_prompt`,
    `_humanize_check` raised MissingFeedbackOverrideError for token '??', and
    the exception propagated out of run_cell — aborting the campaign with a
    traceback AFTER the graded attempt was already on disk, so the model never
    got its attempt-4 repair turn.

    Runner-death check names are born only when a runner dies mid-run, so the
    preflight can never pin a feedback line for them. They must be filtered
    from feedback composition — while REMAIN in `failed_gates`/`problems`,
    which the scored artifacts keep untouched.
    """
    from harness.adapters.challenge import MissingFeedbackOverrideError

    infra = "backend:runner backend/gates-13-16.test.ts"
    problems = [
        {
            "check": infra,
            "expected": "backend gates execute and pass",
            "observed": "runner killed by SIGTERM — reported 0 of 38 gate results",
        },
        {
            "check": "[F12] REQ-NEWGAME — win state + new game without reload",
            "expected": "gate passes",
            "observed": "Error: expect(locator).toHaveCount(expected) failed",
        },
    ]
    # The exact crash input must now compose, dropping ONLY the infra line.
    text = ChallengeRunner._build_feedback_prompt(
        problems=problems, repeat_complaints=set()
    )
    assert "doesn't tell me I won" in text, "the real gate keeps its voice"
    assert "gates-13-16" not in text, "the runner-death line never reaches the model"

    # All four born-on-runner-death shapes are recognised, wherever they appear.
    #
    # `conformance:runner` replaced `conformance:boot` (2026-09-05). The old name
    # rode a FABRICATED problem the conformance phase invented whenever it
    # failed unreadably, and it asserted a boot failure — a claim about the code
    # under test — while letting the attempt publish as GRADABLE. The phase now
    # reports itself unreadable, the attempt is marked ungradable like an
    # aborted backend runner, and the name says only that the runner could not
    # be read.
    for check in (
        "backend:runner backend/gates-13-16.test.ts",
        "backend:report-parse backend/gates-01-08.test.ts",
        "frontend:boot",
        "conformance:runner",
    ):
        assert ChallengeRunner._is_harness_infra_check(check), check

    # And the fabricated name is gone for good: nothing emits it, so nothing may
    # quietly treat it as infra either.
    assert not ChallengeRunner._is_harness_infra_check("conformance:boot")

    # Real gates and conformance sub-checks are NOT infra.
    assert not ChallengeRunner._is_harness_infra_check(
        "[F12] REQ-NEWGAME — win state + new game without reload"
    )
    assert not ChallengeRunner._is_harness_infra_check(
        "conformance:REQ-HINT/hint — selecting a movable checker shows one hint"
    )

    # The single-system contract over GATES is untouched: an unknown gate id
    # still hard-fails, and an infra name routed to _humanize_check directly
    # still raises (naming the wrong system) rather than resolving.
    with pytest.raises(MissingFeedbackOverrideError):
        ChallengeRunner._humanize_check("[ZZ9] REQ-NOTHING — synthetic")
    with pytest.raises(MissingFeedbackOverrideError):
        ChallengeRunner._humanize_check(infra)

    # The pass-verdict path (same _humanize_check exposure) skips infra names
    # instead of crashing, and still voices real gates.
    verdict = ChallengeRunner._build_pass_verdict(newly_passing=[infra, "[F12] REQ-NEWGAME — win state + new game without reload"], told=_told([infra, "[F12] REQ-NEWGAME — win state + new game without reload"]))
    assert "doesn't tell me I won" in verdict
    assert "gates-13-16" not in verdict


def test_repeat_gradient_ignores_harness_infra_checks() -> None:
    """A runner that dies two attempts in a row is a repeat HARNESS failure.
    The gradient swaps a repeated GATE to its second-sighting line; an infra
    name must neither crash repeat-set construction nor present the gate
    tooling as model-repairable work."""
    infra = "backend:runner backend/gates-13-16.test.ts"
    gate = "[F12] REQ-NEWGAME — win state + new game without reload"
    problems = [
        {
            "check": infra,
            "expected": "backend gates execute and pass",
            "observed": "killed",
        },
        {
            "check": gate,
            "expected": "gate passes",
            "observed": "expected 2, received 0",
        },
    ]
    text = ChallengeRunner._build_feedback_prompt(
        problems=problems,
        repeat_complaints={infra, gate},
    )
    assert "still doesn't show me a win message" in text, (
        "the real gate keeps its gradient and moves to its second sighting"
    )
    assert "gates-13-16" not in text, "the runner-death line never reaches the model"
    assert "killed" not in text
    # Exactly one complaint is listed: the infra name is dropped, not voiced.
    assert [ln for ln in text.splitlines() if ln[:2] == "1)"]
    assert not [ln for ln in text.splitlines() if ln[:2] == "2)"]


def test_every_failure_verdict_opens_with_how_the_player_checked() -> None:
    """Every failure verdict opens with how the player checked — on the FIRST
    report and on every repeat, and never on the pass verdict.

    NAMING AN EXCUSE PLANTS IT (run 1789564423). The opener used to name the
    excuses it meant to prevent: cache, hard refresh, stale page, leftover
    files. Together with a note that "a running server keeps the old code", the
    model told the player to restart the server and hard-refresh. The opener now
    states the fact and names nothing."""
    from harness.adapters.challenge import _EXCUSE_ELIMINATOR

    problems = _problems()
    first = ChallengeRunner._build_feedback_prompt(problems=problems)
    repeat = ChallengeRunner._build_feedback_prompt(
        problems=problems,
        repeat_complaints={p["check"] for p in problems},
    )
    for verdict in (first, repeat):
        assert verdict.startswith(_EXCUSE_ELIMINATOR)
        assert "latest code from scratch" in verdict
        assert "brand-new game" in verdict
        for planted in ("refresh", "cache", "stale", "leftover", "restart"):
            assert planted not in verdict.lower(), f"the opener names an excuse: {planted}"

    verdict = ChallengeRunner._build_pass_verdict(newly_passing=["[G05] REQ-HIGHER-DIE — use higher die"], told=_told(["[G05] REQ-HIGHER-DIE — use higher die"]))
    assert _EXCUSE_ELIMINATOR not in verdict


# ── the honesty boundary ─────────────────────────────────────────────────────


def test_gate_timeout_is_a_named_disposition_not_a_model_failure() -> None:
    """A killed gate measured NOTHING. Recording it as an ordinary FAIL would
    attribute a harness death to the model under test.

    `GateTimeoutError` was previously raised and never caught anywhere in the
    repo, so a timed-out gate aborted the campaign and the one genuinely
    'impractical, not impossible' event was the outcome the record could not
    express.
    """
    import inspect

    src = inspect.getsource(ChallengeRunner._run_cell_impl)
    assert "except GateTimeoutError" in src, (
        "the timeout must be caught, not propagated"
    )
    assert 'termination_reason = "gate_timeout"' in src
    assert 'attempts_to_green = "GATE_TIMEOUT"' in src
    # The attempt record must NOT invent failures for gates that never ran.
    assert '"failed_gates": []' in src
    assert '"gate_results": None' in src, (
        "None (not published) ≠ [] (published and empty)"
    )


def test_user_event_sidecar_records_kind_and_verbatim_text(tmp_path) -> None:
    """The sidecar is the ONLY place the exact bytes handed to the model are
    preserved; the PROGRESS log carries a length and a fingerprint, not the
    body."""
    runner = ChallengeRunner.__new__(ChallengeRunner)
    runner._progress = lambda _msg: None

    sidecar = tmp_path / "worktree.user-events.jsonl"
    body = (
        "These are still failing — fix the implementation.\n\n- use higher die: FAILING"
    )
    runner._append_user_event(
        run_label="rl", sidecar_path=sidecar, attempt=2, text=body, kind="feedback"
    )

    record = json.loads(sidecar.read_text(encoding="utf-8").strip())
    assert record["kind"] == "feedback"
    assert record["attempt"] == 2
    assert record["text"] == body, "VERBATIM — never re-wrapped or trimmed"
    assert record["chars"] == len(body)
    assert record["text_fp"]
