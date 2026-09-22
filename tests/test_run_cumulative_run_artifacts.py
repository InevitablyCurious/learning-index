from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

from harness.cumulative.types import PhaseGroup, SessionRecord
from harness.snapshot import (
    SnapshotModelMismatchError,
    SnapshotNotFoundError,
    capture_snapshot,
)

# LI-14: run_cumulative is now a package (scripts/run_cumulative/) fronted by a
# thin scripts/run_cumulative.py entrypoint. Import the PACKAGE: load_snapshot
# lives in run_cumulative.runner and _build_context is re-imported into the
# facade, so the monkeypatch targets below patch the right namespaces.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import run_cumulative  # noqa: E402


def _cell_result() -> Any:
    class _R:
        verdict = "PASS"
        termination_reason = "gates_green"
        attempts_to_green = 1
        conformed = True
        input_tokens = 100
        output_tokens = 50
        turns = 3
        attempt_reports = [
            {
                "attempt": 1,
                "verdict": "PASS",
                "conformed": True,
                "n_problems": 0,
                "failed_gates": [],
                "attempt_cost_usd": 0.0,
            }
        ]
        session_id = "sid-1"
        memory_mode = "off"
        model = "local-llm-proxy/x"
        tool_calls = 5
        test_invocations = 2
        agentic_cycles = 1
        problems_before = 3
        problems_after = 0
        worker_image_fingerprint = None

    return _R()


