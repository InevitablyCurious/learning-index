"""Append-only live event stream — the benchmark's ONE surface for the UI.

WHY THIS EXISTS
---------------
Every "live" panel on the board used to read a file that is written when
something *ends*. ``manifest.status.jsonl`` is appended once per COMPLETED cell
(all of a cell's attempt records at once), and ``predicate-outcomes.jsonl`` is
written in ``run_cumulative.py``'s ``finally`` block -- after the whole campaign
exits. Two consequences, both observed:

* the learning panel resolved its session id from the newest predicate-outcome
  line, so it read ``unresolved`` for the entire run, every run, by
  construction; and
* the gate wall could only move once per cell, never per verdict-pass, because
  that is when its records land.

Nothing was miswired. The board was reading post-mortem artifacts and asking
them to be live. This module is the missing surface.

THE CONTRACT IS BACKEND-NEUTRAL, AND THAT IS THE POINT
------------------------------------------------------
This benchmark is meant to ship as something ANY memory backend can plug into;
Okp is the first implementation of the contract, not the definition of it.
So nothing here knows what a memory is. The benchmark owns a small set of core
kinds describing what the HARNESS did -- a cell started, a gate produced a
verdict, an attempt closed -- and every backend-specific fact travels as an
``ext`` record under a namespace the backend owns:

    {"v":1,"ts":...,"kind":"ext","ns":"okp.plugin",
     "type":"insession.capture","data":{ ...anything the backend likes... }}

The harness never parses ``data``. The board renders namespaces it recognises
natively and unknown namespaces generically, so a third-party backend gets its
telemetry on screen without patching either the benchmark or the dashboard.
That is the whole modularity claim, and it is enforced by this file containing
no memory concepts.

HOW A BACKEND JOINS
-------------------
The harness exports :data:`ENV_PATH` into the cell environment. Anything that
can open a file and append a line can participate -- a plugin, an MCP server, a
shell script -- in any language:

    path = os.environ.get("BENCH_LIVE_STREAM")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({...}) + "\\n")

:data:`ENV_NS` optionally carries the namespace the backend should stamp, so an
operator can run two backends side by side without either hardcoding a name.

DESIGN RULES
------------
1. TELEMETRY NEVER KILLS A RUN. Every write is wrapped; a failure is dropped and
   counted, never raised. A benchmark that dies because its dashboard feed broke
   is worse than a benchmark with no dashboard.
2. APPEND-ONLY, ONE JSON OBJECT PER LINE. No rewrites, no truncation, no
   seeking. A reader that has consumed N lines can consume from N+1 forever, and
   a run that dies mid-cell leaves a valid prefix rather than a corrupt file.
3. ONE LINE PER WRITE, opened ``O_APPEND`` and flushed. Concurrent appenders (the
   harness and one or more backends) interleave whole lines rather than
   corrupting each other.
4. ``session_id`` IS ON THE FIRST LINE OF A CELL. It is the join key for every
   downstream consumer, and the entire class of defect this module replaces was
   consumers guessing it.
5. NO DEPENDENCIES. stdlib only, matching the rest of the harness.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any

__all__ = [
    "SCHEMA_VERSION",
    "STREAM_FILENAME",
    "ENV_PATH",
    "ENV_NS",
    "ENV_NOTICES",
    "run_notice",
    "CORE_KINDS",
    "NOTICE_SOURCES",
    "NOTICE_LEVELS",
    "LiveStream",
    "Heartbeat",
    "HEARTBEAT_INTERVAL_S",
]

#: Bumped only for a BREAKING envelope change. Adding a core kind, or any new
#: optional field, is not breaking: readers ignore what they do not know.
SCHEMA_VERSION = 1

#: Lives beside the other run artifacts, NOT inside any backend's state
#: directory. Okp scopes its own state under ``.okp/`` and deliberately
#: leaves the control arm unbound, which is exactly why a backend-owned location
#: cannot host this: the OFF arm would go dark and the arms would stop being
#: comparable on the one surface meant to compare them.
#:
#: "Beside the run artifacts" means beside the CELL's artifacts:
#: :meth:`LiveStream.for_run` is called from ``BackgammonAdapter.run_cell`` with
#: that cell's ``run_dir``, so the file lands at
#: ``<campaign>/memory<ARM>/cell-<seq>/live.jsonl`` — NOT at the campaign root.
#: Saying "runs/<run>/live.jsonl" here is what led both dashboard readers to
#: construct the campaign-level path and go blind for entire runs. A reader
#: RESOLVES this location; it never assumes it.
STREAM_FILENAME = "live.jsonl"

#: Absolute path to the stream, exported into the cell environment.
ENV_PATH = "BENCH_LIVE_STREAM"

#: Absolute path to the RUN-SCOPED notice stream, exported into the harness's
#: own environment by whatever launched it.
#:
#: WHY A SECOND PATH. ``live.jsonl`` is per CELL. The harness also does work that
#: SPANS cells -- ordering the campaign, publishing run artifacts, deciding a
#: run is done -- and a failure there belongs to the RUN, not to whichever cell
#: happened to be open. Writing it into one cell's stream would file a
#: run-scoped fact where retiring that cell destroys it and the next cell's
#: reader cannot see it.
#:
#: IT IS THE SAME FILE THE CONTROL PLANE WRITES (``<log>.notices.jsonl``), on
#: purpose: both are run-scoped notices about the same run, in the same
#: envelope, and a reader should not have to know which process appended a given
#: line to read them in order. `source` already says who spoke.
#:
#: UNSET MEANS NO TELEMETRY IS WANTED -- carry on, do not error. A CLI-launched
#: harness has no control plane to set it and must run identically.
ENV_NOTICES = "BENCH_NOTICES"
#: The namespace a backend should stamp on its ``ext`` records.
ENV_NS = "BENCH_LIVE_STREAM_NS"

#: Kinds the HARNESS owns. A backend never emits these -- it emits ``ext``.
CORE_KINDS = (
    "run.start",  # once per run: run_id, task, roster
    "cell.start",  # once per cell: session_id lands HERE, before any work
    "phase.start",  # a build or verdict-pass phase opened
    "gate.result",  # ONE gate produced a verdict, at the moment it did
    "attempt.end",  # a verdict-pass closed: verdict + counts
    "cell.end",  # terminal state for the cell
    "backend",  # a backend announcing itself: ns, name, version
    "heartbeat",  # the cell is ALIVE, and here is what it is doing
    "notice",  # a PROCESS reporting something it did or something done to it
)

#: WHO IS TALKING. The `source` axis of a ``notice``, and the ONLY values it may
#: carry natively.
#:
#: This is not a new vocabulary. 46 of the harness's 63 log calls already read
#: ``component.event_name key=value`` -- ``cumulative.sequencer.scorecard_missing``,
#: ``docker_worker.image_fingerprint_invalid`` -- and the dotted prefix IS this
#: axis. What was missing was somewhere for those lines to go other than a log
#: file, and any agreement that the prefixes were a set.
#:
#: WHY A CLOSED SET. With every process's rows merged into one feed, `source` is
#: the only thing separating a benchmark fact from a contributor's local
#: surroundings. An open set makes the filter chips unstable -- a new prefix
#: appears mid-run and the operator has no chip for it -- and a stranger's clone
#: could never be told which sources it should expect to see.
#:
#: EXTERNAL SOURCES ARE NOT LISTED HERE and never will be. A service outside this
#: repo is observed by the control plane and reported under ``control.watch``;
#: see the note on attribution in ``notice`` below.
NOTICE_SOURCES = (
    "harness",  # the cell driver: phases, attempts, transport, budget
    "gates",  # the gate runner: files, runners, per-file aborts
    "worker",  # the docker worker: images, containers, volumes
    "sequencer",  # campaign ordering: cells advanced, halts
    "control",  # the control plane: launches, stops, tools, polling
)

#: HOW BAD. Three, not five.
#:
#: `debug` never reaches a shared surface -- it is noise on a feed an operator
#: watches to decide whether a run is healthy. `critical` folds into `error`: a
#: level whose boundary against `error` nobody can state is a level that gets
#: applied inconsistently, and a severity filter is only ever as good as its
#: boundary.
NOTICE_LEVELS = ("info", "warn", "error")

#: How often the harness heartbeats while a cell is live.
#:
#: WHY A HEARTBEAT IS A CORE KIND. Every other kind marks a TRANSITION, and
#: transitions are exactly what a wedged cell stops producing -- so a stream of
#: them can never answer "is this alive". Before this existed, four surfaces
#: each invented their own liveness proxy from whatever was at hand: the
#: harness log's mtime, the serve event feed, a `ps` scan, and the TUI mirror's
#: child handle. All four answer a different question than the one asked, and
#: the log-mtime one put "CELL STALLED -- SILENT 21:49" in the header of a cell
#: that was mid-turn with its own event ticker scrolling. A build phase has
#: been observed running 86 model turns with no transition record of any kind.
#:
#: The harness is the only component that knows whether it is mid-drive,
#: mid-grade, or genuinely stuck, so the harness says so on a fixed clock and
#: every consumer reads that one fact. "Stalled" then means "the heartbeat
#: stopped", which is true by construction and needs no proxy.
#:
#: 15s against a 900s stall threshold leaves 60 missed beats of headroom, so a
#: slow filesystem or a GC pause cannot be mistaken for a wedge.
HEARTBEAT_INTERVAL_S = 15.0


class LiveStream:
    """Append-only writer for one run's live event stream.

    Construction never creates the file; the first successful :meth:`emit`
    does. A stream whose directory cannot be written reports ``ok = False`` and
    silently drops -- see design rule 1.
    """

    def __init__(self, path: str | os.PathLike[str], *, run_id: str = "") -> None:
        self.path = Path(path)
        self.run_id = str(run_id or "")
        self.dropped = 0
        self.written = 0
        self.ok = True

    # ── construction ────────────────────────────────────────────────────────
    @classmethod
    def for_run(
        cls, run_dir: str | os.PathLike[str], *, run_id: str = ""
    ) -> "LiveStream":
        """The harness-side constructor: the stream beside the run artifacts."""
        return cls(Path(run_dir) / STREAM_FILENAME, run_id=run_id)

    @classmethod
    def from_env(cls, env: dict | None = None) -> "LiveStream | None":
        """The BACKEND-side constructor.

        Returns ``None`` when the harness did not export a stream, which is the
        normal case outside a benchmark run. A backend must treat that as "no
        telemetry wanted" and carry on, never as an error.
        """
        src = os.environ if env is None else env
        path = src.get(ENV_PATH)
        if not path:
            return None
        return cls(path)

    def env(self, ns: str = "") -> dict[str, str]:
        """The environment a cell needs so any backend can join the stream."""
        out = {ENV_PATH: str(self.path)}
        if ns:
            out[ENV_NS] = str(ns)
        return out

    # ── emission ────────────────────────────────────────────────────────────
    def emit(self, kind: str, **fields: Any) -> bool:
        """Append one record. Returns whether it landed. NEVER raises.

        ``None`` values are dropped rather than written: a null on the wire is
        indistinguishable from "this consumer does not set that field", and the
        board's whole convention is that absence is its own state.
        """
        rec: dict[str, Any] = {
            "v": SCHEMA_VERSION,
            "ts": int(time.time() * 1000),
            "kind": str(kind),
        }
        if self.run_id:
            rec["run_id"] = self.run_id
        for key, value in fields.items():
            if value is not None:
                rec[key] = value
        return self._append(rec)

    def ext(self, ns: str, type: str, data: Any = None, **fields: Any) -> bool:
        """Append a backend record under ``ns``.

        ``data`` is opaque: the harness does not read it, validate it, or
        promise anything about it beyond passing it through. That opacity is
        what lets a backend ship telemetry the benchmark has never heard of.
        """
        return self.emit("ext", ns=str(ns), type=str(type), data=data, **fields)

    def notice(
        self,
        source: str,
        event: str,
        *,
        level: str = "info",
        detail: Any = None,
        **fields: Any,
    ) -> bool:
        """Append one process notice: WHO said it, WHAT happened, HOW bad.

        THE GAP THIS FILLS. Every other core kind marks a step of the RUN --
        a phase opened, a gate landed, a cell ended. Nothing carried what a
        PROCESS has to say about itself: a runner that aborted a file, a write
        that failed and left an artifact absent, a step that caught an exception
        and carried on by another route. Those went to a log line and nowhere
        else, which is why the only surface resembling a backend feed today
        works by tailing a log and parsing it with a regex.

        SHAPED LIKE ``ext`` ON PURPOSE. ``source``/``event``/``detail`` mirrors
        ``ns``/``type``/``data``, so one renderer draws a native record and a
        backend's record and a reader learns one shape. The difference is
        ownership: a notice is a fact the benchmark defines and understands;
        ``ext`` is opaque and stays that way.

        ``detail`` IS STRUCTURED, NEVER PROSE. A sentence here is a reason string
        wearing a different hat, and it puts the explanation back where a
        consumer has to parse it out. Name the event; carry the numbers.

        ``level`` IS STATED, NEVER DERIVED from the event name. The ``*_failed``
        naming convention survives so grep still works, but if severity were read
        off the suffix then renaming an event would silently change how loudly it
        reports.

        ATTRIBUTION IS LITERAL. ``source`` is who is SPEAKING, not who the
        notice is about. A service outside this repo announces nothing -- the
        relay serves monotonic counters over HTTP and does not know cells exist
        -- so an observation of one is reported by its observer, under
        ``control.watch``, naming the observed source in ``detail``. Attributing
        it to the service would be this process speaking in another's voice
        about an event that process never reported, which is fabrication however
        accurate the number happens to be.

        UNKNOWN VALUES ARE WRITTEN, NOT DROPPED. An unrecognised source or level
        is a drift between this vocabulary and a caller, and dropping the record
        would hide the drift on the one surface built to show it. The pinning
        test is what makes a drift loud; this makes it harmless.

        NEVER RAISES -- ``emit`` never does, and telemetry about a failure must
        not become a second failure.
        """
        return self.emit(
            "notice",
            source=str(source),
            event=str(event),
            level=str(level),
            detail=detail,
            **fields,
        )

    # ── the one place that touches the filesystem ───────────────────────────
    def _append(self, rec: dict[str, Any]) -> bool:
        try:
            line = json.dumps(rec, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            # ``default=str`` above already coerces the awkward cases (a set, a
            # Path, a dataclass) to their string form rather than failing the
            # record, so a backend's loose payload degrades to something
            # readable instead of vanishing. This branch is the last resort for
            # what even that cannot render -- a self-referential structure. The
            # backend's bug must not become the harness's crash: counted,
            # dropped, run continues.
            self.dropped += 1
            return False
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            # O_APPEND + one write + flush: concurrent appenders interleave
            # whole lines instead of shredding each other's.
            with open(self.path, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
                fh.flush()
        except OSError:
            self.dropped += 1
            self.ok = False
            return False
        self.written += 1
        self.ok = True
        return True


class Heartbeat:
    """Emit ``heartbeat`` on a fixed clock for as long as a cell is running.

    THE ONLY LIVENESS SIGNAL THE BENCHMARK PUBLISHES. See ``LIVE-STREAM.md``,
    "Liveness comes from `heartbeat`, and from nothing else", for the four
    proxies this replaces and the header that called a working cell wedged.

    Two properties it must never lose:

    * **It cannot fail a cell.** The thread is a daemon, every tick is wrapped,
      and :meth:`LiveStream.emit` never raises. A heartbeat that cannot be
      written stops the SIGNAL, which correctly reads as a stall, and does not
      stop the RUN.
    * **It beats on wall time, not on work.** A beat driven by turns or phases
      would be another transition record, and transitions are exactly what a
      wedged cell stops producing.

    The current phase travels with the beat, so a reader can say *what* the
    cell is doing rather than only that it is doing something. It is set by the
    harness at each phase boundary and is otherwise carried unchanged.
    """

    def __init__(
        self,
        stream: "LiveStream | None",
        *,
        interval_s: float = HEARTBEAT_INTERVAL_S,
        **fields: Any,
    ) -> None:
        self._stream = stream
        self._interval_s = float(interval_s)
        self._fields = dict(fields)
        self._phase: str | None = None
        self._attempt: int | None = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._started_at = 0.0
        self.beats = 0

    # ── what the beat carries ───────────────────────────────────────────────
    def set_phase(self, phase: str | None = None, attempt: int | None = None) -> None:
        """Update what the next beat reports. Cheap, thread-safe, never raises."""
        with self._lock:
            if phase is not None:
                self._phase = str(phase)
            if attempt is not None:
                self._attempt = int(attempt)

    def beat(self) -> bool:
        """Emit one beat now. Public so a test can drive it without a clock."""
        if self._stream is None:
            return False
        with self._lock:
            phase, attempt = self._phase, self._attempt
        return self._stream.emit(
            "heartbeat",
            phase=phase,
            attempt=attempt,
            since_ms=int((time.monotonic() - self._started_at) * 1000),
            **self._fields,
        )

    # ── lifecycle ───────────────────────────────────────────────────────────
    def start(self) -> "Heartbeat":
        if self._thread is not None or self._stream is None:
            return self
        self._started_at = time.monotonic()
        # THE FIRST BEAT IS SYNCHRONOUS. Waiting a full interval would leave a
        # window at cell start where the stream holds no heartbeat at all —
        # indistinguishable, to a reader, from a harness that never had one.
        self._tick_once()
        self._thread = threading.Thread(
            target=self._loop, name="bench-live-heartbeat", daemon=True
        )
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
        t, self._thread = self._thread, None
        if t is not None:
            # Bounded join: a heartbeat must never be able to hold a cell's
            # teardown open, and the thread is a daemon regardless.
            t.join(timeout=self._interval_s)

    def _tick_once(self) -> None:
        try:
            if self.beat():
                self.beats += 1
        except Exception:  # noqa: BLE001 - a beat can never fail the run
            pass

    def _loop(self) -> None:
        # `Event.wait` rather than `sleep` so stop() is immediate at teardown
        # instead of up to one interval late.
        while not self._stop.wait(self._interval_s):
            self._tick_once()

    def __enter__(self) -> "Heartbeat":
        return self.start()

    def __exit__(self, *exc: Any) -> None:
        self.stop()


def run_notice(
    source: str,
    event: str,
    *,
    level: str = "info",
    detail: Any = None,
    env: dict | None = None,
) -> bool:
    """Append one RUN-SCOPED notice, for harness work that outlives a cell.

    The cell-scoped path is :meth:`LiveStream.notice`; use that whenever a cell
    is open and the fact belongs to it. This is for the campaign layer -- the
    sequencer ordering cells, run artifacts being published, a run being
    declared done -- where there is no cell to attribute the fact to and the
    open one would be the wrong home for it.

    Resolves :data:`ENV_NOTICES` on every call rather than caching it: the
    harness is a long-lived process across a campaign, and a cached absent path
    would keep a run silent for its whole life after a late export.

    NEVER RAISES, for the same reason ``LiveStream.emit`` does not -- telemetry
    about a failure must not become a second failure. An unwritable stream costs
    a row on a feed, never a measurement.
    """
    path = (env or os.environ).get(ENV_NOTICES, "").strip()
    if not path:
        return False
    rec: dict[str, Any] = {
        "v": SCHEMA_VERSION,
        "ts": int(time.time() * 1000),
        "kind": "notice",
        "source": str(source),
        "event": str(event),
        "level": str(level),
    }
    # Nulls are DROPPED, not written -- absence is a state on every stream here.
    if detail is not None:
        rec["detail"] = detail
    try:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, separators=(",", ":"), ensure_ascii=False) + "\n")
        return True
    except Exception:  # noqa: BLE001 - telemetry never fails its caller
        return False
