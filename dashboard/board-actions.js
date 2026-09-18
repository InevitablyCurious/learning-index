// ─────────────────────────────────────────────────────────────────────────────
// BENCH BOARD v2 — ACTIONS
//
// The network half of the board, split out of board.js: every function here is
// one operator act that reaches the control plane — stop, launch, tool run,
// router key, dev mode, restore, reset, hold release, TUI detach, and pointing
// the DATA FEED card at a baseline record.
//
// STATE AND RENDER LIVE IN board.js — this module owns none. It imports the
// LIVE `board` binding plus `render` and `controlReachability`, and board.js
// imports these handlers back for its delegated onClick dispatch. That cycle is
// the same shape as the board.js ↔ panels cycle and resolves the same way:
// every read of `board` and every call of `render` is DEFERRED inside a
// handler body — nothing here touches state at module scope, so circular
// evaluation has no TDZ window.
//
// THE GUARD PREAMBLE IS THE CONTRACT: each write path re-derives
// controlReachability(board) at CALL time rather than trusting that its button
// was only rendered while reachable — the board can go unreachable between
// render and click, and a POST into the void would leave a dialog looking
// armed. Every request is same-origin; the dashboard relays it to the
// control plane.
// dom-patch.test.mjs pins the gate on every path in this file.
// ─────────────────────────────────────────────────────────────────────────────

import { board, render, controlReachability } from "./board.js";
import { armReset, commitReset } from "./panels/treereset.js";
import { loadRouters, saveRouterKey } from "./panels/routers.js";
import { setDevMode, isDevModeBusy } from "./panels/devmode.js";
import { launchCell } from "./panels/create.js";
import { loadTools, runTool } from "./panels/tools.js";
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
  // The busy flag is LIVE: setDevMode raises it before the POST and clears it in
  // a finally, so this is a real double-POST guard, not a dead condition.
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
  // The frame is switched INSIDE launchBaseline before the first await, so the
  // checklist is on screen while preflight runs rather than after it returns.
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
  // RE-READ THE REGISTRY AFTER EVERY RUN. A tool can change what the other
  // tools can do — restarting the bench MCP unblocks `join org`, and
  // `bench-ready` restarts this control plane, after which the list held here
  // is a copy of a registry that no longer exists. Pressing a stale row sends a
  // tool id at a server mid-restart and reads as a broken button. A failed
  // re-read keeps the rows on screen and says they may be out of date.
  await loadTools();
  render();
}

/**
 * Point the DATA FEED card at one baseline. Never throws, never blocks a render.
 *
 * WHETHER THE RUN IS OLD OR RUNNING NOW. A row whose cell is IN FLIGHT has no
 * frozen record — its feed IS the live one — so selecting it returns the card to
 * live rather than reading a transcript that does not exist yet.
 *
 * A row that can address nothing leaves the card AS IT WAS. Clearing it would
 * make an unaddressable row behave like BACK TO LIVE, which is a different act
 * the operator did not ask for.
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
  // Same gate as every write: with the control plane down, both feed reads
  // would silently come back empty. Refusing with the reason is clearer.
  const reach = controlReachability(board);
  if (!reach.ok) {
    selectHistoricalRunUnreachable(sel, `${reach.code}: ${reach.reason}`);
    render();
    return;
  }
  const read = await selectHistoricalRun(sel);
  if (read) render();
}

/** The board posts same-origin to the dashboard relay, which forwards to the control plane. */
export async function releaseHold() {
  const reach = controlReachability(board);
  if (!reach.ok) {
    console.error(`hold release unavailable — ${reach.code}: ${reach.reason}`);
    return;
  }
  try {
    const res = await fetch(`/api/hold/release`, { method: "POST" });
    if (!res.ok) console.error(`hold release refused: HTTP ${res.status}`);
    // The next poll observes the file vanish, which IS the success signal.
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

// Run start is the loudest control on the board, so a silent `return` here was
// the worst instance of the original defect: the operator arms a run, nothing
// happens, and no reason is given anywhere. The reason now reaches the console
// AND the topbar banner explains the LAN case before the click.
/**
 * RESTORE, in three steps: read history, pick one, confirm it.
 *
 * Each re-checks reachability rather than trusting that the control was only
 * rendered while reachable — the board can go unreachable between render and
 * click, and a POST into the void would leave the dialog looking armed.
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
  // Reloads the page on success — see commitRestore.
  await commitRestore();
  render();
}

/**
 * RESET, in two clicks against the server's own restatement.
 *
 * Both halves re-check reachability rather than trusting that the button was
 * only rendered when reachable — the board can go unreachable between render
 * and click, and a POST into the void would leave the control looking armed.
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
  // On success this reloads the page outright — see commitReset. Nothing after
  // it runs, which is the point: no panel keeps a selection that outlives the
  // data it referred to.
  await commitReset();
  render();
}
