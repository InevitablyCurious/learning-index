"""What a cell ran on: its eight fingerprint inputs, recorded when it starts.

WHY THIS IS RECORDED AT THE CELL, NOT COMPUTED AT THE BATCH
------------------------------------------------------------
A batch of OFF cells (control/batch.mjs) is bound to a fingerprint of
everything that determines what was measured, and a batch whose fingerprint no
longer matches the code is void. That fingerprint used to be hashed from the
repository when the batch record was ASSEMBLED, and the record is re-assembled
every time a cell finishes. So it described the code at the last assembly, not
the code the cells ran on: a grader edited mid-batch was stamped in silently,
an old run acquired today's fingerprint, and the void check could never fire.

So each cell writes ``fingerprint.json`` beside its live stream at the moment
it starts, and the batch is built from those files alone. A cell without the
file is unfingerprinted and never part of a floor.

THE HASH. The directory hash is ``control/batch.mjs`` ``hashDir``'s, byte for
byte: sha256 over each regular file's POSIX path relative to the root (utf-8),
then its raw bytes, in sorted path order; symlinks and any path containing an
excluded segment are skipped. The control plane re-hashes the current tree with
that function and compares, so the two must never drift.
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

FILENAME = "fingerprint.json"
SCHEMA_VERSION = 1

#: Run debris inside the grader, never grader code (control/baselines.mjs uses
#: the same set when it hashes the current grader).
GRADER_EXCLUDED: frozenset[str] = frozenset({"node_modules", ".git", "test-results"})


def dir_hash(root: Path, exclude: frozenset[str] = frozenset()) -> str:
    """The directory hash described above. Raises when ``root`` is not a directory."""
    root = Path(root)
    if not root.is_dir():
        raise FileNotFoundError(f"fingerprint input directory missing: {root}")
    rels: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [d for d in dirnames if d not in exclude]
        for name in filenames:
            if name in exclude:
                continue
            full = Path(dirpath) / name
            if full.is_symlink() or not full.is_file():
                continue
            rels.append(full.relative_to(root).as_posix())
    digest = hashlib.sha256()
    for rel in sorted(rels):
        digest.update(rel.encode("utf-8"))
        digest.update((root / rel).read_bytes())
    return digest.hexdigest()


def cell_fingerprint(
    *,
    task_dir: Path,
    grader_dir: Path,
    model: str,
    challenge: str,
    compaction: bool,
    worker_image: Mapping[str, Any],
) -> dict[str, Any]:
    """The eight inputs, keyed exactly as control/batch.mjs FINGERPRINT_INPUTS."""
    task_dir = Path(task_dir)
    return {
        "chunk_plan_hash": dir_hash(task_dir / "prompts"),
        "grader_hash": dir_hash(Path(grader_dir), GRADER_EXCLUDED),
        "model": str(model),
        "challenge": str(challenge),
        "compaction": bool(compaction),
        "scaffold_hash": dir_hash(task_dir / "scaffold"),
        "golden_hash": dir_hash(task_dir / "golden"),
        "worker_image": {
            "image_id": str(worker_image["image_id"]),
            "created": str(worker_image["created"]),
        },
    }


def write_cell_fingerprint(cell_dir: Path, values: Mapping[str, Any]) -> Path:
    """Write ``fingerprint.json`` into the cell directory, atomically."""
    cell_dir = Path(cell_dir)
    cell_dir.mkdir(parents=True, exist_ok=True)
    path = cell_dir / FILENAME
    tmp = cell_dir / f"{FILENAME}.{os.getpid()}.tmp"
    record = {
        "schema_version": SCHEMA_VERSION,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "values": dict(values),
    }
    tmp.write_text(
        json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    tmp.replace(path)
    return path


__all__ = [
    "FILENAME",
    "GRADER_EXCLUDED",
    "cell_fingerprint",
    "dir_hash",
    "write_cell_fingerprint",
]