@pytest.fixture(autouse=True)
def _empty_proxy_runs_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Point the relay-proxy run-log source (OKP_PROXY_RUNS_DIR, read at call
    time inside _read_proxy_served_identity) at an EMPTY temp dir.

    This makes the spend-DB-fallback / NULL-when-meter-empty behaviour
    deterministic on every machine regardless of whether a real proxy log
    exists at DEFAULT_PROXY_RUNS_DIR. Tests that intentionally exercise the
    proxy-log path override this env (their monkeypatch.setenv runs after the
    fixture's).
    """
    empty = tmp_path / "empty-proxy-runs"
    empty.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("OKP_PROXY_RUNS_DIR", str(empty))
    return empty


def _build_runner(module: Any, tmp_path: Path, *, runs_dir: Path | None = None) -> Any:
    runs_dir = runs_dir or (tmp_path / "runs")
    runner = module.RealSessionRunner.__new__(module.RealSessionRunner)
    runner._session_states = {}
    # WO-ERRDATA-C4: run_session accumulates per-cell error counts into
    # _error_totals (normally initialized in __init__, which __new__ skips).
    runner._error_totals = {
        "guard_aborted_turns": 0,
        "finalize_timeout_turns": 0,
        "stalled_turns": 0,
    }
    runner._runs_dir = runs_dir
    runner._task_dir = tmp_path / "task"
    runner._task = "backgammon"
    runner._max_attempts = 1
    runner._proxy_base_url = "http://127.0.0.1:11434/v1"
    runner._proxy_token = "proxy-token-value"
    runner._progress = lambda message: None
    runner._org_id = "org-test"
    runner._repo_root = tmp_path
    runner._run_manifest_base_path = str(runs_dir / "manifest.json")
    runner._run_manifest_written = False
    runner._runner_cls = _FakeRunner
    runner._spend_meter = _FakeSpendMeter()
    # run_identity contract: _state_for_session reads self._run_identity
    # (normally initialized in __init__, which __new__ skips).
    runner._run_identity = "test-run-identity"
    return runner


class _FakeSpendMeter:
    def __init__(self) -> None:
        self.identities: list[Any] = []
        self.raise_on_model_identity = False

    def model_identity(self, session_id: str) -> list[Any]:
        if self.raise_on_model_identity:
            raise RuntimeError("spend db unavailable")
        return self.identities

    def contention_covariates(self, *args: Any, **kwargs: Any) -> Any:
        from harness.contention import ContentionCovariates

        return ContentionCovariates.empty()


class _FakeRunner:
    def __init__(self, **kwargs: Any) -> None:
        self._kwargs = kwargs

    def run_cell(
        self,
        run_label: str,
        run_dir: Path,
        task_id: str = "backgammon",
        run_identity: str | None = None,
    ) -> Any:
        return _cell_result()


def _session(sequence_index: int) -> SessionRecord:
    return SessionRecord(
        sequence_index=sequence_index,
        model="local-llm-proxy/x",
        provider_pin="local",
        memory_mode="off",
        phase_group=PhaseGroup.OFF_BASELINE.value,
        phase="RUN_SESSION",
    )


def _read_manifest(runs_dir: Path) -> dict[str, Any]:
    path = runs_dir / "manifest.run-manifest.json"
    assert path.is_file(), f"run manifest not created at {path}"
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _read_status_records(runs_dir: Path) -> list[dict[str, Any]]:
    path = runs_dir / "manifest.status.jsonl"
    assert path.is_file(), f"status stream not created at {path}"
    records: list[dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line:
                continue
            records.append(json.loads(line))
    return records


def test_run_manifest_and_status_stream_written(tmp_path: Path) -> None:
    module = run_cumulative
    runs_dir = tmp_path / "runs"
    runner = _build_runner(module, tmp_path, runs_dir=runs_dir)
    runner._runner_cls = _FakeRunner

    session = _session(0)
    returned = runner.run_session(session)

    # (d) behaviour unchanged: same result object returned.
    assert returned.verdict == "PASS"

    # (a) run manifest created with correct identity fields.
    manifest = _read_manifest(runs_dir)
    assert manifest["memory_mode"] == "off"
    assert manifest["org_id"] == "org-test"
    assert manifest["requested_model"] == "local-llm-proxy/x"
    assert manifest["served_model"] is None  # fake meter returns []
    assert manifest["run_id"] == runs_dir.name

    # (b) status stream exists with >=1 parseable record, each with required keys.
    records = _read_status_records(runs_dir)
    assert len(records) >= 1
    required_keys = {
        "type",
        "sequence_index",
        "memory_mode",
        "org_id",
        "served_model",
        "verdict",
        "progress",
        "work_input_tokens",
        "work_output_tokens",
        "work_total_tokens",
        "injected_block_est_tokens",
        "injected_count",
        "injected_block_chars",
        "consumer_injected_count",
        "extraction_state",
        "terminal_outcome",
        "session_fp",
        "session_id",
    }
    for record in records:
        assert set(required_keys) <= set(record), f"missing keys in {record}"
        assert record["type"] == "attempt"
        assert record["schema_version"] == 1
        assert record["sequence_index"] == 0
        assert record["memory_mode"] == "off"
        assert record["org_id"] == "org-test"
        assert record["extraction_state"] == "unknown"
        # WO-TRUNC-1: terminal outcome is recorded, never placeholder-null.
        assert record["terminal_outcome"] is True  # verdict PASS
        assert record["terminal_reason"] == "gates_green"
        assert record["length_truncations"] == 0
        assert record["truncated_turns"] == 0
        assert record["truncated_turns_retried"] == 0
        assert record["unmetered_turns"] == 0
        assert record["unmetered_turn_wall_s"] == 0.0
        assert record["work_input_tokens"] == 100
        assert record["work_output_tokens"] == 50
        assert record["work_total_tokens"] == 150

    # (c) last record's progress equals the cell's final progress mapping
    # (computed from the actual returned result, contention populated).
    last = records[-1]
    final_progress = module.progress_from_cell_result(returned).to_dict()
    assert last["progress"] == final_progress


def test_run_manifest_carries_runner_seed(tmp_path: Path) -> None:
    module = run_cumulative
    runs_dir = tmp_path / "runs"
    runner = _build_runner(module, tmp_path, runs_dir=runs_dir)
    runner._runner_cls = _FakeRunner
    runner._seed = 12345

    runner.run_session(_session(0))

    manifest = _read_manifest(runs_dir)
    assert manifest["seed"] == 12345


def test_run_manifest_write_once_and_stream_append_only(tmp_path: Path) -> None:
    module = run_cumulative
    runs_dir = tmp_path / "runs"
    runner = _build_runner(module, tmp_path, runs_dir=runs_dir)
    runner._runner_cls = _FakeRunner

    runner.run_session(_session(0))
    manifest_path = runs_dir / "manifest.run-manifest.json"
    first_content = manifest_path.read_bytes()

    runner.run_session(_session(1))

    # Run manifest written only once, same content, no error.
    assert manifest_path.read_bytes() == first_content
    assert manifest_path.read_bytes().count(b"schema_version") == 1

    # Status stream has records from both sessions, order preserved.
    records = _read_status_records(runs_dir)
    assert len(records) == 2
    assert [r["sequence_index"] for r in records] == [0, 1]


def test_turn_terminal_records_appended_for_truncated_turns(tmp_path: Path) -> None:
    """WO-TRUNC-1: a truncated turn lands in the status stream as turn_terminal."""
    module = run_cumulative
    runs_dir = tmp_path / "runs"

    result = _cell_result()
    result.verdict = "FAIL"
    result.termination_reason = "transport_incomplete"
    result.truncations = 1
    result.truncated_turns = 1
    result.truncated_turns_retried = 1
    result.unmetered_turns = 1
    result.unmetered_turn_wall_s = 60.0
    result.turn_anomalies = [
        {
            "phase": "initial",
            "turn_index": 7,
            "terminal": "truncated_no_signal",
            "reason": "unknown",
            "tool_uses": 0,
            "file_writes": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "reasoning_tokens": 0,
            "cost_usd": 0.0,
            "tokens_unmetered": True,
            "wall_seconds": 60.0,
            "retried": True,
            "retry_kind": "client_auto",
            "session_id": "sid-1",
        }
    ]

    class _TruncRunner:
        def __init__(self, **kwargs: Any) -> None:
            self._kwargs = kwargs

        def run_cell(
            self,
            run_label: str,
            run_dir: Path,
            task_id: str = "backgammon",
            run_identity: str | None = None,
        ) -> Any:
            return result

    runner = _build_runner(module, tmp_path, runs_dir=runs_dir)
    runner._runner_cls = _TruncRunner
    runner.run_session(_session(0))

    records = _read_status_records(runs_dir)
    attempt_records = [r for r in records if r["type"] == "attempt"]
    turn_records = [r for r in records if r["type"] == "turn_terminal"]

    assert len(attempt_records) == 1
    attempt = attempt_records[0]
    assert attempt["terminal_outcome"] is False  # FAIL, not a placeholder null
    assert attempt["terminal_reason"] == "transport_incomplete"
    assert attempt["length_truncations"] == 1
    assert attempt["truncated_turns"] == 1
    assert attempt["truncated_turns_retried"] == 1
    assert attempt["unmetered_turns"] == 1
    assert attempt["unmetered_turn_wall_s"] == 60.0

    assert len(turn_records) == 1
    turn = turn_records[0]
    assert turn["schema_version"] == 1
    assert turn["sequence_index"] == 0
    assert turn["memory_mode"] == "off"
    assert turn["org_id"] == "org-test"
    assert turn["terminal"] == "truncated_no_signal"
    assert turn["reason"] == "unknown"
    assert turn["turn_index"] == 7
    assert turn["phase"] == "initial"
    assert turn["tokens_unmetered"] is True
    assert turn["wall_seconds"] == 60.0
    assert turn["retried"] is True
    assert turn["retry_kind"] == "client_auto"
    assert turn["session_id"] == "sid-1"


def test_scoring_turn_exclusions_reach_the_status_stream(tmp_path: Path) -> None:
    """WO-NUDGE-INF-1: the status stream must carry BOTH scoring-turn subtrahends.

    Scoring turns are `turns - guard_aborted_turns - finalize_timeout_turns`.
    RC-5 makes the manifest plus this status stream the ONLY sources a scorecard
    may read, so a subtrahend that lives solely on a PROGRESS log line makes the
    measurement unreconstructable from the authoritative artifacts. This pins
    both fields into the attempt record.
    """
    module = run_cumulative
    runs_dir = tmp_path / "runs"

    result = _cell_result()
    result.verdict = "FAIL"
    result.termination_reason = "attempt_ceiling_reached"
    result.guard_aborted_turns = 2
    result.finalize_timeout_turns = 3
    # WO-ERRDATA-C4: stalled turns are not a scoring subtrahend, but the
    # attempt record is the only durable source for them — pin the plumbing.
    result.stalled_turns = 1

    class _ExclusionRunner:
        def __init__(self, **kwargs: Any) -> None:
            self._kwargs = kwargs

        def run_cell(
            self,
            run_label: str,
            run_dir: Path,
            task_id: str = "backgammon",
            run_identity: str | None = None,
        ) -> Any:
            return result

    runner = _build_runner(module, tmp_path, runs_dir=runs_dir)
    runner._runner_cls = _ExclusionRunner
    runner.run_session(_session(0))

    attempts = [r for r in _read_status_records(runs_dir) if r["type"] == "attempt"]
    assert len(attempts) == 1
    attempt = attempts[0]

    assert attempt["guard_aborted_turns"] == 2
    assert attempt["finalize_timeout_turns"] == 3
    assert attempt["stalled_turns"] == 1

    # `recovery_nudges` is deliberately absent: it never reaches
    # ChallengeCellResult, so emitting it would write a constant 0 and
    # fabricate the appearance of a measurement.
    assert "recovery_nudges" not in attempt


def test_served_model_capture_and_failure_tolerance(tmp_path: Path) -> None:
    module = run_cumulative
    runs_dir = tmp_path / "runs"

    class _Identity:
        model = "x"
        upstream_model = "served-y"
        calls = 1

    runner = _build_runner(module, tmp_path, runs_dir=runs_dir)
    runner._runner_cls = _FakeRunner
    runner._spend_meter.identities = [_Identity()]
    runner.run_session(_session(0))

    records = _read_status_records(runs_dir)
    served_model = records[0]["served_model"]
    assert served_model["upstream_model"] == "served-y"
    assert served_model["model"] == "local-llm-proxy/x"

    # Failure path: model_identity raises -> served_model None, run succeeds.
    runner2 = _build_runner(module, tmp_path, runs_dir=tmp_path / "runs2")
    runner2._runner_cls = _FakeRunner
    runner2._spend_meter.raise_on_model_identity = True
    result = runner2.run_session(_session(0))
    assert result.verdict == "PASS"
    records2 = _read_status_records(tmp_path / "runs2")
    assert records2[0]["served_model"] is None


def test_local_proxy_log_served_identity_lands_in_manifest_and_status(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """WO-NIGHT2-1d: the relay proxy's API-reported served identity (genuine
    upstreamModel) lands in BOTH the run manifest and the attempt status
    records, while alias-echo rows and non-request rows are rejected. The spend
    DB stays empty here, so the proxy log is the sole source of identity."""
    module = run_cumulative
    runs_dir = tmp_path / "runs"

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    proxy_dir = tmp_path / "proxy-runs"
    proxy_dir.mkdir(parents=True, exist_ok=True)
    log_path = proxy_dir / f"{today}.jsonl"
    rows = [
        # Alias-echo row: upstream == requested -> must be REJECTED.
        {
            "type": "request",
            "ts": f"{today}T00:00:01Z",
            "requestedModel": "auto (Local LLM Proxy - oMLX)",
            "upstreamModel": "auto (Local LLM Proxy - oMLX)",
        },
        # Non-request row: skipped by type.
        {
            "type": "heartbeat",
            "ts": f"{today}T00:00:03Z",
            "requestedModel": "auto (Local LLM Proxy - oMLX)",
        },
        # Genuine row, latest by ts -> selected.
        {
            "type": "request",
            "ts": f"{today}T00:00:05Z",
            "requestedModel": "auto (Local LLM Proxy - oMLX)",
            "upstreamModel": "Vontra--DeepSeek-V4-Flash-0731-MXFP4-MLX",
        },
    ]
    log_path.write_text(
        "\n".join(json.dumps(row) for row in rows) + "\n",
        encoding="utf-8",
    )

    # Override the autouse empty-dir fixture: this test exercises the real
    # proxy-log path.
    monkeypatch.setenv("OKP_PROXY_RUNS_DIR", str(proxy_dir))

    runner = _build_runner(module, tmp_path, runs_dir=runs_dir)
    runner._runner_cls = _FakeRunner
    # Empty spend meter (no identities) so the proxy log is the sole source.
    runner._spend_meter.identities = []
    runner.run_session(_session(0))

    # Manifest carries the genuine served identity (NON-NULL).
    manifest = _read_manifest(runs_dir)
    assert manifest["served_model"] == "Vontra--DeepSeek-V4-Flash-0731-MXFP4-MLX"

    # Status records carry the served-model dict with the genuine upstream.
    records = _read_status_records(runs_dir)
    assert len(records) >= 1
    for record in records:
        assert record["type"] == "attempt"
        assert (
            record["served_model"]["upstream_model"]
            == "Vontra--DeepSeek-V4-Flash-0731-MXFP4-MLX"
        )
        assert record["served_model"]["model"] == "local-llm-proxy/x"

    # Direct reader assertions: genuine identity via the fixture dir, None when
    # the source dir is empty (fallback degrades).
    assert (
        module._read_proxy_served_identity(proxy_dir)
        == "Vontra--DeepSeek-V4-Flash-0731-MXFP4-MLX"
    )
    empty_dir = tmp_path / "empty-proxy-runs"
    empty_dir.mkdir(parents=True, exist_ok=True)
    assert module._read_proxy_served_identity(empty_dir) is None


# ── WO-SNAP-04: DEV-MODE SEED SNAPSHOT WIRING ────────────────────────────────
#
# --seed-snapshot resolves + validates a captured snapshot against the
# session's model and the running corpus, threads the resolved tree/ to the
# adapter, and writes the four honesty fields (seeded_from_snapshot /
# build_phase_ran / skipped_build_cost / dev_mode) onto the session and into
# every attempt status record. A refusal ABORTS — it never falls back to a
# scaffold build.

_SEED_SNAPSHOT_ID = "snap-seed-1"
# Stated constants, precedent: tests/test_snapshot_capture.py (no git shelling
# in tests; _current_git_head is shadowed on the instance).
_SEED_COMMIT = "0123456789abcdef"
_SEED_BUILD_COST = {"total_cost_usd": 0.42, "build_chunks": 6}


def _seed_fixture(
    module: Any,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    author_model: str = "local-llm-proxy/x",
    template_hash: str | None = None,
    source_commit: str | None = None,
    snapshot_id: str = _SEED_SNAPSHOT_ID,
) -> tuple[Any, Path, Path]:
    """Runner + a REAL captured snapshot whose provenance matches the corpus.

    The runs root is a tmp dir via BENCH_RUNS_DIR (the same env-or-repo
    rule the capture side uses). The scaffold is a real tmp dir with a real
    file, so template_hash is a genuine derivation; chunk_plan_hash is derived
    by the same module function over the real prompts dir that the resolver
    uses; source_commit is stated (no git in tests). ``template_hash`` and
    ``source_commit``, when set, OVERRIDE the captured provenance value — the
    drift injection seam. The snapshot itself is produced by the real
    producer, ``capture_snapshot``.

    Returns ``(runner, runs_root, snap_tree)``.
    """
    runs_root = tmp_path / "runs-root"
    monkeypatch.setenv("BENCH_RUNS_DIR", str(runs_root))

    task_dir = tmp_path / "task"
    scaffold = task_dir / "scaffold"
    scaffold.mkdir(parents=True)
    (scaffold / "CONTRACT.md").write_text("scaffold bytes", encoding="utf-8")

    runner = _build_runner(module, tmp_path)
    runner._task_dir = task_dir
    runner._current_git_head = lambda repo_root: _SEED_COMMIT
    runner._seed_snapshot_id = snapshot_id

    repo_root = run_cumulative.REPO_ROOT
    provenance: dict[str, Any] = {
        "chunk_plan_hash": module.compute_task_template_hash(
            repo_root / "task" / "backgammon" / "prompts"
        ),
        "template_hash": (
            module.compute_task_template_hash(scaffold)
            if template_hash is None
            else template_hash
        ),
        "source_commit": _SEED_COMMIT if source_commit is None else source_commit,
        "author_model": author_model,
        "provider": "local-llm-proxy",
        "build_cost": dict(_SEED_BUILD_COST),
    }
    src_tree = tmp_path / "graded-tree"
    src_tree.mkdir()
    (src_tree / "app.ts").write_text("graded code", encoding="utf-8")
    captured = capture_snapshot(
        worktree=src_tree,
        snapshot_root=runs_root / "snapshots",
        snapshot_id=snapshot_id,
        state_hash="state-hash-1",
        state_alg="sha256",
        provenance=provenance,
    )
    assert captured is not None, "capture_snapshot must succeed for the fixture"
    return runner, runs_root, runs_root / "snapshots" / snapshot_id / "tree"


def test_seed_snapshot_flag_parses_on_main_parser() -> None:
    module = run_cumulative
    parser = module._build_arg_parser()
    assert parser.parse_args(["run"]).seed_snapshot is None
    assert (
        parser.parse_args(["--seed-snapshot", "snap-1", "run"]).seed_snapshot
        == "snap-1"
    )
    # Main parser: `state` parses it too (only `run` builds a real runner).
    assert parser.parse_args(["--seed-snapshot", "s", "state"]).seed_snapshot == "s"


def test_resolve_seed_snapshot_bogus_id_raises_not_found(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = run_cumulative
    runs_root = tmp_path / "runs-root"
    runs_root.mkdir()
    monkeypatch.setenv("BENCH_RUNS_DIR", str(runs_root))
    runner = _build_runner(module, tmp_path)
    runner._seed_snapshot_id = "bogus-id"
    with pytest.raises(SnapshotNotFoundError):
        runner._resolve_seed_snapshot(_session(0))


def test_resolve_seed_snapshot_returns_loaded_tree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = run_cumulative
    runner, _runs_root, snap_tree = _seed_fixture(module, tmp_path, monkeypatch)
    snap = runner._resolve_seed_snapshot(_session(0))
    assert snap is not None
    assert snap.snapshot_id == _SEED_SNAPSHOT_ID
    assert snap.tree == snap_tree
    assert (snap.tree / "app.ts").read_text(encoding="utf-8") == "graded code"
    assert snap.build_cost == _SEED_BUILD_COST
    # The load is cached on the runner for subsequent sessions.
    assert runner._seed_snapshot is snap


def test_resolve_seed_snapshot_model_mismatch_refuses(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = run_cumulative
    runner, *_ = _seed_fixture(
        module, tmp_path, monkeypatch, author_model="local-llm-proxy/other"
    )
    with pytest.raises(SnapshotModelMismatchError, match="author_model"):
        runner._resolve_seed_snapshot(_session(0))


def test_resolve_seed_snapshot_corpus_mismatch_proceeds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """D-SNAP-DEVMODE-EXCEPTIONS: corpus drift is reported, never refused."""
    module = run_cumulative
    runner, *_ = _seed_fixture(module, tmp_path, monkeypatch, template_hash="th-wrong")
    snap = runner._resolve_seed_snapshot(_session(0))
    # The seed PROCEEDS: the resolver returns the snapshot, no raise.
    assert snap is not None
    assert snap.snapshot_id == _SEED_SNAPSHOT_ID
    # The drift is reported on the runner: exactly the template_hash entry,
    # carrying the recorded (wrong) value and the genuine running derivation.
    assert runner._seed_snapshot_drift == [
        {
            "field": "template_hash",
            "snapshot": "th-wrong",
            "running": module.compute_task_template_hash(runner._task_dir / "scaffold"),
        }
    ]


def test_resolve_seed_snapshot_caches_load_but_validates_per_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = run_cumulative
    runner, *_ = _seed_fixture(module, tmp_path, monkeypatch)
    first = runner._resolve_seed_snapshot(_session(0))

    def _boom(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("load_snapshot must not run again for this campaign")

    monkeypatch.setattr(run_cumulative.runner, "load_snapshot", _boom)
    second = runner._resolve_seed_snapshot(_session(1))
    assert second is first

    # Validation is NOT cached: a campaign spans models, and a snapshot
    # authored by one model must not seed another model's cell.
    other = _session(2)
    other.model = "local-llm-proxy/different"
    with pytest.raises(SnapshotModelMismatchError):
        runner._resolve_seed_snapshot(other)


def test_run_session_seeded_threads_tree_and_writes_honesty_fields(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = run_cumulative
    runner, _runs_root, snap_tree = _seed_fixture(module, tmp_path, monkeypatch)
    constructed: list[Any] = []

    class _CapturingRunner(_FakeRunner):
        def __init__(self, **kwargs: Any) -> None:
            super().__init__(**kwargs)
            constructed.append(self)

    runner._runner_cls = _CapturingRunner
    session = _session(0)
    runner.run_session(session)

    # The adapter receives the RESOLVED snapshot tree/ directory.
    assert len(constructed) == 1
    assert constructed[0]._kwargs["seed_snapshot_tree"] == snap_tree

    # Honesty fields on the session — the seam the manifest checkpoint carries.
    assert session.seeded_from_snapshot == _SEED_SNAPSHOT_ID
    assert session.build_phase_ran is False
    assert session.skipped_build_cost == _SEED_BUILD_COST
    assert session.dev_mode is True

    # Every attempt status record carries the same four fields.
    records = _read_status_records(tmp_path / "runs")
    assert records
    for record in records:
        assert record["type"] == "attempt"
        assert record["seeded_from_snapshot"] == _SEED_SNAPSHOT_ID
        assert record["build_phase_ran"] is False
        assert record["skipped_build_cost"] == _SEED_BUILD_COST
        assert record["dev_mode"] is True


def test_run_session_seeded_with_drifted_source_commit_proceeds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """D-SNAP-DEVMODE-EXCEPTIONS: a drifted source_commit still seeds.

    The session proceeds — honesty fields written, runner constructed — and
    the drift the resolver reported is threaded to the adapter on
    ``seed_snapshot_drift`` (the seam the notice emission consumes).
    """
    module = run_cumulative
    runner, _runs_root, snap_tree = _seed_fixture(
        module, tmp_path, monkeypatch, source_commit="drifted-commit"
    )
    constructed: list[Any] = []

    class _CapturingRunner(_FakeRunner):
        def __init__(self, **kwargs: Any) -> None:
            super().__init__(**kwargs)
            constructed.append(self)

    runner._runner_cls = _CapturingRunner
    session = _session(0)
    runner.run_session(session)

    # The seed PROCEEDED: honesty fields carry the seeded values.
    assert session.seeded_from_snapshot == _SEED_SNAPSHOT_ID
    assert session.dev_mode is True
    assert session.build_phase_ran is False

    # The adapter received the tree AND the drift, with both values named:
    # the recorded (drifted) commit and the running one (_SEED_COMMIT, the
    # stated git HEAD the fixture shadows _current_git_head with).
    assert len(constructed) == 1
    kwargs = constructed[0]._kwargs
    assert kwargs["seed_snapshot_tree"] == snap_tree
    assert {
        "field": "source_commit",
        "snapshot": "drifted-commit",
        "running": _SEED_COMMIT,
    } in kwargs["seed_snapshot_drift"]


def test_run_session_unseeded_writes_honest_build_phase_ran_true(
    tmp_path: Path,
) -> None:
    """A normal run DOES run the build: build_phase_ran=True, dev_mode=False.

    Also proves the defensive getattr convention: this runner is built via
    __new__ and never had _seed_snapshot_id set at all.
    """
    module = run_cumulative
    runner = _build_runner(module, tmp_path)
    constructed: list[Any] = []

    class _CapturingRunner(_FakeRunner):
        def __init__(self, **kwargs: Any) -> None:
            super().__init__(**kwargs)
            constructed.append(self)

    runner._runner_cls = _CapturingRunner
    session = _session(0)
    runner.run_session(session)

    assert len(constructed) == 1
    assert "seed_snapshot_tree" not in constructed[0]._kwargs

    assert session.seeded_from_snapshot is None
    assert session.build_phase_ran is True
    assert session.skipped_build_cost is None
    assert session.dev_mode is False

    records = _read_status_records(tmp_path / "runs")
    assert records
    for record in records:
        assert record["seeded_from_snapshot"] is None
        assert record["build_phase_ran"] is True
        assert record["skipped_build_cost"] is None
        assert record["dev_mode"] is False


def test_run_session_refusal_aborts_before_runner_construction(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A refused snapshot ABORTS — no cell runner, no scaffold-build fallback."""
    module = run_cumulative
    runs_root = tmp_path / "runs-root"
    runs_root.mkdir()
    monkeypatch.setenv("BENCH_RUNS_DIR", str(runs_root))
    runner = _build_runner(module, tmp_path)
    constructed: list[Any] = []

    class _CapturingRunner(_FakeRunner):
        def __init__(self, **kwargs: Any) -> None:
            super().__init__(**kwargs)
            constructed.append(self)

    runner._runner_cls = _CapturingRunner
    runner._seed_snapshot_id = "bogus-id"
    with pytest.raises(SnapshotNotFoundError):
        runner.run_session(_session(0))
    assert constructed == []


