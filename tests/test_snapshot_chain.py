"""WO-LI-SNAPSHOT-CHAIN: end-of-run snapshot chaining for exhausted seeded cells.

The contract under test: a DEV-MODE seeded cell that reaches the attempt
ceiling promotes its final attempt's checkpoint tree into a NEW snapshot under
$BENCH_RUNS_DIR/snapshots/<id>/ with snapshot_depth = seed depth + 1, and
records that id on ChallengeCellResult.produced_snapshot_id (the run->snapshot
join key). Promotion is skipped when the exit is harness_error. On the read
side, load_snapshot defaults an absent snapshot_depth to 1 so existing build
snapshots keep their meaning. Helpers are module-local per repo convention
(modeled on tests/test_snapshot_capture.py — never imported across modules).
"""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
from typing import Any

import pytest

import harness.adapters.challenge as challenge_mod
from harness.adapters.challenge import ChallengeRunner, _OpencodeRunStats
from harness.adapters.docker_worker import ImageFingerprint
from harness.snapshot import capture_snapshot, load_snapshot

REPO = Path(__file__).resolve().parents[1]
TASK_DIR = (REPO / "task" / "backgammon").resolve()

# A real graded gate check (the single-system feedback contract hard-fails on
# synthetic labels, so loop mechanics must drive the cell with genuine ids —
# same precedent as tests/test_snapshot_capture.py).
SEEDED_CHECK = "[G02] REQ-PIP — pip count"


def _make_runner(
    tmp_path: Path,
    *,
    mock: str | None = "scaffold",
    max_attempts: int = 8,
    **extra: Any,
) -> ChallengeRunner:
    return ChallengeRunner(
        task_dir=TASK_DIR,
        work_root=tmp_path / "work-root",
        model="local-llm-proxy/okp-bench-worker",
        max_attempts=max_attempts,
        mock=mock,
        **extra,
    )


def _drive(
    runner: ChallengeRunner,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    gate: Any,
) -> Any:
    """Pin the runs root to tmp_path, stub the gate, drive one mock cell."""
    monkeypatch.setenv("BENCH_RUNS_DIR", str(tmp_path))
    monkeypatch.setattr(runner, "_run_gate_report", gate)
    return runner._run_cell_impl(
        run_label="lbl",
        run_dir=tmp_path / "rundir",
        task_id="backgammon",
    )


def _snapshot_dirs(tmp_path: Path) -> list[Path]:
    root = tmp_path / "snapshots"
    if not root.exists():
        return []
    return sorted(p for p in root.iterdir() if p.is_dir())


def _read_snapshot(tmp_path: Path) -> dict[str, Any]:
    dirs = _snapshot_dirs(tmp_path)
    assert len(dirs) == 1, f"expected exactly one snapshot dir, got {dirs}"
    payload = (dirs[0] / "snapshot.json").read_text(encoding="utf-8")
    return json.loads(payload)


