"""Serve-drive methods for the challenge runner.

Extracted VERBATIM from harness/adapters/challenge/__init__.py
(WO-LI15-I3A STAGE 3A) into a role mixin: ChallengeRunner inherits
ServeMixin, so every self./cls. cross-call resolves through the MRO
with zero call-site changes. This module must not import from the
package __init__ at module level -- the package __init__ imports this
module.

SEAM NOTES. ServeClient and DockerCell appear ONLY as parameter
annotations (strings under PEP 563, never evaluated at runtime), so
importing them directly here is correct -- the package-attr patches the
tests set (challenge_mod.ServeClient / challenge_mod.DockerCell)
target runtime reads that stayed in __init__ (the G0/G1 base); G5/G6
consume the serve_client INSTANCE and the active_cell passed in, never
the patched classes. Every other name below (the .constants nudges /
turn-terminal reasons / settle bounds, the serve_client reasons and
classifiers, LOOP_KILL_MARKER_DIRNAME, _build_truncation_evidence,
_provider_backoff_seconds, _OpencodeRunStats)
is not monkeypatched anywhere, so importing them directly is correct
-- same rationale as transport.py's serve_client imports and
grading.py's grader_run imports.
"""

from __future__ import annotations

import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from harness.context_budget import (
    CONTEXT_EXHAUSTED,
    context_exhausted,
    context_limit_tokens,
    latest_context_tokens,
)
from harness.serve_client import (
    LOOP_KILL_WAIT_REASON,
    REASON_LOOP_GUARD,
    REASON_PROVIDER_UNAVAILABLE,
    RECOVERABLE_STREAM_DEATH_REASONS,
    TERMINAL_GUARD_ABORT,
    ServeClient,
    ServeClientError,
    classify_transport_anomaly,
    set_read_retry_observer,
)

from ..docker_worker import LOOP_KILL_MARKER_DIRNAME, DockerCell
from .constants import (
    _COMPACT_SETTLE_GRACE_S,
    _COMPACT_SETTLE_TIMEOUT_S,
    _FINALIZE_RECOVERY_NUDGE,
    _LOOP_RECOVERY_NUDGE,
    _MAX_SERVE_RECOVERY_NUDGES,
    _PROVIDER_RECOVERY_NUDGE,
    _STALL_RECOVERY_NUDGE,
    DEFAULT_TURN_STALL_TIMEOUT_S,
    REASON_OBSERVATION_LOST,
    REASON_TOOL_CALL_TIMEOUT,
    TRUNCATION_EVIDENCE_FILENAME,
    TURN_TERMINAL_GUARD_ABORT,
    TURN_TERMINAL_OBSERVATION_LOST,
    TURN_TERMINAL_STALLED,
    TURN_TERMINAL_TRANSPORT_ERROR,
    TURN_TERMINAL_TRUNCATED,
)
from .exceptions import ServeTransportError
from .models import _OpencodeRunStats
from .transport import _build_truncation_evidence, _provider_backoff_seconds


