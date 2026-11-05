"""One cell's cost record, derived from its on-disk artifacts — not from memory.

WHY DISK AND NOT THE ADAPTER RESULT. ``cost.json`` is written from a ``finally``
so that EVERY ending lands a record, and the endings it exists for are exactly
the ones with no adapter result: stopped by hand (``KeyboardInterrupt``),
crashed, capped, or killed mid-round. A record assembled from the in-memory
``result`` goes blank precisely on the cells an operator most needs priced.
Everything needed is already on disk, written before the cell could die:

* ``session-db/opencode.db`` — the exported session DB: every assistant
  message's token counts, and the completed compactions.
* ``live.jsonl`` — the cell's wall anchors (``cell.start`` / ``cell.end``), the
  first graded round's ``attempt.end``, and the operator pauses.
* ``attempt-N-report.json`` — each round's gate verdicts.

THE TWO PHASES AND THE BOUNDARY BETWEEN THEM. A cell runs a BUILD phase and then
zero or more TROUBLESHOOTING rounds. The boundary is the FIRST graded round's
END — the ``attempt.end`` of attempt 1 — because "build" means everything up to
and including the first grade. Messages at or before it are build, messages
after it are troubleshooting; attempt 1's grades are the build's and attempts
2..N are the troubleshooting rounds'.

ABSENT, NEVER ZERO. Every field is omitted when it was not observed: no session
DB means no token sums and no turn counts, no anchors mean no wall, an ungraded
phase carries no ``grades``. A genuinely observed zero (a run that never wrote
cache reports ``cache_write_tokens: 0``) is written as ``0``. ``cost_usd`` is
NEVER emitted here: pricing lives only on the in-memory result and a local model
has no dollars at all, so a total carrying dollars would be a fiction. A
consumer reads a missing key as "not observed", which is the truth.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from harness.adapters.challenge.memory_record import compaction_timestamps
from harness.context_budget import message_context_tokens

#: Exported session DB, relative to the cell dir. Read through the WAL, not an
#: immutable snapshot (see :func:`_session_messages`).
_SESSION_DB_PATH = Path("session-db") / "opencode.db"
#: The live stream: the cell's only wall-clock anchors.
_LIVE_FILENAME = "live.jsonl"

#: The gate statuses that constitute a GRADED outcome (the vocabulary
#: ``grader/gate-results.mjs`` publishes as GATE_STATUSES). ``not_run`` and
#: ``error`` are the instrument's own silence and its own fault — they belong to
#: a suite's denominator, never to a passed/failed count, because scoring them
#: as failures would score the harness instead of the cell.
_GRADED_GATE_STATUSES = frozenset({"pass", "fail"})

#: Phase fields that ADD UP across a cell's two phases. ``context_peak`` is
#: deliberately absent: peaks do not sum, they take the maximum.
_ADDITIVE_PHASE_FIELDS = (
    "input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "turns",
    "compactions",
    "wall_seconds",
)

_ASSISTANT_MESSAGES_SQL = (
    "SELECT time_created, data FROM message "
    "WHERE json_extract(data, '$.role') = 'assistant' "
    "ORDER BY time_created ASC, rowid ASC"
)


def _read_json_object(path: Path) -> dict[str, Any] | None:
    """Read one JSON object; None when it is missing, unreadable or not an object."""
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _attempt_report_indices(run_dir: Path) -> list[int]:
    """Attempt numbers whose ``attempt-N-report.json`` exists in the cell dir.

    The FILES, not ``result.attempt_reports``: the cost writer runs in a
    ``finally`` that must also cover the exits with no result at all (stopped,
    crashed, capped), and the grader publishes each report before the loop can
    die — so the files are the only grade source that survives every exit.
    """
    try:
        names = [entry.name for entry in Path(run_dir).glob("attempt-*-report.json")]
    except OSError:
        return []
    indices: list[int] = []
    for name in names:
        stem = name.removeprefix("attempt-").removesuffix("-report.json")
        if stem.isdigit():
            indices.append(int(stem))
    return sorted(indices)


def _grades_from_reports(run_dir: Path, attempts: list[int]) -> dict[str, int] | None:
    """Graded gate outcomes across ``attempts``; None when nothing was graded.

    ``total`` is the graded denominator (passed + failed), so the three numbers
    are always internally consistent. ABSENT, never zeros, when no report in the
    slice published a ``gate_results`` row with a decided status: a phase that
    was never graded must not read as a phase that graded nothing and passed.
    """
    passed = 0
    failed = 0
    graded = False
    for attempt in attempts:
        report = _read_json_object(run_dir / f"attempt-{attempt}-report.json")
        if report is None:
            continue
        rows = report.get("gate_results")
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, Mapping):
                continue
            status = row.get("status")
            if status not in _GRADED_GATE_STATUSES:
                continue
            if status == "pass":
                passed += 1
            else:
                failed += 1
            graded = True
    if not graded:
        return None
    return {"total": passed + failed, "passed": passed, "failed": failed}


@dataclass(frozen=True)
class _Timeline:
    """The cell's wall clock, as the live stream recorded it (all ms-epoch).

    ``pauses`` holds RESOLVED spans ``(start, end)``: a ``pause.end`` closes the
    pause it belongs to, and a ``pause.start`` with no release stays open until
    ``cell.end`` — a cell stopped inside a pause never emits one, and that hold
    is still time the cell did not spend working.
    """

    start_ms: int | None = None
    end_ms: int | None = None
    boundary_ms: int | None = None
    pauses: tuple[tuple[int, int], ...] = ()


def _live_events(path: Path) -> list[dict[str, Any]]:
    """Every well-formed record in the live stream; ``[]`` when it is unreadable.

    A truncated final line is normal (the stream is appended while the cell
    runs), so a garbled line is skipped, never fatal.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    events: list[dict[str, Any]] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            events.append(value)
    return events


