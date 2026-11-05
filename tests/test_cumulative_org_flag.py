from __future__ import annotations

import os
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

# LI-14: run_cumulative is now a package (scripts/run_cumulative/) fronted by a
# thin scripts/run_cumulative.py entrypoint. Import the PACKAGE so the
# monkeypatch targets below (_build_context / _append_results_ledger) patch
# the namespace _handle_run actually resolves those bare names in.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import run_cumulative  # noqa: E402


@pytest.fixture(autouse=True)
def _preserve_environ():
    """Isolate os.environ: the run path calls load_bench_env(), which exports
    bench.env vars into the process env and would otherwise leak into later
    tests."""
    snapshot = dict(os.environ)
    yield
    os.environ.clear()
    os.environ.update(snapshot)


def test_org_is_optional_in_both_arms() -> None:
    """--org is a label, not a requirement: a memory-ON cell's memory is set by
    the memory system's own settings (BENCH_MEMORY_ENV), so ON and OFF cells
    both run with or without it.

    Each invocation appends exactly one cell of the arm it names — that append
    is what replaces the old "does the current cell match --mode" validation.
    """
    for args in (
        SimpleNamespace(mode="on", org="okp-org-0"),
        SimpleNamespace(mode="on", org=""),
        SimpleNamespace(mode="off", org=""),
        SimpleNamespace(mode="off", org="okp-org-0"),
    ):
        # Reaching _build_context (stubbed below) proves no RuntimeError was
        # raised on the way there; the append itself is recorded on the stub.
        called = {}
        appended = []

        class _StubSequencer:
            def append_cell(self, memory_mode: str) -> SimpleNamespace:
                appended.append(memory_mode)
                return SimpleNamespace(sequence_index=0)

            def step_until_done(self) -> dict[str, Any]:
                return {"status": "done"}

        def _stub_build_context(_a: Any, *, require_runtime: bool) -> Any:  # noqa: ANN401
            called["called"] = True
            return SimpleNamespace(sequencer=_StubSequencer())

        monkeypatch = pytest.MonkeyPatch()
        monkeypatch.setattr(run_cumulative, "_build_context", _stub_build_context)
        monkeypatch.setattr(
            run_cumulative, "_append_results_ledger", lambda *_a, **_kw: None
        )
        try:
            run_cumulative._handle_run(args)
        finally:
            monkeypatch.undo()
        assert called["called"] is True
        assert appended == [args.mode]
