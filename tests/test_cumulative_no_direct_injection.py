"""No direct injection: the harness has NO injected-memory mechanism at all.

Memory reaches the worker through the plugin substrate (worker-side recall
auto-inject), never through the harness prompt path. These tests pin that
absence: chunk prompts are the raw on-disk bytes, `run_cell` forwards only
cell identity into `_run_cell_impl`, and the removed seam's symbols do not
reappear in the source.
"""

import inspect
from pathlib import Path

import pytest

from harness.adapters.challenge import (
    ChallengeCellResult,
    ChallengeRunner,
)


TASK_DIR = (Path(__file__).resolve().parents[1] / "task" / "backgammon").resolve()


def _make_runner(tmp_path: Path, *, memory_mode: str = "on") -> ChallengeRunner:
    return ChallengeRunner(
        task_dir=TASK_DIR,
        work_root=tmp_path / "work-root",
        model="openrouter/anthropic/claude-opus-4.8",
        memory_mode=memory_mode,
        progress=lambda _line: None,
    )


def test_load_chunk_prompts_returns_exactly_the_on_disk_chunks(
    tmp_path: Path,
) -> None:
    # The signature IS the invariant: `self` is the only parameter — the
    # removed memory kwarg cannot come back without failing here.
    params = list(inspect.signature(ChallengeRunner._load_chunk_prompts).parameters)
    assert params == ["self"]

    runner = _make_runner(tmp_path, memory_mode="on")

    chunks = runner._load_chunk_prompts()

    on_disk = sorted((TASK_DIR / "prompts").glob("chunk-*.md"))
    assert len(on_disk) == 5
    # Byte-identical to disk: nothing is prepended, appended, or formatted in.
    assert chunks == [p.read_text(encoding="utf-8") for p in on_disk]
    assert all("# OKP MEMORY CONTEXT" not in c for c in chunks)


def test_run_cell_forwards_cell_identity_and_no_memory(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    runner = _make_runner(tmp_path, memory_mode="on")
    captured: dict[str, object] = {}

    # The fake's signature no longer ACCEPTS the removed memory kwarg: if
    # `run_cell` tried to pass one, this would raise TypeError and fail here.
    def _fake_run_cell_impl(
        *,
        run_label: str,
        run_dir: Path,
        task_id: str,
    ) -> ChallengeCellResult:
        captured["run_label"] = run_label
        captured["run_dir"] = run_dir
        captured["task_id"] = task_id
        return ChallengeCellResult(
            verdict="PASS",
            attempts_to_green=0,
            termination_reason="gates_green",
            conformed=True,
            input_tokens=0,
            output_tokens=0,
            turns=0,
            wall_seconds=0.0,
            delivery="N/A",
            failed_gates=[],
            problems_final=[],
            attempt_reports=[],
            worktree=str(run_dir / "worktree"),
            session_id="sid-no-direct-injection",
            memory_mode="on",
            model=runner.model,
        )

    monkeypatch.setattr(runner, "_run_cell_impl", _fake_run_cell_impl)

    run_dir = tmp_path / "run-no-direct-injection"
    result = runner.run_cell("run-no-direct-injection", run_dir)

    assert captured["run_label"] == "run-no-direct-injection"
    assert captured["task_id"] == "backgammon"
    assert captured["run_dir"] == run_dir
    assert result.verdict == "PASS"


def test_challenge_source_has_no_direct_injection_seam() -> None:
    # The removed seam symbols, spelled by concatenation so THIS file stays
    # clean under the repo-wide grep for them — a test asserting their absence
    # must not reintroduce the literals. At runtime these are the exact
    # strings that were removed from the adapter.
    seam_param = "injected" + "_memory"
    seam_helper = "_format" + "_memory"

    prompt_source = inspect.getsource(ChallengeRunner._load_chunk_prompts)
    run_cell_source = inspect.getsource(ChallengeRunner.run_cell)

    for source in (prompt_source, run_cell_source):
        assert seam_param not in source
        assert seam_helper not in source

    # The harness also never writes memory into the worktree as a file.
    assert "OKP_MEMORY.md" not in prompt_source
    assert "write_text(" not in prompt_source
