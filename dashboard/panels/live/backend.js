// ─────────────────────────────────────────────────────────────────────────────
// LIVE PANEL — BACKEND FEED HELPERS
//
// The SYSTEM feed, beside the agent: the harness, the gate runner, the control
// plane, the campaign layer, and any backend that joined the stream. These are
// the non-anchored helpers — chips, head, tabs, note, the merged/condensed row
// set, and the source/severity facet controls. The row renderers themselves
// (bRow/bBody) and the paint (paintBackend) stay in the entry because they are
// source-scrape anchors; this module imports state.js, facet.js and the board's
// `esc` only — it never imports the entry, so the graph stays acyclic.
//
// Split from panels/live.js (LI-14) with no behaviour change.
// ─────────────────────────────────────────────────────────────────────────────

import { esc } from "../../board.js";
import { toggleFacet, clearFacet, facetState, facetActive } from "../facet.js";
import { tab, setTab, sourceFacet, levelFacet, backendFeed } from "./state.js";

export function setFeedTab(next) {
  if (next === "events" || next === "backend") setTab(next);
}

export function toggleBackendSource(v) {
  toggleFacet(sourceFacet, v);
}
export function toggleBackendLevel(v) {
  toggleFacet(levelFacet, v);
}
export function clearBackendFilters() {
  clearFacet(sourceFacet);
  clearFacet(levelFacet);
}

/**
 * Chips for both axes.
 *
 * THE SOURCE ROW GROWS TO FIT WHAT ARRIVED. The five native sources are always
 * drawn — a stranger's board should show the same controls as yours, and a chip
 * that appears only once its process has spoken teaches nothing about what can
 * speak. Any EXTERNAL namespace present in the rows is appended: a backend's
 * telemetry is not a benchmark source and never merges into one, but it must be
 * filterable or the merged list is unreadable.
 */
function backendChips() {
  const all = backendRows();
  const seen = new Set(all.map((r) => r.source));
  for (const s of seen) if (!sourceFacet.values.includes(s)) sourceFacet.values.push(s);

  const counts = {};
  for (const r of all) counts[r.source] = (counts[r.source] ?? 0) + 1;
  const lvl = {};
  for (const r of all) lvl[r.level] = (lvl[r.level] ?? 0) + 1;

  const src = sourceFacet.values
    .map(
      (v) =>
        `<button class="chip fchip ${facetState(sourceFacet, v)}" data-bsource="${esc(v)}">${esc(v)} ${counts[v] ?? 0}</button>`,
    )
    .join("");

  // A NON-ZERO ERROR COUNT KEEPS THE DANGER HUE whatever the filter state — the
  // same rule the event feed's error kind has always had, for the same reason.
  const lev = levelFacet.values
    .map(
      (v) =>
        `<button class="chip fchip ${facetState(levelFacet, v)} ${v === "error" && (lvl[v] ?? 0) > 0 ? "err" : ""}" data-blevel="${v}">${v} ${lvl[v] ?? 0}</button>`,
    )
    .join("");

  const clear =
    facetActive(sourceFacet) || facetActive(levelFacet)
      ? `<button class="chip fclear" data-bclear="1">CLEAR</button>`
      : "";

  return `${src}<span class="fsep"></span>${lev}${clear}`;
}

export function backendHead() {
  return `
    <div class="feed-head">
      ${feedTabs()}
      ${backendChips()}
      <span class="spacer"></span>
      <span class="note">${esc(backendNote())}</span>
    </div>`;
}

export function feedTabs() {
  return `
    <span class="ftabs">
      <button class="chip ftab ${tab === "events" ? "picked" : "neutral"}" data-feedtab="events">EVENT FEED</button>
      <button class="chip ftab ${tab === "backend" ? "picked" : "neutral"}" data-feedtab="backend">BACKEND FEED</button>
    </span>`;
}

/**
 * WHICH STREAMS ANSWERED, stated rather than implied.
 *
 * A feed missing the control plane's half and a control plane with nothing to
 * say render identically without this — which is the failure this whole surface
 * exists to remove, reappearing inside the surface itself.
 */
function backendNote() {
  const backend = backendFeed();
  if (backend.unreachable) return "control plane unreachable — this feed is not live";
  if (!backend.loaded) return "reading…";
  const s = backend.sources ?? {};
  const missing = [];
  if (s.live && !s.live.attached) missing.push("cell stream");
  if (s.notices && !s.notices.attached) missing.push("run notices");
  // SAY WHICH HALF IS COMPLETE. "Older records exist beyond the window" is an
  // honest thing to say about activity and a frightening thing to leave hanging
  // over failures — the reader has no way to know the errors are all there.
  const errs = backend.errors_total ?? 0;
  const win = backend.windowed
    ? ` · activity windowed, older records lie beyond it — ${errs} error${errs === 1 ? "" : "s"}, complete`
    : "";
  if (missing.length) return `${missing.join(" and ")} not readable${win}`;
  // THE COUNT IS THE MERGED LIST\'S OWN LENGTH. `returned` is the server\'s
  // window figure, taken before errors[] and rows[] are unioned and deduped —
  // so it can name a number the list beneath it does not contain. The number a
  // reader checks against the rows must come from the rows.
  return `${backendRows().length} of ${backend.total} records${win}`;
}

