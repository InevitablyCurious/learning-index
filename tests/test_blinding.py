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

# TELLS live in harness.blinding, not here: the seed path scans a plugged-in
# memory layer's runtime directive with the same pattern, and two copies of the
# list would drift into protection that only looks real.
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
    adapter = (REPO_ROOT / "harness" / "adapters" / "backgammon" / "__init__.py").read_text("utf-8")
    assert "- Model: {self.model}" not in adapter


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
