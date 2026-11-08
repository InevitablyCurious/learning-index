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
turn-terminal reasons, the serve_client reasons and
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
    max_context_tokens,
    message_context_tokens,
    model_limits,
    output_cap,
)
from harness.serve_client import (
    COMPACTIONS_BEFORE_GRADE_WAIT_REASON,
    LOOP_KILL_WAIT_REASON,
    WORKER_DIED,
    REASON_LOOP_GUARD,
    REASON_MODEL_SILENT,
    REASON_PROVIDER_UNAVAILABLE,
    RECOVERABLE_STREAM_DEATH_REASONS,
    TERMINAL_GUARD_ABORT,
    TERMINAL_TRANSPORT_ERROR,
    ServeClient,
    ServeClientError,
    classify_transport_anomaly,
    set_read_retry_observer,
)
from harness.serve_transport import (
    last_assistant_message,
    message_generation_tokens,
    message_has_tool_part,
)

from ..docker_worker import LOOP_KILL_MARKER_DIRNAME, DockerCell
from .constants import (
    _CAP_CUTOFF_RECOVERY_NUDGE,
    _FINALIZE_RECOVERY_NUDGE,
    _LOOP_RECOVERY_NUDGE,
    _MAX_CAP_CUTOFF_NUDGES,
    _MAX_SERVE_RECOVERY_NUDGES,
    _PROVIDER_RECOVERY_NUDGE,
    _STALL_RECOVERY_NUDGE,
    DEFAULT_TURN_STALL_TIMEOUT_S,
    REASON_OBSERVATION_LOST,
    REASON_TOOL_CALL_TIMEOUT,
    TRUNCATION_EVIDENCE_FILENAME,
    TURN_TERMINAL_CAP_CUTOFF,
    TURN_TERMINAL_GUARD_ABORT,
    TURN_TERMINAL_OBSERVATION_LOST,
    TURN_TERMINAL_STALLED,
    TURN_TERMINAL_TRANSPORT_ERROR,
    TURN_TERMINAL_TRUNCATED,
)
from .exceptions import ServeTransportError
from .models import _OpencodeRunStats
from .token_metrics import compute_delta, has_token_data, metrics_to_cumulative
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
        phase_label: dict[str, Any] | None = None,
        prior_cost_usd: float = 0.0,
        kill_hook: Callable[[], None] | None = None,
        attempt: int | None = None,
        compaction_watermark: int | None = None,
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

        IN-DRIVE COMPACTIONS GATE: when ``compaction_watermark`` is set
        (feedback rounds only), it is handed to ``wait_idle_detailed``, which
        counts completed compactions since it ON ITS OWN POLL TICKS -- so a
        model that never goes idle is covered too -- and returns the
        ``compactions_before_grade`` reason at the second. The drive maps that
        reason onto ``compactions_since_grade=2`` and ends; the count has no
        other source.
        """
        if kill_hook is None:
            kill_hook = active_cell.kill_worker_processes

        # THE PHASE OPENS HERE, and this is the one place every scoring attempt
        # passes through. Build chunks and feedback/troubleshoot rounds both
        # arrive at this method carrying their phase name, so a single re-emit
        # here keeps the board's phase spine lit for the whole run instead of
        # only where a chunk happens to close.
        #
        # `phase.start` means "a phase OPENED" -- it is published BEFORE this
        # attempt's prompt goes out, so a reader knows what the cell is about to
        # do rather than what it just finished. The heartbeat carries the same
        # phase (Heartbeat.set_phase) so every beat that follows says which
        # phase the cell is doing; before this site re-emitted, every heartbeat
        # record omitted its documented `phase` field entirely.
        #
        # NOT AT THE COMPACTION BOUNDARY (`_compact_after_chunk`): that site is
        # where a build chunk CLOSES, so emitting there would name the chunk
        # that just ended (one-chunk lag), and a feedback round has no harness
        # compaction boundary at all -- the phases that make up most of a run
        # would never emit, leaving the board to fall back on a lagging scrape
        # of the log.
        #
        # BOTH SPELLINGS RIDE THE EVENT. ``phase`` is the drive-phase string a
        # dashboard regexes; ``phase_label`` is the structured identity from
        # :func:`harness.prompt_pack.phase_label`, flattened in unchanged so the
        # event and every following heartbeat carry the same four keys.
        live = getattr(self, "_live", None)
        if live is not None:
            live.emit(
                "phase.start",
                cell_seq=getattr(self, "_cell_seq", None),
                phase=str(phase),
                **(phase_label or {}),
            )
        heartbeat = getattr(self, "_heartbeat", None)
        if heartbeat is not None:
            heartbeat.set_phase(str(phase), label=phase_label)

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

        # WO-CUTOFF: phase-start message count for the context-peak read.
        # Unlike class_watermark this NEVER advances — the peak must span the
        # whole phase, including any recovery re-drives.
        context_peak_watermark = class_watermark

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
        # WO-CUTOFF: cap cut-off nudges have their OWN budget, separate from
        # recovery_nudges/_MAX_SERVE_RECOVERY_NUDGES — a length cut at OUR cap
        # is not a transport fault and must not spend (or be starved by) the
        # transport-recovery budget.
        cap_cutoffs_nudged = 0
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
        # WO-CUTOFF: the effective per-response output cap and the model's full
        # context window. context_limit_tokens above already validated the
        # model, so model_limits cannot raise here.
        cap = output_cap(getattr(self, "max_output_tokens", None))
        context_window = model_limits(self.model)["context"]
        context_hit = False
        context_size = 0
        # In-drive compactions-before-grade: completed compactions since the
        # grade watermark. Set to the threshold (2) ONLY when the wait reports
        # the ``compactions_before_grade`` reason; 0 otherwise. The WAIT owns the
        # count (it covers a model that never goes idle); this variable only
        # carries the verdict onto the stats. >= 2 ends the drive.
        compactions_seen = 0
        # THE SESSION'S OWN COMPACTION CLOCK, DIFFED PER DRIVE. The client's
        # accumulator spans every wait this session ever ran, so the pre-drive
        # reading is the baseline and the drive's report is the difference —
        # compactions the runner can act on (re-hand the spec to a context that
        # no longer holds it). Distinct from `compactions_seen`, which is the
        # wait's in-drive verdict and drives the >= 2 abort.
        compactions_observed_baseline = serve_client.live_compactions_observed()
        # WORKER DIED: asked only when the serve stops answering. A cell with no
        # liveness check (a test fake) never reports a death.
        worker_state = getattr(active_cell, "worker_state", None)
        worker_exit: dict[str, Any] | None = None

        def _worker_alive() -> bool:
            nonlocal worker_exit
            if worker_state is None:
                return True
            state = worker_state()
            if not state.get("running", True):
                worker_exit = state
                return False
            return True

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
            silent_this_turn = False
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
                    stall_timeout_s=DEFAULT_TURN_STALL_TIMEOUT_S,
                    loop_kill_marker_dir=loop_kill_marker_dir,
                    turn_start_ts_ms=turn_start_ts_ms,
                    worker_alive=_worker_alive,
                    # Feedback rounds arm the compactions-before-grade rule; the
                    # chunked build leaves it None, so a build's own compaction
                    # is never counted (feedback-only BY CONSTRUCTION).
                    compaction_watermark=compaction_watermark,
                )
            # ── TWO COMPACTIONS BEFORE A GRADE ENDS THE CELL (IN-DRIVE) ─────
            #
            # The wait counted two completed compactions since the grade
            # watermark, either while the session stayed BUSY (never idle — the
            # hole this closes) or on the idle transition. Carry the threshold
            # count and end the drive: the runner reads
            # `compactions_since_grade >= 2` and maps it to the
            # compactions_before_grade terminal (verdict FAIL, reason, notice,
            # progress line) EXACTLY once — that block is unchanged.
            #
            # THIS MUST SIT BEFORE `if not idle:`. The reason is returned with
            # idle=False, so without this branch the drive falls into the
            # non-idle arm below, which treats a threshold the wait SIGNALLED as
            # a wedged turn, and aborts + kill-hooks a worker that did nothing
            # wrong. The wait SIGNALS, this drive MAPS, the runner DECIDES.
            if wait_reason == COMPACTIONS_BEFORE_GRADE_WAIT_REASON:
                compactions_seen = 2
                break
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
                # The bound fired with no command running: the model server
                # sent nothing. Ended the same way as a stall, classified as ours.
                silent_this_turn = wait_reason == REASON_MODEL_SILENT
                if wait_reason == WORKER_DIED:
                    # Nothing to abort or kill: the container is gone. Say so
                    # and end the phase; the runner ends the cell.
                    live = getattr(self, "_live", None)
                    if live is not None:
                        live.notice(
                            "harness",
                            "worker_died",
                            level="error",
                            cell_seq=getattr(self, "_cell_seq", None),
                            session_id=session_id,
                            detail={"phase": phase, **(worker_exit or {})},
                        )
                    self._progress(
                        f"PROGRESS run_label={run_label} step=worker-died phase={phase} "
                        f"exit_code={(worker_exit or {}).get('exit_code')} "
                        f"detail={(worker_exit or {}).get('detail')} session_id={session_id}"
                    )
                    return _OpencodeRunStats(
                        input_tokens=0,
                        output_tokens=0,
                        reasoning_tokens=0,
                        turns=0,
                        session_id=session_id,
                        killed_reason=WORKER_DIED,
                        exit_code=1,
                        cost_usd=0.0,
                        turn_anomalies=tuple(turn_anomaly_list),
                        recovery_nudges=recovery_nudges,
                    )
                if loop_killed_this_turn:
                    loop_killed_turns += 1
                # else: stalled_this_turn. WO-21 STALL-RECOVERY (operator ruling
                # 2026-09-11): a stalled turn now rides the SAME recoverable path
                # as a loop kill — killed_reason/exit_code stay clean so the
                # recovery gate passes; the classifier forces TURN_TERMINAL_STALLED
                # below and the stall is counted from its anomaly record.
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
                    f"status={'loop_killed' if loop_killed_this_turn else ('turn_stalled' if stalled_this_turn else (REASON_MODEL_SILENT if silent_this_turn else wait_reason))} "
                    f"wait_reason={wait_reason} "
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
                # error_texts/provider_truncations/cap_cutoffs/error_parts/
                # info_errors) and would
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

            # WO-LIVE-02: the turn finished and its session-cumulative metrics
            # are in hand. Publish THIS turn's spend -- the delta against the
            # previous completed turn of the same session -- so the board can
            # draw a realtime token bar from the record instead of scraping a
            # log. `_token_prev` survives the retry loop (and later phases that
            # reuse the session) because it keyed on session_id, not on `self`.
            #
            # OBSERVATION-LOST IS NOT A TURN. That arm fabricates `m` from the
            # phase baseline, so emitting from it would publish a fake zero
            # delta; an unobservable read emits NOTHING rather than zeros.
            if not observation_lost and has_token_data(m):
                live = getattr(self, "_live", None)
                if live is not None:
                    cur = metrics_to_cumulative(m)
                    token_prev = getattr(self, "_token_prev", None)
                    if token_prev is None:
                        token_prev = {}
                        self._token_prev = token_prev
                    prev = token_prev.get(session_id)
                    label = phase_label or {}
                    live.emit(
                        "turn.tokens",
                        cell_seq=getattr(self, "_cell_seq", None),
                        phase_index=label.get("phase_index"),
                        phase_name=label.get("phase_name"),
                        phase_kind=label.get("phase_kind"),
                        delta=compute_delta(prev, cur),
                        cumulative=cur,
                    )
                    token_prev[session_id] = cur

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
            #
            # THE OVERFLOW-ONLY RESIDUAL. A session that compacts when it needs
            # to never reaches this check — the summarize rewrites the window
            # and the turn continues. This is what is left for a context too
            # large to compact at all: the provider's own ContextOverflowError,
            # which no nudge and no summarize can clear.
            try:
                context_hit, context_size = context_exhausted(
                    serve_client.get_messages(session_id), context_limit
                )
            except ServeClientError:
                context_hit = False
            if context_hit:
                killed_reason = CONTEXT_EXHAUSTED
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

            # ── FAIL-FAST: compaction is loop-killing ──────────────────────
            #
            # When self-compaction is armed, the HARNESS drives the summarize at
            # each chunk boundary (:meth:`_compact_after_chunk`). If the relay's
            # loop guard kills a compaction, opencode AUTO-RETRIES it
            # (compaction_restores) — a self-sustaining storm. The harness must
            # NOT nudge around it: a recovery nudge does not fire a compaction
            # and only feeds another turn into the storm, and nudging around
            # opencode's retry loop is exactly the 2026-09-03 10-minute hang
            # (run 1788451466: compact-1 ok, compact-2 relay_loop_detected xN,
            # nudged to the budget).
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
            elif silent_this_turn:
                # Ours, not the model's (Jerry, 2026-09-24): recovered like a
                # provider outage, with its nudge — never "that command ran".
                terminal, reason = TERMINAL_TRANSPORT_ERROR, REASON_MODEL_SILENT
            if terminal is not None:
                if terminal == "truncated":
                    mapped_terminal = TURN_TERMINAL_TRUNCATED
                elif terminal == TERMINAL_GUARD_ABORT:
                    mapped_terminal = TURN_TERMINAL_GUARD_ABORT
                elif terminal == "transport_error":
                    mapped_terminal = TURN_TERMINAL_TRANSPORT_ERROR
                else:
                    mapped_terminal = terminal
                # ── CAP CUT-OFF (WO-CUTOFF): "length" at OUR output cap ──────
                # A turn that ends finish_reason=length AT/above our own cap is
                # not a provider truncation: it is the model running into the
                # fixed per-response limit. Detected here, BEFORE the anomaly
                # record is built, so the record's terminal reads "cap_cutoff".
                is_cap_cutoff = False
                cap_cutoff_has_tool_part = False
                cap_cutoff_output = 0
                cap_cutoff_reasoning = 0
                cap_cutoff_last_context = 0
                if (
                    mapped_terminal == TURN_TERMINAL_TRUNCATED
                    and m.get("last_finish") == "length"
                ):
                    # Fail loud: an unread session would score the cut
                    # response as 0 tokens, i.e. a provider truncation, and
                    # void a cell over our own cap — the exact error this
                    # classification exists to remove.
                    try:
                        _cap_msgs = serve_client.get_messages(session_id)
                    except ServeClientError as exc:
                        raise ServeTransportError(
                            f"could not read session {session_id} to classify a length "
                            f"finish as a cap cut-off: {exc}"
                        ) from exc
                    _cap_last = last_assistant_message(_cap_msgs)
                    cap_cutoff_output, cap_cutoff_reasoning = message_generation_tokens(
                        _cap_last
                    )
                    if cap_cutoff_output + cap_cutoff_reasoning >= cap:
                        is_cap_cutoff = True
                        cap_cutoff_has_tool_part = message_has_tool_part(_cap_last)
                        # Prompt + the cut output: all of it is in the context
                        # the nudge's answer has to fit beside.
                        cap_cutoff_last_context = message_context_tokens(_cap_last)
                if is_cap_cutoff:
                    mapped_terminal = TURN_TERMINAL_CAP_CUTOFF
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
                        truncations_seen=int(m.get("provider_truncations", 0) or 0)
                        + int(m.get("cap_cutoffs", 0) or 0),
                    ),
                    evidence_path=evidence_path,
                )
                # ── CAP CUT-OFF RECOVERY (WO-CUTOFF): own budget, own guard ─────
                # A cap cut-off is the fifth recovery member but rides NONE of
                # the shared path below: it has its own nudge budget
                # (_MAX_CAP_CUTOFF_NUDGES, separate from
                # _MAX_SERVE_RECOVERY_NUDGES) and a context guard — nudging is
                # pointless when the last request's context plus one full-cap
                # response cannot fit the model's window. This block always
                # continues (nudged) or breaks (not nudged), so a cap cut-off
                # never reaches the shared `recoverable` set.
                if is_cap_cutoff:
                    cap_nudged = False
                    cap_reason = "budget_spent"
                    if killed_reason is None and exit_code == 0:
                        if (cap_cutoff_last_context + cap) >= context_window:
                            cap_reason = "no_context_room"
                        elif cap_cutoffs_nudged >= _MAX_CAP_CUTOFF_NUDGES:
                            cap_reason = "budget_spent"
                        else:
                            cap_nudged = True
                            cap_reason = "nudged"
                    live = getattr(self, "_live", None)
                    if live is not None:
                        live.notice(
                            "harness",
                            "length_cutoff",
                            level="warn" if cap_nudged else "error",
                            cell_seq=getattr(self, "_cell_seq", None),
                            session_id=session_id,
                            detail={
                                "phase": phase,
                                "attempt": attempt,
                                "nudged": cap_nudged,
                                "reason": cap_reason,
                                "output_tokens": cap_cutoff_output,
                                "reasoning_tokens": cap_cutoff_reasoning,
                                "cap": cap,
                                "wording": (
                                    "cut-off"
                                    if cap_cutoff_has_tool_part
                                    else "cap-cutoff"
                                ),
                            },
                        )
                    if cap_nudged:
                        anomaly_record["retried"] = True
                        anomaly_record["retry_kind"] = "cap_cutoff_nudge"
                        cap_cutoffs_nudged += 1
                        prompt_to_send = (
                            _FINALIZE_RECOVERY_NUDGE
                            if cap_cutoff_has_tool_part
                            else _CAP_CUTOFF_RECOVERY_NUDGE
                        )
                        try:
                            class_watermark = len(serve_client.get_messages(session_id))
                        except ServeClientError:
                            pass
                        continue
                    break
                # The provider said it was unavailable, or sent nothing at all.
                is_provider_outage = (
                    mapped_terminal == TURN_TERMINAL_TRANSPORT_ERROR
                    and str(reason or "")
                    in (REASON_PROVIDER_UNAVAILABLE, REASON_MODEL_SILENT)
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
                            f"reason={reason} "
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
                    # ── RE-DRIVE. No compaction is involved here. ─────────
                    #
                    # The harness used to probe the transcript for "has this
                    # chunk already compacted?" and hold or release the phase
                    # sentinel accordingly — the sentinel being what told the
                    # worker plugin when to summarize. The plugin is gone: the
                    # harness fires the chunk's one summarize itself, at the
                    # boundary, AFTER the drive returns (see
                    # :meth:`_compact_after_chunk`). A recovery re-drive is
                    # therefore just another turn into the same session;
                    # whether it lands before or after the boundary changes
                    # nothing about the compaction, and there is nothing here
                    # to hold.
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
        d_provider_truncations = _d("provider_truncations")
        d_cap_cutoffs = _d("cap_cutoffs")
        d_cost = float(m.get("cost_usd", 0.0) or 0.0) - float(
            baseline.get("cost_usd", 0.0) or 0.0
        )

        if (
            exit_code == 0
            and d_turns <= 0
            and d_output <= 0
            and d_input <= 0
            and compactions_seen < 2
        ):
            # The phase reached idle but produced NOTHING: the final assistant
            # message was discarded (relay stream-finalize defect, 2026-08-09)
            # or the serve never generated. Loud exit 1 — never a clean zero
            # that lets gates run against a stale worktree.
            # The compaction rule ends the drive BEFORE the turn is metered, so
            # that abort is deliberate, not a silent phase, and must stay clean.
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
            f"status={'ok' if idle else (COMPACTIONS_BEFORE_GRADE_WAIT_REASON if compactions_seen >= 2 else wait_reason)}"
        )

        # The largest context of this phase, counted as opencode counts it
        # (prompt + output — the size the out-of-room check and opencode's own
        # TUI use), over the messages at/after the phase-start watermark. None
        # when absent — never 0. The request side alone read 192,334 on a run
        # whose TUI showed 256,688 (1790258326). Maxed into the cell's peak,
        # which cell.end states: a last round that never reaches grading counts.
        try:
            _context_msgs = serve_client.get_messages(session_id)[
                context_peak_watermark:
            ]
        except ServeClientError:
            _context_msgs = []
        context_peak = max_context_tokens(_context_msgs)
        if context_peak is not None:
            self._cell_context_peak = max(context_peak, self._cell_context_peak or 0)

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
            provider_truncations=d_provider_truncations,
            cap_cutoffs=d_cap_cutoffs,
            cap_cutoffs_nudged=cap_cutoffs_nudged,
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
            context_peak_tokens=context_peak,
            compactions_since_grade=compactions_seen,
            compactions_observed=serve_client.live_compactions_observed()
            - compactions_observed_baseline,
        )

    def _run_opencode_serve_chunked(
        self,
        *,
        active_cell: DockerCell,
        serve_client: ServeClient,
        session_id: str,
        prompts: list[str],
        phase_index: int | None = None,
        phase_label: dict[str, Any] | None = None,
        run_label: str,
        sidecar_path: Path | None = None,
        prior_cost_usd: float = 0.0,
        kill_hook: Callable[[], None] | None = None,
    ) -> _OpencodeRunStats:
        """WO-77 chunked first pass: drive the chunk prompts IN ORDER through the
        one serve session.

        PER CHUNK: drive -> one summarize (the harness fires
        it) -> next chunk. A drive is over when the session goes IDLE;
        a non-zero exit ends the whole build there and every later chunk is
        reported ``not_reached``.

        NOTHING HERE READS WHAT THE MODEL WROTE (WO-MARKER-RIP, 2026-09-09).
        The loop used to scan each chunk's own messages for a `CHUNK FINISHED`
        string and re-drive up to ten times when it was absent. That was a
        self-report gating an event the transport already reports, and it is
        deleted — prompts, scan, nudge, budget and failure reason alike.

        Aggregates are the sum of per-chunk deltas (the per-phase metering in
        :meth:`_run_opencode_serve` is delta-true).

        ``phase_index`` names the phase from the pack, not from the chunk's
        position in ``prompts``: a caller driving ONE phase per call passes its
        1-based pack index so ``initial-chunk-K`` survives. Omitted, the
        position names the chunk — which is what a multi-chunk direct call
        means.

        ``phase_label`` is the structured identity for that same phase
        (:func:`harness.prompt_pack.phase_label`). There is no emit here: every
        chunk drives through :meth:`_run_opencode_serve`, so the label rides the
        one ``phase.start`` each drive publishes and every heartbeat after it.
        """
        sum_input = 0
        sum_output = 0
        sum_reasoning = 0
        sum_cache_read = 0
        sum_cache_write = 0
        sum_turns = 0
        sum_cost = 0.0
        sum_provider_truncations = 0
        sum_cap_cutoffs = 0
        sum_cap_cutoffs_nudged = 0
        # Part D peak is MAXED across chunks, never summed — it is a size, not
        # a count. None until some chunk records one (absent, never 0).
        sum_context_peak: int | None = None
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
                provider_truncations=sum_provider_truncations,
                cap_cutoffs=sum_cap_cutoffs,
                cap_cutoffs_nudged=sum_cap_cutoffs_nudged,
                turn_anomalies=tuple(anomalies),
                chunk_reports=tuple(chunk_reports),
                recovery_nudges=sum_recovery_nudges,
                guard_aborted_turns=sum_guard_aborted,
                finalize_timeout_turns=sum_finalize_timeouts,
                observation_lost_turns=sum_observation_lost,
                context_exhausted=bool(context and context.context_exhausted),
                context_tokens=context.context_tokens if context else 0,
                context_limit_tokens=context.context_limit_tokens if context else None,
                context_peak_tokens=sum_context_peak,
            )

        def _drive(phase: str, prompt: str) -> _OpencodeRunStats:
            nonlocal \
                sum_input, \
                sum_output, \
                sum_reasoning, \
                sum_turns, \
                sum_cost, \
                sum_provider_truncations, \
                sum_cap_cutoffs, \
                sum_cap_cutoffs_nudged, \
                sum_context_peak
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
                phase_label=phase_label,
                prior_cost_usd=prior_cost_usd + sum_cost,
                kill_hook=kill_hook,
                attempt=1,
            )
            sum_input += stats.input_tokens
            sum_output += stats.output_tokens
            sum_reasoning += stats.reasoning_tokens
            sum_cache_read += stats.cache_read_tokens
            sum_cache_write += stats.cache_write_tokens
            sum_turns += stats.turns
            sum_cost += stats.cost_usd
            sum_provider_truncations += stats.provider_truncations
            sum_cap_cutoffs += stats.cap_cutoffs
            sum_cap_cutoffs_nudged += stats.cap_cutoffs_nudged
            if stats.context_peak_tokens is not None and (
                sum_context_peak is None or stats.context_peak_tokens > sum_context_peak
            ):
                sum_context_peak = stats.context_peak_tokens
            sum_recovery_nudges += stats.recovery_nudges
            sum_guard_aborted += stats.guard_aborted_turns
            sum_finalize_timeouts += stats.finalize_timeout_turns
            sum_observation_lost += stats.observation_lost_turns
            anomalies.extend(stats.turn_anomalies)
            return stats

        for index, chunk_prompt in enumerate(prompts, start=1):
            # The phase NAME is the pack's own 1-based index when the caller
            # drives one phase per call (`phase_index`). It must NOT be derived
            # from the sort position there: a single-element `prompts` always
            # enumerates to 1, which would label every phase `initial-chunk-1`
            # and erase phase identity from `phase.start` and the heartbeat.
            phase = (
                f"initial-chunk-{phase_index}"
                if phase_index is not None
                else f"initial-chunk-{index}"
            )
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
            stats = _drive(phase, chunk_prompt)
            report["recovery_nudges"] += stats.recovery_nudges
            report["guard_aborted_turns"] += stats.guard_aborted_turns
            report["finalize_timeout_turns"] += stats.finalize_timeout_turns
            report.update(
                turns=stats.turns,
                input_tokens=stats.input_tokens,
                output_tokens=stats.output_tokens,
                exit_code=stats.exit_code,
                # Named cause, for the operator strip: "died (worker_died)"
                # rather than "died (exit_code=1)".
                killed_reason=stats.killed_reason,
            )
            chunk_reports.append(report)
            if stats.killed_reason == WORKER_DIED:
                return _aggregate(exit_code=1, killed_reason=WORKER_DIED)
            if stats.context_exhausted:
                # The build stops where it ran out of room: no compaction, no
                # next chunk. The runner ends the cell as CONTEXT EXHAUSTED.
                return _aggregate(
                    exit_code=0, killed_reason=CONTEXT_EXHAUSTED, context=stats
                )
            if stats.exit_code != 0:
                return _aggregate(
                    exit_code=stats.exit_code, killed_reason=stats.killed_reason
                )

            # ── THE CHUNK BOUNDARY: COMPACT ONCE, HERE ─────────────────────
            #
            # The chunk is closed, so this is the boundary opencode's own
            # auto-compaction would fire on — if it fired at every boundary,
            # which it does not: it fires at a token threshold that a chunk may
            # reach mid-work and a chunk may never reach at all. The harness now
            # fires it explicitly, exactly once per chunk, after the drive
            # returns, and the call blocks until the rewrite is done. The next
            # chunk's prompt goes into the compacted session.
            #
            # The worker used to do this itself, reading a phase sentinel the
            # harness wrote, and the harness only observed the result and
            # aborted the cell when the evidence was missing. That inverted the
            # responsibility: the component that owns the boundary is the one
            # that should compact at it.
            if self.compact:
                self._compact_after_chunk(
                    serve_client=serve_client,
                    session_id=session_id,
                    run_label=run_label,
                    chunk=index,
                    phase_label=phase_label,
                    tokens_before=sum_context_peak,
                )

        return _aggregate(exit_code=0, killed_reason=None)

    def _compact_after_chunk(
        self,
        *,
        serve_client,
        session_id,
        run_label,
        chunk,
        phase_label: dict[str, Any] | None = None,
        tokens_before: int | None = None,
    ):
        """Compact the session once, after this build chunk (POST /summarize).

        The harness — not any worker plugin — fires the compaction now, and it
        is exactly one per chunk boundary. The summarize call blocks until the
        rewrite completes; ``auto=False`` because that flag means auto-continue
        AFTER compaction (inject the synthetic continue turn), and the harness
        drives the next chunk prompt itself.

        The ``compaction`` live event is emitted BEFORE the summarize, because
        it marks where the rewrite happened: once the session is rewritten the
        pre-compaction size is unrecoverable from the session. ``tokens_after``
        is never emitted — ``ServeClient.summarize`` returns ``None``, so no
        after-count exists and fabricating one would be a lie on the wire.
        """
        live = getattr(self, "_live", None)
        if live is not None:
            live.emit(
                "compaction",
                cell_seq=getattr(self, "_cell_seq", None),
                **(phase_label or {}),
                tokens_before=tokens_before,
            )
        provider_id, _, model_id = self.model.partition("/")
        serve_client.summarize(
            session_id, provider_id=provider_id, model_id=model_id, auto=False
        )
        self._progress(
            f"PROGRESS run_label={run_label} step=self-compact chunk={chunk} "
            f"status=compacted compactions=1"
        )
