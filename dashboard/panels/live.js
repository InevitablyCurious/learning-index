// PANEL: DATA FEED — the running cell's feeds, or a concluded baseline's frozen
// record (picked on the BASELINES card), in the same card with the same tools.
//
// Feed behaviours, each fixing an observed defect: oldest-first with a constant
// row height; per-kind filter chips with live counts; render cap 400 trimmed from
// the top with scroll compensation; sticky-bottom within 24px; a "N new ↓" pill
// when scrolled away; append past a seq watermark, never a rebuild (a rebuild
// resets scroll); a one-shot flash only (never height/margin/transform), static
// under prefers-reduced-motion. A running cell's totals are marked provisional.
//
// This entry holds the render and the row painters; state, phases, history and
// backend helpers live in ./live/*.js and are re-exported from here.

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
  expandedBackend,
  setExpandedBackend,
  backendExpandBound,
  setBackendExpandBound,
  eventFeed,
  backendFeed,
} from "./live/state.js";
import { syncFeedToCell, histKey } from "./live/history.js";
import {
  backendHead,
  feedTabs,
  backendRows,
  groupKeyOf,
  gateSummary,
  mergeBackendRows,
  condenseBackend,
} from "./live/backend.js";

// ── THE PUBLIC SURFACE ── moved symbols are re-exported explicitly, so
// panels/live.js stays the one import path.
export { EVENT_KINDS };
export { phaseIndex, chunkOf, spine, provisional } from "./live/phases.js";
export { feedSelection, readCell } from "./live/history.js";
export {
  setFeedTab,
  toggleBackendSource,
  toggleBackendLevel,
  clearBackendFilters,
} from "./live/backend.js";
export { mergeBackendRows, condenseBackend };

export const EVENT_RENDER_CAP = 400;
export const BOTTOM_EPS = 24;

// `harness` no longer appears in EVENT_KINDS; its mark is kept for any producer
// that still emits it.
const KIND_MARK = { tool: "$", file: "~", thinking: "·", error: "!", lifecycle: "◦", user: ">", harness: "▣" };

/**
 * Filter state lives in ./live/state.js and survives re-render (model:
 * panels/facet.js — nothing selected shows everything).
 */
export function toggleKind(k) {
  toggleFacet(kindFacet, k);
}

export function clearKinds() {
  clearFacet(kindFacet);
}

/**
 * The card is the event feed, full width (the spine and counters live on the
 * gate wall).
 */
export function renderLive(board) {
  // The card follows the cell strip (panels/cells.js); history.js keeps the
  // cell's record fresh while it runs.
  syncFeedToCell(board);

  return `
    <section class="panel live">
      <div class="phead">
        <span class="ttl">DATA FEED</span>
        <span class="sub">${cellLabel()}</span>
      </div>
      <div class="live-feed">
        ${tab === "backend" ? backendHead() : feedHead(board)}
        <div class="feed-copy"><button class="chip fexport" data-feed-copy="1">COPY RAW ${tab === "backend" ? "BACKEND" : "EVENTS"} (JSONL)</button><span class="note" id="feed-copy-note"></span></div>
        <div class="evbox" id="sc-events" data-preserve="1"${tab === "backend" ? ' hidden' : ""}></div>
        <div class="evbox" id="sc-backend" data-preserve="1"${tab === "backend" ? "" : ' hidden'}></div>
      </div>
    </section>`;
}

/** Which cell is on screen, and whether it is still running. */
function cellLabel() {
  if (!hist) return nul("no cell to show");
  const sel = hist.sel;
  const who = `<span class="feed-subject">${esc(sel.label)}</span>`;
  return sel.running
    ? `${who} · <span class="feed-live">LIVE</span>`
    : `${who} · <span class="feed-frozen">ENDED — COMPLETE RECORD</span>`;
}

// ── EVENT FEED ──────────────────────────────────────────────────────────────

