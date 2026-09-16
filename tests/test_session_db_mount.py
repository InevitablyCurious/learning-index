from __future__ import annotations

from pathlib import Path

from harness.adapters.challenge import ChallengeRunner
from harness.adapters.docker_worker import DockerCellConfig, _build_run_argv


TASK_DIR = (Path(__file__).resolve().parents[1] / "task" / "backgammon").resolve()
TEST_PROXY_BASE_URL = "http://host.docker.internal:8789/api/v1"
TEST_PROXY_TOKEN = "test-ephemeral-token"


def _contains_pair(argv: list[str], left: str, right: str) -> bool:
    for idx, item in enumerate(argv[:-1]):
        if item == left and argv[idx + 1] == right:
            return True
    return False


def _build_memory_on_cfg(*, worktree: Path) -> DockerCellConfig:
    return DockerCellConfig(
        worktree=worktree,
        memory_mode="on",
        container_name="bench-cell-session-db-on",
        proxy_base_url=TEST_PROXY_BASE_URL,
        proxy_token=TEST_PROXY_TOKEN,
    )


def test_run_argv_session_db_mount_present_when_configured_memory_mode_off(
    tmp_path: Path,
) -> None:
    worktree = tmp_path / "worktree-off"
    session_db = tmp_path / "session-db-off"
    cfg = DockerCellConfig(
        worktree=worktree,
        memory_mode="off",
        container_name="bench-cell-session-db-off",
        proxy_base_url=TEST_PROXY_BASE_URL,
        proxy_token=TEST_PROXY_TOKEN,
        session_db_host_path=session_db,
    )

    argv = _build_run_argv(
        config=cfg, worktree=worktree, uid=501, gid=20, memory_mode="off"
    )

    # WO-DBVOL-1: the session DB is served from a NAMED DOCKER VOLUME, never a
    # host bind mount. On macOS a bind mount puts SQLite on osxfs/gRPC-FUSE,
    # whose locking/fsync semantics SQLite cannot rely on — verified corruption
    # ("database disk image is malformed", damaged pages in the `part` table)
    # on BOTH 2026-08-11 cells that failed with HTTP 500.
    assert _contains_pair(
        argv,
        "-v",
        "bench-cell-session-db-off-session-db:/home/worker/.local/share/opencode:rw",
    )
    # The host path must NOT appear as a bind source: that is the defect.
    assert not any(
        str(session_db.resolve()) in item
        and "/home/worker/.local/share/opencode" in item
        for item in argv
    ), "session DB must never be bind-mounted from the macOS filesystem"
    # The 1777 tmpfs on .local keeps opencode's XDG_STATE_HOME sibling writable:
    # docker pre-creates the mount destination's parents as root:0755 otherwise.
    # size=1g carries the disk-clip cap, matching the HOME tmpfs (docker_worker.py).
    assert _contains_pair(argv, "--tmpfs", "/home/worker/.local:mode=1777,size=1g")


def test_run_argv_session_db_mount_present_when_configured_memory_mode_on(
    tmp_path: Path,
) -> None:
    worktree = tmp_path / "worktree-on"
    session_db = tmp_path / "session-db-on"
    cfg = _build_memory_on_cfg(worktree=worktree)
    cfg.session_db_host_path = session_db

    argv = _build_run_argv(
        config=cfg, worktree=worktree, uid=501, gid=20, memory_mode="on"
    )

    # Volume-backed on the ON arm too: the arms must stay byte-identical in
    # topology, and the ON arm is the one whose extraction result depends on
    # this DB being sound.
    assert _contains_pair(
        argv,
        "-v",
        "bench-cell-session-db-on-session-db:/home/worker/.local/share/opencode:rw",
    )
    assert not any(
        str(session_db.resolve()) in item
        and "/home/worker/.local/share/opencode" in item
        for item in argv
    ), "session DB must never be bind-mounted from the macOS filesystem"
    assert _contains_pair(argv, "--tmpfs", "/home/worker/.local:mode=1777,size=1g")


def test_run_argv_session_db_mount_absent_when_none(tmp_path: Path) -> None:
    worktree = tmp_path / "worktree-none"
    cfg = DockerCellConfig(
        worktree=worktree,
        memory_mode="off",
        container_name="bench-cell-session-db-none",
        proxy_base_url=TEST_PROXY_BASE_URL,
        proxy_token=TEST_PROXY_TOKEN,
        session_db_host_path=None,
    )

    argv = _build_run_argv(
        config=cfg, worktree=worktree, uid=501, gid=20, memory_mode="off"
    )

    assert not any("/home/worker/.local/share/opencode" in entry for entry in argv)
    # Absence is pinned to the SAME capped form docker_worker.py emits when
    # session_db_host_path is set (…:mode=1777,size=1g): checking the old bare
    # string would pass vacuously and miss a buggy capped emission.
    assert not any(entry == "/home/worker/.local:mode=1777,size=1g" for entry in argv)


def test_build_cell_config_wires_session_db_host_path_to_run_dir(
    tmp_path: Path,
) -> None:
    run_dir = tmp_path / "run"
    worktree = run_dir / "worktree"
    worktree.mkdir(parents=True, exist_ok=True)
    runner = ChallengeRunner(
        task_dir=TASK_DIR,
        work_root=tmp_path / "work-root",
        model="openrouter/anthropic/claude-opus-4.8",
        mock="scaffold",
    )

    cell_config = runner._build_cell_config(
        worktree=worktree, container_name="cell-session-db"
    )

    expected = run_dir / "session-db"
    assert cell_config.session_db_host_path == expected
    assert expected.is_dir()


def test_serve_port_publishes_to_loopback_only() -> None:
    """`-p 4096:4096` binds 0.0.0.0 — verified on a live cell as
    "0.0.0.0:4096->4096/tcp, [::]:4096->4096/tcp" — which publishes the
    worker's opencode serve (full session transcript, plus an API that can
    drive the agent) to every device on the operator's network. The 127.0.0.1
    host prefix is the boundary that prevents it."""
    config = DockerCellConfig(
        worktree=TASK_DIR,
        memory_mode="off",
        container_name="bench-cell-loopback-publish",
        proxy_base_url=TEST_PROXY_BASE_URL,
        proxy_token=TEST_PROXY_TOKEN,
    )
    argv = _build_run_argv(
        config=config, worktree=TASK_DIR, uid=501, gid=20, memory_mode="off"
    )

    publishes = [argv[i + 1] for i, tok in enumerate(argv) if tok == "-p"]
    assert publishes, "the serve port must still be published"
    for spec in publishes:
        assert spec.startswith("127.0.0.1:"), (
            f"publish {spec!r} binds every interface; it must be loopback-scoped"
        )
    assert (
        f"127.0.0.1:{config.serve_host_port}:{config.serve_container_port}" in publishes
    )
