// ─────────────────────────────────────────────────────────────────────────────
// PANEL: DATA FEED — the running cell, or a concluded one, in the same surface
//
// ── ONE FEED SURFACE, TWO SOURCES ───────────────────────────────────────────
//
// This card was LIVE RUN and read one source: the cell in flight. It now reads
// EITHER that or a concluded baseline's frozen record, chosen from the BASELINES
// card, and it is the same card either way — same tabs, same filter chips, same
// row renderers, same scroll.
//
// A SECOND SURFACE WAS BUILT FIRST AND WAS THE WRONG ANSWER. The concluded-run
// feeds originally rendered as their own stacked sections inside the baseline
// drawer, reusing this file's row renderers. Same rows, but a reader arriving at
// them had no kind chips, no source/severity facets, no tabs and no jump pill —
// so the surface for reading four thousand rows was the one WITHOUT the tools
// for reading four thousand rows. Reusing a renderer is not reusing a surface.
//
// THE SELECTION IS EXCLUSIVE WITH A LIVE CELL, and the exclusion is enforced
// where the selection is offered (panels/ledger.js): while a cell is in flight
// this card belongs to it, and a historical selection cannot be made. A run
// starting under an open historical selection clears it — the live cell outranks
// a record, and a card silently showing yesterday while today is running is the
// exact defect this whole board exists to prevent.
//
// Two columns: the PHASE SPINE and the EVENT FEED.
//
// ── THE SPINE IS 5 PHASES, NOT 6 ────────────────────────────────────────────
// A cell is BUILD (`initial`) → 4 GRADEs (`verdict-pass-1` … `verdict-pass-4`),
// one per check+fix attempt (max_attempts = 5). The six work orders are
// SUB-TICKS INSIDE PHASE 1 and are rendered only there. Showing "6 phases"
// (an earlier misreading) makes a cell in phase 2 look 1/6 done when it is
// 2/5 done.
//
// ── FEED BEHAVIOURS ARE PRESERVED VERBATIM ──────────────────────────────────
// These were built and verified against a live 45s capture and are NOT
// re-derived here — they are carried over intact, and every one of them exists
// because its absence was a real observed defect:
//   · oldest-first, constant 34px row height
//   · per-kind filter chips with live counts, all ON by default
//   · render cap 400, trimmed from the TOP with scroll compensation
//   · sticky-bottom with BOTTOM_EPS=24 tolerance (exact equality drops the
//     operator out of follow mode on fractional scroll heights)
//   · "N new ↓" pill when detached — announces without stealing the viewport
//   · append past a seq watermark, never innerHTML rebuild (a rebuild resets
//     scrollTop every poll and makes "new" undetectable)
//   · one-shot flash on background + inset left rule ONLY — never height,
//     margin or transform, which would reflow the list under the eye
//   · prefers-reduced-motion → static rule, no animation
//
// PROVISIONAL COUNTERS. A running cell's totals are marked provisional and
// suffixed ›. Presenting a mid-flight total as final is the same lie as
// presenting a partial delta as a result.
//
// ── MODULE LAYOUT (LI-14) ───────────────────────────────────────────────────
// This file is the THIN ENTRY: the card's render + the event/backend row
// painters and click bindings, which are the source-scrape anchors the test
// suite pins. The shared mutable state, the phase spine + provisional counters,
// the historical-selection logic and the backend-feed helpers live in
// ./live/{state,phases,history,backend}.js. The entry re-exports the full
// 31-symbol public surface, so every consumer (board.js, wall.js, ledger.js)
// still imports from panels/live.js. Dependency direction is one-way — entry,
// backend, history and phases all import state; nothing imports this entry back.
// ─────────────────────────────────────────────────────────────────────────────

