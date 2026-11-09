"""THE LAYERED SEQUENCE: build one phase, grade ITS layer, repair, advance.

THE RULE (harness/adapters/challenge/runner.py, ``_run_cell_impl``). The build
is SEVEN phases and the pack's declaration is the only thing that orders them.
Per phase, in ``PromptPack.phases()`` order, the runner drives that phase's
build message over the one serve session and — when the phase declares a grader
layer — grades ``--layer N`` and troubleshoots until that layer PASSes before
the next phase is built. A phase whose ``layer`` is None (the three backend
phases) is built and never graded. The real plan is

    1,2,3 -> layer None   4 -> 1   5 -> 2   6 -> 3   7 -> 3

so the sequence grades layer 3 TWICE: after "Layer 3 — gameplay" and again
after "Wire and verify". That falls out of the data, not a special case.

WHY IT IS A RULE AND NOT AN IMPLEMENTATION DETAIL. A LAYER ADVANCES ONLY ON A
SCOPED PASS. Building layer 2 over layer 1's unresolved failures would measure
a task nobody was asked for, and a grade that is not scoped to the phase's own
layer would report a gate the model has not been asked for yet.

WHAT THESE TESTS STATE, one rule each:

  (a) the seven phases are built in order and layers are graded [1, 2, 3, 3];
  (b) a layer whose scoped grade never passes never advances — the next phase
      is never built, and no grade is ever asked for a later layer;
  (c) every grade is invoked with its ``--layer N`` AND a gate roster (the argv
      carries both; the cell grades against a roster it was handed);
  (d) the 2-compactions abort fires per TROUBLESHOOTING STRETCH, never on a
      build step — a build that compacts heavily does not end the cell.

No model runs: the serve drive, the gate oracle and Docker are the shared fakes
from tests/_serve_drive_fakes.py and tests/test_challenge_budget_stop.py.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

import harness.adapters.challenge.runner as runner_mod
from harness.adapters.challenge import ChallengeRunner, _OpencodeRunStats
from harness.adapters.challenge.runner import COMPACTIONS_BEFORE_GRADE
from harness.grader_run import gate_argv
from harness.prompt_pack import Phase
from tests._serve_drive_fakes import _pack_factory
from tests.test_challenge_budget_stop import (
    _make_runner,
    _patch_fake_docker,
    _stats,
)

# A REAL layer-1 gate (grader/layers.json), spelled the way the grader publishes
# a check — the bracket token is what resolves it to a layer, a player stage and
# a symptom line. The feedback voice is single-system: every complaint must carry
# a human-written line in grader/feedback.json, so loop-mechanics tests drive
# real gates, never synthetic labels.
L1_CHECK = "[F29] the bar sits between the two halves"
_L1_PROBLEM = {
    "check": L1_CHECK,
    "observed": "the bar sits out at the edge of the board, not between the halves",
}

_PASS: dict[str, Any] = {
    "verdict": "PASS",
    "conformed": True,
    "problems": [],
    "failed_gates": [],
}


def _phases(layers: list[int | None]) -> list[Phase]:
    """One build phase per entry: index is POSITION, layer is the entry.

    ``PromptPack.phases()`` refuses any other numbering, and the per-phase
    WO-ABORT check folds the completion rows up to ``phase.index``, so a plan
    whose indices skip a number reports the skipped phases ``not_reached``.
    Names and files are labels only — the fake pack reads nothing off disk.
    """
    return [
        Phase(index, f"Phase {index}", layer, f"chunk-0{index}.md", f"SPEC {index}")
        for index, layer in enumerate(layers, start=1)
    ]


def _roster(tmp_path: Path) -> Path:
    """A REAL roster file, so ``_ensure_gate_roster`` short-circuits.

    A campaign writes one roster before its first cell and every grade in it is
    compared against that denominator; the runner uses an existing file exactly
    as it is. Nothing in these tests reads the contents — the gate oracle is a
    fake — but the file must exist for the argv and the short-circuit to be the
    real ones.
    """
    path = tmp_path / "gate-roster.json"
    path.write_text('{"gates": []}\n', encoding="utf-8")
    return path


def _cell_runner(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    layers: list[int | None] | None = None,
) -> ChallengeRunner:
    """A runner with Docker faked and a roster set.

    ``layers`` omitted leaves the runner's own ``PromptPack`` in place, so the
    cell reads the CHALLENGE'S plan (task/backgammon/prompts/phase-plan.json)
    rather than a test's copy of it; a list scripts a shorter plan instead.
    """
    _patch_fake_docker(monkeypatch)
    if layers is not None:
        monkeypatch.setattr(runner_mod, "PromptPack", _pack_factory(_phases(layers)))
    runner = _make_runner(tmp_path, cost_limit_usd=None)
    runner.gate_roster_path = _roster(tmp_path)
    return runner


def _contains_pair(argv: list[str], left: str, right: str) -> bool:
    return any(
        item == left and argv[index + 1] == right
        for index, item in enumerate(argv[:-1])
    )


def test_every_phase_is_built_in_order_and_layer_three_is_graded_twice(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """(a) Seven builds in phase order; grades land on layers [1, 2, 3, 3].

    THIS IS THE CHALLENGE'S OWN PLAN — the runner constructs ``PromptPack`` from
    the task dir, so nothing here scripts the phases: the three backend phases
    declare no layer, the four frontend phases declare 1, 2, 3, 3.

    The gate PASSes every time, so each layer is green on its first scoped
    grade and the cell ends ``gates_green`` with nothing to repair.
    """
    runner = _cell_runner(tmp_path, monkeypatch)

    builds: list[str] = []

    def _fake_opencode(**kwargs: Any) -> _OpencodeRunStats:
        builds.append(str(kwargs.get("phase") or ""))
        return _stats(session_id="sess-1", exit_code=0, cost_usd=0.0)

    monkeypatch.setattr(runner, "_run_opencode_serve", _fake_opencode)

    layers: list[int | None] = []

    def _fake_gate(**kwargs: Any) -> dict[str, Any]:
        layers.append(kwargs.get("layer"))
        return dict(_PASS)

    monkeypatch.setattr(runner, "_run_gate_report", _fake_gate)

    result = runner._run_cell_impl(
        run_label="layered-sequence",
        run_dir=tmp_path / "layered-sequence",
        task_id="backgammon",
    )

    # THE ORDER IS THE PACK'S: one drive per phase, phase indices 1..7.
    assert builds == [f"initial-chunk-{k}" for k in range(1, 8)]
    # THE TWO LAYER-3 GRADES: phase 6 ("Layer 3 — gameplay") and phase 7
    # ("Wire and verify") both declare layer 3, so 3 is graded twice.
    assert layers == [1, 2, 3, 3]

    assert result.verdict == "PASS"
    assert result.termination_reason == "gates_green"
    # Every layer passed its first scoped grade, so no layer needed a repair.
    assert result.attempts_to_green == 0
    assert result.build_chunks is not None
    assert [row["chunk"] for row in result.build_chunks] == list(range(1, 8))
    assert [row["state"] for row in result.build_chunks] == ["complete"] * 7


def test_a_layer_never_advances_until_its_scoped_grade_passes(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """(b) Layer 1 never passes, so layer 2 is never built and never graded.

    The plan is the real shape: three backend phases, then L1 (layer 1), then L2
    (layer 2). Layer 1's grade FAILs on a real layer-1 gate forever, so the
    troubleshooting loop keeps repeating LAYER 1 — the next phase's build is
    never sent and no grade is ever asked for layer 2.

    The loop is ended the way a real cell's is: the worker stops on its own
    output budget mid-repair (``budget_stop_detected`` on the drive's stats). The
    ENDING IS INCIDENTAL — what is asserted is that it is NOT ``gates_green``,
    because no scoped pass ever happened.
    """
    runner = _cell_runner(tmp_path, monkeypatch, [None, None, None, 1, 2])

    drives: list[str] = []
    repair_rounds = {"count": 0}

    def _fake_opencode(**kwargs: Any) -> _OpencodeRunStats:
        phase = str(kwargs.get("phase") or "")
        drives.append(phase)
        if phase.startswith("initial-chunk-"):
            return _stats(session_id="sess-1", exit_code=0, cost_usd=0.0)
        repair_rounds["count"] += 1
        return _stats(
            session_id="sess-1",
            exit_code=0,
            cost_usd=0.0,
            # The SECOND repair round runs out of output budget: the cell ends
            # there instead of looping on layer 1 forever.
            budget_stop_detected=repair_rounds["count"] >= 2,
        )

    monkeypatch.setattr(runner, "_run_opencode_serve", _fake_opencode)

    layers: list[int | None] = []

    def _fake_gate(**kwargs: Any) -> dict[str, Any]:
        layers.append(kwargs.get("layer"))
        return {
            "verdict": "FAIL",
            "conformed": True,
            "problems": [dict(_L1_PROBLEM)],
            "failed_gates": [L1_CHECK],
        }

    monkeypatch.setattr(runner, "_run_gate_report", _fake_gate)

    result = runner._run_cell_impl(
        run_label="layer-does-not-advance",
        run_dir=tmp_path / "layer-does-not-advance",
        task_id="backgammon",
    )

    # EVERY grade was the layer-1 pass: not one was asked for layer 2.
    assert layers, "layer 1 was graded at least once"
    assert set(layers) == {1}, "a layer advances only on a scoped PASS"
    # The L2 build (phase 5) NEVER ran: a layer is not built over an unresolved
    # one, and the assertion above is why there was nothing to build it for.
    assert f"initial-chunk-{5}" not in drives
    assert [d for d in drives if d.startswith("initial-chunk-")] == [
        f"initial-chunk-{k}" for k in (1, 2, 3, 4)
    ]
    # The cell did NOT end green.
    assert result.verdict != "PASS"
    assert result.termination_reason != "gates_green"
    assert result.termination_reason == "budget_stop_mid_attempt"
    assert result.attempts_to_green == "BUDGET_STOP"


def test_a_layered_grade_carries_its_layer_and_the_roster_on_argv(
    tmp_path: Path,
) -> None:
    """(c) The grade's scope and its roster are BOTH argv, never env or implied.

    ``--layer N`` is the pass being graded — an argument of the grading run
    itself, because the container must not inherit a layer from its environment.
    ``--roster`` is what lets a scoped grade say which gates never ran: without
    it a layered report cannot distinguish "passed" from "not asked for".
    """
    roster = _roster(tmp_path)
    argv = gate_argv(
        worktree=tmp_path / "worktree",
        report_path=tmp_path / "cell" / "attempt-1-report.json",
        roster_path=roster,
        attempt=1,
        layer=2,
    )

    assert "--roster" in argv, "a scoped grade is told which gates exist"
    assert _contains_pair(argv, "--layer", "2")
    assert not any(
        item == "-e" and "LAYER" in argv[index + 1]
        for index, item in enumerate(argv[:-1])
    ), "the layer is the run's scope, never an environment variable"


def test_the_cell_grades_against_the_roster_it_was_handed(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """(c) Every graded phase in a cell reads the SAME roster file.

    An existing roster is the denominator every grade in the campaign is
    compared against, so it is used exactly as it is and never re-baselined:
    ``_ensure_gate_roster`` short-circuits on the file check, and each phase's
    grade is scoped to that phase's own layer.
    """
    runner = _cell_runner(tmp_path, monkeypatch, [1, 2])
    handed = runner.gate_roster_path
    assert handed is not None

    def _fake_opencode(**kwargs: Any) -> _OpencodeRunStats:
        return _stats(session_id="sess-1", exit_code=0, cost_usd=0.0)

    monkeypatch.setattr(runner, "_run_opencode_serve", _fake_opencode)

    layers: list[int | None] = []

    def _fake_gate(**kwargs: Any) -> dict[str, Any]:
        layers.append(kwargs.get("layer"))
        return dict(_PASS)

    monkeypatch.setattr(runner, "_run_gate_report", _fake_gate)

    result = runner._run_cell_impl(
        run_label="roster-per-grade",
        run_dir=tmp_path / "roster-per-grade",
        task_id="backgammon",
    )

    assert layers == [1, 2], "each phase grades its own layer"
    assert result.verdict == "PASS"
    # The roster is a REAL file and the one the cell was handed — written once,
    # never replaced mid-cell.
    assert runner.gate_roster_path == handed
    assert runner.gate_roster_path.is_file()


def test_build_compactions_never_end_a_stretch_and_the_second_repair_one_does(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """(d) The 2-compactions abort is PER TROUBLESHOOTING STRETCH, never a build.

    Every build drive here reports a heavy ``compactions_since_grade`` (5). That
    signal cannot end the cell: the count is only ever read off a REPAIR round's
    drive (``feedback_run``), and the chunked build's aggregate does not carry
    the field at all. So the cell walks on to the layer-1 grade; the FIRST repair
    round then reports the threshold (2) and the cell ends there —
    ``compactions_before_grade`` — with layer 2 never built.
    """
    runner = _cell_runner(tmp_path, monkeypatch, [1, 2])

    drives: list[str] = []

    def _fake_opencode(**kwargs: Any) -> _OpencodeRunStats:
        phase = str(kwargs.get("phase") or "")
        drives.append(phase)
        if phase.startswith("initial-chunk-"):
            return _stats(
                session_id="sess-1",
                exit_code=0,
                cost_usd=0.0,
                compactions_since_grade=5,
            )
        return _stats(
            session_id="sess-1",
            exit_code=0,
            cost_usd=0.0,
            compactions_since_grade=2,
        )

    monkeypatch.setattr(runner, "_run_opencode_serve", _fake_opencode)

    layers: list[int | None] = []

    def _fake_gate(**kwargs: Any) -> dict[str, Any]:
        layers.append(kwargs.get("layer"))
        return {
            "verdict": "FAIL",
            "conformed": True,
            "problems": [dict(_L1_PROBLEM)],
            "failed_gates": [L1_CHECK],
        }

    monkeypatch.setattr(runner, "_run_gate_report", _fake_gate)

    result = runner._run_cell_impl(
        run_label="compactions-per-stretch",
        run_dir=tmp_path / "compactions-per-stretch",
        task_id="backgammon",
    )

    assert result.termination_reason == COMPACTIONS_BEFORE_GRADE
    assert result.attempts_to_green == "COMPACTIONS_BEFORE_GRADE"
    assert result.verdict == "FAIL"
    # The abort fired during TROUBLESHOOTING, not during a build: the build
    # reported a 5-compaction signal and the cell still reached its grade, then
    # drove one repair round — and that round is what ended the cell.
    assert layers == [1], "the build was graded: its compactions never counted"
    assert drives == ["initial-chunk-1", "feedback-1"]
    # Layer 2 was never built.
    assert "initial-chunk-2" not in drives


def test_dev_mode_pauses_after_a_passing_layer_before_the_next_is_built(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A passing layer grade pauses too, then the next phase is built.

    Run 1794248721 passed layer 1 and went straight into building layer 2: the
    round pause sat on the repair path only. Every layer passes here, so the
    pauses are one round pause after each non-last layered phase's PASS, then
    the final pause; the told text of each round pause is the next build.
    """
    runner = _cell_runner(tmp_path, monkeypatch)
    runner.pause_after_grade = True

    events: list[tuple[str, Any]] = []

    def _fake_opencode(**kwargs: Any) -> _OpencodeRunStats:
        events.append(("build", str(kwargs.get("phase") or "")))
        return _stats(session_id="sess-1", exit_code=0, cost_usd=0.0)

    def _fake_pause(**kwargs: Any) -> float:
        events.append(("pause", kwargs["kind"], kwargs.get("told_text") or ""))
        return 0.0

    monkeypatch.setattr(runner, "_run_opencode_serve", _fake_opencode)
    monkeypatch.setattr(runner, "_run_gate_report", lambda **_: dict(_PASS))
    monkeypatch.setattr(runner, "_run_operator_pause", _fake_pause)

    result = runner._run_cell_impl(
        run_label="pause-on-pass",
        run_dir=tmp_path / "pause-on-pass",
        task_id="backgammon",
    )

    assert result.verdict == "PASS"
    pauses = [e for e in events if e[0] == "pause"]
    # Layers on phases 4, 5, 6, 7: a round pause after the PASS of 4, 5 and 6,
    # and the final pause after 7.
    assert [p[1] for p in pauses] == ["round", "round", "round", "final"]
    # Each round pause comes BEFORE the next phase's build and shows it.
    for k in (5, 6, 7):
        pause_at = next(
            i for i, e in enumerate(events) if e[0] == "pause" and f"phase {k}:" in e[2]
        )
        build_at = events.index(("build", f"initial-chunk-{k}"))
        assert pause_at < build_at