function feedHead(board) {
  const ev = eventFeed(board);
  const counts = ev?.counts ?? {};
  const chips = EVENT_KINDS.map((k) => {
    const n = counts[k] ?? 0;
    // A non-zero error count keeps the danger colour whatever the filter state.
    return `<button class="chip fchip ${facetState(kindFacet, k)} ${k === "error" && n > 0 ? "err" : ""}" data-kind="${k}">${KIND_MARK[k]} ${k} ${n}</button>`;
  }).join("");

  // An active filter announces itself and clears in one click.
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

/** `windowed` = more exist, ask for them; `capped` = events were dropped. */
function feedNote(ev) {
  if (!ev) return "reading the record…";
  if (!hist) return "nothing to show";
  // The cell's whole record: no cap, no ring.
  const bits = [`${ev.returned ?? (ev.events ?? []).length} events`];
  if (ev.unmapped) bits.push(`${ev.unmapped} unmapped`);
  bits.push(hist.sel.running ? "oldest first · re-read every 2s" : "oldest first · complete record");
  return bits.join(" · ");
}

// The feed paints out of band after the board's swap (append-only, stateful).

/**
 * What would make the painted list wrong to append to. Includes the source, or
 * switching between two frozen records could splice them into one list.
 */
function sigOf(ev) {
  return JSON.stringify([
    facetSignature(kindFacet),
    ev?.connected ?? null,
    ev?.reason ?? null,
    hist ? histKey(hist.sel) : "none",
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
    box.innerHTML = padNote("reading the cell's record…");
    setRenderedSeq(-1); setRenderedSig(sig);
    return;
  }
  // A dead stream is stated as a banner above the rows, never instead of them.
  // An idle bench (cell_in_flight false) is not called disconnected.
  const idle = ev.cell_in_flight === false;
  const disconnected = !ev.connected && !idle;
  // Marked .feed-banner so it doesn't force a rebuild every poll.
  const banner = disconnected
    ? `<div class="null pad danger feed-banner">${esc(`event feed disconnected — ${ev.reason ?? "no reason given"}. Counts above are frozen at the last event and may be stale.`)}</div>`
    : "";

  const rows = (ev.events ?? []).filter((e) => facetAccepts(kindFacet, e.kind));
  if (!rows.length) {
    box.innerHTML = banner + padNote(
      // Name the filter that emptied the feed.
      ev.retained && facetActive(kindFacet)
        ? `no ${facetPicked(kindFacet).join(" or ")} events among the ${ev.retained} retained — press CLEAR to see the rest.`
        : ev.retained
          ? "every retained event is hidden by the active filters."
          : !hist
            // The state the operator is in, and what to do about it.
            ? "no cell to show — this bench has no batch yet. Start a baseline from BASELINES."
            : idle
              // An ended cell whose record holds nothing: said, never blank.
              ? "this cell's record holds no events — no transcript was captured for it."
            : disconnected
              // Not "connected": the banner above just said it isn't.
              ? "no events were retained before the stream dropped."
              : "connected, no events yet — nothing has happened in the session.",
    );
    setRenderedSeq(-1); setRenderedSig(sig);
    return;
  }

  // Measure before touching the DOM.
  const atBottom = isAtBottom(box);
  const wrapped = rows[0].seq > renderedSeq + 1 && renderedSeq !== -1;
  // The ring re-based (the control plane restarted): replace, don't append.
  const rebased = renderedSeq !== -1 && rows.length > 0 && (rows[rows.length - 1].seq ?? -1) < renderedSeq;
  // An empty-state note means rebuild; the disconnection banner does not.
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

  // Trim from the top, compensating scroll by the height removed.
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

// The expanded body: the captured text, called verbatim only when nothing was
// cut (the >64KB guard says so and points at /api/feedback). Exported for tests.
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

// The one-line row; `open` appends evBody(). Both paint paths use it, so a
// rebuild keeps expansions.
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

// Click-to-expand, delegated on the feed box and bound once; only the affected
// rows repaint, so scroll never moves.
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
 * Click-to-expand for the backend feed, bound here beside its twin (moving it
 * to backend.js would create an import cycle).
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
 * The whole record set, unfiltered and uncondensed, as JSONL on the clipboard:
 * every record reachable as data, in the producers' own format.
 */
export function feedExportText(board) {
  const rows = tab === "backend"
    ? mergeBackendRows(backendFeed())
    : ((eventFeed(board)?.events) ?? []);
  return rows.map((r) => JSON.stringify(r)).join("\n");
}

/** What the export is of, stated so a paste is traceable. */
export function feedExportLabel(board) {
  const what = tab === "backend" ? "backend records" : "events";
  const n = tab === "backend"
    ? mergeBackendRows(backendFeed()).length
    : ((eventFeed(board)?.events) ?? []).length;
  const src = hist ? `${hist.sel.run_dir} · ${hist.sel.label}` : "no cell";
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
            ? `the cell's record could not be read — ${feed.hist_reason}`
            : "control plane unreachable — nothing can be read.")
        : !feed.loaded
          ? "reading…"
          : feed.total > 0
            ? "no records match the picked filters — press CLEAR to see the rest."
            : hist
              ? (hist.sel.running ? "no backend records yet — processes write these as they work." : "this cell wrote no backend records.")
              : "no cell to show.",
      dead,
    );
    return;
  }

  // Rebuilt, not appended (a 2s poll of whole records that chips re-filter);
  // filtered before condensing; scroll preserved across the rebuild.
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

/** One backend row. Every row expands to its full record. */
export function bRow(r, opts = {}) {
  const { children = [], open = false, groupKey = null } = opts;
  const t = r?.ts ? new Date(r.ts).toLocaleTimeString("en-GB", { hour12: false }) : "";
  // The notice's event name, else the record's kind.
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
  // Severity as a data attribute (a literal class the style test can check). A
  // wider second column, because it holds a source name.
  return `<div class="evrow bkrow${open ? " open" : ""}" data-level="${esc(r?.level ?? "info")}" data-bkey="${esc(groupKey ?? "")}" role="button" tabindex="0" aria-expanded="${open ? "true" : "false"}">
      <span class="evt">${esc(t)}</span>
      <span class="evmark">${esc(r?.source ?? "")}</span>
      <span class="evname">${esc(label)}</span>
      <span class="evdetail">${esc(detail)}${fold}</span>
      ${open ? bBody(r, children) : ""}
    </div>`;
}

/** The expanded body: the whole record as JSON, then folded children. */
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