import { esc, nul } from "../board.js";
import {
  toggleFacet,
  clearFacet,
  facetAccepts,
  facetActive,
  facetState,
  facetSignature,
  facetPicked,
} from "./facet.js";
import {
  EVENT_KINDS,
  kindFacet,
  sourceFacet,
  levelFacet,
  renderedSeq,
  setRenderedSeq,
  renderedSig,
  setRenderedSig,
  unread,
  setUnread,
  expandedSeq,
  setExpandedSeq,
  feedEvents,
  setFeedEvents,
  expandBound,
  setExpandBound,
  tab,
  hist,
  setHist,
  wasLive,
  setWasLive,
  expandedBackend,
  setExpandedBackend,
  backendExpandBound,
  setBackendExpandBound,
  eventFeed,
  backendFeed,
} from "./live/state.js";
import { maybeAutoSelect, maybeRefreshBackend, histKey } from "./live/history.js";
import {
  backendHead,
  feedTabs,
  backendRows,
  groupKeyOf,
  gateSummary,
  mergeBackendRows,
  condenseBackend,
} from "./live/backend.js";

// ── THE PUBLIC SURFACE — all 31 symbols resolve from this entry ──────────────
// Defined-here symbols are exported inline below; symbols that moved to a
// submodule are re-exported EXPLICITLY (never `export *`), so the entry stays
// the one import path every consumer knows.
export { EVENT_KINDS };
export { phaseIndex, chunkOf, spine, provisional } from "./live/phases.js";
export {
  resetAutoSelect,
  historicalSelection,
  clearHistoricalRun,
  selectHistoricalRun,
  selectHistoricalRunUnreachable,
} from "./live/history.js";
export {
  setFeedTab,
  toggleBackendSource,
  toggleBackendLevel,
  clearBackendFilters,
} from "./live/backend.js";
export { mergeBackendRows, condenseBackend };

export const EVENT_RENDER_CAP = 400;
export const BOTTOM_EPS = 24;

// The per-kind glyph marks. `harness: "▣"` is a STALE KEY — the harness kind
// left EVENT_KINDS (2026-09-07, see ./live/state.js), so no row carries it and
// this mark is never hit. Left in place rather than purged: it is not proven
// dead (a producer could still emit kind:"harness"), and evRow's `?? "·"`
// fallback would catch such a row anyway. Noted, not removed.
const KIND_MARK = { tool: "$", file: "~", thinking: "·", error: "!", lifecycle: "◦", user: ">", harness: "▣" };

/**
 * Filter state lives in ./live/state.js (kindFacet) and survives the board's
 * re-render. PICK WHAT YOU WANT TO SEE — see panels/facet.js for the model:
 * nothing selected shows everything, one click shows one kind, several show
 * their union.
 */
export function toggleKind(k) {
  toggleFacet(kindFacet, k);
}

export function clearKinds() {
  clearFacet(kindFacet);
}

/**
 * THIS CARD IS NOW THE EVENT FEED, FULL WIDTH.
 *
 * It used to be a 340px spine column beside the feed. Both of the things that
 * column held — the phase spine and the provisional counters — moved to the
 * gate wall, where they sit side by side under the gates those phases produce
 * and at the cost those counters report. Leaving the empty column behind would
 * have been 340px of card holding a heading, which is the defect this whole
 * rearrangement set out to remove rather than relocate.
 */
