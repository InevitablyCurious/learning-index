"""CELL ISOLATION PREFLIGHT — a cell must not inherit a previous cell's work.

Back-to-back runs of the SAME model are the dangerous case: leftover files look
plausible because the same model wrote them, so the contamination is invisible
in the result. These tests pin the assertions that refuse the launch.
"""

from pathlib import Path

import pytest

from bench.cell_isolation import (
    CellIsolationError,
    assert_clean_worktree,
    assert_seeded_from_snapshot,
    docker_residue,
    worktree_drift,
)


def _scaffold(root: Path) -> Path:
    s = root / "scaffold"
    (s / "src").mkdir(parents=True)
    (s / "src" / "game.ts").write_text(
        'throw new Error("not implemented")\n', encoding="utf-8"
    )
    (s / "package.json").write_text("{}\n", encoding="utf-8")
    return s


def _seeded(root: Path, scaffold: Path) -> Path:
    """A correctly seeded worktree: scaffold contents + the harness's AGENTS.md."""
    w = root / "worktree"
    (w / "src").mkdir(parents=True)
    (w / "src" / "game.ts").write_text(
        (scaffold / "src" / "game.ts").read_text(encoding="utf-8"), encoding="utf-8"
    )
    (w / "package.json").write_text("{}\n", encoding="utf-8")
    (w / "AGENTS.md").write_text("# Notes\n", encoding="utf-8")
    return w


def test_a_correctly_seeded_worktree_passes(tmp_path: Path) -> None:
    scaffold = _scaffold(tmp_path)
    worktree = _seeded(tmp_path, scaffold)
    assert_clean_worktree(worktree=worktree, scaffold=scaffold)  # must not raise


def test_a_file_left_by_a_previous_cell_refuses_the_launch(tmp_path: Path) -> None:
    """THE CASE THIS EXISTS FOR. A previous run's implementation survives; the
    file is plausible because the same model wrote it."""
    scaffold = _scaffold(tmp_path)
    worktree = _seeded(tmp_path, scaffold)
    (worktree / "src" / "ai.ts").write_text(
        "export function evaluate(){return 1}\n", encoding="utf-8"
    )

    with pytest.raises(CellIsolationError) as err:
        assert_clean_worktree(worktree=worktree, scaffold=scaffold)

    msg = str(err.value)
    assert "src/ai.ts" in msg
    assert "UNEXPECTED" in msg
    assert "inherited work" in msg
    assert "Nothing was launched" in msg


def test_a_half_copied_scaffold_is_caught_too(tmp_path: Path) -> None:
    """Missing scaffold files fail gates for work the cell was never given —
    that reads as a capability result and is not one."""
    scaffold = _scaffold(tmp_path)
    worktree = _seeded(tmp_path, scaffold)
    (worktree / "package.json").unlink()

    with pytest.raises(CellIsolationError) as err:
        assert_clean_worktree(worktree=worktree, scaffold=scaffold)
    assert "MISSING" in str(err.value)
    assert "package.json" in str(err.value)


