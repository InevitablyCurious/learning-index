"""The repair message carries two people, and each may only say what they could see.

THE DEFECT THIS PINS (run 1788599410, attempt 1). Eleven conformance findings —
eight missing `/api/state` fields, a debug hook and two DOM handles — were all
keyed to the single `CONF` gate, so all eleven rendered the same sentence and ten
were deduped away. What reached the model was:

    1) The game doesn't seem to start up correctly at all

...followed by fifteen complaints about hitting checkers, pip counts and the
doubling cube — every one of them an observation that requires a game that
started and was played. 36 gates passed in that same attempt, including
`[G11] REQ-CUBE-STATE — new game starts with centered cube`.

The line was not merely vague, it was FALSE, and it was false because a player
was made to describe something no player can see. The fix is a second human, not
a machine block: a software team integrating against the app, who can honestly
report a missing field.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from harness.adapters.challenge import (
    ChallengeRunner as R,
    load_feedback_overrides_from_failures,
)
from harness.adapters.challenge.constants import _GRADER_DIR
from harness.adapters.challenge.stages import load_stages, player_view

GATES = Path(__file__).resolve().parents[1] / "grader"
STAGES = load_stages(_GRADER_DIR / "checks.json")


def _problem(check: str) -> dict[str, str]:
    return {"check": check, "expected": "present", "observed": "missing"}


def _infra(check: str) -> bool:
    return R._is_harness_infra_check(check)


def _feedback(problems: list[dict[str, str]]):
    """The real path, exactly as the runner drives it (runner.py): stage the
    problems with player_view, then hand the builder the visible problems plus
    the withheld and unevaluated checks."""
    view = player_view(problems, STAGES, is_infra=_infra)
    msg = R._build_feedback_prompt(
        problems=view.visible,
        repeat_complaints=set(),
        withheld=view.withheld,
        unevaluated=view.unevaluated,
    )
    return view, msg


def test_the_channel_is_decided_in_one_place() -> None:
    # Both the prompt builder and the voice guards route on this function. Two
    # classifiers would let a line be judged by one bar and delivered under the
    # other.
    assert R.feedback_channel("conformance:REQ-STATE/state.winType — x") == "team"
    assert R.feedback_channel("conformance:REQ-TESTID/testid.board — x") == "team"
    assert R.feedback_channel("conformance:REQ-DEBUG/debug.roll — x") == "team"
    assert R.feedback_channel("conformance:REQ-BIND/health — x") == "team"
    # Visible while playing.
    assert R.feedback_channel("conformance:REQ-RENDER/die — x") == "tester"
    assert R.feedback_channel("conformance:REQ-HINT/hint — x") == "tester"
    assert R.feedback_channel("conformance:REQ-BIND/boot — x") == "tester"
    # Every ordinary gate is a played-game symptom. The team is an addition,
    # never a reclassification.
    assert R.feedback_channel("[G07] REQ-HIT — hitting → bar") == "tester"
    assert R.feedback_channel("[F14] REQ-ANIM — animation present") == "tester"


def test_a_missing_field_is_never_reported_as_a_boot_failure() -> None:
    """The exact regression, stated as the thing that must not happen again."""
    msg = R._build_feedback_prompt(
        problems=[
            _problem(
                'conformance:REQ-STATE/state.winType — /api/state carries "winType"'
            )
        ],
    )
    assert "doesn't seem to start up" not in msg
    assert "come up at all" not in msg
    assert "winType" in msg, "the field is named — it was already in the build spec"


def test_the_two_lists_are_separate_and_each_numbered_from_one() -> None:
    msg = R._build_feedback_prompt(
        problems=[
            _problem("[G07] REQ-HIT — hitting → bar"),
            _problem(
                'conformance:REQ-STATE/state.winType — /api/state carries "winType"'
            ),
            _problem(
                'conformance:REQ-STATE/state.turnOver — /api/state carries "turnOver"'
            ),
        ],
    )
    tester_part, _, team_part = msg.partition("my software team")
    assert "1)" in tester_part and "2)" not in tester_part, "one tester complaint"
    # Two accounts, not one list with a divider — the team starts at 1 again.
    assert "1)" in team_part and "2)" in team_part


def test_the_team_section_is_absent_when_the_team_has_nothing_to_say() -> None:
    # Announcing an integration attempt and listing nothing is a sentence with no
    # content, and it still hands the model a party to argue with.
    msg = R._build_feedback_prompt(
        problems=[_problem("[G07] REQ-HIT — hitting → bar")],
    )
    assert "software team" not in msg


def test_a_tester_whose_checks_went_unevaluated_does_not_claim_a_clean_look() -> None:
    """Run 1790597957, round 2: the page dropped every tag the team reads, every
    player check of the board stopped behind that finding, and the tester said
    "Nothing jumped out at me this time while I was playing" of a board drawn as
    four coloured blocks. What a player sees there is unknown: the team speaks
    alone, and its opener no longer begins "Also"."""
    skipped = "never evaluated — an earlier step failed and skipped it"
    view, msg = _feedback(
        [
            {"check": "conformance:REQ-TESTID/testid.board", "observed": skipped},
            {"check": "conformance:REQ-RENDER/checker", "observed": skipped},
            {
                "check": "conformance:REQ-TESTID/dom — page DOM exposes the required testids",
                "observed": "missing",
            },
        ]
    )
    assert [p["check"].split(" ")[0] for p in view.visible] == [
        "conformance:REQ-TESTID/dom"
    ]
    assert "conformance:REQ-RENDER/checker" in view.unevaluated
    assert "Nothing jumped out" not in msg
    assert "while playing the game" not in msg, "no tester opener promising a list"
    assert "Also, my software team" not in msg, "the team opens alone, without 'Also'"
    assert "My software team" in msg
    assert "isn't there to find" in msg, "the team line (and its note) is present"


@pytest.mark.parametrize(
    "observed",
    [
        "Error: SETUP REFUSED: /api/debug/state did not take difficulty (sent difficulty)",
        "Error: POST /api/new failed (500)",
    ],
)
def test_a_tester_check_told_in_the_teams_voice_still_silences_the_tester(
    observed: str,
) -> None:
    """D1: a player-visible check whose finding is a refused setup or a failed
    API call is TOLD in the team's voice, but it is still a player check — the
    tester had something they could not say, so they say nothing."""
    view, msg = _feedback(
        [
            {
                "check": "[F02] REQ-RENDER — start game renders full board",
                "observed": observed,
            }
        ]
    )
    assert view.visible and view.visible[0]["check"].startswith("[F02]")
    assert "Nothing jumped out" not in msg
    assert "while playing the game" not in msg
    assert "Also, my software team" not in msg
    assert "My software team" in msg


def test_a_later_stage_tester_failure_silences_the_tester() -> None:
    """D5: the tester's complaint is a later stage the player never reached —
    they cannot have seen it, so they cannot honestly say the board was fine."""
    view, msg = _feedback(
        [
            {"check": "conformance:REQ-TESTID/testid.board", "observed": "missing"},
            {"check": "[G07] REQ-HIT — hitting → bar", "observed": "x"},
        ]
    )
    assert [p["check"].split(" ")[0] for p in view.visible] == [
        "conformance:REQ-TESTID/testid.board"
    ]
    assert view.withheld == ["[G07] REQ-HIT — hitting → bar"]
    assert "Nothing jumped out" not in msg
    assert "while playing the game" not in msg
    assert "Also, my software team" not in msg
    assert "My software team" in msg


def test_no_failing_tester_check_keeps_the_tester_claiming_a_clean_look() -> None:
    """Every player-visible check this round is team-owned: the tester genuinely
    saw nothing, so the honest line is the clean-look one."""
    view, msg = _feedback(
        [
            {
                "check": 'conformance:REQ-STATE/state.winType — /api/state carries "winType"',
                "observed": "missing",
            }
        ]
    )
    assert [p["check"].split(" ")[0] for p in view.visible] == [
        "conformance:REQ-STATE/state.winType"
    ]
    assert view.withheld == [] and view.unevaluated == []
    assert "1) Nothing jumped out at me this time while I was playing." in msg
    assert "Also, my software team" in msg


def test_nothing_at_all_still_says_something_is_broken() -> None:
    """A FAIL with no itemised checks is still a failure, never a clean run."""
    view, msg = _feedback([])
    assert (
        view.stage is None
        and view.visible == []
        and view.withheld == []
        and view.unevaluated == []
    )
    assert "1) Something is still broken but I couldn't pin down what it was." in msg
    assert "Nothing jumped out" not in msg


def test_the_team_alone_is_not_the_graders_vocabulary() -> None:
    """The team speaking ALONE (the tester silenced) must clear the same
    vocabulary bar — _TEAM_HEADER_ALONE is model-facing text too."""
    skipped = "never evaluated — an earlier step failed and skipped it"
    _, msg = _feedback(
        [
            {"check": "conformance:REQ-TESTID/testid.board", "observed": skipped},
            {"check": "conformance:REQ-RENDER/checker", "observed": skipped},
            {
                "check": "conformance:REQ-TESTID/dom — page DOM exposes the required testids",
                "observed": "missing",
            },
        ]
    )
    lowered = msg.lower()
    for word in ("conformance", "pre-gate", "gate", "harness", "benchmark", "grader"):
        assert word not in lowered, (
            f"the message says {word!r} — that is grader vocabulary"
        )
    assert "Also, my software team" not in msg
    assert "My software team" in msg


def test_the_team_carries_its_own_excuse_eliminator() -> None:
    """A second persona is a second party to blame — closed before it is used.

    The original eliminator closes the stale-page excuse, measured on run
    1788499216 where a model deflected ten failures onto "the user needs to
    hard-refresh". A software team invites "they're calling it wrong" and
    "they're on an old build".
    """
    msg = R._build_feedback_prompt(
        problems=[
            _problem(
                'conformance:REQ-STATE/state.winType — /api/state carries "winType"'
            )
        ],
    )
    assert "clean checkout" in msg and "isn't there to find" in msg
    # And the original one still opens the message.
    assert "latest code from scratch" in msg


def test_the_teams_opener_is_not_the_graders_vocabulary() -> None:
    # "conformance checks came back wrong" was the working draft. That is the
    # harness's own word for the gate; a customer integrating an app would never
    # say it, and it tells the model it is being measured.
    msg = R._build_feedback_prompt(
        problems=[
            _problem(
                'conformance:REQ-STATE/state.winType — /api/state carries "winType"'
            )
        ],
    )
    lowered = msg.lower()
    for word in ("conformance", "pre-gate", "gate", "harness", "benchmark", "grader"):
        assert word not in lowered, (
            f"the message says {word!r} — that is grader vocabulary"
        )


def test_every_conformance_check_the_pregate_can_emit_has_a_line() -> None:
    """No conformance check may fall through to the catch-all unnoticed.

    The catch-all still exists for a check added later, but every key the
    pre-gate can emit today must have its own sentence — otherwise the collapse
    this whole change removes creeps back one check at a time.
    """
    src = (GATES / "conformance" / "pregate.ts").read_text(encoding="utf-8")
    overrides = json.loads((GATES / "feedback.json").read_text(encoding="utf-8"))[
        "gates"
    ]

    import re

    def block(name: str) -> list[str]:
        m = re.search(name + r"\s*:\s*string\[\]\s*=\s*\[(.*?)\n\];", src, re.S)
        assert m, f"{name} not found in pregate.ts"
        return [
            x.strip().strip('",')
            for x in m.group(1).split("\n")
            if x.strip().strip('",')
        ]

    expected = [f"REQ-STATE/state.{k}" for k in block("REQUIRED_STATE_KEYS")]
    expected += [f"REQ-TESTID/testid.{t}" for t in block("REQUIRED_STATIC_TESTIDS")]
    expected += [f"REQ-TESTID/id.{t}" for t in block("REQUIRED_STATIC_TESTIDS")]
    for label in ("point", "checker", "bar", "off-tray", "die"):
        expected.append(f"REQ-TESTID/{label}")
        expected.append(f"REQ-RENDER/{label}")

    missing = [k for k in expected if k not in overrides]
    assert not missing, f"conformance checks with no feedback line: {missing}"


@pytest.mark.parametrize("channel", ["tester", "team"])
def test_each_channel_actually_has_lines_written_for_it(channel: str) -> None:
    overrides = json.loads((GATES / "feedback.json").read_text(encoding="utf-8"))[
        "gates"
    ]
    got = [k for k in overrides if R.feedback_channel(k) == channel]
    assert got, f"no {channel} lines at all — the split is not wired"


def test_no_line_is_truncated_in_delivery() -> None:
    """A complaint cut mid-clause loses the symptom and reads like a machine.

    The cap was 200 and was ALREADY truncating two hand-written tester lines
    (E04 at 267 characters, E02 at 244) before the team's longer lines existed.
    """
    # Asserted on the written lines against the delivery cap, rather than by
    # round-tripping every key through `_humanize_check` — several keys resolve
    # only from a conformance-shaped check string, and synthesising one per key
    # would test the synthesiser rather than the lines.
    cap = 320
    overrides = load_feedback_overrides_from_failures(
        Path(__file__).resolve().parents[1] / "task" / "backgammon" / "prompts"
    )
    too_long = [
        f"{key}/{kind} ({len(entry[kind])} chars)"
        for key, entry in overrides.items()
        for kind in ("first", "repeat")
        if len(entry[kind]) > cap
    ]
    assert not too_long, f"these would be cut mid-clause at delivery: {too_long}"

    # And the real path, on a message carrying both channels.
    msg = R._build_feedback_prompt(
        problems=[
            _problem("[E04] REQ-DOUBLES — doubles"),
            _problem(
                'conformance:REQ-STATE/state.points — /api/state carries "points"'
            ),
        ],
    )
    assert "…" not in msg, "a delivered complaint was truncated"


def test_the_team_line_states_what_the_missing_thing_IS() -> None:
    """Naming a field is useless to a model that no longer knows what it is.

    THE CORRECTION (Jerry, 2026-09-05): the build prompt is NOT in context when
    the model reads this. A normal run compacts between the six build chunks; a
    SEEDED run never ran the build at all, so that model was never handed the
    spec in the first place. "There's no winType" is cryptic on both paths — the
    definition has to travel with the complaint.
    """
    msg = R._build_feedback_prompt(
        problems=[
            _problem(
                'conformance:REQ-STATE/state.winType — /api/state carries "winType"'
            ),
            _problem('conformance:REQ-TESTID/testid.rollBtn — page exposes "rollBtn"'),
        ],
    )
    # The field is named AND said what it is.
    assert "winType" in msg
    assert "single, gammon or backgammon" in msg, (
        "the shape of the value must travel with it"
    )
    # The handle is named AND said what element it belongs to.
    assert "rollBtn" in msg and "roll button" in msg


def test_the_teams_closing_claim_is_true_on_a_seeded_cell() -> None:
    """A seeded cell's model never ran the build, so it was never "given" a spec.

    The eliminator must not assert something the model can correctly deny — an
    excuse eliminator that says a false thing is an excuse generator.
    """
    msg = R._build_feedback_prompt(
        problems=[_problem("conformance:REQ-STATE/state.winType — x")],
    )
    assert "spec you were given" not in msg
    assert "the written spec for this app" in msg


def test_the_pregate_emits_the_PROBLEM_lines_report_mjs_parses() -> None:
    """A contract between two files that nothing else checks.

    THE REGRESSION THIS PINS (2026-09-05, caught on a live run). Splitting the
    pre-gate into 65 tests dropped the `console.error("PROBLEM …")` loop the old
    single test carried. `report.mjs::runConformancePhase` reads those lines off
    each test result's stderr (`parseProblemLine` requires the exact shape
    `PROBLEM <check>: expected <x>, observed <y>`), so `problems` came back
    EMPTY and the report fell through to its single `conformance:boot` fallback.

    The gate wall was still right — it reads playwright's own test outcomes — so
    the wall showed 26 failing while the attempt row showed 16, and the repair
    prompt went back to ONE generic complaint. That is the exact collapse the
    split was performed to remove, reintroduced by a different route and
    invisible from either file alone.
    """
    spec = (GATES / "conformance" / "pregate.spec.ts").read_text(encoding="utf-8")
    assert (
        "PROBLEM ${found.check}: expected ${found.expected}, observed ${found.observed}"
        in spec
    ), (
        "pregate.spec.ts must emit the PROBLEM line report.mjs parses — without it "
        "`problems` is empty and every conformance finding is lost"
    )

    # And the parser on the other side still expects that shape.
    report = (GATES / "lib" / "parse.mjs").read_text(encoding="utf-8")
    assert 'clean.startsWith("PROBLEM ")' in report
    assert '": expected "' in report and '", observed "' in report


def test_one_conformance_finding_is_one_gate() -> None:
    """The wall and the attempt row must count the same universe.

    Before conformance was enumerated they diverged by a constant +10 (eleven
    problems collapsing into one CONF gate). After, they can only agree if every
    finding maps to exactly one test — which is why the shape checks are guarded
    on presence (an absent `pip` used to trip both the presence loop and the
    shape check: two findings, one gate).
    """
    src = (GATES / "conformance" / "pregate.ts").read_text(encoding="utf-8")
    for guarded in (
        'if (present("pip"))',
        'hasOwnProperty.call(echoed, "off")',
        'present("legalMoves")',
        'present("canDouble")',
    ):
        assert guarded in src, f"{guarded} missing — a missing field would report twice"


def test_the_conformance_phase_has_no_fabricated_fallback() -> None:
    """No fallback in the scored path. Ever.

    `runConformancePhase` used to synthesise a `conformance:boot` problem —
    "server boots on :8002 and passes pre-gate" — whenever the phase failed and
    nothing parsed, and then publish the attempt as GRADABLE. That is a second
    route through the scored path, which the bench does not permit
    (dev-benchmark.md §9.1: fail loud, abort, never carry on by another means).

    It was not theoretical. When the pre-gate split dropped the `PROBLEM` lines,
    a phase with 11 real failings produced zero parseable problems — and instead
    of stopping, this manufactured ONE boot complaint and the run continued for
    several attempts on degraded feedback. A loud failure would have surfaced it
    on attempt 1.
    """
    report = (GATES / "report.mjs").read_text(encoding="utf-8")
    assert '"conformance:boot"' not in report, "the fabricated boot problem is back"
    # The phase must declare itself unreadable...
    assert "unreadable" in report
    # ...and that must reach gradability, so the attempt is not published as a
    # measurement. Naming the failure is honest; scoring around it is not.
    assert "conformance?.unreadable" in report, (
        "an unreadable conformance phase must mark the attempt ungradable, exactly "
        "as an aborted backend runner does"
    )


# ── A HANG REACHES THE MODEL (2026-09-11) ───────────────────────────────────
#
# Measured on run 1789076475: the candidate's `maxPlies` recursed forever on
# doubles, the runner was killed on its deadline, and the model was told NOTHING
# about it — it burned every attempt with no idea its engine locked up. The
# timeout surfaced as `backend:runner <file>`, which the repair loop drops on
# purpose because a runner killed EXTERNALLY has no honest sentence to send.
#
# A deadline is a different fact: the code under test did not return, and a
# freeze is the most player-visible symptom there is.

# The two a player meets in the browser (the page never loads; the page freezes
# while played) are the player's. The four backend areas are the integrating
# team's automated tests of the engine — a test no player runs — so a deadline
# there is told by the team (Jerry, 2026-10-07: the player hands the product to
# the team for integration testing, and that is where it shows). Their stages
# in grader/checks.json are unchanged.
PLAYER_STALL_AREAS = ("startup", "playing")
TEAM_STALL_AREAS = ("moving", "bearingoff", "aiturn", "awkwardroll")
STALL_AREAS = PLAYER_STALL_AREAS + TEAM_STALL_AREAS


@pytest.mark.parametrize("area", STALL_AREAS)
def test_a_stall_reaches_the_model(area: str) -> None:
    check = f"REQ-RESPONSIVE/{area} — the game keeps responding"
    assert not R._is_harness_infra_check(check), (
        "a deadline is the candidate's code not returning, not harness "
        "infrastructure — dropping it is how a hang went unreported for a whole run"
    )
    expected = "tester" if area in PLAYER_STALL_AREAS else "team"
    assert R.feedback_channel(check) == expected, (
        "a freeze in the browser is what a person playing sees; a deadline in a "
        "backend file is the team's automated test, which a player never runs"
    )
    line = R._humanize_check(check, pass_kind="first")
    assert line, f"{area} has no symptom line"


@pytest.mark.parametrize("area", PLAYER_STALL_AREAS)
def test_a_player_stall_line_says_it_froze_and_nothing_about_why(area: str) -> None:
    for kind in ("first", "repeat"):
        line = R._humanize_check(f"REQ-RESPONSIVE/{area}", pass_kind=kind).lower()
        # The symptom, in words a player would use. Deliberately broad: a hang
        # is described several honest ways — it froze, it never came back, I
        # had to force it closed — and narrowing this list would push the prose
        # to fit the assertion rather than the other way round.
        assert any(
            w in line
            for w in (
                "locked up",
                "froze",
                "freeze",
                "hung",
                "stops",
                "sat there",
                "never came back",
                "never handed back",
                "force it closed",
                "force-quitting",
                "stopped responding",
                "seized up",
            )
        ), f"{area}/{kind} does not describe a freeze: {line}"
        _assert_no_cause(line, area, kind)


@pytest.mark.parametrize("area", TEAM_STALL_AREAS)
def test_a_team_stall_line_is_the_teams_test_not_finishing_and_nothing_about_why(
    area: str,
) -> None:
    for kind in ("first", "repeat"):
        line = R._humanize_check(f"REQ-RESPONSIVE/{area}", pass_kind=kind).lower()
        assert line.startswith("their automated test"), f"{area}/{kind}: {line}"
        assert "never finished" in line and "force-stop" in line, f"{area}/{kind}: {line}"
        _assert_no_cause(line, area, kind)


def _assert_no_cause(line: str, area: str, kind: str) -> None:
    # Never the cause. Naming a loop, a function or a file would hand over the
    # fix — finding it is the work being measured.
    for leak in ("loop", "infinite", "recurs", "function", "timeout", "hang detected"):
        assert leak not in line, f"{area}/{kind} names the cause: {leak}"


def test_the_infra_check_is_still_dropped() -> None:
    # Unchanged, and it must stay that way: a runner killed by something other
    # than its own deadline has no honest sentence, and forcing one through
    # would raise MissingFeedbackOverrideError and end the campaign.
    for check in (
        "backend:runner backend/edge/edge-gates.test.ts",
        "frontend:boot",
        "conformance:runner",
        "backend:report-parse backend/gates-01-08.test.ts",
    ):
        assert R._is_harness_infra_check(check), check


def test_one_hang_is_reported_once_not_once_per_unmeasured_gate() -> None:
    # A hung file leaves every gate behind it unmeasured. Reporting each of
    # them would be the over-reporting defect the team channel already showed:
    # one absent serializer became twenty near-identical complaints.
    msg = R._build_feedback_prompt(
        problems=[
            {"check": "REQ-RESPONSIVE/awkwardroll — the game keeps responding"},
            {"check": "backend:runner backend/edge/edge-gates.test.ts"},
        ],
        checks=None,
        repeat_complaints=set(),
    )
    assert msg.lower().count("never finished") == 1
    # And the unmeasured gates say nothing at all — they were not measured, so
    # there is no finding to report, and inventing one would be fabrication.
    assert "edge-gates" not in msg


def test_a_refused_setup_is_told_as_the_team_saw_it_never_as_the_gates_player_story() -> (
    None
):
    # Run 1790183923: the endpoint refused every partial body, F19's setup
    # never took, and the model was told "I picked the hard computer,
    # refreshed the page…" — which never happened. The grader now marks it.
    from harness.adapters.challenge import ChallengeRunner

    problems = [
        {
            "check": "[F19] REQ-RELOAD — difficulty survives a reload",
            "observed": "Error: SETUP REFUSED: /api/debug/state did not take difficulty (sent difficulty)"
            " [error: invalid position: white=0, black=0 (must be 15 each)]",
        },
        {
            "check": "[F17] REQ-RELOAD — match score survives a reload",
            "observed": "Error: SETUP REFUSED: /api/debug/state did not take difficulty (sent difficulty)"
            " [error: invalid position: white=0, black=0 (must be 15 each)]",
        },
    ]
    msg = ChallengeRunner._build_feedback_prompt(problems=problems)
    assert "hard computer" not in msg, "the gate's player story must not be told"
    assert msg.count("debug endpoint") == 1, "same finding twice is one line"
    assert '"difficulty"' in msg
    # What was SENT is named (run 1790191629: told "a position", the model
    # tested a full board and saw it work), and the app's own error text.
    assert 'an update with just "difficulty"' in msg
    assert "must be 15 each" in msg
    team = msg.split("software team", 1)[1]
    assert "debug endpoint" in team, "a refused setup is the team's finding"
    again = ChallengeRunner._build_feedback_prompt(
        problems=problems[:1], repeat_complaints={problems[0]["check"]}
    )
    assert "still didn't take" in again


def test_a_roll_that_ignored_the_queued_dice_is_told_as_what_came_up() -> None:
    # WO-GATE-WALL-FLUKES: a build that ignores /api/debug/roll turned every
    # dice-forced check into a coin flip. The grader now proves the roll used the
    # queued dice; a roll that did not is the team's finding, in its own words —
    # never "didn't read back", which is about a position's fields.
    from harness.adapters.challenge import ChallengeRunner

    problems = [
        {
            "check": "[F03] REQ-HINT — clicking a piece shows its moves",
            "observed": "Error: SETUP REFUSED: /api/debug/roll did not take dice (sent 6, 5) [rolled 2, 3]",
        },
        {
            "check": "[F25] REQ-HINT — a played move consumes a die",
            "observed": "Error: SETUP REFUSED: /api/debug/roll did not take dice (sent 6, 5) [rolled 2, 3]",
        },
    ]
    msg = ChallengeRunner._build_feedback_prompt(problems=problems)
    team = msg.split("software team", 1)[1]
    assert "They queued a roll of 6 and 5 through your app's debug endpoint" in team
    assert "came up 2 and 3" in team
    assert msg.count("queued a roll") == 1, "same finding twice is one line"
    assert "read back" not in msg
    again = ChallengeRunner._build_feedback_prompt(
        problems=problems[:1], repeat_complaints={problems[0]["check"]}
    )
    assert "still came up 2 and 3" in again


def test_a_failed_api_call_is_told_as_the_status_and_error_the_app_returned() -> None:
    # Run 1790183923: "HTTP 500 from POST /api/new: EROFS …" was told as
    # "their automation fell over while reading your page".
    from harness.adapters.challenge import ChallengeRunner

    problems = [
        {
            "check": "conformance:REQ-TESTID/dom — page DOM exposes the required testids",
            "observed": "HTTP 500 from POST /api/new: Error: boom",
        },
        {
            "check": "[F02] REQ-RENDER — start game renders full board",
            "observed": "Error: POST /api/new failed (500)\n\nexpect(received).toBeTruthy()",
        },
    ]
    msg = ChallengeRunner._build_feedback_prompt(problems=problems)
    assert "fell over" not in msg
    team = msg.split("software team", 1)[1]
    assert "POST /api/new" in team and "HTTP 500" in team and '"Error: boom"' in team


def test_that_fixed_it_quotes_what_was_actually_said() -> None:
    # Run 1790194347: F19 was told as a debug-endpoint finding, then reported
    # fixed as "I picked the hard computer, refreshed the page…" — a complaint
    # the model never got — and it built difficulty persistence next round.
    from harness.adapters.challenge import ChallengeRunner as R

    record = {
        "check": "[F19] REQ-RELOAD — difficulty survives a reload",
        "observed": "Error: SETUP REFUSED: /api/debug/state did not take difficulty (sent difficulty)",
    }
    told = {record["check"]: R._told_label(record, pass_kind="first")[0]}
    verdict = R._build_pass_verdict(newly_passing=[record["check"]], told=told)
    assert "debug endpoint" in verdict
    assert "hard computer" not in verdict
    # A check never told is never reported fixed.
    assert (
        R._build_pass_verdict(newly_passing=["[G05] REQ-HIGHER-DIE — x"], told={}) == ""
    )


def test_a_labelled_assertion_is_told_as_that_aspect() -> None:
    # G01 checks pieces, setup and opponent in one test; its single line listed
    # them all and the model chased the decoys (run 1790196821).
    from harness.adapters.challenge import ChallengeRunner as R

    pieces = R._humanize_check(
        "[G01] REQ-INIT — initial position",
        observed="AssertionError: [aspect: pieces]: expected [ Array(26) ] to deeply equal [ Array(26) ]",
    )
    assert "pieces" in pieces and "cube" not in pieces
    plain = R._humanize_check(
        "[G01] REQ-INIT — initial position", observed="AssertionError: x"
    )
    assert plain != pieces


def test_f06_aspects_resolve_to_three_distinct_complaints() -> None:
    # Run 1790237137: F06 failed on VALUE — the screen showed 208 where the
    # engine said 167 — but the model was told the sync-flavoured gate line
    # and hunted a screen-vs-game disagreement that didn't exist. The three
    # failure causes must name three DIFFERENT complaint lines, and an
    # unmarked finding must fall back to the gate's own line.
    from harness.adapters.challenge import ChallengeRunner as R

    check = "[F06] REQ-PIPUI — pip display cross-checked vs engine"

    value = R._humanize_check(
        check, observed="AssertionError: [aspect: value]: expected 208 to be 167"
    )
    assert "wrong numbers for the position" in value
    # A wrong-number failure must NOT read as a sync problem.
    assert "own count" not in value

    sync = R._humanize_check(
        check, observed="AssertionError: [aspect: sync]: expected 208 to be 167"
    )
    assert "own count" in sync  # the screen disagrees with the game's count

    fmt = R._humanize_check(
        check, observed="AssertionError: [aspect: format]: expected '208' to match"
    )
    assert "aren't readable" in fmt and "plain numbers" in fmt  # not a plain number

    # Three causes, three different lines.
    assert len({value, sync, fmt}) == 3

    plain = R._humanize_check(check, observed="Error: x")
    assert "drift after a change" in plain  # the gate-level fallback
    assert plain not in (value, sync, fmt)
