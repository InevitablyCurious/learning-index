"""PLAYER ORDER: the model hears only the earliest failing stage's problems.

Every check the grader can report must have a stage — which stage it is in
decides whether the model hears about it (harness/adapters/challenge/stages.py).
"""

from __future__ import annotations

import json
import re

import pytest

from harness.adapters.challenge import ChallengeRunner
from harness.adapters.challenge.constants import _GRADER_DIR, _PACK
from harness.adapters.challenge.feedback import (
    gate_tokens_in_suite,
    load_feedback_overrides_from_failures,
)
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
        # An aspect line (`G01.pieces`) belongs to its gate: same stage.
        check = key if key.startswith("REQ-") else f"[{key.split('.', 1)[0]}] x"
        stage_of(check, STAGES)


def test_the_most_specific_key_wins() -> None:
    assert stage_of("conformance:REQ-TESTID/die — dice tagged", STAGES).number == 2
    assert stage_of("conformance:REQ-TESTID/testid.board — tagged", STAGES).number == 1


def test_an_undeclared_check_is_refused_not_guessed() -> None:
    with pytest.raises(UnstagedCheckError):
        stage_of("[Z99] nothing", STAGES)


def test_only_the_earliest_failing_stage_is_told() -> None:
    problems = [
        {"check": "[G08] REQ-BEAROFF — bear-off"},  # stage 4
        {"check": "[G01] REQ-INIT — initial position"},  # stage 1
        {"check": "[F06] REQ-PIPUI — pips on screen"},  # stage 1
        {"check": "[G14] REQ-AISTRENGTH — hard beats easy"},  # stage 7
    ]
    view = player_view(problems, STAGES, is_infra=_infra)
    assert view.stage is not None and view.stage.number == 1
    assert [p["check"][:5] for p in view.visible] == ["[G01]", "[F06]"]
    assert len(view.withheld) == 2


def test_a_clean_stage_unlocks_the_next_failing_one_skipping_clean_stages() -> None:
    view = player_view([{"check": "[G10] REQ-WINCLASS — x"}, {"check": "[G14] x"}], STAGES, is_infra=_infra)
    assert view.stage is not None and view.stage.number == 5


def test_runner_deaths_are_never_staged_or_told() -> None:
    view = player_view([{"check": "backend:runner backend/gates-13-16.test.ts"}], STAGES, is_infra=_infra)
    assert view.stage is None and view.visible == [] and view.withheld == []


def test_a_check_the_grader_never_reached_is_told_to_no_one() -> None:
    # Run 1790183923, attempt 4: POST /api/new returned 500, the pre-gate
    # skipped everything after it, and 30 skipped checks each became a specific
    # complaint ("their automation can't find the board"). Nobody observed any
    # of them; only the check that actually failed may be told.
    skipped = "never evaluated — an earlier step failed and skipped it"
    problems = [
        {"check": "conformance:REQ-TESTID/testid.board", "expected": "this check is evaluated", "observed": skipped},
        {"check": "conformance:REQ-RENDER/checker", "expected": "this check is evaluated", "observed": skipped},
        {"check": "conformance:REQ-TESTID/dom — page DOM exposes the required testids", "observed": "HTTP 500 from POST /api/new"},
    ]
    view = player_view(problems, STAGES, is_infra=_infra)
    assert [p["check"].split(" ")[0] for p in view.visible] == ["conformance:REQ-TESTID/dom"]
    assert sorted(view.unevaluated) == ["conformance:REQ-RENDER/checker", "conformance:REQ-TESTID/testid.board"]
    assert view.withheld == []
    only_skipped = player_view(problems[:2], STAGES, is_infra=_infra)
    assert only_skipped.stage is None and only_skipped.visible == [] and len(only_skipped.unevaluated) == 2


def test_the_report_runners_own_death_is_never_staged_or_told() -> None:
    # grader/report.mjs publishes `runner:exception` when it throws (gradable
    # false). Unrecognised, it reached stage_of, which raises for an unstaged
    # check and aborts the campaign.
    view = player_view([{"check": "runner:exception", "observed": "TypeError"}], STAGES, is_infra=_infra)
    assert view.stage is None and view.visible == [] and view.withheld == []


# ── A CHECK THAT CANNOT GET STARTED IS NOT TOLD (Jerry, 2026-09-24) ──────────


def _doubles(observed: str) -> dict[str, str]:
    return {"check": "[F33] REQ-DOUBLES — a double lets the player make four moves", "observed": observed}


