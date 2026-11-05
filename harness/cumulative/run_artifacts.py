"""Write-once run manifest, append-only status stream, and scorecard builder.

This module publishes two immutable-by-design per-run artifacts alongside the
MUTABLE cumulative manifest, and a scorecard builder that reads ONLY those two
artifacts. It never touches the mutable ``CumulativeManifest`` at
``runs/cumulative/manifest.json``.

Artifacts
---------
* RunManifest — a WRITE-ONCE, immutable (frozen dataclass) identity record for
  one run. ``write_run_manifest`` refuses to overwrite an existing file
  (``FileExistsError``) so a run's identity can never drift after the first
  write.
* StatusStream — an APPEND-ONLY JSON-lines stream of per-attempt status
  records. Each line is an independently-parseable compact JSON object. A run
  that dies halfway leaves a short but VALID stream: every intact line is
  parseable, and unparseable trailing fragments are skipped on read.

Status record schema (a plain ``dict`` passed to ``StatusStream.append``)
-------------------------------------------------------------------------
Each record describes ONE attempt/cell of a scored session. Keys:

- ``type``: "attempt"
- ``schema_version``: 1
- ``sequence_index``: int — which roster cell this attempt belongs to
- ``memory_mode``: str ("on"/"off")
- ``org_id``: str
- ``served_model``: dict | None — API-reported served model, shape
  ``{"model": <requested>, "upstream_model": <served>|None}`` or None
- ``verdict``: str
- ``termination_reason``: str
- ``attempts_to_green``: int | str | None
- ``progress``: dict — the cumulative ``ProgressVector.to_dict()`` as of this
  record; for the terminal attempt of a cell this equals the cell's final
  progress.

Token accounting (injected-memory-block kept SEPARATE from work tokens):
- ``work_input_tokens``, ``work_output_tokens``, ``work_reasoning_tokens``,
  ``work_cache_read_tokens``, ``work_cache_write_tokens``, and the derived
  ``work_total_tokens`` (all int | None; PER ATTEMPT, not the cell total —
  the cell total lives in ``cost.json``). A counter the adapter never reported
  is an explicit None, never 0; ``work_total_tokens`` sums the counters present
  and is None when none are present.
- ``injected_block_est_tokens`` (int | None; None when mode off)

Injection observability (null BY CONTRACT when mode off — that null is
correct, not a defect):
- ``injected_count``, ``injected_block_chars``,
  ``injected_block_est_tokens``, ``consumer_injected_count`` (all int | None)

Extraction-attempt observability:
- ``extraction_state`` in {"never_invoked","invoked_cut_off",
  "invoked_completed","unknown"}
- ``extraction_candidate_count`` int | None.
  The absent-flag-must-NOT-read-as-pass principle: a missing value is never
  defaulted to a pass; an explicit state is always set.

Terminal outcome (WO-TRUNC-1 — recorded, never placeholder-null):
- ``terminal_outcome``: bool — True iff the cell resolved (verdict PASS);
  False for every other ending.
- ``terminal_reason``: str — the cell's machine termination reason, so a
  scorecard can tell "the model failed" (a non-green verdict) from
  "the stream died" (``transport_incomplete`` / ``harness_error``).

``delivery`` records (fail-closed, unverified delivery)
--------------------------------------------------------
One record per cell whose delivery could not be verified, appended by the
writer when a delivery attempt ends without a verifiable proof. The scorecard
EXCLUDES these cells from the scored set and reports them distinctly as
``not_scored``. Keys: ``type``: "delivery", ``schema_version``: 1,
``sequence_index`` (int), ``memory_mode`` (str), ``org_id`` (str),
``delivery_state`` in {"unverified"} — only the fail-closed ``"unverified"``
disposition excludes a cell; any other value is ignored by the reader —
``not_scored_reason`` (str, the reason the cell was not scored).

Turn-terminal accounting (WO-TRUNC-1):
- ``provider_truncations``: int — genuine provider truncations (``unknown`` /
  ``stream-incomplete`` / ``finish_reason=length`` BELOW the output cap).
- ``cap_cutoffs``: int — ``finish_reason=length`` AT/above OUR output cap — a
  fixed limit, never a provider failure, never a void signal.
- ``truncated_turns`` / ``truncated_turns_retried``: int — anomalous turn
  endings (no-signal truncations, guard aborts, transport deaths) and how many
  of them a later step or resume picked up.
- ``unmetered_turns`` / ``unmetered_turn_wall_s``: int / float — turns whose
  usage frame never survived the stream drop. Their true upstream token burn
  is unmetered client-side and is NEVER synthesized (rule 5.14); their
  measured wall-clock is real cost and is recorded.

``turn_terminal`` records (WO-TRUNC-1)
--------------------------------------
One record per anomalously-ended turn, appended after the attempt records of
the cell. Keys: ``type``: "turn_terminal", ``schema_version``: 1,
``sequence_index``, ``memory_mode``, ``org_id``, ``session_fp``,
``session_id``, ``phase`` (which worker invocation: initial / feedback-N /
…), ``turn_index`` (step index within that invocation), ``terminal`` in
{"truncated_no_signal","guard_abort","transport_error","stream_died_open",
"unclassified_finish"}, ``reason`` (the observed signature: ``unknown``,
``stream-incomplete``, ``stream_incomplete``, ``loop_guard``,
``idle_timeout``, ``provider_error``, ``no_terminal_signal``, …),
``tool_uses``, ``file_writes``, ``input_tokens`` / ``output_tokens`` /
``reasoning_tokens`` (whatever partial usage survived — usually zero),
``cost_usd``, ``tokens_unmetered`` (bool), ``wall_seconds`` (measured,
None if unmeasurable), ``retried`` (bool) and ``retry_kind`` in
{"client_auto","harness_resume"} | None — the burned attempt and its retry
are both recorded, so a scorecard can tell "the model failed" apart from
"the stream died and we tried again".
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import logging
import os
from pathlib import Path
import tempfile
from typing import Any, Mapping

from .convergence import build_convergence_trend

_LOG = logging.getLogger(__name__)

RUN_ARTIFACTS_SCHEMA_VERSION = 1


@dataclass(frozen=True)
class RunManifest:
    """Write-once identity record for a single run.

    ``served_model`` is the API-reported upstream model, never a configured
    name. All fields are informational identity; none are mutated after the
    first write.
    """

    schema_version: int = RUN_ARTIFACTS_SCHEMA_VERSION
    run_id: str = ""
    created_at: str = ""
    served_model: str | None = None
    requested_model: str | None = None
    memory_mode: str = ""
    org_id: str = ""
    source_commit: str | None = None
    worker_image_fingerprint: dict | str | None = None
    seed: int | None = None
    template_hash: str | None = None
    #: Which challenge this cell built — the example is 'backgammon'.
    challenge: str = ""
    roster_fingerprint: str | None = None
    # Chunk-boundary compaction, as the cell actually ran it. A compacted cell
    # and an uncompacted one sit on different turn/token scales, so a record
    # that does not say which it was cannot be read at all.
    compact: bool = False
    # PLAN BEFORE WORK, as the cell actually ran it. Recorded for the same reason
    # as `compact`: it changes what the agent does, so two runs that disagree
    # about it are not comparable, and a run that does not record the condition
    # it ran under cannot be compared to anything later.
    require_todos: bool = False
    # How much of the grading machine this run was allowed to use.
    #
    # NOT in the same class as the three fields above. Those change what the
    # AGENT does, so two runs that disagree about one of them are not
    # comparable. This changes only how many test workers the grading container
    # started once the model had finished, and the gates and their verdicts are
    # identical either way — held to that by
    # `scripts/verify_worker_parity.py`.
    #
    # Recorded anyway, precisely BECAUSE that is a claim: if parity ever breaks,
    # the first question will be what share each run used, and a record that
    # cannot answer it makes the break unattributable. None means the container
    # used its own default.
    grader_worker_target: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": int(self.schema_version),
            "run_id": self.run_id,
            "created_at": self.created_at,
            "served_model": self.served_model,
            "requested_model": self.requested_model,
            "memory_mode": self.memory_mode,
            "org_id": self.org_id,
            "source_commit": self.source_commit,
            "worker_image_fingerprint": self.worker_image_fingerprint,
            "seed": self.seed,
            "template_hash": self.template_hash,
            "challenge": self.challenge,
            "roster_fingerprint": self.roster_fingerprint,
            "grader_worker_target": self.grader_worker_target,
            "compact": bool(self.compact),
            "require_todos": bool(self.require_todos),
        }

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> RunManifest:
        if not isinstance(d, Mapping):
            raise ValueError("run manifest must decode to a JSON object")
        return cls(
            schema_version=int(d.get("schema_version", RUN_ARTIFACTS_SCHEMA_VERSION)),
            run_id=str(d.get("run_id", "")),
            created_at=str(d.get("created_at", "")),
            served_model=d.get("served_model"),
            requested_model=d.get("requested_model"),
            memory_mode=str(d.get("memory_mode", "")),
            org_id=str(d.get("org_id", "")),
            source_commit=d.get("source_commit"),
            worker_image_fingerprint=d.get("worker_image_fingerprint"),
            seed=d.get("seed"),
            template_hash=d.get("template_hash"),
            challenge=str(d.get("challenge") or ""),
            roster_fingerprint=d.get("roster_fingerprint"),
            compact=bool(d.get("compact", False)),
            require_todos=bool(d.get("require_todos", False)),
            grader_worker_target=d.get("grader_worker_target", None),
        )


def write_run_manifest(
    path: str | os.PathLike[str],
    manifest: RunManifest,
) -> RunManifest:
    """Write a run manifest exactly once.

    Raises ``FileExistsError`` if ``path`` already exists. Writes canonical
    JSON (``sort_keys=True, separators=(",",":")``) plus a trailing newline via
    a temp file + ``os.replace`` for atomicity. Never overwrites.
    """
    manifest_path = os.fspath(path)
    if os.path.exists(manifest_path):
        raise FileExistsError(
            f"run manifest already exists; write-once invariant violated: {manifest_path}"
        )
    parent = os.path.dirname(manifest_path) or "."
    os.makedirs(parent, exist_ok=True)

    rendered = (
        json.dumps(manifest.to_dict(), sort_keys=True, separators=(",", ":")) + "\n"
    )

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
        os.replace(tmp_path, manifest_path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except FileNotFoundError:
            pass
        raise
    return manifest


def load_run_manifest(path: str | os.PathLike[str]) -> RunManifest:
    """Read + validate a run manifest. Returns the parsed RunManifest."""
    manifest_path = os.fspath(path)
    with open(manifest_path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, Mapping):
        raise ValueError(f"run manifest at {manifest_path} must decode to an object")
    return RunManifest.from_dict(payload)


class StatusStream:
    """Append-only JSON-lines stream of per-attempt status records.

    Invariants:
    - Never truncates, rewrites prior lines, rewinds, or compacts.
    - ``append`` opens the file in append mode each call and writes one compact
      JSON line plus a newline, then flushes and fsyncs the handle.
    - ``records`` reads all parsed records in order, skipping unparseable lines
      (a run that dies halfway leaves a short-but-valid stream).
    """

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self._path = os.fspath(path)
        parent = os.path.dirname(self._path) or "."
        os.makedirs(parent, exist_ok=True)

    def append(self, record: dict) -> None:
        line = json.dumps(record, sort_keys=True, separators=(",", ":"))
        with open(self._path, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    def records(self) -> list[dict]:
        parsed: list[dict] = []
        if not os.path.exists(self._path):
            return parsed
        with open(self._path, "r", encoding="utf-8") as handle:
            for raw in handle:
                line = raw.strip()
                if not line:
                    continue
                try:
                    decoded = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(decoded, Mapping):
                    parsed.append(dict(decoded))
        return parsed


def default_run_manifest_path(manifest_path: str | os.PathLike[str]) -> str:
    """Sibling path of the mutable manifest for the write-once run manifest."""
    path = Path(os.fspath(manifest_path))
    return str(path.with_name(f"{path.stem}.run-manifest.json"))


def default_status_stream_path(manifest_path: str | os.PathLike[str]) -> str:
    """Sibling path of the mutable manifest for the append-only status stream."""
    path = Path(os.fspath(manifest_path))
    return str(path.with_name(f"{path.stem}.status.jsonl"))


def default_scorecard_path(manifest_path: str | os.PathLike[str]) -> str:
    """Sibling path of the mutable manifest for the published scorecard."""
    path = Path(os.fspath(manifest_path))
    return str(path.with_name(f"{path.stem}.scorecard.json"))


def write_scorecard(
    manifest_path: str | os.PathLike[str],
    *,
    stream_path: str | os.PathLike[str] | None = None,
    scorecard_path: str | os.PathLike[str] | None = None,
) -> str | None:
    """Publish the scorecard as an artifact. Returns the path, or None on failure.

    WHY THIS EXISTS. ``build_scorecard`` was computed IN MEMORY ONLY on the
    cumulative path -- consumed by the results-ledger append and by the
    sequencer's done-state convergence, and never written down. So the only
    process that knew which cells scored and which were VOID-INSTRUMENT was the
    one that was about to exit, and the board could not say whether a finished
    cell had contributed a data point or none at all. A cell that ran 3h08m,
    passed five verdict passes and scored nothing looked exactly like a cell
    still running.

    THE ALTERNATIVE WAS REJECTED. The control plane is JS and could re-derive
    the scored/void split from the run-manifest and status stream itself. That
    is a SECOND implementation of the VOID-INSTRUMENT rule, and the two paths
    are already known to disagree: the mutable manifest holds a complete
    ``session_records[0]`` for a cell the scorecard correctly voids, so a
    consumer reading progress off it concludes the cell scored. Only one path is
    the scoring authority, and the authority is the one that publishes.

    NOT WRITE-ONCE, unlike the run manifest beside it. The scorecard is a
    DERIVED view of two write-once artifacts and is republished whenever they
    grow -- after each cell, so the board's reading tracks the campaign instead
    of appearing only at the end. Rewriting it loses nothing: it holds no fact
    the run-manifest and status stream do not already hold, and it is rebuilt
    from them alone.

    REPLACED ATOMICALLY, because a poller reads this file while a cell is
    finishing and a half-written scorecard would parse as a campaign that lost
    its cells.

    INSTRUMENTATION-ONLY: never raises. A scorecard that cannot be built or
    written costs the board its numbers -- which read as unavailable, the honest
    answer -- and must never cost the run.
    """
    target = (
        default_scorecard_path(manifest_path)
        if scorecard_path is None
        else os.fspath(scorecard_path)
    )
    try:
        payload = build_scorecard(manifest_path, stream_path=stream_path)
        rendered = json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n"

        parent = os.path.dirname(target) or "."
        os.makedirs(parent, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(
            prefix=f".{os.path.basename(target)}.tmp-",
            dir=parent,
            text=True,
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(rendered)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_path, target)
        except Exception:
            try:
                os.unlink(tmp_path)
            except FileNotFoundError:
                pass
            raise
    except Exception as exc:  # noqa: BLE001 -- instrumentation, never fails a run
        _LOG.error(
            "run_artifacts.scorecard_publish_failed path=%s error_type=%s",
            target,
            type(exc).__name__,
        )
        return None
    return target


class _ScoredSession:
    """Lightweight record adapter consumed by ``build_convergence_trend``."""

    __slots__ = (
        "sequence_index",
        "session_fp",
        "session_id",
        "progress",
    )

    def __init__(
        self,
        *,
        sequence_index: int,
        session_fp: str,
        session_id: str | None,
        progress: dict[str, Any],
    ) -> None:
        self.sequence_index = sequence_index
        self.session_fp = session_fp
        self.session_id = session_id
        self.progress = progress


# A void whose terminal reason names itself keeps that name; anything else is a
# provider-side truncation, the reason the original gate was built for.
_VOID_REASON_BY_TERMINAL: dict[str, str] = {
    "instrument_fault": "instrument_fault",
    "compactions_before_grade": "compactions_before_grade",
}

# Terminal reasons that void a cell on their own: the harness never finished
# measuring, so whatever the gates saw is not a capability result.
_VOID_TERMINAL_REASONS: frozenset[str] = frozenset(
    {"transport_incomplete", "instrument_fault", "compactions_before_grade"}
)


def _progress_full_green(progress: Any) -> bool:
    """The ``full_green`` flag of a progress vector, True only when a real bool.

    Fail-closed: a missing ``progress`` mapping, a missing key, or a non-bool
    value reads as NOT green, so a malformed record can never be promoted to a
    scored PASS.
    """
    if not isinstance(progress, Mapping):
        return False
    raw = progress.get("full_green", False)
    return bool(raw) if isinstance(raw, bool) else False


def cell_void(record: Mapping[str, Any]) -> dict[str, Any]:
    """Classify ONE cell's TERMINAL attempt record as VOID-INSTRUMENT or scored.

    VOID-INSTRUMENT (RUNBOOK rule 5.10) means the instrument failed to measure,
    so the cell is never scored as a capability FAIL. This is the single
    definition of that rule — the scorecard builder and every downstream writer
    (e.g. the cost.json writer) call this instead of re-deriving it.

    Returns exactly ``{"is_void": bool, "reason": str | None}``; ``reason`` is
    None when the cell is not void.

    A green terminal attempt is never void, regardless of truncation seen on
    earlier attempts of the same cell: the cell completed and was graded, so it
    is scored PASS.

    Signal set: ``terminal_reason`` in {"transport_incomplete",
    "instrument_fault", "compactions_before_grade"} — the grader measured
    nothing twice on the same code (Jerry, 2026-09-23;
    harness/adapters/challenge/exceptions.py InstrumentFaultError), or the
    harness ended the cell after two completed compactions with no grade; or
    ``provider_truncations > 0`` (a stream that stopped short BELOW the cap);
    or ``unrecovered_anomaly_turns > 0``; or ``observation_lost_turns > 0``
    (D-SERVE-MESSAGE-500: the transcript read failed past every transient
    retry, so the gates measured an unobserved worktree).

    Two counters are deliberately NOT void signals:

    * ``truncated_turns`` is ``len(turn_anomalies)`` — ALL anomalies, including
      ``guard_abort``. Reading it as "a provider-side truncation signal"
      voided a completed cell over a looping model the harness had caught and
      recovered. Measured on run 1788599410: five graded attempts, 39/53
      passing, discarded; all three "truncations" were ``terminal:
      guard_abort, reason: loop_guard`` with ``finish_reason: "tool-calls"``
      (a clean finish, not ``length``), ``truncations_seen: 0``,
      ``provider_truncations: 0``, and ``retried: true`` (fixed 2026-09-05).
    * ``instrument_anomaly_turns`` counts recoverable transport errors the
      harness owns (``guard_abort``, ``provider_unavailable``,
      ``stream_finalize_timeout``), so it still exists as data but is no
      longer the void signal (fixed 2026-09-07, WO-I2).

    The recovered-truncation rule: this leg voids on a NON-RECOVERABLE anomaly
    only. Recovered/nudged anomalies NEVER void, regardless of retry status —
    Jerry's ruling: nudging a looping model is model behaviour, not a void
    classifier.
    """
    if _progress_full_green(record.get("progress")):
        return {"is_void": False, "reason": None}

    terminal_reason = str(record.get("terminal_reason") or "")
    is_void = (
        terminal_reason in _VOID_TERMINAL_REASONS
        or int(record.get("provider_truncations") or 0) > 0
        or int(record.get("unrecovered_anomaly_turns") or 0) > 0
        or int(record.get("observation_lost_turns") or 0) > 0
    )
    if not is_void:
        return {"is_void": False, "reason": None}
    return {
        "is_void": True,
        "reason": _VOID_REASON_BY_TERMINAL.get(terminal_reason, "provider_truncation"),
    }


def build_scorecard(
    manifest_path: str | os.PathLike[str],
    *,
    stream_path: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    """Build a scorecard reading ONLY the two published run artifacts.

    The ``manifest_path`` argument is the path of the MUTABLE cumulative
    manifest; the scorecard locates the run-manifest and status-stream as its
    siblings and does NOT read the mutable manifest itself.

    Returns a dict with ``schema_version``, ``manifest`` (the RunManifest
    identity dict), ``convergence`` (the derived trend dict), and the counts of
    parsed stream records and scored sessions. The scorecard distinguishes
    four outcomes: ``scored_pass`` / ``scored_fail`` (counts of the scored set),
    ``not_scored`` (the cells excluded via a fail-closed
    ``delivery_state=="unverified"`` delivery record, each with
    ``sequence_index``, ``memory_mode`` and ``not_scored_reason``), and
    ``void_instrument`` (the cells whose terminal attempt was non-green AND
    carried a provider-side truncation signal — VOID-INSTRUMENT per RUNBOOK
    rule 5.10, never scored as a capability FAIL; each entry carries
    ``sequence_index``, ``memory_mode`` and ``void_reason``).
    """
    run_manifest_path = default_run_manifest_path(manifest_path)
    resolved_stream_path = (
        default_status_stream_path(manifest_path)
        if stream_path is None
        else os.fspath(stream_path)
    )

    run_manifest = load_run_manifest(run_manifest_path)
    stream = StatusStream(resolved_stream_path)
    records = stream.records()

    # Fail-closed delivery gate (WO-NIGHT2-1a): any cell whose delivery was
    # written as ``delivery_state=="unverified"`` is EXCLUDED from the scored
    # set and reported distinctly as not-scored-with-reason. Only the
    # fail-closed ``unverified`` disposition excludes; any other value is
    # ignored so a (future) verified disposition never drops a cell.
    not_scored_by_index: dict[int, dict[str, Any]] = {}
    for record in records:
        if record.get("type") != "delivery":
            continue
        if record.get("delivery_state") != "unverified":
            continue
        seq = record.get("sequence_index")
        if seq is None:
            continue
        not_scored_by_index[int(seq)] = record

    # Group records by sequence_index; take the LAST record per cell that has a
    # non-None progress dict (the terminal attempt's final progress).
    best_by_cell: dict[int, dict[str, Any]] = {}
    for record in records:
        if record.get("type") != "attempt":
            continue
        progress = record.get("progress")
        if not isinstance(progress, Mapping):
            continue
        seq = record.get("sequence_index")
        if seq is None:
            continue
        best_by_cell[int(seq)] = record

    # VOID-INSTRUMENT gate (WO-NIGHT2-1b): a cell whose TERMINAL (last) attempt
    # is non-green AND carries an instrument-failure signal is VOID-INSTRUMENT
    # per RUNBOOK rule 5.10 — never scored as a capability FAIL. The rule lives
    # in ``cell_void`` alone; this loop only partitions the cells and keeps the
    # reason it returned so the published entry and the classification can
    # never disagree. Symmetric across ON/OFF — the rule branches on no mode
    # flag.
    void_instrument_by_index: dict[int, dict[str, Any]] = {}
    void_reason_by_index: dict[int, str] = {}
    for seq, record in best_by_cell.items():
        verdict = cell_void(record)
        if not verdict["is_void"]:
            continue
        void_instrument_by_index[seq] = record
        void_reason_by_index[seq] = verdict["reason"]

    # The ONLY change to which cells enter the scored set: a not-scored cell
    # (whose attempt record may still exist from ``run_session``) and a
    # VOID-INSTRUMENT cell are both dropped from the scored set.
    def _is_scored(seq: int) -> bool:
        return seq not in not_scored_by_index and seq not in void_instrument_by_index

    scored_sessions = [
        _ScoredSession(
            sequence_index=int(record["sequence_index"]),
            session_fp=str(record.get("session_fp") or ""),
            session_id=record.get("session_id"),
            progress=dict(record["progress"]),
        )
        for record in best_by_cell.values()
        if _is_scored(int(record["sequence_index"]))
    ]

    convergence = build_convergence_trend(scored_sessions).to_dict()

    # scored_pass / scored_fail are derived from the SAME progress objects that
    # feed ``build_convergence_trend`` (mirroring its ``full_green`` semantics),
    # so they are perfectly consistent with ``convergence`` — the cells that
    # ARE scored have their metrics unchanged.
    scored_pass = sum(1 for s in scored_sessions if _progress_full_green(s.progress))
    scored_fail = len(scored_sessions) - scored_pass

    not_scored = [
        {
            "sequence_index": int(record["sequence_index"]),
            "memory_mode": str(record.get("memory_mode") or ""),
            "not_scored_reason": str(record.get("not_scored_reason") or ""),
        }
        for record in not_scored_by_index.values()
    ]

    void_instrument = [
        {
            "sequence_index": int(record["sequence_index"]),
            "memory_mode": str(record.get("memory_mode") or ""),
            "void_reason": void_reason_by_index[seq],
        }
        for seq, record in void_instrument_by_index.items()
    ]

    # WO-ERRDATA: per-benchmark error-type totals for the dashboard footer.
    # Summed over best_by_cell (ONE record per cell); never sum all attempt
    # records — the counters are whole-cell values repeated per attempt.
    # The dashboard's /api/stats reads these three fields from this scorecard.
    error_totals = {
        "guard_aborted_turns": sum(
            int(r.get("guard_aborted_turns") or 0) for r in best_by_cell.values()
        ),
        "finalize_timeout_turns": sum(
            int(r.get("finalize_timeout_turns") or 0) for r in best_by_cell.values()
        ),
        "stalled_turns": sum(
            int(r.get("stalled_turns") or 0) for r in best_by_cell.values()
        ),
        # ── THE STREAM-FAILURE COUNT, WHICH WAS MISSING ────────────────────
        #
        # The board's STREAM ERRORS slot read `finalize_timeout_turns`, which is
        # ONE narrow kind: a turn killed while the stream was finalizing
        # (terminal=transport_error AND reason=stream_finalize_timeout). A plain
        # `transport_error` — the stream dying mid-turn, which is the common
        # case — is not that, so the counter sat at 0 through a run that had one.
        # Measured 2026-09-11: a transport_error on initial-chunk-2 moved
        # nothing on the board.
        #
        # `instrument_anomaly_turns` is the honest denominator: every anomalous
        # turn EXCEPT the model's own (loop guard, stall watchdog, cap cut-off —
        # each has its own slot; adapters/challenge/transport.py
        # _is_instrument_anomaly). It already contains the finalize-timeout
        # subset, so this neither double-counts nor loses the narrower kind.
        "instrument_anomaly_turns": sum(
            int(r.get("instrument_anomaly_turns") or 0) for r in best_by_cell.values()
        ),
    }

    return {
        "schema_version": RUN_ARTIFACTS_SCHEMA_VERSION,
        "manifest": run_manifest.to_dict(),
        "convergence": convergence,
        "error_totals": error_totals,
        "stream_records": len(records),
        "scored_sessions": len(scored_sessions),
        "scored_pass": scored_pass,
        "scored_fail": scored_fail,
        "not_scored": not_scored,
        "void_instrument": void_instrument,
    }


__all__ = [
    "RUN_ARTIFACTS_SCHEMA_VERSION",
    "RunManifest",
    "StatusStream",
    "build_scorecard",
    "cell_void",
    "default_scorecard_path",
    "write_scorecard",
    "default_run_manifest_path",
    "default_status_stream_path",
    "load_run_manifest",
    "write_run_manifest",
]