export function renderLive(board) {
  const r = board.run ?? {};
  // A RUN STARTING TAKES THE CARD BACK. The live cell outranks a record: a card
  // silently showing yesterday's transcript while today's cell is burning hours
  // is the exact failure this board exists to prevent, and it is the failure an
  // operator is LEAST likely to catch, because a frozen feed and a quiet live
  // one look identical. Read from the same flag the selector gates on
  // (control/models-ledger.mjs `run_in_flight`) so the two cannot disagree about
  // whether a cell is in flight.
  // ── A RUN *STARTING* TAKES THE CARD BACK — the EDGE, not the state ───────
  //
  // This read `if (hist && run_in_flight) hist = null` on every render, which
  // made a historical selection impossible to hold WHILE a cell ran: click an
  // old baseline mid-run and the next 2s render wiped it. That is the same
  // "fleeting and inconsistent" failure the toggling [feed] button caused,
  // wearing different clothes.
  //
  // The operator asked for the row to work "whether it's old or running now", so
  // an old record stays selected during a live run and BACK TO LIVE returns. Only
  // the TRANSITION into a run reclaims the card, because that is the moment
  // something new is worth watching.
  const nowLive = board?.models_ledger?.run_in_flight === true;
  if (hist && nowLive && wasLive === false) setHist(null);
  setWasLive(nowLive);
  // ── NOTHING LIVE? THEN SHOW THE LAST THING THAT RAN ──────────────────────
  //
  // With no cell in flight this card had nothing to draw and said so, pointing
  // at the [feed] control on the BASELINES row. That is a correct sentence and a
  // dead end: the bench's resting state is "one concluded run and nothing
  // happening", so the default view was an empty box explaining where the data
  // it could have shown lives.
  //
  // The record opens by itself instead. Still explicitly marked CONCLUDED, still
  // switchable from any other row, still dropped the moment a run starts — the
  // selection is exactly the one [feed] would have made, made without requiring
  // the operator to ask for the only thing there is to see.
  maybeAutoSelect(board);
  maybeRefreshBackend();

  return `
    <section class="panel live">
      <div class="phead">
        <span class="ttl">DATA FEED</span>
        <span class="sub">${hist ? histLabel() : cellLabel(r)}</span>
        <span class="spacer"></span>
        ${hist ? `<button class="btn sm" data-feed-live="1">← BACK TO LIVE</button>` : ""}
      </div>
      <div class="live-feed">
        ${tab === "backend" ? backendHead() : feedHead(board)}
        <div class="feed-copy"><button class="chip fexport" data-feed-copy="1">COPY RAW ${tab === "backend" ? "BACKEND" : "EVENTS"} (JSONL)</button><span class="note" id="feed-copy-note"></span></div>
        <div class="evbox" id="sc-events" data-preserve="1"${tab === "backend" ? ' hidden' : ""}></div>
        <div class="evbox" id="sc-backend" data-preserve="1"${tab === "backend" ? "" : ' hidden'}></div>
      </div>
    </section>`;
}

/**
 * WHICH CELL IS ON SCREEN — and only when one actually is.
 *
 * `board.run` describes the newest cell on disk whether or not it is running, so
 * a finished run left this printing `qwen3-…-0000 · OFF` under a card labelled
 * live. Paired with the live feed serving that same finished run's prompts, the
 * card presented a concluded run as the live session — and read, correctly, as a
 * historical feed that had lost its rows.
 */
function cellLabel(r) {
  if (r?.state && r.state !== "running") return nul("no cell running");
  if (!r?.arm && !r?.cell_label) return nul("no run observed");
  const seq = r.cell_label ? esc(r.cell_label) : "cell";
  const arm = r.arm ? esc(r.arm.toUpperCase()) : nul("arm unobserved");
  return `${seq} · ${arm}`;
}

/**
 * WHICH RECORD IS ON SCREEN, and that it is a record.
 *
 * "CONCLUDED" is stated on the card rather than left to the operator to infer
 * from a quiet feed. A frozen transcript and a live cell that has gone silent
 * look identical in the rows, and that is precisely the confusion this card
 * would otherwise introduce by being able to show both.
 */
function histLabel() {
  const sel = hist.sel;
  const who = sel.label ? esc(sel.label) : esc(`${sel.run_dir} · cell ${sel.sequence_index}`);
  return `${who} · <span class="feed-frozen">CONCLUDED — READ ONCE</span>`;
}

// ── EVENT FEED ──────────────────────────────────────────────────────────────

function feedHead(board) {
  const ev = eventFeed(board);
  const counts = ev?.counts ?? {};
  const chips = EVENT_KINDS.map((k) => {
    const n = counts[k] ?? 0;
    // THE ERROR HUE OUTRANKS THE FILTER STATE, unchanged: a non-zero error count
    // is the one thing an operator must not be able to overlook, so it keeps the
    // danger treatment whatever this chip's selection state is.
    return `<button class="chip fchip ${facetState(kindFacet, k)} ${k === "error" && n > 0 ? "err" : ""}" data-kind="${k}">${KIND_MARK[k]} ${k} ${n}</button>`;
  }).join("");

  // A FILTER MUST ANNOUNCE ITSELF AND BE ESCAPABLE IN ONE ACTION. Without this
  // a narrowed feed is indistinguishable from a quiet one, and the way out is to
  // remember which chips you pressed.
  const clear = facetActive(kindFacet)
    ? `<button class="chip fclear" data-clearkinds="1">CLEAR</button>`
    : "";

  return `
    <div class="feed-head">
      ${feedTabs()}
      ${chips}
      ${clear}
      <span class="spacer"></span>
      <span class="note">${esc(feedNote(ev))}</span>
      <button class="pill" id="evjump" style="display:none"></button>
    </div>`;
}

