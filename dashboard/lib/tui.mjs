// ─────────────────────────────────────────────────────────────────────────────
// THE TUI FAST PATH — frame polling, row diffing, subscriber-only pushes.
//
// Extracted from server.mjs (WO LI-13). The measurements below are the record
// of why the mirror has its own cadence and cannot ride the board's.
// Import-safe: top level is declarations only.
// ─────────────────────────────────────────────────────────────────────────────

import { streamClients } from "./state.mjs";

/**
 * The TUI screen, reduced to its status when nobody is looking at it.
 *
 * The terminal frame is 12.4KB — by far the largest section on the board — and
 * it changes on every capture. Streaming it to a client whose popout is
 * MINIMIZED spends the entire bandwidth budget on pixels nobody can see.
 *
 * The client declares interest by reconnecting with `?tui=1` (panels/tui.js
 * toggles it). When it has not, the frame is dropped and only the STATUS is
 * sent — which is exactly what the minimized dock bar renders, so the bar stays
 * truthful about whether the mirror is alive.
 *
 * This is a transport optimisation ONLY. Nothing about what the TUI panel may
 * display changes; an expanded popout receives the full frame as before.
 */
export function tuiForClient(section, wantsFrame) {
  if (!section || wantsFrame) return section;
  const { frame: _f, ...status } = section;
  return { ...status, frame: null, frame_withheld: true };
}

/**
 * The TUI fast path.
 *
 * ── WHY THE MIRROR NEEDS ITS OWN CADENCE (measured defect 2026-08-13) ───────
 *
 * The terminal was repainting about once every 4 seconds. It was not streaming
 * at all — it was being PULLED through two independent 2s stages that do not
 * share a phase:
 *
 *   pty -> control Capture (continuous)
 *       -> control /api/tui            (pulled only when asked)
 *       -> dashboard control-plane source, inside getBoard()
 *       -> dashboard getBoard CACHE     age < pollMs = 2000ms
 *       -> dashboard push tick          setInterval(pollMs) = 2000ms
 *       -> browser
 *
 * best case 2s, worst case ~4s — which is exactly what was observed.
 *
 * A terminal is not board state. The board's cadence is right for a gate wall
 * that changes every few minutes and wrong for a screen a human is reading. So
 * the mirror gets a DIRECT line: this polls control/api/tui on its own short
 * interval and pushes frames the moment they change, bypassing the board
 * assembly and its cache entirely.
 *
 * IT RUNS ONLY WHILE SOMEONE IS WATCHING. The capture upstream stops itself
 * when nothing reads it (TUI_IDLE_STOP_MS), and polling IS that keepalive — so
 * an interval that ran with no subscriber would hold a pty open against a live
 * benchmark session for no reason.
 */
export const TUI_STREAM_MS = 250;

/** Clients whose popout is open, and therefore want frames. */
function tuiSubscribers() {
  return [...streamClients].filter((res) => res.okpWantsTui === true);
}

/**
 * Diff two terminal frames to the ROWS that changed.
 *
 * ── WHY (measured 2026-08-13) ──────────────────────────────────────────────
 * Streaming at 250ms made the mirror feel live, and cost 36KB per frame — 80
 * frames in 20s, ~2.8MB, to fix a latency problem. That trade is not worth
 * making: a terminal that is being typed into changes a handful of rows, and a
 * cursor blink changes exactly one.
 *
 * So only changed rows go on the wire, addressed by index. The client splices
 * them into the frame it already holds. A full frame is still sent whenever the
 * geometry changes or the client has no frame to splice into — correctness
 * first, and a resize is rare.
 */
export function diffTuiRows(prev, next) {
  if (!Array.isArray(prev) || !Array.isArray(next) || prev.length !== next.length) return null;
  const rows = [];
  for (let i = 0; i < next.length; i += 1) {
    if (JSON.stringify(prev[i]) !== JSON.stringify(next[i])) rows.push([i, next[i]]);
  }
  return rows;
}

// ── THE TUI FAST PATH LOOP ───────────────────────────────────────────────────
// A dedicated short-interval poll straight to the control plane, pushing
// frames to subscribed clients only. See TUI_STREAM_MS above for why the
// mirror cannot ride the board's cadence.
let lastTuiFrame = null;
let lastTuiRows = null;
let tuiInFlight = false;

export async function tuiTick(cfg) {
  const subs = tuiSubscribers();
  if (!subs.length) {
    // Nobody is watching. Drop the memo so the next subscriber is guaranteed
    // a full frame rather than being diffed against a stale one.
    lastTuiFrame = null;
    return;
  }
  // Never let a slow control plane stack requests on top of each other.
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

    // ROW DIFF. The full ~36KB screen is sent only when there is nothing to
    // splice against or the geometry moved; otherwise only the rows that
    // actually changed, addressed by index. A cursor blink is one row.
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
    // A blink of the control plane must not kill the loop; the next tick
    // retries and the panel keeps its last good frame on screen.
  } finally {
    tuiInFlight = false;
  }
}
