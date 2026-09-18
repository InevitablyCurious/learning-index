// DATA FEED — backend feed helpers: the system beside the agent (harness, gate
// runner, control plane, campaign layer, any backend). Chips, head, tabs, note,
// the merged and condensed rows, and the facet controls. The row renderers and
// paint stay in ../live.js; this imports only state.js, facet.js and esc.

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
 * Chips for both axes. The five native sources always show; any external
 * namespace present is appended (filterable, never merged into a native one).
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

  // A non-zero error count keeps the danger colour whatever the filter.
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

/** Which streams answered, stated. */
function backendNote() {
  const backend = backendFeed();
  if (backend.unreachable) return "control plane unreachable — this feed is not live";
  if (!backend.loaded) return "reading…";
  const s = backend.sources ?? {};
  const missing = [];
  if (s.live && !s.live.attached) missing.push("cell stream");
  if (s.notices && !s.notices.attached) missing.push("run notices");
  // Say that the error list is complete even when activity is windowed.
  const errs = backend.errors_total ?? 0;
  const win = backend.windowed
    ? ` · activity windowed, older records lie beyond it — ${errs} error${errs === 1 ? "" : "s"}, complete`
    : "";
  if (missing.length) return `${missing.join(" and ")} not readable${win}`;
  // The count is the merged list's own length (the server's figure predates the
  // union and dedupe).
  return `${backendRows().length} of ${backend.total} records${win}`;
}

/**
 * Recent activity (a window) plus every error (complete, sent separately),
 * unioned and deduped.
 */
export function backendRows() {
  return mergeBackendRows(backendFeed());
}

/**
 * Union errors + rows, dedupe, oldest first — the one definition, shared with
 * the concluded-run view. The key includes `detail`: a gate suite's results
 * share second, source and event and differ only there (without it 600 records
 * became 53).
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
  // Numeric and stable, so a suite sharing one millisecond keeps producer order.
  return out.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
}

/** A group's stable identity, so fold state survives the 2s rebuild. */
export function groupKeyOf(g) {
  const r = g.row ?? g.children[0] ?? null;
  return `${r?.ts ?? "?"}|${r?.kind ?? "?"}|${r?.source ?? "?"}|${r?.event ?? ""}`;
}

// ── CONDENSING ── gate.result records (most of a cell's backend rows) fold
// into the attempt.end that closed them, one click away; every other row keeps
// its place. gate_phase_duration notices stay top-level. Same view live and
// concluded.

/** Records that fold into the attempt that closed them. */
const FOLDS_INTO_ATTEMPT = new Set(["gate.result"]);

/**
 * Group rows oldest first into [{ row, children }]: an attempt.end carries the
 * gate results since the previous attempt closed. Gate results with no closing
 * attempt go under a synthetic open group, never dropped. Pure.
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
