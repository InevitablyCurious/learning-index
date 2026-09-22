// BENCH BOARD — ACTIONS: every operator act that reaches the control plane
// (stop, launch, tool run, router key, dev mode, restore, reset, hold release,
// TUI detach, pointing the DATA FEED card at a baseline). State and render live
// in board.js; the import cycle is safe because everything here is deferred
// inside handlers. Each write path re-checks controlReachability(board) when
// clicked (the board can lose the control plane between render and click);
// dom-patch.test.mjs pins that.

import { board, render, controlReachability, setTuiRunId, nul } from "./board.js";
import { armReset, commitReset } from "./panels/treereset.js";
import { loadRouters, saveRouterKey } from "./panels/routers.js";
import { setDevMode, isDevModeBusy } from "./panels/devmode.js";
import { launchCell } from "./panels/create.js";
import { loadTools, runTool } from "./panels/tools.js";
import { loadBatch, renderBatch, pickRun } from "./panels/batch.js";
import {
  selectHistoricalRun,
  selectHistoricalRunUnreachable,
  clearHistoricalRun,
} from "./panels/live.js";
import { loadBackups, armRestore, commitRestore } from "./panels/restore.js";
import { previewStop, commitStop } from "./panels/runstart.js";
import { cancelDetach } from "./panels/tui.js";

export async function doPreviewStop() {
  const reach = controlReachability(board);
  if (!reach.ok) { console.error(`stop unavailable — ${reach.code}`); render(); return; }
  render();
  await previewStop();
  render();
}

export async function doCommitStop() {
  const reach = controlReachability(board);
  if (!reach.ok) { console.error(`stop unavailable — ${reach.code}`); render(); return; }
  render();
  await commitStop();
  render();
}

export async function doLoadRouters() {
  const reach = controlReachability(board);
  if (!reach.ok) { console.error(`routers unavailable — ${reach.code}`); render(); return; }
  await loadRouters();
  render();
}

export async function doSaveRouterKey(id) {
  const reach = controlReachability(board);
  if (!reach.ok) { console.error(`routers unavailable — ${reach.code}`); render(); return; }
  render();
  await saveRouterKey(id);
  render();
}

export async function doToggleDevMode(desired) {
  const reach = controlReachability(board);
  if (!reach.ok) { console.error(`dev mode unavailable — ${reach.code}`); render(); return; }
  // A real double-POST guard: setDevMode raises the flag before the POST.
  if (isDevModeBusy()) { render(); return; }
  render();
  await setDevMode(desired === "on");
  render();
}

export async function doLaunchBaseline(opts) {
  const reach = controlReachability(board);
  if (!reach.ok) {
    console.error(`run start unavailable — ${reach.code}: ${reach.reason}`);
    render();
    return;
  }
  // The launch frame is switched before the first await, so the checklist shows
  // while preflight runs.
  render();
  await launchCell(opts);
  render();
}

export async function doLoadTools() {
  const reach = controlReachability(board);
  if (!reach.ok) { console.error(`tools unavailable — ${reach.code}`); render(); return; }
  await loadTools();
  render();
}

export async function doRunTool(id) {
  const reach = controlReachability(board);
  if (!reach.ok) { console.error(`tools unavailable — ${reach.code}`); render(); return; }
  render();
  await runTool(id);
  render();
  // Re-read the registry after every run: a tool can change the others. A
  // failed re-read keeps the rows and says they may be stale.
  await loadTools();
  render();
}

/**
 * Point the DATA FEED card at one baseline. Never throws. A row whose cell is
 * running returns the card to live; a row that addresses nothing leaves it as is.
 */
export async function pointFeedAt(board, b) {
  if (!b) return;
  if (board?.models_ledger?.run_in_flight === true && b.state === "running") {
    clearHistoricalRun();
    render();
    return;
  }
  if (b.state !== "complete") return;
  if (typeof b.run_dir !== "string" || !b.run_dir) return;
  if (!Number.isInteger(b.sequence_index) || b.sequence_index < 0) return;

  const sel = {
    run_dir: b.run_dir,
    sequence_index: b.sequence_index,
    label: `${b.id} · ${b.model ?? "unknown model"}`,
  };
  // With the control plane down both feed reads would come back empty: refuse
  // with the reason instead.
  const reach = controlReachability(board);
  if (!reach.ok) {
    selectHistoricalRunUnreachable(sel, `${reach.code}: ${reach.reason}`);
    render();
    return;
  }
  const read = await selectHistoricalRun(sel);
  if (read) render();
}

