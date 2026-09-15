"""The worker's opencode.json is written beside the worktree, never inside it.

The file carries the permission rules, and those name the grading and reference
folders. Run 1789474325's model opened /work/opencode.json and read them.
"""

from __future__ import annotations

from pathlib import Path

from harness.adapters.backgammon import BackgammonRunner
from harness.adapters.docker_worker import worker_config_host_dir

TASK_DIR = Path(__file__).resolve().parents[1] / "task" / "backgammon"


def test_settings_file_is_written_outside_the_worktree(tmp_path: Path) -> None:
    worktree = tmp_path / "cell" / "worktree"
    worktree.mkdir(parents=True)
    runner = BackgammonRunner(
        task_dir=TASK_DIR,
        work_root=tmp_path / "work-root",
        model="openrouter/anthropic/claude-opus-4.8",
        mock="scaffold",
    )

    runner._write_worker_permission_config(worktree=worktree)

    written = worker_config_host_dir(worktree) / "opencode.json"
    assert written.is_file()
    assert written.parent == worktree.parent / "worker-config"
    assert not (worktree / "opencode.json").exists()
    assert list(worktree.iterdir()) == []
