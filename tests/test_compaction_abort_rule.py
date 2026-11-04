"""Two compactions before a grade ends the cell — and it is troubleshooting-only.

THE RULE (harness/adapters/challenge/runner.py, ``COMPACTIONS_BEFORE_GRADE``):
opencode auto-compacts when the conversation outgrows the window. Inside a
repair round that is RECOVERY — the session rebuilt its context and carried on
fixing. A SECOND compaction with no grade in between means the round is
spending its budget rewriting context instead of changing code, so the cell is
ended with ``termination_reason == "compactions_before_grade"`` rather than
scored as if it were a real result (``build_scorecard`` voids it for the same
reason; see tests/test_cap_cutoff_void.py).

ENFORCED IN-DRIVE, INSIDE ONE DRIVE. The count is taken by
``_run_opencode_serve`` at every turn end — the loop that already watches turn
ends, recovery and context overflow — so a model that keeps compacting across
recovered turns inside ONE long drive is aborted at the second compaction
instead of riding the recovery loop forever without ever returning. The drive
carries the count back on ``_OpencodeRunStats.compactions_since_grade`` and the
runner maps it to the cell terminal; there is no post-drive recount.

TROUBLESHOOT-ONLY BY CONSTRUCTION, NOT BY A MODE FLAG. The ``compaction_watermark``
is passed only by ``_run_cell_attempt`` (the feedback entry); the chunked build
runs through ``_run_opencode_serve_chunked`` -> ``_drive`` and leaves it None, so
a build's per-chunk summarize is never counted. The watermark is re-captured at
EVERY grade (right after ``final_report = report``), so one compaction per round
never accumulates across rounds.

Each test drives a real full cell through ``_run_cell_impl`` with the shared
fakes from tests/test_challenge_budget_stop.py, returning the drive's own
``compactions_since_grade`` signal from the fake ``_run_opencode_serve``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from harness.adapters.challenge import _OpencodeRunStats
from harness.adapters.challenge.runner import COMPACTIONS_BEFORE_GRADE
from harness.live_stream import LiveStream
from tests.test_challenge_budget_stop import (
    REAL_CHECK,
    _make_runner,
    _patch_fake_docker,
    _stats,
)


def _always_fail_gate(**kwargs: Any) -> dict[str, Any]:
    """A gradable FAIL report on a REAL gate id.

    The single-system feedback contract hard-fails on synthetic labels, so the
    loop must be driven with a genuine gate id.
    """
    return {
        "verdict": "FAIL",
        "conformed": True,
        "problems": [{"check": REAL_CHECK}],
        "failed_gates": [REAL_CHECK],
    }


def test_fires_at_the_second_troubleshoot_compaction_before_a_grade(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Two compactions in one repair round end the cell as COMPACTIONS_BEFORE_GRADE.

    The build completes without a single compaction, grade 1 is a gradable FAIL,
    and the ``feedback-1`` drive compacts twice before it returns. The ENDING is
    the second compaction itself — the cell's legitimate abort — so nothing
    bounds the round count.
    """
    runner = _make_runner(tmp_path, cost_limit_usd=None)
    _patch_fake_docker(monkeypatch)
    monkeypatch.setattr(
        runner, "_load_chunk_prompts", lambda *args, **kwargs: ["CHUNK ONE"]
    )
    monkeypatch.setattr(runner, "_run_gate_report", _always_fail_gate)

    def _fake_opencode(**kwargs: Any) -> _OpencodeRunStats:
        if kwargs.get("phase") == "feedback-1":
            return _stats(
                session_id="sess-1",
                exit_code=0,
                cost_usd=0.0,
                compactions_since_grade=2,
            )
        return _stats(session_id="sess-1", exit_code=0, cost_usd=0.0)

    monkeypatch.setattr(runner, "_run_opencode_serve", _fake_opencode)

    result = runner._run_cell_impl(
        run_label="two-compactions-before-grade",
        run_dir=tmp_path / "two-compactions-before-grade",
        task_id="backgammon",
    )

    assert result.termination_reason == COMPACTIONS_BEFORE_GRADE
    assert result.attempts_to_green == "COMPACTIONS_BEFORE_GRADE"
    assert result.verdict == "FAIL"


