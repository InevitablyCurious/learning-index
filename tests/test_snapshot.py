"""Tests for the snapshot capture + seed-loading contract (bench.snapshot).

The contract under test: a snapshot binds graded outcomes to the exact code
state they ran against. That binding is only trustworthy if the capture
excludes exactly the non-graded internals, refuses an unknown identity,
introduces nothing of its own (no synthesized .gitignore — walk_manifest
refuses a worktree carrying one), and degrades to "no snapshot" rather than
raising or leaving half-valid state behind.

The read side is the mirror image: loading never degrades silently. An
absent or unreadable snapshot raises its own SnapshotError subclass, and
seeding refuses — with a field-naming message — any snapshot whose author
model or corpus provenance differs from the running one, treating absence
on either side as a mismatch.
"""

import json
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

from bench.outcomes.predicate_emitter import walk_manifest
from bench.snapshot import (
    SNAPSHOT_EXCLUDED,
    LoadedSnapshot,
    SnapshotModelMismatchError,
    SnapshotNotFoundError,
    SnapshotUnreadableError,
    capture_snapshot,
    compute_grader_hash,
    load_snapshot,
    validate_snapshot_for_seed,
)

STATE_ALG = "walk-v1"


def _make_worktree(root: Path) -> Path:
    """A graded-worktree fixture: excluded internals + graded code."""
    wt = root / "worktree"
    (wt / ".git").mkdir(parents=True)
    (wt / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
    (wt / ".okp").mkdir()
    (wt / ".okp" / "keys.json").write_text("{}\n")
    (wt / "AGENTS.md").write_text("# canon\n")
    (wt / "opencode.json").write_text("{}\n")
    (wt / "test-results").mkdir()
    (wt / "test-results" / "out.txt").write_text("debris\n")
    (wt / "test").mkdir()
    (wt / "test" / "a.cjs").write_text("module.exports.a = 1\n")
    (wt / "test" / "b.cjs").write_text("module.exports.b = 2\n")
    (wt / "src").mkdir()
    (wt / "src" / "index.js").write_text("export const x = 1\n")
    return wt


def _capture(
    wt: Path, snapshot_root: Path, snapshot_id: str = "snap-1", **overrides: Any
) -> Path | None:
    kwargs: dict[str, Any] = {
        "worktree": wt,
        "snapshot_root": snapshot_root,
        "snapshot_id": snapshot_id,
        "state_hash": "abc123",
        "state_alg": STATE_ALG,
        "provenance": {},
    }
    kwargs.update(overrides)
    return capture_snapshot(**kwargs)


def test_exclusion_list_exact(tmp_path):
    assert SNAPSHOT_EXCLUDED == frozenset(
        {".git", ".okp", "AGENTS.md", "opencode.json", "test-results"}
    )
    wt = _make_worktree(tmp_path)
    dest = _capture(wt, tmp_path / "snapshots")
    assert dest == tmp_path / "snapshots" / "snap-1"
    tree = dest / "tree"
    # Everything not excluded is copied recursively, structure preserved.
    assert {p.name for p in tree.iterdir()} == {"test", "src"}
    assert (tree / "test" / "a.cjs").read_text() == "module.exports.a = 1\n"
    assert (tree / "test" / "b.cjs").read_text() == "module.exports.b = 2\n"
    assert (tree / "src" / "index.js").read_text() == "export const x = 1\n"
    # Excluded by top-level name: never present under tree/.
    for name in sorted(SNAPSHOT_EXCLUDED):
        assert not (tree / name).exists()


def test_snapshot_json_fields(tmp_path):
    wt = _make_worktree(tmp_path)
    provenance = {"run_id": "run-42", "attempt": 2, "cell": "on"}
    dest = _capture(
        wt,
        tmp_path / "snapshots",
        "snap-2",
        state_hash="deadbeef",
        provenance=provenance,
    )
    payload = json.loads((dest / "snapshot.json").read_text())
    # Exactly the four identity fields, then provenance in the caller's order.
    assert list(payload) == [
        "snapshot_id",
        "state_hash",
        "state_alg",
        "created_at",
        "run_id",
        "attempt",
        "cell",
    ]
    assert payload["snapshot_id"] == "snap-2"
    assert payload["state_hash"] == "deadbeef"
    assert payload["state_alg"] == STATE_ALG
    assert isinstance(payload["created_at"], str) and payload["created_at"]
    datetime.fromisoformat(payload["created_at"])  # ISO-8601, parses
    for key, value in provenance.items():
        assert payload[key] == value


def test_forced_failure_writes_nothing_and_never_raises(tmp_path):
    wt = _make_worktree(tmp_path)
    root = tmp_path / "snapshots"

    # A null hash is an unknown identity: refused before anything is written.
    for bad_hash in (None, ""):
        assert _capture(wt, root, "snap-null", state_hash=bad_hash) is None
    assert not root.exists()

    # An unwritable destination (snapshot_root's parent is a regular file)
    # degrades to None — no raise, no snapshot.json at the destination.
    blocker = tmp_path / "blocker"
    blocker.write_text("i am a file\n")
    dest = _capture(wt, blocker / "snapshots", "snap-bad")
    assert dest is None
    assert not (blocker / "snapshots" / "snap-bad" / "snapshot.json").exists()
    assert blocker.read_text() == "i am a file\n"


def test_capture_does_not_introduce_gitignore(tmp_path):
    wt = _make_worktree(tmp_path)
    assert not list(wt.rglob(".gitignore"))  # clean worktree going in
    dest = _capture(wt, tmp_path / "snapshots", "snap-3")
    tree = dest / "tree"
    assert not list(tree.rglob(".gitignore"))  # nothing synthesized coming out
    # walk_manifest refuses a worktree carrying a .gitignore; hashing the
    # captured tree proves the snapshot is itself a valid walk-v1 worktree.
    files, manifest_hash = walk_manifest(tree)
    assert files
    assert isinstance(manifest_hash, str) and manifest_hash


def test_missing_worktree_returns_none(tmp_path):
    root = tmp_path / "snapshots"
    dest = _capture(tmp_path / "no-such-worktree", root, "snap-4")
    assert dest is None
    assert not root.exists()  # nothing written, not even the root


SEED_PROVENANCE: dict[str, Any] = {
    "chunk_plan_hash": "cph-1",
    "template_hash": "th-1",
    "source_commit": "commit-1",
    "author_model": "m",
    "provider": "m",
    "build_cost": {"turns": 2, "total_tokens": 99},
}


def _seed(tmp_path: Path, snapshot_id: str = "snap-seed") -> LoadedSnapshot:
    """Capture a real snapshot under ``tmp_path`` and load it back."""
    wt = _make_worktree(tmp_path)
    dest = _capture(
        wt,
        tmp_path / "snapshots",
        snapshot_id,
        provenance=dict(SEED_PROVENANCE),
    )
    assert dest is not None
    return load_snapshot(snapshot_id, tmp_path)


def test_load_snapshot_round_trip(tmp_path):
    loaded = _seed(tmp_path, "snap-load")
    assert isinstance(loaded, LoadedSnapshot)
    assert loaded.snapshot_id == "snap-load"
    assert loaded.tree == tmp_path / "snapshots" / "snap-load" / "tree"
    assert loaded.tree.is_dir()
    assert (loaded.tree / "src" / "index.js").read_text() == "export const x = 1\n"
    assert loaded.state_hash == "abc123"  # _capture's default
    assert loaded.state_alg == STATE_ALG
    assert loaded.author_model == "m"
    assert loaded.provider == "m"
    assert loaded.build_cost == {"turns": 2, "total_tokens": 99}
    assert loaded.chunk_plan_hash == "cph-1"
    assert loaded.template_hash == "th-1"
    assert loaded.source_commit == "commit-1"


def test_load_snapshot_absent_raises_not_found(tmp_path):
    with pytest.raises(SnapshotNotFoundError, match="nonexistent"):
        load_snapshot("nonexistent", tmp_path)


def test_load_snapshot_missing_tree_raises_not_found(tmp_path):
    snap_dir = tmp_path / "snapshots" / "snap-no-tree"
    snap_dir.mkdir(parents=True)
    (snap_dir / "snapshot.json").write_text(
        json.dumps({"snapshot_id": "snap-no-tree"}), encoding="utf-8"
    )
    with pytest.raises(SnapshotNotFoundError, match="snap-no-tree"):
        load_snapshot("snap-no-tree", tmp_path)


def test_load_snapshot_missing_manifest_raises_unreadable(tmp_path):
    (tmp_path / "snapshots" / "snap-no-json" / "tree").mkdir(parents=True)
    with pytest.raises(SnapshotUnreadableError, match="snap-no-json"):
        load_snapshot("snap-no-json", tmp_path)


def test_load_snapshot_invalid_json_raises_unreadable(tmp_path):
    snap_dir = tmp_path / "snapshots" / "snap-bad-json"
    (snap_dir / "tree").mkdir(parents=True)
    (snap_dir / "snapshot.json").write_text("{not json", encoding="utf-8")
    with pytest.raises(SnapshotUnreadableError, match="snap-bad-json"):
        load_snapshot("snap-bad-json", tmp_path)


def test_load_snapshot_absent_manifest_keys_are_none(tmp_path):
    wt = _make_worktree(tmp_path)
    dest = _capture(wt, tmp_path / "snapshots", "snap-bare")  # provenance={}
    assert dest is not None
    loaded = load_snapshot("snap-bare", tmp_path)
    for field in (
        "chunk_plan_hash",
        "template_hash",
        "source_commit",
        "author_model",
        "provider",
        "build_cost",
    ):
        assert getattr(loaded, field) is None


def test_validate_snapshot_for_seed_happy(tmp_path):
    loaded = _seed(tmp_path)
    # No drift: the running corpus matches field by field, so the report is
    # the empty list (the function no longer returns None).
    assert (
        validate_snapshot_for_seed(
            loaded,
            model="m",
            chunk_plan_hash="cph-1",
            template_hash="th-1",
            source_commit="commit-1",
        )
        == []
    )


def test_validate_snapshot_model_mismatch(tmp_path):
    loaded = _seed(tmp_path)
    with pytest.raises(SnapshotModelMismatchError) as excinfo:
        validate_snapshot_for_seed(
            loaded,
            model="wrong",
            chunk_plan_hash="cph-1",
            template_hash="th-1",
            source_commit="commit-1",
        )
    message = str(excinfo.value)
    assert "'m'" in message and "'wrong'" in message  # both models named


def test_validate_snapshot_corpus_mismatch_names_fields(tmp_path):
    loaded = _seed(tmp_path)
    # Demoted (D-SNAP-DEVMODE-EXCEPTIONS): drift is RETURNED, never raised.
    drift = validate_snapshot_for_seed(
        loaded,
        model="m",
        chunk_plan_hash="x",
        template_hash="y",
        source_commit="z",
    )
    assert len(drift) == 3  # every differing field is reported
    # Each descriptor names its field and carries both values.
    assert {"field": "chunk_plan_hash", "snapshot": "cph-1", "running": "x"} in drift
    assert {"field": "template_hash", "snapshot": "th-1", "running": "y"} in drift
    assert {"field": "source_commit", "snapshot": "commit-1", "running": "z"} in drift


def test_validate_snapshot_absence_matches_when_both_none(tmp_path):
    # A manifest omitting the corpus fields loads them as None, and the
    # running values are None too. None == None is NOT drift: absence on
    # both sides proceeds silently (the D-SNAP-DEVMODE-EXCEPTIONS demotion).
    # One-sided absence is still drift — absence cannot prove identity.
    wt = _make_worktree(tmp_path)
    dest = _capture(
        wt,
        tmp_path / "snapshots",
        "snap-void",
        provenance={"author_model": "m"},
    )
    assert dest is not None
    loaded = load_snapshot("snap-void", tmp_path)
    assert loaded.chunk_plan_hash is None
    assert (
        validate_snapshot_for_seed(
            loaded,
            model="m",
            chunk_plan_hash=None,
            template_hash=None,
            source_commit=None,
        )
        == []
    )


def _make_gates(root: Path) -> Path:
    """A grader-gates fixture: real gate code in a small tree."""
    gates = root / "gates"
    (gates / "backend").mkdir(parents=True)
    (gates / "backend" / "gate.py").write_text("def grade():\n    return True\n")
    (gates / "README.md").write_text("# gates\n")
    return gates


def test_grader_hash_none_for_missing_or_non_dir(tmp_path):
    assert compute_grader_hash(tmp_path / "no-such-gates") is None
    regular = tmp_path / "regular.txt"
    regular.write_text("i am a file\n")
    assert compute_grader_hash(regular) is None


def test_grader_hash_deterministic(tmp_path):
    gates = _make_gates(tmp_path)
    first = compute_grader_hash(gates)
    assert isinstance(first, str) and len(first) == 64
    assert compute_grader_hash(gates) == first


def test_grader_hash_independent_of_creation_order(tmp_path):
    bodies = {
        "README.md": "# gates\n",
        "backend/gate.py": "def grade():\n    return True\n",
        "backend/util.py": "X = 1\n",
    }
    forward = tmp_path / "forward"
    reverse = tmp_path / "reverse"
    for root in (forward, reverse):
        (root / "backend").mkdir(parents=True)
    for name, body in bodies.items():
        (forward / name).write_text(body)
    for name, body in reversed(list(bodies.items())):
        (reverse / name).write_text(body)
    assert compute_grader_hash(forward) == compute_grader_hash(reverse)


def test_grader_hash_changes_with_content(tmp_path):
    gates = _make_gates(tmp_path)
    before = compute_grader_hash(gates)
    (gates / "backend" / "gate.py").write_text("def grade():\n    return False\n")
    assert compute_grader_hash(gates) != before


def test_grader_hash_excludes_run_debris(tmp_path):
    gates = _make_gates(tmp_path)
    baseline = compute_grader_hash(gates)
    # Debris dirs never enter the hash, whatever they hold.
    (gates / "node_modules" / "pkg").mkdir(parents=True)
    (gates / "node_modules" / "pkg" / "index.js").write_text("module.exports = {}\n")
    (gates / "test-results").mkdir()
    (gates / "test-results" / "out.txt").write_text("debris\n")
    (gates / ".git").mkdir()
    (gates / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
    assert compute_grader_hash(gates) == baseline
    # Real files DO move the hash: one at the root, one in a real subdir.
    (gates / "NOTES.md").write_text("root file\n")
    after_root = compute_grader_hash(gates)
    assert after_root != baseline
    (gates / "backend" / "extra.py").write_text("Y = 2\n")
    assert compute_grader_hash(gates) != after_root


def test_grader_hash_skips_symlinks(tmp_path):
    gates = _make_gates(tmp_path)
    baseline = compute_grader_hash(gates)
    outside = tmp_path / "outside.py"
    outside.write_text("OUTSIDE = 'never hashed'\n")
    (gates / "backend" / "link.py").symlink_to(outside)
    assert compute_grader_hash(gates) == baseline