/**
 * `capped` and `windowed` are DIFFERENT facts and are never collapsed:
 * windowed means "more exist, ask for them"; capped means events were DROPPED
 * and are gone. Only the second is data loss.
 */
function feedNote(ev) {
  if (!ev) return hist ? "reading the record…" : "oldest first · cap 400 · sticky bottom";
  const bits = [];
  // A HISTORICAL READ IS NOT CAPPED AND IS NOT A RING. "cap 400" describes the
  // live path's server-side window (EVENT_RENDER_CAP), which the persisted read
  // does not apply — it answers with the cell's whole transcript. Printing the
  // live sentence over it claimed a cap of 400 above 4,312 rows, which is a
  // false statement about the data on screen and exactly the class of claim this
  // feed exists to avoid making.
  if (hist) {
    bits.push(`${ev.returned ?? (ev.events ?? []).length} events · complete record`);
    if (ev.unmapped) bits.push(`${ev.unmapped} unmapped`);
    bits.push("oldest first · read once");
    return bits.join(" · ");
  }
  // AN IDLE FEED HAS NO WINDOW TO DESCRIBE. "cap 400" over an empty box on a
  // bench that is not running anything states a limit that is doing nothing.
  if (ev.cell_in_flight === false && !(ev.events ?? []).length) return "nothing running";
  if (ev.capped) bits.push(`ring full — oldest dropped (${ev.total} seen)`);
  else if (ev.returned < ev.retained) bits.push(`showing ${ev.returned} of ${ev.retained}`);
  // A high unmapped count is CORRECT, not a defect: message.part.delta is ~99%
  // of traffic (one frame per token) and is deliberately dropped.
  if (ev.unmapped) bits.push(`${ev.unmapped} unmapped`);
  bits.push("oldest first · cap 400");
  return bits.join(" · ");
}

// The feed is painted OUT OF BAND, after the board's innerHTML swap, because it
// is append-only and stateful. See paintFeed() below.

/**
 * WHAT WOULD MAKE THE PAINTED LIST WRONG TO APPEND TO.
 *
 * `paintFeed` is append-only past a seq watermark — a rebuild every poll would
 * reset scrollTop and make "new" undetectable — so it needs one value that
 * changes whenever the rows on screen stop being a prefix of the rows it is
 * about to draw.
 *
 * THE SOURCE IS PART OF IT. Without the source key, switching from one frozen
 * record to another can silently APPEND the second onto the first: both are
 * numbered from their own session, so if the incoming record's seqs happen to
 * run above what is already painted, neither the wrapped check (a FORWARD gap)
 * nor the rebased check (seqs going BACKWARD) fires, and the card shows two runs
 * spliced into one list with nothing on screen saying so.
 */
function sigOf(ev) {
  return JSON.stringify([
    facetSignature(kindFacet),
    ev?.connected ?? null,
    ev?.reason ?? null,
    hist ? histKey(hist.sel) : "live",
  ]);
}

