// ─────────────────────────────────────────────────────────────────────────────
// DELETE A RUN — permanently, and only when the shape is understood.
//
// ── WHY IT REFUSES MORE THAN IT DELETES ─────────────────────────────────────
//
// This bench's history is heterogeneous on purpose: runs stopped early, trees
// written before conventions this code knows about, folders moved by hand. The
// governing rule is to standardise the VIEW, never the data — so nothing here
// repairs, migrates or infers. It recognises the ONE layout the reset actually
// writes, and anything else is refused with a reason worth pasting to someone
// rather than deleted on a guess.
//
// ── WHAT A RUN LEAVES, AND WHAT IS ACTUALLY ITS OWN ─────────────────────────
//
//   live      runs/<treeId>/…                      the tree itself
//   archived  runs/backups/<newTreeId>/            the tree a reset retired,
//                                                  plus the active-tree pointer,
//                                                  baselines and ledger AS THEY
//                                                  STOOD when it was retired
//
// The archived folder is named for the tree that SUPERSEDED it and holds
// exactly one tree inside. Deleting the folder therefore removes one run and
// the ledger rows that recorded it — which is what "as if it never ran" means.
// If it holds anything but that one tree, the layout is not the one this code
// knows and it is refused, listed, and left alone.
//
// ── WHAT IS DELIBERATELY NOT TOUCHED ────────────────────────────────────────
//
//   runs/baselines.json    DERIVED from the cells (`baselines.mjs`), rewritten
//                          whenever the derived index changes. Editing it here
//                          would be conforming data by hand.
//   docker volumes         named `bench-cell-<label>-session-db` — the label
//                          is MODEL-scoped, not run-scoped, so the same model in
//                          two trees produces one name. A volume cannot be
//                          attributed to a run, so deleting one on a run's
//                          behalf could destroy a different run's isolation.
//                          Reported in the preview, never removed here.
//   runs/snapshots/        carries its own `run_id`, which is a campaign label
//                          and not a tree id. No reliable correspondence exists,
//                          so none is invented.
// ─────────────────────────────────────────────────────────────────────────────

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

/** Recursive size + file count, bounded so a pathological tree cannot hang a request. */
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
        // A file that vanished mid-walk contributes nothing; it is not an error.
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

/** Stale per-cell session-DB volumes, reported so they are never a silent leftover. */
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
    // No docker, or it is not running. Absence of evidence, reported as absence.
    return [];
  }
}

/**
 * What deleting this row would remove, and whether it may proceed.
 *
 * Returns `{ok:true, target, token, restatement, …}` or a named refusal. The
 * TOKEN BINDS TO THE TARGET AND ITS CONTENTS: if the folder changes between the
 * preview and the confirm, the token no longer matches and the operator is
 * re-shown what is actually there instead of deleting something they never saw.
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
    // backups/<newTreeId>/<oldTreeId>/… — the folder is the unit.
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

    // The one shape this code knows: exactly one tree inside, and it is the
    // row's own. Anything else is somebody else's data or a layout that has
    // changed, and is refused rather than swept up.
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

  // Containment, again and independently: `target` is composed here, so it is
  // checked here rather than trusted from the resolution above.
  if (target !== root && !target.startsWith(root + sep)) {
    return refuse("invalid_run", "resolved target escapes the runs root");
  }
  if (target === root) {
    return refuse("invalid_run", "refusing to delete the runs root itself");
  }

  // THE ACTIVE TREE IS NOT DELETABLE. Removing it would leave active-tree.json
  // pointing at nothing, and the thing that retires a live tree already exists.
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

  // A LIVE RUN ONLY BLOCKS A LIVE TREE. The harness writes into the active tree
  // and nowhere else, so an archived run is not something it can be in the
  // middle of. Refusing every delete during a run would mean never being able
  // to clear old data on a bench that is usually running — which is the whole
  // reason this exists.
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

  const token = ["delete-run", treeId, `files=${files}`, `bytes=${bytes}`].join("|");
  const restatement = [
    `Permanently delete run ${treeId}.`,
    `${files} file${files === 1 ? "" : "s"} (${human(bytes)}) under ${target} will be REMOVED FROM DISK.`,
    archived
      ? "That is the archived tree plus the baselines and ledger recorded when it was retired."
      : "That is the whole tree: its cells, worktrees, transcripts and checkpoints.",
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
    token,
    restatement,
  };
}

/** Delete, once the token still matches what is on disk. */
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

  // An empty archive folder left behind after its only tree went is noise, not
  // history. Removed only when it is genuinely empty — never recursively.
  if (plan.archived) {
    const parent = dirname(plan.target);
    if (basename(parent) === BACKUPS_DIR) {
      try {
        if ((await fs.readdir(plan.target)).length === 0) await fs.rmdir(plan.target);
      } catch {
        // Already gone, or not empty. Either way there is nothing to tidy.
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
  };
}
