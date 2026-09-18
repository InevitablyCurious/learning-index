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

/** Clients that asked for frames. */
function tuiSubscribers() {
  return [...streamClients].filter((res) => res.okpWantsTui === true);
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
let lastTuiFrame = null;
let lastTuiRows = null;
let tuiInFlight = false;

export async function tuiTick(cfg) {
  const subs = tuiSubscribers();
  if (!subs.length) {
    // Nobody watching: forget the memo so the next subscriber gets a full frame.
    lastTuiFrame = null;
    return;
  }
  // Never stack requests on a slow control plane.
  if (tuiInFlight) return;
  tuiInFlight = true;
  try {
    const base = cfg.controlUrl ?? "http://127.0.0.1:8718";
    const res = await fetch(`${base}/api/tui`, {
      signal: AbortSignal.timeout(2000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return;
    const data = await res.json();
    const sig = JSON.stringify(data);
    if (sig === lastTuiFrame) return; // an unchanged terminal sends nothing
    lastTuiFrame = sig;

    // Changed rows only, by index; a full frame when there's nothing to splice.
    const rows = diffTuiRows(lastTuiRows, data.frame);
    const { frame: _f, ...meta } = data;
    const body =
      rows === null
        ? JSON.stringify({ tui: data })
        : JSON.stringify({ tui_rows: { rows, meta } });
    lastTuiRows = data.frame ?? null;

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
    tuiInFlight = false;
  }
}
