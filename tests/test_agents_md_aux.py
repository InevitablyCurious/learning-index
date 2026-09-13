"""The AGENTS.md auxiliary-directive seam (``BENCH_AGENTS_AUX_FILE``).

This is a PUBLIC benchmark: anyone plugs their own memory system in, so the
seeded AGENTS.md may not name one. A memory layer that needs a standing
instruction in front of the model for the whole session supplies it at seed
time through this seam instead.

The two things worth pinning:

1. **Absent by default.** With the env unset the file is ``_WORKER_AGENTS_MD``
   byte for byte, so the tree clones and runs with no memory layer at all.
2. **Loud when declared and broken.** A path that was set but cannot be read is
   a misconfiguration, and swallowing it would run a whole cell whose model was
   never told to record anything — an empty result that reads as a finding
   about the memory system rather than as a wiring bug.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from harness.adapters.backgammon import BackgammonRunner, _WORKER_AGENTS_MD

TASK_DIR = Path(__file__).resolve().parents[1] / "task" / "backgammon"


def _runner(tmp_path: Path) -> BackgammonRunner:
    return BackgammonRunner(
        task_dir=TASK_DIR,
        work_root=tmp_path / "work-root",
        model="local-llm-proxy/kimi/kimi-k3",
    )


def test_unset_env_leaves_agents_md_byte_identical(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("BENCH_AGENTS_AUX_FILE", raising=False)
    assert _runner(tmp_path)._agents_md_text("run") == _WORKER_AGENTS_MD


def test_blank_env_is_treated_as_unset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("BENCH_AGENTS_AUX_FILE", "   ")
    assert _runner(tmp_path)._agents_md_text("run") == _WORKER_AGENTS_MD


def test_directive_is_appended_under_a_neutral_heading(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    aux = tmp_path / "directive.md"
    aux.write_text("Record what you learn as you go.\n", encoding="utf-8")
    monkeypatch.setenv("BENCH_AGENTS_AUX_FILE", str(aux))

    text = _runner(tmp_path)._agents_md_text("run")

    assert text.startswith(_WORKER_AGENTS_MD), "the shipped notes stay first and intact"
    assert "## Recording what you learn" in text
    assert text.rstrip().endswith("Record what you learn as you go.")


def test_missing_file_aborts_rather_than_seeding_a_bare_agents_md(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("BENCH_AGENTS_AUX_FILE", str(tmp_path / "nope.md"))
    with pytest.raises(RuntimeError, match="could not be read"):
        _runner(tmp_path)._agents_md_text("run")


def test_empty_file_aborts_because_it_is_ambiguous(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    aux = tmp_path / "empty.md"
    aux.write_text("\n  \n", encoding="utf-8")
    monkeypatch.setenv("BENCH_AGENTS_AUX_FILE", str(aux))
    with pytest.raises(RuntimeError, match="is empty"):
        _runner(tmp_path)._agents_md_text("run")


def test_the_shipped_vendor_directive_is_appended(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The directive this repo's own plugin ships must still append at seed time.

    Skipped rather than failed when the sibling plugin tree is not checked out:
    the repo has to clone and test standalone.
    """
    directive = (
        Path(__file__).resolve().parents[2]
        / "dev"
        / "benchmark"
        / "opencode-plugin"
        / "plugins"
        / "tokp-record-mandate.md"
    )
    if not directive.is_file():
        pytest.skip(f"sibling plugin tree not present: {directive}")
    monkeypatch.setenv("BENCH_AGENTS_AUX_FILE", str(directive))
    text = _runner(tmp_path)._agents_md_text("run")
    assert text.startswith(_WORKER_AGENTS_MD)
    assert len(text) > len(_WORKER_AGENTS_MD)
