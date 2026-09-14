// ─────────────────────────────────────────────────────────────────────────────
// CONTROL PLANE — RESET / RESTORE GATES
//
// Split out of server.mjs (LI-14 phase 1), byte-verbatim: MAY THE TREE BE
// RESET RIGHT NOW, and MAY THIS BACKUP BE RESTORED RIGHT NOW. The routes that
// call these stay in server.mjs until phase 2.
// ─────────────────────────────────────────────────────────────────────────────

import { refuse } from "../contract.mjs";
import { readRunState } from "../runstate.mjs";
import { planReset } from "../tree.mjs";
import { describeBackup, checkBackup, resolveBackupDir } from "../backups.mjs";
import { RUNS_ROOT, getLauncher } from "../state.mjs";

/**
 * MAY THE TREE BE RESET RIGHT NOW, and what exactly would that retire?
 *
 * ── THE ONE HARD REFUSAL: A CELL IN FLIGHT ──────────────────────────────────
 *
 * Rolling the tree forward mid-run would leave the running harness writing into
 * a tree no reader resolves into any more. The cell would keep burning hours,
 * the board would show an empty bench, and the measurement would be findable
 * only by someone who knew the old timestamp. That is a silent loss of exactly
 * the kind this tree exists to prevent, so it is refused rather than warned
 * about — the operator can reset the moment the cell lands.
 */
export async function treeResetGate() {
  const run = await readRunState({ runsRoot: RUNS_ROOT, launcher: getLauncher() });
  // A run in flight no longer hard-refuses a reset: the reset now STOPS it
  // first (see stopRun) so its partial data lands in the backup rather than
  // being moved out from under a live process. The operator is told, verbatim,
  // that a stop will happen before they confirm.
  const willStop = run.can_start !== true;

  const { moves, keeps } = await planReset(RUNS_ROOT);

  // THE TOKEN BINDS TO WHAT WILL ACTUALLY MOVE. If a run lands between the
  // confirmation appearing and the operator pressing continue, the list changes,
  // the token changes, and they are re-shown the new list instead of silently
  // backing up a measurement they never saw named.
  const token = ["reset-all", `items=${moves.length}`, `sig=${moves.join(",")}`].join("|");

  // PLAIN WORDS. This is the sentence an operator agrees to, and it is the one
  // place where precise-but-opaque costs the most.
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
    // KEPT ITEMS ARE COUNTED, NOT LISTED. There are two dozen pytest and
    // redeploy logs down there, and printing them buried the one line that
    // decides whether this is safe to press. The live process files are named
    // because they are the ones an operator would worry about.
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
 * MAY THIS BACKUP BE RESTORED RIGHT NOW, and what exactly would that do?
 *
 * Three refusals, in the order an operator would hit them: a run in flight, an
 * id that names nothing, and a backup that fails the conformance check. The
 * third is the one worth having — a malformed backup restores QUIETLY WRONG
 * rather than loudly, so it is caught before anything moves.
 */
export async function restoreGate(id) {
  const run = await readRunState({ runsRoot: RUNS_ROOT, launcher: getLauncher() });
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

  // The token binds to the backup AND to what is about to be parked, so a cell
  // landing between preview and confirm re-shows the operator the new picture.
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
