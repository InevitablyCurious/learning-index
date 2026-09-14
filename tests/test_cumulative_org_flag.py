from __future__ import annotations

import os
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

# LI-14: run_cumulative is now a package (scripts/run_cumulative/) fronted by a
# thin scripts/run_cumulative.py entrypoint. Import the PACKAGE so the
# monkeypatch targets below (_build_context / _current_session_or_raise) patch
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


def test_on_without_org_errors_before_runtime_build() -> None:
    """ON cells REQUIRE --org: the validation fires in _handle_run BEFORE
    _build_context is reached, so no runtime construction happens."""
    args = SimpleNamespace(mode="on", org="")

    def _forbidden_build_context(*_: Any, **__: Any) -> Any:  # noqa: ANN401
        raise AssertionError("_build_context must not run for ON-without-org")

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(run_cumulative, "_build_context", _forbidden_build_context)
    try:
        with pytest.raises(RuntimeError) as excinfo:
            run_cumulative._handle_run(args)
    finally:
        monkeypatch.undo()

    message = str(excinfo.value)
    assert "--mode on" in message
    assert "--org" in message


def test_on_with_org_and_off_without_org_do_not_raise() -> None:
    """ON with --org present and OFF without --org both pass the validation."""
    for args in (
        SimpleNamespace(mode="on", org="okp-org-0"),
        SimpleNamespace(mode="off", org=""),
        SimpleNamespace(mode="", org=""),
    ):
        # Validation passes; reaching _build_context (which is stubbed to a no-op
        # returning a fake context) proves no RuntimeError was raised here.
        called = {}

        class _StubSequencer:
            def memory_mode(self) -> str:  # pragma: no cover - not reached for off
                return "off"

            def step_until_done(self) -> dict[str, Any]:
                return {"status": "done"}

        def _stub_build_context(_a: Any, *, require_runtime: bool) -> Any:  # noqa: ANN401
            called["called"] = True
            return SimpleNamespace(sequencer=_StubSequencer())

        monkeypatch = pytest.MonkeyPatch()
        monkeypatch.setattr(run_cumulative, "_build_context", _stub_build_context)
        session_mode = str(getattr(args, "mode", "") or "").strip().lower() or "off"
        monkeypatch.setattr(
            run_cumulative,
            "_current_session_or_raise",
            lambda seq: SimpleNamespace(memory_mode=session_mode),
        )
        try:
            run_cumulative._handle_run(args)
        finally:
            monkeypatch.undo()
        assert called["called"] is True
