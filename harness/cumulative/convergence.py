"""Derived read-only convergence trend over checkpointed per-session progress.

This module computes a rollup from ``SessionRecord.progress`` values already
persisted in the cumulative manifest checkpoint. It does not add or mutate any
checkpoint schema fields.

Design invariants:
- Derived-only: trend is computed on read from existing session records.
- None-honest: ``None`` means unavailable; ``None`` values are excluded from
  aggregates and are never silently zero-filled.
- Repo hash/version convention: canonical JSON (sorted keys, compact
  separators) + SHA-256 fingerprint.
- Safe output/logging surface: counts, timings, and fingerprints only.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
import hashlib
import json
from typing import Any

from .types import SessionRecord

CONVERGENCE_SCHEMA_VERSION = 1

# The contention-covariate subset of the status-stream ``progress`` dict
# (ProgressVector.to_dict fields), measured on BOTH memory arms via the spend
# DB. Fixed tuple: no invented metrics. None means not measured (e.g. spend DB
# unavailable) — never zero-filled. Visibility only: these fields gate nothing.
CONTENTION_FIELDS = (
    "http_429_count",
    "http_402_count",
    "retry_count",
    "upstream_error_count",
    "max_request_ms",
    "median_request_ms",
    "wall_near_timeout",
)


def _coerce_optional_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool) or isinstance(value, str):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not value.is_integer():
            return None
        return int(value)
    try:
        coerced = int(value)
    except (TypeError, ValueError):
        return None
    if isinstance(value, bytes | bytearray):
        return None
    return coerced


def _coerce_int(value: Any, *, default: int) -> int:
    parsed = _coerce_optional_int(value)
    if parsed is None:
        return default
    return parsed


def _coerce_optional_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool) or isinstance(value, str):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _coerce_float(value: Any, *, default: float) -> float:
    if value is None or isinstance(value, bool) or isinstance(value, str):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class ConvergencePoint:
    sequence_index: int
    session_fp: str
    problems_before: int | None
    problems_after: int | None
    resolved_count: int | None
    remaining_count: int | None
    full_green: bool
    attempts_to_green: int | None
    # THE MODULE DOCSTRING'S "None-honest… never silently zero-filled" WAS FALSE
    # FOR THESE FOUR until 2026-09-04: they were coerced with `default=0`, which
    # is a second zero-fill layer beneath progress.py's. Now they carry absence.
    turns: int | None
    total_tokens: int | None
    wall_seconds: float | None
    wall_cost_usd: float | None
    tool_calls: int | None
    test_invocations: int | None
    agentic_cycles: int | None
    seeded_from_snapshot: str | None = None
    build_phase_ran: bool = False
    skipped_build_cost: dict[str, Any] | None = None
    dev_mode: bool = False
    # WO-CONCUR-07: the contention covariates this session was gathered under,
    # mirrored from the progress dict's CONTENTION_FIELDS (visibility, never a
    # gate). None only on a point constructed without a progress mapping; a
    # per-field None means that covariate was not measured.
    contention: dict[str, Any] | None = None

    @classmethod
    def from_session_record(cls, record: SessionRecord) -> ConvergencePoint | None:
        """Build a point from one scored session.

        Returns ``None`` when ``record.progress`` is missing, which represents a
        not-yet-scored session and is excluded from the convergence trend.
        """

        progress = record.progress
        if not isinstance(progress, Mapping):
            return None

        session_fp = str(record.session_fp or "").strip()
        if not session_fp:
            session_id = str(record.session_id or "").strip()
            session_fp = (
                SessionRecord.session_fp_of(session_id) if session_id else "none"
            )

        skipped_build_cost = getattr(record, "skipped_build_cost", None)

        return cls(
            sequence_index=int(record.sequence_index),
            session_fp=session_fp,
            problems_before=_coerce_optional_int(progress.get("problems_before")),
            problems_after=_coerce_optional_int(progress.get("problems_after")),
            resolved_count=_coerce_optional_int(progress.get("resolved_count")),
            remaining_count=_coerce_optional_int(progress.get("remaining_count")),
            full_green=bool(progress.get("full_green", False))
            if isinstance(progress.get("full_green", False), bool)
            else False,
            attempts_to_green=_coerce_optional_int(progress.get("attempts_to_green")),
            turns=_coerce_optional_int(progress.get("turns")),
            total_tokens=_coerce_optional_int(progress.get("total_tokens")),
            wall_seconds=_coerce_optional_float(progress.get("wall_seconds")),
            wall_cost_usd=_coerce_optional_float(progress.get("wall_cost_usd")),
            tool_calls=_coerce_optional_int(progress.get("tool_calls")),
            test_invocations=_coerce_optional_int(progress.get("test_invocations")),
            agentic_cycles=_coerce_optional_int(progress.get("agentic_cycles")),
            seeded_from_snapshot=getattr(record, "seeded_from_snapshot", None),
            build_phase_ran=bool(getattr(record, "build_phase_ran", False)),
            skipped_build_cost=dict(skipped_build_cost)
            if isinstance(skipped_build_cost, Mapping)
            else None,
            dev_mode=bool(getattr(record, "dev_mode", False)),
            contention={name: progress.get(name) for name in CONTENTION_FIELDS},
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "sequence_index": self.sequence_index,
            "session_fp": self.session_fp,
            "problems_before": self.problems_before,
            "problems_after": self.problems_after,
            "resolved_count": self.resolved_count,
            "remaining_count": self.remaining_count,
            "full_green": self.full_green,
            "attempts_to_green": self.attempts_to_green,
            "turns": self.turns,
            "total_tokens": self.total_tokens,
            "wall_seconds": self.wall_seconds,
            "wall_cost_usd": self.wall_cost_usd,
            "tool_calls": self.tool_calls,
            "test_invocations": self.test_invocations,
            "agentic_cycles": self.agentic_cycles,
            "seeded_from_snapshot": self.seeded_from_snapshot,
            "build_phase_ran": self.build_phase_ran,
            "skipped_build_cost": self.skipped_build_cost,
            "dev_mode": self.dev_mode,
            "contention": self.contention,
        }


@dataclass(frozen=True)
class ConvergenceTrend:
    schema_version: int
    points: tuple[ConvergencePoint, ...]
    sessions_completed: int
    sessions_green: int
    resolved_total: int | None
    # A TOTAL OVER A HOLE IS NOT A TOTAL. Each of these follows `resolved_total`:
    # None values are excluded from the sum, and a set with no measured value at
    # all sums to None rather than to 0.
    tokens_total: int | None
    wall_seconds_total: float | None
    wall_cost_usd_total: float | None

    @property
    def trend_hash(self) -> str:
        """First-8 SHA-256 fingerprint of canonical JSON point dicts.

        This hash is intended for safe log correlation and derived-state
        fingerprinting.
        """

        canonical_points = [point.to_dict() for point in self.points]
        payload = json.dumps(canonical_points, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:8]

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "points": [point.to_dict() for point in self.points],
            "sessions_completed": self.sessions_completed,
            "sessions_green": self.sessions_green,
            "resolved_total": self.resolved_total,
            "tokens_total": self.tokens_total,
            "wall_seconds_total": self.wall_seconds_total,
            "wall_cost_usd_total": self.wall_cost_usd_total,
            "trend_hash": self.trend_hash,
        }


def build_convergence_trend(
    session_records: Iterable[SessionRecord],
) -> ConvergenceTrend:
    points = tuple(
        sorted(
            (
                point
                for point in (
                    ConvergencePoint.from_session_record(record)
                    for record in session_records
                )
                if point is not None
            ),
            key=lambda point: point.sequence_index,
        )
    )

    def _total(attr: str) -> Any:
        values = [
            value
            for value in (getattr(point, attr) for point in points)
            if value is not None
        ]
        return sum(values) if values else None

    return ConvergenceTrend(
        schema_version=CONVERGENCE_SCHEMA_VERSION,
        points=points,
        sessions_completed=len(points),
        sessions_green=sum(1 for point in points if point.full_green),
        resolved_total=_total("resolved_count"),
        tokens_total=_total("total_tokens"),
        wall_seconds_total=_total("wall_seconds"),
        wall_cost_usd_total=_total("wall_cost_usd"),
    )


__all__ = [
    "CONTENTION_FIELDS",
    "CONVERGENCE_SCHEMA_VERSION",
    "ConvergencePoint",
    "ConvergenceTrend",
    "build_convergence_trend",
]
