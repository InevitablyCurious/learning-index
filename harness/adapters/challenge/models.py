"""Pure dataclass leaves for the challenge adapter.

Extracted verbatim from harness/adapters/challenge/__init__.py
(WO-LI15-I1A STAGE 1A) and re-exported there. Annotations stay lazy
(PEP 563) exactly as in the origin module: ChallengeCellResult names
ContentionCovariates and ImageFingerprint in annotations only, so no
runtime import of those is needed here.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RecallFunnelScan:
    recall_fired_total: int = 0
    recall_returned_total: int = 0
    recall_returned_count_sum: int = 0
    no_keywords_count: int = 0
    injected_count: int = 0
    served_attempted: int = 0
    served_failed: int = 0
    served_confirmed: int = 0


@dataclass(frozen=True)
class _OpencodeRunStats:
    input_tokens: int
    output_tokens: int
    reasoning_tokens: int
    turns: int
    session_id: str | None
    killed_reason: str | None
    exit_code: int | None
    cost_usd: float
    # PROMPT-CACHE ACCOUNTING (WO-TOKENS-ALL). Defaulted so every existing
    # construction site stays valid: a path that cannot observe cache reports 0
    # rather than forcing a guess. Summed across turns, never maxed — each turn
    # is billed for its own cache read.
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    budget_stop_detected: bool = False
    budget_stop_signature: str | None = None
    truncations: int = 0
    zero_tool_turns: int = 0
    terminal_zero_tool_turn: bool = False
    zero_tool_resumes: int = 0
    zero_tool_turn_honest_fail: bool = False
    resume_count: int = 0
    # WO-TRUNC-1: per-anomalous-turn terminal records (truncated/guard/transport
    # endings and their retries). Normal stop/tool-calls/length turns stay
    # aggregate-only. Each dict is a turn_terminal payload ready for the
    # append-only status stream.
    turn_anomalies: tuple[dict[str, Any], ...] = ()
    # WO-77 chunked first pass: one record per chunk (index, delta tokens,
    # exit code, recovery pressure). Empty for single-prompt phases.
    chunk_reports: tuple[dict[str, Any], ...] = ()
    # Turns whose usage frame never survived the stream drop: their true
    # upstream token burn is unmetered client-side (never synthesized), but
    # their measured wall-clock is real cost and lands here.
    unmetered_turns: int = 0
    unmetered_turn_wall_s: float = 0.0
    # WO-LOOPREC-1/FINALIZE-REC-1: recovery nudges this invocation fired after
    # relay loop-guard kills or finalize-watchdog kills (serve path only; see
    # _LOOP_RECOVERY_NUDGE/_FINALIZE_RECOVERY_NUDGE), bounded by
    # _MAX_SERVE_RECOVERY_NUDGES per phase.
    recovery_nudges: int = 0
    # WO-TURNACCT-1 (Walter 2026-08-10): guard-killed turns NEVER count toward
    # scoring turns. ``turns`` already excludes them; their count is carried
    # here so the exclusion is reported, never silent. Tokens stay metered.
    guard_aborted_turns: int = 0
    # WO-NUDGE-INF-1 (Walter 2026-08-11): finalize-killed turns are excluded
    # from scoring turns on the same grounds and counted here for the same
    # reason — the exclusion is reported, never silent. Tokens stay metered.
    finalize_timeout_turns: int = 0
    # D-SERVE-MESSAGE-500: phases whose transcript read failed past every
    # transient retry. Non-zero means the cell was measured blind and must be
    # gated VOID-INSTRUMENT rather than scored.
    observation_lost_turns: int = 0
    # CONTEXT EXHAUSTED (harness/context_budget.py): the session reached the
    # size at which opencode would have compacted, or a request overflowed.
    # The cell stops here; it is a result, not an instrument fault.
    context_exhausted: bool = False
    context_tokens: int = 0
    context_limit_tokens: int | None = None


@dataclass(frozen=True)
class _ProxyBudgetSnapshot:
    hard_cap_usd: float
    accrued_actual_usd: float
    accrued_derived_usd: float
    committed_unproven_usd: float
    remaining_usd: float
    checkpoint_path: str


@dataclass
class ChallengeCellResult:
    verdict: str
    attempts_to_green: int | str
    termination_reason: str
    conformed: bool
    input_tokens: int
    output_tokens: int
    turns: int
    wall_seconds: float
    delivery: str
    failed_gates: list[str]
    problems_final: list[dict[str, Any]]
    attempt_reports: list[dict[str, Any]]
    worktree: str
    session_id: str | None
    memory_mode: str
    model: str
    wall_cost_usd: float = 0.0
    # WO-TOKENS-ALL. Additive: `input_tokens`/`output_tokens` above are
    # UNCHANGED (output still carries reasoning inside it, as it always has).
    # These break the cell down by real category so the board can stack it, and
    # carry the cache figures the record has never held.
    reasoning_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    tool_calls: int | None = None
    test_invocations: int | None = None
    agentic_cycles: int | None = None
    problems_before: int | None = None
    injected_block_chars: int | None = None
    injected_block_est_tokens: int | None = None
    recall_fired_total: int | None = None
    recall_returned_total: int | None = None
    recall_returned_count_sum: int | None = None
    no_keywords_count: int | None = None
    injected_count: int | None = None
    served_attempted: int | None = None
    served_failed: int | None = None
    served_confirmed: int | None = None
    funnel_snapshot: dict[str, dict[str, int | None]] | None = None
    truncations: int = 0
    zero_tool_turns: int = 0
    zero_tool_resumes: int = 0
    zero_tool_turn_honest_fails: int = 0
    transport_resume_count: int = 0
    # WO-CHUNKVIS-1: one operator-facing row per build chunk (complete / died /
    # not_reached, with the stub count of the file that chunk owns). Display
    # only — nothing branches on it. None when the cell ran no chunked build.
    build_chunks: list[dict[str, Any]] | None = None
    # WO-TRUNC-1: ledger of anomalously-ended turns across every worker
    # invocation of the cell (truncated_no_signal / guard_abort /
    # transport_error / stream_died_open / unclassified_finish), each with its
    # retry linkage. truncated_turns counts them; truncated_turns_retried counts
    # those a later step or resume picked up.
    turn_anomalies: list[dict[str, Any]] | None = None
    truncated_turns: int = 0
    truncated_turns_retried: int = 0
    # ── THE VOID SIGNAL, STATED BY THE PRODUCER (2026-09-05) ──────────────
    #
    # Anomalous turns that are INSTRUMENT failures — every kind except
    # ``guard_abort``. This exists because ``truncated_turns`` is
    # ``len(turn_anomalies)``, i.e. ALL anomalies, and three separate consumers
    # were reading it as "a provider-side truncation signal" and voiding the
    # cell on it. A loop-guard abort is not a truncation and not an instrument
    # failure: the harness fired it, on purpose, at a model that was looping,
    # and then recovered the turn.
    #
    # Jerry's ruling, 2026-09-05: "nudging on a loop should be considered model
    # behaviour and not a void classifier." A model that loops is a CAPABILITY
    # observation and one of the more interesting ones this bench can make;
    # voiding the cell deletes it.
    #
    # Stated here rather than subtracted by each consumer — there are three of
    # them (run_artifacts.py, control/baselines.mjs,
    # dashboard/sources/stack-ledger.mjs) and three subtractions are three
    # chances to disagree about whether a cell is a measurement.
    instrument_anomaly_turns: int = 0
    # ── WO-I1 (2026-09-07): THE UNRECOVERED COMPLEMENT, STATED BY THE
    # PRODUCER ─────────────────────────────────────────────────────────────
    #
    # Instrument anomalies the harness did NOT recover — the anomalies that
    # ended a phase / were graded. Computed from the recoverability gate in
    # ``_run_opencode_serve``: the RECOVERABLE classes (``guard_abort``,
    # ``transport_error``+``provider_unavailable``,
    # ``transport_error``+``stream_finalize_timeout``) NEVER count into this
    # field, REGARDLESS of whether the anomaly was actually retried — a
    # budget-exhausted recoverable kill does not count either. Every
    # non-recoverable class (``truncated_no_signal``,
    # ``transport_error``/``error_event`` or other reasons,
    # ``observation_lost``, ``compaction_loop_killed``, ``silent_phase``)
    # DOES count. This is ``instrument_anomaly_turns`` minus the recoverable
    # transport_error classes, stated here rather than re-derived by each
    # downstream void-consumer — the gate's complement computed once, so
    # consumers cannot disagree about which anomalies the harness owns.
    unrecovered_anomaly_turns: int = 0
    # WO-TURNACCT-1 (Walter 2026-08-10): relay guard-killed turns, excluded
    # from ``turns`` (scoring) but never silently dropped — counted here.
    guard_aborted_turns: int = 0
    # WO-NUDGE-INF-1 (Walter 2026-08-11): relay finalize-killed turns, excluded
    # from ``turns`` (scoring) on the same grounds and counted here for the same
    # reason. These are the turns recovery re-drove; the count is what proves
    # the nudges did not inflate the measurement.
    finalize_timeout_turns: int = 0
    # WO-ERRDATA-C1: turns the stall watchdog killed. WO-21 made a stall ride
    # the recoverable path like a loop kill, so it now enters the anomaly ledger
    # (terminal="turn_stalled") and is recomputed from turn_anomalies_all at the
    # aggregation site — the same way guard_aborted_turns is.
    stalled_turns: int = 0
    # D-SERVE-MESSAGE-500: phases that lost transcript observation entirely.
    observation_lost_turns: int = 0
    unmetered_turns: int = 0
    unmetered_turn_wall_s: float = 0.0
    contention: ContentionCovariates | None = None
    worker_image_fingerprint: ImageFingerprint | None = None
    # WO-STRIP-2b: deterministic title the cell gave its OpenCode session(s),
    # surfaced to the run-manifest status stream so the prod dashboard can
    # join exported session-DB rows to bench cells.
    session_title: str | None = None