export function paintFeed(board) {
  const box = document.getElementById("sc-events");
  if (!box) return;
  ensureExpandBound();
  const ev = eventFeed(board);
  setFeedEvents(ev ? (ev.events ?? []) : []);
  const sig = sigOf(ev);

  if (!ev) {
    box.innerHTML = padNote("control plane not enabled — the event feed is opt-in and currently off.");
    setRenderedSeq(-1); setRenderedSig(sig);
    return;
  }
  // ── A DEAD STREAM IS A FACT ABOUT THE UPSTREAM, NOT ABOUT THE ROWS ──────
  //
  // This used to RETURN here, replacing whatever the feed held with a notice.
  // On an idle bench that is exactly wrong: the agent stream is unreachable
  // because no cell is running, but the prompts are rebuilt from files and
  // admitted anyway — so the `user` chip counted 10 rows and the box beneath it
  // said "disconnected" and drew none of them. A chip that counts rows the box
  // refuses to render is the surface contradicting itself.
  //
  // The disconnection is still stated, as a BANNER ABOVE the rows. It is
  // rendered by the same fall-through below, so there is one path that draws
  // rows and one place that decides whether a warning rides above them.
  // ── AN IDLE BENCH IS NOT A FAULT ────────────────────────────────────────
  //
  // `connected:false` is equally true when a run has crashed and when nothing is
  // running at all, and those want opposite words on screen: one is a failure to
  // chase, the other is the normal resting state of a bench between runs. The
  // server says which (`cell_in_flight`), so the card stops reporting "event
  // feed disconnected: fetch failed" over a bench that is simply waiting.
  const idle = ev.cell_in_flight === false;
  const disconnected = !ev.connected && !idle;
  // MARKED, because `stale` below treats any `.null` in the box as "this is
  // showing a note, rebuild". The banner is a permanent fixture while the stream
  // is down, so an unmarked one would force a full innerHTML rebuild on every
  // 2s poll — resetting scrollTop and destroying the append watermark that makes
  // "new" detectable.
  const banner = disconnected
    ? `<div class="null pad danger feed-banner">${esc(`event feed disconnected — ${ev.reason ?? "no reason given"}. Counts above are frozen at the last event and may be stale.`)}</div>`
    : "";

  const rows = (ev.events ?? []).filter((e) => facetAccepts(kindFacet, e.kind));
  if (!rows.length) {
    box.innerHTML = banner + padNote(
      // NAME THE FILTER THAT EMPTIED IT. "Hidden by the active filters" left the
      // operator to work out which ones, on the surface where a narrowed feed and
      // a silent one look the same.
      ev.retained && facetActive(kindFacet)
        ? `no ${facetPicked(kindFacet).join(" or ")} events among the ${ev.retained} retained — press CLEAR to see the rest.`
        : ev.retained
          ? "every retained event is hidden by the active filters."
          : idle
            // THE STATE THE OPERATOR IS ACTUALLY IN, and what to do about it.
            // This card printed "disconnected — fetch failed" here over an idle
            // bench, which reads as a broken feed rather than an empty one — and
            // it named the last CONCLUDED cell in its own subtitle while doing
            // so, so it looked precisely like a historical read returning
            // nothing. It is not: that record is reachable, by selecting it.
            ? "no cell is running, and this bench holds no concluded record to open. Start a baseline from BASELINES."
            : disconnected
              // NOT "connected, no events yet" — that sentence over a dead
              // stream claims a connection the banner above has just denied.
              ? "no events were retained before the stream dropped."
              : "connected, no events yet — nothing has happened in the session.",
    );
    setRenderedSeq(-1); setRenderedSig(sig);
    return;
  }

  // Measure BEFORE touching the DOM — scrollHeight changes on append.
  const atBottom = isAtBottom(box);
  const wrapped = rows[0].seq > renderedSeq + 1 && renderedSeq !== -1;
  // THE RING RE-BASED. seq is monotonic within one control-plane process, so the
  // window's highest seq can only fall BELOW what this feed already rendered
  // when the process restarted and re-admitted rows at low seq values. That is
  // the inverse of `wrapped` (a FORWARD gap): the rows on screen belong to a
  // dead ring and must be replaced, not appended to.
  const rebased = renderedSeq !== -1 && rows.length > 0 && (rows[rows.length - 1].seq ?? -1) < renderedSeq;
  // `.null:not(.feed-banner)` — an empty-state note means the box holds no rows
  // and must be rebuilt now that there are some. The disconnection banner is not
  // that: it sits ABOVE real rows and stays put, so counting it here would
  // rebuild on every poll for as long as the stream is down.
  const stale = sig !== renderedSig || wrapped || rebased || box.querySelector(".null:not(.feed-banner)");

  if (stale) {
    box.innerHTML = banner + rows.map((e) => evRow(e, false)).join("");
    setRenderedSeq(rows[rows.length - 1].seq ?? -1);
    setRenderedSig(sig);
    box.scrollTop = box.scrollHeight;
    return;
  }

  const fresh = rows.filter((e) => (e.seq ?? -1) > renderedSeq);
  if (!fresh.length) return;

  const prevTop = box.scrollTop;
  box.insertAdjacentHTML("beforeend", fresh.map((e) => evRow(e, true)).join(""));
  setRenderedSeq(fresh[fresh.length - 1].seq ?? renderedSeq);

  // Trim from the TOP to the cap, compensating scroll by the exact height
  // removed — otherwise the list jumps every time the cap is hit.
  const over = box.children.length - EVENT_RENDER_CAP;
  let trimmed = 0;
  if (over > 0) {
    for (let i = 0; i < over; i += 1) {
      const first = box.firstElementChild;
      if (!first) break;
      trimmed += first.getBoundingClientRect().height;
      first.remove();
    }
  }

  if (atBottom) box.scrollTop = box.scrollHeight;
  else box.scrollTop = prevTop - trimmed;

  markUnread(fresh.length, atBottom);
}