def _stamp(event: Mapping[str, Any]) -> int | None:
    """A record's ``ts`` as int ms-epoch; None when it carries none."""
    try:
        return int(event.get("ts"))
    except (TypeError, ValueError):
        return None


def _first_stamp(events: list[dict[str, Any]], kind: str) -> int | None:
    """``ts`` of the FIRST record of ``kind``; None when the kind never appeared."""
    for event in events:
        if event.get("kind") == kind:
            stamp = _stamp(event)
            if stamp is not None:
                return stamp
    return None


def _graded_boundary_ms(events: list[dict[str, Any]]) -> int | None:
    """``attempt.end`` of attempt 1 — the moment the build phase ended.

    The first graded round's END, not a timestamp in the DB: the DB only knows
    message times, so only the stream can say where one phase stopped and the
    next began.
    """
    for event in events:
        if event.get("kind") != "attempt.end" or event.get("attempt") != 1:
            continue
        stamp = _stamp(event)
        if stamp is not None:
            return stamp
    return None


def _pauses(
    events: list[dict[str, Any]], end_ms: int | None
) -> tuple[tuple[int, int], ...]:
    """Operator pauses as resolved ``(start, end)`` spans, clamped to the cell.

    A pause is released by the next ``pause.end``; one still open when the cell
    ends is counted up to ``cell.end`` (and dropped when there is no cell end to
    measure it against, because an unclosable span has no length to report).

    ONE pause at a time. The cell holds a single stack while paused, so a
    ``pause.start`` that arrives while a span is already open cannot be a second,
    nested hold — taking both would subtract the same held milliseconds twice and
    break the identity ``build + troubleshooting == cell wall - paused``. The
    later start is ignored; the earlier span extends to the release.
    """
    spans: list[tuple[int, int]] = []
    open_start: int | None = None
    for event in events:
        kind = event.get("kind")
        if kind == "pause.start":
            if open_start is None:
                open_start = _stamp(event)
        elif kind == "pause.end":
            stamp = _stamp(event)
            if stamp is None or open_start is None:
                continue
            spans.append((open_start, stamp))
            open_start = None
    if open_start is not None and end_ms is not None:
        spans.append((open_start, end_ms))
    if end_ms is None:
        return tuple(spans)
    # A hold cannot extend past the cell's own end, so both bounds clamp to it.
    return tuple((min(start, end_ms), min(end, end_ms)) for start, end in spans)


