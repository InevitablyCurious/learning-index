// ─────────────────────────────────────────────────────────────────────────────
// LIVE PANEL — SHARED STATE (leaf module)
//
// Every module-level mutable binding the DATA FEED card carries, plus the three
// facet objects, the two pure envelope resolvers and the empty-envelope
// factories. This is the leaf the rest of the live panel imports: the entry
// (../live.js), backend.js, history.js and phases.js all READ these bindings and
// route EVERY write through the setters below — an ESM import binding is
// read-only to the importer, so a `let` declared here cannot be reassigned from
// another module. The facet objects are `const` and mutated IN PLACE (a Set add
// / a values.push), which crosses the module boundary fine because it is the
// same object, never a rebind.
//
// Split from panels/live.js (LI-14) with no behaviour change.
// ─────────────────────────────────────────────────────────────────────────────

import { createFacet } from "../facet.js";

// THE KINDS THIS FEED CAN CARRY, and therefore the chips it draws.
//
// `user` is the verbatim text the harness hands the model AS A USER TURN — the
// task chunk, the pass verdict, the failure feedback (WO-FEEDBACK-1). It is the
// single most consequential input the benchmarked model receives, so it gets its
// own chip rather than being folded in with harness plumbing.
//
// `harness` LEFT (2026-09-07). The four row types it named are what the HARNESS
// did, which is the backend feed; they were scraped from `PROGRESS step=…` log
// lines that carry no timestamp, so they rendered with a blank time column and
// could not be ordered. The same events are in the cell's `live.jsonl` WITH
// times. A chip whose count is structurally always 0 reads as "this never
// happens", so the chip went with the rows rather than being left to say
// nothing. This array is the seed vocabulary of `kindFacet` below, so it lives
// here rather than in the entry — the entry re-exports it.
export const EVENT_KINDS = ["tool", "file", "thinking", "error", "lifecycle", "user"];

/**
 * Filter state lives here, client-side, and survives the board's re-render.
 *
 * PICK WHAT YOU WANT TO SEE. This was seven booleans that all began `true`,
 * where a click REMOVED a kind — so "show me just the errors" cost six clicks
 * to exclude everything else and six more to undo. The work scaled with what
 * you did NOT want. See panels/facet.js for the model that replaced it: nothing
 * selected shows everything, one click shows one kind, several show their
 * union.
 */
export const kindFacet = createFacet(EVENT_KINDS);

/**
 * TWO FACETS, TWO AXES — and this is what resolves the collision that would
 * otherwise put two chips called "error" on one card.
 *
 * The EVENT feed filters by KIND, and one of its kinds is `error` — the AGENT
 * erring. This feed filters by SOURCE and, separately, by SEVERITY. So there is
 * no chip named `error` here at all: an operator narrowing to failures picks the
 * ERROR severity, which is a different control in a different row from the
 * agent's error kind. Two numbers with one name, disagreeing side by side on one
 * card, simply never arise.
 *
 * `values` are seeded from the closed native vocabulary and GROW to include any
 * external namespace the feed actually carries — see `backendChips`.
 */
export const sourceFacet = createFacet(["harness", "gates", "worker", "sequencer", "control"]);
export const levelFacet = createFacet(["info", "warn", "error"]);

// ── EVENT-FEED PAINT STATE ────────────────────────────────────────────────────
// The feed is painted OUT OF BAND, after the board's innerHTML swap, because it
// is append-only and stateful (see paintFeed in ../live.js).

export let renderedSeq = -1;
export let renderedSig = null;
export let unread = 0;

// Click-to-expand state: at most ONE row is open (its seq, null when none) and
// the current unfiltered event window, kept for the seq→event lookup on click.
// The expansion is painted by live.js itself — the feed box is data-preserve, so
// dom.js never patches its children, and a board-wide render() would reset the
// append-only watermark.
export let expandedSeq = null;
export let feedEvents = [];
export let expandBound = false;