function isAtBottom(node) {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_EPS;
}

function markUnread(n, atBottom) {
  setUnread(atBottom ? 0 : unread + n);
  const pill = document.getElementById("evjump");
  if (!pill) return;
  if (unread > 0) {
    pill.textContent = `${unread} new ↓`;
    pill.style.display = "";
  } else {
    pill.style.display = "none";
  }
}

export function jumpToLive() {
  const box = document.getElementById("sc-events");
  if (!box) return;
  setUnread(0);
  box.scrollTop = box.scrollHeight;
  const pill = document.getElementById("evjump");
  if (pill) pill.style.display = "none";
}

// The expanded body of a row: the captured text, honestly labelled. Full text
// flows to the feed by default, so "verbatim" is the normal claim — still made
// ONLY when nothing was cut. The truncated branch is the rare safety-guard case
// (a pathological >64KB payload): it says so, names the surviving length, and
// points at /api/feedback where the full text lives. Pure; exported for tests.
export function evBody(e) {
  const hasText = typeof e.text === "string" && e.text.length > 0;
  const label = hasText
    ? (e.truncated
        ? `<span class="evlbl">truncated — showing first ${e.text.length} chars · full text via /api/feedback</span>`
        : `<span class="evlbl">verbatim — exactly what the model was sent</span>`)
    : `<span class="evlbl">no captured text for this event</span>`;
  const body = hasText ? `<pre class="evtext">${esc(e.text)}</pre>` : "";
  return `<div class="evbody">${label}${body}</div>`;
}

// The compact one-line row, unchanged; `open` (default: the module state) adds
// the `open` class and appends evBody() after the four spans. BOTH paintFeed
// paths (append and stale-rebuild) render through here, so a rebuild
// reproduces the expansion instead of silently collapsing it.
export function evRow(e, isNew, open) {
  const expanded = open === undefined ? e.seq === expandedSeq : open;
  const t = e.at ? new Date(e.at).toLocaleTimeString("en-GB", { hour12: false }) : "";
  return `
    <div class="evrow ${esc(e.kind)}${isNew ? " fresh" : ""}${expanded ? " open" : ""}" data-seq="${esc(String(e.seq ?? ""))}" role="button" tabindex="0" aria-expanded="${expanded}">
      <span class="evt">${esc(t)}</span>
      <span class="evmark">${KIND_MARK[e.kind] ?? "·"}</span>
      <span class="evname">${esc(e.name ?? "")}</span>
      <span class="evdetail ${e.kind === "file" ? "evpath" : ""}">${esc(e.detail ?? "")}</span>
      ${expanded ? evBody(e) : ""}
    </div>`;
}

// Click-to-expand, DELEGATED on the feed box and bound lazily ONCE — the box
// survives every rebuild, per-row listeners would not, and re-binding on each
// append would stack listeners. Only the affected rows are repainted in place
// via outerHTML; the append-only watermark, scrollTop and every other row are
// untouched, so expand/collapse never disturbs scroll. No animation: the feed
// contract forbids height/margin/transform motion (see index.html).
function rerenderRow(seq) {
  const node = document.querySelector(`#sc-events .evrow[data-seq="${seq}"]`);
  const e = feedEvents.find((r) => r.seq === seq);
  if (node && e) node.outerHTML = evRow(e, false);
}
function ensureExpandBound() {
  if (expandBound) return;
  const box = document.getElementById("sc-events");
  if (!box) return;
  setExpandBound(true);
  box.addEventListener("click", (evt) => {
    const row = evt.target && evt.target.closest ? evt.target.closest(".evrow") : null;
    if (!row) return;
    const seq = Number(row.dataset.seq);
    if (!Number.isFinite(seq)) return;
    const prev = expandedSeq;
    setExpandedSeq(prev === seq ? null : seq);
    if (prev !== null && prev !== seq) rerenderRow(prev);
    rerenderRow(seq);
  });
}

