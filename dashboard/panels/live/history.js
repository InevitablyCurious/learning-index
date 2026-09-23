// DATA FEED — which cell's record the card shows, and keeping it fresh.
//
// ONE SUBJECT. The card shows the cell the cell strip is pointing at
// (panels/cells.js activeCell: the operator's pick, else the newest running
// cell, else the batch's first). It used to have its own selection — a live
// ring for "the" running cell, BASELINES rows for a concluded one, BACK TO LIVE
// between them — and with N concurrent cells that ring held every cell's rows
// at once. Now there is one read for every cell, running or ended: the cell's
// own record by (run_dir, sequence_index). While the cell runs it is re-read
// every REFRESH_MS; the painter appends past its seq watermark, so a re-read
// adds rows and never rebuilds. One more read after the cell ends catches the
// rows written between the last poll and the end.
//
// Writes go through state.js setters.

import { hist, setHist } from "./state.js";
import { activeCell } from "../cells.js";
import { controlReachability } from "../../board.js";

const REFRESH_MS = 2000;

/** `${run_dir}::${sequence_index}` — the cell coordinates, composed once. */
export function histKey(sel) {
  return `${sel?.run_dir}::${sel?.sequence_index}`;
}

/** The cell the card is showing, or null when there is none. */
export function feedSelection() {
  return hist ? { ...hist.sel } : null;
}

/** The strip's active cell as a feed selection; null when it addresses nothing. */
function selectionFor(board) {
  const c = activeCell(board);
  if (!c) return null;
  if (typeof c.run_dir !== "string" || !c.run_dir) return null;
  if (!Number.isInteger(c.sequence_index) || c.sequence_index < 0) return null;
  return {
    run_dir: c.run_dir,
    sequence_index: c.sequence_index,
    running: c.running === true,
    label: `s${String(c.sequence_index).padStart(4, "0")}`,
  };
}

/**
 * Point the card at the strip's cell and keep its record fresh. Called every
 * render; fire-and-forget, never throws. A read that fails is shown on the card
 * as its reason, never as an empty feed.
 */
export function syncFeedToCell(board) {
  const sel = selectionFor(board);
  if (!sel) {
    if (hist) setHist(null);
    return;
  }
  const reach = controlReachability(board);

  if (!hist || histKey(hist.sel) !== histKey(sel)) {
    if (!reach.ok) {
      setHist({ sel, loading: false, at: Date.now(), readWhileRunning: false,
        events: { ok: false, reason: `${reach.code}: ${reach.reason}` },
        backend: { ok: false, reason: `${reach.code}: ${reach.reason}` } });
      return;
    }
    setHist({ sel, loading: true, at: 0, readWhileRunning: false, events: null, backend: null });
    void readCell(sel);
    return;
  }

  // Same cell: carry its running state, and re-read while it runs plus once
  // after it stops.
  hist.sel.running = sel.running;
  if (hist.inFlight || !reach.ok) return;
  const due = Date.now() - (hist.at ?? 0) >= REFRESH_MS;
  if (due && (sel.running || hist.readWhileRunning)) void readCell(sel);
}

/**
 * Read one cell's record (events + backend feed). The previous read stays on
 * screen until this one lands; a read for a cell the card has left is dropped.
 * Returns true when it landed.
 */
export async function readCell(sel) {
  if (!hist || histKey(hist.sel) !== histKey(sel)) return false;
  hist.inFlight = true;
  const key = histKey(sel);
  const run = encodeURIComponent(sel.run_dir);
  const seq = sel.sequence_index;
  const [events, backendRes] = await Promise.all([
    histFetch(`/api/events?run_dir=${run}&sequence_index=${seq}`),
    histFetch(`/api/backend-feed?run_dir=${run}&sequence_index=${seq}`),
  ]);
  // The operator moved on while this was in flight: drop the stale read.
  if (!hist || histKey(hist.sel) !== key) return false;
  setHist({
    ...hist,
    loading: false,
    inFlight: false,
    at: Date.now(),
    // A read taken while running earns exactly one more after the cell ends.
    readWhileRunning: hist.sel.running === true,
    events,
    backend: backendRes,
  });
  return true;
}

// A raw fetch; every failure becomes data.
async function histFetch(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err) };
  }
}
