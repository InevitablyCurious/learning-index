// THE TUI FAST PATH — frame polling, row diffing, subscriber-only pushes.
// Import-safe: top level is declarations only.

import { streamClients } from "./state.mjs";

/**
 * The TUI section reduced to its status unless the client asked for frames
 * (`?tui=1`, sent while the TUI MIRROR tab is on screen). The frame is the
 * largest section; this only saves bandwidth, it hides nothing.
 */
export function tuiForClient(section, wantsFrame) {
  if (!section || wantsFrame) return section;
  const { frame: _f, ...status } = section;
  return { ...status, frame: null, frame_withheld: true };
}

/**
 * The mirror's own cadence (250ms). Riding the board's 2s build-and-push loop
 * made it repaint every 2–4s; a terminal someone is reading needs better. Runs
 * only while a client subscribes: polling is what keeps the capture alive.
 */
export const TUI_STREAM_MS = 250;

/**
 * Clients that asked for frames, grouped by the run_id of the cell each one
 * mirrors (`res.okpTuiRunId`, from /api/stream's `?run_id=` param). `null` is
 * the unkeyed default group — the newest cell — matching /api/tui's own
 * truthiness contract: an empty string counts as default too.
 */
export function groupTuiSubscribers(clients) {
  const groups = new Map();
  for (const res of clients) {
    if (res.okpWantsTui !== true) continue;
    const key = res.okpTuiRunId || null;
    const subs = groups.get(key);
    if (subs) subs.push(res);
    else groups.set(key, [res]);
  }
  return groups;
}

/**
 * Diff two frames to the rows that changed (a full frame at 250ms was ~2.8MB
 * per 20s). A full frame is sent when geometry changes or the client has none.
 */
export function diffTuiRows(prev, next) {
  if (!Array.isArray(prev) || !Array.isArray(next) || prev.length !== next.length) return null;
  const rows = [];
  for (let i = 0; i < next.length; i += 1) {
    if (JSON.stringify(prev[i]) !== JSON.stringify(next[i])) rows.push([i, next[i]]);
  }
  return rows;
}

// ── THE FAST PATH LOOP ──
/**
 * run_id (null = the default newest cell) → { sig, rows, inFlight }: one memo
 * per mirrored cell, so each subscriber receives the frame of the cell IT
 * selected rather than whichever single cell the unkeyed path last saw.
 */
const tuiMemo = new Map();

/**
 * Fetch, diff, and push for ONE run_id group. `runId === null` fetches
 * /api/tui unkeyed (the default newest cell); a string run_id fetches exactly
 * that cell. Every patch carries the run_id it belongs to so the client can
 * key its render.
 */
async function pushTuiGroup(base, runId, subs) {
  let memo = tuiMemo.get(runId);
  if (!memo) {
    memo = { sig: null, rows: null, inFlight: false };
    tuiMemo.set(runId, memo);
  }
  // Never stack requests on a slow control plane.
  if (memo.inFlight) return;
  memo.inFlight = true;
  try {
    const url =
      runId === null
        ? `${base}/api/tui`
        : `${base}/api/tui?run_id=${encodeURIComponent(runId)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(2000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return;
    const data = await res.json();
    const sig = JSON.stringify(data);
    if (sig === memo.sig) return; // an unchanged terminal sends nothing
    memo.sig = sig;

    // Changed rows only, by index; a full frame when there's nothing to splice.
    const rows = diffTuiRows(memo.rows, data.frame);
    const { frame: _f, ...meta } = data;
    const key = data.run_id ?? runId;
    const body =
      rows === null
        ? JSON.stringify({ tui: { ...data, run_id: key } })
        : JSON.stringify({ tui_rows: { rows, meta, run_id: key } });
    memo.rows = data.frame ?? null;

    for (const r of subs) {
      try {
        r.write(`event: patch\ndata: ${body}\n\n`);
      } catch {
        streamClients.delete(r);
      }
    }
  } catch {
    // A blip never kills the loop; the panel keeps its last good frame.
  } finally {
    memo.inFlight = false;
  }
}

export async function tuiTick(cfg) {
  const groups = groupTuiSubscribers(streamClients);
  // Forget the memo of any cell nobody watches, so its next subscriber gets a
  // full frame. An in-flight entry survives the prune — dropping it would let
  // the next tick stack a second fetch for the same cell.
  for (const [runId, memo] of tuiMemo) {
    if (!groups.has(runId) && !memo.inFlight) tuiMemo.delete(runId);
  }
  if (!groups.size) return;
  const base = cfg.controlUrl ?? "http://127.0.0.1:8718";
  await Promise.all([...groups].map(([runId, subs]) => pushTuiGroup(base, runId, subs)));
}
