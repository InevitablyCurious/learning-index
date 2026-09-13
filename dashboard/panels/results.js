// ─────────────────────────────────────────────────────────────────────────────
// RESULTS HISTORY — durable, past-run record of completed scored cells.
//
// The rest of the board is live-only by construction (WO-42): once a run
// concludes and the tree is swept, its results vanish from the board. This
// panel reads the durable ledger (WO-43) instead — one line per completed
// scored cell, accumulated across runs and surviving reset (the ledger itself
// is archived into the same backup folder as the tree on every reset).
//
// WHAT A ROW IS: one completed scored cell. The column that matters is the
// help→harm delta: `problems_before → problems_after`. That is the number the
// whole campaign exists to watch, so it gets the emphasis.
//
// DEFENSIVE BY CONSTRUCTION: the ledger is parsed tolerantly upstream, and the
// schema is the writer's contract — but a reader must not trust a file it does
// not write. Every field goes through `esc`/`nul`; a record with nothing
// readable renders as an explicit null row, never a blank line.
// ─────────────────────────────────────────────────────────────────────────────

import { esc, nul } from "../board.js";

/**
 * Short wall-clock stamp. The writer emits ISO-8601; a non-string or a string
 * that fails to parse renders as an explicit null — never "Invalid Date".
 */
function when(r) {
  const t = typeof r.timestamp === "string" ? r.timestamp : null;
  if (!t) return nul("unstamped");
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return nul("unstamped");
  return `<span class="label">${esc(d.toISOString().slice(0, 16).replace("T", " "))}</span>`;
}

/** Field or explicit null — the ledger is a contract, the renderer is not naive. */
function f(v, kind = "unrecorded") {
  return v === null || v === undefined || v === "" ? nul(kind) : esc(String(v));
}

/**
 * Verdict chip. PASS green, FAIL in the fg colour (fail is normal mid-campaign
 * and must not read as an alarm), anything else neutral. Unknown → null.
 */
function chip(v) {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  if (s === "pass") return `<span class="chip" style="color:var(--ok)">pass</span>`;
  if (s === "fail") return `<span class="chip" style="color:var(--fg)">fail</span>`;
  if (!s) return nul("no verdict");
  return `<span class="chip">${esc(v)}</span>`;
}

export function renderResults(board) {
  const results = board.results;
  if (!Array.isArray(results) || !results.length) {
    return `
    <div class="results">
      <div class="kick">RESULTS HISTORY</div>
      <div class="null">no completed runs yet — the ledger fills as runs conclude</div>
    </div>`;
  }

  const rows = results
    .map((r) => {
      const arm = typeof r.arm === "string" && r.arm ? r.arm : null;
      const pb = r.problems_before;
      const pa = r.problems_after;
      const delta =
        Number.isFinite(pb) && Number.isFinite(pa)
          ? `${pa} <span class="label">from</span> ${pb}`
          : `<span class="null">delta unrecorded</span>`;
      return `
      <div class="res-row">
        <span class="res-when">${when(r)}</span>
        <span class="res-task">${f(r.task, "untitled task")}</span>
        <span class="res-model">${f(r.model, "unrecorded")}</span>
        <span class="res-arm">${arm ? esc(arm) : nul("unrecorded")}</span>
        <span class="res-verdict">${chip(r.verdict)}</span>
        <span class="res-atg">${f(r.attempts_to_green, "unmeasured")}</span>
        <span class="res-delta">${delta}</span>
      </div>`;
    })
    .join("");

  return `
  <div class="results">
    <div class="kick">RESULTS HISTORY</div>
    <div class="res-list">${rows}</div>
  </div>`;
}
