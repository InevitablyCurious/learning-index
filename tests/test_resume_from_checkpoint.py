"""RESUME FROM A CHECK-POINT — the dev loop's step 6 (Jerry, 2026-11-11).

After a grader fix the run continues from the check-point where the wrong grade
was given, never from zero. What these tests state:

  (a) seeding makes the worktree EXACTLY the captured tree: a scaffold file the
      model deleted stays deleted, the cell's own AGENTS.md is kept, and a
      directory that is not a check-point is refused;
  (b) a check-point records the build phase and layer it was graded at;
  (c) a resumed cell builds nothing up to its check-point's phase, starts that
      phase at its GRADE, re-hands the phase header + whole spec in the first
      message (a fresh session), marks those phases "seeded", and says it is
      not a measurement (resume.json);
  (d) a resume is refused without the operator pause, and on a phase that
      contradicts the check-point.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import pytest

from harness.adapters.challenge import ChallengeRunner, _OpencodeRunStats
from harness.checkpoint import (
    CheckpointSeedError,
    record_checkpoint,
    seed_worktree_from_checkpoint,
)
from harness.prompt_pack import PromptPack
from tests.test_challenge_budget_stop import TASK_DIR, _patch_fake_docker, _stats
from tests.test_layered_sequence import _L1_PROBLEM, _PASS, L1_CHECK, _roster


def _checkpoint(root: Path, files: dict[str, str], **meta: Any) -> Path:
    cp = root / "checkpoints" / "cp-03"
    for rel, text in files.items():
        (cp / "tree" / rel).parent.mkdir(parents=True, exist_ok=True)
        (cp / "tree" / rel).write_text(text, encoding="utf-8")
    (cp / "cp.json").write_text(
        json.dumps({"attempt": 3, "phase": "feedback-2", "state_hash": "h3", **meta}),
        encoding="utf-8",
    )
    return cp


# ── (a) SEEDING ──────────────────────────────────────────────────────────────


def test_seeding_reproduces_the_captured_tree_exactly(tmp_path: Path) -> None:
    cp = _checkpoint(tmp_path, {"a.txt": "model's a", "sub/b.txt": "model's b"})
    worktree = tmp_path / "worktree"
    worktree.mkdir()
    (worktree / "AGENTS.md").write_text("harness", encoding="utf-8")
    (worktree / "a.txt").write_text("scaffold a", encoding="utf-8")
    (worktree / "deleted-by-model.txt").write_text("scaffold", encoding="utf-8")

    meta = seed_worktree_from_checkpoint(worktree=worktree, cp_dir=cp)

    assert (worktree / "a.txt").read_text(encoding="utf-8") == "model's a"
    assert (worktree / "sub" / "b.txt").read_text(encoding="utf-8") == "model's b"
    # The model deleted it before the check-point: it must stay deleted.
    assert not (worktree / "deleted-by-model.txt").exists()
    # The harness's own file is the cell's, never the check-point's.
    assert (worktree / "AGENTS.md").read_text(encoding="utf-8") == "harness"
    assert meta["attempt"] == 3 and meta["dir"] == str(cp.resolve())


def test_a_directory_that_is_not_a_checkpoint_is_refused(tmp_path: Path) -> None:
    (tmp_path / "not-a-cp").mkdir()
    with pytest.raises(CheckpointSeedError):
        seed_worktree_from_checkpoint(worktree=tmp_path, cp_dir=tmp_path / "not-a-cp")


# ── (b) RECORDING ────────────────────────────────────────────────────────────


def test_a_checkpoint_records_its_build_phase_and_layer(tmp_path: Path) -> None:
    worktree = tmp_path / "wt"
    worktree.mkdir()
    (worktree / "x.txt").write_text("x", encoding="utf-8")
    entry = record_checkpoint(
        run_dir=tmp_path,
        worktree=worktree,
        attempt=1,
        phase="initial",
        state_hash="abc",
        run_id="r",
        build_phase=4,
        layer=1,
    )
    assert entry is not None
    assert (entry["build_phase"], entry["layer"]) == (4, 1)
    cp_json = json.loads((tmp_path / "checkpoints" / "cp-01" / "cp.json").read_text())
    assert (cp_json["build_phase"], cp_json["layer"]) == (4, 1)


# ── (c)/(d) THE RESUMED CELL ─────────────────────────────────────────────────


def _resumed_runner(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    cp: Path,
    **kw: Any,
) -> ChallengeRunner:
    _patch_fake_docker(monkeypatch)
    runner = ChallengeRunner(
        task_dir=TASK_DIR,
        work_root=tmp_path / "work-root",
        model="local-llm-proxy/okp-bench-worker",
        pause_after_grade=True,
        resume_checkpoint=cp,
        **kw,
    )
    runner.gate_roster_path = _roster(tmp_path)
    return runner


def _scaffold_checkpoint(tmp_path: Path, **meta: Any) -> Path:
    """A check-point whose tree is the real scaffold plus one file of the
    model's, so nothing the cell reads is missing."""
    cp = _checkpoint(tmp_path, {"MODEL_WROTE_THIS.txt": "layer 1 work"}, **meta)
    shutil.copytree(TASK_DIR / "scaffold", cp / "tree", dirs_exist_ok=True)
    return cp


