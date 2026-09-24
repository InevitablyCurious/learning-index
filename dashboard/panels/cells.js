// PANEL: CELLS — the run strip, and what the rest of the board is showing.
//
// ── WHY A STRIP AND NOT A DROPDOWN ──────────────────────────────────────────
//
// Every label that distinguishes a run elsewhere on this board is identical
// across the cells of one batch: same model, same arm, same run_dir. A
// <select> of four entries reading "qwen3.6 · off" is not a control, it is
// four indistinguishable rows.
//
// What actually differs is outcome and health — so each run gets a card
// carrying its identity (tree + sequence index), its status, and the
// measurements it stated. The strip spans the CURRENT tree plus every
// ARCHIVED run (board.runs, built by control/board/sources/runs.mjs, newest
// tree first); selecting a card re-renders the board beneath it against that
// run. An archived run's per-cell view is not on the board: board.js fetches
// it from /api/run-view once per page load and keeps it outside the board.
//
// ── SIX THINGS, STATED ───────────────────────────────────────────────────────
//
// A card shows exactly: the status header (dot + identity + tag), problems
// before → after, peak context / window, turns, loop errors, and
// stalled/limit errors. A field no artifact recorded is null and renders
// "not recorded" — never 0, never derived. No progress bar, no meta line, no
// median marker: the card is a measurement record, not a chart.
//
// ── A VOID RUN IS STILL SELECTABLE ──────────────────────────────────────────
//
// It is dimmed and marked, never hidden and never removed. A run that died is
// exactly where an operator finds out WHY it died, and a strip that quietly
// dropped its failures would present four samples with the confidence of six.
//
// ── EVERY STATE CLASS IS cc- PREFIXED ────────────────────────────────────────
//
// The board ships ONE global stylesheet, and a bare state class here (`live`)
// once matched the live PANEL rule, which gave a 6px dot 12px of padding and
// blew it to 26px. Every state class this panel emits carries the cc- prefix.

import { clip, esc, nul } from "../board.js";

/** The selected run's cellKey `${run_dir}::${sequence_index}`, or null for
 *  "follow the live cell". */
let selected = null;

export function selectedCell() {
  return selected;
}

/** Set by the click handler in board.js. Re-render is the caller's job. */
export function setSelectedCell(key) {
  selected = key || null;
}

/**
 * A card's address: `${run_dir}::${sequence_index}` — the SAME format as
 * board.js's cellKey. Deliberately local: board.js imports this module, so
 * importing cellKey from there would be a cycle.
 */
function cellKeyOf(c) {
  return `${c.run_dir}::${c.sequence_index}`;
}

/**
 * Which run the board is drawing. The operator's pick when they made one and
 * it is still on the strip; otherwise the newest live run (the producer sorts
 * newest-tree-first, so the first live card is the newest), then the first
 * card. Never a stale address: a pick that no longer exists falls back rather
 * than rendering an empty board.
 */
export function activeCell(board) {
  const list = board?.runs?.list ?? [];
  if (!list.length) return null;
  if (selected !== null) {
    const hit = list.find((c) => cellKeyOf(c) === selected);
    if (hit) return hit;
  }
  return list.find((c) => c.status === "live") ?? list[0];
}

/** Status → dot class, tag class, tag text, card class. The card's whole
 *  state vocabulary; the producer's enum is these four. */
const STATUS = {
  live: { dot: "cc-live", tag: "t-live", text: "LIVE", card: "" },
  scored: { dot: "cc-scored", tag: "t-scored", text: "SCORED", card: "" },
  void: { dot: "cc-void", tag: "t-void", text: "VOID", card: "cc-is-void" },
  harness_error: { dot: "cc-harness", tag: "t-harness", text: "HARNESS ERROR", card: "cc-is-harness" },
};

/**
 * A status the vocabulary does not know is still drawn — verbatim, undotted,
 * as a designed absence. Never guessed as one of the four.
 */
function statusOf(c) {
  return (
    STATUS[c.status] ?? {
      dot: "cc-unknown",
      tag: "t-unknown",
      text: c.status === null || c.status === undefined ? "UNOBSERVED" : esc(String(c.status)).toUpperCase(),
      card: "",
    }
  );
}

