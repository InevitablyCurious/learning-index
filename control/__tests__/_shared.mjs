// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPERS for control/__tests__/*.test.mjs
//
// Moved VERBATIM from control/control.test.mjs during the split. The `_`
// prefix + non-`.test.mjs` suffix keeps `node --test` from treating this file
// as a test file. HERE/BENCH are recomputed for this directory so they resolve
// to the SAME absolute paths as the original (HERE = <repo>/control,
// BENCH = <repo>).
// ─────────────────────────────────────────────────────────────────────────────

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BENCH = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A run dir on disk: one schedule slot plus its status record. */
export function writeRun(root, dir, { seq = 0, model = "m-a", arm = "off", status = null }) {
  const d = join(root, dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "manifest.json"), JSON.stringify({
    created_at: "2026-08-13T00:00:00Z",
    // The arm field is `memory_mode` and the model is bare in `provider_pin`.
    schedule: [{ sequence_index: seq, memory_mode: arm, provider_pin: model }],
  }));
  if (status) writeFileSync(join(d, "manifest.status.jsonl"), `${JSON.stringify(status)}\n`);
  return d;
}

/**
 * A MULTI-SLOT campaign: one schedule, both arms, one status record per slot.
 *
 * This is the shape a real campaign has — `harness/cumulative/ordering.py`
 * schedules ONE model per directory, slot 0 as the OFF floor and every later
 * slot an ON repetition of it — and it is what the runs of a baseline are read
 * from. `writeRun` above is the single-slot case kept for the gate tests.
 */
export function writeCampaign(root, dir, slots, { model = "m-a" } = {}) {
  const d = join(root, dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "manifest.json"), JSON.stringify({
    created_at: "2026-08-13T00:00:00Z",
    schedule: slots.map((s) => ({ sequence_index: s.seq, memory_mode: s.arm, provider_pin: model })),
  }));
  const status = slots.filter((s) => s.status).map((s) => JSON.stringify(s.status)).join("\n");
  if (status) writeFileSync(join(d, "manifest.status.jsonl"), `${status}\n`);
  return d;
}

export const OFF_PASS = { type: "attempt", sequence_index: 0, verdict: "PASS", progress: { turns: 9, total_tokens: 400, wall_seconds: 60 } };

/** A campaign directory with a pinned roster and one attempt's outcomes. */
export function writeCampaignCell(runs, dir, { gates, results }) {
  mkdirSync(join(runs, dir, "sessions"), { recursive: true });
  writeFileSync(
    join(runs, dir, "gate-roster.json"),
    JSON.stringify({ total: gates.length, enumeration: { complete: true }, gates }),
  );
  writeFileSync(
    join(runs, dir, "manifest.status.jsonl"),
    JSON.stringify({ type: "attempt", attempt: 1, gate_results: results }) + "\n",
  );
  writeFileSync(
    join(runs, "off-cell-live.log"),
    "PROGRESS step=worktree-git-init path=" + join(runs, dir, "sessions", "cell", "worktree") + "\n",
  );
}

export function treeFixture() {
  const root = mkdtempSync(join(tmpdir(), "tree-"));
  return { root, runs: join(root, "runs") };
}

export function campaignAt(runs, rel, { status = true } = {}) {
  const dir = join(runs, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ created_at: "2026-08-20T00:00:00Z" }));
  if (status) writeFileSync(join(dir, "manifest.status.jsonl"), "");
  return dir;
}