def test_a_stuck_check_is_not_told_when_the_check_for_that_step_failed_too() -> None:
    # FIX-2 mutation M27, no hints anywhere: the doubles gate told "I rolled a
    # double and could only make two moves" to a player who could make none.
    problems = [
        _doubles("Error: move 1: no hint appeared [aspect: nomove] [needs: REQ-HINT/hint F03 F25]"),
        {"check": "[F03] REQ-HINT — clicking a piece shows its moves", "observed": "Error: Could not reveal hints"},
    ]
    view = player_view(problems, STAGES, is_infra=_infra)
    assert [p["check"][:5] for p in view.visible] == ["[F03]"]
    assert [c[:5] for c in view.unevaluated] == ["[F33]"]


def test_a_stuck_check_is_told_when_the_step_failed_only_in_its_own_situation() -> None:
    # Hints vanish only on a double: every ordinary-roll check passes, so the
    # double's own line is what the player saw — hiding it would skip stage 2.
    view = player_view([_doubles("Error: move 1: no hint appeared [aspect: nomove] [needs: F25]")], STAGES, is_infra=_infra)
    assert view.stage is not None and view.stage.number == 2
    assert [p["check"][:5] for p in view.visible] == ["[F33]"] and view.unevaluated == []
    label, _ = ChallengeRunner._told_label(view.visible[0], pass_kind="first")
    assert label == ChallengeRunner._feedback_overrides()["F33.nomove"]["first"]


def test_a_chain_of_stuck_checks_is_told_as_the_one_step_that_failed() -> None:
    problems = [
        _doubles("move 1: no checker to pick up [aspect: nomove] [needs: F25]"),
        {"check": "[F25] REQ-HINT — a played move consumes a die", "observed": "[needs: REQ-HINT/hint F03]"},
        {"check": "conformance:REQ-HINT/hint — selecting a movable checker shows move hints", "observed": "none"},
    ]
    view = player_view(problems, STAGES, is_infra=_infra)
    assert [p["check"].split(" ")[0] for p in view.visible] == ["conformance:REQ-HINT/hint"]
    assert sorted(c[:5] for c in view.unevaluated) == ["[F25]", "[F33]"]


def test_moves_after_the_first_are_the_doubles_checks_own_finding() -> None:
    # The player has made moves, so how many is the complaint — whatever else fails.
    problems = [_doubles("move 3: no hint appeared [aspect: two]"), {"check": "[F25] REQ-HINT — x", "observed": "x"}]
    view = player_view(problems, STAGES, is_infra=_infra)
    assert sorted(p["check"][:5] for p in view.visible) == ["[F25]", "[F33]"]
    label, _ = ChallengeRunner._told_label(_doubles("move 3: no hint appeared [aspect: two]"), pass_kind="first")
    assert label == "I rolled a double and could only make two moves."


# ── Every marker in the graded suite resolves ────────────────────────────────
#
# Markers live in assertion messages, so nothing checks them at run time: an
# aspect with no line silently falls back to the gate's general line, and a
# needs marker naming a later stage, a check that does not exist, or a cycle
# would hide a fault the player meets. These read the graded sources the way
# gate_tokens_in_suite does and refuse all of those.

_TITLE = re.compile(r"\b(?:test|it)\(\s*[\"'`]\[([A-Z]+[0-9]*)\]")
_MARKER = re.compile(r"\[(aspect|needs): ([^\]]+)\]")
# A marker in a shared helper sits in no test: each is listed with the gates
# whose tests call the helper, so it is checked for each of them.
_LAYOUT = ("F35", "F36", "F37", "F38")  # layout.spec.ts openAt / drawnBoard
# fixtures.ts waits for the drawn game on every open and reload of every
# frontend gate.
_FRONTEND = tuple(
    sorted(
        {
            m.group(1)
            for path in (_GRADER_DIR / "frontend").glob("*.spec.ts")
            for m in re.finditer(r"\b(?:test|it)\(\s*[\"'`]\[([A-Z]+[0-9]*)\]", path.read_text(encoding="utf-8"))
        }
    )
)
_HELPER_MARKERS = {
    ("frontend/core.spec.ts", "[aspect: format]"): ("F06",),  # readInt
    ("frontend/doubles.spec.ts", "[needs: REQ-RENDER/die]"): ("F39",),  # rollThroughThePage
    ("frontend/fixtures.ts", "[needs: REQ-RENDER/point REQ-RENDER/checker]"): _FRONTEND,
    ("frontend/layout.spec.ts", "[needs: F01]"): _LAYOUT,
    ("frontend/layout.spec.ts", "[needs: REQ-RENDER/point]"): _LAYOUT,
}


def _string_end(src: str, i: int) -> int:
    quote, j, n = src[i], i + 1, len(src)
    while j < n and src[j] != quote:
        if src[j] == "\\":
            j += 2
            continue
        if quote == "`" and src.startswith("${", j):
            depth, j = 1, j + 2
            while j < n and depth:
                depth += {"{": 1, "}": -1}.get(src[j], 0)
                j += 1
            continue
        j += 1
    return j + 1


