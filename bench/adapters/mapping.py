"""Session mapping: join check-point phases to transcript entry ranges.

At cell teardown the harness exports the container's opencode session DB and
the run's check-point index (``<cell>/checkpoints/index.json``). This module
emits ``<cell>/mapping.json``: for every check-point phase, the inclusive
``[start, end]`` range of transcript entry sequence numbers (as produced by
:func:`bench.adapters.transcript.read_kept_entries`) that belong to it.

Phase boundaries come from the user-events sidecar: each feedback event
carries the exact user text that opened its attempt, and the transcript's
kept user entries are matched monotonically (in file order, each match
strictly after the previous one). The attempt-1 "initial" phase starts at
entry 1; every later phase starts at its feedback boundary; the last phase
ends at the final entry.

Fail-open contract: :func:`write_session_mapping` NEVER raises. On missing or
unreadable inputs it writes an honest degraded mapping (``phases: []`` or
``entries: null`` plus a ``notice``) and returns the matching status label
(``"absent-index"``, ``"unreadable-index"``, ``"absent-db"``, ``"unreadable"``);
``"ok"`` means the mapping was built from a readable index and session DB.

Pure stdlib and self-contained; reads the index from the GIVEN path and
deliberately does NOT import checkpoint.py.
"""

import json
import logging
from pathlib import Path

from .transcript import read_kept_entries

_LOG = logging.getLogger(__name__)


def write_session_mapping(
    *,
    session_db_path: Path,
    checkpoint_index_path: Path,
    mapping_path: Path,
    user_events_path: Path | None = None,
    run_id: str | None = None,
) -> str:
    """Write ``mapping.json`` joining check-point phases to entry ranges.

    Returns a short status label in {"ok", "absent-index", "unreadable-index",
    "absent-db", "unreadable"}. Fail-open: NEVER raises.
    """
    try:
        try:
            index = _load_index(checkpoint_index_path)
        except (ValueError, OSError) as exc:
            _write_mapping(
                mapping_path,
                {
                    "run_id": run_id,
                    "phases": [],
                    "notice": (
                        "checkpoint index unreadable: "
                        f"{exc.__class__.__name__}"
                    ),
                },
            )
            return "unreadable-index"
        if index is None:
            _write_mapping(
                mapping_path,
                {
                    "run_id": run_id,
                    "phases": [],
                    "notice": f"checkpoint index absent: {checkpoint_index_path}",
                },
            )
            return "absent-index"

        checkpoints = sorted(
            (
                c
                for c in index["checkpoints"]
                if isinstance(c, dict) and isinstance(c.get("attempt"), int)
            ),
            key=lambda c: c["attempt"],
        )
        mapping_run_id = index.get("run_id") or run_id

        if not session_db_path.is_file():
            phases = [
                {
                    "phase": c.get("phase"),
                    "attempt": c["attempt"],
                    "checkpoint": c.get("id"),
                    "entries": None,
                }
                for c in checkpoints
            ]
            _write_mapping(
                mapping_path,
                {
                    "run_id": mapping_run_id,
                    "phases": phases,
                    "notice": f"session db absent: {session_db_path}",
                },
            )
            return "absent-db"

        entries = read_kept_entries(session_db_path)
        feedback_events = _read_feedback_events(user_events_path)
        phases, notices = _build_phases(checkpoints, entries, feedback_events)
        if not entries:
            notices.append(
                "session db yielded no transcriptable entries "
                "(empty or unreadable)"
            )
        payload = {"run_id": mapping_run_id, "phases": phases}
        if notices:
            payload["notice"] = "; ".join(notices)
        _write_mapping(mapping_path, payload)
        return "ok"
    except Exception as exc:
        _LOG.warning(
            "session mapping failed path=%s error_class=%s",
            mapping_path,
            exc.__class__.__name__,
        )
        try:
            _write_mapping(
                mapping_path,
                {
                    "run_id": run_id,
                    "phases": [],
                    "notice": f"mapping failed: {exc.__class__.__name__}",
                },
            )
        except OSError:
            _LOG.warning(
                "session mapping notice unwritable path=%s", mapping_path
            )
        return "unreadable"


