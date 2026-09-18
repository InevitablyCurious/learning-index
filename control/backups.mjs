// BACKUPS — what a reset parked, and putting one back. Each reset moves the
// live bench into runs/backups/<unix-seconds>/ with its names intact.
//
// Restore parks whatever is live into its own backup first, then moves the
// chosen one in: nothing is ever overwritten, and the restore is itself undoable.
// A backup is checked before anything moves, because a malformed one (a pointer
// naming a missing tree, an unreadable manifest) would restore into a bench that
// looks fine and reads wrong.

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { BACKUPS_DIR, isBenchmarkData, isTreeId, sweepToBackup } from "./tree.mjs";
import { listDir } from "./lib/fs.mjs";

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * A backup id → its path: unix seconds only, and it must stay inside the
 * backups folder (the id comes from a request).
 */
export function resolveBackupDir(runsRoot, id) {
  const name = String(id ?? "").trim();
  if (!isTreeId(name)) return null;
  const full = resolve(join(runsRoot, BACKUPS_DIR, name));
  const baseWithSep = resolve(join(runsRoot, BACKUPS_DIR)) + sep;
  if (!full.startsWith(baseWithSep)) return null;
  return full;
}

/** Bytes on disk, bounded so a huge backup cannot stall the listing. */
async function dirBytes(dir, budget = { files: 20000 }) {
  let total = 0;
  async function walk(d) {
    if (budget.files <= 0) return;
    for (const ent of await listDir(d)) {
      if (budget.files <= 0) return;
      const p = join(d, ent.name);
      if (ent.isDirectory()) {
        await walk(p);
      } else {
        budget.files -= 1;
        try {
          total += (await fs.stat(p)).size;
        } catch {
          /* A file vanishing mid-walk doesn't fail the listing. */
        }
      }
    }
  }
  await walk(dir);
  return { bytes: total, truncated: budget.files <= 0 };
}

/**
 * What a result folder shows at a glance, read from its manifest (never the
 * folder name).
 */
async function describeResult(dir, name) {
  const manifest = await readJsonOrNull(join(dir, "manifest.json"));
  if (!manifest) return { name, readable: false };

  const schedule = Array.isArray(manifest.schedule) ? manifest.schedule : [];
  const models = [...new Set(schedule.map((c) => c?.model).filter(Boolean))];
  let off = 0;
  let on = 0;
  for (const c of schedule) {
    if (c?.memory_mode === "off") off += 1;
    else if (c?.memory_mode === "on") on += 1;
  }

  let attempts = 0;
  try {
    const raw = await fs.readFile(join(dir, "manifest.status.jsonl"), "utf8");
    attempts = raw.split("\n").filter((l) => l.trim()).length;
  } catch {
    attempts = 0;
  }

  return {
    name,
    readable: true,
    models,
    org_id: manifest.org_id ?? null,
    task: manifest.task ?? null,
    seed: manifest.seed ?? null,
    created_at: manifest.created_at ?? null,
    cells: schedule.length,
    cells_off: off,
    cells_on: on,
    attempts,
  };
}

/**
 * Can the bench take this backup back? Errors refuse the restore; warnings
 * (e.g. a run log whose result folder was pruned) are shown and allowed.
 */