def test_a_resumed_cell_starts_at_its_checkpoints_grade(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Resume at phase 4 (layer 1): phases 1-4 are never driven, layer 1 is
    graded first, its first repair message re-hands the phase-4 header and the
    whole spec, and phase 5 is the first build sent."""
    cp = _scaffold_checkpoint(tmp_path, build_phase=4, layer=1)
    runner = _resumed_runner(tmp_path, monkeypatch, cp)

    drives: list[tuple[str, str]] = []

    def _fake_opencode(**kwargs: Any) -> _OpencodeRunStats:
        drives.append((str(kwargs.get("phase") or ""), str(kwargs.get("prompt") or "")))
        return _stats(session_id="sess-1", exit_code=0, cost_usd=0.0)

    grades: list[Any] = []

    def _fake_gate(**kwargs: Any) -> dict[str, Any]:
        grades.append(kwargs.get("layer"))
        if len(grades) == 1:
            return {
                "verdict": "FAIL",
                "conformed": True,
                "problems": [dict(_L1_PROBLEM)],
                "failed_gates": [L1_CHECK],
            }
        return dict(_PASS)

    monkeypatch.setattr(runner, "_run_opencode_serve", _fake_opencode)
    monkeypatch.setattr(runner, "_run_gate_report", _fake_gate)
    monkeypatch.setattr(runner, "_run_operator_pause", lambda **_: 0.0)

    run_dir = tmp_path / "resumed"
    result = runner._run_cell_impl(
        run_label="resumed", run_dir=run_dir, task_id="backgammon"
    )

    builds = [phase for phase, _ in drives if phase.startswith("initial-chunk-")]
    # Nothing up to the check-point's phase is built; 5, 6, 7 are.
    assert builds == ["initial-chunk-5", "initial-chunk-6", "initial-chunk-7"]
    # The first grade is the check-point's own layer.
    assert grades[0] == 1
    # The first message the fresh session receives is the repair after that
    # grade, and it carries the phase-4 header and the whole spec.
    first_prompt = drives[0][1]
    assert not drives[0][0].startswith("initial-chunk-")
    assert first_prompt.startswith(
        PromptPack(TASK_DIR / "prompts").build_step_message(4)
    )
    # The model's code was the worktree.
    assert (run_dir / "worktree" / "MODEL_WROTE_THIS.txt").read_text() == "layer 1 work"
    # Seeded, not complete: nothing was driven for phases 1-4 here.
    assert result.build_chunks is not None
    assert [row["state"] for row in result.build_chunks] == ["seeded"] * 4 + [
        "complete"
    ] * 3
    # And it says what it is.
    marker = json.loads((run_dir / "resume.json").read_text())
    assert marker["measurement"] is False and marker["build_phase"] == 4


def test_a_resume_needs_the_operator_pause(tmp_path: Path) -> None:
    cp = _checkpoint(tmp_path, {"a.txt": "a"}, build_phase=4)
    with pytest.raises(ValueError, match="dev-mode"):
        ChallengeRunner(
            task_dir=TASK_DIR,
            work_root=tmp_path / "w",
            model="local-llm-proxy/okp-bench-worker",
            resume_checkpoint=cp,
        )


def test_a_resume_phase_that_contradicts_the_checkpoint_is_refused(
    tmp_path: Path,
) -> None:
    cp = _checkpoint(tmp_path, {"a.txt": "a"}, build_phase=4)
    with pytest.raises(ValueError, match="contradicts"):
        ChallengeRunner(
            task_dir=TASK_DIR,
            work_root=tmp_path / "w",
            model="local-llm-proxy/okp-bench-worker",
            pause_after_grade=True,
            resume_checkpoint=cp,
            resume_phase=5,
        )


def test_an_old_checkpoint_needs_its_phase_named(tmp_path: Path) -> None:
    cp = _checkpoint(tmp_path, {"a.txt": "a"})  # recorded before build_phase existed
    with pytest.raises(ValueError, match="records no build phase"):
        ChallengeRunner(
            task_dir=TASK_DIR,
            work_root=tmp_path / "w",
            model="local-llm-proxy/okp-bench-worker",
            pause_after_grade=True,
            resume_checkpoint=cp,
        )
