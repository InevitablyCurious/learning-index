// SOURCE: results-ledger — <bench_root>/data/results-ledger.jsonl, one line
// per completed scored cell, appended by the harness. RESET archives it with the
// tree and starts a fresh one, so it is history across runs. Records pass
// through unrenamed. An absent or empty file is a normal state (unwired, with a
// plain reason).

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

  // Absent before the first run; an over-cap file is also reported unreadable,
  // never a partial history.
  if (raw === null) {
    return { ok: false, reason: "no results ledger yet — nothing has completed since the last reset" };
  }

  const results = parseJsonl(raw);

  // Empty and whitespace-only are the same nothing.
  if (!results.length) {
    return { ok: false, reason: "results ledger is empty — no completed cells recorded yet" };
  }

  // Newest first by `timestamp` (stable sort keeps append order for ties and
  // unstamped records); records otherwise untouched.
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