// ── WHICH FEED IS SHOWN ───────────────────────────────────────────────────────
// ONE CARD, TWO TABS. Both boxes stay in the DOM and are toggled with `hidden`,
// so scroll position and append state survive a switch.
export let tab = "events";

// ── THE HISTORICAL SOURCE ───────────────────────────────────────────────────
//
// A concluded baseline's frozen record, read ONCE when it is selected. `null`
// means this card is showing the live cell, which is the default and the state
// a run start returns it to.
//
// The two feeds arrive in the SAME ENVELOPES the live path uses — the persisted
// `/api/events` branch answers the ring's own shape (control/server.mjs) and
// `/api/backend-feed` answers its own — so every renderer, filter and count
// reads one shape and never asks which source it came from.
export let hist = null;

// ONCE PER BENCH STATE, NOT ONCE PER RENDER. `autoTried` holds the key it last
// attempted, so a failed read is not retried on every push, and an operator who
// deliberately pressed BACK TO LIVE is not overridden a moment later by this.
export let autoTried = null;
export let autoSuppressed = false;
// Whether a cell was in flight at the LAST render — so the rising edge of a run
// can be told from the run merely continuing. `null` until the first render, so
// a board that loads mid-run does not read as a run that just started.
export let wasLive = null;

// ── BACKEND-FEED POLL STATE ───────────────────────────────────────────────────
export let backend = emptyBackendFeed();
export let backendAt = 0;
export let backendInFlight = false;

// ── BACKEND CLICK-TO-EXPAND STATE ─────────────────────────────────────────────
export let expandedBackend = null;
export let backendExpandBound = false;

// ── SETTERS — every write to the bindings above routes through one ────────────
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

// ── EMPTY-ENVELOPE FACTORIES ──────────────────────────────────────────────────
// The backend empty envelope was written out as a literal in four places (the
// initial `backend`, the unreachable refresh, the loading read and the failed
// historical read), differing only in `loaded` / `unreachable` / `hist_reason`.
// One factory, the differences passed as overrides, so the base shape has a
// single definition. The base carries NO `unreachable` key — its absence is
// load-bearing: `backendNote` reads `if (backend.unreachable)` and `paintBackend`
// reads `feed.unreachable === true`, both falsy when the key is absent.

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

/**
 * THE BACKEND ENVELOPE THIS CARD IS SHOWING — the polled live one, or the
 * frozen one read at selection. Resolved in ONE place so no renderer below
 * reads the module variable directly and quietly stays live while the rest of
 * the card went historical.
 */
export function backendFeed() {
  if (!hist) return backend;
  if (hist.loading) return emptyBackendFeed();
  if (hist.backend?.ok !== true) {
    return emptyBackendFeed({ loaded: true, unreachable: true, hist_reason: hist.backend?.reason ?? null });
  }
  return { ...hist.backend.data, loaded: true, unreachable: false };
}

/**
 * THE EVENT ENVELOPE THIS CARD IS SHOWING. Same rule as backendFeed().
 *
 * `connected` is REWRITTEN to true for a loaded historical read, and that is
 * not a lie about a socket — it is what the flag means to every reader below.
 * `paintFeed` treats `connected:false` as "the counts on screen are frozen and
 * may be stale", which is the correct thing to say about a live feed whose
 * stream dropped and the wrong thing to say about a record that is frozen BY
 * DEFINITION and complete. The persisted branch reports `connected:false,
 * reason:"persisted"` because it is honest about the ring; the card translates
 * that into its own vocabulary rather than rendering a concluded run under a
 * disconnection warning.
 */
export function eventFeed(board) {
  if (!hist) return board?.events ?? null;
  if (hist.loading) return null;
  if (hist.events?.ok !== true) return emptyEventFeed(hist.events?.reason ?? "the frozen record could not be read");
  return { ...hist.events.data, connected: true, reason: null };
}