def _timeline(live: Path) -> _Timeline:
    """The cell's anchors and pauses; every field None/empty when unrecorded."""
    events = _live_events(live)
    end_ms = _first_stamp(events, "cell.end")
    return _Timeline(
        start_ms=_first_stamp(events, "cell.start"),
        end_ms=end_ms,
        boundary_ms=_graded_boundary_ms(events),
        pauses=_pauses(events, end_ms),
    )


def _walls(timeline: _Timeline) -> tuple[float | None, float | None, float | None]:
    """(build wall, troubleshooting wall, paused) in seconds.

    Wall is elapsed time NET of operator pauses. A pause is whole-phase, booked
    to the phase it STARTED in: a hold the cell entered inside the build is build
    time, even if the release lands after the boundary.

    No boundary (no graded round closed) means the whole cell is build — there is
    no span to split off, so the troubleshooting span is zero and the full net
    wall stays on build. A boundary at or after ``cell.end`` is the same case.
    """
    start_ms = timeline.start_ms
    end_ms = timeline.end_ms
    if start_ms is None or end_ms is None:
        return (None, None, None)
    boundary_ms = timeline.boundary_ms
    split = boundary_ms is not None and boundary_ms < end_ms
    build_paused_ms = 0
    troubleshooting_paused_ms = 0
    for pause_start, pause_end in timeline.pauses:
        duration = max(0, pause_end - pause_start)
        if split and pause_start > boundary_ms:
            troubleshooting_paused_ms += duration
        else:
            build_paused_ms += duration
    paused_seconds = (build_paused_ms + troubleshooting_paused_ms) / 1000.0
    if not split:
        return (
            max(0, (end_ms - start_ms) - build_paused_ms) / 1000.0,
            0.0,
            paused_seconds,
        )
    build_wall = max(0, (boundary_ms - start_ms) - build_paused_ms) / 1000.0
    troubleshooting_wall = (
        max(0, (end_ms - boundary_ms) - troubleshooting_paused_ms) / 1000.0
    )
    return (build_wall, troubleshooting_wall, paused_seconds)


def _session_messages(session_db: Path) -> list[tuple[Any, ...]] | None:
    """Every assistant message as ``(time_created, data)``; None if unreadable.

    Opened ``mode=ro`` through the URI, never ``immutable=1`` and never
    ``-readonly``: the export's last writes can still be sitting in its WAL tail,
    and an immutable handle would silently read the DB as of its last checkpoint
    — dropping exactly the final turns a stopped cell was writing when it died.
    """
    if not session_db.is_file():
        return None
    try:
        conn = sqlite3.connect(f"file:{session_db}?mode=ro", uri=True, timeout=5.0)
    except sqlite3.Error:
        return None
    try:
        return conn.execute(_ASSISTANT_MESSAGES_SQL).fetchall()
    except sqlite3.Error:
        return None
    finally:
        conn.close()


def _json_object(raw: Any) -> dict[str, Any]:
    """A decoded JSON object from a message row; ``{}`` when it is not one."""
    try:
        value = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _count(value: Any) -> int:
    """A token count as int; ``0`` for a value the message never carried."""
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


