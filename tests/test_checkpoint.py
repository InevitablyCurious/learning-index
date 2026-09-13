"""Tests for the per-attempt check-point contract (bench.checkpoint).

The contract under test: a check-point binds one attempt's delivered tree to
the moment it was delivered. Each attempt captures into
``<run_dir>/checkpoints/cp-NN/`` and is diffed against the previous
check-point (the first has no diff), so the run's history reads as a chain of
per-attempt unified diffs. Classification must be exact — modified, added,
removed, with no phantom entries for files the capture excludes (AGENTS.md is
stripped from both trees, so it can never surface as "removed").

Capture is instrumentation and must never kill a run: a falsy state hash or a
raising capture degrades to "no check-point" (``None``) with nothing written,
never an exception. And ``index.json`` must round-trip: every recorded path is
run_dir-relative (starts with ``checkpoints/``) and resolves back to what was
written.
"""

import json
from pathlib import Path
from typing import Any

from bench.checkpoint import checkpoint_root, record_checkpoint


def _worktree(root: Path) -> Path:
    """A fake graded worktree: excluded internals + graded code.

    AGENTS.md and .git are present in the LIVE tree on purpose — the capture
    excludes them (SNAPSHOT_EXCLUDED), and the diff must never mention them.
    """
    wt = root / "worktree"
    (wt / "src").mkdir(parents=True)
    (wt / "src" / "game.ts").write_text(
        'throw new Error("not implemented")\n', encoding="utf-8"
    )
    (wt / "src" / "ai.ts").write_text("export const ai = 1\n", encoding="utf-8")
    (wt / "package.json").write_text("{}\n", encoding="utf-8")
    (wt / "AGENTS.md").write_text("# canon\n", encoding="utf-8")
    (wt / ".git").mkdir()
    (wt / ".git" / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    return wt


def _record(
    run_dir: Path,
    worktree: Path,
    attempt: int,
    state_hash: str | None,
    **overrides: Any,
) -> dict | None:
    """record_checkpoint with deterministic defaults (explicit wall_ts)."""
    kwargs: dict[str, Any] = {
        "run_dir": run_dir,
        "worktree": worktree,
        "attempt": attempt,
        "phase": "grade",
        "state_hash": state_hash,
        "run_id": "run-1",
        "wall_ts": 1000 + attempt,
    }
    kwargs.update(overrides)
    return record_checkpoint(**kwargs)


def _index(run_dir: Path) -> dict[str, Any]:
    return json.loads(
        (checkpoint_root(run_dir) / "index.json").read_text(encoding="utf-8")
    )


def test_two_attempts_yield_two_checkpoints_and_one_diff(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    wt = _worktree(tmp_path)

    first = _record(run_dir, wt, 1, "hash-1")
    assert first is not None and first["id"] == "cp-01"
    # The first check-point has no previous entry to diff against: no diff yet.
    assert _index(run_dir)["diffs"] == []

    (wt / "src" / "game.ts").write_text("export const game = 1\n", encoding="utf-8")
    second = _record(run_dir, wt, 2, "hash-2")
    assert second is not None and second["id"] == "cp-02"

    root = checkpoint_root(run_dir)
    assert root == run_dir / "checkpoints"
    assert (root / "cp-01" / "tree").is_dir()
    assert (root / "cp-02" / "tree").is_dir()
    assert (root / "diffs" / "cp-01_to_cp-02" / "combined.diff").is_file()

    index = _index(run_dir)
    assert [cp["id"] for cp in index["checkpoints"]] == ["cp-01", "cp-02"]
    assert len(index["diffs"]) == 1
    assert index["diffs"][0]["id"] == "cp-01_to_cp-02"

    cp_json = json.loads((root / "cp-02" / "cp.json").read_text(encoding="utf-8"))
    assert cp_json["attempt"] == 2


def test_diff_classifies_modified_added_removed_without_phantoms(
    tmp_path: Path,
) -> None:
    run_dir = tmp_path / "run"
    wt = _worktree(tmp_path)
    assert _record(run_dir, wt, 1, "hash-1") is not None

    # One of each: (i) modify content, (ii) add a new file, (iii) delete one.
    (wt / "src" / "game.ts").write_text("export const game = 2\n", encoding="utf-8")
    (wt / "src" / "new.ts").write_text("export const fresh = true\n", encoding="utf-8")
    (wt / "package.json").unlink()
    assert _record(run_dir, wt, 2, "hash-2") is not None

    root = checkpoint_root(run_dir)
    diff = _index(run_dir)["diffs"][0]
    by_path = {f["path"]: f["change"] for f in diff["files"]}
    # Exact equality: each file classified correctly AND no phantom entries.
    assert by_path == {
        "src/game.ts": "modified",
        "src/new.ts": "added",
        "package.json": "removed",
    }
    # AGENTS.md lives in the worktree but is excluded from every captured
    # tree, so it must never surface (e.g. as a phantom "removed" entry).
    assert not any("AGENTS.md" in f["path"] for f in diff["files"])
    combined = (root / "diffs" / diff["id"] / "combined.diff").read_text(
        encoding="utf-8"
    )
    assert "AGENTS.md" not in combined


def test_capture_failure_never_raises_and_writes_nothing(
    tmp_path: Path, monkeypatch
) -> None:
    wt = _worktree(tmp_path)

    # (i) A falsy state hash is an unknown identity: capture_snapshot refuses
    # before anything is written, so even the checkpoints/ dir never exists.
    run_dir = tmp_path / "run-null"
    assert _record(run_dir, wt, 1, None) is None
    assert not checkpoint_root(run_dir).exists()

    # (ii) A raising capture degrades to None — instrumentation never kills a
    # run — and leaves no index behind.
    run_dir = tmp_path / "run-boom"

    def boom(**kwargs: Any) -> None:
        raise RuntimeError("boom")

    monkeypatch.setattr("bench.checkpoint.capture_snapshot", boom)
    assert _record(run_dir, wt, 1, "hash-1") is None  # must NOT raise
    assert not (checkpoint_root(run_dir) / "index.json").exists()
    assert not checkpoint_root(run_dir).exists()


def test_index_json_round_trips(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    wt = _worktree(tmp_path)
    assert _record(run_dir, wt, 1, "hash-1", run_id="run-77") is not None
    (wt / "src" / "game.ts").write_text("export const game = 3\n", encoding="utf-8")
    assert _record(run_dir, wt, 2, "hash-2", run_id="run-77") is not None

    payload = _index(run_dir)
    assert payload["run_id"] == "run-77"

    checkpoints = payload["checkpoints"]
    assert isinstance(checkpoints, list) and len(checkpoints) == 2
    for entry in checkpoints:
        assert isinstance(entry, dict)
        assert set(entry) == {
            "id",
            "attempt",
            "phase",
            "state_hash",
            "wall_ts",
            "tree_path",
        }
    assert [
        (c["id"], c["attempt"], c["state_hash"], c["wall_ts"]) for c in checkpoints
    ] == [
        ("cp-01", 1, "hash-1", 1001),
        ("cp-02", 2, "hash-2", 1002),
    ]
    assert all(c["phase"] == "grade" for c in checkpoints)

    diffs = payload["diffs"]
    assert isinstance(diffs, list) and len(diffs) == 1
    diff = diffs[0]
    assert set(diff) == {"id", "from", "to", "combined", "files"}
    assert (diff["id"], diff["from"], diff["to"]) == (
        "cp-01_to_cp-02",
        "cp-01",
        "cp-02",
    )
    assert isinstance(diff["files"], list) and diff["files"]
    for file_entry in diff["files"]:
        assert set(file_entry) == {"path", "change", "diff"}

    # Every recorded path is run_dir-relative and resolves back to disk.
    for entry in checkpoints:
        assert entry["tree_path"].startswith("checkpoints/")
        assert (run_dir / entry["tree_path"]).is_dir()
    assert diff["combined"].startswith("checkpoints/")
    assert (run_dir / diff["combined"]).is_file()
    for file_entry in diff["files"]:
        assert file_entry["diff"].startswith("checkpoints/")
        assert (run_dir / file_entry["diff"]).is_file()
