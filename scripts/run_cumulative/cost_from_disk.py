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
  per-phase labels (``phase.start`` / ``attempt.end``), and the operator pauses.
* ``attempt-N-report.json`` — each round's gate verdicts.

THE PHASES, AS THE STREAM LABELS THEM. A cell builds SEVEN phases, one after the
other; each phase's build is then graded, and any rounds spent repairing it run
on that SAME phase. So "build vs troubleshooting" is not one cell-wide split — it
is a split per phase, and only the records can say which is which. Every record
already carries that identity (:func:`harness.prompt_pack.phase_label`):
``phase_index``, ``phase_name``, ``phase_kind`` and — for a layered phase —
``phase_layer``. This module READS those labels; it infers none of them.

* A phase's BUILD span runs from its ``phase.start`` to its OWN first
  ``attempt.end``, so "build" is everything up to and including the grade that
  reads what the phase's build drive wrote.
* Its TROUBLESHOOTING span runs from that grade to where the NEXT phase's build
  started (the cell's end, for the last phase) — which is how the stream says
  this phase's repair rounds are over.
* A grade belongs to the bucket its ``attempt.end`` LABELLED, so a report is
  never placed by its attempt number.

The attempt number says nothing about phases: it is a cell-global counter, and
grading happens PER PHASE, so attempt 1 is layer 1's grade — not the build's.
That is why the old attempt-1 boundary billed six of seven build phases as
troubleshooting, and why it is gone rather than repaired.

Pre-standard cells carry no labels at all (unlabelled data is a throwaway by the
owner's decision 7), so they produce NO phases — there is no fallback split and
no guessed boundary.

ABSENT, NEVER ZERO. Every field is omitted when it was not observed: no session
DB means no token sums and no turn counts, no anchors mean no wall, an ungraded
phase carries no ``grades``. A genuinely observed zero (a run that never wrote
cache reports ``cache_write_tokens: 0``) is written as ``0``. ``cost_usd`` is
NEVER emitted here: pricing lives only on the in-memory result and a local model
has no dollars at all, so a total carrying dollars would be a fiction. A
consumer reads a missing key as "not observed", which is the truth.

TWO READERS, ONE STREAM. :func:`derive_cost_from_disk` derives the phases and
the pause total; :func:`derive_cost_meta` derives the cell's served identity
(``model``/``provider``), its terminal reason, its wall twice (total and
pause-excluded) and where each compaction happened on that measured axis. The
assembled ``cost.json`` is schema_version 2 and is written by
``scripts/run_cumulative/runner.py``, which is also the only place a price row
is attached — ``null`` for a local model, which has no dollars at all.
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

#: The two kinds an interval inside ONE phase can be: the phase's BUILD (its
#: build drive, up to and including the grade that reads it) and its
#: TROUBLESHOOTING rounds (a repair drive and the grade that reads it). These
#: are the values ``phase_kind`` carries on the wire — the vocabulary is the
#: producer's, never a second spelling invented here.
_BUILD = "build"
_TROUBLESHOOTING = "troubleshooting"
_KINDS = (_BUILD, _TROUBLESHOOTING)

#: Bucket fields that ADD UP when buckets are recombined. ``context_peak`` is
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


def _grades_from_reports(run_dir: Path, attempts: list[int]) -> dict[str, Any] | None:
    """How many grades ``attempts`` holds, and what the latest of them found.

    ``count`` is the number of grading passes (attempts whose report published
    a decided gate row); ``last`` is that latest pass's gate outcome, ``total``
    being its graded denominator (passed + failed). Gate counts are NEVER summed
    across passes: run 1793876536 cell 1 read 472 "grades" for two passes of 236
    gates, a number that measures nothing. ABSENT, never zeros, when no report in
    the slice was graded: a phase never graded must not read as one that passed.
    """
    count = 0
    last: dict[str, int] | None = None
    for attempt in attempts:
        report = _read_json_object(run_dir / f"attempt-{attempt}-report.json")
        if report is None:
            continue
        rows = report.get("gate_results")
        if not isinstance(rows, list):
            continue
        passed = 0
        failed = 0
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
        if passed + failed == 0:
            continue
        count += 1
        last = {"total": passed + failed, "passed": passed, "failed": failed}
    if last is None:
        return None
    return {"count": count, "last": last}


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


def _phase_index(event: Mapping[str, Any]) -> int | None:
    """The phase index a labelled record carries; None when it carries none."""
    try:
        return int(event.get("phase_index"))
    except (TypeError, ValueError):
        return None


def _phase_name(event: Mapping[str, Any]) -> str | None:
    """The phase name a labelled record carries; None when it carries none."""
    value = event.get("phase_name")
    return value if isinstance(value, str) and value else None


def _phase_layer(event: Mapping[str, Any]) -> int | None:
    """The grader layer a labelled record carries; None for a backend phase.

    ``phase_layer`` is OMITTED on the wire for a backend phase rather than
    written as ``None`` (:func:`harness.prompt_pack.phase_label`), so absent
    reads as "this phase is not a layer" — never as "unrecorded".
    """
    try:
        return int(event.get("phase_layer"))
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True)
class _Labels:
    """What the live stream's phase labels say — read as ground truth.

    ``starts`` is each phase's build start and ``grades`` its own first grade
    (absolute ms-epoch); ``names``/``layers`` are the identity the producer
    printed on the labels. ``attempts`` maps an attempt number to the
    ``(phase_index, phase_kind)`` ITS OWN ``attempt.end`` published — the only
    attribution a report is allowed to have, because a number never implies a
    phase.
    """

    starts: dict[int, int]
    grades: dict[int, int]
    names: dict[int, str]
    layers: dict[int, int]
    attempts: dict[int, tuple[int, str]]


def _labels(events: list[dict[str, Any]]) -> _Labels:
    """Every phase label the stream published, in one pass.

    Labels are read off ``phase.start`` and ``attempt.end`` and nowhere else:
    both are emitted from :func:`harness.prompt_pack.phase_label`, so the
    identity, the kind and the phase a grade belongs to arrive already decided.
    A record without ``phase_index`` contributes nothing — unlabelled data is
    pre-standard, and a guessed phase would be worse than no phase.
    """
    starts: dict[int, int] = {}
    grades: dict[int, int] = {}
    names: dict[int, str] = {}
    layers: dict[int, int] = {}
    attempts: dict[int, tuple[int, str]] = {}
    for event in events:
        kind = event.get("kind")
        index = _phase_index(event)
        if index is None:
            continue
        name = _phase_name(event)
        if name is not None:
            names.setdefault(index, name)
        layer = _phase_layer(event)
        if layer is not None:
            layers.setdefault(index, layer)
        stamp = _stamp(event)
        if kind == "phase.start":
            if stamp is not None:
                known = starts.get(index)
                if known is None or stamp < known:
                    starts[index] = stamp
        elif kind == "attempt.end":
            if stamp is not None:
                known = grades.get(index)
                if known is None or stamp < known:
                    grades[index] = stamp
            try:
                attempt = int(event.get("attempt"))
            except (TypeError, ValueError):
                continue
            grade_kind = event.get("phase_kind")
            if attempt > 0 and grade_kind in _KINDS:
                attempts.setdefault(attempt, (index, str(grade_kind)))
    return _Labels(
        starts=starts,
        grades=grades,
        names=names,
        layers=layers,
        attempts=attempts,
    )


@dataclass(frozen=True)
class _PhaseSpan:
    """One labelled phase's wall clock, in absolute ms-epoch bounds.

    ``grade_ms`` is the phase's OWN first grade — where its build stops and its
    troubleshooting begins — and ``bound_ms`` is where the NEXT phase's build
    started (or the cell's end), the far edge of its troubleshooting span. Both
    are None when the stream never said.

    A phase the stream labelled but never opened (a truncated head can lose its
    ``phase.start``) has ``start_ms`` None: no wall can be measured for it, but
    its grades still land on IT rather than on a neighbour.
    """

    index: int
    name: str | None
    layer: int | None
    start_ms: int | None
    grade_ms: int | None = None
    bound_ms: int | None = None

    def kind_at(self, ms: int) -> str | None:
        """Which of this phase's two spans ``ms`` falls in; None when neither.

        The build span closes ON its grade INCLUSIVE — "build" is everything up
        to and including the first grade — and troubleshooting runs from just
        after that grade to the bound. Before ``start_ms`` and at/after
        ``bound_ms`` the instant belongs to another phase or to none.
        """
        if self.start_ms is None:
            return None
        if self.grade_ms is None:
            if self.bound_ms is not None and self.start_ms <= ms < self.bound_ms:
                return _BUILD
            return None
        if self.start_ms <= ms <= self.grade_ms:
            return _BUILD
        if self.bound_ms is not None and self.grade_ms < ms < self.bound_ms:
            return _TROUBLESHOOTING
        return None

    def build_ms(self) -> int | None:
        """Build wall, in ms; None when no bound was recorded to measure it to."""
        if self.start_ms is None:
            return None
        end = self.grade_ms if self.grade_ms is not None else self.bound_ms
        return None if end is None else max(0, end - self.start_ms)

    def troubleshoot_ms(self) -> int | None:
        """Troubleshooting wall, in ms; None for a phase that was never graded."""
        if self.grade_ms is None or self.bound_ms is None:
            return None
        return max(0, self.bound_ms - self.grade_ms)


def _phase_spans(labels: _Labels, end_ms: int | None) -> list[_PhaseSpan]:
    """Every labelled phase's window, in the order the build ran them.

    Order is the stream's: a phase's bound is the next phase's build START,
    which is how the stream says this phase's repair rounds are over. Nothing
    here looks at an attempt number, so phase 4's grade can no longer be charged
    to phase 1's build.
    """
    ordered = sorted(labels.starts.items(), key=lambda item: (item[1], item[0]))
    spans: list[_PhaseSpan] = []
    for position, (index, start_ms) in enumerate(ordered):
        bound_ms = ordered[position + 1][1] if position + 1 < len(ordered) else end_ms
        grade_ms = labels.grades.get(index)
        # A grade outside (start, bound] cannot close THIS phase's build: the
        # phase had not opened, or a later phase already had. The grade still
        # counts as a grade (it is labelled to this phase); it just cannot bound
        # a wall, and clamping it would put two phases' spans on the same ms.
        if grade_ms is not None and (
            grade_ms < start_ms or (bound_ms is not None and grade_ms > bound_ms)
        ):
            grade_ms = None
        spans.append(
            _PhaseSpan(
                index=index,
                name=labels.names.get(index),
                layer=labels.layers.get(index),
                start_ms=start_ms,
                grade_ms=grade_ms,
                bound_ms=bound_ms,
            )
        )
    # Labelled but never opened: no wall to measure, and its grades still belong
    # to it. Appended after the opened phases so order stays build order.
    graded = set(labels.grades) | {index for index, _ in labels.attempts.values()}
    for index in sorted(graded - set(labels.starts)):
        spans.append(
            _PhaseSpan(
                index=index,
                name=labels.names.get(index),
                layer=labels.layers.get(index),
                start_ms=None,
                grade_ms=labels.grades.get(index),
            )
        )
    return spans


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
    break the identity ``build + troubleshooting == cell wall - paused`` the
    per-phase roll-ups are summed into. The later start is ignored; the earlier
    span extends to the release.
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


def _bounds(events: list[dict[str, Any]]) -> tuple[int | None, int | None]:
    """The cell's overall (start, end) ms-epoch anchors.

    ``cell.start``/``cell.end`` are the truth. When either is missing — a cell
    killed before it could close, a stream whose tail was cut — the stream's own
    earliest and latest stamps stand in, so a partial stream still measures a
    wall instead of reporting none.
    """
    start_ms = _first_stamp(events, "cell.start")
    end_ms = _first_stamp(events, "cell.end")
    stamps = [stamp for stamp in (_stamp(event) for event in events) if stamp]
    if start_ms is None and stamps:
        start_ms = min(stamps)
    if end_ms is None and stamps:
        end_ms = max(stamps)
    return (start_ms, end_ms)


def _timeline(events: list[dict[str, Any]]) -> _Timeline:
    """The cell's anchors and pauses; every field None/empty when unrecorded."""
    start_ms, end_ms = _bounds(events)
    return _Timeline(
        start_ms=start_ms,
        end_ms=end_ms,
        pauses=_pauses(events, end_ms),
    )


def _paused_ms(
    spans: list[_PhaseSpan], pauses: tuple[tuple[int, int], ...]
) -> tuple[dict[tuple[int, str], int], int]:
    """Paused milliseconds per ``(phase index, kind)`` bucket, and the cell total.

    A pause is booked WHOLE to the bucket its START fell in: a hold the cell
    entered inside a phase's build is build time, even when the release lands
    after that phase's grade. A pause that falls in no span — the final hold,
    taken after the last phase's span closed — is booked to the last phase's
    troubleshooting, which is where an operator holds a finished cell; with no
    phases at all it is booked nowhere and only counted in the total, which is
    what keeps ``build + troubleshooting == cell wall - paused`` true.
    """
    booked: dict[tuple[int, str], int] = {}
    total = 0
    last = spans[-1] if spans else None
    holds_troubleshooting = (
        last is not None
        and last.troubleshoot_ms() is not None
        and last.grade_ms is not None
    )
    for pause_start, pause_end in pauses:
        duration = max(0, pause_end - pause_start)
        total += duration
        bucket = _bucket_at(spans, pause_start)
        if bucket is None and last is not None and holds_troubleshooting:
            bucket = (last.index, _TROUBLESHOOTING)
        if bucket is not None:
            booked[bucket] = booked.get(bucket, 0) + duration
    return booked, total


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


def _bucket_at(spans: list[_PhaseSpan], ms: int) -> tuple[int, str] | None:
    """Which ``(phase index, kind)`` bucket an instant falls in; None elsewhere.

    None is a real answer: an instant before the first phase opened, or past the
    last measured bound, belongs to no phase and its message is counted nowhere
    rather than dropped into a neighbour that never sent it.
    """
    for span in spans:
        kind = span.kind_at(ms)
        if kind is not None:
            return (span.index, kind)
    return None


def _db_phase_totals(
    session_db: Path, spans: list[_PhaseSpan]
) -> dict[tuple[int, str], _PhaseTotals]:
    """Per ``(phase index, kind)`` totals, attributed by the labelled windows.

    An unreadable DB yields an EMPTY mapping: every bucket then carries no
    token, turn or compaction key at all, which is the honest encoding of a
    session that was never exported.
    """
    totals: dict[tuple[int, str], _PhaseTotals] = {}
    rows = _session_messages(session_db)
    if rows is None:
        return totals
    # The DB's own receipt for a COMPLETED compaction: a message whose
    # time_created is one of these is a compaction, not a turn. Anything else
    # (a killed compaction still flagged summary, a plain turn) counts as turns.
    stamps = compaction_timestamps(session_db)
    compactions = frozenset(stamps or ())
    for time_created, raw in rows:
        bucket = _bucket_at(spans, _count(time_created))
        if bucket is None:
            continue
        totals.setdefault(bucket, _PhaseTotals()).absorb(
            _json_object(raw), compaction=_count(time_created) in compactions
        )
    return totals


def _grade_slices(
    attempts: Mapping[int, tuple[int, str]], indices: list[int]
) -> dict[tuple[int, str], list[int]]:
    """The attempt reports on disk, grouped by the label each one published.

    A report whose attempt has no ``attempt.end`` label is in NO slice: nothing
    on disk says which phase graded it, and a guessed attribution is the
    attempt-number inference this replaced.
    """
    slices: dict[tuple[int, str], list[int]] = {}
    for attempt in indices:
        bucket = attempts.get(attempt)
        if bucket is not None:
            slices.setdefault(bucket, []).append(attempt)
    return slices


def _total_phase(*phases: Mapping[str, Any]) -> dict[str, Any]:
    """Buckets recombined: additive fields sum, peaks take the max, grades fold.

    The buckets arrive in CHRONOLOGICAL order (phase order, build before that
    phase's troubleshooting), which is what makes the last graded bucket the
    latest pass — the one ``grades.last`` reports. ``cost_usd`` is never emitted
    here: this path measures tokens only, so a total it produces never carries
    dollars.
    """
    total: dict[str, Any] = {}
    for field in _ADDITIVE_PHASE_FIELDS:
        values = [phase[field] for phase in phases if field in phase]
        if values:
            total[field] = sum(values)
    peaks = [phase["context_peak"] for phase in phases if "context_peak" in phase]
    if peaks:
        total["context_peak"] = max(peaks)
    graded = [phase["grades"] for phase in phases if "grades" in phase]
    if graded:
        total["grades"] = {
            "count": sum(g["count"] for g in graded),
            "last": graded[-1]["last"],
        }
    return total


def _phase_buckets(
    span: _PhaseSpan,
    totals: Mapping[tuple[int, str], _PhaseTotals],
    slices: Mapping[tuple[int, str], list[int]],
    booked: Mapping[tuple[int, str], int],
    run_dir: Path,
) -> dict[str, Any]:
    """One phase's ``by_phase`` entry: its identity and the buckets that opened.

    A bucket exists only if something was observed in it — messages, a grade, or
    (build only) net wall. Wall is folded the way the single-split derivation
    folded it: when only one of a phase's two buckets opened, the other's span
    belongs to it rather than being lost, because the time between a phase's
    grade and the next phase is still time the cell spent on that phase.
    """
    entry: dict[str, Any] = {}
    if span.name is not None:
        entry["name"] = span.name
    if span.layer is not None:
        entry["layer"] = span.layer

    buckets: dict[str, dict[str, Any]] = {}
    for kind in _KINDS:
        bucket: dict[str, Any] = {}
        observed = totals.get((span.index, kind))
        if observed is not None:
            bucket.update(observed.to_dict())
        grades = _grades_from_reports(run_dir, slices.get((span.index, kind), []))
        if grades is not None:
            bucket["grades"] = grades
        buckets[kind] = bucket

    build_ms = span.build_ms()
    if build_ms is not None:
        build_ms = max(0, build_ms - booked.get((span.index, _BUILD), 0))
    troubleshoot_ms = span.troubleshoot_ms()
    if troubleshoot_ms is not None:
        troubleshoot_ms = max(
            0, troubleshoot_ms - booked.get((span.index, _TROUBLESHOOTING), 0)
        )

    opened = {
        _BUILD: bool(buckets[_BUILD]) or (build_ms or 0) > 0,
        # Troubleshooting is not given the wall-alone standing: with no message
        # and no grade it never opened as a PHASE, and its span is folded below.
        _TROUBLESHOOTING: bool(buckets[_TROUBLESHOOTING]),
    }
    if (
        opened[_BUILD] != opened[_TROUBLESHOOTING]
        and build_ms is not None
        and troubleshoot_ms is not None
    ):
        folded = build_ms + troubleshoot_ms
        if opened[_BUILD]:
            build_ms, troubleshoot_ms = folded, None
        else:
            troubleshoot_ms, build_ms = folded, None

    walls = {_BUILD: build_ms, _TROUBLESHOOTING: troubleshoot_ms}
    for kind in _KINDS:
        if not opened[kind]:
            continue
        if walls[kind] is not None:
            buckets[kind]["wall_seconds"] = walls[kind] / 1000.0
        entry[kind] = buckets[kind]
    return entry


def derive_cost_from_disk(run_dir: Path) -> dict[str, Any]:
    """This cell's cost, built from what survived on disk. NEVER raises.

    Returns ``{"phases": {...}, "paused_seconds": float | None}``. ``phases``
    holds ``by_phase`` — one entry per LABELLED phase, keyed by its index — plus
    the ``build``, ``troubleshooting`` and ``total`` roll-ups computed FROM those
    entries. Every bucket holds only the fields that were observed, and the
    roll-ups are absent when they would be empty.

    NO LABELS, NO PHASES. A phase exists because a record said so: its
    ``phase.start`` opened it, its ``attempt.end`` graded it. A cell whose stream
    carries no ``phase_index`` (pre-standard — a throwaway by owner decision 7)
    reports no phases at all rather than a split no record supports; there is no
    fallback that guesses one. The cell's anchor and pause fields survive
    independently, so such a cell still reports its paused seconds.

    Every artifact is optional, which is why a cell stopped by hand still gets a
    full accounting of the work it did before it was stopped.
    """
    run_dir = Path(run_dir)
    events = _live_events(run_dir / _LIVE_FILENAME)
    labels = _labels(events)
    timeline = _timeline(events)
    spans = _phase_spans(labels, timeline.end_ms)
    booked, paused_ms = _paused_ms(spans, timeline.pauses)
    totals = _db_phase_totals(run_dir / _SESSION_DB_PATH, spans)
    slices = _grade_slices(labels.attempts, _attempt_report_indices(run_dir))

    by_phase: dict[str, Any] = {}
    for span in spans:
        entry = _phase_buckets(span, totals, slices, booked, run_dir)
        if entry:
            by_phase[str(span.index)] = entry

    phases: dict[str, Any] = {}
    if by_phase:
        # Phase order is insertion order, and within a phase build precedes
        # troubleshooting, so the roll-ups fold grades in the order they were
        # earned.
        build_total = _total_phase(
            *(entry["build"] for entry in by_phase.values() if "build" in entry)
        )
        troubleshoot_total = _total_phase(
            *(
                entry[_TROUBLESHOOTING]
                for entry in by_phase.values()
                if _TROUBLESHOOTING in entry
            )
        )
        phases["by_phase"] = by_phase
        if build_total:
            phases[_BUILD] = build_total
        if troubleshoot_total:
            phases[_TROUBLESHOOTING] = troubleshoot_total
        total = _total_phase(build_total, troubleshoot_total)
        if total:
            phases["total"] = total

    paused_seconds = (
        None
        if timeline.start_ms is None or timeline.end_ms is None
        else paused_ms / 1000.0
    )
    return {"phases": phases, "paused_seconds": paused_seconds}


def _first_text(
    events: list[dict[str, Any]], kind: str, field: str
) -> str | None:
    """The non-empty ``field`` of the FIRST ``kind`` record carrying one."""
    for event in events:
        if event.get("kind") != kind:
            continue
        value = event.get(field)
        if isinstance(value, str) and value:
            return value
    return None


def derive_cost_meta(run_dir: Path) -> dict[str, Any]:
    """This cell's served identity, wall and compactions, from disk. NEVER raises.

    Returns ``{"model", "provider", "terminal_reason", "cell_wall_seconds",
    "measured_wall_seconds", "compactions": {"count", "positions"}}``. Every
    identity field is read off the stream record that published it —
    ``cell.start`` carries ``model`` (:mod:`harness.adapters.challenge.runner`),
    ``cell.end`` carries ``terminal_reason`` — and never inferred from a label,
    a session DB row or a filename.

    THE WALL IS THE CELL'S, AND ITS MEASURE IS PAUSE-EXCLUDED. ``cell_wall_seconds``
    is ``cell.end - cell.start`` resolved by :func:`_timeline`, so a stream whose
    head or tail was cut still measures what it can. ``measured_wall_seconds``
    subtracts the SAME resolved pause spans :func:`_paused_ms` books against the
    phases — one pause resolution, not a second reading of the pause records.

    A COMPACTION'S POSITION IS WHERE IT HAPPENED, ON THE MEASURED AXIS. Each
    ``compaction`` record contributes its own ``ts`` (ms-epoch), its
    pause-excluded offset from the cell's start (pauses that had already ended
    before ``ts`` are removed, a pause still open at ``ts`` is removed only up to
    ``ts``), and the phase identity the event itself published. The session DB is
    never consulted for that identity: the event was written at the moment it
    happened, and its label says which phase that was.

    ABSENT, NEVER ZERO. An unrecorded model, provider, terminal reason or wall is
    ``None``; an offset that cannot be measured (no ``ts``, or no cell start) is
    ``None``. Only ``compactions.count`` is genuinely ``0``, when no compaction
    record exists at all.
    """
    run_dir = Path(run_dir)
    events = _live_events(run_dir / _LIVE_FILENAME)
    timeline = _timeline(events)

    model = _first_text(events, "cell.start", "model")
    provider = None if model is None else model.partition("/")[0]
    terminal_reason = _first_text(events, "cell.end", "terminal_reason")

    cell_wall_seconds: float | None = None
    measured_wall_seconds: float | None = None
    if timeline.start_ms is not None and timeline.end_ms is not None:
        cell_wall_seconds = (timeline.end_ms - timeline.start_ms) / 1000.0
        paused_ms = sum(max(0, end - start) for start, end in timeline.pauses)
        measured_wall_seconds = cell_wall_seconds - paused_ms / 1000.0

    positions: list[dict[str, Any]] = []
    for event in events:
        if event.get("kind") != "compaction":
            continue
        stamp = _stamp(event)
        offset: float | None = None
        if stamp is not None and timeline.start_ms is not None:
            paused_before_ms = sum(
                max(0, min(end, stamp) - start)
                for start, end in timeline.pauses
                if start < stamp
            )
            offset = round((stamp - timeline.start_ms - paused_before_ms) / 1000.0, 3)
        positions.append(
            {
                "ts": stamp,
                "measured_offset_s": offset,
                "phase_index": _phase_index(event),
                "phase_kind": event.get("phase_kind"),
            }
        )

    return {
        "model": model,
        "provider": provider,
        "terminal_reason": terminal_reason,
        "cell_wall_seconds": cell_wall_seconds,
        "measured_wall_seconds": measured_wall_seconds,
        "compactions": {"count": len(positions), "positions": positions},
    }