class _PhaseTotals:
    """What the session DB observed for ONE phase of the cell.

    The counters only exist while messages are attributed to the phase: an
    :meth:`absorbed` phase of ``False`` means "no message landed here", and its
    dict is empty rather than a set of zeros. A local model can legitimately
    report ``cache_write_tokens: 0`` for every message it took — that zero is
    observed and is KEPT, which is precisely why absence has to be an empty dict
    at this level and not a zero-filled one.
    """

    __slots__ = (
        "cache_read_tokens",
        "cache_write_tokens",
        "compactions",
        "context_peak",
        "input_tokens",
        "output_tokens",
        "reasoning_tokens",
        "turns",
    )

    def __init__(self) -> None:
        self.input_tokens = 0
        self.output_tokens = 0
        self.reasoning_tokens = 0
        self.cache_read_tokens = 0
        self.cache_write_tokens = 0
        self.turns = 0
        self.compactions = 0
        self.context_peak: int | None = None

    def absorbed(self) -> bool:
        """Whether any message was attributed to this phase."""
        return bool(self.turns or self.compactions)

    def absorb(self, message: Mapping[str, Any], *, compaction: bool) -> None:
        """Fold one assistant message in, compaction or turn as the DB says."""
        tokens = message.get("tokens")
        tokens = tokens if isinstance(tokens, dict) else {}
        cache = tokens.get("cache")
        cache = cache if isinstance(cache, dict) else {}
        self.input_tokens += _count(tokens.get("input"))
        self.output_tokens += _count(tokens.get("output"))
        self.reasoning_tokens += _count(tokens.get("reasoning"))
        self.cache_read_tokens += _count(cache.get("read"))
        self.cache_write_tokens += _count(cache.get("write"))
        if compaction:
            self.compactions += 1
        else:
            self.turns += 1
        # The same size opencode's own out-of-room check compares
        # (harness/context_budget.py): 0 for an aborted request, so a request
        # that reported nothing never becomes a peak of zero.
        size = message_context_tokens({"tokens": tokens})
        if size > 0 and (self.context_peak is None or size > self.context_peak):
            self.context_peak = size

    def to_dict(self) -> dict[str, Any]:
        """Observed fields only; ``{}`` when the phase took no message."""
        if not self.absorbed():
            return {}
        observed: dict[str, Any] = {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "reasoning_tokens": self.reasoning_tokens,
            "cache_read_tokens": self.cache_read_tokens,
            "cache_write_tokens": self.cache_write_tokens,
            "turns": self.turns,
            "compactions": self.compactions,
        }
        if self.context_peak is not None:
            observed["context_peak"] = self.context_peak
        return observed


def _phase_of(time_created: Any, boundary_ms: int | None) -> str | None:
    """Which phase a message belongs to; None when it cannot be placed.

    With no boundary everything is build. With a boundary, a message whose
    ``time_created`` cannot be read cannot be placed on either side — and
    guessing would move its tokens and turns into a phase that never ran it.
    """
    if boundary_ms is None:
        return "build"
    try:
        stamp = int(time_created)
    except (TypeError, ValueError):
        return None
    return "build" if stamp <= boundary_ms else "troubleshooting"


def _db_phases(
    session_db: Path, boundary_ms: int | None
) -> tuple[_PhaseTotals, _PhaseTotals]:
    """(build, troubleshooting) totals from the exported session DB.

    An unreadable DB yields two EMPTY totals: the caller's phases then carry no
    token, turn or compaction keys at all, which is the honest encoding of a
    session that was never exported.
    """
    build = _PhaseTotals()
    troubleshooting = _PhaseTotals()
    rows = _session_messages(session_db)
    if rows is None:
        return (build, troubleshooting)
    # The DB's own receipt for a COMPLETED compaction: a message whose
    # time_created is one of these is a compaction, not a turn. Anything else
    # (a killed compaction still flagged summary, a plain turn) counts as turns.
    stamps = compaction_timestamps(session_db)
    compactions = frozenset(stamps or ())
    for time_created, raw in rows:
        phase = _phase_of(time_created, boundary_ms)
        if phase is None:
            continue
        message = _json_object(raw)
        is_compaction = _count(time_created) in compactions
        (build if phase == "build" else troubleshooting).absorb(
            message, compaction=is_compaction
        )
    return (build, troubleshooting)


