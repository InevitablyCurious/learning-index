// PANEL: CELLS — the batch strip, and what the rest of the board is showing.
//
// ── WHY A STRIP AND NOT A DROPDOWN ──────────────────────────────────────────
//
// With N concurrent cells of ONE model and arm, every label that distinguishes
// a run elsewhere on this board is identical across them: same model, same
// arm, same run_dir. A <select> of four entries reading "qwen3.6 · off" is not
// a control, it is four indistinguishable rows.
//
// What actually differs is progress, outcome and health — so each cell gets a
// card carrying its sequence index, where it has got to, how long and how many
// turns it has spent, and a state dot. Selecting one re-renders the board
// beneath it against that cell.
//
// ── A VOID CELL IS STILL SELECTABLE ─────────────────────────────────────────
//
// It is dimmed and marked, never hidden and never removed. A cell that died is
// exactly where an operator finds out WHY it died, and a batch that quietly
// dropped its failures would present four samples with the confidence of six.
//
// The median marker is the batch's own (control/batch.mjs), carried through
// rather than recomputed here, so this strip and the batch panel cannot
// disagree about which run is representative.

import { esc, nul } from "../board.js";

/** The selected cell's sequence index, or null for "the newest live one". */
let selected = null;

export function selectedCell() {
  return selected;
}

/** Set by the click handler in board.js. Re-render is the caller's job. */
export function setSelectedCell(index) {
  selected = index === null || index === undefined ? null : Number(index);
}

/**
 * Which cell the board is drawing. The operator's pick when they made one and
 * it is still in the batch; otherwise the newest live cell, then the first.
 * Never a stale index: a pick that no longer exists falls back rather than
 * rendering an empty board.
 */
export function activeCell(board) {
  const list = board?.cells?.list ?? [];
  if (!list.length) return null;
  if (selected !== null) {
    const hit = list.find((c) => c.sequence_index === selected);
    if (hit) return hit;
  }
  return list.find((c) => c.running) ?? list[0];
}