def _load_index(index_path: Path) -> dict | None:
    """Return the parsed check-point index, or None when the file is absent.

    Raises ValueError when the file is present but not a JSON object, or its
    ``checkpoints`` member is not a list; OSError propagates from the read.
    """
    if not index_path.is_file():
        return None
    index = json.loads(index_path.read_text(encoding="utf-8"))
    if not isinstance(index, dict):
        raise ValueError("checkpoint index is not a JSON object")
    if not isinstance(index.get("checkpoints"), list):
        raise ValueError("checkpoint index 'checkpoints' is not a list")
    return index


def _read_feedback_events(
    user_events_path: Path | None,
) -> list[tuple[int, str]]:
    """Return (attempt, text) feedback events from the sidecar, in file order.

    The sidecar is JSONL, one compact object per line; blank and unparseable
    lines are skipped. Only records with ``type == "user"``,
    ``kind == "feedback"``, an int ``attempt`` and a str ``text`` are kept.
    Returns [] when the path is None or the file is missing.
    """
    if user_events_path is None or not user_events_path.is_file():
        return []
    events: list[tuple[int, str]] = []
    for line in user_events_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if not isinstance(rec, dict):
            continue
        if rec.get("type") != "user" or rec.get("kind") != "feedback":
            continue
        attempt = rec.get("attempt")
        text = rec.get("text")
        if isinstance(attempt, int) and isinstance(text, str):
            events.append((attempt, text))
    return events


def _build_phases(
    checkpoints: list, entries: list[dict], feedback_events: list[tuple[int, str]]
) -> tuple[list[dict], list[str]]:
    """Join check-points and feedback boundaries into phase entry ranges.

    Returns (phases, notices). Each phase object has exactly the keys
    ``phase``, ``attempt``, ``checkpoint`` (id or None) and ``entries``
    (inclusive [start, end] or None).
    """
    user_entries = [
        (e["seq"], e["text"]) for e in entries if e["role"] == "user"
    ]
    boundaries: dict[int, int] = {}
    unmatched: list[int] = []
    last_seq = 0
    for attempt, text in feedback_events:
        matched = None
        for seq, etext in user_entries:
            if seq > last_seq and etext == text:
                matched = seq
                break
        if matched is None:
            unmatched.append(attempt)
        else:
            boundaries[attempt] = matched
            last_seq = matched

    cp_by_attempt: dict[int, dict] = {}
    for c in checkpoints:
        if isinstance(c, dict) and isinstance(c.get("attempt"), int):
            cp_by_attempt.setdefault(c["attempt"], c)

    all_attempts = sorted(set(cp_by_attempt) | set(boundaries))
    n = len(entries)
    phases: list[dict] = []
    notices: list[str] = []
    for i, attempt in enumerate(all_attempts):
        cp = cp_by_attempt.get(attempt)
        start = 1 if attempt == 1 else boundaries.get(attempt)
        if start is None:
            rng = None
            notices.append(
                f"attempt {attempt}: no phase boundary found in transcript"
            )
        elif i == len(all_attempts) - 1:
            rng = [start, n] if start <= n else None
        else:
            next_attempt = all_attempts[i + 1]
            next_start = (
                1 if next_attempt == 1 else boundaries.get(next_attempt)
            )
            if next_start is None:
                rng = None
                notices.append(
                    f"attempt {attempt}: next boundary "
                    f"(attempt {next_attempt}) not found"
                )
            else:
                end = next_start - 1
                rng = [start, end] if start <= end else None
        label = (
            cp["phase"]
            if cp
            else ("initial" if attempt == 1 else f"feedback-{attempt - 1}")
        )
        phases.append(
            {
                "phase": label,
                "attempt": attempt,
                "checkpoint": cp["id"] if cp else None,
                "entries": rng,
            }
        )
    for attempt in unmatched:
        notices.append(
            f"feedback event attempt {attempt}: text not matched to any "
            "transcript user entry"
        )
    return phases, notices


def _write_mapping(mapping_path: Path, payload: dict) -> None:
    mapping_path.write_text(
        json.dumps(payload, indent=2) + "\n", encoding="utf-8"
    )
