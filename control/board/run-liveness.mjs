/**
 * Liveness comes from the control plane, the reader that can measure it (it
 * probes the process and reads the harness's own heartbeat). Its published
 * `state` replaces the board's live-looking state in both directions: a dead
 * process is never `running`, a stated stall always lands, and a beating cell is
 * never `stalled`. It wins on liveness only (phase, turns, tokens and gates stay
 * with their sources), and only when it actually answered — silence is not
 * evidence, so otherwise run-log's answer stands.
 */
export function reconcileRunLiveness(board) {
  const c = board?.control?.run;
  // `running` is the published boolean; absent = no answer.
  if (!c || typeof c.running !== "boolean") return board;

  const own = board.run?.state ?? null;
  // Only the live-looking states can be wrong in the dangerous direction.
  if (own !== "running" && own !== "stalled") return board;

  // The producer's verdict, consumed not re-derived. An older control plane with
  // only the boolean: true confirms the board, false means the process is gone.
  const stated = typeof c.state === "string" ? c.state : c.running ? own : "complete";
  if (stated === own) return board;

  const wedge = stated === "stalled";
  board.run = {
    ...board.run,
    state: stated,
    terminal_status: c.terminal_status ?? board.run?.terminal_status ?? null,
    // The heartbeat age the STALLED chip shows comes with the verdict.
    ...(wedge && typeof c.heartbeat_age_s === "number"
      ? { heartbeat_age_s: c.heartbeat_age_s }
      : {}),
    // Stated, so a disagreement with the log is visible.
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