/**
 * The short tree label of a run_dir: the leading segment for a current run,
 * the inner tree id of "backups/<stamp>/<oldTreeId>/…" for an archived one.
 * A 9-11-digit epoch tree id (the same predicate as isTreeId in
 * control/tree.mjs — the browser cannot import it) shortens to its last five
 * digits; anything else is shown clipped. No identity is invented: no usable
 * segment, no tree label.
 */
function treeLabel(runDir) {
  const parts = String(runDir ?? "").split("/");
  const seg = parts[0] === "backups" ? parts[2] : parts[0];
  if (!seg) return null;
  return /^\d{9,11}$/.test(seg) ? seg.slice(-5) : clip(seg, 8);
}

/** Context tokens as the card states them: 262144 → "262k". */
function compact(n) {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** One label/value row. Labels are this file's own literals; value HTML comes
 *  from statedPair/statedNum (which escape nothing user-made — numbers only)
 *  or from nul(), the single null renderer. */
function field(label, valueHtml) {
  return `<span class="cc-f"><b class="cc-fl">${label}</b><span class="cc-fv">${valueHtml}</span></span>`;
}

/** A stated number, or the one rendering of null: never 0, never derived. */
function statedNum(v) {
  return Number.isFinite(v) ? `<span class="snum">${v}</span>` : nul("not recorded");
}

/** Two stated numbers as one value; either null ⇒ the whole field is
 *  "not recorded" — a half-stated pair is not half-rendered. */
function statedPair(a, b, fmt, join) {
  return Number.isFinite(a) && Number.isFinite(b)
    ? `<span class="snum">${fmt(a)} ${join} ${fmt(b)}</span>`
    : nul("not recorded");
}

function card(c, activeKey) {
  const st = statusOf(c);
  const on = cellKeyOf(c) === activeKey;
  const seq = Number.isInteger(c.sequence_index) ? `s${String(c.sequence_index).padStart(4, "0")}` : null;
  const tree = treeLabel(c.run_dir);
  const id = [tree, seq].filter(Boolean).map(esc).join("·") || nul("unnamed");
  return `
    <button class="cellcard${st.card ? ` ${st.card}` : ""}${on ? " on" : ""}" data-cell-pick="${esc(cellKeyOf(c))}"
            aria-pressed="${on ? "true" : "false"}" title="${esc(cellKeyOf(c))} — ${st.text}">
      <span class="cc-head">
        <span class="cc-dot ${st.dot}"></span>
        <span class="cc-id">${id}</span>
        <span class="cc-tag ${st.tag}">${st.text}</span>
      </span>
      <span class="cc-fields">
        ${field("problems", statedPair(c.problems_before, c.problems_after, String, "→"))}
        ${field("peak ctx", statedPair(c.context_peak, c.context_window, compact, "/"))}
        ${field("turns", statedNum(c.turns))}
        ${field("loop errors", statedNum(c.loop_errors))}
        ${field("stall/limit", statedNum(c.stalled_limit_errors))}
      </span>
    </button>`;
}

export function renderCells(board) {
  const runs = board?.runs;
  const list = runs?.list ?? [];
  // The strip ALWAYS renders — one run is the board's ordinary state, and
  // zero runs is a designed absence the header states, not a hidden section.
  const active = activeCell(board);
  const activeKey = active ? cellKeyOf(active) : null;
  const k = runs?.counts ?? {};

  const total = k.total ?? list.length;
  const summary = `${total} run${total === 1 ? "" : "s"}`;
  const tally = [
    k.live ? `${k.live} live` : null,
    k.scored ? `${k.scored} scored` : null,
    k.void ? `${k.void} void` : null,
    k.harness_error ? `${k.harness_error} harness error` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return `
    <section class="cells" aria-label="runs, current and archived">
      <div class="cells-head">
        <span class="kick">RUNS · ${esc(summary)}</span>
        <span class="spacer"></span>
        <span class="note">${tally ? esc(tally) : nul("no runs recorded")}</span>
      </div>
      <div class="cells-scroll">
        ${list.map((c) => card(c, activeKey)).join("")}
      </div>
    </section>`;
}

/**
 * Fade only the edges that actually have cards beyond them.
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
