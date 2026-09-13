// ─────────────────────────────────────────────────────────────────────────────
// SOURCE: results-ledger
//
// Reads the bench's durable results ledger:
//
//   <bench_root>/data/results-ledger.jsonl
//
// One append-only JSONL line per COMPLETED scored cell (WO-43). The harness's
// Python writer appends here when a run concludes; RESET archives the file into
// the same `runs/backups/<ts>/` folder as the rest of the tree and starts a
// fresh one — so the ledger is history ACROSS runs, not just within one, and
// the board can show the help→harm trajectory over a task even after a sweep.
//
// RECORD SCHEMA (the writer's contract; this module renames NOTHING — the
// records pass through as-is and the panel renders defensively):
//   tree_id, run_id, task, org_id, model, arm ("off"|"on"), sequence_index,
//   verdict, attempts_to_green, problems_before, problems_after, full_green,
//   gate_totals, turns, tokens, wall_seconds, wall_cost_usd, recall,
//   session_fp, session_id, timestamp
//
// ABSENT FILE or EMPTY FILE (post-reset, or simply no runs yet) is a DESIGNED
// state, not a failure — same stance as extraction-inventory and live-stream:
// the source reports unwired with a plain reason and the panel says so.
// ─────────────────────────────────────────────────────────────────────────────

import { join } from "node:path";
import { readTextCapped, parseJsonl } from "./_runtime.mjs";

export const id = "results-ledger";
export const fields = ["results"];
export function describe() {
  return "durable results ledger — one line per completed scored cell, across runs and resets";
}

export async function read(ctx) {
  const path = join(ctx.benchRoot, "data", "results-ledger.jsonl");
  const raw = await readTextCapped(path);

  // ABSENT is the normal before-first-run state. readTextCapped also returns
  // null on an over-cap file — in that case the file exists but cannot be
  // safely parsed whole, so the honest report is still "not readable", never a
  // partial set presented as complete history.
  if (raw === null) {
    return { ok: false, reason: "no results ledger yet — nothing has completed since the last reset" };
  }

  const results = parseJsonl(raw);

  // EMPTY FILE (post-reset) and WHITESPACE-ONLY are the same designed nothing.
  if (!results.length) {
    return { ok: false, reason: "results ledger is empty — no completed cells recorded yet" };
  }

  // Records are appended in run order; the panel wants newest-first. Sorting
  // HERE by the writer's `timestamp` (stamped records first, then unstamped in
  // file order — Array#sort is stable, so equal/absent timestamps preserve
  // append order) keeps the panel dependency-free. The records themselves pass
  // through unmodified: no renaming, no added fields.
  results.sort((a, b) => {
    const ta = typeof a.timestamp === "string" ? a.timestamp : null;
    const tb = typeof b.timestamp === "string" ? b.timestamp : null;
    if (ta && tb && ta !== tb) return ta < tb ? 1 : -1;
    if (ta && !tb) return -1;
    if (!ta && tb) return 1;
    return 0;
  });

  return {
    ok: true,
    provenance: { path, mtime: null, bytes: raw.length },
    patch: { results },
  };
}
