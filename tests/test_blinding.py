"""Nothing the model can read may reveal that it is being measured.

A model that knows it is in an evaluation is not the model whose behaviour the
run is trying to measure. Every surface below is something the model actually
sees — the files seeded into its worktree, the prompts it is sent, and the
messages the harness interrupts it with — so evaluation vocabulary in any of
them contaminates the measurement.

This guard exists because the leaks were real and load-bearing: the seeded
AGENTS.md opened with "Worker instructions / Do NOT cheat ... the grader", the
spec described "the hidden gate suite", and package.json was named
`benchmark-backgammon`, which printed on every single `npm` command the model
ran.
"""

from __future__ import annotations

from pathlib import Path

import pytest

# TELLS live in harness.blinding, the one copy of the list.
from harness.blinding import TELL_RE, TELLS, offending_lines as _offending_lines

REPO_ROOT = Path(__file__).resolve().parents[1]
SCAFFOLD = REPO_ROOT / "task" / "backgammon" / "scaffold"
PROMPTS = REPO_ROOT / "task" / "backgammon" / "prompts"

__all__ = ["TELLS", "TELL_RE"]


def _agent_visible_files() -> list[Path]:
    files: list[Path] = []
    for root in (SCAFFOLD, PROMPTS):
        if root.is_dir():
            files.extend(p for p in root.rglob("*") if p.is_file())
    return files


@pytest.mark.parametrize(
    "path", _agent_visible_files(), ids=lambda p: str(p.relative_to(REPO_ROOT))
)
def test_agent_visible_file_has_no_evaluation_vocabulary(path: Path) -> None:
    """Every file the model reads — the spec, the scaffold, the prompts."""
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        pytest.skip(f"binary file: {path.name}")
    offenders = _offending_lines(text)
    assert not offenders, (
        f"{path.relative_to(REPO_ROOT)} reveals the run is an evaluation:\n  "
        + "\n  ".join(offenders)
    )


def test_package_name_is_not_a_tell() -> None:
    """package.json's name prints on every npm command the model runs."""
    import json

    name = json.loads((SCAFFOLD / "package.json").read_text(encoding="utf-8"))["name"]
    assert not TELL_RE.search(name), f"package name {name!r} announces the evaluation"


def test_seeded_agents_md_has_no_evaluation_vocabulary() -> None:
    from harness.adapters.backgammon import _WORKER_AGENTS_MD

    offenders = _offending_lines(_WORKER_AGENTS_MD)
    assert not offenders, "seeded AGENTS.md reveals the evaluation:\n  " + "\n  ".join(
        offenders
    )


def test_agents_md_does_not_name_the_model_to_itself() -> None:
    # runner.py is where the seeded AGENTS.md is written.
    adapter = (REPO_ROOT / "harness" / "adapters" / "backgammon" / "runner.py").read_text("utf-8")
    assert '(worktree / "AGENTS.md").write_text(' in adapter
    assert "- Model: {self.model}" not in adapter


def test_seeded_worktree_has_no_evaluation_vocabulary(tmp_path: Path) -> None:
    """Everything the harness leaves in /work before the first prompt.

    The per-file scan above covers what this repo ships. This one runs the real
    seed steps — scaffold copy, AGENTS.md, git init — and scans the result,
    including the git metadata: the model lists and queries /work/.git, and the
    seed commit's author and message used to be `bench <bench@okp.local>` /
    "bench cell seed".
    """
    import shutil
    import subprocess

    from harness.adapters.backgammon import _WORKER_AGENTS_MD, BackgammonRunner

    worktree = tmp_path / "cell" / "worktree"
    shutil.copytree(SCAFFOLD, worktree)
    (worktree / "AGENTS.md").write_text(_WORKER_AGENTS_MD, encoding="utf-8")
    runner = BackgammonRunner(
        task_dir=SCAFFOLD.parent,
        work_root=tmp_path / "work-root",
        model="openrouter/anthropic/claude-opus-4.8",
        mock="scaffold",
    )
    runner._init_worktree_git(worktree=worktree)

    surfaces: dict[str, str] = {}
    for path in worktree.rglob("*"):
        if not path.is_file() or "objects" in path.relative_to(worktree).parts:
            continue
        try:
            surfaces[str(path.relative_to(worktree))] = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
    surfaces["git log"] = subprocess.run(
        ["git", "log", "--format=%an%n%ae%n%cn%n%ce%n%B"],
        cwd=worktree, capture_output=True, text=True, check=True,
    ).stdout

    leaks = {name: _offending_lines(text) for name, text in surfaces.items()}
    leaks = {name: lines for name, lines in leaks.items() if lines}
    assert "git log" in surfaces and ".git/config" in surfaces
    assert not leaks, "the seeded worktree reveals the evaluation:\n" + "\n".join(
        f"  {name}: {lines}" for name, lines in leaks.items()
    )


class TestInterruptsSoundHuman:
    """The harness interrupts mid-session. Those messages must read as a person.

    They previously opened "Transport notice:" and referred to the reader in the
    third person as "the model" — both of which say plainly that something
    automated is driving the conversation.
    """

    def _nudges(self) -> dict[str, str]:
        from harness.adapters import backgammon as b

        return {
            "loop_recovery": b._LOOP_RECOVERY_NUDGE,
            "finalize_recovery": b._FINALIZE_RECOVERY_NUDGE,
            "stall_recovery": b._STALL_RECOVERY_NUDGE,
            "provider_recovery": b._PROVIDER_RECOVERY_NUDGE,
        }

    def test_no_evaluation_vocabulary(self) -> None:
        for name, text in self._nudges().items():
            assert not TELL_RE.search(text), f"{name} nudge leaks: {text!r}"

    @pytest.mark.parametrize(
        "phrase",
        [
            "transport notice",
            "loop detector",
            "the model",
            "verdict",
            "attempt 1",
            "system:",
            "automated",
            "test suite",
        ],
    )
    def test_no_machine_voice(self, phrase: str) -> None:
        for name, text in self._nudges().items():
            assert phrase not in text.lower(), (
                f"{name} nudge reads as machine output, not a person: {phrase!r} in {text!r}"
            )

    def test_nudges_are_not_empty(self) -> None:
        # A blank interrupt would be its own kind of tell.
        for name, text in self._nudges().items():
            assert len(text.strip()) > 20, name
