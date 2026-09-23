"""Terminal-error types for the challenge adapter.

Extracted verbatim from harness/adapters/challenge/__init__.py
(WO-LI15-I1A STAGE 1A) and re-exported there, so every name stays
resolvable as harness.adapters.challenge.<Name>. Pure leaves:
docstring-only RuntimeError subclasses, no imports, no state.
ERROR_CAP_PER_TYPE (named in the ErrorCapExceeded docstring) stays in
__init__.py -- the docstring mention is prose, not a runtime reference.
"""


class GateTimeoutError(RuntimeError):
    """The gate oracle exceeded its wall-clock limit and was killed.

    Distinct from a gate FAIL: the model's work was never graded, so this is a
    harness/instrument failure and must never be scored as a capability FAIL
    (RUNBOOK rule 5.10 reasoning). It carries the partial log path so the stall
    is diagnosable from the artifact rather than from a live process.
    """


class GraderReportUnreadableError(RuntimeError):
    """The gate oracle produced no readable report.

    The grader container ran (or failed to) but its report is missing,
    truncated, or not valid JSON — so nothing was measured. Like
    GateTimeoutError, this is an instrument failure, never a capability FAIL,
    and must not abort the campaign: it is recorded as a named terminal state.
    """


class InstrumentFaultError(RuntimeError):
    """A grading pass failed to measure, twice, on the same code.

    Jerry's ruling (2026-09-23): a pass the grader itself reports as not a
    measurement — its report unreadable, or ``gradable: false`` because a
    runner aborted, timed out or threw — is graded once more on the same code.
    A second pass that measures is used as normal. A second failure ends the
    cell VOID, blamed on the instrument and never on the model: it counts
    toward no median, and the board says why. Before this the repair loop never
    read ``gradable`` and told the model a player's story about a pass that had
    measured nothing.
    """


class MissingFeedbackOverrideError(RuntimeError):
    """A gate reached the repair loop with no human-written symptom line.

    WO-FEEDBACK-VOICE-3 (2026-08-30): the feedback voice is SINGLE-SYSTEM —
    the ONLY sentence a gate may carry is the human-written line in
    `grader/feedback.json`. The old title-derived fallback is gone: a test title
    states the RULE, so a gate with no override would leak its answer and the
    repair loop would measure attempt count, not capability. This is raised, not
    silently papered over, because a gate the model cannot be told about in the
    right voice is a misconfigured benchmark, not a thing to route around.

    Completeness is guaranteed BEFORE a run starts (preflight) and pinned by a
    test, so reaching this during a run means a gate was added or a key was
    mistyped after preflight passed — a real defect, worth stopping for.
    """


class IncompleteBuildError(RuntimeError):
    """The build phase did not deliver every chunk, so there is nothing to grade.

    THE BUILD IS ALL-OR-NOTHING (2026-09-08 ruling). The six chunks ARE the
    corpus. The chunked driver returns early the moment a chunk exits non-zero,
    so a chunk that stalls does not merely lose its own work — every chunk after
    it is never sent. The model is then asked to repair a product it was never
    asked to build.

    WHAT THIS REPLACED, AND WHY IT HAD TO GO. Run 1788842999: chunk 2 of 6
    emitted 177 tokens and went silent; the 600s stall watchdog aborted the turn
    with ``killed_reason="turn_stalled"``. Because ``turn_stalled`` is a HARNESS
    LIMIT reason, the post-attempt decision was ``continue_if_budget`` — correct
    for a repair round, where a stalled turn only means that attempt did less,
    and wrong for the build, where it means chunks 3-6 do not exist. The cell
    graded a two-sixths build at 44/118, then spent 23,355 tokens in feedback-1
    reverse-engineering an API contract it had never been given, and reported
    66/118. Those numbers are not a capability signal and are not comparable to
    anything, yet nothing in the artifact distinguishes them from a real result.

    ``build_chunk_completion`` already knew: it tracks complete / died /
    not_reached precisely so an operator can read "2 died, 3-6 never started".
    The accounting existed and gated nothing. It gates the grader now.

    A partial build is the same trade ``ServeTransportError`` refuses: a cell
    salvaged by a lesser method is worth less than no cell. This aborts.
    """


class ServeTransportError(RuntimeError):
    """The one transport the benchmark runs on became unusable.

    THE BENCHMARK RUNS EXACTLY ONE WAY (2026-09-02 ruling). Every scored turn is
    delivered over the persistent ``opencode serve`` session, and when that
    session cannot be created or cannot carry a turn, the cell ABORTS. It does
    not quietly re-run the work down the stdout subprocess path.

    WHAT THIS REPLACED, AND WHY IT HAD TO GO. Four sites used to catch a
    transport fault and continue by a different method: the chunked build (which
    restarted the whole build as ONE joined six-chunk prompt, erasing the chunk
    boundaries), the per-attempt drive, cell start when ``create_session``
    failed, and the phase metrics baseline (which degraded per-phase deltas to
    session CUMULATIVE totals — a corrupted measurement, not merely a different
    route). Each logged a single PROGRESS line and carried on, so a cell that ran
    a materially different experiment was indistinguishable in the ledger from
    one that did not. The operator had to be watching the TUI to know, which is
    the definition of a surface that does not report itself.

    A cell salvaged by a lesser method is worth less than no cell: it produces
    numbers that look comparable and are not. Aborting turns hours of
    uninterpretable output into one named failure.
    """


class ErrorCapExceeded(RuntimeError):
    """One error type exceeded ``ERROR_CAP_PER_TYPE`` across the benchmark.

    PER-BENCHMARK FAST-FAIL (WO-ERRDATA-C1 ruling). When any of
    ``guard_aborted_turns`` / ``finalize_timeout_turns`` / ``stalled_turns``
    exceeds ``ERROR_CAP_PER_TYPE`` across the whole benchmark, the run aborts
    loudly — uncaught, with no scorecard — because a benchmark that produced
    that many harness-caught error turns is not a comparable capability
    signal. The same trade ``ServeTransportError`` refuses: numbers that look
    comparable and are not are worth less than no numbers.
    """