def test_git_dir_is_ignored_so_the_check_survives_git_init(tmp_path: Path) -> None:
    scaffold = _scaffold(tmp_path)
    worktree = _seeded(tmp_path, scaffold)
    (worktree / ".git" / "objects").mkdir(parents=True)
    (worktree / ".git" / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    (worktree / ".git" / "objects" / "abc").write_text("x", encoding="utf-8")

    assert_clean_worktree(worktree=worktree, scaffold=scaffold)  # must not raise


def test_drift_reports_both_directions_separately(tmp_path: Path) -> None:
    scaffold = _scaffold(tmp_path)
    worktree = _seeded(tmp_path, scaffold)
    (worktree / "leftover.ts").write_text("x", encoding="utf-8")
    (worktree / "package.json").unlink()

    unexpected, missing, modified = worktree_drift(worktree=worktree, scaffold=scaffold)
    assert unexpected == {"leftover.ts"}
    assert missing == {"package.json"}
    assert modified == set()


def test_an_empty_worktree_is_a_failure_not_a_pass(tmp_path: Path) -> None:
    """A seed that produced nothing must never read as 'clean'."""
    scaffold = _scaffold(tmp_path)
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(CellIsolationError):
        assert_clean_worktree(worktree=empty, scaffold=scaffold)


def test_docker_residue_never_looks_beyond_this_cells_two_names(monkeypatch) -> None:
    """THE MEMORY SYSTEM MUST BE UNREACHABLE FROM HERE. It is a separately
    managed process whose survival across runs is the experiment."""
    seen: list[list[str]] = []

    def fake(args: list[str]) -> str:
        seen.append(args)
        return ""

    monkeypatch.setattr("bench.cell_isolation._docker_stdout", fake)
    docker_residue(container_name="okp-bench-cell-x")

    flat = " ".join(" ".join(a) for a in seen)
    # Every query is anchored to the exact cell name; no wildcard enumeration.
    assert "name=^okp-bench-cell-x$" in flat
    assert "name=^okp-bench-cell-x-session-db$" in flat
    for forbidden in ("okp-server", "postgres", "qdrant", "hub", "mcp"):
        assert forbidden not in flat
    # And every call is READ-ONLY: `docker ps` / `docker volume ls`, never a
    # verb that mutates. Checked on the argv tokens, not as a substring —
    # "rm" also appears inside "--format".
    for args in seen:
        assert "rm" not in args and "prune" not in args and "remove" not in args
        assert args[0] in {"ps", "volume"}
        if args[0] == "volume":
            assert args[1] == "ls"


def test_an_unavailable_docker_daemon_is_not_reported_as_residue(monkeypatch) -> None:
    """Docker being unreachable is its own loud failure moments later; calling
    it an isolation error would misname it."""
    monkeypatch.setattr("bench.cell_isolation._docker_stdout", lambda args: None)
    assert docker_residue(container_name="okp-bench-cell-x") == []


def test_a_stub_filled_in_by_a_PREVIOUS_cell_refuses_the_launch(tmp_path: Path) -> None:
    """THE CASE A NAME-ONLY CHECK MISSES, and the one that actually happens.

    The scaffold ships stub `src/game.ts`, `src/ai.ts`, `src/server.ts` and
    `public/app.js`. A previous cell's model fills them IN PLACE, under names
    the scaffold already has — so comparing file SETS reports "clean". The
    first version of this module did exactly that and passed a worktree
    carrying a previous cell's entire implementation. Verified against the real
    scaffold before it was fixed.
    """
    scaffold = _scaffold(tmp_path)
    worktree = _seeded(tmp_path, scaffold)

    # Same filename, same file count. Only the content is a previous cell's.
    (worktree / "src" / "game.ts").write_text(
        "export function startingPoints(){ return [] }\n", encoding="utf-8"
    )

    unexpected, missing, modified = worktree_drift(worktree=worktree, scaffold=scaffold)
    assert unexpected == set(), "no new file — this is why names alone are not enough"
    assert missing == set()
    assert modified == {"src/game.ts"}

    with pytest.raises(CellIsolationError) as err:
        assert_clean_worktree(worktree=worktree, scaffold=scaffold)
    msg = str(err.value)
    assert "MODIFIED" in msg
    assert "src/game.ts" in msg
    assert "inherited from a previous cell" in msg


def test_agents_md_content_is_the_harness_business_not_the_scaffolds(
    tmp_path: Path,
) -> None:
    """The harness writes AGENTS.md itself, so its content must not be diffed
    against a scaffold that does not contain it."""
    scaffold = _scaffold(tmp_path)
    worktree = _seeded(tmp_path, scaffold)
    (worktree / "AGENTS.md").write_text("# totally different notes\n", encoding="utf-8")
    assert_clean_worktree(worktree=worktree, scaffold=scaffold)  # must not raise


def _snapshot_tree(root: Path) -> Path:
    """A captured snapshot's ``tree/``: the slate one cell DECLARED it started
    from. ``.git``-free and ``AGENTS.md``-free by construction, like the real
    thing (``SNAPSHOT_EXCLUDED`` in snapshot.py)."""
    t = root / "snapshot" / "tree"
    (t / "src").mkdir(parents=True)
    (t / "src" / "game.ts").write_text(
        'throw new Error("not implemented")\n', encoding="utf-8"
    )
    (t / "package.json").write_text("{}\n", encoding="utf-8")
    return t


def test_a_worktree_seeded_from_the_declared_snapshot_passes(tmp_path: Path) -> None:
    """Clean seed: the snapshot tree's files byte-for-byte + the harness's
    AGENTS.md, which HARNESS_SEEDED accounts for."""
    snapshot_tree = _snapshot_tree(tmp_path)
    worktree = _seeded(tmp_path, snapshot_tree)
    assert_seeded_from_snapshot(worktree=worktree, snapshot_tree=snapshot_tree)


def test_a_worktree_that_drifts_from_the_declared_snapshot_refuses_the_launch(
    tmp_path: Path,
) -> None:
    """The check is SWAPPED to the snapshot tree, never bypassed: a file no
    snapshot declared is inherited work exactly as it is against a scaffold."""
    snapshot_tree = _snapshot_tree(tmp_path)
    worktree = _seeded(tmp_path, snapshot_tree)
    (worktree / "src" / "ai.ts").write_text(
        "export function evaluate(){return 1}\n", encoding="utf-8"
    )

    with pytest.raises(CellIsolationError) as err:
        assert_seeded_from_snapshot(worktree=worktree, snapshot_tree=snapshot_tree)

    msg = str(err.value)
    assert "declared snapshot tree" in msg
    assert str(snapshot_tree) in msg
    assert "src/ai.ts" in msg
    assert "UNEXPECTED" in msg
    assert "inherited work" in msg
    assert "Nothing was launched" in msg


def test_drift_against_the_snapshot_tree_reports_all_three_directions(
    tmp_path: Path,
) -> None:
    """Same machinery, same sets: ``worktree_drift`` against the snapshot tree
    reports unexpected, missing and modified separately, content-hashed."""
    snapshot_tree = _snapshot_tree(tmp_path)
    worktree = _seeded(tmp_path, snapshot_tree)
    (worktree / "leftover.ts").write_text("x", encoding="utf-8")
    (worktree / "package.json").unlink()
    (worktree / "src" / "game.ts").write_text(
        "export function startingPoints(){ return [] }\n", encoding="utf-8"
    )

    unexpected, missing, modified = worktree_drift(
        worktree=worktree, scaffold=snapshot_tree
    )
    assert unexpected == {"leftover.ts"}
    assert missing == {"package.json"}
    assert modified == {"src/game.ts"}
