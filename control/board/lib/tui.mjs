// THE TUI FAST PATH — frame polling, row diffing, subscriber-only pushes.
// Import-safe: top level is declarations only.

import { streamClients } from "./state.mjs";

/**
 * The mirror's own cadence (250ms). Riding the board's 2s build-and-push loop
 * made it repaint every 2–4s; a terminal someone is reading needs better. Runs
 * only while a client subscribes: polling is what keeps the capture alive.
 */
export const TUI_STREAM_MS = 250;

/**
 * Clients that asked for frames, grouped by the cell each one mirrors
 * (`res.okpTuiCell`, from /api/stream's `?cell=` param — the cell's address).
 * A client with no cell mirrors nothing: there is no "default" cell to guess.
 */
export function groupTuiSubscribers(clients) {
  const groups = new Map();
  for (const res of clients) {
    if (res.okpWantsTui !== true) continue;
    // Its board frame is not written yet (routes/board.mjs); frames wait for it.
    if (res.okpBoardSent === false) continue;
    const key = res.okpTuiCell || null;
    if (key === null) continue;
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
 * cell address → { sig, rows, inFlight }: one memo
 * per mirrored cell, so each subscriber receives the frame of the cell IT
 * selected rather than whichever single cell the unkeyed path last saw.
 */
const tuiMemo = new Map();

/**
 * Fetch, diff, and push for ONE cell's group. Every patch carries the cell
 * it belongs to so the client can key its render.
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
    const url = `${base}/api/tui?cell=${encodeURIComponent(runId)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(2000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return;
    const data = await res.json();
    const sig = JSON.stringify(data);
    // The memo is the cell's, not the subscriber's: a client joining a cell
    // someone already watches has no frame to splice rows into, so it is sent
    // a full frame first, changed or not.
    const unframed = subs.filter((r) => r.okpTuiFramed !== runId);
    const changed = sig !== memo.sig;
    if (!changed && !unframed.length) return; // an unchanged terminal sends nothing
    memo.sig = sig;

    // Changed rows only, by index; a full frame when there's nothing to splice.
    const rows = diffTuiRows(memo.rows, data.frame);
    const { frame: _f, ...meta } = data;
    const key = data.cell ?? runId;
    const full = JSON.stringify({ tui: { ...data, cell: key } });
    const body = rows === null ? full : JSON.stringify({ tui_rows: { rows, meta, cell: key } });
    memo.rows = data.frame ?? null;

    for (const r of subs) {
      const fresh = r.okpTuiFramed !== runId;
      if (!fresh && !changed) continue;
      try {
        r.write(`event: patch\ndata: ${fresh ? full : body}\n\n`);
        r.okpTuiFramed = runId;
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