class ServeMixin:
    def _run_opencode_serve(
        self,
        *,
        active_cell: DockerCell,
        serve_client: ServeClient,
        session_id: str,
        prompt: str,
        run_label: str,
        phase: str,
        prior_cost_usd: float = 0.0,
        timeout_s: float = 5400.0,
        kill_hook: Callable[[], None] | None = None,
    ) -> _OpencodeRunStats:
        """Drive ONE scoring attempt through the persistent opencode serve.

        WO-WATCH-1F serve-drive path: enqueue the prompt via
        ``POST /session/{sid}/prompt_async``, wait for the session to go idle
        (``GET /session/status`` busy->idle), then meter from the persisted
        transcript ``GET /session/{sid}/message`` via :func:`serve_client.metrics`.
        The harness's OWN timeout path MAY call ``POST /session/{sid}/abort``
        on ITS OWN session to stop serve-side generation; the never-abort rule
        applies ONLY to the founder's passive viewer, never to the harness's
        own timeout path. The harness never kills the serve itself (the
        per-attempt kill hook is serve-PID-scoped and survives by design).

        This path does NOT re-raise transport failures: a send error returns an
        ``_OpencodeRunStats`` with ``exit_code=1`` so the caller's budget/gating
        logic decides. ``session_id`` here is the serve-side session id
        (persisted on the serve).

        WO-LOOPREC-1: a relay loop-guard kill (``relay_loop_detected`` in the
        persisted assistant ``info.error``) is classified ``guard_abort`` and
        re-driven with the anti-repetition nudge. WO-FINALIZE-REC-1: a relay
        finalize-watchdog kill is classified
        ``transport_error/stream_finalize_timeout`` and re-driven with the
        resume nudge. Both recoveries are BOUNDED by
        ``_MAX_SERVE_RECOVERY_NUDGES`` and fail closed on exhaustion exactly
        like a non-recoverable terminal (the anomaly stays unretried, the
        drive ends). A killed turn never reads as completed work because it
        is subtracted from ``turns`` (scoring), not because the phase is
        failed; its tokens stay metered.
        """
        if kill_hook is None:
            kill_hook = active_cell.kill_worker_processes

        # A2: PUBLISH THE PHASE BEFORE THE PROMPT GOES OUT. This is the single
        # choke point every scoring attempt passes through, so it is the only
        # place the sentinel needs to be written — build chunks, recording
        # turns, recovery nudges and feedback rounds all arrive here with their
        # phase name, and the plugin's next session.idle reads whatever this
        # wrote.
        self._publish_compact_phase(active_cell=active_cell, phase=phase)

        # Surface every transient observation-read retry on the progress
        # stream. A retry nobody can see is indistinguishable from a serve that
        # never faulted, and a rising retry rate is the leading indicator of
        # D-SERVE-MESSAGE-500 degrading underneath a run that still looks green.
        set_read_retry_observer(
            lambda what, attempt, exc: self._progress(
                f"PROGRESS run_label={run_label} step=serve-read-retry "
                f"phase={phase} what={what} attempt={attempt} detail={exc}"
            )
        )

        # WO-WATCH-1E per-attempt evidence correlation id + start timestamp.
        # The evidence file path is
        # derived from the cell's worktree when available (real DockerCell);
        # otherwise it falls back to the system temp dir so the serve-drive
        # path stays hermetic (the only DockerCell surface it depends on is
        # ``kill_worker_processes``) without polluting the source tree.
        attempt_id = f"{run_label}-{phase}-{uuid.uuid4().hex[:12]}"
        ts_start_epoch_ms = int(time.time() * 1000)
        try:
            cell_worktree = Path(active_cell.config.worktree).expanduser().resolve()
        except (AttributeError, TypeError):
            cell_worktree = None
        evidence_dir = (
            cell_worktree.parent
            if cell_worktree is not None
            else Path(tempfile.gettempdir())
        )
        evidence_path = evidence_dir / TRUNCATION_EVIDENCE_FILENAME

        # WO-LOOPKILL-1: loop-kill marker fast-path dir. The egress sidecar's
        # guard writes loop-kill-<sid>.json here the moment it kills a looping
        # request (docker_worker mounts the SAME dir into the sidecar), so the
        # idle waiter can end a wedged turn in seconds instead of riding out
        # the stall bound. Derivation matches docker_worker exactly:
        # <worktree>.parent (the run dir) / LOOP_KILL_MARKER_DIRNAME. With no
        # worktree (hermetic-test fallback) there is no container and no marker
        # writer, so the check stays OFF (None) rather than pointing at the
        # shared temp dir where a stray marker could false-positive. A missing
        # dir is fine — the reader tolerates it.
        loop_kill_marker_dir = (
            str(cell_worktree.parent / LOOP_KILL_MARKER_DIRNAME)
            if cell_worktree is not None
            else None
        )

        # Phase baseline for per-phase delta metering: serve transcript metrics
        # are session-CUMULATIVE, so a phase's true cost is the delta against
        # this snapshot. Without deltas, every phase after the first
        # double-counts session totals, and a fully-dead phase (stream
        # dropped, assistant message discarded) masquerades as success with
        # stale cumulative numbers (2026-08-09 feedback-phase void).
        #
        # A FAILED BASELINE READ IS AN ABORT, NOT A DEGRADATION. It used to set
        # `baseline = None` and let the phase report SESSION-CUMULATIVE totals as
        # its own: a feedback phase that cost 3k tokens would publish the whole
        # session's running total instead, and nothing on the record said so.
        # That is a corrupted measurement wearing the shape of a good one — worse
        # than a missing phase, which at least reads as missing.
        try:
            baseline = serve_client.metrics(session_id)
        except ServeClientError as exc:
            self._progress(
                f"PROGRESS run_label={run_label} step=serve-drive phase={phase} "
                f"status=abort reason=baseline_metrics_error detail={exc}"
            )
            raise ServeTransportError(
                f"could not read the phase baseline for {phase} ({exc}) — this "
                "phase cannot be metered honestly, and publishing cumulative "
                "session totals in its place would be a false measurement"
            ) from exc

        # Classification watermark (2026-08-10 live-cell defect): a guard- or
        # finalize-killed message keeps its info.error in the transcript
        # FOREVER, and extract_transcript_metrics surfaces it in error_texts on
        # every cumulative read. Classifying on the cumulative read re-trips
        # the SAME kill after a successful recovery — the live chunk-2 drive
        # recovered and finished its work, and was still classified
        # guard_abort twice more, which under the then-current nudge budget
        # exhausted it and voided the cell (the WO-NUDGE-INF-1 era removed
        # the exhaustion kill; WO-COMPACTION-RESTORE C5A re-added a bounded
        # one — but a stale re-classification would still burn recovery
        # budget on a kill that already recovered). The
        # classification surface is therefore WINDOWED to messages at/after
        # this watermark, and the watermark advances past each classified kill
        # before the recovery nudge re-drives. Metering deltas above are
        # unaffected (they diff cumulative reads).
        try:
            class_watermark = len(serve_client.get_messages(session_id))
        except ServeClientError:
            class_watermark = 0

        # A SECOND WATERMARK, TAKEN ONCE AND NEVER MOVED.
        #
        # `class_watermark` advances past each classified kill, which is right
        # for classification and wrong for the question the recovery path has to
        # answer: has THIS CHUNK already had its compaction? That has to be
        # measured from the start of the drive, because a compaction landing
        # anywhere in it is the chunk's one fire. A watermark that advances
        # would sit past it and report none.
        #
        # READ INDEPENDENTLY, FAILING OPEN (WO-25). Copying `class_watermark`
        # would inherit its `0`-on-failure fallback, and a bogus `0` counts the
        # WHOLE session as "since" — any past compaction then reads as this
        # chunk's fire and the hold below never releases. `None` marks the
        # watermark unknown, and the hold probe fails open on it.
        try:
            compact_watermark = len(serve_client.get_messages(session_id))
        except ServeClientError:
            compact_watermark = None

        # WO-LOOPREC-1/FINALIZE-REC-1 transport recovery: a guard-killed or
        # finalize-killed turn is metered (its tokens burned) but must NOT read
        # as completed work. When the terminal classification is recoverable,
        # mark the anomaly retried and re-drive the phase — anti-repetition
        # nudge for a guard kill (never the original prompt: the same prompt
        # into the same context is the loop's fuel), resume nudge for a finalize
        # kill.
        # BOUNDED (WO-COMPACTION-RESTORE C5A): recovery re-drives at most
        # _MAX_SERVE_RECOVERY_NUDGES times per phase, then fails closed the
        # SAME way a non-recoverable terminal does — the anomaly stays
        # unretried, the loop breaks, the drive ends. The measurement
        # protection is unchanged: every recovered turn is subtracted from
        # scoring turns below, so no number of nudges can inflate
        # turns/phases, while the tokens they burn stay fully metered. (The
        # WO-NUDGE-INF-1 unbounded era ended with the 2026-09-02
        # compaction-looping incident, which rode this loop to 126+ recovery
        # events with no exit.)
        recovery_nudges = 0
        provider_outages = 0
        # WO-LOOPKILL-1: count of turns in THIS drive ended by a fresh loop-kill
        # marker (wait_reason == LOOP_KILL_WAIT_REASON). The sidecar kills the
        # request mid-turn, so the transcript may carry NO loop signature and
        # the transcript-driven guard_aborted_turns delta cannot see these
        # kills; the count is carried separately and added to the guard-aborted
        # delta for the scoring exclusion below.
        loop_killed_turns = 0
        # The size at which this session is out of room — opencode's own
        # compaction line (harness/context_budget.py). A model with no declared
        # limit raises here rather than running unguarded.
        context_limit = context_limit_tokens(
            self.model, output_token_max=getattr(self, "max_output_tokens", None)
        )
        context_hit = False
        context_size = 0
        prompt_to_send = prompt
        turn_anomaly_list: list[dict[str, Any]] = []
        killed_reason: str | None = None
        exit_code = 0
        # Set when the transcript read fails past serve_client's transient
        # retries: the harness has lost its window onto the session, so the
        # phase carries no trustworthy measurement (D-SERVE-MESSAGE-500).
        observation_lost = False
        m: dict[str, Any] = {}
        while True:
            # 1) Enqueue the prompt asynchronously.
            try:
                serve_client.send_prompt(session_id, prompt_to_send)
            except ServeClientError as exc:
                self._progress(
                    f"PROGRESS run_label={run_label} step=serve-drive phase={phase} "
                    f"status=send_error detail={exc}"
                )
                return _OpencodeRunStats(
                    input_tokens=0,
                    output_tokens=0,
                    reasoning_tokens=0,
                    turns=0,
                    session_id=session_id,
                    killed_reason=None,
                    exit_code=1,
                    cost_usd=0.0,
                    turn_anomalies=tuple(turn_anomaly_list),
                    recovery_nudges=recovery_nudges,
                )

            # 2) Confirm the serve actually picked the prompt up (busy), THEN wait
            #    for completion (busy->idle). prompt_async is fire-and-forget: a
            #    bare wait_idle races the serve's busy flag and returns a false
            #    idle in milliseconds, metering turns=0 while gates run against a
            #    worktree the model is still writing (2026-08-09 void cell).
            #    A never-busy send is a loud transport failure (exit 1), never a
            #    clean zero-turn "ok" — unless the transcript already shows turns
            #    (a turn that raced past the busy window is metered, not voided).
            busy_grace_s = 60.0
            went_busy = serve_client.wait_busy(session_id, timeout_s=busy_grace_s)
            killed_reason = None
            exit_code = 0
            loop_killed_this_turn = False
            stalled_this_turn = False
            if not went_busy:
                self._progress(
                    f"PROGRESS run_label={run_label} step=serve-drive phase={phase} "
                    f"status=never_busy grace_s={busy_grace_s:.0f} session_id={session_id}"
                )
                try:
                    early = serve_client.metrics(session_id)
                except ServeClientError:
                    early = None
                dead = True
                if early:
                    # `baseline` is never None now — a failed baseline read
                    # aborts the phase above rather than degrading it.
                    dead = (
                        int(early.get("turns") or 0) - int(baseline.get("turns") or 0)
                        <= 0
                        and int(early.get("output_tokens") or 0)
                        - int(baseline.get("output_tokens") or 0)
                        <= 0
                    )
                if dead:
                    return _OpencodeRunStats(
                        input_tokens=0,
                        output_tokens=0,
                        reasoning_tokens=0,
                        turns=0,
                        session_id=session_id,
                        killed_reason=None,
                        exit_code=1,
                        cost_usd=0.0,
                        turn_anomalies=tuple(turn_anomaly_list),
                        recovery_nudges=recovery_nudges,
                    )
                # The turn completed inside the busy-grace window; fall through to
                # the normal metering path with idle already reached.
                idle = True
                wait_reason = "idle"
            else:
                # The serve-side generation may continue briefly after idle
                # returns; do NOT wait further.
                # WO-LOOPKILL-1: the freshness bound for the marker fast path —
                # only a marker written at/after this instant (epoch ms) counts,
                # so a stale marker from an earlier turn can never kill this one.
                turn_start_ts_ms = int(time.time() * 1000)
                idle, wait_reason = serve_client.wait_idle_detailed(
                    session_id,
                    timeout_s=timeout_s,
                    stall_timeout_s=DEFAULT_TURN_STALL_TIMEOUT_S,
                    loop_kill_marker_dir=loop_kill_marker_dir,
                    turn_start_ts_ms=turn_start_ts_ms,
                    context_limit_tokens=context_limit,
                )
            if not idle:
                # WO-LOOPKILL-1: a fresh loop-kill marker ended the wait. The
                # turn is wedged exactly like a stall and gets un-stuck the same
                # way (abort + kill hook below), but the kill is the loop
                # guard's: the marker is proof of a kill whose signature may
                # never reach the transcript, so the turn is classified
                # downstream as a RECOVERABLE guard-abort (forced at the
                # classifier) instead of the UNRECOVERABLE turn_stalled.
                # killed_reason/exit_code stay clean so the recovery gate passes.
                loop_killed_this_turn = wait_reason == LOOP_KILL_WAIT_REASON
                stalled_this_turn = wait_reason == "stalled"
                context_hit = wait_reason == CONTEXT_EXHAUSTED
                if loop_killed_this_turn:
                    loop_killed_turns += 1
                elif context_hit:
                    # Out of room mid-turn: stop generation (abort below) and
                    # end the phase. Not a harness limit and not an error.
                    killed_reason = CONTEXT_EXHAUSTED
                elif not stalled_this_turn:
                    # Distinguish "the cell's whole budget ran out" from "this
                    # turn stopped progressing". Both end the drive; only the
                    # second says something went wrong with a single command.
                    killed_reason = "run_timeout"
                    exit_code = 1
                # else: stalled_this_turn. WO-21 STALL-RECOVERY (operator ruling
                # 2026-09-11): a stalled turn now rides the SAME recoverable path
                # as a loop kill — killed_reason/exit_code stay clean so the
                # recovery gate passes; the classifier forces TURN_TERMINAL_STALLED
                # below and the stall is counted from its anomaly record.
                # WO-25 STALL-ABORT HOLD: write `repair` BEFORE the abort. The
                # abort's own session.idle is not a boundary. A loop-kill is
                # already covered — the sidecar writes `repair` at its kill —
                # but a stall has no sidecar, so without this the stall's own
                # abort idle could fire the summarizer mid-stall. The recovery
                # probe republishes `build` when the chunk has not compacted.
                if stalled_this_turn:
                    self._publish_compact_phase(
                        active_cell=active_cell, phase=phase, held=True
                    )
                # WO-WATCH-1F: genuinely stop serve-side generation before teardown.
                # An abort failure is logged but must NOT mask the timeout outcome.
                try:
                    serve_client.abort(session_id)
                except Exception as exc:  # noqa: BLE001 - never mask the timeout outcome.
                    self._progress(
                        f"PROGRESS run_label={run_label} step=serve-drive phase={phase} "
                        f"status=abort_failed reason={exc}"
                    )
                else:
                    self._progress(
                        f"PROGRESS run_label={run_label} step=serve-drive phase={phase} "
                        f"status=abort_issued session_id={session_id}"
                    )
                try:
                    kill_hook()
                except Exception as exc:  # noqa: BLE001 - never mask the timeout outcome.
                    self._progress(
                        f"PROGRESS run_label={run_label} step=serve-drive phase={phase} "
                        f"status=kill_hook_error detail={exc}"
                    )
                self._progress(
                    f"PROGRESS run_label={run_label} step=serve-drive phase={phase} "
                    f"status={'loop_killed' if loop_killed_this_turn else ('turn_stalled' if stalled_this_turn else killed_reason)} "
                    f"wait_reason={wait_reason} "
                    f"timeout_s={timeout_s:.1f} "
                    f"stall_timeout_s={DEFAULT_TURN_STALL_TIMEOUT_S:.0f} "
                    f"session_id={session_id}"
                )

            # 3) Pull metrics from the persisted transcript.
            try:
                m = serve_client.metrics(session_id)
                m_window = serve_client.metrics(session_id, since=class_watermark)
            except ServeClientError as exc:
                # OBSERVATION LOST (D-SERVE-MESSAGE-500). serve_client already
                # retried this read through every transient fault, so reaching
                # here means the harness can no longer see the session at all.
                #
                # This is NOT a capability result and must never be scored as
                # one: the classification window is empty, so the recovery
                # classifier below is blind by construction (it reads only
                # error_texts/truncations/error_parts/info_errors) and would
                # report "no anomaly" for a session that may still be running.
                # That blindness is exactly what voided the 2026-08-11 cell.
                #
                # Record it as a first-class terminal so run_artifacts can gate
                # the cell VOID-INSTRUMENT instead of letting gates run against
                # a half-written worktree and report a false capability FAIL.
                self._progress(
                    f"PROGRESS run_label={run_label} step=serve-drive phase={phase} "
                    f"status=observation_lost detail={exc}"
                )
                observation_lost = True
                # Baseline is always present (a failed baseline read aborts the
                # phase), so a lost observation reports a ZERO delta against it
                # rather than inventing an empty metrics dict.
                m = dict(baseline)
                m_window = {}
                if exit_code == 0:
                    exit_code = 1

            if observation_lost:
                # The classifier cannot see anything (m_window is empty), so
                # record the lost-observation terminal explicitly rather than
                # letting the blind classifier report a clean phase.
                turn_anomaly_list.append(
                    {
                        "phase": str(phase),
                        "turn_index": int(m.get("turns", 0) or 0),
                        "terminal": TURN_TERMINAL_OBSERVATION_LOST,
                        "reason": REASON_OBSERVATION_LOST,
                        "tool_uses": 0,
                        "file_writes": 0,
                        "input_tokens": int(m.get("input_tokens", 0) or 0),
                        "output_tokens": int(m.get("output_tokens", 0) or 0),
                        "reasoning_tokens": int(m.get("reasoning_tokens", 0) or 0),
                        "cost_usd": float(m.get("cost_usd", 0.0) or 0.0),
                        "tokens_unmetered": True,
                        "wall_seconds": None,
                        "retried": False,
                        "retry_kind": None,
                        "session_id": session_id,
                    }
                )
                break

            # ── CONTEXT EXHAUSTED: STOP, NEVER NUDGE ────────────────────────
            #
            # Checked on every turn end, before any recovery classification: a
            # session out of room cannot be nudged back into room, and an
            # overflowed request would otherwise read as a transport error and
            # be re-driven into the same wall.
            if not context_hit:
                try:
                    context_hit, context_size = context_exhausted(
                        serve_client.get_messages(session_id), context_limit
                    )
                except ServeClientError:
                    context_hit = False
                if context_hit:
                    killed_reason = CONTEXT_EXHAUSTED
            if context_hit:
                if not context_size:
                    try:
                        context_size = latest_context_tokens(
                            serve_client.get_messages(session_id)
                        )
                    except ServeClientError:
                        context_size = 0
                live = getattr(self, "_live", None)
                if live is not None:
                    live.notice(
                        "harness",
                        "context_exhausted",
                        level="error",
                        cell_seq=getattr(self, "_cell_seq", None),
                        session_id=session_id,
                        detail={
                            "phase": phase,
                            "context_tokens": context_size,
                            "limit_tokens": context_limit,
                        },
                    )
                self._progress(
                    f"PROGRESS run_label={run_label} step=context-exhausted "
                    f"phase={phase} context_tokens={context_size} "
                    f"limit_tokens={context_limit} session_id={session_id}"
                )
                break

            # ── FAIL-FAST: the worker's own compaction is loop-killing ──────
            #
            # When self-compaction is armed, the worker plugin (not the harness)
            # fires the summarize. If the relay's loop guard kills that
            # summarize, opencode AUTO-RETRIES it (compaction_restores) — a
            # self-sustaining storm. The harness must NOT nudge around it: it
            # does not drive compaction, so a recovery nudge is meaningless
            # there, and nudging around opencode's retry loop is exactly the
            # 2026-09-03 10-minute hang (run 1788451466: compact-1 ok, compact-2
            # relay_loop_detected xN, nudged to the budget).
            #
            # DISJOINT FROM THE BUILD-TURN NUDGE: this branch keys on
            # ``agent=compaction`` kills only, and runs BEFORE
            # classify_transport_anomaly. A build-turn guard abort
            # (``agent=build``) never matches here and reaches the nudge path
            # below unchanged.
            if (
                self.compact
                and serve_client.guard_killed_compactions_since(
                    session_id, class_watermark
                )
                > 0
            ):
                self._progress(
                    f"PROGRESS run_label={run_label} step=compaction-loop-kill "
                    f"phase={phase} session_id={session_id} action=abort"
                )
                exit_code = 1
                killed_reason = "compaction_loop_killed"
                turn_anomaly_list.append(
                    {
                        "phase": str(phase),
                        "turn_index": int(m.get("turns", 0) or 0),
                        "terminal": "compaction_loop_killed",
                        "reason": REASON_LOOP_GUARD,
                        "tool_uses": 0,
                        "file_writes": 0,
                        "input_tokens": int(m.get("input_tokens", 0) or 0),
                        "output_tokens": int(m.get("output_tokens", 0) or 0),
                        "reasoning_tokens": int(m.get("reasoning_tokens", 0) or 0),
                        "cost_usd": float(m.get("cost_usd", 0.0) or 0.0),
                        "tokens_unmetered": False,
                        "wall_seconds": None,
                        "retried": False,
                        "retry_kind": None,
                        "session_id": session_id,
                    }
                )
                break

            terminal, reason = classify_transport_anomaly(m_window)
            if loop_killed_this_turn:
                # WO-LOOPKILL-1: the marker IS the kill evidence. The sidecar
                # killed the request mid-turn, so the relay's loop signature
                # may never have reached the transcript and the classifier
                # can legitimately find nothing. Force the guard-abort terminal
                # so the turn rides the EXISTING recoverable path (anomaly
                # record, evidence line, nudge, watermark advance, re-drive)
                # exactly like a transcript-visible loop kill.
                terminal, reason = TERMINAL_GUARD_ABORT, REASON_LOOP_GUARD
            elif stalled_this_turn:
                # WO-21 STALL-RECOVERY: mirror the loop-kill force. The stall
                # watchdog is proof the turn wedged, but the transcript carries no
                # signature, so force the stall terminal to ride the existing
                # recoverable path (anomaly record, nudge, watermark, re-drive).
                terminal, reason = TURN_TERMINAL_STALLED, REASON_TOOL_CALL_TIMEOUT
            if terminal is not None:
                if terminal == "truncated":
                    mapped_terminal = TURN_TERMINAL_TRUNCATED
                elif terminal == TERMINAL_GUARD_ABORT:
                    mapped_terminal = TURN_TERMINAL_GUARD_ABORT
                elif terminal == "transport_error":
                    mapped_terminal = TURN_TERMINAL_TRANSPORT_ERROR
                else:
                    mapped_terminal = terminal
                anomaly_record: dict[str, Any] = {
                    "phase": str(phase),
                    "turn_index": int(m.get("turns", 0)),
                    "terminal": str(mapped_terminal),
                    "reason": str(reason or ""),
                    # The step-finish reason this turn ACTUALLY ended on. The
                    # truncated class is wider here than in
                    # TRUNCATED_STEP_FINISH_REASONS — serve_client counts
                    # `length` as a truncation and this file does not — so the
                    # raw reason has to travel for a consumer to tell an output
                    # cap from a dead stream. It already rode into the evidence
                    # file below; it just never rode into the record.
                    "finish_reason": m.get("last_finish"),
                    "tool_uses": 0,
                    "file_writes": 0,
                    "input_tokens": int(m.get("input_tokens", 0) or 0),
                    "output_tokens": int(m.get("output_tokens", 0) or 0),
                    "reasoning_tokens": int(m.get("reasoning_tokens", 0) or 0),
                    "cost_usd": float(m.get("cost_usd", 0.0) or 0.0),
                    "tokens_unmetered": False,
                    "wall_seconds": None,
                    "retried": False,
                    "retry_kind": None,
                    "session_id": session_id,
                }
                turn_anomaly_list.append(anomaly_record)
                self._write_truncation_evidence(
                    record=_build_truncation_evidence(
                        attempt_id=attempt_id,
                        run_label=run_label,
                        phase=phase,
                        terminal=mapped_terminal,
                        reason=str(reason or ""),
                        ts_start_epoch_ms=ts_start_epoch_ms,
                        ts_end_epoch_ms=int(time.time() * 1000),
                        wall_seconds=None,
                        session_id=session_id,
                        received_bytes=None,
                        received_lines=None,
                        last_event_type=None,
                        last_event_ts=None,
                        finish_reason=m.get("last_finish"),
                        output_tokens_received=int(m.get("output_tokens", 0) or 0),
                        input_tokens_received=int(m.get("input_tokens", 0) or 0),
                        reasoning_tokens_received=int(
                            m.get("reasoning_tokens", 0) or 0
                        ),
                        truncations_seen=int(m.get("truncations", 0) or 0),
                    ),
                    evidence_path=evidence_path,
                )
                is_provider_outage = (
                    mapped_terminal == TURN_TERMINAL_TRANSPORT_ERROR
                    and str(reason or "") == REASON_PROVIDER_UNAVAILABLE
                )
                # RELAY STREAM DEATH — both of the relay's shapes, one class,
                # one recovery (the resume nudge). The reason recorded on the
                # anomaly stays the precise one that fired.
                is_stream_death = (
                    mapped_terminal == TURN_TERMINAL_TRANSPORT_ERROR
                    and str(reason or "") in RECOVERABLE_STREAM_DEATH_REASONS
                )
                # THE RECOVERY SET — closed (four members, 2026-09-11). Three are
                # upstream terminals raised by the proxy (guard_abort,
                # provider_outage, stream_death). The fourth, turn_stalled, is the
                # harness's own stall watchdog — a terminal the harness raises over
                # a turn the model wedged, not prose the model wrote. Operator
                # ruling: nudging a stall is "model behaviour, not a void
                # classifier", the same precedent that already admitted guard_abort.
                # Nothing derived from what the model WROTE (its prose) is
                # recoverable, and nothing of that kind may be added here.
                recoverable = (
                    mapped_terminal == TURN_TERMINAL_GUARD_ABORT
                    or mapped_terminal == TURN_TERMINAL_STALLED
                    or is_provider_outage
                    or is_stream_death
                )
                if (
                    recoverable
                    and killed_reason is None
                    and exit_code == 0
                    and recovery_nudges < _MAX_SERVE_RECOVERY_NUDGES
                ):
                    anomaly_record["retried"] = True
                    anomaly_record["retry_kind"] = "harness_resume"
                    recovery_nudges += 1
                    # ── THE EVENT THAT VOIDS CELLS, SAID OUT LOUD ───────────
                    #
                    # Each of these is a TRUNCATED TURN, and `_truncation_signal`
                    # needs only one: a non-green terminal attempt with
                    # `truncated_turns > 0` is dropped from the scored set as an
                    # instrument failure. Ten of these — every one of them a
                    # loop-guard fire later certified FALSE — voided a cell that
                    # had run 3h08m, passed five verdict passes and published
                    # 265 gate verdicts.
                    #
                    # Until now the only trace was a PROGRESS line on stdout,
                    # emitted TWICE (once structured, once bare) and recoverable
                    # only by regex-deduping the log downstream. The board's
                    # loop-guard tile could show the count; nothing could show
                    # WHICH turns, in WHICH phase, or that the cell was quietly
                    # accumulating the thing that would disqualify it.
                    #
                    # `warn`, not `error`: the harness is recovering as designed
                    # and the run continues. Whether this one costs the cell is
                    # not knowable here — it depends on the terminal attempt's
                    # verdict, minutes away and decided elsewhere — so the level
                    # describes the event, never its eventual cost.
                    live = getattr(self, "_live", None)
                    if live is not None:
                        live.notice(
                            "harness",
                            "turn_truncated_retried",
                            level="warn",
                            cell_seq=getattr(self, "_cell_seq", None),
                            session_id=session_id,
                            detail={
                                "phase": phase,
                                "terminal": mapped_terminal,
                                "nudge": recovery_nudges,
                                "budget_remaining": (
                                    _MAX_SERVE_RECOVERY_NUDGES - recovery_nudges
                                ),
                            },
                        )
                    self._progress(
                        f"PROGRESS run_label={run_label} step=transport-recovery "
                        f"phase={phase} terminal={mapped_terminal} action=nudge "
                        f"nudge={recovery_nudges} "
                        f"budget_remaining={_MAX_SERVE_RECOVERY_NUDGES - recovery_nudges} "
                        f"session_id={session_id}"
                    )
                    if mapped_terminal == TURN_TERMINAL_GUARD_ABORT:
                        prompt_to_send = _LOOP_RECOVERY_NUDGE
                    elif mapped_terminal == TURN_TERMINAL_STALLED:
                        prompt_to_send = _STALL_RECOVERY_NUDGE
                    elif is_provider_outage:
                        prompt_to_send = _PROVIDER_RECOVERY_NUDGE
                        # Hold off before asking again. Re-prompting a provider
                        # that just said it was unavailable only spends another
                        # turn to hear the same thing.
                        provider_outages += 1
                        backoff_s = _provider_backoff_seconds(provider_outages)
                        self._progress(
                            f"PROGRESS run_label={run_label} step=transport-recovery "
                            f"phase={phase} terminal={mapped_terminal} "
                            f"reason={REASON_PROVIDER_UNAVAILABLE} "
                            f"outage={provider_outages} backoff_s={backoff_s:.0f} "
                            f"session_id={session_id}"
                        )
                        self._provider_backoff(backoff_s)
                    else:
                        prompt_to_send = _FINALIZE_RECOVERY_NUDGE
                    # Advance the classification window PAST the kill just
                    # classified: the persisted error never leaves the
                    # transcript, so without this the post-nudge read
                    # re-classifies the same kill (see the watermark note
                    # at phase baseline). A failed probe keeps the old
                    # watermark — a stuck window re-trips LOUD, never
                    # silently clean.
                    try:
                        class_watermark = len(serve_client.get_messages(session_id))
                    except ServeClientError:
                        pass
                    # ── THE HOLD IS NOW CONDITIONAL, AND WHY ──────────────
                    #
                    # This used to publish `repair` here, on the reasoning that
                    # "the boundary idle already fired at the loop-kill abort
                    # that triggered this nudge". That was TRUE ONLY BECAUSE OF
                    # A DEFECT: the plugin fired its summarize on the idle that
                    # a DYING stream emits, which is not a boundary at all. It
                    # then diverted the agent into the compaction agent and
                    # stopped the drive (measured, run 1789125594).
                    #
                    # The plugin now gates that itself — it records the turn a
                    # `session.error` killed and refuses to summarize it. So no
                    # compaction fires on a death, and the re-drive's completion
                    # IS this chunk's one boundary.
                    #
                    # Holding here would therefore leave the sentinel on
                    # `repair` for the rest of the drive, the real boundary
                    # could never compact, and `_settle_after_chunk` would abort
                    # the cell with `no_compaction_evidence`. Measured exactly
                    # that way on run 1789127719, chunk 5: two nudges, no
                    # compaction, cell dead.
                    #
                    # ── SO ASK, RATHER THAN ASSUME EITHER WAY ─────────────
                    #
                    # Unconditionally holding breaks the gated case; never
                    # holding breaks the un-gated one. Both are real: the
                    # plugin's gate keys on `session.error`, and not every way a
                    # turn can die is guaranteed to emit one (a turn that simply
                    # stops with no signal does not).
                    #
                    # The harness can just LOOK. `completed_compactions_since`
                    # is the same evidence `_settle_after_chunk` requires at the
                    # boundary, so this asks the one question that decides it:
                    # has this chunk already had its compaction?
                    #
                    #   already fired -> HOLD (`repair`). The re-drive must
                    #                    not spend a second fire (the chunk-4
                    #                    double-fire that exhausted the budget
                    #                    by chunk 6).
                    #   not fired     -> REPUBLISH `build`. The re-drive's
                    #                    completion is this chunk's one real
                    #                    boundary, and holding would make
                    #                    `_settle_after_chunk` abort the cell
                    #                    with no_compaction_evidence (measured,
                    #                    run 1789127719 chunk 5). The republish
                    #                    is active, not a no-op: the loop-kill
                    #                    sidecar writes `repair` at its kill,
                    #                    and the stall-abort hold writes it too
                    #                    — this is the ONLY place that restores
                    #                    `build`, so without it the boundary
                    #                    idle could never summarize.
                    #
                    # A read failure — or a watermark never captured (`None`) —
                    # FAILS OPEN to `build` (WO-25). Holding on a lost read
                    # strands the sentinel on `repair` for the rest of the
                    # drive, which kills the cell at the boundary with
                    # no_compaction_evidence: the exact measured failure above.
                    # The double-fire a wrong open risks instead is the lesser
                    # cost — it burns one budget fire, and every later nudge
                    # re-probes.
                    try:
                        already = (
                            serve_client.completed_compactions_since(
                                session_id, compact_watermark
                            )
                            if compact_watermark is not None
                            else 0
                        )
                    except ServeClientError:
                        already = 0
                    self._publish_compact_phase(
                        active_cell=active_cell, phase=phase, held=bool(already)
                    )
                    continue
                if recoverable and killed_reason is None and exit_code == 0:
                    # BUDGET EXHAUSTED (WO-COMPACTION-RESTORE C5A). The kill is
                    # still classified recoverable, but the drive stops
                    # re-driving: it falls through to the SAME outcome a
                    # NON-recoverable terminal gets — the anomaly stays
                    # unretried, the loop breaks below, the drive ends, and the
                    # unretried anomaly climbs the cell ledger. Fail-closed: a
                    # kill that repeats past the budget is a storm, and the
                    # 2026-09-02 compaction-looping incident (126+ recovery
                    # events) is what an unbounded storm costs.
                    # THE STORM LIMIT. The kill is still classified recoverable
                    # but the drive stops re-driving, so this turn stays
                    # unretried and climbs the cell ledger. `error`: unlike a
                    # nudge, nothing here recovers, and the 2026-09-02 compaction
                    # incident (126+ recovery events) is what the unbounded
                    # version costs.
                    live = getattr(self, "_live", None)
                    if live is not None:
                        live.notice(
                            "harness",
                            "recovery_budget_exhausted",
                            level="error",
                            cell_seq=getattr(self, "_cell_seq", None),
                            session_id=session_id,
                            detail={
                                "phase": phase,
                                "terminal": mapped_terminal,
                                "nudges": recovery_nudges,
                                "budget": _MAX_SERVE_RECOVERY_NUDGES,
                            },
                        )
                    self._progress(
                        f"PROGRESS run_label={run_label} step=transport-recovery "
                        f"phase={phase} terminal={mapped_terminal} "
                        f"action=budget_exhausted nudges={recovery_nudges} "
                        f"budget={_MAX_SERVE_RECOVERY_NUDGES} session_id={session_id}"
                    )
            break

        turn_anomalies: tuple[dict[str, Any], ...] = tuple(turn_anomaly_list)

        def _d(key: str) -> int:
            end_v = int(m.get(key, 0) or 0)
            return end_v - int(baseline.get(key, 0) or 0)

        d_input = _d("input_tokens")
        d_output = _d("output_tokens")
        d_reasoning = _d("reasoning_tokens")
        d_cache_read = _d("cache_read_tokens")
        d_cache_write = _d("cache_write_tokens")
        d_turns = _d("turns")
        # WO-LOOPKILL-1: marker-backed loop kills are guard kills the
        # transcript-driven delta cannot see (the sidecar killed the request
        # before any signature persisted), so the drive's own count is added
        # here. Each is then excluded from scoring turns exactly like a
        # transcript-visible guard abort (WO-TURNACCT-1) and carried on
        # guard_aborted_turns — never silent.
        d_guard_aborted = _d("guard_aborted_turns") + loop_killed_turns
        d_finalize_timeouts = _d("finalize_timeouts")
        # WO-TURNACCT-1 (Walter 2026-08-10): guard-killed turns are EXCLUDED
        # from scoring turns — their tokens stay metered (real burn), the
        # excluded count is carried on guard_aborted_turns (never silent), and
        # the raw session turn_index cursors stay untouched (watermarks key on
        # them). A killed turn never reads as completed work: the subtraction
        # is what keeps the measurement honest (RC-4).
        # WO-NUDGE-INF-1 (Walter 2026-08-11): finalize-killed turns are excluded
        # on exactly the same grounds. This is what keeps recovery from
        # inflating the measurement: a phase that was nudged N times reports
        # the same scoring turns as one that was never nudged, while every
        # burned token stays on the token counters.
        scoring_turns = max(0, d_turns - d_guard_aborted - d_finalize_timeouts)
        d_truncations = _d("truncations")
        d_cost = float(m.get("cost_usd", 0.0) or 0.0) - float(
            baseline.get("cost_usd", 0.0) or 0.0
        )

        if exit_code == 0 and d_turns <= 0 and d_output <= 0 and d_input <= 0:
            # The phase reached idle but produced NOTHING: the final assistant
            # message was discarded (relay stream-finalize defect, 2026-08-09)
            # or the serve never generated. Loud exit 1 — never a clean zero
            # that lets gates run against a stale worktree.
            exit_code = 1
            turn_anomalies = turn_anomalies + (
                {
                    "phase": str(phase),
                    "turn_index": int(m.get("turns", 0)),
                    "terminal": "silent_phase",
                    "reason": "phase produced zero new turns and zero new tokens",
                    "tool_uses": 0,
                },
            )
            self._progress(
                f"PROGRESS run_label={run_label} step=serve-drive phase={phase} "
                f"status=silent_phase session_id={session_id}"
            )

        self._progress(
            f"PROGRESS run_label={run_label} step=serve-drive-end phase={phase} "
            f"turns={scoring_turns} guard_aborted_turns={d_guard_aborted} "
            f"finalize_timeout_turns={d_finalize_timeouts} "
            f"observation_lost={'1' if observation_lost else '0'} "
            f"recovery_nudges={recovery_nudges} "
            f"session_turns={m.get('turns', 0)} "
            f"input={d_input} output={d_output} reasoning={d_reasoning} "
            f"cache_read={d_cache_read} cache_write={d_cache_write} "
            f"session_id={session_id} cost_usd={d_cost:.4f} "
            f"status={'ok' if idle else 'timeout'}"
        )

        return _OpencodeRunStats(
            input_tokens=d_input,
            output_tokens=d_output,
            reasoning_tokens=d_reasoning,
            cache_read_tokens=d_cache_read,
            cache_write_tokens=d_cache_write,
            turns=scoring_turns,
            session_id=session_id,
            killed_reason=killed_reason,
            exit_code=exit_code,
            cost_usd=d_cost,
            budget_stop_detected=False,
            budget_stop_signature=None,
            truncations=d_truncations,
            zero_tool_turns=0,
            terminal_zero_tool_turn=False,
            zero_tool_resumes=0,
            zero_tool_turn_honest_fail=False,
            resume_count=0,
            turn_anomalies=turn_anomalies,
            unmetered_turns=0,
            unmetered_turn_wall_s=0.0,
            recovery_nudges=recovery_nudges,
            guard_aborted_turns=d_guard_aborted,
            finalize_timeout_turns=d_finalize_timeouts,
            observation_lost_turns=1 if observation_lost else 0,
            context_exhausted=context_hit,
            context_tokens=context_size,
            context_limit_tokens=context_limit,
        )

    def _run_opencode_serve_chunked(
        self,
        *,
        active_cell: DockerCell,
        serve_client: ServeClient,
        session_id: str,
        prompts: list[str],
        run_label: str,
        sidecar_path: Path | None = None,
        prior_cost_usd: float = 0.0,
        timeout_s: float = 5400.0,
        kill_hook: Callable[[], None] | None = None,
    ) -> _OpencodeRunStats:
        """WO-77 chunked first pass: drive the chunk prompts IN ORDER through the
        one serve session.

        PER CHUNK: drive -> settle the worker's own
        compaction -> next chunk. A drive is over when the session goes IDLE;
        a non-zero exit ends the whole build there and every later chunk is
        reported ``not_reached``.

        NOTHING HERE READS WHAT THE MODEL WROTE (WO-MARKER-RIP, 2026-09-09).
        The loop used to scan each chunk's own messages for a `CHUNK FINISHED`
        string and re-drive up to ten times when it was absent. That was a
        self-report gating an event the transport already reports, and it is
        deleted — prompts, scan, nudge, budget and failure reason alike.

        Aggregates are the sum of per-chunk deltas (the per-phase metering in
        :meth:`_run_opencode_serve` is delta-true).
        """
        sum_input = 0
        sum_output = 0
        sum_reasoning = 0
        sum_cache_read = 0
        sum_cache_write = 0
        sum_turns = 0
        sum_cost = 0.0
        sum_truncations = 0
        sum_recovery_nudges = 0
        sum_guard_aborted = 0
        sum_finalize_timeouts = 0
        sum_observation_lost = 0
        anomalies: list[dict[str, Any]] = []
        chunk_reports: list[dict[str, Any]] = []

        def _aggregate(
            *,
            exit_code: int | None,
            killed_reason: str | None,
            context: _OpencodeRunStats | None = None,
        ) -> _OpencodeRunStats:
            return _OpencodeRunStats(
                input_tokens=sum_input,
                output_tokens=sum_output,
                reasoning_tokens=sum_reasoning,
                cache_read_tokens=sum_cache_read,
                cache_write_tokens=sum_cache_write,
                turns=sum_turns,
                session_id=session_id,
                killed_reason=killed_reason,
                exit_code=exit_code,
                cost_usd=sum_cost,
                truncations=sum_truncations,
                turn_anomalies=tuple(anomalies),
                chunk_reports=tuple(chunk_reports),
                recovery_nudges=sum_recovery_nudges,
                guard_aborted_turns=sum_guard_aborted,
                finalize_timeout_turns=sum_finalize_timeouts,
                observation_lost_turns=sum_observation_lost,
                context_exhausted=bool(context and context.context_exhausted),
                context_tokens=context.context_tokens if context else 0,
                context_limit_tokens=context.context_limit_tokens if context else None,
            )

        def _drive(phase: str, prompt: str) -> _OpencodeRunStats:
            nonlocal \
                sum_input, \
                sum_output, \
                sum_reasoning, \
                sum_turns, \
                sum_cost, \
                sum_truncations
            nonlocal sum_cache_read, sum_cache_write
            nonlocal sum_recovery_nudges, sum_guard_aborted, sum_finalize_timeouts
            nonlocal sum_observation_lost
            stats = self._run_opencode_serve(
                active_cell=active_cell,
                serve_client=serve_client,
                session_id=session_id,
                prompt=prompt,
                run_label=run_label,
                phase=phase,
                prior_cost_usd=prior_cost_usd + sum_cost,
                timeout_s=timeout_s,
                kill_hook=kill_hook,
            )
            sum_input += stats.input_tokens
            sum_output += stats.output_tokens
            sum_reasoning += stats.reasoning_tokens
            sum_cache_read += stats.cache_read_tokens
            sum_cache_write += stats.cache_write_tokens
            sum_turns += stats.turns
            sum_cost += stats.cost_usd
            sum_truncations += stats.truncations
            sum_recovery_nudges += stats.recovery_nudges
            sum_guard_aborted += stats.guard_aborted_turns
            sum_finalize_timeouts += stats.finalize_timeout_turns
            sum_observation_lost += stats.observation_lost_turns
            anomalies.extend(stats.turn_anomalies)
            return stats

        for index, chunk_prompt in enumerate(prompts, start=1):
            phase = f"initial-chunk-{index}"
            if sidecar_path is not None:
                self._append_user_event(
                    kind="chunk",
                    run_label=run_label,
                    sidecar_path=sidecar_path,
                    attempt=1,
                    text=chunk_prompt,
                )
            report: dict[str, Any] = {
                "chunk": index,
                "recovery_nudges": 0,
                "guard_aborted_turns": 0,
                "finalize_timeout_turns": 0,
            }
            # Watermark BEFORE the drive. `_settle_after_chunk` counts the
            # worker's own compactions since this point, and the fire happens
            # DURING one of the drives below — a watermark taken afterwards
            # sits past it and reads zero.
            watermark = len(serve_client.get_messages(session_id))
            stats = _drive(phase, chunk_prompt)
            report["recovery_nudges"] += stats.recovery_nudges
            report["guard_aborted_turns"] += stats.guard_aborted_turns
            report["finalize_timeout_turns"] += stats.finalize_timeout_turns
            report.update(
                turns=stats.turns,
                input_tokens=stats.input_tokens,
                output_tokens=stats.output_tokens,
                exit_code=stats.exit_code,
                # Named cause, for the operator strip: "died (run_timeout)"
                # rather than "died (exit_code=1)".
                killed_reason=stats.killed_reason,
            )
            chunk_reports.append(report)
            if stats.context_exhausted:
                # The build stops where it ran out of room: no settle, no next
                # chunk. The runner ends the cell as CONTEXT EXHAUSTED.
                return _aggregate(
                    exit_code=0, killed_reason=CONTEXT_EXHAUSTED, context=stats
                )
            if stats.exit_code != 0:
                return _aggregate(
                    exit_code=stats.exit_code, killed_reason=stats.killed_reason
                )

            # ── LET THE WORKER'S OWN COMPACTION SETTLE ──────────────────────
            #
            # The chunk is closed. If self-compaction is armed, the plugin saw
            # the phase sentinel read `build` on the boundary drive's
            # session.idle and fired its own summarize — which happens DURING
            # that drive, not after it: the plugin fires the moment idle is
            # published, before the drive's stable-idle wait returns, so the
            # compaction has typically already completed by the time the drive
            # reports serve-drive-end. Detection therefore uses the PRE-DRIVE
            # watermark (captured above), not a fresh one taken now — a
            # post-drive watermark sits PAST the compaction and reports zero.
            #
            # THE HARNESS OBSERVES, IT DOES NOT DRIVE. It waits (bounded) and
            # requires the worker's own summarize to have landed a compaction
            # part since the pre-drive watermark: no part is
            # no_compaction_evidence and aborts the cell. It never triggers,
            # never substitutes, never retries — driver-issued compaction is
            # what turned one killed generation into a 40-minute storm on
            # 2026-09-03 (68 kills, run 1788415430).
            if self.compact:
                self._settle_after_chunk(
                    serve_client=serve_client,
                    session_id=session_id,
                    run_label=run_label,
                    chunk=index,
                    watermark=watermark,
                )

        return _aggregate(exit_code=0, killed_reason=None)

    def _settle_after_chunk(
        self,
        *,
        serve_client: ServeClient,
        session_id: str,
        run_label: str,
        chunk: int,
        watermark: int,
    ) -> None:
        """Bounded wait for the WORKER'S OWN compaction. Fail-closed.

        The worker plugin fires its own summarize on the session.idle of the
        drive the phase sentinel flagged as the chunk boundary — DURING that
        drive, so the compaction has usually already completed by the time this
        is called. The harness only OBSERVES that fire — it never triggers it
        and never substitutes for it. At the chunk boundary it holds the next
        prompt back until the session settles (bounded by
        ``_COMPACT_SETTLE_TIMEOUT_S``, with a short ``_COMPACT_SETTLE_GRACE_S``
        for the generation to start), then requires at least one COMPLETED
        compaction part to have landed since ``watermark`` — which MUST be the
        PRE-DRIVE message count, not a fresh one taken here (a post-drive
        count sits past the already-completed compaction and reads zero).

        FAIL-CLOSED CONTRACT. Success is: the wait settled AND the worker's
        own summarize landed at least one compaction part. Anything else —
        the wait timed out, the plugin never fired, or the generation was
        killed (a guard-killed compaction still carries ``summary: true`` but
        an error, and is not counted) — is ``no_compaction_evidence``: the
        cell ABORTS with :class:`ServeTransportError`. There is no substitute
        summarize and no "continue uncompacted": a cell that was armed to
        compact and did not is a broken measurement, not a cheaper one.
        """
        deadline = time.monotonic() + _COMPACT_SETTLE_TIMEOUT_S
        # The plugin fires on idle, so the session may not be busy YET. Give it a
        # short grace to go busy before concluding nothing is coming.
        went_busy = serve_client.wait_busy(
            session_id, timeout_s=_COMPACT_SETTLE_GRACE_S
        )
        settled = True
        if went_busy:
            remaining = max(1.0, deadline - time.monotonic())
            settled = serve_client.wait_idle(session_id, timeout_s=remaining)

        compactions = serve_client.completed_compactions_since(session_id, watermark)
        if not settled or compactions == 0:
            # FAIL-CLOSED: the worker's own summarize is the only compaction
            # there is. No evidence of it within the bounded wait aborts the
            # cell — never a substitute summarize, never "continue uncompacted".
            self._progress(
                f"PROGRESS run_label={run_label} step=self-compact chunk={chunk} "
                f"status=no_compaction_evidence settled={settled} "
                f"went_busy={went_busy} compactions={compactions} "
                f"budget_s={_COMPACT_SETTLE_TIMEOUT_S:.0f}"
            )
            raise ServeTransportError(
                f"no_compaction_evidence: run_label={run_label} chunk={chunk} — "
                f"the worker's own summarize landed {compactions} compaction "
                f"part(s) within the bounded wait (settled={settled}, "
                f"went_busy={went_busy}, "
                f"budget_s={_COMPACT_SETTLE_TIMEOUT_S:.0f}). The harness "
                "observes only and never fires a substitute, so the cell "
                "aborts instead of continuing uncompacted."
            )
        self._progress(
            f"PROGRESS run_label={run_label} step=self-compact chunk={chunk} "
            f"status=compacted compactions={compactions}"
        )
