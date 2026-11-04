from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

import pytest

from harness.cumulative.types import PhaseGroup, SessionRecord


def _load_run_cumulative_module() -> Any:
    script_path = Path(__file__).resolve().parents[1] / "scripts" / "run_cumulative.py"
    spec = importlib.util.spec_from_file_location("run_cumulative_script", script_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _build_real_session_runner(module: Any, tmp_path: Path) -> Any:
    repo_root = tmp_path / "repo"
    (repo_root / "task" / "backgammon").mkdir(parents=True, exist_ok=True)

    return module.RealSessionRunner(
        task="backgammon",
        org_id="okp-org-0",
        runs_dir=tmp_path / "runs",
        repo_root=repo_root,
    )


def _sample_session() -> SessionRecord:
    return SessionRecord(
        sequence_index=0,
        model="openrouter/tencent/hy3",
        provider_pin="tencent",
        memory_mode="off",
        phase_group=PhaseGroup.OFF_BASELINE.value,
        phase="RUN_SESSION",
    )


def test_pacing_knobs_env_unset_uses_defaults_without_optional_runner_overrides(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    module = _load_run_cumulative_module()
    monkeypatch.delenv("BENCH_MAX_STEPS_PER_ATTEMPT", raising=False)

    runner = _build_real_session_runner(module, tmp_path)
    captured: dict[str, Any] = {}

    class _FakeRunner:
        def __init__(self, **kwargs: Any) -> None:
            captured.update(kwargs)

        def run_cell(
            self,
            run_label: str,
            run_dir: Path,
            task_id: str = "backgammon",
            run_identity: str | None = None,
        ) -> Any:
            return type("_R", (), {"session_id": "sid-default", "verdict": "PASS"})()

    runner._runner_cls = _FakeRunner
    runner.run_session(_sample_session())

    assert "max_steps_per_attempt" not in captured


def test_pacing_knobs_env_set_forwards_runner_constructor_overrides(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    module = _load_run_cumulative_module()
    monkeypatch.setenv("BENCH_MAX_STEPS_PER_ATTEMPT", "83")

    runner = _build_real_session_runner(module, tmp_path)
    captured: dict[str, Any] = {}

    class _FakeRunner:
        def __init__(self, **kwargs: Any) -> None:
            captured.update(kwargs)

        def run_cell(
            self,
            run_label: str,
            run_dir: Path,
            task_id: str = "backgammon",
            run_identity: str | None = None,
        ) -> Any:
            return type("_R", (), {"session_id": "sid-env", "verdict": "PASS"})()

    runner._runner_cls = _FakeRunner
    runner.run_session(_sample_session())

    assert captured["max_steps_per_attempt"] == 83


@pytest.mark.parametrize(
    ("env_name", "env_value"),
    [
        ("BENCH_MAX_STEPS_PER_ATTEMPT", "0"),
        ("BENCH_MAX_STEPS_PER_ATTEMPT", "abc"),
    ],
)
def test_pacing_knobs_invalid_env_raises_runtime_error(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    env_name: str,
    env_value: str,
) -> None:
    module = _load_run_cumulative_module()
    monkeypatch.delenv("BENCH_MAX_STEPS_PER_ATTEMPT", raising=False)
    monkeypatch.setenv(env_name, env_value)

    with pytest.raises(RuntimeError, match=env_name):
        _build_real_session_runner(module, tmp_path)
