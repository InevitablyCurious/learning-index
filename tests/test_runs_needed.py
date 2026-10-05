"""scripts/runs_needed.py — the runs-per-arm planner reads the floor's own batch
and its rank test agrees with the textbook values."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import runs_needed  # noqa: E402


def test_p_value_matches_the_textbook_for_complete_separation():
    # U = 0 for b below every a; mean 4.5, variance 5.25, continuity 0.5.
    p = runs_needed.mann_whitney_p_less([1, 2, 3], [4, 5, 6])
    assert p == pytest.approx(0.0404, abs=5e-4)


def test_p_value_is_high_when_b_is_larger():
    assert runs_needed.mann_whitney_p_less([4, 5, 6], [1, 2, 3]) > 0.95


def test_every_value_tied_is_no_evidence():
    assert runs_needed.mann_whitney_p_less([5, 5], [5, 5]) == 1.0


def test_improvement_never_goes_below_zero():
    assert runs_needed.improve(1, 3, relative=False) == 0
    assert runs_needed.improve(100, 0.2, relative=True) == pytest.approx(80)


def test_no_spread_needs_three_runs_per_arm():
    # Two runs per arm can never reach 5% one-sided; three can.
    needed = runs_needed.runs_needed(
        [10.0] * 6,
        1.0,
        relative=False,
        target=0.8,
        alpha=0.05,
        max_runs=10,
        sims=50,
        seed=0,
    )
    assert needed == 3


def test_a_wider_spread_needs_more_runs():
    common = dict(relative=False, target=0.8, alpha=0.05, max_runs=30, sims=300, seed=0)
    narrow = runs_needed.runs_needed([10, 11, 10, 11, 10, 11], 2.0, **common)
    wide = runs_needed.runs_needed([2, 20, 5, 18, 9, 14], 2.0, **common)
    assert narrow is not None
    assert wide is None or wide > narrow


def _write_batch(path: Path, runs: list[dict], **extra) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"fingerprint": "abc123", "runs": runs, "void": False, **extra})
    )
    return path


def test_load_batch_keeps_only_scored_counts(tmp_path):
    path = _write_batch(
        tmp_path / "batch.json",
        [
            {"problem_count": 12, "scored": True},
            {"problem_count": 9, "scored": True},
            {"problem_count": None, "scored": True},
            {"problem_count": 30, "scored": False, "void_reason": "instrument_fault"},
            {"problem_count": True, "scored": True},
        ],
        void=True,
        void_kind="superseded",
        void_reason="grader changed",
    )
    values, info = runs_needed.load_batch(path)
    assert values == [12.0, 9.0]
    assert info["excluded"] == 3
    assert info["void"] is True and info["void_kind"] == "superseded"


def test_one_batch_under_a_root_is_used_and_archives_are_skipped(tmp_path):
    live = _write_batch(tmp_path / "tree" / "model" / "batch.json", [])
    _write_batch(tmp_path / "backups" / "old" / "batch.json", [])
    assert runs_needed.resolve_source(str(tmp_path)) == live


def test_several_batches_are_listed_not_guessed(tmp_path, capsys):
    _write_batch(tmp_path / "a" / "batch.json", [{"problem_count": 3, "scored": True}])
    _write_batch(tmp_path / "b" / "batch.json", [])
    assert runs_needed.resolve_source(str(tmp_path)) is None
    listed = capsys.readouterr().err
    assert "2 batches" in listed and "1 scored" in listed


def test_report_warns_when_the_spread_is_thin(capsys):
    code = runs_needed.main(
        ["--values", "10,12,11,13", "--effects", "1", "--sims", "50", "--max-runs", "4"]
    )
    out = capsys.readouterr().out
    assert code == 0
    assert "runs per arm" in out and "chance with 3 per arm" in out
    assert "Only 4 scored runs" in out


def test_a_single_run_is_refused(capsys):
    assert runs_needed.main(["--values", "10"]) == 2
    assert "at least 2" in capsys.readouterr().err
