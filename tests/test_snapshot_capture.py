"""WO-SNAP-02: automatic attempt-1 snapshot capture at the grade boundary.

The contract under test: when attempt 1 is graded on the normal path, the
runner copies the graded tree beside its gate record — identified by the SAME
state hash the attempt report carries — with producer-stated provenance. A
failed capture writes nothing and emits exactly one live notice; the cell
carries on either way. Snapshots land under $BENCH_RUNS_DIR/snapshots,
which every test here pins to tmp_path so nothing ever touches bench/runs/.
"""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
from typing import Any

import pytest

import harness.adapters.backgammon as backgammon_mod
from harness.adapters.backgammon import BackgammonRunner, _OpencodeRunStats
from harness.adapters.docker_worker import ImageFingerprint
from harness.live_stream import LiveStream
from harness.snapshot import compute_grader_hash

REPO = Path(__file__).resolve().parents[1]
TASK_DIR = (REPO / "task" / "backgammon").resolve()

PASS_REPORT: dict[str, Any] = {
    "verdict": "PASS",
    "conformed": True,
    "gate_results": [],
    "gate_totals": {},
    "failed_gates": [],
}

PROVENANCE_KEYS = (
    "chunk_plan_hash",
    "template_hash",
    "source_commit",
    "grader_hash",
    "worker_image_fingerprint",
    "author_model",
    "provider",
    "memory_mode",
    "run_id",
    "cell_seq",
    "gate_totals",
    "failed_gates",
    "build_chunks",
    "build_cost",
    "cell_void",
)


def _make_runner(
    tmp_path: Path,
    *,
    mock: str | None = "scaffold",
    max_attempts: int = 8,
    **extra: Any,
) -> BackgammonRunner:
    return BackgammonRunner(
        task_dir=TASK_DIR,
        work_root=tmp_path / "work-root",
        model="local-llm-proxy/okp-bench-worker",
        max_attempts=max_attempts,
        mock=mock,
        **extra,
    )


