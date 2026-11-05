// BENCH BOARD — ACTIONS: every operator act that reaches the control plane
// (stop, launch, tool run, router key, dev mode, restore, reset,
// TUI detach). State and render live
// in board.js; the import cycle is safe because everything here is deferred
// inside handlers. Each write path re-checks controlReachability(board) when
// clicked (the board can lose the control plane between render and click);
// dom-patch.test.mjs pins that.

import { board, render, controlReachability, nul } from "./board.js";
import { armReset, commitReset } from "./panels/treereset.js";
import { loadRouters, saveRouterKey } from "./panels/routers.js";
import { setDevMode, isDevModeBusy } from "./panels/devmode.js";
import { launchCell } from "./panels/create.js";
import { loadTools, runTool } from "./panels/tools.js";
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
  // The launch is mode-blind: the control plane derives the dev-mode pause from
  // its own dev-mode state, so nothing about the mode travels with the request.
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
