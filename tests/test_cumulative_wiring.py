from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

import pytest

from harness.config import RunConfig
from harness.cumulative.types import PhaseGroup, SessionRecord
from harness.lifecycle.lconfig import LifecycleConfig


def _load_run_cumulative_module() -> Any:
    script_path = Path(__file__).resolve().parents[1] / "scripts" / "run_cumulative.py"
    spec = importlib.util.spec_from_file_location("run_cumulative_script", script_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_real_session_runner_forwards_proxy_creds_to_backgammon_runner(
    tmp_path: Path,
) -> None:
    module = _load_run_cumulative_module()
    runner = module.RealSessionRunner.__new__(module.RealSessionRunner)

    captured: dict[str, Any] = {}

    class _FakeRunner:
        def __init__(self, **kwargs: Any) -> None:
            captured.update(kwargs)

        def run_cell(
            self, run_label: str, run_dir: Path, task_id: str = "backgammon"
        ) -> Any:
            return type("_R", (), {"session_id": "sid-1", "verdict": "PASS"})()

    runner._session_states = {}
    # WO-ERRDATA-C4: run_session accumulates per-cell error counts into
    # _error_totals (normally initialized in __init__, which __new__ skips).
    runner._error_totals = {
        "guard_aborted_turns": 0,
        "finalize_timeout_turns": 0,
        "stalled_turns": 0,
    }
    runner._runs_dir = tmp_path / "runs"
    runner._task_dir = tmp_path / "task"
    runner._task = "backgammon"
    runner._org_id = "okp-org-0"
    runner._max_attempts = 3
    runner._proxy_base_url = "http://127.0.0.1:11434/v1"
    runner._proxy_token = "proxy-token-value"
    runner._runner_cls = _FakeRunner
    runner._progress = lambda message: None

    session = SessionRecord(
        sequence_index=0,
        model="openrouter/tencent/hy3",
        provider_pin="tencent",
        memory_mode="off",
        phase_group=PhaseGroup.OFF_BASELINE.value,
        phase="RUN_SESSION",
    )

    result = runner.run_session(session)

    assert captured["proxy_base_url"] == "http://127.0.0.1:11434/v1"
    assert captured["proxy_token"] == "proxy-token-value"
    assert captured["model"] == "openrouter/tencent/hy3"
    # WO-STRIP-2b: org_id is plumbed through so the runner can title the
    # cell's OpenCode session deterministically.
    assert captured["org_id"] == "okp-org-0"
    assert result.session_id == "sid-1"


def test_error_cap_per_type_aborts_the_whole_benchmark(tmp_path: Path) -> None:
    """WO-ERRDATA-C4: one error type exceeding ERROR_CAP_PER_TYPE (20) across
    the benchmark fast-fails the WHOLE run — uncaught, no scorecard. The
    per-cell count (3) plus the running total (18) crosses the cap (21 > 20),
    so run_session must raise ErrorCapExceeded naming the over-cap kind.
    """
    module = _load_run_cumulative_module()
    # ErrorCapExceeded is imported function-locally inside run_session, so it
    # is not a run_cumulative module attribute — bind the SAME class from its
    # canonical home.
    from harness.adapters.backgammon import ErrorCapExceeded

    runner = module.RealSessionRunner.__new__(module.RealSessionRunner)

    class _CapRunner:
        def __init__(self, **kwargs: Any) -> None:
            pass

        def run_cell(
            self, run_label: str, run_dir: Path, task_id: str = "backgammon"
        ) -> Any:
            return type(
                "_R",
                (),
                {
                    "session_id": "sid-1",
                    "verdict": "PASS",
                    "guard_aborted_turns": 3,
                },
            )()

    runner._session_states = {}
    runner._error_totals = {
        "guard_aborted_turns": 18,
        "finalize_timeout_turns": 0,
        "stalled_turns": 0,
    }
    runner._runs_dir = tmp_path / "runs"
    runner._task_dir = tmp_path / "task"
    runner._task = "backgammon"
    runner._org_id = "okp-org-0"
    runner._max_attempts = 3
    runner._proxy_base_url = "http://127.0.0.1:11434/v1"
    runner._proxy_token = "proxy-token-value"
    runner._runner_cls = _CapRunner
    runner._progress = lambda message: None

    session = SessionRecord(
        sequence_index=0,
        model="openrouter/tencent/hy3",
        provider_pin="tencent",
        memory_mode="off",
        phase_group=PhaseGroup.OFF_BASELINE.value,
        phase="RUN_SESSION",
    )

    with pytest.raises(ErrorCapExceeded, match="guard_aborted_turns"):
        runner.run_session(session)


def test_lifecycle_config_env_hooks_default_and_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("BENCH_HUB_URL", raising=False)
    monkeypatch.delenv("BENCH_LEADER_MCP_URL", raising=False)

    default_cfg = LifecycleConfig()
    assert default_cfg.hub_url == "http://127.0.0.1:4440"
    # :4550 is the seed-derived bench leader clone. The default was :4450 (the
    # real host okp-mcp, keychain identity, no seed support), so a run
    # without the env override minted its org under the wrong leader.
    assert default_cfg.leader_mcp_url == "http://127.0.0.1:4550"

    monkeypatch.setenv("BENCH_HUB_URL", "http://127.0.0.1:4449")
    monkeypatch.setenv("BENCH_LEADER_MCP_URL", "http://127.0.0.1:4550")

    overridden_cfg = LifecycleConfig()
    assert overridden_cfg.hub_url == "http://127.0.0.1:4449"
    assert overridden_cfg.leader_mcp_url == "http://127.0.0.1:4550"


def test_run_config_env_hooks_default_and_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("BENCH_HUB_URL", raising=False)
    monkeypatch.delenv("BENCH_MCP_RECALL_URL", raising=False)

    default_cfg = RunConfig()
    assert default_cfg.hub_url == "http://127.0.0.1:4440"
    assert default_cfg.mcp_recall_url == "http://127.0.0.1:4550"

    monkeypatch.setenv("BENCH_HUB_URL", "http://127.0.0.1:4444")
    monkeypatch.setenv("BENCH_MCP_RECALL_URL", "http://127.0.0.1:4557")

    overridden_cfg = RunConfig()
    assert overridden_cfg.hub_url == "http://127.0.0.1:4444"
    assert overridden_cfg.mcp_recall_url == "http://127.0.0.1:4557"
