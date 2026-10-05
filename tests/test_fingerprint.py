"""harness/fingerprint.py — a cell records what it ran on, before it runs.

The batch is fingerprinted from these files alone (control/baselines.mjs), and
the control plane re-hashes the current tree with control/batch.mjs hashDir to
compare, so the hash here must be that function's, byte for byte.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import pytest

from harness.fingerprint import (
    FILENAME,
    GRADER_EXCLUDED,
    cell_fingerprint,
    dir_hash,
    write_cell_fingerprint,
)

REPO = Path(__file__).resolve().parents[1]


def _expected(root: Path, files: dict[str, bytes]) -> str:
    digest = hashlib.sha256()
    for rel in sorted(files):
        digest.update(rel.encode("utf-8"))
        digest.update(files[rel])
    return digest.hexdigest()


def test_dir_hash_is_sorted_relative_paths_then_bytes(tmp_path: Path) -> None:
    files = {"b.txt": b"two", "a/z.txt": b"one", "a/b.txt": b"three"}
    for rel, data in files.items():
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_bytes(data)
    assert dir_hash(tmp_path) == _expected(tmp_path, files)


def test_excluded_segments_and_symlinks_are_skipped(tmp_path: Path) -> None:
    (tmp_path / "gate.ts").write_bytes(b"g")
    (tmp_path / "node_modules" / "x").mkdir(parents=True)
    (tmp_path / "node_modules" / "x" / "y.js").write_bytes(b"debris")
    (tmp_path / "link.ts").symlink_to(tmp_path / "gate.ts")
    assert dir_hash(tmp_path, GRADER_EXCLUDED) == _expected(tmp_path, {"gate.ts": b"g"})


def test_a_missing_directory_fails_loud(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        dir_hash(tmp_path / "absent")


def test_the_eight_inputs_carry_control_batch_mjs_names(tmp_path: Path) -> None:
    for d in ("prompts", "scaffold", "golden"):
        (tmp_path / d).mkdir()
        (tmp_path / d / "f").write_bytes(d.encode())
    grader = tmp_path / "grader"
    grader.mkdir()
    (grader / "g").write_bytes(b"g")
    values = cell_fingerprint(
        task_dir=tmp_path,
        grader_dir=grader,
        model="m",
        challenge="backgammon",
        compaction=True,
        worker_image={"image_id": "sha256:x", "created": "t", "extra": "dropped"},
    )
    src = (REPO / "control" / "batch.mjs").read_text(encoding="utf-8")
    block = src[
        src.index("export const FINGERPRINT_INPUTS") : src.index(
            "];", src.index("export const FINGERPRINT_INPUTS")
        )
    ]
    names = re.findall(r'name: "([a-z_]+)"', block)
    assert sorted(values) == sorted(names)
    assert values["worker_image"] == {"image_id": "sha256:x", "created": "t"}


def test_the_record_is_written_beside_the_cell(tmp_path: Path) -> None:
    path = write_cell_fingerprint(tmp_path / "cell-0000", {"model": "m"})
    assert path.name == FILENAME
    record = json.loads(path.read_text(encoding="utf-8"))
    assert record["schema_version"] == 1
    assert record["values"] == {"model": "m"}
    assert "recorded_at" in record
