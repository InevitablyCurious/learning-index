"""harness/fingerprint.py — a cell records what it ran on, before it runs.

The batch is fingerprinted from these files alone (control/baselines.mjs), and
the control plane re-hashes the current tree with control/batch.mjs hashDir to
compare, so the hash here must be that function's, byte for byte.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
from pathlib import Path

import pytest

from harness.fingerprint import (
    FILENAME,
    GRADER_EXCLUDED,
    cell_fingerprint,
    dir_hash,
    git_status_dirty,
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


def test_the_fourteen_inputs_carry_control_batch_mjs_names(tmp_path: Path) -> None:
    for d in ("prompts", "scaffold", "golden"):
        (tmp_path / d).mkdir()
        (tmp_path / d / "f").write_bytes(d.encode())
    grader = tmp_path / "grader"
    grader.mkdir()
    (grader / "g").write_bytes(b"g")
    harness = tmp_path / "harness"
    (harness / "__pycache__").mkdir(parents=True)
    (harness / "fingerprint.py").write_bytes(b"h")
    (harness / "__pycache__" / "fingerprint.cpython-311.pyc").write_bytes(b"debris")
    values = cell_fingerprint(
        task_dir=tmp_path,
        grader_dir=grader,
        model="m",
        challenge="backgammon",
        compaction=True,
        worker_image={"image_id": "sha256:x", "created": "t", "extra": "dropped"},
        harness_dir=harness,
        source_commit="71af42a",
        source_dirty=False,
        worker_source_digest="sha256:w",
        opencode_version="1.2.3",
        grader_image={"image": "bench-grader:v1", "source_digest": "sha256:g"},
    )
    src = (REPO / "control" / "batch.mjs").read_text(encoding="utf-8")
    block = src[
        src.index("export const FINGERPRINT_INPUTS") : src.index(
            "];", src.index("export const FINGERPRINT_INPUTS")
        )
    ]
    names = re.findall(r'name: "([a-z_]+)"', block)
    assert len(names) == 14
    assert sorted(values) == sorted(names)
    # The six later inputs are pinned HERE, literally, as well as by the parity
    # assert above: parity alone would still pass if both files dropped one of
    # them together, and these six are the ones added after the original eight.
    assert {
        "harness_hash",
        "source_commit",
        "source_dirty",
        "worker_source_digest",
        "opencode_version",
        "grader_image",
    } <= set(values)
    assert values["worker_image"] == {"image_id": "sha256:x", "created": "t"}
    # harness_hash covers harness code only: __pycache__ never determines a run.
    assert values["harness_hash"] == _expected(harness, {"fingerprint.py": b"h"})
    assert re.fullmatch(r"[0-9a-f]{64}", values["harness_hash"])
    assert values["source_commit"] == "71af42a"
    assert values["source_dirty"] is False
    assert values["worker_source_digest"] == "sha256:w"
    assert values["opencode_version"] == "1.2.3"
    assert values["grader_image"] == {
        "image": "bench-grader:v1",
        "source_digest": "sha256:g",
    }


def test_an_unobserved_input_is_absent_never_faked(tmp_path: Path) -> None:
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
        worker_image={"image_id": "sha256:x", "created": "t"},
    )
    assert sorted(values) == [
        "challenge",
        "chunk_plan_hash",
        "compaction",
        "golden_hash",
        "grader_hash",
        "model",
        "scaffold_hash",
        "worker_image",
    ]


def test_git_status_dirty_reads_the_tree_and_raises_when_unknown(
    tmp_path: Path,
) -> None:
    # Not a repository: git fails, so the cell cannot be fingerprinted.
    with pytest.raises(RuntimeError):
        git_status_dirty(tmp_path)
    (tmp_path / "tracked.txt").write_bytes(b"one")
    subprocess.run(["git", "init", "-q"], cwd=str(tmp_path), check=True)
    subprocess.run(["git", "add", "."], cwd=str(tmp_path), check=True)
    subprocess.run(
        [
            "git",
            "-c",
            "user.email=t@example.com",
            "-c",
            "user.name=t",
            "commit",
            "-qm",
            "seed",
        ],
        cwd=str(tmp_path),
        check=True,
    )
    assert git_status_dirty(tmp_path) is False
    (tmp_path / "tracked.txt").write_bytes(b"two")
    assert git_status_dirty(tmp_path) is True


def test_the_record_is_written_beside_the_cell(tmp_path: Path) -> None:
    path = write_cell_fingerprint(tmp_path / "cell-0000", {"model": "m"})
    assert path.name == FILENAME
    record = json.loads(path.read_text(encoding="utf-8"))
    assert record["schema_version"] == 1
    assert record["values"] == {"model": "m"}
    assert "recorded_at" in record
