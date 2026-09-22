// CONTROL PLANE — RESET / RESTORE GATES: may the tree be reset, and may this
// backup be restored, right now — and what exactly would each do.

import { refuse } from "../contract.mjs";
import { readRunState } from "../runstate.mjs";
import { planReset } from "../tree.mjs";
import { describeBackup, checkBackup, resolveBackupDir } from "../backups.mjs";
import { RUNS_ROOT } from "../state.mjs";

/**
 * May the tree be reset now, and what would it move? A cell in flight is
 * stopped first (its partial data lands in the backup), and the restatement
 * says so.
 */
export async function treeResetGate() {
  const run = await readRunState({ runsRoot: RUNS_ROOT });
  const willStop = run.can_start !== true;

  const { moves, keeps } = await planReset(RUNS_ROOT);

  // The token binds to what will move: a run landing in between changes it, and
  // the operator is shown the new list.
  const token = ["reset-all", `items=${moves.length}`, `sig=${moves.join(",")}`].join("|");

  // Plain words: this is the sentence the operator agrees to.
  const restatement = [
    "Reset ALL benchmark data.",
    willStop
      ? `A benchmark run is still in progress (${run.state}) — resetting will STOP it first.`
      : null,
    moves.length
      ? `${moves.length} item${moves.length === 1 ? "" : "s"} will be moved to a backup folder: ${moves.join(", ")}`
      : "there is nothing to back up — the bench is already empty",
    "That clears results, baselines and run logs. The board goes back to zero.",
    "NOTHING IS DELETED. Everything moves into runs/backups/ and can be moved back.",
    // Kept items are counted, not listed; the live process files are named.
    keeps.length
      ? `Left alone: ${keeps.length} tooling/live file${keeps.length === 1 ? "" : "s"}` +
        (keeps.some((k) => k.startsWith("mcp4550.")) ? " (including the running bench MCP)" : "")
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  return { ok: true, token, restatement, moves, keeps };
}

/**
 * May this backup be restored now? Refused while a run is in flight, for an
 * unknown id, or when the backup fails its check (a malformed backup restores
 * quietly wrong).
 */
export async function restoreGate(id) {
  const run = await readRunState({ runsRoot: RUNS_ROOT });
  if (run.can_start !== true) {
    return refuse(
      "run_in_progress",
      `a benchmark run is still going — restoring now would move its results out from under it. ` +
        `Wait for it to finish, then restore. (${run.blocked_reason ?? "a run is in progress"})`,
    );
  }

  const dir = resolveBackupDir(RUNS_ROOT, id);
  if (!dir) return refuse("bad_backup_id", `${JSON.stringify(String(id ?? ""))} is not a backup id`);

  const summary = await describeBackup(RUNS_ROOT, id);
  if (!summary) return refuse("no_such_backup", `there is no backup ${JSON.stringify(String(id))}`);

  const check = await checkBackup(dir);
  if (!check.ok) {
    return refuse(
      "backup_failed_check",
      `this backup did not pass the check, so it was not restored: ${check.errors.join("; ")}`,
      { errors: check.errors, warnings: check.warnings },
    );
  }

  const { moves } = await planReset(RUNS_ROOT);

  // Bound to the backup and to what will be parked.
  const token = ["restore", `id=${summary.id}`, `items=${summary.counts.items}`, `park=${moves.length}`].join("|");

  const when = new Date(Number(summary.id) * 1000).toISOString().replace("T", " ").replace(/\..*/, " UTC");
  const restatement = [
    `Restore the benchmark data from ${when}.`,
    `${summary.counts.items} item(s) come back: ${summary.items.join(", ")}`,
    moves.length
      ? `The ${moves.length} item(s) on the bench right now are saved as a new backup first — nothing is overwritten.`
      : "The bench is empty right now, so nothing needs saving first.",
    check.warnings.length ? `Note: ${check.warnings.join("; ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return { ok: true, token, restatement, backup: summary, will_park: moves };
}
