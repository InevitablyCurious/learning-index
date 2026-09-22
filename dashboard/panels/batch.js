// PANEL: BATCH — the operator's floor pick, rendered.
//
// A model's floor is the operator's SELECTED run from its batch of OFF cells
// (control/batch.mjs): the median problem count over the SCORED runs is the
// reference, void runs are excluded and never counted as failures, and the
// whole record is fingerprint-bound — a batch whose inputs changed is void and
// says which input changed. This panel draws that record: the median, one row
// per run (its problem count, or its void reason), the median marker, and one
// pick button per scored run. A void batch shows the banner and NO pick
// buttons: a selection never rides on stale numbers.
//
// Bare-import safe: fetch lives inside the exported functions, no top-level
// DOM, no side effects at import.

import { esc, nul } from "../board.js";

/**
 * Is this scored run's problem count the median? An odd-count median is one
 * run's exact count; an even-count median can be fractional (x.5), in which
 * case the two middle runs — floor and ceil — both carry the marker.
 */
function isMedianCount(count, median) {
  if (median === null || !Number.isFinite(count)) return false;
  return count === median || count === Math.ceil(median) || count === Math.floor(median);
}

/** One run: seq + problem count, or its void reason. Pick only when scored. */
function batchRow(r, median, batchVoid, runDir) {
  const seq = `<span class="cbatch-seq">seq ${esc(String(r.sequence_index))}</span>`;
  if (r.scored !== true) {
    return `<div class="cbatch-row">${seq}${nul(`void · ${esc(String(r.void_reason ?? "unscored"))}`)}</div>`;
  }
  const mark = isMedianCount(r.problem_count, median) ? `<span class="bright">◀ median</span>` : "";
  const pick = batchVoid
    ? ""
    : `<button class="cbatch-btn" data-batch-pick="${esc(String(r.sequence_index))}" data-batch-dir="${esc(runDir)}">pick</button>`;
  return `<div class="cbatch-row">${seq}<span>${esc(String(r.problem_count))} problems</span>${mark}${pick}</div>`;
}

/**
 * The batch record (GET /api/batch → {ok, batch}) as an HTML string, painted
 * into the row's data-preserve slot by doOpenBatch (board-actions.js).
 */
export function renderBatch(batch) {
  const runs = Array.isArray(batch?.runs) ? batch.runs : [];
  const scored = batch?.scored_count ?? 0;
  const voids = batch?.void_count ?? 0;
  const median = batch?.median ?? null;
  const batchVoid = batch?.void === true;

  // The void banner leads: it is the one fact that changes what every number
  // below it means.
  const banner = batchVoid
    ? `<div class="cbatch-void">BATCH VOID — ${esc(String(batch.void_input))} changed</div>`
    : "";

  const head = `<div class="kick">median: ${
    median === null ? "—" : esc(String(median))
  } · ${esc(String(scored))} of ${esc(String(scored + voids))} scored, ${esc(String(voids))} void</div>`;

  const rows = runs.map((r) => batchRow(r, median, batchVoid, batch?.run_dir ?? "")).join("");

  // The deviation arrives signed from the server (+ = worse, − = better);
  // it is printed as it stands, never re-derived here.
  const sel = batch?.selection
    ? `<div class="cbatch-sel">selected: seq ${esc(String(batch.selection.sequence_index))} · deviation ${esc(String(batch.selection.signed_deviation))}</div>`
    : "";

  return `${banner}${head}${rows}${sel}`;
}

/**
 * GET /api/batch for one runs-root-relative run_dir. The batch record on
 * success; null when the server has none (or refuses) — the caller paints the
 * absence, it is never silently an empty list.
 */
export async function loadBatch(runDir) {
  const res = await fetch("/api/batch?run_dir=" + encodeURIComponent(runDir));
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.ok !== true || !body?.batch) return null;
  return body.batch;
}

/**
 * POST /api/batch/select — record the operator's pick. Throws on any refusal
 * (409 void batch, 400 unscored index) with the server's own message: a pick
 * that did not land must never read as one that did.
 */
export async function pickRun(runDir, sequenceIndex) {
  const res = await fetch("/api/batch/select", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ run_dir: runDir, sequence_index: sequenceIndex }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.ok !== true) {
    throw new Error(`batch select refused: HTTP ${res.status}${body?.error ? ` — ${body.error}` : ""}`);
  }
  return body.batch;
}