/**
 * CLICK-TO-EXPAND on the backend feed, the same affordance the event feed has.
 * Bound once, delegated, and identical in behaviour: one row open at a time.
 * Kept in the entry beside its twin `ensureExpandBound` because its handler
 * repaints via `paintBackend` (an entry anchor) — moving it to backend.js would
 * make backend.js import the entry, a cycle the split forbids.
 */
function ensureBackendExpandBound() {
  if (backendExpandBound) return;
  const box = document.getElementById("sc-backend");
  if (!box) return;
  setBackendExpandBound(true);
  box.addEventListener("click", (evt) => {
    const row = evt.target && evt.target.closest ? evt.target.closest(".bkrow") : null;
    if (!row) return;
    const key = row.dataset.bkey;
    if (!key) return;
    setExpandedBackend(expandedBackend === key ? null : key);
    paintBackend();
  });
}

/**
 * THE WHOLE RECORD SET, UNFILTERED, ON THE CLIPBOARD.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * The board is being read in the "is the benchmark even working" phase, where
 * the red flags have not been named yet. A surface that only ever shows what
 * somebody already decided was interesting cannot answer a question nobody has
 * formulated. So every record is reachable AS DATA — one paste into whatever
 * the operator wants to reason with.
 *
 * UNFILTERED AND UNCONDENSED, DELIBERATELY. The chips and the fold are reading
 * aids; an export that inherited them would quietly ship a subset shaped by a
 * view state the recipient cannot see. What comes out is what the run produced.
 *
 * JSONL because that is what the producers wrote (`live.jsonl`,
 * `agent-events.jsonl`) — round-tripping the board's own render back into an
 * object shape nothing else uses would make the export a third format.
 */
export function feedExportText(board) {
  const rows = tab === "backend"
    ? mergeBackendRows(backendFeed())
    : ((eventFeed(board)?.events) ?? []);
  return rows.map((r) => JSON.stringify(r)).join("\n");
}

/** What the export is OF — stated on the confirmation so a paste is traceable. */
export function feedExportLabel(board) {
  const what = tab === "backend" ? "backend records" : "events";
  const n = tab === "backend"
    ? mergeBackendRows(backendFeed()).length
    : ((eventFeed(board)?.events) ?? []).length;
  const src = hist ? `${hist.sel.label ?? hist.sel.run_dir} · cell ${hist.sel.sequence_index}` : "live cell";
  return `${n} ${what} · ${src}`;
}

export function padNote(text, bad = false) {
  return `<div class="null pad ${bad ? "danger" : ""}">${esc(text)}</div>`;
}

export function paintBackend() {
  const box = document.getElementById("sc-backend");
  if (!box) return;
  ensureBackendExpandBound();

  const rows = backendRows().filter(
    (r) => facetAccepts(sourceFacet, r.source) && facetAccepts(levelFacet, r.level),
  );

  if (!rows.length) {
    const feed = backendFeed();
    const dead = feed.unreachable === true;
    box.innerHTML = padNote(
      dead
        ? (feed.hist_reason
            ? `the frozen record could not be read — ${feed.hist_reason}`
            : "control plane unreachable — nothing can be read.")
        : !feed.loaded
          ? "reading…"
          : feed.total > 0
            ? "no records match the picked filters — press CLEAR to see the rest."
            : hist
              ? "this cell wrote no backend records."
              : "no backend records yet. Processes write these as they work; an idle bench has none.",
      dead,
    );
    return;
  }

  // REBUILT, NOT APPENDED — deliberately unlike the event feed. That feed is a
  // token-rate stream where an innerHTML rebuild every poll would reset
  // scrollTop and make "new" undetectable. This one is a 2s poll over at most a
  // few hundred whole records, and its rows can be RE-FILTERED at any moment by
  // a chip, which an append-only watermark cannot express.
  //
  // CONDENSED AFTER FILTERING, NOT BEFORE. The chips select over the RAW record
  // set — an operator narrowing to `gates` or to `error` is asking about
  // records, not about groups — and the fold is applied to whatever survives.
  // Folding first would hide a gate result from its own filter.
  //
  // SCROLL IS PRESERVED ACROSS THE REBUILD. Expanding a row rebuilds this box,
  // and without this the list jumps to the top on every click — which on a
  // 600-row feed means the row you just opened is gone from view.
  const at = box.scrollTop;
  box.innerHTML = condenseBackend(rows)
    .map((g) => {
      const key = groupKeyOf(g);
      return bRow(g.row ?? g.children[0], {
        children: g.children,
        open: expandedBackend === key,
        groupKey: key,
      });
    })
    .join("");
  box.scrollTop = at;
}

