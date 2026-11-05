"""Delivery telemetry: what the memory plugin actually put in front of the model.

Two layers are under test. The scanners read the plugin's own log
(`.okp/logs/okp-plugin-errors.log`) for `[inject] injected ...` lines; the cell
path runs the REAL arm — there is no mock arm — with the container, the
transport and the build drive stood in, so everything above them (the worktree
seed, the memory switch, the scan at the end) is the code a measured run uses.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

import pytest

import harness.adapters.challenge as challenge_mod
import harness.adapters.challenge.runner as runner_mod
from harness.adapters.challenge import (
    ChallengeRunner,
    _OpencodeRunStats,
    _scan_cell_delivery,
    _scan_injected_block_chars,
)
from harness.adapters.docker_worker import BakedPlugin, ImageFingerprint


TASK_DIR = (Path(__file__).resolve().parents[1] / "task" / "backgammon").resolve()


def _write_plugin_log(worktree: Path, contents: str) -> None:
    log_path = worktree / ".okp" / "logs" / "okp-plugin-errors.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(contents, encoding="utf-8")


def _patch_fake_real_arm(monkeypatch: pytest.MonkeyPatch) -> None:
    """Hermetic real-arm stubs, mirroring test_challenge_budget_stop.

    No docker, no serve HTTP, no model contact: the container, the transport
    and the fingerprint are stood in; everything above them is real.
    """

    class _FakeDockerCellConfig:
        def __init__(
            self,
            *,
            worktree: Path,
            memory_mode: str,
            container_name: str,
            output_token_max: int | None = None,
        ) -> None:
            self.worktree = worktree
            self.memory_mode = memory_mode
            self.container_name = container_name
            self.output_token_max = output_token_max

    class _FakeDockerCell:
        def __init__(self, config: _FakeDockerCellConfig, progress: Any) -> None:
            self.config = config
            self.progress = progress
            self.container_name = config.container_name

        def __enter__(self) -> "_FakeDockerCell":
            return self

        def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
            return False

        def kill_worker_processes(self) -> None:
            pass

        def start_serve(self) -> None:
            # Never start a real `opencode serve`; the session is stubbed below.
            pass

    monkeypatch.setattr(challenge_mod, "DockerCellConfig", _FakeDockerCellConfig)
    monkeypatch.setattr(challenge_mod, "DockerCell", _FakeDockerCell)
    monkeypatch.setattr(challenge_mod, "docker_available", lambda: (True, "ok"))
    monkeypatch.setattr(
        challenge_mod,
        "worker_image_fingerprint",
        lambda: ImageFingerprint(
            image_id="sha256:fake-delivery-test-worker",
            created="2026-09-04T00:00:00Z",
        ),
    )

    real_run = challenge_mod.subprocess.run

    def _run(*args: Any, **kwargs: Any) -> subprocess.CompletedProcess[str]:
        cmd = args[0] if args else kwargs.get("args")
        if isinstance(cmd, list) and cmd and cmd[0] == "docker":
            return subprocess.CompletedProcess(
                cmd, 1, stdout="", stderr="No such container"
            )
        return real_run(*args, **kwargs)

    monkeypatch.setattr(challenge_mod.subprocess, "run", _run)

    class _FakeServeClient:
        def __init__(self, base_url: str, **kwargs: Any) -> None:
            self.base_url = base_url

        def create_session(self, title: str | None = None) -> str:
            return "ses_delivery_cell"

        def get_messages(self, session_id: str) -> list[dict[str, Any]]:
            return []

        def completed_compactions_since(self, session_id: str, watermark: int) -> int:
            return 0

    monkeypatch.setattr(challenge_mod, "ServeClient", _FakeServeClient)
    # The image's baked memory plugin, read from labels in a real run. An ON
    # cell refuses to start without one, so the fake image carries it.
    monkeypatch.setattr(
        runner_mod,
        "baked_plugin",
        lambda: BakedPlugin(
            entry="/opt/bench-plugin/dist/index.js",
            identity="@honcho-ai/opencode-honcho@0.2.1",
        ),
    )


def _make_runner(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, memory_mode: str = "on"
) -> ChallengeRunner:
    """A real-arm runner with a clean one-chunk build; no container, no model."""
    _patch_fake_real_arm(monkeypatch)
    runner = ChallengeRunner(
        task_dir=TASK_DIR,
        work_root=tmp_path / "work-root",
        model="openrouter/anthropic/claude-opus-4.8",
        memory_mode=memory_mode,
    )
    monkeypatch.setattr(
        runner, "_load_chunk_prompts", lambda *args, **kwargs: ["BUILD PROMPT"]
    )

    def _fake_chunked(**kwargs: Any) -> _OpencodeRunStats:
        # A clean one-chunk build: the transport reached idle on its chunk.
        return _OpencodeRunStats(
            input_tokens=1,
            output_tokens=1,
            reasoning_tokens=0,
            turns=1,
            session_id="ses_delivery_cell",
            killed_reason=None,
            exit_code=0,
            cost_usd=0.0,
            chunk_reports=({"chunk": 1, "exit_code": 0},),
        )

    monkeypatch.setattr(runner, "_run_opencode_serve_chunked", _fake_chunked)
    return runner


def _pass_report(**kwargs: Any) -> dict[str, Any]:
    return {
        "verdict": "PASS",
        "conformed": True,
        "problems": [],
        "failed_gates": [],
    }


def test_scan_cell_delivery_returns_yes_when_any_inject_count_is_positive(
    tmp_path: Path,
) -> None:
    worktree = tmp_path / "worktree"
    worktree.mkdir(parents=True, exist_ok=True)
    _write_plugin_log(
        worktree,
        "[inject] injected count=0 chars=10 sid=ses_1 newly_served=0\n"
        "[inject] injected count=2 chars=1207 sid=ses_2 newly_served=2\n",
    )

    assert _scan_cell_delivery(worktree) == "YES"


def test_scan_cell_delivery_returns_no_when_all_inject_counts_are_zero(
    tmp_path: Path,
) -> None:
    worktree = tmp_path / "worktree"
    worktree.mkdir(parents=True, exist_ok=True)
    _write_plugin_log(
        worktree,
        "[inject] injected count=0 chars=100 sid=ses_1 newly_served=0\n"
        "[inject] injected count=0 chars=222 sid=ses_2 newly_served=0\n",
    )

    assert _scan_cell_delivery(worktree) == "NO"


def test_scan_cell_delivery_returns_none_when_log_file_is_missing(
    tmp_path: Path,
) -> None:
    worktree = tmp_path / "worktree"
    worktree.mkdir(parents=True, exist_ok=True)

    assert _scan_cell_delivery(worktree) is None


def test_scan_cell_delivery_returns_none_when_no_inject_lines_exist(
    tmp_path: Path,
) -> None:
    worktree = tmp_path / "worktree"
    worktree.mkdir(parents=True, exist_ok=True)
    _write_plugin_log(
        worktree,
        "[plugin] startup complete\n[inject] unrelated marker\n",
    )

    assert _scan_cell_delivery(worktree) is None


def test_scan_injected_block_chars_reads_new_block_chars_shape(tmp_path: Path) -> None:
    worktree = tmp_path / "worktree"
    worktree.mkdir(parents=True, exist_ok=True)
    _write_plugin_log(
        worktree,
        "[inject] injected count=2 block_chars=2400 sid=ses_new newly_served=2\n",
    )

    assert _scan_injected_block_chars(worktree) == 2400


def test_scan_injected_block_chars_falls_back_to_legacy_chars_shape(
    tmp_path: Path,
) -> None:
    worktree = tmp_path / "worktree"
    worktree.mkdir(parents=True, exist_ok=True)
    _write_plugin_log(
        worktree,
        "[inject] injected count=2 chars=1207 sid=ses_legacy newly_served=2\n",
    )

    assert _scan_injected_block_chars(worktree) == 1207


def test_scan_injected_block_chars_sums_multiple_inject_events(tmp_path: Path) -> None:
    worktree = tmp_path / "worktree"
    worktree.mkdir(parents=True, exist_ok=True)
    _write_plugin_log(
        worktree,
        "[inject] injected count=1 block_chars=1000 sid=ses_a newly_served=1\n"
        "[inject] injected count=1 block_chars=400 sid=ses_b newly_served=1\n",
    )

    assert _scan_injected_block_chars(worktree) == 1400


def test_scan_injected_block_chars_prefers_block_chars_when_both_present(
    tmp_path: Path,
) -> None:
    worktree = tmp_path / "worktree"
    worktree.mkdir(parents=True, exist_ok=True)
    _write_plugin_log(
        worktree,
        "[inject] injected count=2 block_chars=2400 chars=9999 sid=ses_mix newly_served=2\n",
    )

    assert _scan_injected_block_chars(worktree) == 2400


def test_scan_injected_block_chars_returns_none_when_log_missing_or_without_injects(
    tmp_path: Path,
) -> None:
    missing = tmp_path / "missing-worktree"
    missing.mkdir(parents=True, exist_ok=True)
    assert _scan_injected_block_chars(missing) is None

    no_inject = tmp_path / "no-inject-worktree"
    no_inject.mkdir(parents=True, exist_ok=True)
    _write_plugin_log(
        no_inject,
        "[plugin] startup complete\n[inject] unrelated marker\n",
    )

    assert _scan_injected_block_chars(no_inject) is None


def test_scan_cell_delivery_with_additive_cadence_fields(tmp_path: Path) -> None:
    worktree = tmp_path / "worktree"
    worktree.mkdir(parents=True, exist_ok=True)
    _write_plugin_log(
        worktree,
        "[inject] injected count=2 block_chars=2400 cadence=once block_tokens=600 top_k=5 sid=s1 newly_served=2 injected_once=5 budget_remaining=7000\n",
    )

    assert _scan_cell_delivery(worktree) == "YES"


def test_scan_injected_block_chars_with_additive_cadence_fields(tmp_path: Path) -> None:
    worktree = tmp_path / "worktree"
    worktree.mkdir(parents=True, exist_ok=True)
    _write_plugin_log(
        worktree,
        "[inject] injected count=2 block_chars=2400 cadence=once block_tokens=600 top_k=5 sid=s1 newly_served=2 injected_once=5 budget_remaining=7000\n",
    )

    assert _scan_injected_block_chars(worktree) == 2400


def test_restore_lines_are_not_counted_as_injections(tmp_path: Path) -> None:
    worktree = tmp_path / "worktree"
    worktree.mkdir(parents=True, exist_ok=True)
    _write_plugin_log(
        worktree,
        "[inject] injected count=1 block_chars=1200 sid=s1 newly_served=1 injected_once=1 budget_remaining=7800 cadence=once\n"
        "[inject] restored count=2 block_chars=2400 sid=s1 cadence=once compaction_restores=1\n",
    )

    assert _scan_cell_delivery(worktree) == "YES"
    assert _scan_injected_block_chars(worktree) == 1200


def test_restore_only_log_is_not_an_injection(tmp_path: Path) -> None:
    worktree = tmp_path / "worktree"
    worktree.mkdir(parents=True, exist_ok=True)
    _write_plugin_log(
        worktree,
        "[inject] restored count=2 block_chars=2400 sid=s1 cadence=once compaction_restores=1\n",
    )

    assert _scan_cell_delivery(worktree) is None


def _memory_on_prepare(plugin_log: str | None):
    """Stand in for the memory switch: mark the cell measured, plant the log.

    The plugin log is written HERE, not by a copy hook, because the isolation
    preflight refuses any file in the worktree that the scaffold did not
    declare — the cell's own telemetry can only appear after it.
    """

    def _prepare(*, worktree: Path) -> bool:
        marker = worktree / ".okp" / "org.json"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text("{}", encoding="utf-8")
        if plugin_log is not None:
            _write_plugin_log(worktree, plugin_log)
        return False

    return _prepare


def test_run_cell_impl_sets_delivery_yes_when_memory_on_and_inject_log_exists(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    runner = _make_runner(tmp_path, monkeypatch, memory_mode="on")
    monkeypatch.setattr(
        runner,
        "_prepare_memory_mode",
        _memory_on_prepare(
            "[inject] injected count=2 chars=1207 sid=ses_delivery newly_served=2\n"
        ),
    )
    monkeypatch.setattr(runner, "_run_gate_report", _pass_report)

    result = runner._run_cell_impl(
        run_label="delivery-on-yes",
        run_dir=tmp_path / "delivery-on-yes",
        task_id="backgammon",
    )

    assert result.delivery == "YES"


def test_run_cell_impl_sets_injected_block_est_tokens_from_scanned_chars(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    runner = _make_runner(tmp_path, monkeypatch, memory_mode="on")
    monkeypatch.setattr(
        runner,
        "_prepare_memory_mode",
        _memory_on_prepare(
            "[inject] injected count=2 block_chars=1207 sid=ses_tokens newly_served=2\n"
        ),
    )
    monkeypatch.setattr(runner, "_run_gate_report", _pass_report)

    result = runner._run_cell_impl(
        run_label="delivery-on-est-tokens",
        run_dir=tmp_path / "delivery-on-est-tokens",
        task_id="backgammon",
    )

    assert result.injected_block_chars == 1207
    assert result.injected_block_est_tokens == round(1207 / 4)


def test_run_cell_impl_sets_delivery_not_measured_when_memory_on_without_inject_log(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    runner = _make_runner(tmp_path, monkeypatch, memory_mode="on")
    # Measured as a memory cell (the marker exists) but the plugin logged no
    # injection at all: that is "not_measured", never a fabricated "NO".
    monkeypatch.setattr(runner, "_prepare_memory_mode", _memory_on_prepare(None))
    monkeypatch.setattr(runner, "_run_gate_report", _pass_report)

    result = runner._run_cell_impl(
        run_label="delivery-on-not-measured",
        run_dir=tmp_path / "delivery-on-not-measured",
        task_id="backgammon",
    )

    assert result.delivery == "not_measured"


@pytest.mark.slow
def test_run_cell_impl_sets_delivery_na_when_memory_off(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    runner = _make_runner(tmp_path, monkeypatch, memory_mode="off")

    result = runner._run_cell_impl(
        run_label="delivery-off-na",
        run_dir=tmp_path / "delivery-off-na",
        task_id="backgammon",
    )

    assert result.delivery == "N/A"