export async function checkBackup(dir) {
  const errors = [];
  const warnings = [];

  if (!existsSync(dir)) {
    return { ok: false, errors: ["the backup folder is not there"], warnings };
  }

  const entries = await listDir(dir);
  const names = entries.map((e) => e.name).filter((n) => !n.startsWith("."));
  if (names.length === 0) errors.push("the backup folder is empty");

  // Nothing foreign: all of it is about to land in the runs root.
  const foreign = names.filter((n) => !isBenchmarkData(n));
  if (foreign.length) {
    errors.push(`contains ${foreign.length} item(s) the bench does not recognise: ${foreign.join(", ")}`);
  }

  // The pointer must name a tree that is present (otherwise the bench reads
  // empty while holding results).
  if (names.includes("active-tree.json")) {
    const pointer = await readJsonOrNull(join(dir, "active-tree.json"));
    if (!pointer) {
      errors.push("active-tree.json is unreadable — the bench could not tell which tree is live");
    } else if (!isTreeId(pointer.active)) {
      errors.push(`active-tree.json names ${JSON.stringify(String(pointer.active))}, which is not a tree id`);
    } else if (!names.includes(String(pointer.active))) {
      errors.push(`active-tree.json points at tree ${pointer.active}, which is not in this backup`);
    }
  } else if (names.some((n) => isTreeId(n))) {
    warnings.push("no active-tree.json — the bench will start a fresh tree beside the restored results");
  }

  // Result folders must be readable, or they drop off every reader silently.
  for (const n of names.filter((x) => x.startsWith("cumulative"))) {
    if (!(await readJsonOrNull(join(dir, n, "manifest.json")))) {
      warnings.push(`${n} has no readable manifest.json — it will not appear on the board`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** One backup, summarised for the list. */
export async function describeBackup(runsRoot, id) {
  const dir = resolveBackupDir(runsRoot, id);
  if (!dir) return null;

  const entries = await listDir(dir);
  const names = entries.map((e) => e.name).filter((n) => !n.startsWith("."));

  const results = [];
  for (const n of names) {
    if (isTreeId(n)) {
      // A tree nests result folders by substrate/router/provider/model.
      for (const found of await treeResults(join(dir, n), n)) results.push(found);
    } else if (n.startsWith("cumulative")) {
      results.push(await describeResult(join(dir, n), n));
    }
  }

  const runLogs = names.filter((n) => /^(off|on)-cell-.*\.log$/.test(n) || /^cell-.*\.log$/.test(n)).length;
  const { bytes, truncated } = await dirBytes(dir);
  const check = await checkBackup(dir);

  return {
    id: String(id),
    // The id is the moment it was taken.
    created_at: new Date(Number(id) * 1000).toISOString(),
    items: names.sort(),
    results,
    counts: {
      results: results.length,
      run_logs: runLogs,
      items: names.length,
    },
    bytes,
    bytes_truncated: truncated,
    check,
  };
}

/** Result folders inside a tree, walked to the model level and no deeper. */
async function treeResults(treeDir, treeId, prefix = [], depth = 0) {
  const out = [];
  if (depth > 4) return out;
  for (const ent of await listDir(treeDir)) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
    const child = join(treeDir, ent.name);
    if (existsSync(join(child, "manifest.json")) || existsSync(join(child, "manifest.status.jsonl"))) {
      const d = await describeResult(child, [...prefix, ent.name].join("/"));
      out.push({ ...d, tree: treeId });
      continue;
    }
    out.push(...(await treeResults(child, treeId, [...prefix, ent.name], depth + 1)));
  }
  return out;
}

/** Every backup, newest first. */
export async function listBackups(runsRoot) {
  const base = join(runsRoot, BACKUPS_DIR);
  const out = [];
  for (const ent of await listDir(base)) {
    if (!ent.isDirectory() || !isTreeId(ent.name)) continue;
    const d = await describeBackup(runsRoot, ent.name);
    if (d) out.push(d);
  }
  out.sort((a, b) => Number(b.id) - Number(a.id));
  return out;
}

/**
 * RESTORE: park what is live, move the chosen backup in, then remove its
 * emptied folder (an empty backup would read as data loss).
 */
export async function restoreBackup(runsRoot, id, { now = Date.now() } = {}) {
  const dir = resolveBackupDir(runsRoot, id);
  if (!dir) throw new Error(`${JSON.stringify(String(id))} is not a valid backup id`);

  const check = await checkBackup(dir);
  if (!check.ok) {
    throw new Error(`this backup did not pass the check: ${check.errors.join("; ")}`);
  }

  // 1. Park the live bench.
  const parked = await sweepToBackup(runsRoot, { now });

  // 2. Move the backup's contents to the runs root.
  const restored = [];
  for (const ent of await listDir(dir)) {
    if (ent.name.startsWith(".")) continue;
    await fs.rename(join(dir, ent.name), join(runsRoot, ent.name));
    restored.push(ent.name);
  }

  // 3. Remove the emptied folder. Non-fatal: the data is already home.
  let consumed = true;
  try {
    await fs.rmdir(dir);
  } catch {
    consumed = false;
  }

  return {
    restored: restored.sort(),
    parked_as: parked.backup_id,
    parked_items: parked.moved,
    consumed,
    warnings: check.warnings,
  };
}
