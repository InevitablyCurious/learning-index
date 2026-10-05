"""What a memory-ON cell is given at run time, and what an OFF cell is not.

Two things reach a memory-ON cell from the operator's environment
(harness/memory_slot.py): a route to the memory system's server through the
egress sidecar (BENCH_MEMORY_UPSTREAM), and the memory plugin's own settings
(BENCH_MEMORY_ENV), passed into the worker by name so a key never lands in argv.
An OFF cell gets neither.
"""

from __future__ import annotations

import subprocess
from itertools import pairwise
from pathlib import Path

import pytest

from harness.adapters.challenge import ChallengeRunner
from harness.adapters.docker_worker import DockerCell, DockerCellConfig
from harness.egress import EGRESS_MEMORY_PORT
from harness.memory_slot import (
    ENV_MEMORY_ENV,
    ENV_MEMORY_UPSTREAM,
    memory_settings,
    memory_upstream,
    parse_settings,
    redacted,
)

TASK_DIR = Path(__file__).resolve().parents[1] / "task" / "backgammon"
UPSTREAM = "http://host.docker.internal:8000"
SIDECAR = "okp-egress-memory-route"
SECRET = "hch-secret-value"


def _contains_pair(argv: list[str], left: str, right: str) -> bool:
    return any(a == left and b == right for a, b in pairwise(argv))


# --- the settings file ---------------------------------------------------------


def test_settings_lines_are_read_as_name_value_pairs() -> None:
    text = (
        "# Honcho\n"
        "\n"
        "HONCHO_BASE_URL={memory_url}\n"
        "export HONCHO_WORKSPACE_ID=series-a\n"
        "HONCHO_PEER_NAME = 'operator'\n"
        'HONCHO_SYSTEM_INSTRUCTION="a = b"\n'
        "HONCHO_API_KEY=\n"
    )
    assert parse_settings(text) == {
        "HONCHO_BASE_URL": "{memory_url}",
        "HONCHO_WORKSPACE_ID": "series-a",
        "HONCHO_PEER_NAME": "operator",
        "HONCHO_SYSTEM_INSTRUCTION": "a = b",
        "HONCHO_API_KEY": "",
    }


@pytest.mark.parametrize("line", ["no equals sign", "1BAD=x", "=value", "A B=x"])
def test_a_malformed_line_is_refused_by_number(line: str) -> None:
    with pytest.raises(ValueError, match="line 2: expected NAME=value"):
        parse_settings(f"GOOD=1\n{line}\n")


@pytest.mark.parametrize(
    "name",
    [
        "HOME",
        "PATH",
        "OPENCODE_CONFIG",
        "BENCH_MEMORY_UPSTREAM",
        "LOCAL_LLM_PROXY_API_KEY",
        "ORCAROUTER_API_KEY",
        "NODE_OPTIONS",
        "DOCKER_HOST",
        "HTTPS_PROXY",
        "no_proxy",
    ],
)
def test_a_name_that_decides_what_the_cell_is_is_refused(name: str) -> None:
    with pytest.raises(
        ValueError, match=f"line 1: {name} is reserved by the benchmark"
    ):
        parse_settings(f"{name}=x\n")


def test_the_server_address_is_filled_into_the_settings(tmp_path: Path) -> None:
    settings_file = tmp_path / "memory.env"
    settings_file.write_text(
        "HONCHO_BASE_URL={memory_url}\nHONCHO_WORKSPACE_ID=series-a\n"
    )
    env = {ENV_MEMORY_ENV: str(settings_file)}
    assert memory_settings("http://sidecar:4560", env) == {
        "HONCHO_BASE_URL": "http://sidecar:4560",
        "HONCHO_WORKSPACE_ID": "series-a",
    }


def test_the_server_address_without_a_server_is_refused(tmp_path: Path) -> None:
    settings_file = tmp_path / "memory.env"
    settings_file.write_text("HONCHO_BASE_URL={memory_url}\n")
    with pytest.raises(ValueError, match="BENCH_MEMORY_UPSTREAM is not set"):
        memory_settings("", {ENV_MEMORY_ENV: str(settings_file)})


def test_no_settings_file_means_no_settings() -> None:
    assert memory_settings("http://sidecar:4560", {}) == {}
    assert memory_upstream({}) == ""
    assert memory_upstream({ENV_MEMORY_UPSTREAM: f" {UPSTREAM} "}) == UPSTREAM


def test_a_named_settings_file_that_is_missing_stops_the_cell(tmp_path: Path) -> None:
    env = {ENV_MEMORY_ENV: str(tmp_path / "absent.env")}
    with pytest.raises(FileNotFoundError, match="is not a file"):
        memory_settings("http://sidecar:4560", env)


def test_secret_looking_values_are_never_recorded() -> None:
    assert redacted(
        {
            "HONCHO_API_KEY": SECRET,
            "HONCHO_BASE_URL": "http://sidecar:4560",
            "SOME_TOKEN": SECRET,
        }
    ) == {
        "HONCHO_API_KEY": "***",
        "HONCHO_BASE_URL": "http://sidecar:4560",
        "SOME_TOKEN": "***",
    }


# --- the docker invocation -----------------------------------------------------


