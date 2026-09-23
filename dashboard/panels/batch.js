// PANEL: BATCH — the operator's floor pick, posted.
//
// A model's floor is the operator's SELECTED cell from its batch of OFF cells
// (control/batch.mjs). The batch itself is drawn inside the BASELINES row
// (panels/ledger.js cellsSection); this module only records the pick.
//
// Bare-import safe: fetch lives inside the exported function.

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
