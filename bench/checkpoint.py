"""Per-attempt check-point capture and diffing for one run.

A check-point binds one attempt's delivered tree to the moment it was
delivered: the live worktree is copied under ``<run_dir>/checkpoints/cp-NN/``
by :func:`bench.snapshot.capture_snapshot` — the copy, the exclusion list and
the manifest writer are reused, never re-derived — and the previous
check-point is diffed against this one, so the run's history reads as a chain
of per-attempt unified diffs.

Identity comes from the caller: ``state_hash`` is the walk-v1 hash of the
LIVE worktree, and the captured tree is never hashed here. A falsy hash means
the tree was unhashable (the nested-``.gitignore`` guard already refused
upstream), so :func:`capture_snapshot` declines and the check-point is
cleanly absent — nothing is written and ``None`` comes back for the caller to
notice.

Capture is instrumentation and must never kill a run: nothing here raises.
Any failure — capture, diff, index write — degrades to "no check-point"
(``None``). The index is written atomically (temp file + :func:`os.replace`),
so a crash never leaves a partial ``index.json`` behind, and an existing
index is appended to, never clobbered: an index that cannot be appended to
is a refusal, not a fresh start.
"""

import difflib
import json
import os
import tempfile
import time
from pathlib import Path

from bench.cell_isolation import worktree_drift
from bench.snapshot import capture_snapshot

CHECKPOINT_DIR_NAME = "checkpoints"


def checkpoint_root(run_dir: Path) -> Path:
    """The directory holding every check-point of one run."""
    return Path(run_dir) / CHECKPOINT_DIR_NAME


def checkpoint_id(attempt: int) -> str:
    """The stable id of attempt ``attempt``: ``cp-01``, ``cp-02``, …"""
    return f"cp-{attempt:02d}"


