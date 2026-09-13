"""Transport-agnostic source guards.

The zero-tool resume tests this file was named for were removed 2026-09-03:
they exercised the dead stdout subprocess transport, which was purged in the
COMPACTION-RESTORE work. The four guards below read source files only and
stay — they pin live properties of the serve path and the worker image.
"""

from __future__ import annotations

import re
from pathlib import Path


def test_tool_choice_required_guard_absent_in_harness_llm_sources() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    llm_call_sources = [
        repo_root / "harness" / "adapters" / "backgammon.py",
    ]
    pattern = re.compile(r"[\"']tool_choice[\"']\s*:\s*[\"']required[\"']")

    offenders: list[str] = []
    for path in llm_call_sources:
        payload = path.read_text(encoding="utf-8")
        if pattern.search(payload):
            offenders.append(str(path))

    assert not offenders, (
        f"tool_choice='required' is banned in harness LLM call paths: {offenders}"
    )


def test_serve_launch_carries_per_cell_config_env() -> None:
    """The serve-drive launch must load the per-cell config via OPENCODE_CONFIG.

    The cell's actual attempt path is serve-drive: `opencode serve` is started
    once per cell and a session is driven through it via serve_client. That
    serve is launched WITHOUT `--config` (opencode serve v1.18.15 has no such
    flag), and `docker exec` does not forward host env, so the OPENCODE_CONFIG
    env var must be injected inline into the serve launch script. Without it
    the serve inherits the container's baked config and the serve-created
    session falls back to the built-in model -> Invalid token -> 0 model turns
    -> cell VOID. The inline env override is the only delivery vector.
    """
    repo_root = Path(__file__).resolve().parents[1]
    adapter_path = repo_root / "harness" / "adapters" / "docker_worker.py"
    payload = adapter_path.read_text(encoding="utf-8")
    assert "OPENCODE_CONFIG=/work/opencode.json" in payload, (
        "the serve launch script must set OPENCODE_CONFIG=/work/opencode.json "
        "so the per-cell config (local :4545 routing) is loaded by `opencode serve`."
    )


def test_serve_config_written_before_serve_boots() -> None:
    """The per-cell config must exist before the serve boots.

    `opencode serve` boots once per cell and is reused across all attempts, so
    the per-cell config file (/work/opencode.json) must be written before
    `active_cell.start_serve()` runs. A config written after serve boot would
    never be read by the already-running serve. Guard the call ordering: the
    first `_write_worker_permission_config(worktree=worktree)` occurrence must
    precede the first `active_cell.start_serve()` occurrence in backgammon.py.
    """
    repo_root = Path(__file__).resolve().parents[1]
    adapter_path = repo_root / "harness" / "adapters" / "backgammon.py"
    payload = adapter_path.read_text(encoding="utf-8")

    config_write = payload.index("_write_worker_permission_config(worktree=worktree)")
    serve_boot = payload.index("active_cell.start_serve()")
    assert config_write < serve_boot, (
        "the per-cell config write must appear before active_cell.start_serve(); "
        "a config written after serve boot would be missed (serve boots once per cell)."
    )


def test_agents_md_written_after_seed() -> None:
    """/work/AGENTS.md must be written AFTER the scaffold seed, not wiped by it.

    The cell worktree seed is a full overlay of the scaffold tree: any file
    placed in the worktree before the copy runs is silently replaced. The
    2026-08-09 cells booted with no /work/AGENTS.md at all (4 consecutive
    runs) because the write never landed. Guard the call ordering: the
    AGENTS.md write must appear after the scaffold `_copy_tree_contents`
    call in backgammon.py, and the written content must carry the live
    model line so the worker knows what it is running as.
    """
    repo_root = Path(__file__).resolve().parents[1]
    adapter_path = repo_root / "harness" / "adapters" / "backgammon.py"
    payload = adapter_path.read_text(encoding="utf-8")
    seed = payload.index(
        'self._copy_tree_contents(self.task_dir / "scaffold", worktree)'
    )
    agents_write = payload.index('(worktree / "AGENTS.md").write_text(')
    assert seed < agents_write, (
        "the /work/AGENTS.md write must appear AFTER the scaffold "
        "_copy_tree_contents(...); written before the seed it is wiped by the "
        "overlay and the worker receives no repo-orientation context."
    )
    # BLINDING PASS 2026-08-24: the model/provider line was REMOVED. Naming a
    # model back to itself in a project's AGENTS.md is something no ordinary
    # repository does, so it read as a tell that something was driving the
    # session. Nothing downstream consumed it — the model identity is already
    # carried by opencode.json and by the run manifest.
    assert "- Model: {self.model}" not in payload, (
        "the seeded AGENTS.md must NOT name the model back to itself; it is a "
        "tell that the session is being driven, and nothing reads it."
    )
