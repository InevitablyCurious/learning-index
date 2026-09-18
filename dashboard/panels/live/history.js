// DATA FEED — historical selection and backend refresh: opening a concluded
// baseline's record, returning to live, auto-opening the last run when nothing
// is live, and the throttled backend-feed refresh. Writes go through state.js
// setters.

import {
  hist,
  setHist,
  autoTried,
  setAutoTried,
  autoSuppressed,
  setAutoSuppressed,
  setWasLive,
  backend,
  setBackend,
  backendAt,
  setBackendAt,
  backendInFlight,
  setBackendInFlight,
  emptyBackendFeed,
} from "./state.js";

/** Test seam: forget both what was tried and any operator stand-down. */
export function resetAutoSelect() {
  setAutoTried(null);
  setAutoSuppressed(false);
  setWasLive(null);
}

/**
 * Open the newest concluded baseline when nothing is live and nothing is
 * chosen. Fire-and-forget. Tried once per bench state (autoTried), so a failed
 * read isn't retried every push and BACK TO LIVE isn't overridden.
 */
export function maybeAutoSelect(board) {
  if (hist) return;

  const live = board?.models_ledger?.run_in_flight === true
    // cell_in_flight comes off the feed and moves before the ledger does.
    || board?.events?.cell_in_flight === true;
  if (live) {
    // A run clears the stand-down: after a cell runs, the next concluded one opens
    // by itself again.
    setAutoSuppressed(false);
    setAutoTried(null);
    return;
  }
  if (autoSuppressed) return;

  if (!board?.control) return;

  const rows = board?.models_ledger?.baseline_rows ?? [];
  const b = rows.find(
    (row) => row?.state === "complete"
      && typeof row.run_dir === "string" && row.run_dir.length > 0
      && Number.isInteger(row.sequence_index) && row.sequence_index >= 0,
  );
  if (!b) return;

  const key = `${b.run_dir}::${b.sequence_index}`;
  if (autoTried === key) return;
  setAutoTried(key);
  void selectHistoricalRun({
    run_dir: b.run_dir,
    sequence_index: b.sequence_index,
    label: `${b.id} · ${b.model ?? "unknown model"}`,
  });
}

/** `${run_dir}::${sequence_index}` — the cell coordinates, composed once. */
export function histKey(sel) {
  return `${sel?.run_dir}::${sel?.sequence_index}`;
}

/** What the card is showing: the selection, or null for the live cell. */
export function historicalSelection() {
  return hist ? { ...hist.sel } : null;
}

/** Return the card to the live cell; the cached feeds go with it. */
export function clearHistoricalRun() {
  setHist(null);
  // Auto-select stands down, or BACK TO LIVE would undo itself next render.
  setAutoSuppressed(true);
}

/**
 * Select a concluded cell and read its record once. Never throws; a failure
 * is shown as a note. Returns true when it actually read.
 */
export async function selectHistoricalRun(sel) {
  if (!sel || typeof sel.run_dir !== "string" || !sel.run_dir) return false;
  if (!Number.isInteger(sel.sequence_index) || sel.sequence_index < 0) return false;
  if (hist && histKey(hist.sel) === histKey(sel)) return false;

  setHist({ sel: { ...sel }, loading: true, events: null, backend: null });
  const key = histKey(sel);
  const run = encodeURIComponent(sel.run_dir);
  const seq = sel.sequence_index;
  const [events, backendRes] = await Promise.all([
    histFetch(`/api/events?run_dir=${run}&sequence_index=${seq}`),
    histFetch(`/api/backend-feed?run_dir=${run}&sequence_index=${seq}`),
  ]);
  // The operator moved on while this was in flight: drop the stale read.
  if (!hist || histKey(hist.sel) !== key) return false;
  setHist({ ...hist, loading: false, events, backend: backendRes });
  return true;
}

/**
 * Select a cell whose record can't be read (the control plane is
 * unreachable), and show why, rather than doing nothing.
 */
export function selectHistoricalRunUnreachable(sel, reason) {
  setHist({
    sel: { ...sel },
    loading: false,
    events: { ok: false, reason },
    backend: { ok: false, reason },
  });
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

const BACKEND_MIN_INTERVAL_MS = 2000;

/** Fire-and-forget, throttled, read on the next render. */
export function maybeRefreshBackend() {
  if (backendInFlight) return;
  const now = Date.now();
  if (backend.loaded && now - backendAt < BACKEND_MIN_INTERVAL_MS) return;
  setBackendInFlight(true);
  fetch(`/api/backend-feed`)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((body) => {
      setBackend({ ...body, loaded: true, unreachable: false });
    })
    .catch(() => {
      // The control plane failed, not a producer: say so.
      setBackend(emptyBackendFeed({ loaded: true, unreachable: true }));
    })
    .finally(() => {
      setBackendInFlight(false);
      setBackendAt(Date.now());
    });
}