/**
 * ONE BACKEND ROW. `children` renders a count and an expand affordance; the
 * children themselves are painted only when the row is open.
 *
 * EVERY ROW EXPANDS, not just the folded ones. The operator does not yet know
 * which fields will turn out to matter — that is the whole reason this feed is
 * being read — so the full record is one click away on every row rather than on
 * the ones somebody guessed would be interesting.
 */
export function bRow(r, opts = {}) {
  const { children = [], open = false, groupKey = null } = opts;
  const t = r?.ts ? new Date(r.ts).toLocaleTimeString("en-GB", { hour12: false }) : "";
  // The event name for a notice; the record's own kind otherwise — a
  // `gate.result` has no event name and inventing one would be prose.
  const label = r?.event ?? r?.kind ?? "";
  const detail =
    r?.detail && typeof r.detail === "object"
      ? Object.entries(r.detail)
          .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
          .join(" ")
      : "";
  const fold = children.length
    ? `<span class="bkfold">${esc(`${open ? "▾" : "▸"} ${gateSummary(children)}`)}</span>`
    : "";
  // SEVERITY TRAVELS AS DATA, NOT AS A COMPOSED CLASS NAME. A class built by
  // interpolation cannot be checked against the stylesheet — the coverage test
  // sees only the literal prefix — so a rule could go missing and the row would
  // render silently with no geometry. As an attribute it is one literal class
  // and a selector that is verifiable on both sides.
  // A WIDER SECOND COLUMN, BECAUSE THIS ONE HOLDS A WORD. The event feed's
  // `.evmark` is 22px — it carries a single glyph (`$`, `~`, `·`). A source name
  // is `harness`, `sequencer`, or a backend's whole namespace, so in that column
  // it overflowed and printed on top of the event name. `bkrow` keeps every other
  // row behaviour and only re-columns the grid.
  return `<div class="evrow bkrow${open ? " open" : ""}" data-level="${esc(r?.level ?? "info")}" data-bkey="${esc(groupKey ?? "")}" role="button" tabindex="0" aria-expanded="${open ? "true" : "false"}">
      <span class="evt">${esc(t)}</span>
      <span class="evmark">${esc(r?.source ?? "")}</span>
      <span class="evname">${esc(label)}</span>
      <span class="evdetail">${esc(detail)}${fold}</span>
      ${open ? bBody(r, children) : ""}
    </div>`;
}

/**
 * THE EXPANDED BODY — the record verbatim, then any folded children.
 *
 * The whole record as JSON, not a curated subset. The operator is looking for
 * red flags nobody has named yet, so a field this renderer decided was
 * uninteresting is exactly the one that would be missing when it mattered.
 */
export function bBody(r, children = []) {
  const rec = r ? `<pre class="evtext">${esc(JSON.stringify(r, null, 2))}</pre>` : "";
  if (!children.length) return `<div class="evbody"><span class="evlbl">the record, verbatim</span>${rec}</div>`;
  const kids = children.map((c) => {
    const st = c?.detail?.status ?? "?";
    const id = c?.detail?.id ?? "(unnamed gate)";
    const ms = c?.detail?.duration_ms;
    return `<div class="bkkid" data-status="${esc(st)}"><span class="bkst">${esc(st)}</span><span class="bkid">${esc(id)}</span><span class="bkms">${ms === undefined ? "" : esc(`${ms}ms`)}</span></div>`;
  }).join("");
  return `<div class="evbody">
      <span class="evlbl">${esc(`the record, verbatim · ${children.length} gates folded into it`)}</span>
      ${rec}
      <div class="bkkids">${kids}</div>
    </div>`;
}