def record_checkpoint(
    *,
    run_dir: Path,
    worktree: Path,
    attempt: int,
    phase: str,
    state_hash: str | None,
    run_id: str,
    wall_ts: int | None = None,
) -> dict | None:
    """Capture attempt ``attempt``'s check-point and diff it against the previous.

    Layout under ``<run_dir>/checkpoints/``::

        cp-NN/tree/…                          the captured worktree
        cp-NN/snapshot.json                   capture manifest
        cp-NN/cp.json                         attempt/phase/hash/wall_ts
        diffs/<from>_to_<to>/combined.diff    concatenation of file diffs
        diffs/<from>_to_<to>/files/<rel>.diff one file's unified diff
        index.json                            {"run_id","checkpoints","diffs"}

    ``state_hash`` is the caller-supplied walk-v1 hash of the LIVE worktree;
    the captured tree is never hashed here. A falsy hash makes
    :func:`capture_snapshot` refuse and this function return ``None`` having
    written nothing. The first check-point has no previous entry to diff
    against and gets no diff. Every path recorded in ``index.json`` is
    relative to ``run_dir`` (so it starts with ``checkpoints/``).

    Returns the check-point's index entry on success, ``None`` on any
    failure. Never raises.
    """
    try:
        cid = checkpoint_id(attempt)
        root = checkpoint_root(run_dir)
        index = _load_index(root / "index.json")
        prev = index["checkpoints"][-1] if index and index["checkpoints"] else None
        # Validate the previous entry BEFORE capturing anything: a malformed
        # index must degrade to absence with nothing written, exactly like a
        # falsy state hash.
        prev_id: str | None = None
        if prev is not None:
            prev_id = prev.get("id")
            if not isinstance(prev_id, str) or not prev_id:
                raise ValueError(f"previous check-point entry carries no id: {prev!r}")

        cp_dir = capture_snapshot(
            worktree=worktree,
            snapshot_root=root,
            snapshot_id=cid,
            state_hash=state_hash,
            state_alg="walk-v1",
            provenance={
                "run_id": run_id,
                "checkpoint": cid,
                "attempt": attempt,
                "phase": phase,
            },
        )
        if cp_dir is None:
            return None

        ts = int(time.time() * 1000) if wall_ts is None else wall_ts
        (cp_dir / "cp.json").write_text(
            json.dumps(
                {
                    "attempt": attempt,
                    "phase": phase,
                    "state_hash": state_hash,
                    "wall_ts": ts,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        entry = {
            "id": cid,
            "attempt": attempt,
            "phase": phase,
            "state_hash": state_hash,
            "wall_ts": ts,
            "tree_path": f"{CHECKPOINT_DIR_NAME}/{cid}/tree",
        }

        if index is None:
            index = {"run_id": run_id, "checkpoints": [], "diffs": []}
        else:
            # The run_id belongs to the first check-point written; an index
            # that predates it (or lost it) takes this run's.
            index = {
                "run_id": index.get("run_id") or run_id,
                "checkpoints": index["checkpoints"],
                "diffs": index["diffs"],
            }
        diff_entry = (
            _write_diff(root=root, prev_id=prev_id, cid=cid)
            if prev_id is not None
            else None
        )
        index["checkpoints"].append(entry)
        if diff_entry is not None:
            index["diffs"].append(diff_entry)
        _write_index_atomic(root / "index.json", index)
        return entry
    except Exception:
        return None


def _load_index(index_path: Path) -> dict | None:
    """Read an existing index; ``None`` when absent, refuse when unappendable.

    An index that exists but cannot be parsed — or lacks the two lists — is a
    failure, not a blank slate: rebuilding it would clobber the run's recorded
    history, so the refusal rides :func:`record_checkpoint`'s catch-all and
    degrades to ``None``.
    """
    if not index_path.exists():
        return None
    payload = json.loads(index_path.read_text(encoding="utf-8"))
    if (
        not isinstance(payload, dict)
        or not isinstance(payload.get("checkpoints"), list)
        or not isinstance(payload.get("diffs"), list)
    ):
        raise ValueError(f"checkpoint index at {index_path} is not appendable")
    return payload


def _write_diff(*, root: Path, prev_id: str, cid: str) -> dict:
    """Diff check-point ``cid`` against ``prev_id``; return the index entry.

    Classification reuses :func:`bench.cell_isolation.worktree_drift` with the
    new tree as ``worktree`` and the previous tree as ``scaffold``:
    ``unexpected`` (in to, not in from) is ``added`` and ``modified`` (in
    both, bytes differ) is ``modified``. ``missing`` is ``removed`` only for
    files genuinely present in the from-tree: worktree_drift's
    ``HARNESS_SEEDED`` expects AGENTS.md unconditionally, but captured trees
    never contain it (``SNAPSHOT_EXCLUDED`` strips it from both sides), so
    the unfiltered set would put a phantom "removed" AGENTS.md in every diff
    and make the zero-changed-files case impossible. The three sets are
    disjoint by construction. ``combined.diff`` is the concatenation of the
    per-file diffs in sorted path order; a zero-changed-files diff is valid
    and yields an empty ``combined.diff`` with an empty ``files`` list.
    """
    diff_id = f"{prev_id}_to_{cid}"
    from_tree = root / prev_id / "tree"
    to_tree = root / cid / "tree"
    unexpected, missing, modified = worktree_drift(worktree=to_tree, scaffold=from_tree)
    # Phantom guard (see docstring): "removed" is "in from, not in to", so a
    # missing file only qualifies when it actually exists in the from-tree.
    removed = {rel for rel in missing if (from_tree / rel).is_file()}
    changes = {rel: "added" for rel in unexpected}
    changes.update({rel: "removed" for rel in removed})
    changes.update({rel: "modified" for rel in modified})

    diff_dir = root / "diffs" / diff_id
    diff_dir.mkdir(parents=True, exist_ok=True)
    files: list[dict[str, str]] = []
    combined: list[str] = []
    for rel in sorted(changes):
        content = _file_diff(from_tree, to_tree, rel, changes[rel])
        file_diff = diff_dir / "files" / f"{rel}.diff"
        file_diff.parent.mkdir(parents=True, exist_ok=True)
        file_diff.write_text(content, encoding="utf-8")
        combined.append(content)
        files.append(
            {
                "path": rel,
                "change": changes[rel],
                "diff": f"{CHECKPOINT_DIR_NAME}/diffs/{diff_id}/files/{rel}.diff",
            }
        )
    (diff_dir / "combined.diff").write_text("".join(combined), encoding="utf-8")
    return {
        "id": diff_id,
        "from": prev_id,
        "to": cid,
        "combined": f"{CHECKPOINT_DIR_NAME}/diffs/{diff_id}/combined.diff",
        "files": files,
    }


def _file_diff(from_tree: Path, to_tree: Path, rel: str, change: str) -> str:
    """One file's unified diff, labelled ``a/<rel>`` → ``b/<rel>``.

    ``added`` diffs empty → new bytes, ``removed`` diffs old bytes → empty,
    ``modified`` diffs old → new. A side that will not decode as utf-8 — or
    will not read at all — yields git's binary marker instead of a text diff,
    so an unreadable file is marked in the diff chain and never crashes it.
    """
    label_from, label_to = f"a/{rel}", f"b/{rel}"
    old: list[str] = []
    new: list[str] = []
    try:
        if change in ("modified", "removed"):
            text = (from_tree / rel).read_text(encoding="utf-8")
            old = text.splitlines(keepends=True)
        if change in ("modified", "added"):
            text = (to_tree / rel).read_text(encoding="utf-8")
            new = text.splitlines(keepends=True)
    except (UnicodeDecodeError, OSError):
        return f"Binary files {label_from} and {label_to} differ\n"
    content = "".join(
        difflib.unified_diff(old, new, fromfile=label_from, tofile=label_to)
    )
    if content and not content.endswith("\n"):
        # A file not ending in a newline would otherwise run its last diff
        # line into the next file's header inside combined.diff.
        content += "\n"
    return content


def _write_index_atomic(index_path: Path, payload: dict) -> None:
    """Write ``index.json`` through a temp file + :func:`os.replace`.

    The replace is atomic within a filesystem, so a crash mid-write leaves
    either the old index or the new one — never a partial file. On failure the
    temp file is best-effort removed and the error rides
    :func:`record_checkpoint`'s catch-all.
    """
    fd, tmp = tempfile.mkstemp(
        dir=str(index_path.parent), prefix=".index-", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, index_path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
