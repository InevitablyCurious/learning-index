// DELETE A RUN — permanently, and only when the layout is the one a reset
// writes (anything else is refused with a reason, never deleted on a guess).
//
//   live      runs/<treeId>/…              refused: the live tree isn't deletable
//   archived  runs/backups/<newTreeId>/    one retired tree, plus the pointer,
//                                          baselines and ledger as they stood
// Deleting the archived folder removes that one run and its ledger rows.
//
// Not touched: runs/baselines.json (derived; regenerates), docker session-db
// volumes (named by model, not run, so they can't be attributed — reported
// only), and snapshots seeded from this run downstream (no cascade). The
// snapshots this run PRODUCED — manifest session_records[].produced_snapshot_id
// — are hard-deleted with it.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { resolveCellDir } from "./history.mjs";
import { BACKUPS_DIR, TREE_POINTER } from "./tree.mjs";

const execFileAsync = promisify(execFile);

function refuse(code, reason, extra = {}, status = 400) {
  return { ok: false, code, reason, status, ...extra };
}

/** Bounded size and file count. */
async function measure(dir, budget = { files: 0, bytes: 0, left: 200_000 }) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return budget;
  }
  for (const ent of entries) {
    if (budget.left <= 0) return budget;
    const child = join(dir, ent.name);
    if (ent.isDirectory()) {
      await measure(child, budget);
    } else {
      budget.left -= 1;
      budget.files += 1;
      try {
        budget.bytes += (await fs.stat(child)).size;
      } catch {
        // A file vanishing mid-walk is not an error.
      }
    }
  }
  return budget;
}

function human(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Leftover per-cell session-DB volumes, reported. */
async function strandedVolumes() {
  try {
    const { stdout } = await execFileAsync("docker", [
      "volume", "ls", "--format", "{{.Name}}",
    ]);
    return String(stdout)
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => /^bench-cell-.*-session-db$/.test(s));
  } catch {
    // No docker: report nothing.
    return [];
  }
}

/**
 * Every snapshot id this run produced, read from the campaign manifest(s)
 * nested under the target (<tree>/<substrate>/<router>/<provider>/<model>/
 * manifest.json). Missing or malformed manifests yield nothing: a run with no
 * readable produced_snapshot_id deletes as before — no error, no guessing.
 */
