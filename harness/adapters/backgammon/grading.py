"""Gate-oracle grading methods for the backgammon runner.

Extracted VERBATIM from harness/adapters/backgammon/__init__.py
(WO-LI15-I2C STAGE 2C) into a role mixin: BackgammonRunner inherits
GradingMixin, so every self./cls. cross-call resolves through the MRO
with zero call-site changes. This module must not import from the package
__init__ -- the package __init__ imports this module.

The harness.grader_run names (gate_argv, grading_container_name,
kill_grading_container, assert_grader_image_available) are not
monkeypatched anywhere -- tests import them from harness.grader_run
directly -- so importing them here is correct (same rationale as
transport.py's serve_client imports). GraderImageMissing is NOT imported:
the moved bodies never reference it. subprocess is the dual-safe module
singleton. Path(__file__).resolve().parents[2] in _run_gate_report is
UNCHANGED by the move: grading.py sits in the same directory as
__init__.py, so the parents chain resolves identically.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import threading
import time
from typing import Any

from harness.grader_run import (
    assert_image_available as assert_grader_image_available,
    container_name as grading_container_name,
    gate_argv,
    kill_container as kill_grading_container,
)

from .exceptions import GateTimeoutError, GraderReportUnreadableError


class GradingMixin:
    def _run_gate_report(
        self,
        *,
        worktree: Path,
        report_path: Path,
        log_path: Path,
        attempt: int | None = None,
    ) -> dict[str, Any]:
        """Run the gate oracle, STREAMING its output to ``log_path`` as it runs.

        WHY STREAMED AND NOT BUFFERED (WO-GRADE-VIS-1). This previously used
        ``subprocess.run(capture_output=True)`` and wrote the log only AFTER the
        process returned. A slow or hung grade therefore produced ZERO bytes for
        its entire duration: measured 2026-08-12, an attempt-3 gate ran 1918s
        (~32 min) against a 45s/113s baseline while `attempt-3-gate.log` did not
        exist, so "grading" and "wedged" were indistinguishable without
        inspecting process stacks by hand. The gate runner already announces
        every phase on stderr BEFORE spawning it (`report.mjs`:
        ``[report] phase=<name> target=...``); those markers were real and
        simply trapped in a pipe buffer until exit.

        Streaming makes the log an append-only progress record whose MTIME is a
        true liveness signal — which is what the board's stall detection reads.
        Both streams are merged (``stderr=STDOUT``) so phase markers and the
        output they describe stay in causal order in one file, and a single
        reader cannot deadlock on two pipes.

        TIMEOUT (belt-and-suspenders). A gate that never returns must fail its
        attempt with evidence rather than hang the campaign forever. On timeout
        the whole process GROUP is killed: the gate spawns npm -> vitest ->
        workers, and signalling only the direct child leaves those children
        alive (exactly the orphan class that burned 341 CPU-minutes on
        2026-08-12). Partial output is already on disk by construction.
        """
        # ── GRADING RUNS IN ITS OWN IMAGE ──────────────────────────────────
        #
        # It used to run here, on the host, with whatever was installed. Four
        # things differed from the container the candidate was BUILT in — Node,
        # Playwright, Chromium, and vitest (declared as a RANGE, so it could
        # change itself on a reinstall) — and `compute_grader_hash` excludes
        # node_modules, so nothing recorded which toolchain produced a result.
        #
        # The corpus is frozen byte-for-byte and a cell aborts on a mismatch.
        # The instrument measuring it is now pinned the same way.
        #
        # A missing image ABORTS with the build command. There is deliberately
        # no host fallback: the fallback is what people reach for when the
        # container is inconvenient, and then a result exists that nobody can
        # reproduce.
        assert_grader_image_available()
        grade_container = grading_container_name(report_path)
        gate_cmd = gate_argv(
            worktree=worktree,
            report_path=report_path,
            roster_path=self.gate_roster_path,
            attempt=attempt,
            worker_target=self.grader_worker_target,
        )
        # `docker` is invoked from the repo root; the gates travel inside the
        # image, so there is no gates directory for this process to stand in.
        gates_cwd = str(Path(__file__).resolve().parents[2])
        log_path.parent.mkdir(parents=True, exist_ok=True)

        gate_started = time.monotonic()
        timed_out = False  # set by the watchdog below, never inferred
        # Header is written and flushed BEFORE the child starts, so the file
        # exists from t=0 and its absence can never be mistaken for a slow gate.
        with log_path.open("w", encoding="utf-8") as log_file:
            log_file.write(f"cmd: {gate_cmd}\n")
            log_file.write(f"cwd: {gates_cwd}\n")
            log_file.write(f"timeout_seconds: {self.gate_timeout_s}\n")
            log_file.write("--- output (streamed, stdout+stderr merged) ---\n")
            log_file.flush()

            # THE GATE RUNNER JOINS THE LIVE STREAM DIRECTLY.
            #
            # It is a child of this process and already streams its stdout here
            # line by line — so the harness COULD parse its output and relay
            # what it finds. That is exactly the pattern the backend feed exists
            # to replace: `gate-events.mjs` tails a log and regex-parses it, and
            # every fact it recovers that way is one the producer could simply
            # have stated. The runner knows when a worker died; it says so
            # itself.
            #
            # `LiveStream.env()` is the same seam a backend gets. Absent (no
            # stream on this run) the runner writes nothing and carries on —
            # telemetry is never a precondition for grading.
            gate_env = dict(os.environ)
            live = getattr(self, "_live", None)
            if live is not None:
                gate_env.update(live.env())

            proc = subprocess.Popen(  # noqa: S603 - fixed argv, host-only gate oracle
                gate_cmd,
                cwd=gates_cwd,
                env=gate_env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,  # line-buffered: a phase marker lands as it is emitted
                start_new_session=True,  # own process group, so timeout kills the tree
            )
            assert proc.stdout is not None
            # WATCHDOG, NOT `wait(timeout=...)`. The reader loop below blocks in
            # `for line in proc.stdout` until the child closes the pipe, so a
            # hung gate never reaches a post-loop wait() — the timeout would be
            # structurally unreachable. (That is precisely the defect class this
            # work exists to fix: vitest's own 60s testTimeout could not fire
            # because a microtask loop starved its timer.) An independent timer
            # thread owns the deadline, kills the process group, and the pipe
            # closes as a consequence, which unblocks the reader.
            timeout_fired = threading.Event()

            def _on_deadline() -> None:
                timeout_fired.set()
                # THE CONTAINER FIRST, then the client. Killing the process
                # group reaches the `docker` CLI only — the container is a child
                # of the DAEMON, so it would survive, keep the candidate mounted
                # and keep burning CPU with nothing left holding its id.
                kill_grading_container(grade_container)
                self._kill_process_group(proc)

            watchdog = threading.Timer(self.gate_timeout_s, _on_deadline)
            watchdog.daemon = True
            watchdog.start()
            try:
                for line in proc.stdout:
                    log_file.write(line)
                    # Flushed per line: an unflushed buffer would reintroduce
                    # exactly the invisibility this change exists to remove.
                    log_file.flush()
                    self._emit_gate_phase_progress(line, log_path=log_path)
                proc.wait()
            finally:
                watchdog.cancel()
                if proc.poll() is None:
                    # Pipe closed while the child still lives. Never leave the
                    # tree running — nor the container behind it.
                    kill_grading_container(grade_container)
                    self._kill_process_group(proc)
                    proc.wait()
            timed_out = timeout_fired.is_set()

            gate_wall = time.monotonic() - gate_started
            returncode = proc.returncode
            if timed_out:
                log_file.write(
                    f"\n[harness] gate TIMED OUT after {gate_wall:.3f}s "
                    f"(limit {self.gate_timeout_s}s); process group killed\n"
                )
            log_file.write(f"\nexit: {returncode}\n")
            log_file.write(f"wall_seconds: {gate_wall:.3f}\n")
            log_file.flush()

        if timed_out:
            self._progress(
                f"PROGRESS step=gate-timeout wall_s={gate_wall:.1f} "
                f"limit_s={self.gate_timeout_s} log={log_path}"
            )
            raise GateTimeoutError(
                f"gate oracle exceeded {self.gate_timeout_s}s "
                f"(ran {gate_wall:.1f}s); partial output at {log_path}"
            )

        if not report_path.is_file():
            raise GraderReportUnreadableError(
                f"gate report missing at {report_path} (exit={returncode})"
            )

        try:
            payload = json.loads(report_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise GraderReportUnreadableError(
                f"gate report unparseable at {report_path}: {exc}"
            ) from exc
        if not isinstance(payload, dict):
            raise GraderReportUnreadableError(
                f"gate report must be an object: {report_path}"
            )
        return payload

    def _emit_gate_phase_progress(self, line: str, *, log_path: Path) -> None:
        """Republish a gate phase marker as a harness PROGRESS line.

        The gate runner's own markers live in the gate log, which the control
        plane does not read. Mirroring them into the run log puts grading into
        the same ``PROGRESS step=`` vocabulary every downstream consumer already
        parses, so grading progress appears in the live event feed instead of
        reading as dead air between attempts.

        Instrumentation only: this must never alter gate behaviour, and a
        malformed line is ignored rather than raised.
        """
        text = line.strip()

        # WO-GATE-ROSTER live signal. The gate runner announces each phase's
        # gate SET before spawning it, so the wall can mark those gates
        # under-test the moment the phase begins instead of waiting ~30 minutes
        # for the attempt record. PER-PHASE-SET, not per-test: `report.mjs`
        # spawns each runner with `spawnSync`, so a child's per-test output is
        # buffered until the phase has already ended and could never be live.
        #
        # The line carries a COUNT, not ids — identity already lives in the
        # roster the board reads, and the count is what makes roster/runner
        # drift detectable.
        if text.startswith("[report] gateset "):
            fields = dict(
                part.split("=", 1)
                for part in text[len("[report] gateset ") :].split()
                if "=" in part
            )
            phase = fields.get("phase")
            if phase:
                self._progress(
                    f"PROGRESS step=gate-phase-gates phase={phase} "
                    f"count={fields.get('count', 'unknown')} log={log_path}"
                )
            return

        if not text.startswith("[report] phase="):
            return
        fields = dict(
            part.split("=", 1)
            for part in text[len("[report] ") :].split()
            if "=" in part
        )
        phase = fields.get("phase")
        if not phase:
            return
        status = fields.get("status")
        if status is None:
            # Phase ANNOUNCED. Emitted before the phase runs, so a stall inside
            # it is attributable to a named phase rather than to "the gate".
            self._progress(
                f"PROGRESS step=gate-phase-start phase={phase} log={log_path}"
            )
        else:
            self._progress(
                f"PROGRESS step=gate-phase-end phase={phase} status={status} "
                f"problems={fields.get('problems', 'unknown')} log={log_path}"
            )