def _drive(
    runner: BackgammonRunner,
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


def test_attempt_one_capture_writes_snapshot(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    runner = _make_runner(tmp_path, mock="scaffold")
    result = _drive(runner, tmp_path, monkeypatch, lambda **kwargs: dict(PASS_REPORT))

    assert result.verdict == "PASS"
    dirs = _snapshot_dirs(tmp_path)
    assert len(dirs) == 1
    snap = dirs[0]
    assert (snap / "tree").is_dir()
    assert (snap / "snapshot.json").is_file()

    payload = _read_snapshot(tmp_path)
    assert payload["state_alg"] == "walk-v1"
    assert payload["state_hash"]
    assert payload["snapshot_id"] == snap.name
    for key in PROVENANCE_KEYS:
        assert key in payload, f"provenance key missing: {key}"
    # Producer-stated values in mock mode: no build ran, so the build facts are
    # honest absences rather than invented numbers.
    assert payload["author_model"] == "local-llm-proxy/okp-bench-worker"
    assert payload["provider"] == "local-llm-proxy"
    assert payload["run_id"] == "lbl"
    assert payload["build_chunks"] == []
    assert payload["build_cost"] == {
        "turns": None,
        "total_tokens": None,
        "wall_seconds": None,
        "wall_cost_usd": None,
    }
    assert payload["cell_void"] is False


def test_state_hash_equals_attempt_one_state_hash(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The acceptance: same tree, same hash, same record.

    The snapshot is identified by the state hash the grader already computed
    for the attempt report — one derivation, two consumers, never two numbers
    that can disagree.
    """
    runner = _make_runner(tmp_path, mock="scaffold")
    result = _drive(runner, tmp_path, monkeypatch, lambda **kwargs: dict(PASS_REPORT))

    payload = _read_snapshot(tmp_path)
    attempt_hash = result.attempt_reports[0]["state_hash"]
    assert attempt_hash is not None
    assert payload["state_hash"] == attempt_hash


def test_capture_excludes_harness_files(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The captured tree is the GRADED code, never the harness's own files.

    AGENTS.md is written into every worktree at seed time. opencode.json is
    written by the permission config in real mode only (mock is None), so the
    stubbed gate writes it here to reproduce the real-mode condition at grade
    time — the exclusion must be by name, not by luck of the mock.
    """
    runner = _make_runner(tmp_path, mock="scaffold")

    def _gate(*, worktree: Path, **kwargs: Any) -> dict[str, Any]:
        (worktree / "opencode.json").write_text("{}\n", encoding="utf-8")
        return dict(PASS_REPORT)

    result = _drive(runner, tmp_path, monkeypatch, _gate)
    assert result.verdict == "PASS"

    tree = _snapshot_dirs(tmp_path)[0] / "tree"
    assert not (tree / "AGENTS.md").exists()
    assert not (tree / "opencode.json").exists()
    # The graded scaffold itself IS captured, structure preserved.
    assert (tree / "package.json").is_file()
    assert (tree / "src").is_dir()


def test_forced_capture_failure_writes_nothing_and_one_notice(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A failed capture degrades to 'no snapshot' + exactly one notice.

    Capture is instrumentation: it never kills a run, never leaves a half-valid
    directory behind, and the absence is reported on the live stream rather
    than silent.
    """
    runner = _make_runner(tmp_path, mock="scaffold")
    runner._live = LiveStream(tmp_path / "live.jsonl", run_id="lbl")
    monkeypatch.setattr(
        "harness.adapters.backgammon.capture_snapshot", lambda **kwargs: None
    )

    result = _drive(runner, tmp_path, monkeypatch, lambda **kwargs: dict(PASS_REPORT))

    # The cell completed despite the failed capture.
    assert result.verdict == "PASS"
    snap_root = tmp_path / "snapshots"
    assert not snap_root.exists() or not list(snap_root.rglob("snapshot.json"))

    rows = [
        json.loads(line)
        for line in (tmp_path / "live.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    notices = [row for row in rows if row.get("kind") == "notice"]
    assert len(notices) == 1
    notice = notices[0]
    assert notice["source"] == "harness"
    assert notice["event"] == "snapshot_capture_failed"
    assert notice["level"] == "warn"
    assert notice["detail"]["attempt"] == 1
    assert notice["detail"]["snapshot_id"]


def test_no_snapshot_beyond_attempt_one(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Attempt 1 is the corpus fact; later attempts are repair, not capture."""
    runner = _make_runner(tmp_path, mock="scaffold", max_attempts=2)
    calls = {"count": 0}

    def _gate(**kwargs: Any) -> dict[str, Any]:
        calls["count"] += 1
        if calls["count"] == 1:
            return {
                "verdict": "FAIL",
                "conformed": True,
                "problems": [{"check": "x"}],
                "failed_gates": ["x"],
                "gate_results": [],
                "gate_totals": {},
            }
        return dict(PASS_REPORT)

    result = _drive(runner, tmp_path, monkeypatch, _gate)

    assert result.verdict == "PASS"
    assert len(result.attempt_reports) == 2
    assert len(_snapshot_dirs(tmp_path)) == 1


def test_corpus_hashes_flow_into_snapshot(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Producer-stated corpus identity reaches snapshot.json verbatim.

    The campaign producer (scripts/run_cumulative.py) computes
    chunk_plan_hash / template_hash / source_commit and threads them into
    the runner at construction; the snapshot records exactly what the
    producer stated — the consumer never re-derives or rewrites it.
    """
    runner = _make_runner(
        tmp_path,
        mock="scaffold",
        chunk_plan_hash="cph-test",
        template_hash="th-test",
        source_commit="0123456789abcdef",
    )
    result = _drive(runner, tmp_path, monkeypatch, lambda **kwargs: dict(PASS_REPORT))
    assert result.verdict == "PASS"

    payload = _read_snapshot(tmp_path)
    assert payload["chunk_plan_hash"] == "cph-test"
    assert payload["template_hash"] == "th-test"
    assert payload["source_commit"] == "0123456789abcdef"


def test_capture_writes_grade_report_and_grader_hash(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The grade travels with the tree, keyed by the grader's identity.

    Capture writes the full attempt-1 grade as grade-report.json beside
    snapshot.json, and snapshot.json carries the grader_hash of the gates dir
    that produced it — the two inputs the dev-mode grade cache reads back.
    """
    runner = _make_runner(tmp_path, mock="scaffold")
    result = _drive(runner, tmp_path, monkeypatch, lambda **kwargs: dict(PASS_REPORT))
    assert result.verdict == "PASS"

    snap = _snapshot_dirs(tmp_path)[0]
    grade_path = snap / "grade-report.json"
    assert grade_path.is_file()
    grade = json.loads(grade_path.read_text(encoding="utf-8"))
    assert grade["verdict"] == PASS_REPORT["verdict"]
    assert grade["gate_totals"] == PASS_REPORT["gate_totals"]

    payload = _read_snapshot(tmp_path)
    # The SAME grader dir the grader runs against (repo-root grader/), hashed by
    # the same function — one derivation, never two numbers that disagree.
    assert payload["grader_hash"] == compute_grader_hash(REPO / "grader")


# ── WO-SNAP-04: THE SEED BRANCH ─────────────────────────────────────────────
#
# A seeded cell starts from a captured snapshot tree instead of the scaffold,
# so the chunked build must NOT run, no attempt-1 snapshot may be captured
# (a snapshot-of-a-snapshot is a degenerate corpus row), and the first
# troubleshooting round must still be reached — which only happens when the
# seed branch binds `session_id` to the cell's serve session, because the
# pre-feedback guard aborts with harness_error when it is None.

# A real graded gate check (the single-system feedback contract hard-fails on
# synthetic labels, so loop mechanics must drive the cell with genuine ids —
# same precedent as tests/test_backgammon_budget_stop.py).
SEEDED_CHECK = "[G02] REQ-PIP — pip count"


def _patch_fake_real_arm(monkeypatch: pytest.MonkeyPatch) -> None:
    """Hermetic real-arm (mock=None) stubs, mirroring test_backgammon_budget_stop.

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

    monkeypatch.setattr(backgammon_mod, "DockerCellConfig", _FakeDockerCellConfig)
    monkeypatch.setattr(backgammon_mod, "DockerCell", _FakeDockerCell)
    monkeypatch.setattr(backgammon_mod, "docker_available", lambda: (True, "ok"))
    monkeypatch.setattr(
        backgammon_mod,
        "worker_image_fingerprint",
        lambda: ImageFingerprint(
            image_id="sha256:fake-seeded-test-worker",
            created="2026-09-04T00:00:00Z",
        ),
    )

    real_run = backgammon_mod.subprocess.run

    def _run(*args: Any, **kwargs: Any) -> subprocess.CompletedProcess[str]:
        cmd = args[0] if args else kwargs.get("args")
        if isinstance(cmd, list) and cmd and cmd[0] == "docker":
            return subprocess.CompletedProcess(
                cmd, 1, stdout="", stderr="No such container"
            )
        return real_run(*args, **kwargs)

    monkeypatch.setattr(backgammon_mod.subprocess, "run", _run)

    class _FakeServeClient:
        def __init__(self, base_url: str, **kwargs: Any) -> None:
            self.base_url = base_url

        def create_session(self, title: str | None = None) -> str:
            return "ses_seeded_cell"

    monkeypatch.setattr(backgammon_mod, "ServeClient", _FakeServeClient)


def test_seeded_cell_skips_build_and_reaches_first_feedback_round(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The seed branch buys zero build chunks and goes straight to repair."""
    # A plausible snapshot tree: the graded work product of a prior cell
    # (.git-free, AGENTS.md-free by snapshot construction).
    seed_tree = tmp_path / "seed-snapshot-tree"
    (seed_tree / "src").mkdir(parents=True)
    (seed_tree / "package.json").write_text(
        '{"name": "seeded"}\n', encoding="utf-8"
    )
    seeded_src = "// built by the snapshot's source cell\nexport const seeded = true;\n"
    (seed_tree / "src" / "game.ts").write_text(seeded_src, encoding="utf-8")

    monkeypatch.delenv("BENCH_PROXY_CHECKPOINT", raising=False)
    _patch_fake_real_arm(monkeypatch)

    runner = _make_runner(
        tmp_path,
        mock=None,
        max_attempts=3,
        seed_snapshot_tree=seed_tree,
    )
    monkeypatch.setattr(
        runner,
        "_load_chunk_prompts",
        lambda *args, **kwargs: ["BUILD PROMPT THAT MUST NOT BE DELIVERED"],
    )

    gate_calls = {"count": 0}

    def _fake_gate(**kwargs: Any) -> dict[str, Any]:
        gate_calls["count"] += 1
        if gate_calls["count"] == 1:
            # FAILING report so the loop proceeds to the feedback drive.
            return {
                "verdict": "FAIL",
                "conformed": True,
                "problems": [{"check": SEEDED_CHECK}],
                "failed_gates": [SEEDED_CHECK],
                "gate_results": [],
                "gate_totals": {},
            }
        return dict(PASS_REPORT)

    chunked_calls: list[dict[str, Any]] = []

    def _fake_chunked(**kwargs: Any) -> _OpencodeRunStats:
        chunked_calls.append(kwargs)
        raise AssertionError("a seeded cell must never drive the chunked build")

    monkeypatch.setattr(runner, "_run_opencode_serve_chunked", _fake_chunked)

    attempt_calls: list[dict[str, Any]] = []

    def _fake_attempt(**kwargs: Any) -> _OpencodeRunStats:
        attempt_calls.append(
            {"phase": kwargs.get("phase"), "prompt": kwargs.get("stdin_text")}
        )
        return _OpencodeRunStats(
            input_tokens=1,
            output_tokens=1,
            reasoning_tokens=0,
            turns=1,
            session_id="ses_seeded_cell",
            killed_reason=None,
            exit_code=0,
            cost_usd=0.0,
        )

    monkeypatch.setattr(runner, "_run_cell_attempt", _fake_attempt)

    result = _drive(runner, tmp_path, monkeypatch, _fake_gate)

    # THE BUILD WAS SKIPPED: zero chunked-build calls, zero build-chunk rows.
    assert chunked_calls == []
    assert result.build_chunks is None
    # THE FIRST TROUBLESHOOTING ROUND WAS REACHED (proves the seed branch
    # bound session_id to the cell serve session; without it the
    # pre-feedback guard aborts with harness_error before any feedback).
    assert [entry["phase"] for entry in attempt_calls] == ["feedback-1"]
    assert result.verdict == "PASS"
    assert result.session_id == "ses_seeded_cell"
    # F3: no snapshot-of-a-snapshot was captured at attempt 1.
    assert _snapshot_dirs(tmp_path) == []
    # The worktree really was seeded from the snapshot tree, not the scaffold.
    assert (
        Path(result.worktree) / "src" / "game.ts"
    ).read_text(encoding="utf-8") == seeded_src


# ── WO-SNAP-04B: DRIFTED SEED PROVENANCE WARNS, NEVER REFUSES ───────────────
#
# D-SNAP-DEVMODE-EXCEPTIONS demotes seed-time corpus-provenance drift to a
# warning: the resolver reports it, run_cumulative.py threads it into the
# runner as `seed_snapshot_drift`, and the adapter emits ONE
# `snapshot_validity_relaxed` notice per drifted field at the top of the
# cell's live stream. The cell proceeds on the running corpus — the seed
# branch still skips the build and still reaches troubleshooting.


def test_seeded_cell_with_drifted_source_commit_emits_notice_and_skips_build(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """One drift entry → exactly one warn notice; the build stays skipped."""
    seed_tree = tmp_path / "seed-snapshot-tree"
    (seed_tree / "src").mkdir(parents=True)
    (seed_tree / "package.json").write_text('{"name": "seeded"}\n', encoding="utf-8")
    (seed_tree / "src" / "game.ts").write_text(
        "export const seeded = true;\n", encoding="utf-8"
    )

    monkeypatch.delenv("BENCH_PROXY_CHECKPOINT", raising=False)
    _patch_fake_real_arm(monkeypatch)

    runner = _make_runner(
        tmp_path,
        mock=None,
        max_attempts=3,
        seed_snapshot_tree=seed_tree,
        seed_snapshot_drift=[
            {
                "field": "source_commit",
                "snapshot": "ad115a8",
                "running": "e5838e1",
            }
        ],
    )
    monkeypatch.setattr(
        runner,
        "_load_chunk_prompts",
        lambda *args, **kwargs: ["BUILD PROMPT THAT MUST NOT BE DELIVERED"],
    )

    gate_calls = {"count": 0}

    def _fake_gate(**kwargs: Any) -> dict[str, Any]:
        gate_calls["count"] += 1
        if gate_calls["count"] == 1:
            # FAILING report so the loop proceeds to the feedback drive.
            return {
                "verdict": "FAIL",
                "conformed": True,
                "problems": [{"check": SEEDED_CHECK}],
                "failed_gates": [SEEDED_CHECK],
                "gate_results": [],
                "gate_totals": {},
            }
        return dict(PASS_REPORT)

    chunked_calls: list[dict[str, Any]] = []

    def _fake_chunked(**kwargs: Any) -> _OpencodeRunStats:
        chunked_calls.append(kwargs)
        raise AssertionError("a seeded cell must never drive the chunked build")

    monkeypatch.setattr(runner, "_run_opencode_serve_chunked", _fake_chunked)

    attempt_calls: list[dict[str, Any]] = []

    def _fake_attempt(**kwargs: Any) -> _OpencodeRunStats:
        attempt_calls.append({"phase": kwargs.get("phase")})
        return _OpencodeRunStats(
            input_tokens=1,
            output_tokens=1,
            reasoning_tokens=0,
            turns=1,
            session_id="ses_seeded_cell",
            killed_reason=None,
            exit_code=0,
            cost_usd=0.0,
        )

    monkeypatch.setattr(runner, "_run_cell_attempt", _fake_attempt)

    # Driven through `run_cell` — the production entry point and the ONLY
    # place the live stream opens (`self._live = LiveStream.for_run(run_dir)`)
    # and the drift notice is emitted. `_drive` enters via `_run_cell_impl`
    # and bypasses both, so no stream would ever carry the notice. Same env
    # pin and gate stub `_drive` applies.
    run_dir = tmp_path / "rundir"
    monkeypatch.setenv("BENCH_RUNS_DIR", str(tmp_path))
    monkeypatch.setattr(runner, "_run_gate_report", _fake_gate)
    result = runner.run_cell("lbl", run_dir, task_id="backgammon")

    # The seed branch is untouched by the drift: zero chunked-build calls,
    # zero build-chunk rows, straight to the first troubleshooting round.
    assert chunked_calls == []
    assert result.build_chunks is None
    assert [entry["phase"] for entry in attempt_calls] == ["feedback-1"]
    assert result.verdict == "PASS"

    # Exactly one relaxed-validity notice on the cell's live stream, carrying
    # the structured drift fact (field + both values), never prose.
    rows = [
        json.loads(line)
        for line in (run_dir / "live.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    relaxed = [
        row
        for row in rows
        if row.get("kind") == "notice"
        and row.get("event") == "snapshot_validity_relaxed"
    ]
    assert len(relaxed) == 1
    notice = relaxed[0]
    assert notice["source"] == "harness"
    assert notice["level"] == "warn"
    assert notice["detail"] == {
        "field": "source_commit",
        "snapshot": "ad115a8",
        "running": "e5838e1",
    }


# ── DEV-MODE GRADE CACHE: A SEEDED ATTEMPT 1 REUSES A BYTE-IDENTICAL GRADE ──
#
# Capture now stores the full attempt-1 grade (grade-report.json) beside the
# tree, keyed by the grader_hash in snapshot.json. A seeded cell whose stored
# grader_hash matches the running gates dir skips _run_gate_report at attempt
# 1 and consumes the cached dict exactly like a fresh one — same parse, same
# feedback round, same live emits — plus ONE `grade_cache_hit` notice. Any
# miss is silent and grades for real (the old behavior). This is dev-mode
# tooling, not certification: reuse requires a byte-identical grader.

# The cached grade: FAIL on a real gate id so the single-system feedback
# contract accepts it and the loop proceeds to the troubleshooting round.
CACHED_FAIL_REPORT: dict[str, Any] = {
    "verdict": "FAIL",
    "conformed": True,
    "problems": [{"check": SEEDED_CHECK}],
    "failed_gates": [SEEDED_CHECK],
    "gate_results": [],
    "gate_totals": {},
}


def _write_seed_snapshot(
    tmp_path: Path,
    *,
    grader_hash: str | None,
    grade: dict[str, Any] | None,
) -> Path:
    """Build a capture-shaped snapshot dir: tree/ + snapshot.json [+ grade]."""
    snap_dir = tmp_path / "seed-snapshot"
    tree = snap_dir / "tree"
    (tree / "src").mkdir(parents=True)
    (tree / "package.json").write_text('{"name": "seeded"}\n', encoding="utf-8")
    (tree / "src" / "game.ts").write_text(
        "// built by the snapshot's source cell\nexport const seeded = true;\n",
        encoding="utf-8",
    )
    manifest: dict[str, Any] = {"snapshot_id": snap_dir.name}
    if grader_hash is not None:
        manifest["grader_hash"] = grader_hash
    (snap_dir / "snapshot.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    if grade is not None:
        (snap_dir / "grade-report.json").write_text(
            json.dumps(grade, indent=2) + "\n", encoding="utf-8"
        )
    return snap_dir


def _make_seeded_cache_runner(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    snap_dir: Path,
    *,
    max_attempts: int = 3,
) -> tuple[BackgammonRunner, list[str], list[dict[str, Any]]]:
    """Hermetic seeded real-arm runner; returns (runner, graded paths, phases).

    The gate stub records the report_path name of every real grade and passes
    from its first call on; the drive stubs record every feedback phase.
    """
    monkeypatch.delenv("BENCH_PROXY_CHECKPOINT", raising=False)
    _patch_fake_real_arm(monkeypatch)

    runner = _make_runner(
        tmp_path,
        mock=None,
        max_attempts=max_attempts,
        seed_snapshot_tree=snap_dir / "tree",
    )
    runner._live = LiveStream(tmp_path / "live.jsonl", run_id="lbl")
    monkeypatch.setattr(
        runner,
        "_load_chunk_prompts",
        lambda *args, **kwargs: ["BUILD PROMPT THAT MUST NOT BE DELIVERED"],
    )

    def _fake_chunked(**kwargs: Any) -> _OpencodeRunStats:
        raise AssertionError("a seeded cell must never drive the chunked build")

    monkeypatch.setattr(runner, "_run_opencode_serve_chunked", _fake_chunked)

    attempt_calls: list[dict[str, Any]] = []

    def _fake_attempt(**kwargs: Any) -> _OpencodeRunStats:
        attempt_calls.append({"phase": kwargs.get("phase")})
        return _OpencodeRunStats(
            input_tokens=1,
            output_tokens=1,
            reasoning_tokens=0,
            turns=1,
            session_id="ses_seeded_cell",
            killed_reason=None,
            exit_code=0,
            cost_usd=0.0,
        )

    monkeypatch.setattr(runner, "_run_cell_attempt", _fake_attempt)
    return runner, [], attempt_calls


def _graded_paths_gate(graded_paths: list[str], first: dict[str, Any]) -> Any:
    """Gate stub: records each real grade's report path, returns ``first``."""

    def _gate(**kwargs: Any) -> dict[str, Any]:
        graded_paths.append(Path(kwargs["report_path"]).name)
        return first

    return _gate


def _hit_notices(tmp_path: Path) -> list[dict[str, Any]]:
    rows = [
        json.loads(line)
        for line in (tmp_path / "live.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    return [
        row
        for row in rows
        if row.get("kind") == "notice" and row.get("event") == "grade_cache_hit"
    ]


def test_seeded_cache_hit_skips_the_attempt_one_grade(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Byte-identical grader → the stored grade IS the attempt-1 grade.

    _run_gate_report never runs for attempt 1; the cached FAIL dict flows
    through the loop's existing parse unchanged (feedback-1 is still built,
    attempt 2 grades for real), and exactly one grade_cache_hit notice lands.
    """
    snap_dir = _write_seed_snapshot(
        tmp_path, grader_hash="test-grader-hash", grade=dict(CACHED_FAIL_REPORT)
    )
    monkeypatch.setattr(
        backgammon_mod, "compute_grader_hash", lambda gates: "test-grader-hash"
    )
    runner, graded_paths, attempt_calls = _make_seeded_cache_runner(
        monkeypatch, tmp_path, snap_dir
    )

    result = _drive(
        runner,
        tmp_path,
        monkeypatch,
        _graded_paths_gate(graded_paths, dict(PASS_REPORT)),
    )

    # THE CACHED GRADE SERVED ATTEMPT 1: the gate runner was never asked for
    # attempt-1-report.json; only attempt 2 (post-feedback) graded for real.
    assert graded_paths == ["attempt-2-report.json"]
    # The cached FAIL drove the loop exactly like a fresh one: the first
    # troubleshooting round was built and delivered off the cached dict.
    assert [entry["phase"] for entry in attempt_calls] == ["feedback-1"]
    assert result.verdict == "PASS"

    hits = _hit_notices(tmp_path)
    assert len(hits) == 1
    notice = hits[0]
    assert notice["source"] == "harness"
    assert notice["level"] == "info"
    assert notice["detail"] == {
        "snapshot_id": snap_dir.name,
        "grader_hash_matched": True,
    }


def test_seeded_cache_miss_grades_for_real_and_stays_silent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A mismatched grader_hash is a miss: attempt 1 grades, no hit notice.

    The stored grade was produced by DIFFERENT gate code, so it says nothing
    about this run — the cell falls back to the old behavior (re-grade) and
    the cache announces nothing, because nothing happened.
    """
    snap_dir = _write_seed_snapshot(
        tmp_path, grader_hash="stale-grader-hash", grade=dict(CACHED_FAIL_REPORT)
    )
    monkeypatch.setattr(
        backgammon_mod, "compute_grader_hash", lambda gates: "test-grader-hash"
    )
    runner, graded_paths, attempt_calls = _make_seeded_cache_runner(
        monkeypatch, tmp_path, snap_dir
    )

    gate_calls = {"count": 0}

    def _gate(**kwargs: Any) -> dict[str, Any]:
        graded_paths.append(Path(kwargs["report_path"]).name)
        gate_calls["count"] += 1
        if gate_calls["count"] == 1:
            # FAILING report so the loop proceeds to the feedback drive.
            return {
                "verdict": "FAIL",
                "conformed": True,
                "problems": [{"check": SEEDED_CHECK}],
                "failed_gates": [SEEDED_CHECK],
                "gate_results": [],
                "gate_totals": {},
            }
        return dict(PASS_REPORT)

    result = _drive(runner, tmp_path, monkeypatch, _gate)

    # THE OLD BEHAVIOR, UNTOUCHED: the gate runner graded attempt 1 itself.
    assert graded_paths == ["attempt-1-report.json", "attempt-2-report.json"]
    assert [entry["phase"] for entry in attempt_calls] == ["feedback-1"]
    assert result.verdict == "PASS"
    # A miss is silent: no grade_cache_hit notice on the live stream.
    assert _hit_notices(tmp_path) == []
