"""The challenge's prompts directory is the only source of model-facing text.

WHY. The build steps lived in the challenge folder; the standing notes, the
repair-message wrapper and the four interruption messages were string literals
in the adapter. Half the text a challenge author owns was in a Python module
they should never have to open.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from harness.prompt_pack import MissingPromptError, PromptPack, default_pack

REPO = Path(__file__).resolve().parents[1]


def test_the_example_challenge_provides_every_prompt_the_run_uses() -> None:
    pack = default_pack()
    for name in (
        "agents.md",
        "repair/opener.md",
        "repair/first-round.md",
        "repair/repeat-round.md",
        "repair/no-change.md",
        "repair/fixed-one.md",
        "repair/fixed-many.md",
        "repair/team-header.md",
        "repair/team-header-alone.md",
        "repair/team-note.md",
        "repair/constraints.md",
        "nudges/write-limit.md",
    ):
        assert pack.text(name).strip()
    assert len(pack.chunks()) == 5


def test_a_missing_prompt_is_loud() -> None:
    """Silence here would run a challenge that says less than its author wrote,
    produce a number, and look exactly like one that said it."""
    pack = PromptPack(REPO / "task" / "backgammon" / "prompts")
    with pytest.raises(MissingPromptError):
        pack.text("nudges/no-such-file.md")


def test_an_empty_prompt_is_loud(tmp_path: Path) -> None:
    (tmp_path / "agents.md").write_text("\n   \n", encoding="utf-8")
    with pytest.raises(MissingPromptError):
        PromptPack(tmp_path).text("agents.md")


def test_a_challenge_with_no_build_steps_is_loud(tmp_path: Path) -> None:
    with pytest.raises(MissingPromptError):
        PromptPack(tmp_path).chunks()


def test_no_nudge_reaches_the_model_with_a_raw_placeholder() -> None:
    """A nudge may carry `{write_limit}`; the model must only ever see it resolved."""
    pack = default_pack()
    for name in ("connection", "cut-off", "loop", "stall"):
        assert "{write_limit}" not in pack.nudge(f"nudges/{name}.md")


def test_the_template_skeleton_still_loads() -> None:
    """challenges/TEMPLATE is what an author copies. If it stops satisfying the
    loader, the first thing a new challenge does is fail."""
    pack = PromptPack(REPO / "challenges" / "TEMPLATE" / "prompts")
    for name in (
        "agents.md",
        "repair/opener.md",
        "repair/first-round.md",
        "repair/repeat-round.md",
        "repair/no-change.md",
        "repair/fixed-one.md",
        "repair/fixed-many.md",
        "repair/team-header.md",
        "repair/team-header-alone.md",
        "repair/team-note.md",
        "repair/constraints.md",
        "nudges/write-limit.md",
    ):
        assert pack.text(name).strip()
    assert len(pack.chunks()) >= 1
    assert pack.text("nudges/write-limit.md") in pack.nudge("nudges/cut-off.md")


def test_a_challenge_directory_can_be_pointed_at_by_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """A challenge is its own repo, cloned anywhere; BENCH_TASK_DIR selects it."""
    from harness import prompt_pack

    monkeypatch.setenv(prompt_pack.TASK_DIR_ENV, str(REPO / "challenges" / "TEMPLATE"))
    assert prompt_pack.default_task_dir() == (REPO / "challenges" / "TEMPLATE").resolve()
    monkeypatch.delenv(prompt_pack.TASK_DIR_ENV)
    assert prompt_pack.default_task_dir().name == "backgammon"