def _total_phase(
    build: Mapping[str, Any], troubleshooting: Mapping[str, Any]
) -> dict[str, Any]:
    """The cell's two phases recombined: additive fields sum, peaks take the max.

    ``cost_usd`` is never emitted here: this path measures tokens only, so a
    total it produces never carries dollars.
    """
    phases = (build, troubleshooting)
    total: dict[str, Any] = {}
    for field in _ADDITIVE_PHASE_FIELDS:
        values = [phase[field] for phase in phases if field in phase]
        if values:
            total[field] = sum(values)
    peaks = [phase["context_peak"] for phase in phases if "context_peak" in phase]
    if peaks:
        total["context_peak"] = max(peaks)
    grades: dict[str, int] = {}
    for phase in phases:
        for name, value in (phase.get("grades") or {}).items():
            grades[name] = grades.get(name, 0) + int(value)
    if grades:
        total["grades"] = grades
    return total


def derive_cost_from_disk(run_dir: Path) -> dict[str, Any]:
    """This cell's cost, built from what survived on disk. NEVER raises.

    Returns ``{"phases": {...}, "paused_seconds": float | None}`` with ``build``,
    ``troubleshooting`` and ``total`` phases, each holding only the fields that
    were observed. Every artifact is optional: the record degrades to whatever
    landed, which is why a cell stopped by hand still gets a full accounting of
    the work it did before it was stopped.

    A phase exists only if it has activity — messages, a grade, or (build only)
    wall time. When the troubleshooting phase never opened, its wall span is
    FOLDED INTO BUILD rather than dropped: the time between the last grade and
    the cell's end still belongs to the build's wall, and losing it would
    understate the cell.
    """
    run_dir = Path(run_dir)
    timeline = _timeline(run_dir / _LIVE_FILENAME)
    build_wall, troubleshooting_wall, paused_seconds = _walls(timeline)
    build_totals, troubleshooting_totals = _db_phases(
        run_dir / _SESSION_DB_PATH, timeline.boundary_ms
    )

    # Attempt 1 is the build's grade (everything up to and including the first
    # grade); attempts 2..N are the troubleshooting rounds by construction, and
    # there is no alternative attribution for them.
    indices = _attempt_report_indices(run_dir)
    build = build_totals.to_dict()
    build_grades = _grades_from_reports(run_dir, [1]) if 1 in indices else None
    if build_grades is not None:
        build["grades"] = build_grades
    troubleshooting = troubleshooting_totals.to_dict()
    troubleshooting_grades = _grades_from_reports(
        run_dir, [attempt for attempt in indices if attempt > 1]
    )
    if troubleshooting_grades is not None:
        troubleshooting["grades"] = troubleshooting_grades

    # Wall alone is enough to make a build: a cell that ran and took no
    # attributable message still consumed real time. Troubleshooting is not
    # given that standing — with no message and no grade it never opened, and
    # its span belongs to the build's fold below. The test reads BOTH spans, so a
    # cell whose entire net wall landed after its boundary still lands somewhere
    # instead of being dropped for lacking a build-side span.
    net_wall_recorded = any(
        wall is not None and wall > 0 for wall in (build_wall, troubleshooting_wall)
    )
    build_opened = bool(build) or net_wall_recorded
    troubleshooting_opened = bool(troubleshooting)

    build_wall_final = build_wall
    troubleshooting_wall_final = troubleshooting_wall
    both_walls = build_wall is not None and troubleshooting_wall is not None
    if build_opened != troubleshooting_opened and both_walls:
        folded = build_wall + troubleshooting_wall
        if build_opened:
            build_wall_final = folded
            troubleshooting_wall_final = None
        else:
            troubleshooting_wall_final = folded
            build_wall_final = None
    if build_opened and build_wall_final is not None:
        build["wall_seconds"] = build_wall_final
    if troubleshooting_opened and troubleshooting_wall_final is not None:
        troubleshooting["wall_seconds"] = troubleshooting_wall_final

    phases: dict[str, Any] = {}
    if build_opened:
        phases["build"] = build
    if troubleshooting_opened:
        phases["troubleshooting"] = troubleshooting
    if phases:
        phases["total"] = _total_phase(build, troubleshooting)
    return {"phases": phases, "paused_seconds": paused_seconds}
