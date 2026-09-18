// ─────────────────────────────────────────────────────────────────────────────
// BACKUPS — what a reset parked, and putting one back
//
// Every reset moves the live bench into `runs/backups/<unix-seconds>/` with the
// names it had at the runs root, so a backup is browsable as the runs directory
// it used to be. This module reads them, CHECKS them, and restores one.
//
// ── RESTORE IS A SWEEP PLUS A MOVE, NEVER AN OVERWRITE ──────────────────────
//
// Restoring parks whatever is live NOW into its own backup first, then moves the
// chosen one in. That is not politeness — it is the only ordering that has no
// destructive step. Copying a backup over a live runs root would have to
// overwrite `active-tree.json` and `baselines.json` and would silently lose any
// measurement taken since the reset, which is exactly the class of loss this
// whole tree exists to prevent. It also makes restore reversible: the state you
// just left is now the newest entry in the same list you restored from.
//
// ── WHY THE CHECK EXISTS ────────────────────────────────────────────────────
//
// A backup is a directory an operator can rename, half-copy off a drive, or
// hand-edit. Moving a malformed one into the runs root does not fail loudly — it
// produces a bench that LOOKS restored and reads wrong: a pointer naming a tree
// that is not there renders as an empty bench holding results, and a result
// folder with an unparseable manifest drops off every reader with no error. The
// check runs BEFORE anything moves, and a hard error refuses the restore.
// ─────────────────────────────────────────────────────────────────────────────

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
 * Resolve a backup id to a path, safely.
 *
 * The id reaches an fs path and arrives from a request body, so it is confined
 * to a direct child of the backups directory: unix-seconds only, then the
 * containment check that every path built from user input needs regardless.
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
          /* a file that vanished mid-walk is not a reason to fail a listing */
        }
      }
    }
  }
  await walk(dir);
  return { bytes: total, truncated: budget.files <= 0 };
}

/**
 * Everything a result folder can tell an operator at a glance.
 *
 * Read from the manifest the harness wrote, never guessed from the folder name:
 * the name is a convention and the manifest is a record.
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
 * Does this backup look like something the bench can take back?
 *
 * ERRORS REFUSE THE RESTORE. WARNINGS DO NOT. The split matters: an operator
 * restoring a backup that is merely incomplete (a run log whose result folder
 * was pruned) should be told and allowed to proceed, while one whose pointer
 * names a tree that is not in the directory would get a bench that renders as
 * empty and is not obviously broken. Only the second kind blocks.
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

  // NOTHING FOREIGN. Everything here is about to be moved into the runs root,
  // so anything the bench would not recognise there does not belong here either.
  const foreign = names.filter((n) => !isBenchmarkData(n));
  if (foreign.length) {
    errors.push(`contains ${foreign.length} item(s) the bench does not recognise: ${foreign.join(", ")}`);
  }

  // THE POINTER MUST NAME A TREE THAT IS PRESENT. A pointer naming an absent
  // tree restores to a bench that reads as empty while holding results — the
  // failure is invisible, which is why it is an error and not a warning.
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

  // RESULT FOLDERS MUST BE READABLE. An unparseable manifest drops the folder
  // off every reader silently, so it is named here instead.
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
      // A tree holds its result folders nested by substrate/router/provider/model.
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
    // The id IS the moment it was taken — unix seconds, by construction.
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
 * RESTORE: park what is live, then move the chosen backup back in.
 *
 * The chosen backup's folder is REMOVED once emptied, because its contents are
 * no longer history — they are the bench. Leaving an empty directory behind
 * would show as a backup holding nothing, which an operator would reasonably
 * read as data loss.
 */
export async function restoreBackup(runsRoot, id, { now = Date.now() } = {}) {
  const dir = resolveBackupDir(runsRoot, id);
  if (!dir) throw new Error(`${JSON.stringify(String(id))} is not a valid backup id`);

  const check = await checkBackup(dir);
  if (!check.ok) {
    throw new Error(`this backup did not pass the check: ${check.errors.join("; ")}`);
  }

  // 1. Park the live bench. Nothing is overwritten because nothing is left.
  const parked = await sweepToBackup(runsRoot, { now });

  // 2. Move the chosen backup's contents up to the runs root.
  const restored = [];
  for (const ent of await listDir(dir)) {
    if (ent.name.startsWith(".")) continue;
    await fs.rename(join(dir, ent.name), join(runsRoot, ent.name));
    restored.push(ent.name);
  }

  // 3. Consume the now-empty folder. Non-fatal: a leftover empty directory is
  //    cosmetic, and failing here after the data is already home would report a
  //    restore that actually succeeded as a failure.
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