def _start_cell(
    monkeypatch: pytest.MonkeyPatch, config: DockerCellConfig
) -> tuple[list[list[str]], list[dict[str, str]]]:
    """Start a cell against a fake docker CLI; return each run's argv and env."""
    argvs: list[list[str]] = []
    envs: list[dict[str, str]] = []

    def _fake_run(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess:
        if argv[:2] == ["docker", "run"]:
            argvs.append(list(argv))
            envs.append(dict(kwargs.get("env") or {}))
            return subprocess.CompletedProcess(argv, 0, stdout="fake-id\n", stderr="")
        if argv[:2] == ["docker", "rm"]:
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")
        raise AssertionError(f"unexpected docker invocation: {argv!r}")

    monkeypatch.setattr(
        "harness.adapters.docker_worker.ensure_network", lambda *_, **__: None
    )
    monkeypatch.setattr("harness.adapters.docker_worker._host_uid", lambda: 501)
    monkeypatch.setattr("harness.adapters.docker_worker._host_gid", lambda: 20)
    monkeypatch.setattr("harness.adapters.docker_worker.subprocess.run", _fake_run)

    cell = DockerCell(config)
    try:
        cell.__enter__()
    finally:
        cell.teardown()
    return argvs, envs


def _cell_config(tmp_path: Path, memory_mode: str, **memory) -> DockerCellConfig:
    return DockerCellConfig(
        worktree=tmp_path / "worktree",
        memory_mode=memory_mode,
        container_name="bench-cell-memory-route",
        proxy_base_url=f"http://{SIDECAR}:4545/v1",
        proxy_token="test-ephemeral-token",
        egress_host=SIDECAR,
        **memory,
    )


def test_a_memory_on_cell_gets_the_route_and_the_settings_by_name(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    memory_env = {
        "HONCHO_BASE_URL": f"http://{SIDECAR}:{EGRESS_MEMORY_PORT}",
        "HONCHO_API_KEY": SECRET,
    }
    (sidecar_argv, worker_argv), (_, worker_env) = _start_cell(
        monkeypatch,
        _cell_config(tmp_path, "on", memory_upstream=UPSTREAM, memory_env=memory_env),
    )

    # The sidecar opens the memory route to the server.
    assert _contains_pair(sidecar_argv, "-e", f"{ENV_MEMORY_UPSTREAM}={UPSTREAM}")

    # The worker gets each setting by name; the values travel in the CLI env.
    assert _contains_pair(worker_argv, "-e", "HONCHO_BASE_URL")
    assert _contains_pair(worker_argv, "-e", "HONCHO_API_KEY")
    assert worker_env["HONCHO_API_KEY"] == SECRET
    assert worker_env["HONCHO_BASE_URL"] == memory_env["HONCHO_BASE_URL"]

    # No value is ever in argv; the sidecar gets no settings, the worker no route.
    assert not any(SECRET in part for part in sidecar_argv + worker_argv)
    assert not any("HONCHO_" in part for part in sidecar_argv)
    assert not any(ENV_MEMORY_UPSTREAM in part for part in worker_argv)


def test_an_off_cell_gets_no_route_and_no_settings(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    (sidecar_argv, _), _ = _start_cell(monkeypatch, _cell_config(tmp_path, "off"))
    assert not any(ENV_MEMORY_UPSTREAM in part for part in sidecar_argv)


# --- the runner's cell config --------------------------------------------------


def _runner(tmp_path: Path, memory_mode: str) -> ChallengeRunner:
    return ChallengeRunner(
        task_dir=TASK_DIR,
        work_root=tmp_path / "work-root",
        model="local/qwen",
        mock="scaffold",
        memory_mode=memory_mode,
    )


def _built(runner: ChallengeRunner, tmp_path: Path) -> DockerCellConfig:
    worktree = tmp_path / "cell" / "worktree"
    worktree.mkdir(parents=True)
    return runner._build_cell_config(
        worktree=worktree, container_name="bench-cell-x", egress_host=SIDECAR
    )


@pytest.fixture
def operator_memory_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    settings_file = tmp_path / "memory.env"
    settings_file.write_text(
        f"HONCHO_BASE_URL={{memory_url}}\nHONCHO_API_KEY={SECRET}\n"
    )
    monkeypatch.setenv(ENV_MEMORY_UPSTREAM, UPSTREAM)
    monkeypatch.setenv(ENV_MEMORY_ENV, str(settings_file))


def test_a_memory_on_cell_reaches_the_server_through_the_sidecar(
    tmp_path: Path, operator_memory_env: None
) -> None:
    runner = _runner(tmp_path, "on")
    progress: list[str] = []
    runner._progress = progress.append

    config = _built(runner, tmp_path)

    assert config.memory_upstream == UPSTREAM
    assert config.memory_env == {
        "HONCHO_BASE_URL": f"http://{SIDECAR}:{EGRESS_MEMORY_PORT}",
        "HONCHO_API_KEY": SECRET,
    }
    recorded = "\n".join(progress)
    assert "step=memory-config" in recorded
    assert SECRET not in recorded


def test_an_off_cell_ignores_the_operator_memory_settings(
    tmp_path: Path, operator_memory_env: None
) -> None:
    config = _built(_runner(tmp_path, "off"), tmp_path)
    assert config.memory_upstream == ""
    assert config.memory_env == {}
