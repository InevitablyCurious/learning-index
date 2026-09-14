// ─────────────────────────────────────────────────────────────────────────────
// LIVE PANEL — HISTORICAL SELECTION + BACKEND REFRESH
//
// Opening a concluded baseline's frozen record, returning to the live cell, the
// auto-select that opens the last run when nothing is live, and the throttled
// fire-and-forget refresh of the polled backend feed. Every write to the shared
// state goes through a state.js setter — this module never rebinds an imported
// binding. Split from panels/live.js (LI-14) with no behaviour change.
// ─────────────────────────────────────────────────────────────────────────────

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
 * Open the newest concluded baseline when there is nothing live and nothing
 * chosen. Fire-and-forget: the board re-renders on its own 2s push, which is the
 * same shape `maybeRefreshBackend` and the ledger's stat strip use — render must
 * draw from what is known rather than block on a fetch.
 *
 * ONCE PER BENCH STATE, NOT ONCE PER RENDER. `autoTried` holds the key it last
 * attempted, so a failed read is not retried on every push, and an operator who
 * deliberately pressed BACK TO LIVE is not overridden a moment later by this.
 */
export function maybeAutoSelect(board) {
  if (hist) return;

  const live = board?.models_ledger?.run_in_flight === true
    // A live cell owns this card even before the ledger notices —
    // `cell_in_flight` comes straight off the feed and moves first.
    || board?.events?.cell_in_flight === true;
  if (live) {
    // A RUN CLEARS THE STAND-DOWN. "I pressed BACK TO LIVE" is a statement about
    // the record on screen at the time, not a permanent preference — so once a
    // cell has actually run, the next concluded one opens by itself again.
    setAutoSuppressed(false);
    setAutoTried(null);
    return;
  }
  if (autoSuppressed) return;

  const base = board?.control?.base_url;
  if (!base) return;

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
  void selectHistoricalRun(base, {
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

/**
 * Return the card to the live cell.
 *
 * The cached feeds go with it. A frozen record never changes, so re-selecting
 * re-reads it — one HTTP round trip against a paint that would otherwise have to
 * decide whether a cache entry is still the one being asked for.
 */
export function clearHistoricalRun() {
  setHist(null);
  // AND THE AUTO-SELECT STANDS DOWN. Without this, pressing BACK TO LIVE would
  // re-open the same record on the very next render — a control that undoes
  // itself, which is worse than one that does nothing. The suppression is
  // lifted when a cell actually runs (see maybeAutoSelect), so the next
  // concluded run opens by itself again.
  setAutoSuppressed(true);
}

/**
 * SELECT a concluded cell and read its record once. Never throws: a failed read
 * is recorded as data and rendered as the honest note, because the card must
 * draw from what is known rather than block the board on a fetch.
 *
 * Returns true when it actually read — the caller re-renders on true, and a
 * re-selection of what is already shown reports false and does nothing.
 */
export async function selectHistoricalRun(base, sel) {
  if (!base || !sel || typeof sel.run_dir !== "string" || !sel.run_dir) return false;
  if (!Number.isInteger(sel.sequence_index) || sel.sequence_index < 0) return false;
  if (hist && histKey(hist.sel) === histKey(sel)) return false;

  setHist({ sel: { ...sel }, loading: true, events: null, backend: null });
  const key = histKey(sel);
  const run = encodeURIComponent(sel.run_dir);
  const seq = sel.sequence_index;
  const [events, backendRes] = await Promise.all([
    histFetch(`${base}/api/events?run_dir=${run}&sequence_index=${seq}`),
    histFetch(`${base}/api/backend-feed?run_dir=${run}&sequence_index=${seq}`),
  ]);
  // The operator may have switched away or gone back to live while this was in
  // flight. Landing a stale read on top of their choice is how a card ends up
  // showing a run nobody asked for.
  if (!hist || histKey(hist.sel) !== key) return false;
  setHist({ ...hist, loading: false, events, backend: backendRes });
  return true;
}

/**
 * SELECT a cell whose record CANNOT be read, and say why on the card.
 *
 * Both feed reads go client-direct to the control plane's loopback address, so
 * a board opened from another device on the LAN cannot reach either — and the
 * caller knows that before it spends a round trip finding out. The selection is
 * still made, carrying the refusal, because the operator pressed a control and
 * an unexplained no-op is the defect this whole surface exists to remove.
 */
export function selectHistoricalRunUnreachable(sel, reason) {
  setHist({
    sel: { ...sel },
    loading: false,
    events: { ok: false, reason },
    backend: { ok: false, reason },
  });
}

// Raw fetch, the house pattern for browser panels: no control-plane module
// (that one is server-side). Every failure becomes data, never a throw.
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

/**
 * Fire-and-forget refresh, throttled, read on the NEXT render — the same shape
 * the ledger's stats strip uses, and for the same reason: the panel must draw
 * from what is already known rather than block the board on a fetch.
 */
export function maybeRefreshBackend(base) {
  if (!base || backendInFlight) return;
  const now = Date.now();
  if (backend.loaded && now - backendAt < BACKEND_MIN_INTERVAL_MS) return;
  setBackendInFlight(true);
  fetch(`${base}/api/backend-feed`)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((body) => {
      setBackend({ ...body, loaded: true, unreachable: false });
    })
    .catch(() => {
      // The CONTROL PLANE failed, not any one producer. Say that, rather than
      // rendering an empty feed that reads as a silent system.
      setBackend(emptyBackendFeed({ loaded: true, unreachable: true }));
    })
    .finally(() => {
      setBackendInFlight(false);
      setBackendAt(Date.now());
    });
}
