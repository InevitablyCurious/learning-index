"""A grading pass that measured nothing is regraded once; twice is the
instrument's failure, VOID, never the model's (Jerry, 2026-09-23)."""

from __future__ import annotations

from pathlib import Path

import pytest

from harness.adapters.challenge import (
    ChallengeRunner,
    GraderReportUnreadableError,
    InstrumentFaultError,
)


class _Grader:
    """Just enough of the runner for _grade_measured: a scripted grader."""

    _grade_measured = ChallengeRunner._grade_measured

    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.progress: list[str] = []

    def _progress(self, line: str) -> None:
        self.progress.append(line)

    def _run_gate_report(self, *, report_path: Path, log_path: Path, **_kw):
        report_path.write_text("{}")
        log_path.write_text("log")
        out = self.outcomes.pop(0)
        if isinstance(out, Exception):
            raise out
        return out


def _grade(tmp_path: Path, outcomes):
    g = _Grader(outcomes)
    rep, log = tmp_path / "attempt-2-report.json", tmp_path / "attempt-2-gate.log"
    return g, g._grade_measured(
        worktree=tmp_path, report_path=rep, log_path=log, attempt=2
    )


def test_a_measured_pass_is_used_as_is(tmp_path: Path) -> None:
    g, report = _grade(tmp_path, [{"gradable": True, "verdict": "FAIL"}])
    assert report["verdict"] == "FAIL" and g.outcomes == [] and not g.progress


def test_an_unmeasured_pass_is_regraded_once_and_its_evidence_kept(
    tmp_path: Path,
) -> None:
    g, report = _grade(
        tmp_path,
        [
            {"gradable": False, "ungradable_reason": "backend runner aborted"},
            {"gradable": True, "verdict": "PASS"},
        ],
    )
    assert report["verdict"] == "PASS"
    assert (tmp_path / "attempt-2-report.first-pass.json").is_file()
    assert (tmp_path / "attempt-2-gate.first-pass.log").is_file()
    assert any("step=regrade" in p for p in g.progress)


def test_twice_unmeasured_is_an_instrument_fault(tmp_path: Path) -> None:
    with pytest.raises(InstrumentFaultError, match="twice"):
        _grade(tmp_path, [GraderReportUnreadableError("missing"), {"gradable": False}])


def test_a_deadline_kill_is_the_candidates_hang_not_the_instrument(
    tmp_path: Path,
) -> None:
    # report.mjs: a runner killed on a deadline means the code under test did
    # not return. Regrading would hang again and void the model's failure.
    hang = {
        "gradable": False,
        "ungradable_reason": "backend gates-13-16.test.ts was KILLED ON A DEADLINE",
        "aborted_runners": ["backend gates-13-16.test.ts"],
        "timed_out_runners": ["backend gates-13-16.test.ts"],
        "skipped_runners": [],
    }
    g, report = _grade(tmp_path, [hang])
    assert report is hang and not g.progress, "used as measured, no regrade"


def test_an_abort_that_was_not_a_deadline_is_still_regraded(tmp_path: Path) -> None:
    crashed = {
        "gradable": False,
        "aborted_runners": ["conformance"],
        "timed_out_runners": [],
    }
    g, report = _grade(tmp_path, [crashed, {"gradable": True}])
    assert report == {"gradable": True} and any("step=regrade" in p for p in g.progress)
