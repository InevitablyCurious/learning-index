"""THE LIVE-STREAM LABEL RULES (WO-LI-C4-I).

Two rules, stated here as tests.

  (a) EVERY PHASE-BEARING LIVE EVENT CARRIES THE LABEL, AND EACH KEY HAS ONE
      MEANING. ``phase_index`` / ``phase_name`` / ``phase_kind`` (plus
      ``phase_layer`` when the phase is layered) come from
      :func:`harness.prompt_pack.phase_label` and ride ``phase.start``,
      ``heartbeat``, ``gate.result``, ``attempt.end``, ``pause.start`` and
      ``pause.end``. The free-text ``phase`` STRING rides ONLY ``phase.start``
      and ``heartbeat`` — the two records the dashboard regexes. ``gate.result``
      carries the GRADER's grouping as ``gate_phase`` and has no ``phase`` key at
      all, so "phase" cannot mean two different things on one stream.

  (b) EVERY ATTEMPT/GRADE RECORD CARRIES LAYER + PHASE + KIND. The live
      ``attempt.end`` and ``gate.result`` and the DURABLE ``attempt_reports``
      entry the cell returns all carry the same four keys, with the same values,
      for a layered phase.

WHY THESE ARE RULES AND NOT IMPLEMENTATION DETAIL. A label only some records
carry is a label a reader has to guess at: a board that sees ``phase_index`` on
``attempt.end`` but not on ``gate.result`` cannot group a grade under the phase
it belongs to, and a ``phase`` key that is sometimes the drive string and
sometimes the grader's grouping is worse than no key. The label is also the
JOIN KEY between the live stream and the durable record, so the two must be one
spelling or a reader has to learn two.

NO MODEL, NO DOCKER, NO GRADER RUNS. The cell is driven through the shared fakes
(tests/_serve_drive_fakes.py for the serve client, tests/test_challenge_budget_stop.py
for docker and the gate roster), and ``_run_opencode_serve`` is NOT patched out —
so the ``phase.start`` and heartbeat records asserted below are the production
emission sites, not a stand-in for them.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

import harness.adapters.challenge as challenge_mod
import harness.adapters.challenge.runner as runner_mod
from harness.adapters.challenge import ChallengeCellResult, ChallengeRunner
from tests._serve_drive_fakes import (
    TASK_DIR,
    _FakeServeClient,
    _metrics,
    _one_layer_phase,
    _pack_factory,
)
from tests.test_challenge_budget_stop import _patch_fake_docker

#: A REAL layer-1 gate id, spelled the way the grader publishes a check. The
#: feedback voice is single-system (every complaint needs a human-written line in
#: grader/feedback.json), so a repair round must be driven by a real gate.
REAL_CHECK = "[G02] REQ-PIP — pip count"

#: The identity `phase_label` writes. ``phase_layer`` is present only for a
#: LAYERED phase: a backend phase OMITS the key rather than writing null.
LABEL_KEYS = ("phase_index", "phase_name", "phase_kind")
LAYERED_KEYS = (*LABEL_KEYS, "phase_layer")

#: The one phase this cell builds and grades.
PHASE = _one_layer_phase()[0]

#: The record kinds that name a phase. A beat opens no phase of its own — see
#: the heartbeat assertions — so it is handled beside them, not in the loop.
PHASE_BEARING = (
    "phase.start",
    "gate.result",
    "attempt.end",
    "pause.start",
    "pause.end",
)


class _CellServeClient(_FakeServeClient):
    """The shared drive fake, plus the ONE call the CELL makes itself.

    ``_serve_drive_fakes._FakeServeClient`` is handed a session id by its
    caller; ``_run_cell_impl`` creates the session first, so this adds exactly
    that. Every other surface — send, wait, metrics, summarize — is the shared
    fake, unmodified.
    """

    def create_session(self, title: str | None = None) -> str:
        return "ses_hermetic"


def _roster(tmp_path: Path) -> Path:
    """A REAL roster file, so ``_ensure_gate_roster`` short-circuits.

    Nothing here reads the contents — the gate oracle is a fake — but the file
    must exist for the runner to treat the campaign's denominator as already
    written rather than re-baselining mid-cell.
    """
    path = tmp_path / "gate-roster.json"
    path.write_text('{"gates": []}\n', encoding="utf-8")
    return path


def _gate_report(*, verdict: str, check: str | None = None) -> dict[str, Any]:
    """A gate report shaped the way the grader publishes one.

    ``gate_results`` is where the live ``gate.result`` rows come from, and each
    row carries the GRADER's grouping in its own ``phase`` field
    (conformance|backend|frontend) — the very field the runner renames to
    ``gate_phase`` precisely so ``phase`` keeps one meaning.
    """
    report: dict[str, Any] = {
        "verdict": verdict,
        "conformed": True,
        "problems": [] if check is None else [{"check": check}],
        "failed_gates": [] if check is None else [check],
        "gate_results": [
            {
                "id": check or "[G01] REQ-INIT — initial position",
                "status": "fail" if check else "pass",
                "phase": "frontend",
                "duration_ms": 7,
            }
        ],
        "gate_totals": {"passed": 0 if check else 1, "failed": 1 if check else 0},
    }
    return report


def _rows(run_dir: Path) -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in (run_dir / "live.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def _run_labeled_cell(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[ChallengeCellResult, list[dict[str, Any]]]:
    """One whole cell: build the layered phase, FAIL once, repair, PASS.

    ONE FAILURE THEN A PASS is what puts a ``round`` pause AND a ``final`` pause
    on the stream, so both pause records under test are the production ones. The
    gate roster is a real file; the serve client, docker and the gate oracle are
    the shared fakes.
    """
    _patch_fake_docker(monkeypatch)
    # THE REAL DRIVE, over the full-featured fake client: `phase.start` and the
    # heartbeat phase are set inside harness/adapters/challenge/serve.py, so
    # patching `_run_opencode_serve` out would leave nothing to assert there.
    #
    # ONE SCRIPTED READ PER READ: the drive meters each phase as the DELTA
    # between a baseline read and a post-drive read, and a phase that adds no
    # turn and no token is the `silent_phase` ending — so the two drives below
    # are scripted to actually advance (baseline, post, baseline, post).
    client = _CellServeClient()
    client.metrics_script = [
        _metrics(0, 0, 0),
        _metrics(1, 10, 20),
        _metrics(1, 10, 20),
        _metrics(2, 30, 60),
    ]
    monkeypatch.setattr(challenge_mod, "ServeClient", lambda *a, **k: client)
    monkeypatch.setattr(runner_mod, "PromptPack", _pack_factory(_one_layer_phase()))
    # The hold blocks for an operator; the records around it are what is under
    # test, so the one thing that can wait returns at once.
    monkeypatch.setattr(runner_mod, "_hold_for_operator", lambda **kwargs: None)

    runner = ChallengeRunner(
        task_dir=TASK_DIR,
        work_root=tmp_path / "work-root",
        model="local-llm-proxy/qwen3.6-35b-a3b-bench",
        pause_after_grade=True,
    )
    runner.gate_roster_path = _roster(tmp_path)

    grades = {"count": 0}
    beats: list[bool] = []

    def _fake_gate(**kwargs: Any) -> dict[str, Any]:
        grades["count"] += 1
        # A beat lands BETWEEN the build's `phase.start` and this grade's own
        # records — the real cadence a wall-clock beat takes during a phase.
        # `beat()` is public for exactly this: no clock in a test.
        beats.append(runner._heartbeat.beat())
        if grades["count"] == 1:
            return _gate_report(verdict="FAIL", check=REAL_CHECK)
        return _gate_report(verdict="PASS")

    monkeypatch.setattr(runner, "_run_gate_report", _fake_gate)

    run_dir = tmp_path / "labeled-cell"
    result = runner.run_cell("labeled-cell", run_dir, task_id="backgammon")
    assert beats and all(beats), (
        "a beat taken during the grade must be written, and this cell never "
        f"reached a grade (it ended {result.termination_reason!r})"
    )
    return result, _rows(run_dir)


def test_every_phase_bearing_event_carries_the_label_and_phase_is_one_meaning(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """(a) The label is on every phase record; the phase STRING is on two kinds.

    Nothing in this cell is synthesized: the build drives the real
    ``_run_opencode_serve`` (which publishes ``phase.start`` and hands the phase
    to the heartbeat), the grade drives the real ``gate.result``/``attempt.end``
    sites, and the pauses drive the real ``_run_operator_pause`` body.
    """
    result, rows = _run_labeled_cell(tmp_path, monkeypatch)
    assert result.verdict == "PASS"
    assert result.termination_reason == "gates_green"

    seen: set[str] = set()
    for row in rows:
        kind = row["kind"]
        if kind not in PHASE_BEARING:
            continue
        seen.add(kind)
        for key in LAYERED_KEYS:
            assert key in row, f"{kind} lost the label key {key}"
        if kind == "phase.start":
            # The dashboard regexes this string; it is the DRIVE phase. For a
            # repair round the drive is `feedback-N` — the label's `phase_index`
            # still names the BUILD phase that round belongs to, so the two
            # spellings cannot drift apart.
            assert row["phase"] == (
                f"initial-chunk-{row['phase_index']}"
                if row["phase_kind"] == "build"
                else "feedback-1"
            )
        else:
            # `gate.result` has NO `phase` key: its grouping is `gate_phase`.
            assert "phase" not in row, f"{kind} must not carry the phase string"
    # Every kind above was actually produced — otherwise the loop could pass by
    # having nothing to check.
    assert seen == set(PHASE_BEARING), f"a phase-bearing kind never fired: {seen}"

    # THE BUILD AND THE REPAIR ROUND EACH OPENED WITH THEIR OWN DRIVE STRING.
    starts = [row for row in rows if row["kind"] == "phase.start"]
    assert [(row["phase"], row["phase_kind"]) for row in starts] == [
        (f"initial-chunk-{PHASE.index}", "build"),
        ("feedback-1", "troubleshooting"),
    ]

    # BOTH pauses fired, so both pause records above are the production ones.
    pause_kinds = [row["pause_kind"] for row in rows if row["kind"] == "pause.start"]
    assert pause_kinds == ["round", "final"]

    # THE GRADER'S GROUPING KEEPS ITS OWN NAME.
    gate_rows = [row for row in rows if row["kind"] == "gate.result"]
    assert gate_rows, "a graded phase must publish its gate rows"
    for row in gate_rows:
        assert row["gate_phase"] == "frontend", "the grouping is gate_phase"

    # THE PHASE STRING LIVES ON EXACTLY TWO KINDS.
    carrying = {row["kind"] for row in rows if "phase" in row}
    assert carrying == {"phase.start", "heartbeat"}, (
        f"the phase string must ride only phase.start and heartbeat, got {carrying}"
    )

    # THE HEARTBEAT CARRIES THE SAME LABEL — after a phase has opened.
    beats = [row for row in rows if row["kind"] == "heartbeat"]
    assert beats, "the cell must beat"
    # The first beat is synchronous at cell start, BEFORE any phase opens. A
    # beat with no phase names none (nulls are dropped, never written): that is
    # an honest "not in a phase yet", not a missing label.
    assert all(key not in beats[0] for key in LAYERED_KEYS)
    labelled = [beat for beat in beats if "phase_index" in beat]
    assert labelled, "a beat taken after phase.start must name the phase"
    for beat in labelled:
        for key in LAYERED_KEYS:
            assert key in beat
        assert beat["phase_index"] == PHASE.index
        assert beat["phase_name"] == PHASE.name
        # The beat's drive string and its label's kind agree on which round it
        # is — a beat can never report one phase's index under another's string.
        if beat["phase_kind"] == "build":
            assert beat["phase"] == f"initial-chunk-{PHASE.index}"
        else:
            assert beat["phase"] == "feedback-1"
    # The LAST labelled beat is the repair round's, so `set_phase` REPLACED the
    # build label instead of leaving a stale one behind.
    assert (labelled[-1]["phase"], labelled[-1]["phase_kind"]) == (
        "feedback-1",
        "troubleshooting",
    )


def test_every_attempt_and_grade_record_carries_layer_phase_and_kind(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """(b) Live attempts, live gate rows and the durable report agree on all four.

    ``phase_kind`` is not decoration: the first grade of a troubleshooting
    stretch reads the tree the phase's BUILD produced, every later one reads a
    FEEDBACK round, and the record says which.
    """
    result, rows = _run_labeled_cell(tmp_path, monkeypatch)

    ends = [row for row in rows if row["kind"] == "attempt.end"]
    assert [row["phase_kind"] for row in ends] == ["build", "troubleshooting"]
    gate_rows = [row for row in rows if row["kind"] == "gate.result"]
    assert len(gate_rows) == len(ends), "one gate row per attempt here"

    # EVERY live record of this layered phase: index, name, layer and kind.
    for row in [*ends, *gate_rows]:
        assert row["phase_index"] == PHASE.index
        assert row["phase_name"] == PHASE.name
        assert row["phase_layer"] == PHASE.layer
        assert row["phase_kind"] in {"build", "troubleshooting"}

    # THE DURABLE ROW CARRIES THE SAME FOUR KEYS, with the same values.
    reports = result.attempt_reports
    assert len(reports) == len(ends)
    for report in reports:
        assert report["phase_index"] == PHASE.index
        assert report["phase_name"] == PHASE.name
        assert report["phase_layer"] == PHASE.layer
        assert report["phase_kind"] in {"build", "troubleshooting"}
    # ONE SPELLING, BOTH PLACES: the stream and the record cannot disagree.
    assert [report["phase_kind"] for report in reports] == [
        row["phase_kind"] for row in ends
    ]
    assert [report["phase_index"] for report in reports] == [
        row["phase_index"] for row in ends
    ]
