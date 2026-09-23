// DATA FEED — shared state (a leaf module). Every mutable binding the card
// carries, the facets, the envelope resolvers and the empty-envelope factories.
// Other modules read these and write only through the setters below (an ESM
// import binding is read-only); facets are mutated in place.

import { createFacet } from "../facet.js";

// The kinds this feed carries, and so its chips. `user` is the verbatim text
// the harness sends the model as a user turn. `harness` was removed (those rows
// live in the backend feed, with timestamps).
export const EVENT_KINDS = ["tool", "file", "thinking", "error", "lifecycle", "user"];

/**
 * Kind filter, client-side (panels/facet.js: nothing selected shows everything,
 * one click shows one kind, several show their union).
 */
export const kindFacet = createFacet(EVENT_KINDS);

/**
 * The backend feed filters by source and, separately, by severity — so there
 * is never a second chip named "error" beside the agent's error kind. Values grow
 * to include any external namespace that appears.
 */
export const sourceFacet = createFacet(["harness", "gates", "worker", "sequencer", "control"]);
export const levelFacet = createFacet(["info", "warn", "error"]);

// ── EVENT-FEED PAINT STATE ── painted out of band (see paintFeed).

export let renderedSeq = -1;
export let renderedSig = null;
export let unread = 0;

// At most one row open (its seq), plus the current window for lookups. The
// feed box is data-preserve, so live.js paints the expansion itself.
export let expandedSeq = null;
export let feedEvents = [];
export let expandBound = false;

// ── WHICH FEED ── two tabs, both boxes kept in the DOM (toggled with hidden).
export let tab = "events";

// ── THE CELL ON SHOW ── the record of the cell the strip points at (see
// history.js), re-read while it runs; null = no cell to show.
export let hist = null;

// ── BACKEND CLICK-TO-EXPAND STATE ─────────────────────────────────────────────
export let expandedBackend = null;
export let backendExpandBound = false;

// ── SETTERS ── every write to the bindings above goes through one.
export function setRenderedSeq(v) { renderedSeq = v; }
export function setRenderedSig(v) { renderedSig = v; }
export function setUnread(v) { unread = v; }
export function setExpandedSeq(v) { expandedSeq = v; }
export function setFeedEvents(v) { feedEvents = v; }
export function setExpandBound(v) { expandBound = v; }
export function setTab(v) { tab = v; }
export function setHist(v) { hist = v; }
export function setExpandedBackend(v) { expandedBackend = v; }
export function setBackendExpandBound(v) { backendExpandBound = v; }

// ── EMPTY-ENVELOPE FACTORIES ── one base shape with per-case overrides. The
// base has no `unreachable` key on purpose (readers test it as falsy).

/** The backend feed's empty envelope. `over` carries the per-case differences. */
export function emptyBackendFeed(over = {}) {
  return {
    rows: [], errors: [], errors_total: 0, total: 0, returned: 0,
    sources: null, windowed: false, loaded: false, ...over,
  };
}

/** The event feed's empty envelope, for a record that could not be read. */
export function emptyEventFeed(reason) {
  return { connected: false, reason, events: [], counts: {}, retained: 0, returned: 0, total: 0 };
}

// ── ENVELOPE RESOLVERS ────────────────────────────────────────────────────────

/** The backend envelope of the cell on show, resolved in one place. */
export function backendFeed() {
  if (!hist) return emptyBackendFeed({ loaded: true });
  if (hist.loading) return emptyBackendFeed();
  if (hist.backend?.ok !== true) {
    return emptyBackendFeed({ loaded: true, unreachable: true, hist_reason: hist.backend?.reason ?? null });
  }
  return { ...hist.backend.data, loaded: true, unreachable: false };
}

/**
 * The event envelope of the cell on show. A running cell carries the control
 * plane's event-subscription state (disconnected = its rows may be stale); an
 * ended cell's record is complete, so it is never called disconnected.
 * `cell_in_flight` is this cell's, not the bench's.
 */
export function eventFeed(board) {
  if (!hist) return { ...emptyEventFeed(null), cell_in_flight: false };
  if (hist.loading) return null;
  if (hist.events?.ok !== true) return emptyEventFeed(hist.events?.reason ?? "the cell's record could not be read");
  const running = hist.sel.running === true;
  return {
    ...hist.events.data,
    connected: running ? board?.events?.connected === true : true,
    reason: running ? (board?.events?.reason ?? null) : null,
    cell_in_flight: running,
  };
}