def _patch_fake_real_arm(monkeypatch: pytest.MonkeyPatch) -> None:
    """Hermetic real-arm (mock=None) stubs, mirroring test_snapshot_capture.

    No docker, no serve HTTP, no model contact: the container, the transport
    and both drive methods are stood in; everything above them is real.
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
            image_id="sha256:fake-seeded-test-worker",
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
            return "ses_seeded_cell"

    monkeypatch.setattr(challenge_mod, "ServeClient", _FakeServeClient)


def _fail_gate(**kwargs: Any) -> dict[str, Any]:
    """ALWAYS-FAIL gate report carrying a real check id (SEEDED_CHECK)."""
    return {
        "verdict": "FAIL",
        "conformed": False,
        "problems": [{"check": SEEDED_CHECK}],
        "failed_gates": [SEEDED_CHECK],
        "gate_results": [],
        "gate_totals": {},
    }


def _seed_tree(tmp_path: Path) -> tuple[Path, str]:
    """A plausible snapshot tree: graded work product of a prior cell."""
    seed_tree = tmp_path / "seed-snapshot-tree"
    (seed_tree / "src").mkdir(parents=True)
    seeded_src = "// built by the snapshot's source cell\nexport const seeded = true;\n"
    (seed_tree / "src" / "game.ts").write_text(seeded_src, encoding="utf-8")
    return seed_tree, seeded_src


def _patch_seeded_attempt(
    runner: ChallengeRunner,
    monkeypatch: pytest.MonkeyPatch,
    *,
    exit_code: int,
) -> None:
    """Stub the build-prompt loader and the attempt transport."""
    monkeypatch.setattr(
        runner,
        "_load_chunk_prompts",
        lambda *args, **kwargs: ["BUILD PROMPT THAT MUST NOT BE DELIVERED"],
    )

    def _fake_attempt(**kwargs: Any) -> _OpencodeRunStats:
        return _OpencodeRunStats(
            input_tokens=1,
            output_tokens=1,
            reasoning_tokens=0,
            turns=1,
            session_id="ses_seeded_cell",
            killed_reason=None,
            exit_code=exit_code,
            cost_usd=0.0,
        )

    monkeypatch.setattr(runner, "_run_cell_attempt", _fake_attempt)


# ── READ-SIDE DEFAULT: absent snapshot_depth loads as 1 ─────────────────────


def test_load_snapshot_defaults_depth_to_one(tmp_path: Path) -> None:
    """Existing build snapshots (no depth field) are treated as depth 1."""
    worktree = tmp_path / "wt"
    worktree.mkdir()
    (worktree / "game.ts").write_text("export const x = 1;\n", encoding="utf-8")

    dest = capture_snapshot(
        worktree=worktree,
        snapshot_root=tmp_path / "snapshots",
        snapshot_id="snap-no-depth",
        state_hash="deadbeef",
        state_alg="sha256",
        provenance={},
    )
    assert dest is not None
    # The manifest really omits snapshot_depth (capture wrote no default).
    manifest = json.loads((dest / "snapshot.json").read_text(encoding="utf-8"))
    assert "snapshot_depth" not in manifest

    loaded = load_snapshot("snap-no-depth", tmp_path)
    assert loaded.snapshot_depth == 1


# ── WRITE-SIDE CHAIN: ceiling promotes depth+1 with the join key ────────────


def test_seeded_cell_at_ceiling_promotes_snapshot_with_depth_and_join_key(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    seed_tree, seeded_src = _seed_tree(tmp_path)
    monkeypatch.delenv("BENCH_PROXY_CHECKPOINT", raising=False)
    _patch_fake_real_arm(monkeypatch)

    runner = _make_runner(
        tmp_path,
        mock=None,
        max_attempts=2,
        seed_snapshot_tree=seed_tree,
        seed_snapshot_depth=1,
    )
    _patch_seeded_attempt(runner, monkeypatch, exit_code=0)

    result = _drive(runner, tmp_path, monkeypatch, _fail_gate)

    assert result.termination_reason == "attempt_ceiling_reached"
    dirs = _snapshot_dirs(tmp_path)
    assert len(dirs) == 1, f"expected exactly one promoted snapshot, got {dirs}"
    payload = _read_snapshot(tmp_path)
    assert payload["snapshot_depth"] == 2
    assert (dirs[0] / "tree").is_dir()
    # The run->snapshot join key names the promoted snapshot directory.
    assert result.produced_snapshot_id == dirs[0].name
    # Sanity: the seeded tree content was carried into the promoted tree.
    assert (
        (dirs[0] / "tree" / "src" / "game.ts").read_text(encoding="utf-8")
        == seeded_src
    )


# ── HARNESS ERROR: no checkpoint, no promotion ──────────────────────────────


def test_seeded_cell_harness_error_produces_no_snapshot(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    seed_tree, _seeded_src = _seed_tree(tmp_path)
    monkeypatch.delenv("BENCH_PROXY_CHECKPOINT", raising=False)
    _patch_fake_real_arm(monkeypatch)

    runner = _make_runner(
        tmp_path,
        mock=None,
        max_attempts=2,
        seed_snapshot_tree=seed_tree,
        seed_snapshot_depth=1,
    )
    # Non-zero exit, killed_reason=None: NOT a harness-limit reason, so the
    # feedback phase classifies the cell as harness_error.
    _patch_seeded_attempt(runner, monkeypatch, exit_code=1)

    result = _drive(runner, tmp_path, monkeypatch, _fail_gate)

    assert result.termination_reason == "harness_error"
    assert _snapshot_dirs(tmp_path) == []
    assert result.produced_snapshot_id is None