/** Release a hold (same-origin, relayed). */
export async function releaseHold() {
  const reach = controlReachability(board);
  if (!reach.ok) {
    console.error(`hold release unavailable — ${reach.code}: ${reach.reason}`);
    return;
  }
  try {
    const res = await fetch(`/api/hold/release`, { method: "POST" });
    if (!res.ok) console.error(`hold release refused: HTTP ${res.status}`);
    // The next poll sees the hold file vanish: that is the success signal.
  } catch (err) {
    console.error("hold release failed:", err);
  }
}

export async function detachTui() {
  const reach = controlReachability(board);
  cancelDetach();
  if (!reach.ok) {
    console.error(`tui detach unavailable — ${reach.code}: ${reach.reason}`);
    render();
    return;
  }
  try {
    const res = await fetch(`/api/tui/detach`, { method: "POST" });
    if (!res.ok) console.error(`tui detach refused: HTTP ${res.status}`);
  } catch (err) {
    console.error("tui detach failed:", err);
  }
  render();
}

/**
 * The TUI mirror's cell selector: re-key the SSE subscription to one live cell
 * ("" = the default/newest). Not a control-plane write — the resubscribe inside
 * setTuiRunId IS the act; the render refreshes the selector and the label.
 */
export function doSelectTuiRun(runId) {
  setTuiRunId(runId);
  render();
}

/**
 * RESTORE: read the list, pick one, confirm — each step re-checks
 * reachability.
 */
export async function doLoadBackups() {
  const reach = controlReachability(board);
  if (!reach.ok) { console.error(`restore unavailable — ${reach.code}`); render(); return; }
  await loadBackups();
  render();
}

export async function doArmRestore(id) {
  const reach = controlReachability(board);
  if (!reach.ok) { console.error(`restore unavailable — ${reach.code}`); render(); return; }
  render();
  await armRestore(id);
  render();
}

export async function doCommitRestore() {
  const reach = controlReachability(board);
  if (!reach.ok) { console.error(`restore unavailable — ${reach.code}`); render(); return; }
  // Reloads the page on success (see commitRestore).
  await commitRestore();
  render();
}

/**
 * RESET: two clicks against the server's restatement, each re-checking
 * reachability.
 */
export async function doArmReset() {
  const reach = controlReachability(board);
  if (!reach.ok) {
    console.error(`reset unavailable — ${reach.code}: ${reach.reason}`);
    render();
    return;
  }
  render();
  await armReset();
  render();
}

export async function doCommitReset() {
  const reach = controlReachability(board);
  if (!reach.ok) {
    console.error(`reset unavailable — ${reach.code}: ${reach.reason}`);
    render();
    return;
  }
  // Reloads the page on success, so no panel keeps a selection that outlived
  // its data.
  await commitReset();
  render();
}

/**
 * BATCH: read one campaign's batch record and paint it into the row's
 * data-preserve slot (panels/ledger.js renders the slot; patch() never wipes
 * it). A batch the server does not have is painted as absent — never as an
 * empty, pickable list.
 */
export async function doOpenBatch(runDir) {
  const reach = controlReachability(board);
  if (!reach.ok) { console.error(`batch unavailable — ${reach.code}`); render(); return; }
  let batch = null;
  try {
    batch = await loadBatch(runDir);
  } catch (err) {
    console.error("batch load failed:", err);
  }
  const slot = document.querySelector(`[data-batch-slot="${runDir}"]`);
  if (slot) slot.innerHTML = batch ? renderBatch(batch) : nul("batch unavailable");
  render();
}

/**
 * BATCH PICK: POST the operator's floor selection, then re-open the batch so
 * the slot shows the server's truth — the recorded selection with its signed
 * deviation, or the void banner if the batch died between render and click.
 * A refused pick is printed, never swallowed: the re-opened record is the
 * only success signal.
 */
export async function doPickBatch(runDir, seq) {
  const reach = controlReachability(board);
  if (!reach.ok) { console.error(`batch select unavailable — ${reach.code}`); render(); return; }
  render();
  try {
    await pickRun(runDir, seq);
  } catch (err) {
    console.error("batch select failed:", err);
  }
  await doOpenBatch(runDir);
  render();
}
