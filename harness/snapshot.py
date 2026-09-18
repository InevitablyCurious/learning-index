"""Snapshot capture and seed loading for graded worktrees.

A snapshot binds "what the gates observed" to the exact code that was present
when they graded: the tree is copied at grading time and identified by the
state hash the grader already computed. Capture is instrumentation and must
never kill a run, so nothing in :func:`capture_snapshot` raises — any failure
degrades to "no snapshot" (``None``). A snapshot whose identity is unknown (a
null state hash) is structurally ineligible and is refused before anything is
written.

The read side is the opposite contract: loading a snapshot to seed a run is a
trust decision, so every refusal raises a :class:`SnapshotError` subclass with
its own distinct message — absent, unreadable, corpus mismatch, model
mismatch — and never degrades silently. Provenance that is ``None`` on either
side of a comparison is a mismatch: absence cannot prove identity.
"""

import hashlib
import json
import shutil
from dataclasses import dataclass
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


class SnapshotError(Exception):
    """Base for every snapshot read-side refusal."""


class SnapshotNotFoundError(SnapshotError):
    """The snapshot is absent: its directory or its ``tree/`` is missing."""


class SnapshotUnreadableError(SnapshotError):
    """``snapshot.json`` is missing, unreadable, or not parseable."""


class SnapshotModelMismatchError(SnapshotError):
    """The snapshot's ``author_model`` differs from the run's model."""


@dataclass(frozen=True)
class LoadedSnapshot:
    """A snapshot read back from disk, ready for seed validation.

    Provenance fields are ``None`` when the manifest omits them; seed
    validation reports a one-sided absence as drift (never a wildcard) and
    reads absence on both sides as a match.
    """

    snapshot_id: str
    tree: Path
    state_hash: str | None
    state_alg: str | None
    chunk_plan_hash: str | None
    template_hash: str | None
    source_commit: str | None
    author_model: str | None
    provider: str | None
    build_cost: dict[str, Any] | None
    snapshot_depth: int


def load_snapshot(snapshot_id: str, runs_root: Path) -> LoadedSnapshot:
    """Read ``<runs_root>/snapshots/<snapshot_id>/`` into a LoadedSnapshot.

    Raises :class:`SnapshotNotFoundError` when the snapshot directory or its
    ``tree/`` is missing, and :class:`SnapshotUnreadableError` when
    ``snapshot.json`` is missing or cannot be parsed as a JSON object (the
    underlying reason travels in the message). Every other manifest key is
    read with ``.get`` — an absent key loads as ``None``.
    """
    snap_dir = Path(runs_root) / "snapshots" / snapshot_id
    tree = snap_dir / "tree"
    if not snap_dir.is_dir() or not tree.is_dir():
        raise SnapshotNotFoundError(
            f"snapshot {snapshot_id!r} not found: expected a directory "
            f"carrying a tree/ subdirectory at {snap_dir}"
        )
    manifest = snap_dir / "snapshot.json"
    try:
        payload = json.loads(manifest.read_text(encoding="utf-8"))
    except (ValueError, OSError) as exc:
        raise SnapshotUnreadableError(
            f"snapshot {snapshot_id!r} has no parseable manifest at "
            f"{manifest}: {exc!r}"
        ) from exc
    if not isinstance(payload, dict):
        raise SnapshotUnreadableError(
            f"snapshot {snapshot_id!r} manifest at {manifest} is not a JSON "
            f"object (got {type(payload).__name__})"
        )
    return LoadedSnapshot(
        # The directory is named by the id, so a manifest omitting it falls
        # back to the requested one; every other field is None when absent.
        snapshot_id=payload.get("snapshot_id") or snapshot_id,
        tree=tree,
        state_hash=payload.get("state_hash"),
        state_alg=payload.get("state_alg"),
        chunk_plan_hash=payload.get("chunk_plan_hash"),
        template_hash=payload.get("template_hash"),
        source_commit=payload.get("source_commit"),
        author_model=payload.get("author_model"),
        provider=payload.get("provider"),
        build_cost=payload.get("build_cost"),
        snapshot_depth=payload.get("snapshot_depth") or 1,
    )


def validate_snapshot_for_seed(
    snapshot: LoadedSnapshot,
    *,
    model: str,
    chunk_plan_hash: str | None,
    template_hash: str | None,
    source_commit: str | None,
) -> list[dict[str, str | None]]:
    """Refuse a snapshot that may not seed this run; return its corpus drift.

    ONE refusal: the snapshot must have been authored by ``model``
    (:class:`SnapshotModelMismatchError`). Corpus provenance drift
    (``chunk_plan_hash``, ``template_hash``, ``source_commit``) is DEMOTED —
    never refused. It is reported instead: the return value is one descriptor
    per differing field, ``{"field": <name>, "snapshot": <recorded value>,
    "running": <running value>}``, and the empty list when the running corpus
    matches. ``None`` on exactly one side of a field comparison is drift
    (absence cannot prove identity); ``None`` on both sides is a match and
    proceeds silently.
    """
    if snapshot.author_model is None or snapshot.author_model != model:
        raise SnapshotModelMismatchError(
            f"snapshot {snapshot.snapshot_id!r} carries "
            f"author_model={snapshot.author_model!r} but this run's model "
            f"is {model!r}; refusing to seed from another model's snapshot"
        )
    # D-SNAP-DEVMODE-EXCEPTIONS: corpus provenance drift is REPORTED, never
    # refused — do not "fix" this back into a raise. Dev mode is the
    # operator's fast-iteration tool: a captured snapshot is a starting
    # point, and its validity is NOT a publicly-defendable data point, so
    # source_commit and corpus-identity drift must not block seeding. The
    # refusals that remain are the ones with nothing to seed from (absent,
    # unreadable) and the same-model-only rule above (unchanged).
    drift: list[dict[str, str | None]] = []
    for field, running in (
        ("chunk_plan_hash", chunk_plan_hash),
        ("template_hash", template_hash),
        ("source_commit", source_commit),
    ):
        recorded = getattr(snapshot, field)
        if recorded != running:
            drift.append({"field": field, "snapshot": recorded, "running": running})
    return drift


# Path components that are run debris, never grader code: excluded from the
# grader-identity hash so debris churn cannot invalidate a dev-mode grade
# cache entry.
GRADER_HASH_EXCLUDED: frozenset[str] = frozenset(
    {"node_modules", "test-results", ".git"}
)


def compute_grader_hash(gates: Path) -> str | None:
    """Stable SHA-256 over grader gate files (sorted relative paths + bytes).

    Pure function: no instance state, no model endpoints. Returns the hexdigest
    over the concatenation of each file's utf-8-encoded relative path (sorted by
    ``str(path)``) followed by its raw bytes. Mirrors ``compute_task_template_hash``
    with one difference: files under a :data:`GRADER_HASH_EXCLUDED` path
    component and symlinks are skipped, so run debris never enters the grader's
    identity. Returns ``None`` when the gates directory is unavailable and
    never raises for missing/unreadable files.
    """
    if gates is None or not gates.is_dir():
        return None
    digest = hashlib.sha256()
    files = sorted(
        (p for p in gates.rglob("*") if p.is_file()), key=lambda p: str(p)
    )
    for path in files:
        try:
            rel_parts = path.relative_to(gates).parts
            if path.is_symlink() or any(
                part in GRADER_HASH_EXCLUDED for part in rel_parts
            ):
                continue
            rel = str(path.relative_to(gates))
            digest.update(rel.encode("utf-8"))
            digest.update(path.read_bytes())
        except OSError:
            continue
    return digest.hexdigest()
