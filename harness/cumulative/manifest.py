"""Durable manifest state for cumulative benchmark sequencing runs."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
import tempfile
from typing import Any, Mapping

from .types import (
    CUMULATIVE_SCHEMA_VERSION,
    RosterEntry,
    ScheduledSession,
    SessionRecord,
)


def _utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _mapping_list(value: Any, *, field_name: str) -> list[Mapping[str, Any]]:
    if not isinstance(value, list):
        raise ValueError(f"manifest field {field_name!r} must be an array")

    out: list[Mapping[str, Any]] = []
    for index, item in enumerate(value):
        if not isinstance(item, Mapping):
            raise ValueError(
                f"manifest field {field_name!r} entry at index {index} must be an object"
            )
        out.append(item)
    return out


def roster_hash(roster: list[RosterEntry]) -> str:
    canonical = [entry.canonical() for entry in roster]
    payload = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass
class CumulativeManifest:
    created_at: str
    task: str
    org_id: str
    roster: list[RosterEntry]
    roster_hash: str
    config_fingerprint: str
    # THE APPEND LOG: one entry per clicked cell, in click order. Never
    # precomputed — ``sequence_index`` is this list's ordinal, so appending is
    # the only way a cell comes into existence.
    schedule: list[ScheduledSession]
    session_records: list[SessionRecord]
    updated_at: str
    schema_version: int = CUMULATIVE_SCHEMA_VERSION
    run_context: dict[str, Any] | None = None
    chunk_plan_hash: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": int(self.schema_version),
            "created_at": self.created_at,
            "task": self.task,
            "org_id": self.org_id,
            "roster": [entry.to_dict() for entry in self.roster],
            "roster_hash": self.roster_hash,
            "config_fingerprint": self.config_fingerprint,
            "schedule": [session.to_dict() for session in self.schedule],
            "session_records": [record.to_dict() for record in self.session_records],
            "updated_at": self.updated_at,
            "run_context": self.run_context,
            "chunk_plan_hash": self.chunk_plan_hash,
        }

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> CumulativeManifest:
        roster_data = _mapping_list(d["roster"], field_name="roster")
        schedule_data = _mapping_list(d["schedule"], field_name="schedule")
        records_data = _mapping_list(d["session_records"], field_name="session_records")

        return cls(
            schema_version=int(d["schema_version"]),
            created_at=str(d["created_at"]),
            task=str(d["task"]),
            org_id=str(d["org_id"]),
            roster=[RosterEntry.from_dict(item) for item in roster_data],
            roster_hash=str(d["roster_hash"]),
            config_fingerprint=str(d["config_fingerprint"]),
            schedule=[ScheduledSession.from_dict(item) for item in schedule_data],
            session_records=[SessionRecord.from_dict(item) for item in records_data],
            updated_at=str(d["updated_at"]),
            run_context=dict(d["run_context"])
            if isinstance(d.get("run_context"), Mapping)
            else None,
            chunk_plan_hash=str(d.get("chunk_plan_hash") or ""),
        )


def atomic_write(path: str | os.PathLike[str], manifest: CumulativeManifest) -> None:
    manifest_path = os.fspath(path)
    parent = os.path.dirname(manifest_path) or "."
    os.makedirs(parent, exist_ok=True)

    rendered = json.dumps(manifest.to_dict(), sort_keys=True, indent=2) + "\n"

    fd, tmp_path = tempfile.mkstemp(
        prefix=f".{os.path.basename(manifest_path)}.tmp-",
        dir=parent,
        text=True,
    )

    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(rendered)
            handle.flush()
            os.fsync(handle.fileno())
            os.fchmod(handle.fileno(), 0o644)
        os.replace(tmp_path, manifest_path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except FileNotFoundError:
            pass
        raise


def load(path: str | os.PathLike[str]) -> CumulativeManifest:
    manifest_path = os.fspath(path)
    with open(manifest_path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)

    if not isinstance(payload, Mapping):
        raise ValueError(f"manifest at {manifest_path} must decode to an object")
    return CumulativeManifest.from_dict(payload)


def validate_or_fail(
    manifest: CumulativeManifest,
    *,
    expected_roster: list[RosterEntry],
    expected_task: str,
    expected_chunk_plan_hash: str = "",
) -> None:
    if manifest.schema_version != CUMULATIVE_SCHEMA_VERSION:
        raise ValueError(
            "cannot resume: manifest schema mismatch "
            f"({manifest.schema_version} vs {CUMULATIVE_SCHEMA_VERSION}); start a fresh run"
        )

    expected_hash = roster_hash(expected_roster)
    if manifest.roster_hash != expected_hash:
        raise ValueError(
            "cannot resume: roster hash drift detected "
            f"(manifest={manifest.roster_hash} expected={expected_hash}); start a fresh run"
        )

    if manifest.task != expected_task:
        raise ValueError(
            "cannot resume: task drift detected "
            f"(manifest={manifest.task!r} expected={expected_task!r}); start a fresh run"
        )

    if manifest.chunk_plan_hash != expected_chunk_plan_hash:
        raise ValueError(
            "cannot resume: chunk-plan hash drift detected "
            f"(manifest={manifest.chunk_plan_hash} expected={expected_chunk_plan_hash}); "
            "start a fresh run"
        )


def resume_or_create(
    path: str | os.PathLike[str],
    *,
    roster: list[RosterEntry],
    task: str,
    org_id: str,
    config_fingerprint: str,
    run_context: Mapping[str, Any] | None = None,
    chunk_plan_hash: str = "",
) -> CumulativeManifest:
    manifest_path = os.fspath(path)
    if os.path.exists(manifest_path):
        existing = load(manifest_path)
        validate_or_fail(
            existing,
            expected_roster=roster,
            expected_task=task,
            expected_chunk_plan_hash=chunk_plan_hash,
        )
        return existing

    now = _utc_now_iso()
    created = CumulativeManifest(
        created_at=now,
        task=task,
        org_id=org_id,
        roster=list(roster),
        roster_hash=roster_hash(roster),
        config_fingerprint=config_fingerprint,
        # A new campaign has clicked nothing yet: the log starts empty and the
        # first cell is appended by the launch that creates the manifest.
        schedule=[],
        session_records=[],
        updated_at=now,
        schema_version=CUMULATIVE_SCHEMA_VERSION,
        run_context=dict(run_context) if run_context is not None else None,
        chunk_plan_hash=chunk_plan_hash,
    )
    atomic_write(manifest_path, created)
    return created


__all__ = [
    "CumulativeManifest",
    "atomic_write",
    "load",
    "resume_or_create",
    "roster_hash",
    "validate_or_fail",
]