def test_build_compactions_never_trigger_the_abort(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A build's compaction signal never counts against a repair round.

    Every ``initial-chunk-`` drive reports a large ``compactions_since_grade`` —
    simulating a build that compacted heavily per chunk — and the runner ignores
    it: the build never passes a watermark, so the cell's terminal is decided by
    the FEEDBACK drive alone. ``feedback-1`` compacts exactly ONCE (healthy:
    recovery), and the cell ends the only way an uncapped loop can end normally:
    the gate PASSES on the next grade (``gates_green``).
    """
    runner = _make_runner(tmp_path, cost_limit_usd=None)
    _patch_fake_docker(monkeypatch)
    monkeypatch.setattr(
        runner,
        "_load_chunk_prompts",
        lambda *args, **kwargs: ["CHUNK ONE", "CHUNK TWO", "CHUNK THREE"],
    )

    grades = {"count": 0}

    def _fail_once_then_pass(**kwargs: Any) -> dict[str, Any]:
        """FAIL once, then PASS — a bounded gate, never a bounded round count."""
        grades["count"] += 1
        if grades["count"] == 1:
            return {
                "verdict": "FAIL",
                "conformed": True,
                "problems": [{"check": REAL_CHECK}],
                "failed_gates": [REAL_CHECK],
            }
        return {
            "verdict": "PASS",
            "conformed": True,
            "problems": [],
            "failed_gates": [],
        }

    monkeypatch.setattr(runner, "_run_gate_report", _fail_once_then_pass)

    def _fake_opencode(**kwargs: Any) -> _OpencodeRunStats:
        phase = str(kwargs.get("phase") or "")
        if phase.startswith("initial-chunk-"):
            return _stats(
                session_id="sess-1",
                exit_code=0,
                cost_usd=0.0,
                compactions_since_grade=5,
            )
        if phase == "feedback-1":
            return _stats(
                session_id="sess-1",
                exit_code=0,
                cost_usd=0.0,
                compactions_since_grade=1,
            )
        return _stats(session_id="sess-1", exit_code=0, cost_usd=0.0)

    monkeypatch.setattr(runner, "_run_opencode_serve", _fake_opencode)

    result = runner._run_cell_impl(
        run_label="build-compactions-ignored",
        run_dir=tmp_path / "build-compactions-ignored",
        task_id="backgammon",
    )

    # The abort did NOT fire: the cell ended by passing its gate — the
    # legitimate ending, since nothing caps the round count any more.
    assert result.termination_reason != COMPACTIONS_BEFORE_GRADE
    assert result.termination_reason == "gates_green"
    assert result.verdict == "PASS"


def test_the_count_resets_at_each_grade(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """One compaction per repair round never accumulates into an abort.

    The watermark is re-captured at every grade and the count is per-drive, so
    ``feedback-1``'s single compaction is behind round 2's waterline. Two rounds
    that each compact once are two recoveries, not a stuck session — the gate
    FAILs twice and then PASSes, so the cell ends ``gates_green`` (a legitimate
    ending) rather than on a round count.
    """
    runner = _make_runner(tmp_path, cost_limit_usd=None)
    _patch_fake_docker(monkeypatch)
    monkeypatch.setattr(
        runner, "_load_chunk_prompts", lambda *args, **kwargs: ["CHUNK ONE"]
    )

    grades = {"count": 0}

    def _fail_twice_then_pass(**kwargs: Any) -> dict[str, Any]:
        """FAIL twice, then PASS — a bounded gate, never a bounded round count."""
        grades["count"] += 1
        if grades["count"] <= 2:
            return {
                "verdict": "FAIL",
                "conformed": True,
                "problems": [{"check": REAL_CHECK}],
                "failed_gates": [REAL_CHECK],
            }
        return {
            "verdict": "PASS",
            "conformed": True,
            "problems": [],
            "failed_gates": [],
        }

    monkeypatch.setattr(runner, "_run_gate_report", _fail_twice_then_pass)

    compacted_phases: list[str] = []

    def _fake_opencode(**kwargs: Any) -> _OpencodeRunStats:
        phase = str(kwargs.get("phase") or "")
        if phase in {"feedback-1", "feedback-2"}:
            compacted_phases.append(phase)
            return _stats(
                session_id="sess-1",
                exit_code=0,
                cost_usd=0.0,
                compactions_since_grade=1,
            )
        return _stats(session_id="sess-1", exit_code=0, cost_usd=0.0)

    monkeypatch.setattr(runner, "_run_opencode_serve", _fake_opencode)

    result = runner._run_cell_impl(
        run_label="count-resets-at-grade",
        run_dir=tmp_path / "count-resets-at-grade",
        task_id="backgammon",
    )

    # Both repair rounds compacted exactly once — an accumulating reading would
    # have aborted this cell at the second round.
    assert compacted_phases == ["feedback-1", "feedback-2"]
    assert result.termination_reason != COMPACTIONS_BEFORE_GRADE
    # The ending: the gate PASSED on round 3, the only normal way an uncapped
    # loop stops.
    assert result.termination_reason == "gates_green"


def test_a_live_stream_notice_is_emitted_when_the_rule_fires(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """The abort reaches the live stream as an error-level harness notice.

    A cell that ends this way produced no capability result, and an operator
    reading the board has to be told why rather than see a silent FAIL. The
    record is ``kind=notice``, ``source=harness``, ``event=compactions_before_grade``,
    ``level=error`` — and it is emitted EXACTLY ONCE: the count now comes off the
    drive's stats, so there is one counting path and one report, not an in-drive
    signal plus a post-drive recount.
    """
    run_dir = tmp_path / "notice-run"
    progress_lines: list[str] = []
    runner = _make_runner(
        tmp_path,
        cost_limit_usd=None,
        progress=progress_lines.append,
    )
    runner._live = LiveStream.for_run(run_dir, run_id="notice-cell")
    _patch_fake_docker(monkeypatch)
    monkeypatch.setattr(
        runner, "_load_chunk_prompts", lambda *args, **kwargs: ["CHUNK ONE"]
    )
    monkeypatch.setattr(runner, "_run_gate_report", _always_fail_gate)

    def _fake_opencode(**kwargs: Any) -> _OpencodeRunStats:
        if kwargs.get("phase") == "feedback-1":
            return _stats(
                session_id="sess-1",
                exit_code=0,
                cost_usd=0.0,
                compactions_since_grade=2,
            )
        return _stats(session_id="sess-1", exit_code=0, cost_usd=0.0)

    monkeypatch.setattr(runner, "_run_opencode_serve", _fake_opencode)

    result = runner._run_cell_impl(
        run_label="notice-cell",
        run_dir=run_dir,
        task_id="backgammon",
    )
    assert result.termination_reason == COMPACTIONS_BEFORE_GRADE

    rows = [
        json.loads(line)
        for line in (run_dir / "live.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    notices = [
        row
        for row in rows
        if row.get("kind") == "notice"
        and row.get("event") == "compactions_before_grade"
    ]
    assert len(notices) == 1, f"expected exactly one notice, got {len(notices)}"
    notice = notices[0]
    assert notice["source"] == "harness"
    assert notice["level"] == "error"
    assert notice["detail"]["compactions"] == 2
    assert notice["detail"]["phase"] == "feedback-1"
    # Progress lines reach `_progress_cb`/the logger, never live.jsonl (see
    # `_progress` in harness/adapters/challenge/utils.py) — so the single-report
    # proof reads the runner's own progress callback.
    fired = [line for line in progress_lines if "step=compactions-before-grade" in line]
    assert len(fired) == 1, (
        f"expected exactly one compactions-before-grade progress line, got {len(fired)}"
    )
