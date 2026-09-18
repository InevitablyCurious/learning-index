// CONTROL-PLANE NOTICES — this process speaking for itself (stops, tool runs,
// watched counters), in the live stream's notice envelope with source `control`.
// Written beside the run's log as <log>.notices.jsonl: run-scoped (its facts
// outlive any one cell), retired with the tree, and scoped to the run the board
// names. No log, no run: the notice is dropped. Appends are fire-and-forget and
// never fail a launch, stop or request.

import { appendFile } from "node:fs/promises";

import { NOTICE_LEVELS } from "./contract.mjs";

/** Matches harness/live_stream.py SCHEMA_VERSION. */
const SCHEMA_VERSION = 1;

const NOTICES_SUFFIX = ".notices.jsonl";

export function noticesPathFor(logPath) {
  return `${logPath}${NOTICES_SUFFIX}`;
}

/**
 * Append one notice; returns whether it landed. An unknown level falls back to
 * info (the drift test makes that loud).
 */
export async function notice(logPath, event, { level = "info", detail = null } = {}) {
  if (!logPath) return false;
  const rec = {
    v: SCHEMA_VERSION,
    ts: Date.now(),
    kind: "notice",
    source: "control",
    event: String(event),
    level: NOTICE_LEVELS.includes(level) ? level : "info",
  };
  // Nulls are omitted, not written: absence is a state on these streams.
  if (detail !== null && detail !== undefined) rec.detail = detail;

  try {
    await appendFile(noticesPathFor(logPath), `${JSON.stringify(rec)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
