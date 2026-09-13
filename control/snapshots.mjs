// ─────────────────────────────────────────────────────────────────────────────
// BUILD SNAPSHOTS — the list, and the one that is armed
//
// A snapshot is a captured worktree taken at the attempt-1 grade boundary. A
// later cell can start FROM it instead of rebuilding the scaffold, which skips
// a build phase measured at ~5,600 wall-seconds on this bench. Capture is
// automatic (WO-SNAP-02); this module is the read side plus the arming state
// the run path consults.
//
// ── ARMING IS CONTROL-PLANE STATE, NOT A PAYLOAD FIELD ──────────────────────
// The same argument dev mode is built on (dev-benchmark-snapshot.md §4): a
// seed carried in the start payload would mean this process trusts the
// browser's claim about what the run is. `/api/run/start`'s preflight reads the
// armed snapshot from HERE, so the id the confirmation token is minted over and
// the id the harness is handed are the same value from the same read.
//
// ── ELIGIBILITY IS STATED, NOT SCORED ───────────────────────────────────────
// A snapshot is listed with an `eligible` boolean and, when false, a `reason`.
// Nothing is hidden: an operator who captured a snapshot and cannot find it in
// the list learns nothing from its absence, and "why is it not here" is the
// question a filtered list cannot answer. The ineligible ones are listed and
// refused, in their producer's own terms.
//
// ── WHAT DOES *NOT* MAKE A SNAPSHOT INELIGIBLE ──────────────────────────────
// Corpus-provenance drift (`source_commit`, `chunk_plan_hash`, `template_hash`)
// is REPORTED and never disqualifying — D-SNAP-DEVMODE-EXCEPTIONS (Jerry,
// 2026-09-05). Dev mode is the operator's fast-iteration tool and a seeded run
// is never a publicly defendable data point, so drift is a caution, not a gate.
// `harness/snapshot.py::validate_snapshot_for_seed` implements the same ruling on
// the harness side; the two must not disagree about what refuses.
//
// The refusals that remain are the ones with nothing to seed from — no
// `snapshot.json`, unparseable, no `tree/` — plus a void authoring cell, and
// the same-model rule (§6), which is applied by the CALLER because only it
// knows which model the run is for.
// ─────────────────────────────────────────────────────────────────────────────

