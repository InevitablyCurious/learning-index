// BUILD SNAPSHOTS — the list, and which one is armed.
//
// A snapshot is a worktree captured at the attempt-1 grade boundary; a later
// cell can start from it and skip the build (~5,600s). Arming is control-plane
// state, never a payload field, so the token and the harness see the same id.
// Every snapshot is listed, with `eligible` and a reason when not. Corpus drift
// (source_commit, chunk_plan_hash, template_hash) is reported, never
// disqualifying (seeded runs are dev-only), matching
// harness/snapshot.py validate_snapshot_for_seed. Refusals: nothing to seed from
// (no snapshot.json, unparseable, no tree/), a void authoring cell, and — applied
// by the caller — a different model.

import { readdir, readFile, stat, writeFile, mkdir, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";

/** Inside the runs root, so a fresh clone lists nothing. */
export const SNAPSHOTS_DIRNAME = "snapshots";

export function snapshotsDir(runsRoot) {
  return join(runsRoot, SNAPSHOTS_DIRNAME);
}

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function isDir(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * One snapshot folder in the board's shape. Read defensively: a half-written
 * capture is an ineligible row with a reason, never a throw.
 */
export async function readSnapshot(runsRoot, id) {
  const dir = join(snapshotsDir(runsRoot), id);
  const manifest = await readJsonOrNull(join(dir, "snapshot.json"));

  if (!manifest) {
    // A failed capture writes no snapshot.json, on purpose.
    return {
      id,
      eligible: false,
      reason: "no readable snapshot.json — capture did not complete, so there is nothing to seed from",
      author_model: null,
      snapshot_depth: 1,
    };
  }
  if (!(await isDir(join(dir, "tree")))) {
    return {
      id,
      eligible: false,
      reason: "no tree/ directory — the manifest exists but the worktree it describes does not",
      author_model: manifest.author_model ?? null,
      snapshot_depth: 1,
    };
  }

  const gates = manifest.gate_totals ?? null;
  const cost = manifest.build_cost ?? null;
  const row = {
    id,
    author_model: manifest.author_model ?? null,
    provider: manifest.provider ?? null,
    memory_mode: manifest.memory_mode ?? null,
    run_id: manifest.run_id ?? null,
    created_at: manifest.created_at ?? null,
    state_hash: manifest.state_hash ?? null,

    // Identity metadata only: nothing selects or gates on the gate tally.
    gate_totals: gates,
    failed_count: gates && Number.isFinite(gates.fail) ? gates.fail : null,

    // What a seeded run skips, stated at capture.
    build_cost: cost,

    // Reported, never disqualifying.
    source_commit: manifest.source_commit ?? null,
    chunk_plan_hash: manifest.chunk_plan_hash ?? null,
    template_hash: manifest.template_hash ?? null,
    snapshot_depth: manifest.snapshot_depth ?? 1,

    cell_void: manifest.cell_void === true,
    eligible: true,
    reason: null,
  };

  if (row.cell_void) {
    row.eligible = false;
    row.reason = "the cell that authored this snapshot was an instrument failure — its tree is not a build anyone chose";
  }
  return row;
}

/** Every snapshot on disk, newest first. Empty is normal on a fresh clone. */
export async function listSnapshots(runsRoot) {
  const dir = snapshotsDir(runsRoot);
  let names = [];
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return { ok: true, dir, snapshots: [], reason: "no snapshots directory yet — nothing has been captured" };
  }

  const rows = await Promise.all(names.map((n) => readSnapshot(runsRoot, n)));
  // The id is a millisecond capture stamp, so it sorts numerically.
  rows.sort((a, b) => Number(b.id) - Number(a.id));
  return { ok: true, dir, snapshots: rows, reason: null };
}

/**
 * Can this snapshot seed a run for this model? Same model only (cross-model
 * seeding is out of scope). { ok: true } or { ok: false, reason } naming both
 * models.
 */
/**
 * Normalise a model id for that comparison: the harness records local models
 * as `local-llm-proxy/<alias>` while the board uses the bare alias. Only that
 * prefix is stripped (as run_cumulative.py does), so other routers still differ.
 */
const LOCAL_PREFIX = "local-llm-proxy/";
export function normalizeModelId(id) {
  if (typeof id !== "string" || !id) return null;
  return id.startsWith(LOCAL_PREFIX) ? id.slice(LOCAL_PREFIX.length) : id;
}

export function seedableBy(row, model) {
  if (!row) return { ok: false, reason: "no such snapshot" };
  if (!row.eligible) return { ok: false, reason: row.reason };
  if (!row.author_model) {
    return { ok: false, reason: "the snapshot does not say which model authored it, so same-model cannot be proven" };
  }
  if (normalizeModelId(row.author_model) !== normalizeModelId(model)) {
    return {
      ok: false,
      reason:
        `snapshot ${row.id} was built by ${row.author_model}; this run is for ${model}. `
        + "Seeding is same-model only — repairing another model's code is a different experiment.",
    };
  }
  return { ok: true, reason: null };
}

// ── THE ARMED SNAPSHOT ── persisted beside dev mode (survives restarts, never
// committed). writeArmed returns the re-read state. Whether arming is allowed
// (dev mode) is the caller's policy.

export const ARMED_ENV_VAR = "BENCH_SEED_SNAPSHOT";

export function armedStateFile(benchRoot, env = process.env) {
  return env.BENCH_SEED_SNAPSHOT_FILE || join(benchRoot, "config", "armed-snapshot.json");
}

/**
 * Which snapshot is armed, and whether it can be changed: env → state file →
 * none. An environment pin cannot be changed from the board.
 */
export async function resolveArmed({ benchRoot, env = process.env } = {}) {
  const pinned = env[ARMED_ENV_VAR];
  if (typeof pinned === "string" && pinned.trim() !== "") {
    return {
      snapshot_id: pinned.trim(),
      source: "environment",
      settable: false,
      settable_reason: `pinned by ${ARMED_ENV_VAR}; unset it to arm from the board`,
    };
  }
  const raw = await readJsonOrNull(armedStateFile(benchRoot, env));
  const id = raw && typeof raw.snapshot_id === "string" && raw.snapshot_id.trim() ? raw.snapshot_id.trim() : null;
  return {
    snapshot_id: id,
    source: id ? "state_file" : "none",
    settable: true,
    settable_reason: null,
  };
}

export async function writeArmed({ benchRoot, snapshotId, env = process.env } = {}) {
  if (snapshotId !== null && typeof snapshotId !== "string") {
    return { ok: false, code: "bad_snapshot_id", reason: "`snapshot_id` must be a string, or null to disarm" };
  }
  const current = await resolveArmed({ benchRoot, env });
  if (!current.settable) {
    return { ok: false, code: "pinned_by_environment", reason: current.settable_reason, armed: current };
  }
  const path = armedStateFile(benchRoot, env);
  try {
    await mkdir(dirname(path), { recursive: true });
    if (snapshotId === null) {
      // Disarm deletes the file (no file = none).
      await unlink(path).catch(() => {});
    } else {
      await writeFile(path, `${JSON.stringify({ snapshot_id: snapshotId }, null, 2)}\n`, "utf8");
    }
  } catch (err) {
    return { ok: false, code: "write_failed", reason: String(err?.message ?? err) };
  }
  return { ok: true, armed: await resolveArmed({ benchRoot, env }) };
}
