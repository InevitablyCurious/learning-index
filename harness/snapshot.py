"""Snapshot capture for graded worktrees.

A snapshot binds "what the gates observed" to the exact code that was present
when they graded: the tree is copied at grading time and identified by the
state hash the grader already computed. Capture is instrumentation and must
never kill a run, so nothing in :func:`capture_snapshot` raises — any failure
degrades to "no snapshot" (``None``). A snapshot whose identity is unknown (a
null state hash) is structurally ineligible and is refused before anything is
written.
"""

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Top-level worktree entries that are never captured: VCS and agent internals
# plus harness config are not graded code, and test-results is run debris.
SNAPSHOT_EXCLUDED: frozenset[str] = frozenset(
    {".git", ".okp", "AGENTS.md", "opencode.json", "test-results"}
)


def capture_snapshot(
    *,
    worktree: Path,
    snapshot_root: Path,
    snapshot_id: str,
    state_hash: str | None,
    state_alg: str,
    provenance: dict[str, Any],
) -> Path | None:
    """Copy ``worktree`` into ``<snapshot_root>/<snapshot_id>/``.

    Layout on success: ``tree/`` holds the worktree's top-level entries minus
    :data:`SNAPSHOT_EXCLUDED` (exclusion is by top-level name only; everything
    else is copied recursively, structure preserved), and ``snapshot.json`` —
    written last — holds the identity fields followed by ``provenance``.

    Returns the snapshot directory, or ``None`` when the state hash is null or
    anything failed; a failed capture best-effort removes its partial directory
    so no half-valid snapshot persists. Never raises.
    """
    dest: Path | None = None
    try:
        if not state_hash:
            return None
        dest = Path(snapshot_root) / snapshot_id
        entries = sorted(Path(worktree).iterdir())
        tree = dest / "tree"
        tree.mkdir(parents=True)
        for entry in entries:
            if entry.name in SNAPSHOT_EXCLUDED:
                continue
            if entry.is_dir():
                shutil.copytree(entry, tree / entry.name)
            else:
                shutil.copy2(entry, tree / entry.name)
        payload: dict[str, Any] = {
            "snapshot_id": snapshot_id,
            "state_hash": state_hash,
            "state_alg": state_alg,
            "created_at": datetime.now(timezone.utc).isoformat(),
            **provenance,
        }
        (dest / "snapshot.json").write_text(
            json.dumps(payload, indent=2) + "\n", encoding="utf-8"
        )
    except Exception:
        if dest is not None:
            shutil.rmtree(dest, ignore_errors=True)
        return None
    return dest