import { readdir, readFile, stat, writeFile, mkdir, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";

/** Where capture writes. Inside the runs root, so a fresh clone lists nothing. */
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
 * Read one snapshot directory into the shape the board renders.
 *
 * CHECK BEFORE SERVE, the discipline `baselines.mjs` already applies to cells:
 * every field is read defensively and absence stays null. A half-written
 * capture must produce an ineligible row with a stated reason, never a throw
 * that costs the whole list.
 */
export async function readSnapshot(runsRoot, id) {
  const dir = join(snapshotsDir(runsRoot), id);
  const manifest = await readJsonOrNull(join(dir, "snapshot.json"));

  if (!manifest) {
    // Capture writes no `snapshot.json` when it fails, deliberately — a
    // structurally ineligible snapshot beats a half-valid one (WO-SNAP-02).
    return {
      id,
      eligible: false,
      reason: "no readable snapshot.json — capture did not complete, so there is nothing to seed from",
      author_model: null,
    };
  }
  if (!(await isDir(join(dir, "tree")))) {
    return {
      id,
      eligible: false,
      reason: "no tree/ directory — the manifest exists but the worktree it describes does not",
      author_model: manifest.author_model ?? null,
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

    // Operator-facing identity metadata ONLY. dev-benchmark-snapshot.md §3.5:
    // the gate tally never selects the snapshot's contents and the harness
    // never reads it to filter, rank or gate anything.
    gate_totals: gates,
    failed_count: gates && Number.isFinite(gates.fail) ? gates.fail : null,

    // WHAT A SEEDED RUN SKIPS. Stated at capture so no consumer has to infer it
    // from a suspiciously low total.
    build_cost: cost,

    // Reported, never disqualifying — see the header.
    source_commit: manifest.source_commit ?? null,
    chunk_plan_hash: manifest.chunk_plan_hash ?? null,
    template_hash: manifest.template_hash ?? null,

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

/**
 * Every snapshot on disk, newest first.
 *
 * An empty list is NOT an error — a fresh clone has captured nothing, which is
 * the §7 "unset contributes nothing" pattern rather than a fault to report.
 */
export async function listSnapshots(runsRoot) {
  const dir = snapshotsDir(runsRoot);
  let names = [];
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return { ok: true, dir, snapshots: [], reason: "no snapshots directory yet — nothing has been captured" };
  }

  const rows = await Promise.all(names.map((n) => readSnapshot(runsRoot, n)));
  // Newest first. The id is a capture-time millisecond stamp, so it orders
  // correctly as a number and does not depend on `created_at` being present.
  rows.sort((a, b) => Number(b.id) - Number(a.id));
  return { ok: true, dir, snapshots: rows, reason: null };
}

/**
 * Can THIS snapshot seed a run for THIS model?
 *
 * The same-model rule (§6) lives here rather than in `readSnapshot`, because a
 * snapshot is not eligible or ineligible in the abstract — it is eligible for a
 * given run. Cross-model seeding is a different experiment and is explicitly
 * out of scope; the refusal is unchanged by the dev-mode exception.
 *
 * Returns `{ ok: true }` or `{ ok: false, reason }`. The reason is the sentence
 * an operator reads, so it names both models.
 */
/**
 * Normalise a model id for the same-model comparison.
 *
 * THE BOARD AND THE HARNESS SPELL A LOCAL MODEL DIFFERENTLY, and both spellings
 * are correct. The roster serves the bare alias (`qwen3.6-35b-a3b-bench`), which
 * is what `/api/run/start` receives and passes as `--model`; the harness then
 * qualifies it to `local-llm-proxy/<alias>` and records THAT as the snapshot's
 * `author_model`. Comparing the two raw would refuse every local snapshot for
 * the model that authored it.
 *
 * The rule mirrored here is the harness's own, not a new one:
 * `scripts/run_cumulative.py:434-435` strips exactly this prefix and no other.
 * Only `local-llm-proxy/` is stripped, so a cloud slug keeps its provider and an
 * `openrouter/...` snapshot still cannot seed a local run — which is a real
 * mismatch, not a spelling difference.
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

/**
 * Corpus drift, as a list of differing fields.
 *
 * Mirrors `harness/snapshot.py::validate_snapshot_for_seed`'s return shape on
 * purpose: the board shows the same drift the harness will report in its
 * `snapshot_validity_relaxed` notice, so the caution an operator reads before
 * starting matches the notice the run emits. `null` on exactly one side is
 * drift — absence cannot prove identity; `null` on both is a match.
 */
export function corpusDrift(row, { chunkPlanHash = null, templateHash = null, sourceCommit = null } = {}) {
  if (!row) return [];
  const pairs = [
    ["chunk_plan_hash", row.chunk_plan_hash, chunkPlanHash],
    ["template_hash", row.template_hash, templateHash],
    ["source_commit", row.source_commit, sourceCommit],
  ];
  return pairs
    .filter(([, recorded, running]) => recorded !== running)
    .map(([field, recorded, running]) => ({ field, snapshot: recorded, running }));
}

// ── THE ARMED SNAPSHOT ──────────────────────────────────────────────────────
//
// Persisted beside dev mode, for the same reason and with the same discipline:
// it is control-plane state, it must survive a restart, and it must never be
// committed. `writeArmed` returns the RE-RESOLVED state rather than what it
// hoped it wrote — the only version that cannot report a success the next read
// contradicts.
//
// ARMING IS GATED ON DEV MODE BY THE CALLER, not here. This module stores a
// selection; whether the operator is allowed to make one is a policy the server
// owns, and duplicating it would give the two a chance to disagree.

export const ARMED_ENV_VAR = "BENCH_SEED_SNAPSHOT";

export function armedStateFile(benchRoot, env = process.env) {
  return env.BENCH_SEED_SNAPSHOT_FILE || join(benchRoot, "config", "armed-snapshot.json");
}

/**
 * Which snapshot is armed, and whether it can be changed.
 *
 * Resolution order matches dev mode exactly: env → state file → none. An
 * environment pin makes the selection unsettable, so a scripted run cannot be
 * silently re-armed from the board.
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
      // DISARM DELETES THE FILE rather than writing a null into it. "No file"
      // and "a file that says none" are the same fact, and one of them cannot
      // rot into a stale id after a partial write.
      await unlink(path).catch(() => {});
    } else {
      await writeFile(path, `${JSON.stringify({ snapshot_id: snapshotId }, null, 2)}\n`, "utf8");
    }
  } catch (err) {
    return { ok: false, code: "write_failed", reason: String(err?.message ?? err) };
  }
  return { ok: true, armed: await resolveArmed({ benchRoot, env }) };
}
