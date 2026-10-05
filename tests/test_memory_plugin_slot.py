"""The memory slot: any opencode plugin package, loaded in memory-ON cells only.

A memory system enters the benchmark as an opencode plugin baked into the worker
image. Listing it in a cell's opencode.json is what switches memory on, so only a
memory-ON cell lists it; an OFF cell on the same image runs without it.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from harness.adapters import docker_worker
from harness.adapters.challenge import ChallengeRunner
from harness.adapters.challenge.worker_config import build_worker_opencode_config
from harness.adapters.docker_worker import (
    BakedPlugin,
    baked_plugin,
    worker_config_host_dir,
)

TASK_DIR = Path(__file__).resolve().parents[1] / "task" / "backgammon"
SELF_COMPACT = "/opt/bench/self-compact.ts"
ENTRY = "/opt/bench-plugin/dist/index.js"


def _config(**kwargs) -> dict:
    return build_worker_opencode_config(
        model="local/qwen",
        reasoning_effort=None,
        proxy_base_url="http://relay:4545/v1",
        gates_dir="/gates",
        golden_dir="/golden",
        **kwargs,
    )


def test_without_a_plugin_entry_only_self_compaction_is_listed() -> None:
    config = _config()
    assert config["plugin"] == [SELF_COMPACT]
    assert "mcp" not in config


def test_with_a_plugin_entry_the_plugin_is_listed_before_self_compaction() -> None:
    config = _config(plugin_entry=ENTRY)
    assert config["plugin"] == [ENTRY, SELF_COMPACT]
    assert "mcp" not in config


@pytest.mark.parametrize("memory_mode,listed", [("on", True), ("off", False)])
def test_only_a_memory_on_cell_lists_the_baked_plugin(
    tmp_path: Path, memory_mode: str, listed: bool
) -> None:
    worktree = tmp_path / "cell" / "worktree"
    worktree.mkdir(parents=True)
    runner = ChallengeRunner(
        task_dir=TASK_DIR,
        work_root=tmp_path / "work-root",
        model="openrouter/anthropic/claude-opus-4.8",
        mock="scaffold",
        memory_mode=memory_mode,
    )
    runner._baked_plugin = BakedPlugin(entry=ENTRY, identity="memory-plugin@1.0.0")

    runner._write_worker_permission_config(worktree=worktree)

    written = json.loads(
        (worker_config_host_dir(worktree) / "opencode.json").read_text()
    )
    assert (ENTRY in written["plugin"]) is listed
    assert SELF_COMPACT in written["plugin"]


def _inspect_returning(monkeypatch, stdout: str, returncode: int = 0) -> None:
    def fake_run(argv, **_kwargs):
        assert argv[:3] == ["docker", "image", "inspect"]
        return subprocess.CompletedProcess(argv, returncode, stdout=stdout, stderr="")

    monkeypatch.setattr(docker_worker.subprocess, "run", fake_run)


def test_the_baked_plugin_is_read_from_the_image_labels(monkeypatch) -> None:
    _inspect_returning(
        monkeypatch, "1|dist/index.js|@honcho-ai/opencode-honcho@0.2.1\n"
    )
    assert baked_plugin() == BakedPlugin(
        entry=ENTRY, identity="@honcho-ai/opencode-honcho@0.2.1"
    )


@pytest.mark.parametrize(
    "stdout,returncode",
    [
        ("0|<no value>|<no value>\n", 0),  # vanilla image
        ("1|<no value>|<no value>\n", 0),  # built before the entry label existed
        ("", 1),  # no such image
    ],
)
def test_an_image_without_a_loadable_plugin_reads_as_none(
    monkeypatch, stdout: str, returncode: int
) -> None:
    _inspect_returning(monkeypatch, stdout, returncode)
    assert baked_plugin() is None


@pytest.mark.parametrize("memory_mode,pure", [("on", False), ("off", True)])
def test_both_arms_start_from_the_same_worktree(
    tmp_path: Path, memory_mode: str, pure: bool
) -> None:
    """Memory is switched on in the cell's config, never by files the model sees:
    no marker, predicate or runner is added for one arm, and a stale ``.okp/``
    from an old seed snapshot is removed in both."""
    worktree = tmp_path / "worktree"
    (worktree / ".okp").mkdir(parents=True)
    (worktree / ".okp" / "org.json").write_text("{}")
    (worktree / "package.json").write_text("{}")
    runner = ChallengeRunner(
        task_dir=TASK_DIR,
        work_root=tmp_path / "work-root",
        model="local/qwen",
        mock="scaffold",
        memory_mode=memory_mode,
    )

    assert runner._prepare_memory_mode(worktree=worktree) is pure
    assert sorted(p.name for p in worktree.iterdir()) == ["package.json"]
