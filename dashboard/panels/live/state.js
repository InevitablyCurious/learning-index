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

// ── THE HISTORICAL SOURCE ── a concluded baseline's record, read once when
// selected; null = the live cell. Same envelopes as the live path.
export let hist = null;

// The key last auto-opened, so a failed read isn't retried every push and BACK
// TO LIVE isn't overridden.
export let autoTried = null;
export let autoSuppressed = false;
// Whether a cell was in flight last render (null before the first), to catch
// the start of a run.
export let wasLive = null;

// ── BACKEND-FEED POLL STATE ───────────────────────────────────────────────────
export let backend = emptyBackendFeed();
export let backendAt = 0;
export let backendInFlight = false;

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
export function setAutoTried(v) { autoTried = v; }
export function setAutoSuppressed(v) { autoSuppressed = v; }
export function setWasLive(v) { wasLive = v; }
export function setBackend(v) { backend = v; }
export function setBackendAt(v) { backendAt = v; }
export function setBackendInFlight(v) { backendInFlight = v; }
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

/** The event feed's empty envelope, for a frozen record that could not be read. */
export function emptyEventFeed(reason) {
  return { connected: false, reason, events: [], counts: {}, retained: 0, returned: 0, total: 0 };
}

// ── ENVELOPE RESOLVERS ────────────────────────────────────────────────────────

/** The backend envelope on show (live or frozen), resolved in one place. */
export function backendFeed() {
  if (!hist) return backend;
  if (hist.loading) return emptyBackendFeed();
  if (hist.backend?.ok !== true) {
    return emptyBackendFeed({ loaded: true, unreachable: true, hist_reason: hist.backend?.reason ?? null });
  }
  return { ...hist.backend.data, loaded: true, unreachable: false };
}

/**
 * The event envelope on show. A loaded historical read is reported as
 * connected: to every reader here, disconnected means "live counts may be
 * stale", which is wrong for a complete record.
 */
export function eventFeed(board) {
  if (!hist) return board?.events ?? null;
  if (hist.loading) return null;
  if (hist.events?.ok !== true) return emptyEventFeed(hist.events?.reason ?? "the frozen record could not be read");
  return { ...hist.events.data, connected: true, reason: null };
}
