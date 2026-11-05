"""What a cell ran on: every fingerprint input, recorded when it starts.

WHAT IS IN IT. The fingerprint records everything that determines what was
measured: the eight original inputs (the prompt/scaffold/golden/grader trees,
model, challenge, compaction, the worker image id) plus the harness code, the
source commit and whether the tree was dirty, the worker image's source digest,
the opencode version, and the grader image identity. The six newer inputs are
appended only when the caller observed them — an input nobody could read is
absent, never filled with a placeholder, so a later change to it reads as
"not recorded" rather than as a match.

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
import logging
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

FILENAME = "fingerprint.json"
SCHEMA_VERSION = 1

#: Run debris inside the grader, never grader code (control/baselines.mjs uses
#: the same set when it hashes the current grader).
GRADER_EXCLUDED: frozenset[str] = frozenset({"node_modules", ".git", "test-results"})

#: Byte-compiled debris inside the harness, never harness code: the harness dir
#: is hashed from the working tree, where ``__pycache__`` churns on any import.
PYCACHE_EXCLUDED: frozenset[str] = frozenset({"__pycache__"})

_LOG = logging.getLogger(__name__)


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


def git_status_dirty(repo_root: Path) -> bool:
    """Whether ``repo_root`` has uncommitted changes.

    WHY THE DIRTY BIT IS ITS OWN INPUT AND NOT A CONVENIENCE: a cell run from a
    modified tree measured code that no commit names, so the commit alone cannot
    reproduce the run.

    Raises when git cannot answer: a cell whose cleanliness is unknown cannot be
    fingerprinted, and an unfingerprinted cell must not run (no silent fallback).
    """
    completed = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        timeout=10,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"fingerprint: git status failed in {repo_root}: {completed.stderr.strip()}"
        )
    return bool(completed.stdout.strip())


def cell_fingerprint(
    *,
    task_dir: Path,
    grader_dir: Path,
    model: str,
    challenge: str,
    compaction: bool,
    worker_image: Mapping[str, Any],
    harness_dir: Path | None = None,
    source_commit: str | None = None,
    source_dirty: bool | None = None,
    worker_source_digest: str | None = None,
    opencode_version: str | None = None,
    grader_image: dict[str, str] | None = None,
) -> dict[str, Any]:
    """The fingerprint inputs, keyed exactly as control/batch.mjs FINGERPRINT_INPUTS.

    The NAMES are that list's contract, so the eight original keys are always
    written and always first. The six later inputs are appended only when their
    argument is not None — the fingerprint is absent-not-fake, so a caller that
    could not read the harness tree, the git state, the worker digest, the
    opencode version or the grader image leaves the key out rather than writing
    a value that would later compare equal to itself.
    """
    task_dir = Path(task_dir)
    values: dict[str, Any] = {
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
    # Appended in FINGERPRINT_INPUTS order: code first, then the identity that
    # says where that code came from. str()/bool() keep the record JSON-typed.
    if harness_dir is not None:
        values["harness_hash"] = dir_hash(Path(harness_dir), PYCACHE_EXCLUDED)
    if source_commit is not None:
        values["source_commit"] = str(source_commit)
    if source_dirty is not None:
        values["source_dirty"] = bool(source_dirty)
    if worker_source_digest is not None:
        values["worker_source_digest"] = str(worker_source_digest)
    if opencode_version is not None:
        values["opencode_version"] = str(opencode_version)
    if grader_image is not None:
        values["grader_image"] = dict(grader_image)
    return values


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
    "PYCACHE_EXCLUDED",
    "cell_fingerprint",
    "dir_hash",
    "git_status_dirty",
    "write_cell_fingerprint",
]
