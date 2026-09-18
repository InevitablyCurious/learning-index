// RESULTS HISTORY — completed scored cells from past runs, read from the
// durable results ledger (it survives reset, archived with each backup). The
// emphasised column is problems_before → problems_after. Every field is escaped
// or rendered as an explicit null; an unreadable record is a null row, never a
// blank line.

import { esc, nul } from "../board.js";

/** Short wall-clock stamp; an unparseable one is an explicit null. */
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
 * Verdict chip: PASS green, FAIL plain (normal mid-campaign, not an alarm),
 * anything else neutral.
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