async function producedSnapshotIds(target) {
  try {
    const entries = await fs.readdir(target, { recursive: true });
    const ids = [];
    for (const rel of entries) {
      if (basename(rel) !== "manifest.json") continue;
      try {
        const raw = JSON.parse(await fs.readFile(join(target, rel), "utf8"));
        for (const rec of Array.isArray(raw?.session_records) ? raw.session_records : []) {
          const id = rec?.produced_snapshot_id;
          if (typeof id === "string" && id !== "") ids.push(id);
        }
      } catch {
        // One unreadable manifest never stops the walk.
      }
    }
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

/**
 * What deleting this row would remove, and whether it may. The token binds to
 * the target and its contents: if the folder changes before confirm, the operator
 * is shown what is there now.
 */
export async function planRunDelete(runsRoot, benchmarkId, cell, opts = {}) {
  const cellDir = resolveCellDir(runsRoot, benchmarkId, cell);
  if (!cellDir) return refuse("invalid_run", "run or cell identifier is invalid");

  const root = resolve(runsRoot);
  const archived = benchmarkId === BACKUPS_DIR;
  const segments = String(cell).split("/").filter(Boolean);

  let target;
  let treeId;
  if (archived) {
    // backups/<new>/<old>/…: the folder is the unit.
    const backupFolder = segments[0];
    treeId = segments[1] ?? null;
    if (!backupFolder || !treeId) {
      return refuse(
        "unrecognised_layout",
        `archived cell is not under the expected backups/<treeId>/<treeId>/… layout: "${cell}"`,
        {},
        422,
      );
    }
    target = join(root, BACKUPS_DIR, backupFolder);

    // Exactly one tree inside, and it is the row's own; anything else is refused.
    let inside;
    try {
      inside = await fs.readdir(target, { withFileTypes: true });
    } catch (err) {
      return refuse("target_unreadable", `cannot read ${target}: ${err?.message ?? err}`, {}, 404);
    }
    const dirs = inside.filter((e) => e.isDirectory()).map((e) => e.name);
    if (dirs.length !== 1 || dirs[0] !== treeId) {
      return refuse(
        "unrecognised_layout",
        `${target} holds ${dirs.length === 0 ? "no tree" : dirs.join(", ")} — expected exactly one, "${treeId}". ` +
          "Nothing was deleted: this archive was not written by the reset this code knows about.",
        { found: dirs },
        422,
      );
    }
  } else {
    treeId = benchmarkId;
    target = join(root, benchmarkId);
  }

  // Containment re-checked on the composed target.
  if (target !== root && !target.startsWith(root + sep)) {
    return refuse("invalid_run", "resolved target escapes the runs root");
  }
  if (target === root) {
    return refuse("invalid_run", "refusing to delete the runs root itself");
  }

  // The active tree is not deletable (reset retires it).
  if (!archived) {
    let active = null;
    try {
      active = JSON.parse(await fs.readFile(join(root, TREE_POINTER), "utf8"))?.active ?? null;
    } catch {
      active = null;
    }
    if (active && active === treeId) {
      return refuse(
        "active_tree",
        `${treeId} is the LIVE tree — deleting it would leave ${TREE_POINTER} pointing at nothing. ` +
          "Reset the bench from the board first; that retires this tree into the archive, where it can be deleted.",
        {},
        409,
      );
    }
  }

  // A live run only blocks deleting the live tree; archived runs can go anytime.
  if (opts.runInFlight && !archived) {
    return refuse(
      "run_in_flight",
      `a benchmark run is in progress, and ${treeId} is a live tree — stop the run before deleting it. ` +
        "Archived runs can be deleted while a run is going; nothing writes to them.",
      {},
      409,
    );
  }

  const { files, bytes } = await measure(target);
  const volumes = await strandedVolumes();
  const snapshot_ids = await producedSnapshotIds(target);

  const token =
    ["delete-run", treeId, `files=${files}`, `bytes=${bytes}`].join("|") +
    (snapshot_ids.length ? `|snaps=${snapshot_ids.join(",")}` : "");
  const restatement = [
    `Permanently delete run ${treeId}.`,
    `${files} file${files === 1 ? "" : "s"} (${human(bytes)}) under ${target} will be REMOVED FROM DISK.`,
    archived
      ? "That is the archived tree plus the baselines and ledger recorded when it was retired."
      : "That is the whole tree: its cells, worktrees, transcripts and checkpoints.",
    ...(snapshot_ids.length
      ? [
          `This run's produced snapshot${snapshot_ids.length === 1 ? "" : "s"} will ALSO be removed from disk: runs/snapshots/${snapshot_ids.join(", ")}.`,
          "Snapshots seeded from it downstream are kept.",
        ]
      : []),
    "THIS IS NOT A RESET. Nothing is moved to a backup — it is gone.",
    "runs/baselines.json is derived from the cells and rebuilds itself; it is not edited here.",
    volumes.length
      ? `Left alone: ${volumes.length} docker session-db volume${volumes.length === 1 ? "" : "s"} ` +
        `(${volumes.join(", ")}). Their names are model-scoped, not run-scoped, so none can be ` +
        "attributed to this run — remove them yourself if they are stale."
      : null,
  ].filter(Boolean).join(" ");

  return {
    ok: true,
    target,
    tree_id: treeId,
    archived,
    files,
    bytes,
    bytes_human: human(bytes),
    stranded_volumes: volumes,
    snapshot_ids,
    token,
    restatement,
  };
}

/** Delete, if the token still matches what is on disk. */
export async function deleteRun(runsRoot, benchmarkId, cell, confirm, opts = {}) {
  const plan = await planRunDelete(runsRoot, benchmarkId, cell, opts);
  if (plan.ok === false) return plan;

  if (confirm !== plan.token) {
    return refuse(
      "bad_confirmation",
      "the confirmation did not match what is on disk — it changed after the preview was shown. " +
        "Review the restatement and confirm again.",
      { expected_token: plan.token, restatement: plan.restatement },
    );
  }

  try {
    await fs.rm(plan.target, { recursive: true, force: true });
  } catch (err) {
    return refuse("delete_failed", `${plan.target}: ${err?.message ?? err}`, {}, 500);
  }

  // The snapshots this run produced go with it — hard delete, no cascade:
  // snapshots seeded from them downstream are never touched. The run folder is
  // already gone, so a stuck snapshot lowers the count instead of failing the op.
  let snapshots_deleted = 0;
  for (const id of plan.snapshot_ids) {
    if (id.includes("/") || id.includes("\\") || id === "." || id === "..") continue;
    try {
      await fs.rm(join(runsRoot, "snapshots", id), { recursive: true, force: true });
      snapshots_deleted += 1;
    } catch {
      // Counted by omission; the run delete itself already succeeded.
    }
  }

  // Remove the emptied archive folder — only if truly empty, never recursively.
  if (plan.archived) {
    const parent = dirname(plan.target);
    if (basename(parent) === BACKUPS_DIR) {
      try {
        if ((await fs.readdir(plan.target)).length === 0) await fs.rmdir(plan.target);
      } catch {
        // Already gone or not empty: nothing to tidy.
      }
    }
  }

  return {
    ok: true,
    deleted: plan.target,
    tree_id: plan.tree_id,
    files: plan.files,
    bytes: plan.bytes,
    bytes_human: plan.bytes_human,
    stranded_volumes: plan.stranded_volumes,
    snapshots_deleted,
  };
}