/** "18m", "2h 04m", or null when there is nothing to measure. */
function shortDur(s) {
  if (!Number.isFinite(s) || s < 0) return null;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/**
 * Live, quiet, ended-clean, ended-void — the dot and what it means.
 *
 * NAMESPACED ON PURPOSE. The board ships ONE global stylesheet, and a bare
 * `live` class here matched `.curve,.wall,.ledger,.live,...` — the live PANEL
 * rule — which gave a 6px dot 12px of padding and blew it to 26px. Every state
 * class this panel emits carries the cc- prefix for that reason.
 */
function health(c) {
  if (c.scored === false) return { cls: "cc-is-void", dot: "cc-void" };
  if (!c.running) return { cls: "cc-is-done", dot: "cc-done" };
  if (Number.isFinite(c.heartbeat_age_s) && c.heartbeat_age_s > 90) {
    return { cls: "cc-is-quiet", dot: "cc-quiet" };
  }
  return { cls: "cc-is-live", dot: "cc-live" };
}

/**
 * The one line that says where a cell is. A running cell shows its build
 * chunk; a finished one its problem count; a void one why it is void. Kept
 * inside ~20 characters — the card is 146px of JetBrains Mono, and a line that
 * wraps costs the card its second row.
 */
function stateLine(c) {
  if (c.scored === false) return esc(c.void_reason ?? "void");
  if (Number.isFinite(c.problems)) return `done · ${c.problems}`;
  const cur = c.chunk?.current;
  const tot = c.chunk?.total;
  if (Number.isFinite(cur)) return tot ? `chunk ${cur}/${tot}` : `chunk ${cur}`;
  if (c.phase) return esc(String(c.phase).slice(0, 18));
  return c.running ? "starting" : "—";
}

/** How far along, 0..1. Finished cells read full whatever their verdict. */
function progress(c) {
  if (!c.running) return 1;
  const cur = c.chunk?.current;
  const tot = c.chunk?.total;
  if (Number.isFinite(cur) && Number.isFinite(tot) && tot > 0) return cur / tot;
  return 0;
}

/** Is this the run nearest the batch median — the one usually worth picking? */
function nearMedian(c, median) {
  if (median === null || !Number.isFinite(c.problems)) return false;
  return (
    c.problems === median ||
    c.problems === Math.floor(median) ||
    c.problems === Math.ceil(median)
  );
}

function card(c, median, activeIndex) {
  const h = health(c);
  const on = c.sequence_index === activeIndex;
  const seq = `s${String(c.sequence_index ?? 0).padStart(4, "0")}`;
  // Scoring turns of the build phases that have FINISHED (control/board/sources/
  // cells.mjs): the phase in progress is added when it ends.
  const bits = [shortDur(c.elapsed_s), Number.isFinite(c.turns) ? `${c.turns} turns` : null]
    .filter(Boolean)
    .join(" · ");
  return `
    <button class="cellcard ${h.cls}${on ? " on" : ""}" data-cell-pick="${esc(String(c.sequence_index))}"
            data-cell-run="${esc(String(c.run_id ?? ""))}"
            aria-pressed="${on ? "true" : "false"}" title="${esc(seq)} — ${esc(stateLine(c))}">
      <span class="cc-head">
        <span class="cc-dot ${h.dot}"></span>
        <span class="cc-seq">${esc(seq)}</span>
        ${c.running ? `<span class="cc-tag live">LIVE</span>` : ""}
        ${on ? `<span class="cc-tag view">VIEW</span>` : nearMedian(c, median) ? `<span class="cc-tag med">~med</span>` : ""}
      </span>
      <span class="cc-state">${stateLine(c)}</span>
      <span class="cc-bar"><i style="width:${Math.round(progress(c) * 100)}%"></i></span>
      <span class="cc-meta">${esc(bits || "—")}</span>
    </button>`;
}

export function renderCells(board) {
  const cells = board?.cells;
  const list = cells?.list ?? [];
  // One cell is the board's ordinary state — the strip is what N looks like,
  // and drawing it for a single cell is chrome with nothing to choose.
  if (list.length < 2) return "";

  const active = activeCell(board);
  const activeIndex = active?.sequence_index ?? null;
  const k = cells.counts ?? {};
  const median = cells.median ?? null;

  const summary = [
    `${k.total ?? list.length} cells`,
    median !== null ? `median ${median}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const tally = [
    k.live ? `${k.live} live` : null,
    k.scored ? `${k.scored} scored` : null,
    k.void ? `${k.void} void` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const voidBanner = cells.batch_void
    ? `<div class="cells-void">batch void — ${esc(cells.void_reason ?? "an input changed")}</div>`
    : "";

  return `
    <section class="cells" aria-label="cells in this batch">
      <div class="cells-head">
        <span class="kick">CELLS · ${esc(summary)}</span>
        <span class="spacer"></span>
        <span class="note">${esc(tally || nul("nothing running"))}</span>
      </div>
      ${voidBanner}
      <div class="cells-scroll">
        ${list.map((c) => card(c, median, activeIndex)).join("")}
      </div>
    </section>`;
}

/**
 * Fade only the edges that actually have cells beyond them.
 *
 * A fixed both-edge mask dims the first card when there is nothing to its
 * left, and a right-only mask leaves a hard cut after the operator scrolls —
 * both read as a rendering fault rather than an affordance. So the edges are
 * classes, set from the real scroll position.
 *
 * Called after each render (board.js). `patch()` morphs the tree in place, so
 * the listener is attached once per element and marked; re-running this is
 * cheap and idempotent.
 */
export function observeCellStrip() {
  const el = document.querySelector(".cells-scroll");
  if (!el) return;
  const mark = () => {
    const max = el.scrollWidth - el.clientWidth;
    el.classList.toggle("at-start", el.scrollLeft <= 1);
    el.classList.toggle("at-end", max <= 1 || el.scrollLeft >= max - 1);
  };
  if (!el.dataset.edgeBound) {
    el.addEventListener("scroll", mark, { passive: true });
    el.dataset.edgeBound = "1";
  }
  mark();
}

/**
 * The mark for a panel that cannot follow the strip yet. Its source reads one
 * cell the control plane chooses, and records not which — so with two or more
 * cells it may be showing a different cell than the strip's. Said on the panel,
 * never left for the operator to assume. Nothing with a single cell.
 */
export function notPerCellMark(board) {
  if ((board?.cells?.list ?? []).length < 2) return "";
  return `<span class="tag cc-notcell" title="${esc(
    "this panel reads one cell chosen by the control plane, not the cell selected in the strip — per-cell reads for it are not built yet",
  )}">NOT PER-CELL</span>`;
}
