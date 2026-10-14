// BENCH BOARD — ACTIONS: every operator act that reaches the control plane
// (stop, launch, tool run, router key, dev mode, restore, reset, hold release,
// TUI detach). State and render live
// in board.js; the import cycle is safe because everything here is deferred
// inside handlers. Each write path re-checks controlReachability(board) when
// clicked (the board can lose the control plane between render and click);
// dom-patch.test.mjs pins that.

import { board, render, controlReachability, nul } from "./board.js";
import { setHoldBusy, setHoldError, setHoldNote, holdNoteValue } from "./panels/hold.js";
import { armReset, commitReset } from "./panels/treereset.js";
import { loadRouters, saveRouterKey } from "./panels/routers.js";
import { setDevMode, isDevModeBusy, isDevModeOn } from "./panels/devmode.js";
import { launchCell } from "./panels/create.js";
import { loadTools, runTool } from "./panels/tools.js";
import { pickRun } from "./panels/batch.js";
import { notePickRefusal } from "./panels/ledger.js";
import { loadBackups, armRestore, commitRestore } from "./panels/restore.js";
import { previewStop, commitStop } from "./panels/runstart.js";
import { cancelDetach } from "./panels/tui.js";
import { setContinuousRefusal } from "./panels/continuous.js";

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
  await launchCell({ ...opts, devOn: isDevModeOn(board) });
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
 * Pure: the JSON body for a hold release — carries {note} ONLY when the note
 * is non-empty (whitespace counts as empty). null = send no body at all.
 */
export function releaseBody(note) {
  const trimmed = String(note ?? "").trim();
  return trimmed ? { note: trimmed } : null;
}

/**
 * Release a hold (same-origin, relayed). An optional note is sent with the
 * release only when it is non-empty (a 4000-char cap is enforced by the
 * control plane and the textarea). Returns {ok, reason} so the pause panel can
 * keep the note and show the server's reason on a refusal.
 */
export async function releaseHold(note = null) {
  const reach = controlReachability(board);
  if (!reach.ok) {
    return { ok: false, reason: `${reach.code}: ${reach.reason}` };
  }
  const body = releaseBody(note);
  const init = { method: "POST" };
  if (body) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(`/api/hold/release`, init);
    if (res.ok) return { ok: true };
    let reason = `HTTP ${res.status}`;
    try {
      const d = await res.json();
      if (d?.reason) reason = (d.code ? `${d.code}: ` : "") + d.reason;
    } catch {
      /* keep the HTTP status */
    }
    return { ok: false, reason };
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err) };
  }
}

/**
 * CONTINUE from the pause panel: send the note (if any) with the release. The
 * note box text is kept unless the release succeeds; a refusal is shown in the
 * panel, not swallowed. The next poll seeing the hold vanish is the success
 * signal.
 */
export async function doContinueHold() {
  setHoldBusy(true);
  setHoldError(null);
  render();
  const result = await releaseHold(holdNoteValue());
  if (result.ok) setHoldNote("");
  else setHoldError(result.reason);
  setHoldBusy(false);
  render();
}

/**
 * END AFTER THIS RUN: continuous mode stops chaining; the run in flight goes
 * on. A refusal is shown in the banner itself. The next poll's ended chain is
 * the success signal.
 */
export async function doEndContinuous() {
  const reach = controlReachability(board);
  if (!reach.ok) {
    setContinuousRefusal(`ending continuous mode is unavailable — ${reach.code}: ${reach.reason}`);
    render();
    return;
  }
  try {
    const res = await fetch(`/api/continuous/stop`, { method: "POST" });
    const data = await res.json().catch(() => null);
    setContinuousRefusal(
      res.ok && data?.ok !== false
        ? null
        : `${data?.code ?? `HTTP ${res.status}`}: ${data?.reason ?? "ending continuous mode was refused"}`,
    );
  } catch (err) {
    setContinuousRefusal(`ending continuous mode failed: ${err?.message ?? err}`);
  }
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

/**
 * BATCH PICK: POST the operator's floor selection. Success shows on the next
 * board push (the row turns FLOOR with its distance from the median); a refused
 * pick is printed on the batch's own cell table, never swallowed.
 */
export async function doPickBatch(runDir, seq) {
  const reach = controlReachability(board);
  if (!reach.ok) {
    notePickRefusal(runDir, `pick unavailable — ${reach.code}: ${reach.reason}`);
    render();
    return;
  }
  try {
    await pickRun(runDir, seq);
    notePickRefusal(runDir, null);
  } catch (err) {
    notePickRefusal(runDir, String(err?.message ?? err));
  }
  render();
}