def _blank_comments(src: str) -> str:
    out, i, n = list(src), 0, len(src)
    while i < n:
        if src[i] in "\"'`":
            i = _string_end(src, i)
        elif src.startswith("//", i) or src.startswith("/*", i):
            end = src.find("\n", i) if src[i + 1] == "/" else src.find("*/", i) + 2
            end = n if end < 0 else end
            out[i:end] = " " * (end - i)
            i = end
        else:
            i += 1
    return "".join(out)


def _call_end(code: str, open_paren: int) -> int:
    depth, i = 0, open_paren
    while i < len(code):
        if code[i] in "\"'`":
            i = _string_end(code, i)
            continue
        depth += {"(": 1, "[": 1, "{": 1, ")": -1, "]": -1, "}": -1}.get(code[i], 0)
        if depth == 0:
            return i + 1
        i += 1
    raise AssertionError(f"unbalanced test call at offset {open_paren}")


def _suite_markers() -> list[tuple[str, str, str, str]]:
    """(file, owning gate token, marker kind, marker value) across the graded suite."""
    found = []
    for directory in ("backend", "frontend", "conformance"):
        for path in sorted((_GRADER_DIR / directory).rglob("*.ts")):
            code = _blank_comments(path.read_text(encoding="utf-8"))
            spans = [(m.group(1), m.start(), _call_end(code, code.index("(", m.start()))) for m in _TITLE.finditer(code)]
            rel = path.relative_to(_GRADER_DIR).as_posix()
            for mark in _MARKER.finditer(code):
                owners = [token for token, start, end in spans if start <= mark.start() < end]
                gates = owners[-1:] or _HELPER_MARKERS.get((rel, mark.group(0)))
                assert gates, f"{rel}: {mark.group(0)} sits in no gate's test — list it in _HELPER_MARKERS"
                found.extend((rel, gate, mark.group(1), mark.group(2)) for gate in gates)
    return found


def test_every_aspect_marker_has_its_gates_first_and_repeat_lines() -> None:
    lines = load_feedback_overrides_from_failures(_PACK.dir)
    aspects = {f"{owner}.{value}" for _, owner, kind, value in _suite_markers() if kind == "aspect"}
    assert "F33.nomove" in aspects and "G03.plainmoves" in aspects  # the scan sees the suite
    assert sorted(a for a in aspects if a not in lines) == []


def test_a_needed_check_exists_in_the_same_or_an_earlier_stage_and_never_in_a_cycle() -> None:
    # A needed check must be one the player can hear: withholding a stuck check
    # is only honest when the check it names has a complaint line of its own.
    known = set(load_feedback_overrides_from_failures(_PACK.dir))
    graph: dict[str, set[str]] = {}
    for rel, owner, kind, value in _suite_markers():
        if kind != "needs":
            continue
        own_stage = stage_of(f"[{owner}] x", STAGES).number
        for ident in value.split():
            assert ident != owner, f"{rel}: {owner} needs itself"
            assert ident in known, f"{rel}: {owner} needs {ident}, which has no complaint line"
            needed = stage_of(ident if ident.startswith("REQ-") else f"[{ident}] x", STAGES).number
            assert needed <= own_stage, f"{rel}: {owner} (stage {own_stage}) needs {ident} (stage {needed})"
            graph.setdefault(owner, set()).add(ident)
    assert graph, "no needs markers found — the scan is not reading the suite"

    def visit(node: str, path: tuple[str, ...]) -> None:
        assert node not in path, f"needs cycle: {' -> '.join(path + (node,))}"
        for nxt in graph.get(node, ()):
            visit(nxt, path + (node,))

    for start in graph:
        visit(start, ())


def test_a_new_complaint_from_a_check_already_told_is_a_first_sighting() -> None:
    # Run 1790345941: F32 told "The off tray isn't showing", then — the model
    # drew the tray over the points — "The off tray is STILL drawn over some of
    # the points.", a complaint the player had never made. Repeats are per
    # complaint (check + aspect), not per check.
    check = "[F32] REQ-GEOMETRY — off tray is visible"
    told_before = {ChallengeRunner._complaint_id({"check": check, "observed": "expected the off tray to be drawn"})}
    record = {"check": check, "observed": "[aspect: overlap] the off tray is drawn over points"}
    message = ChallengeRunner._build_feedback_prompt(problems=[record], repeat_complaints=told_before)
    lines = ChallengeRunner._feedback_overrides()["F32.overlap"]
    assert lines["first"] in message and lines["repeat"] not in message
    again = ChallengeRunner._build_feedback_prompt(
        problems=[record], repeat_complaints=told_before | {ChallengeRunner._complaint_id(record)}
    )
    assert lines["repeat"] in again
