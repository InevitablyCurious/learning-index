/**
 * LIVENESS COMES FROM THE READER THAT CAN MEASURE IT.
 *
 * ── THE DEFECTS, BOTH MEASURED ──────────────────────────────────────────────
 *
 * 1. A DEAD PROCESS REPORTED AS RUNNING (2026-09-02). A cell was interrupted
 *    with SIGINT. The harness tore its own containers down and exited, leaving
 *    a KeyboardInterrupt traceback and no terminal record. The board's log
 *    parser reported `running` — over a process that was already gone — and
 *    kept a spinner turning, on course to escalate to STALLED, a claim that a
 *    deliberately stopped cell was wedged.
 *
 * 2. A LIVE CELL REPORTED AS STALLED (WO-HDR-FIX-01). run-log.mjs used to name
 *    `stalled` from the launch log's mtime against a 900s threshold. The
 *    harness writes PROGRESS at phase BOUNDARIES — one build phase has been
 *    observed running 86 model turns between two of them — so the header
 *    printed `CELL STALLED — SILENT 23:29` over a cell that was mid-turn, its
 *    own 15s live.jsonl heartbeat beating the whole time. The control plane
 *    had already migrated off exactly this proxy (control/runstate.mjs); the
 *    board's copy survived.
 *
 * Both are one defect class: the board is a read-only container with no host
 * PID namespace and no heartbeat reader, so it CANNOT measure liveness — not a
 * bug in it, a boundary. A consumer must never derive a fact that a producer
 * could state.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * The control plane wins on LIVENESS, and only on liveness. It is not a better
 * source of phase, turns, tokens or gates — run-log and the status stream are
 * closer to those and stay authoritative. What the control plane uniquely
 * knows is whether the process exists (host probe) and whether WORK is
 * happening (the harness's own heartbeat), folded into the `state` it
 * publishes on GET /api/run. When it answers, its verdict replaces the board's
 * live-looking state in BOTH directions: a dead process is never `running`, a
 * stated stall always lands, and a beating cell is never `stalled`.
 *
 * ── AND ONLY WHEN IT ACTUALLY KNOWS ─────────────────────────────────────────
 *
 * An unreachable control plane must never be read as "the run is dead" — or as
 * "the run is wedged". Silence from a source is not evidence. The
 * reconciliation applies only when the control plane answered AND published
 * its boolean; otherwise run-log's answer stands, unchanged, as the fallback
 * it has always been: `running` or `complete`, with the log's silence reported
 * as a debug fact and never escalated to a verdict the board cannot measure.
 */
export function reconcileRunLiveness(board) {
  const c = board?.control?.run;
  // `running` is the published boolean (control/runstate.mjs). Absent means an
  // older control plane, or none at all — either way, not an answer.
  if (!c || typeof c.running !== "boolean") return board;

  const own = board.run?.state ?? null;
  // Only the live-looking states can be wrong in the dangerous direction. A
  // board already showing `complete` is not improved by second-guessing it.
  if (own !== "running" && own !== "stalled") return board;

  // THE PRODUCER'S VERDICT, CONSUMED NOT RE-DERIVED. `state` is readRunState's
  // own fold of process probe + heartbeat liveness + terminal record; folding
  // `liveness` again here would be a second derivation of the same fact. An
  // older plane that publishes only the boolean has no verdict to give:
  // running=true confirms the board's own view, running=false means the
  // process is gone.
  const stated = typeof c.state === "string" ? c.state : c.running ? own : "complete";
  if (stated === own) return board;

  const wedge = stated === "stalled";
  board.run = {
    ...board.run,
    state: stated,
    terminal_status: c.terminal_status ?? board.run?.terminal_status ?? null,
    // The producer's own measurement rides with its verdict: this is the
    // duration the STALLED chip renders, so the verdict and the evidence it
    // cites come from the same source and cannot disagree.
    ...(wedge && typeof c.heartbeat_age_s === "number"
      ? { heartbeat_age_s: c.heartbeat_age_s }
      : {}),
    // STATED, so the disagreement is visible rather than silently resolved. A
    // reader that wonders why the log looks live and the board says otherwise
    // can see which source answered and why it outranks the other.
    liveness_source: "control-plane",
    liveness_note: wedge
      ? `the harness's own heartbeat (live.jsonl, 15s cadence) has been silent for ` +
        `${c.heartbeat_age_s ?? "?"}s — the control plane states the stall, and the ` +
        `board derives none from the launch log's mtime`
      : c.running
        ? `the control plane's heartbeat liveness reports the cell beating ` +
          `(liveness=${c.liveness ?? "unpublished"}) — it outranks any stall the board ` +
          `thought it saw, because the harness is the only component that knows whether ` +
          `it is mid-drive`
        : `the log has no terminal record, but the control plane's process probe reports the ` +
          `harness is gone (state=${c.state ?? "unknown"}) — liveness is taken from the probe, ` +
          `which is the only reader that can see host processes`,
  };
  return board;
}