def test_handle_run_refuses_snapshot_error_with_clean_line(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Operator-facing refusal: one clean stderr line, exit 2, no traceback.

    Re-based onto SnapshotModelMismatchError — a STAYING refusal. Corpus
    drift no longer exits 2 (D-SNAP-DEVMODE-EXCEPTIONS demoted it to a
    reported warning); the operator surface for the refusals that remain must
    survive unchanged.
    """
    module = run_cumulative
    monkeypatch.setenv("BENCH_SKIP_CLEANUP", "1")

    class _RefusingSequencer:
        def current_session(self) -> SessionRecord:
            return _session(0)

        def step_until_done(self) -> Any:
            raise SnapshotModelMismatchError(
                "snapshot 'snap-1' carries author_model='other' but this "
                "run's model is 'local-llm-proxy/x'; refusing to seed from "
                "another model's snapshot"
            )

    class _FakeContext:
        sequencer = _RefusingSequencer()

    monkeypatch.setattr(
        module,
        "_build_context",
        lambda args, *, require_runtime: _FakeContext(),
    )
    args = module._build_arg_parser().parse_args(["--seed-snapshot", "snap-1", "run"])
    exit_code = module._handle_run(args)
    assert exit_code == 2
    err = capsys.readouterr().err
    assert (
        "SEED SNAPSHOT REFUSED: snapshot 'snap-1' carries author_model="
        "'other'" in err
    )
    assert "Traceback" not in err
