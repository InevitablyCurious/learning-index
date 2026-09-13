// ── CONTROL-PLANE NOTICES — this process speaking for itself ─────────────────
//
// WHAT THIS IS. The control plane is the one component that outlives a cell: it
// launches the harness, stops it, runs tools, archives trees and polls services
// the bench does not ship. Until now it said almost nothing about any of it —
// thirteen `console.*` calls in the whole of `control/`, six of them a startup
// banner, with no vocabulary and nowhere for a reader to look. It is a process
// the backend feed is meant to show, and it had nothing to show.
//
// ── WHY A SECOND STREAM, AND NOT `live.jsonl` ───────────────────────────────
//
// `live.jsonl` is per CELL, beside that cell's artifacts, and that scoping is
// correct. The control plane's facts OUTLIVE the cell — a stop signalled after
// the harness is gone, a tool refused between cells, a counter watched across a
// whole campaign. Writing them into one cell's stream would file run-scoped
// facts inside a cell's artifacts, where retiring that cell's tree destroys
// them and where a reader of the NEXT cell cannot see them at all.
//
// ── WHERE IT LIVES, AND WHY THERE ───────────────────────────────────────────
//
// Beside the run's own log, named after it: `<log>.notices.jsonl`. That is the
// same reasoning that placed `<log>.stats-baseline.json` — retiring a tree
// retires its notices in the same act, and no cleanup step has to be
// remembered. Keyed by the LOG because that is what `readRunState` resolves to
// when the board asks what is running, so a notice is scoped to exactly the run
// named above it.
//
// ── RUN-SCOPED, DELIBERATELY ────────────────────────────────────────────────
//
// No log means no run means nothing to attach a notice to, and it is DROPPED.
// The alternative — a run-independent file at the runs root — is an
// ever-growing stream that no tree retirement ever clears, which is the
// `stats-baseline` hazard inverted: a file that outlives every run it describes.
// Events with no run (the startup banner, a tool run against an idle bench) are
// not feed material; the feed answers "what is happening in this run".
//
// ── THE ENVELOPE IS THE LIVE STREAM'S ───────────────────────────────────────
//
// Same shape, same kind, same two axes as `harness/live_stream.py::notice`, so the
// aggregator reads one record type from both files and the feed renders one row
// shape. `source` is always `control` here: this module is the control plane
// speaking, and a module that could claim another process's name would be able
// to forge one.
//
// ── NEVER THROWS, NEVER BLOCKS ──────────────────────────────────────────────
//
// Appends are fire-and-forget. Telemetry about a failure must not become a
// second failure, and a notice that cannot be written must never be able to
// fail a launch, a stop, or a request.

import { appendFile } from "node:fs/promises";

import { NOTICE_LEVELS } from "./contract.mjs";

/** Envelope version, matching `harness/live_stream.py::SCHEMA_VERSION`. */
const SCHEMA_VERSION = 1;

const NOTICES_SUFFIX = ".notices.jsonl";

export function noticesPathFor(logPath) {
  return `${logPath}${NOTICES_SUFFIX}`;
}

/**
 * Append one control-plane notice. Returns whether it landed.
 *
 * `level` falls back to `info` when it is not one this contract knows — an
 * unrecognised level is a caller drifting from the vocabulary, and the drift
 * test is what makes that loud. Dropping the record would hide the drift on the
 * one surface built to show it.
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
  // NULLS ARE DROPPED, NOT WRITTEN — a null on the wire cannot be told apart
  // from "this producer does not set that field", and absence is a state
  // everywhere else on these streams.
  if (detail !== null && detail !== undefined) rec.detail = detail;

  try {
    await appendFile(noticesPathFor(logPath), `${JSON.stringify(rec)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
