"""A2 phase-sentinel mount: the transport that tells a cell which phase it is in.

WHY THIS EXISTS. The worker's self-compaction arm used to fire on a string the
MODEL emits (`CHUNK FINISHED`). That string was instructed only by the six build
chunk prompts, but repair rounds run in the SAME session with no phase framing,
so the convention survived every compaction and the model kept printing it while
fixing gate failures. In run 1788462647 that fired a compaction ~80s before the
end of `feedback-2`, and no scoring path could see it: the settle wait runs only
at build boundaries, and VOID-INSTRUMENT only catches a compaction that was
KILLED, not one that completed.

The phase is knowable exactly on the harness side, so the harness publishes it.
The cell env is fixed at `docker run` and cannot change between phases, so the
transport is a read-only bind mount the plugin re-reads on every session.idle.

SINCE WO-MARKER-RIP (2026-09-09) THIS MOUNT IS THE WHOLE GATE. The model-emitted
string is deleted, so a cell that does not get this mount cannot compact at all
— which is why the harness aborts rather than continuing when it is absent.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from harness.adapters.docker_worker import DockerCell, DockerCellConfig, _build_run_argv


TEST_PROXY_BASE_URL = "http://host.docker.internal:8789/api/v1"
TEST_PROXY_TOKEN = "test-ephemeral-token"


def _contains_pair(argv: list[str], left: str, right: str) -> bool:
    for idx, item in enumerate(argv[:-1]):
        if item == left and argv[idx + 1] == right:
            return True
    return False


def _cfg(tmp_path: Path, *, memory_mode: str, compact: bool) -> DockerCellConfig:
    cfg = DockerCellConfig(
        worktree=tmp_path / f"worktree-{memory_mode}",
        memory_mode=memory_mode,
        container_name=f"bench-cell-compact-{memory_mode}",
        proxy_base_url=TEST_PROXY_BASE_URL,
        proxy_token=TEST_PROXY_TOKEN,
    )
    cfg.self_compact = compact
    if compact:
        cfg.compact_phase_host_path = tmp_path / f"compact-phase-{memory_mode}"
    return cfg


@pytest.mark.parametrize("memory_mode", ["on", "off"])
def test_the_sentinel_is_mounted_for_both_arms(
    tmp_path: Path, memory_mode: str
) -> None:
    """BOTH ARMS OR THE COMPARISON IS WORTHLESS.

    The leak was never memory-mode-specific: without a phase transport the arm
    stays armed through repair in ON and OFF alike. An OFF cell that could still
    compact during repair would break the very comparability the OFF arm exists
    to provide.
    """
    cfg = _cfg(tmp_path, memory_mode=memory_mode, compact=True)
    argv = _build_run_argv(
        config=cfg,
        worktree=cfg.worktree,
        uid=501,
        gid=20,
        memory_mode=memory_mode,
    )

    assert _contains_pair(argv, "-e", "BENCH_SELF_COMPACT=1")
    assert _contains_pair(argv, "-e", "BENCH_COMPACT_PHASE_FILE=/okp-compact/phase")
    host = (tmp_path / f"compact-phase-{memory_mode}").resolve()
    assert _contains_pair(argv, "-v", f"{host}:/okp-compact:ro")


def test_the_sentinel_mount_is_read_only_and_outside_the_worktree(
    tmp_path: Path,
) -> None:
    """Two separate properties, both load-bearing.

    READ-ONLY: the harness is the only writer, so a cell cannot forge its own
    phase and compact whenever it likes.

    OUTSIDE /work: anything under the worktree is inside the surface the model
    works in and the gates score. The phase is instrument state, and the model
    must never see it — the same reason the OFF arm's extraction state lives at
    /okp-state rather than in the worktree.
    """
    cfg = _cfg(tmp_path, memory_mode="on", compact=True)
    argv = _build_run_argv(
        config=cfg, worktree=cfg.worktree, uid=501, gid=20, memory_mode="on"
    )

    mounts = [argv[i + 1] for i, a in enumerate(argv[:-1]) if a == "-v"]
    sentinel = [m for m in mounts if ":/okp-compact" in m]
    assert len(sentinel) == 1, mounts
    assert sentinel[0].endswith(":ro"), sentinel[0]
    assert not sentinel[0].startswith(f"{cfg.worktree}"), (
        "the phase sentinel must not live inside the scored worktree"
    )


def test_no_sentinel_and_no_env_when_the_run_does_not_compact(
    tmp_path: Path,
) -> None:
    """A non-compacting run is byte-for-byte unchanged by this mechanism."""
    cfg = _cfg(tmp_path, memory_mode="on", compact=False)
    argv = _build_run_argv(
        config=cfg, worktree=cfg.worktree, uid=501, gid=20, memory_mode="on"
    )

    assert not any("BENCH_COMPACT_PHASE_FILE" in a for a in argv)
    assert not any("/okp-compact" in a for a in argv)
    assert not _contains_pair(argv, "-e", "BENCH_SELF_COMPACT=1")


def test_arming_compaction_without_a_sentinel_path_refuses_to_launch(
    tmp_path: Path,
) -> None:
    """The plugin is fail-closed on the sentinel, so a cell launched without the
    mount would never compact and would abort at the first chunk boundary on
    no_compaction_evidence — after paying for a whole build. Refuse at launch
    instead, where the mistake is free and legible."""
    cfg = _cfg(tmp_path, memory_mode="on", compact=True)
    cfg.compact_phase_host_path = None

    with pytest.raises(RuntimeError, match="compact_phase_host_path"):
        _build_run_argv(
            config=cfg, worktree=cfg.worktree, uid=501, gid=20, memory_mode="on"
        )


def _enter_cell_capturing_argv(
    cfg: DockerCellConfig, monkeypatch: pytest.MonkeyPatch
) -> list[list[str]]:
    """Enter a DockerCell with docker mocked out; return every `docker run` argv.

    The sidecar argv is built inline in DockerCell.__enter__ (no pure builder
    seam like _build_run_argv), so the nearest testable seam is the mocked
    subprocess capture used by test_docker_isolation.py's sidecar test: first
    `docker run` is the sidecar, second is the worker cell.
    """
    run_argvs: list[list[str]] = []

    def _fake_run(
        argv: list[str], **kwargs: object
    ) -> subprocess.CompletedProcess[str]:
        if len(argv) >= 2 and argv[0] == "docker" and argv[1] == "run":
            run_argvs.append(list(argv))
            return subprocess.CompletedProcess(
                argv, 0, stdout="fake-container-id\n", stderr=""
            )
        if len(argv) >= 2 and argv[0] == "docker" and argv[1] == "rm":
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")
        raise AssertionError(f"unexpected docker invocation: {argv!r}")

    monkeypatch.setattr(
        "harness.adapters.docker_worker.ensure_network", lambda *_, **__: None
    )
    monkeypatch.setattr("harness.adapters.docker_worker._host_uid", lambda: 501)
    monkeypatch.setattr("harness.adapters.docker_worker._host_gid", lambda: 20)
    monkeypatch.setattr("harness.adapters.docker_worker.subprocess.run", _fake_run)

    cell = DockerCell(cfg)
    try:
        cell.__enter__()
    finally:
        cell.teardown()
    return run_argvs


def test_sidecar_gets_rw_sentinel_mount_and_phase_env_when_compacting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The sidecar is the repair-phase WRITER: it must carry the same host dir
    the cell mounts :ro, but RW (no suffix) and with BENCH_COMPACT_PHASE_FILE so
    its scanner can write `repair` between rounds. The cell's own :ro mount is
    unchanged — the cell still cannot forge its phase."""
    cfg = _cfg(tmp_path, memory_mode="on", compact=True)
    cfg.egress_host = "okp-egress-compact-sentinel"

    run_argvs = _enter_cell_capturing_argv(cfg, monkeypatch)
    assert len(run_argvs) == 2
    sidecar_argv, worker_argv = run_argvs

    host = cfg.compact_phase_host_path.expanduser().resolve()
    assert _contains_pair(sidecar_argv, "-v", f"{host}:/okp-compact"), (
        f"sidecar argv missing RW phase mount: {sidecar_argv!r}"
    )
    assert not any(part == f"{host}:/okp-compact:ro" for part in sidecar_argv), (
        "sidecar phase mount must be RW, not :ro"
    )
    assert _contains_pair(
        sidecar_argv, "-e", "BENCH_COMPACT_PHASE_FILE=/okp-compact/phase"
    ), f"sidecar argv missing phase env: {sidecar_argv!r}"

    # Worker cell mount unchanged: still read-only.
    assert _contains_pair(worker_argv, "-v", f"{host}:/okp-compact:ro")


def test_sidecar_gets_no_sentinel_mount_when_not_compacting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A non-compacting egress run's sidecar is byte-for-byte unchanged: no
    /okp-compact mount, no BENCH_COMPACT_PHASE_FILE env (the guard mirrors the
    worker's self_compact gate)."""
    cfg = _cfg(tmp_path, memory_mode="on", compact=False)
    cfg.egress_host = "okp-egress-no-compact-sentinel"
    # The real harness sets the host path on EVERY cell (backgammon.py:4081)
    # and gates only on self_compact — pin that: a configured path with
    # self_compact=False must still produce no sidecar mount.
    cfg.compact_phase_host_path = tmp_path / "compact-phase-on"

    run_argvs = _enter_cell_capturing_argv(cfg, monkeypatch)
    assert len(run_argvs) == 2
    sidecar_argv, _worker_argv = run_argvs

    assert not any("/okp-compact" in part for part in sidecar_argv)
    assert not any("BENCH_COMPACT_PHASE_FILE" in part for part in sidecar_argv)
