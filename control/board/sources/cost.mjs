// SOURCE: cost — ONE CELL's v2 cost stamp (`cost.json`, schema_version 2).
//
// The harness writes cost.json when a cell ends: what it measured, where the
// time went (phases, compactions), and whether it measured the model or itself.
// This source only READS that stamp — it never re-derives a value. A v1 stamp
// (pre-versioned: phases.{build,troubleshooting,total} with per-bucket integer
// compactions) has no schema_version and no system_epoch, and is NOT this
// contract: normalizeV2Cost returns null for it, so the board states "no v2
// cost" rather than projecting a half-shaped older file as if it were v2.
//
// Per cell only. The run CARDS (sources/runs.mjs) reuse readV2Cost directly so
// archived runs — which have no by_cell entry — carry the same cost object.

import { join } from "node:path";

import { readJson } from "./_runtime.mjs";
import { cellDirForRun } from "../../runstate.mjs";

export const id = "cost";
/** What readCell adds to one cell's view. */
export const cellFields = ["cost"];
export function describe() {
  return "the cell's v2 cost stamp — phases, compactions, wall, price, outcome";
}

/** The v2 wire marker: schema_version 2, or the epoch every v2 stamp states. */
const V2_SCHEMA_VERSION = 2;
const V2_SYSTEM_EPOCH = "2026-11-08";

/**
 * A v2 cost.json, normalized; null for anything that is not v2.
 *
 * Identity is the stamp's own: `schema_version: 2` OR `system_epoch:
 * "2026-11-08"`. Fields are preserved VERBATIM under their harness names — no
 * renaming, no derivation. An absent field is null ("not recorded"), never 0;
 * a local model's `price`/`cost_usd` stay null (N/A, decided downstream).
 */
export function normalizeV2Cost(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.schema_version !== V2_SCHEMA_VERSION && raw.system_epoch !== V2_SYSTEM_EPOCH) {
    return null;
  }
  return {
    system_epoch: raw.system_epoch ?? null,
    model: raw.model ?? null,
    provider: raw.provider ?? null,
    outcome: raw.outcome ?? null,
    terminal_reason: raw.terminal_reason ?? null,
    void: raw.void ?? null,
    cell_wall_seconds: raw.cell_wall_seconds ?? null,
    measured_wall_seconds: raw.measured_wall_seconds ?? null,
    paused_seconds: raw.paused_seconds ?? null,
    price: raw.price ?? null,
    cost_usd: raw.cost_usd ?? null,
    // {by_phase:[{name,layer,build:{},troubleshooting:{}}], build, troubleshooting, total}
    phases: raw.phases ?? null,
    // {count, positions:[{ts, measured_offset_s, phase_index, phase_kind}]}
    compactions: raw.compactions ?? null,
  };
}

/** A cell's v2 cost stamp, or null when it wrote none (or wrote a v1 one). */
export async function readV2Cost(cellDir) {
  if (!cellDir) return null;
  return normalizeV2Cost(await readJson(join(cellDir, "cost.json")));
}

/**
 * ONE CELL's cost stamp, addressed by (run_dir, sequence_index) — never by "the
 * newest cell". The cell directory is resolved the same way the rest of the
 * board resolves it (cellDirForRun), so this source and runs.mjs agree on which
 * directory a card is talking about. Absent directory, absent file and a v1
 * file all state the same honest absence: there is no v2 cost to show.
 */
export async function readCell(ctx) {
  const found = ctx?.cell
    ? await cellDirForRun(ctx.runsRoot, ctx.cell.run_dir, ctx.cell.sequence_index)
    : null;
  const cost = found ? await readV2Cost(join(ctx.runsRoot, found.cellDir)) : null;
  if (!cost) return { ok: false, reason: "no v2 cost.json" };
  return { ok: true, patch: { cost } };
}