/**
 * RECENT ACTIVITY, PLUS EVERY ERROR.
 *
 * The activity rows are a WINDOW — the last stretch of two append-only streams
 * that grow without bound. That is right for "what is happening" and wrong for
 * "what went wrong": an error from three hours ago is precisely the record
 * someone reviewing a finished run came for, and it is the first thing a tail
 * drops.
 *
 * So the server sends the complete error set separately and they are unioned
 * here. DEDUPED, because an error inside the window arrives on both lists and
 * showing it twice would make one failure look like two.
 */
export function backendRows() {
  return mergeBackendRows(backendFeed());
}

/**
 * UNION errors[] + rows[], dedupe, oldest first. EXPORTED and the only
 * definition: the live card and the BASELINES card's concluded-run drawer read
 * the same feed, and two merges of one record set would be two claims.
 *
 * ── THE KEY IDENTIFIES A RECORD, NOT A TIME BUCKET ──────────────────────────
 *
 * It was `${ts}|${kind}|${source}|${event}` — which is not an identity. A gate
 * suite reports every result in the same second, from the same source, under
 * the same `gate.result` event name, differing ONLY in `detail.id`. Measured on
 * a real run: 600 backend records collapsed to 53, and the header above them
 * went on saying "600 records" — 547 rows dropped, silently, with the count
 * still claiming they were there.
 *
 * `detail` is therefore part of the key. It is the only field that distinguishes
 * one gate result from the next, so a merge that ignores it is not deduplicating
 * duplicates — it is discarding evidence.
 */
export function mergeBackendRows(feed) {
  const seen = new Set();
  const out = [];
  for (const r of [...(feed?.errors ?? []), ...(feed?.rows ?? [])]) {
    const key = `${r.ts}|${r.kind}|${r.source}|${r.event ?? ""}|${JSON.stringify(r.detail ?? null)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  // NUMERIC, and stable within a tie. `ts` is a number by contract
  // (control/backend-feed.mjs toRow), and a whole gate suite shares one
  // millisecond — so equal stamps must keep the order the producer wrote them
  // in rather than being reshuffled by an unstable comparison.
  return out.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
}

/**
 * A group's stable identity across rebuilds — the fold state must survive the
 * 2s poll, and a positional index would move under the operator the moment a
 * new record landed or a chip changed.
 */
export function groupKeyOf(g) {
  const r = g.row ?? g.children[0] ?? null;
  return `${r?.ts ?? "?"}|${r?.kind ?? "?"}|${r?.source ?? "?"}|${r?.event ?? ""}`;
}

// ── CONDENSING: A BIRD'S-EYE VIEW, WITH THE DATA ONE CLICK AWAY ─────────────
//
// A 2h19m cell produces ~630 backend records, and 585 of them are `gate.result`
// — one per gate, per attempt, all landing in the same second. Rendered flat,
// the forty-five records that actually describe what the harness DID (phase
// starts, attempt verdicts, truncation warnings, the cell's own start and end)
// are unfindable underneath them, and the 600-row window meant you saw almost
// nothing but the final grading burst.
//
// SO GATE RESULTS FOLD INTO THE ATTEMPT THEY BELONG TO. Nothing is discarded:
// the gates are children of the `attempt.end` that closed them, one click away,
// and every other row keeps its place. `gate_phase_duration` notices stay
// TOP-LEVEL by operator ruling — grading slowness is a thing to watch, not a
// detail to bury.
//
// THE SAME VIEW LIVE AND CONCLUDED. One surface, one behaviour: a gate burst
// scrolling past is not more readable while it happens than afterwards, and a
// card that reorganised itself the moment a run ended would teach the operator
// that what they watched is not what they can review.

/** Records that fold into the attempt that closed them. */
const FOLDS_INTO_ATTEMPT = new Set(["gate.result"]);

/**
 * Group merged backend rows into a birds-eye list, oldest first.
 *
 * Returns `[{ row, children }]` — `children` empty for an ordinary record, and
 * for an `attempt.end` the gate results that preceded it since the last attempt
 * closed. Gate results with no attempt after them (a cell still grading, or one
 * that died mid-attempt) are NOT dropped: they are handed back under a synthetic
 * open group so a run that never closed its last attempt still shows them.
 * Losing rows because the run ended untidily would hide exactly the run worth
 * looking at.
 *
 * PURE. Exported for tests and used by the paint.
 */
export function condenseBackend(rows) {
  const out = [];
  let pending = [];
  for (const r of rows ?? []) {
    if (FOLDS_INTO_ATTEMPT.has(r.kind)) { pending.push(r); continue; }
    if (r.kind === "attempt.end") {
      out.push({ row: r, children: pending });
      pending = [];
      continue;
    }
    out.push({ row: r, children: [] });
  }
  if (pending.length) out.push({ row: null, children: pending, open_group: true });
  return out;
}

/** A one-line summary of a folded gate set: what passed, what did not. */
export function gateSummary(children) {
  let pass = 0, fail = 0, other = 0;
  for (const c of children) {
    const st = c?.detail?.status;
    if (st === "pass") pass += 1;
    else if (st === "fail") fail += 1;
    else other += 1;
  }
  const bits = [`${children.length} gates`];
  if (pass) bits.push(`${pass} pass`);
  if (fail) bits.push(`${fail} fail`);
  if (other) bits.push(`${other} other`);
  return bits.join(" · ");
}
