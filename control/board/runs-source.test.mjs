// ─────────────────────────────────────────────────────────────────────────────
// SOURCE: runs — one card per run (current-tree cells + archived backups).
//
// The fixture is a whole bench in a tmpdir: an active tree with one scored
// cell (launch record + batch + manifest.status.jsonl + live.jsonl) and one
// archived run under backups/<stamp>/<oldTree>/… whose live.jsonl carries
// synthetic notices (guard_abort / turn_stalled / length_cutoff) and a
// cell.end with terminal_reason "harness_error", with an EMPTY results
// ledger — the common archived shape. No run artifact on disk today carries
// length_cutoff / context_peak / cap_cutoffs (they landed in 3fbe190), so
// these fixtures are the only place the counting is pinned.
//
// Tree ids are chosen so the fixture outranks any real tree (9999999999) and
// the archive under-ranks it (1780000001): the newest-first order assertion
// holds even if a real bench is running while the suite runs (readRunState's
// process scan is machine-wide). Assertions target the fixture's cards by
// run_dir rather than the whole list, for the same reason.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { read, id, fields } from "./sources/runs.mjs";

const CURRENT_TREE = "9999999999";
const CURRENT_RUN = `${CURRENT_TREE}/local/local-llm-proxy/omlx/model-a`;
const STAMP = "1790000001";
const OLD_TREE = "1780000001";
const ARCHIVED_RUN = `backups/${STAMP}/${OLD_TREE}/local/local-llm-proxy/omlx/model-old`;

/** The card contract: EXACTLY these keys, in this order, on every card. */
const CARD_KEYS = [
  "run_dir", "sequence_index", "archived", "model", "arm", "status",
  "problems_before", "problems_after", "context_peak", "context_window",
  "turns", "loop_errors", "stalled_limit_errors",
];

const notice = (event, terminal) =>
  JSON.stringify({ kind: "notice", event, detail: { terminal } });
const cutoff = () =>
  JSON.stringify({ kind: "notice", event: "length_cutoff", detail: { nudged: true, reason: "nudged" } });

function writeJsonl(path, records) {
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function fixture() {
  const runsRoot = mkdtempSync(join(tmpdir(), "runs-source-"));

  // ── the active tree ──
  writeFileSync(
    join(runsRoot, "active-tree.json"),
    JSON.stringify({ active: CURRENT_TREE, created_at: null, history: [] }),
  );
  const campaign = join(runsRoot, CURRENT_RUN);
  mkdirSync(join(campaign, "memoryOFF", "cell-0000"), { recursive: true });
  writeFileSync(
    join(campaign, "manifest.json"),
    JSON.stringify({
      created_at: "2026-09-01T00:00:00Z",
      schedule: [{ sequence_index: 0, memory_mode: "off", provider_pin: "m-current" }],
    }),
  );
  // One attempt record: the HEAD-era fields (context_peak/context_window/
  // cap_cutoffs) that no real artifact on disk carries yet.
  writeJsonl(join(campaign, "manifest.status.jsonl"), [
    {
      type: "attempt", sequence_index: 0, memory_mode: "off", verdict: "PASS",
      terminal_reason: "converged",
      served_model: { model: "m-manifest", upstream_model: null },
      progress: { turns: 42, problems_before: 23, problems_after: 12 },
      guard_aborted_turns: 2, stalled_turns: 1, cap_cutoffs: 1,
      context_peak: 120000, context_window: 131072,
    },
  ]);
  writeFileSync(
    join(campaign, "batch.json"),
    JSON.stringify({
      schema_version: 1, run_dir: CURRENT_RUN,
      runs: [{ sequence_index: 0, problem_count: 12, scored: true, void_reason: null }],
      median: 12,
    }),
  );
  // The harness's own verdict, written when the cell completed: the card's status.
  writeFileSync(
    join(campaign, "manifest.scorecard.json"),
    JSON.stringify({ scored_sessions: 1, void_instrument: [], not_scored: [] }),
  );
  // The durable launch record (finished): the enumeration's ended source.
  mkdirSync(join(runsRoot, CURRENT_TREE, "launches"), { recursive: true });
  writeFileSync(
    join(runsRoot, CURRENT_TREE, "launches", "r-current.json"),
    JSON.stringify({
      run_id: "r-current", sequence_index: 0, model: "m-current", arm: "off",
      kind: "cell", org: null, context: null, manifest_arg: null,
      pid: 999999, started_at: 1788000000000, log_path: null,
      run_dir: CURRENT_RUN, finished: true, terminal_status: "done", terminal_ok: true,
      ended: { at: 1788009999000, code: 0, signal: null, reason: "exit 0", log_tail: null },
    }),
  );
  // The cell's own stream: 1 loop kill, 1 stall, 1 cap cut-off, ended green.
  writeFileSync(
    join(campaign, "memoryOFF", "cell-0000", "live.jsonl"),
    [
      JSON.stringify({ kind: "heartbeat", ts: 1 }),
      notice("turn_truncated_retried", "guard_abort"),
      notice("turn_truncated_retried", "turn_stalled"),
      cutoff(),
      JSON.stringify({ kind: "attempt.end", attempt: 1, verdict: "PASS", conformed: true, failed: 0, context_peak: 120000, context_window: 131072 }),
      JSON.stringify({ kind: "cell.end", verdict: "PASS", terminal_reason: "converged" }),
    ].join("\n") + "\n",
  );

  // ── the archived run ── backups/<stamp>/<oldTree>/…/model-old
  const oldCampaign = join(runsRoot, ARCHIVED_RUN);
  mkdirSync(join(oldCampaign, "memoryOFF", "cell-0000"), { recursive: true });
  // The campaign manifest (discovery), but NO manifest.status.jsonl and an
  // EMPTY results ledger: the common archived shape — the stream is the only
  // source that states anything.
  writeFileSync(join(oldCampaign, "manifest.json"), JSON.stringify({ created_at: "2026-08-01T00:00:00Z" }));
  writeFileSync(join(runsRoot, "backups", STAMP, "results-ledger.jsonl"), "");
  writeFileSync(
    join(oldCampaign, "memoryOFF", "cell-0000", "live.jsonl"),
    [
      JSON.stringify({ kind: "heartbeat", ts: 1 }),
      notice("turn_truncated_retried", "guard_abort"),
      notice("recovery_budget_exhausted", "guard_abort"),
      notice("turn_truncated_retried", "turn_stalled"),
      cutoff(),
      JSON.stringify({ kind: "attempt.end", attempt: 5, verdict: "FAIL", conformed: false, failed: 24 }),
      JSON.stringify({ kind: "cell.end", verdict: "FAIL", terminal_reason: "harness_error" }),
    ].join("\n") + "\n",
  );

  return runsRoot;
}

/** The fixture's own cards, in list order (any external run is filtered out). */
function fixtureCards(list) {
  return list.filter((c) => c.run_dir === CURRENT_RUN || c.run_dir === ARCHIVED_RUN);
}

test("runs source: id/fields contract", () => {
  assert.equal(id, "runs");
  assert.deepEqual(fields, ["runs"]);
});

test("runs source: enumerates the current cell AND the archived run, newest tree first", async () => {
  const runsRoot = fixture();
  try {
    const res = await read({ runsRoot, benchRoot: runsRoot });
    assert.equal(res.ok, true);
    const { list, counts } = res.patch.runs;

    const cards = fixtureCards(list);
    assert.deepEqual(cards.map((c) => c.run_dir), [CURRENT_RUN, ARCHIVED_RUN],
      "the current tree (9999999999) leads; the archived run (1780000001) follows");
    // The order holds in the RAW list too, not just after filtering.
    assert.ok(
      list.findIndex((c) => c.run_dir === CURRENT_RUN) < list.findIndex((c) => c.run_dir === ARCHIVED_RUN),
      "newest-first is a property of the emitted list",
    );
    assert.equal(cards[0].archived, false);
    assert.equal(cards[1].archived, true);

    // counts is a breakdown of the emitted list by status, whatever else ran.
    assert.equal(counts.total, list.length);
    assert.equal(
      counts.live + counts.scored + counts.void + counts.harness_error,
      counts.total,
    );
    assert.equal(counts.scored >= 1, true);
    assert.equal(counts.harness_error >= 1, true);
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("runs source: each card carries EXACTLY the contract keys, with the stated values", async () => {
  const runsRoot = fixture();
  try {
    const res = await read({ runsRoot, benchRoot: runsRoot });
    const [current, archived] = fixtureCards(res.patch.runs.list);

    for (const card of [current, archived]) {
      assert.deepEqual(Object.keys(card), CARD_KEYS, "the card shape is the shared contract");
    }

    // Current: the launch record states model/arm; the manifest states the
    // measurement; the scorecard states the verdict; the stream states the kills.
    assert.deepEqual(current, {
      run_dir: CURRENT_RUN,
      sequence_index: 0,
      archived: false,
      model: "m-current",
      arm: "off",
      status: "scored",
      problems_before: 23,
      problems_after: 12,
      context_peak: 120000,
      context_window: 131072,
      turns: 42,
      loop_errors: 1,
      stalled_limit_errors: 2, // 1 turn_stalled + 1 length_cutoff
    });

    // Archived: no manifest.status.jsonl, an empty ledger — every unrecorded
    // measurement is null ("not recorded"), NEVER 0; the status is the
    // cell.end terminal_reason; the counts come from the notices.
    assert.deepEqual(archived, {
      run_dir: ARCHIVED_RUN,
      sequence_index: 0,
      archived: true,
      model: null,
      arm: "off", // stated by the harness's own memoryOFF dir name
      status: "harness_error",
      problems_before: null,
      problems_after: null,
      context_peak: null,
      context_window: null,
      turns: null,
      loop_errors: 2, // turn_truncated_retried + recovery_budget_exhausted, guard_abort
      stalled_limit_errors: 2, // 1 turn_stalled + 1 length_cutoff
    });
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("runs source: an archived run's status is its scorecard's verdict — scored is not passed", async () => {
  const runsRoot = fixture();
  try {
    const modelDir = join(runsRoot, ARCHIVED_RUN);
    const livePath = join(modelDir, "memoryOFF", "cell-0000", "live.jsonl");
    // A FAILING cell (never green, never PASS) that the harness scored.
    writeFileSync(livePath, JSON.stringify({ kind: "cell.end", verdict: "FAIL", terminal_reason: "attempt_ceiling_reached" }) + "\n");
    writeFileSync(
      join(modelDir, "manifest.scorecard.json"),
      JSON.stringify({ scored_sessions: 1, void_instrument: [], not_scored: [] }),
    );
    let res = await read({ runsRoot, benchRoot: runsRoot });
    let archived = fixtureCards(res.patch.runs.list).find((c) => c.archived);
    assert.equal(archived.status, "scored", "a failing cell the harness scored is scored");
    assert.equal(archived.turns, null);
    // No notices in this stream: a live stream with none reads 0, not null.
    assert.equal(archived.loop_errors, 0);

    // The harness dropped it (run 1790200233: instrument_fault, once shown SCORED).
    writeFileSync(
      join(modelDir, "manifest.scorecard.json"),
      JSON.stringify({ scored_sessions: 0, void_instrument: [{ sequence_index: 0, void_reason: "instrument_fault" }], not_scored: [] }),
    );
    res = await read({ runsRoot, benchRoot: runsRoot });
    archived = fixtureCards(res.patch.runs.list).find((c) => c.archived);
    assert.equal(archived.status, "void");
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("runs source: a CURRENT run's status is its scorecard's too — never the BASELINES batch record", async () => {
  // Run 1790258326 (seeded from a snapshot, context_exhausted, scored FAIL by
  // the harness) read VOID while current and SCORED once archived: the current
  // path read batch.json, which marks every seeded run not-scored because a
  // seeded run is no floor. That is baseline eligibility, not measurement.
  const runsRoot = fixture();
  try {
    const campaign = join(runsRoot, CURRENT_RUN);
    writeFileSync(
      join(campaign, "batch.json"),
      JSON.stringify({
        schema_version: 1, run_dir: CURRENT_RUN,
        runs: [{ sequence_index: 0, problem_count: null, scored: false, void_reason: "seeded_from_snapshot" }],
        median: null,
      }),
    );
    let res = await read({ runsRoot, benchRoot: runsRoot });
    let current = fixtureCards(res.patch.runs.list).find((c) => !c.archived);
    assert.equal(current.status, "scored", "the harness scored it; the batch only says it is no floor");

    writeFileSync(
      join(campaign, "manifest.scorecard.json"),
      JSON.stringify({ scored_sessions: 0, void_instrument: [{ sequence_index: 0, void_reason: "instrument_fault" }], not_scored: [] }),
    );
    res = await read({ runsRoot, benchRoot: runsRoot });
    current = fixtureCards(res.patch.runs.list).find((c) => !c.archived);
    assert.equal(current.status, "void", "a cell the harness dropped is void, current or archived");
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("runs source: a run that aborted before its status stream reads problems from the grader's reports", async () => {
  // Run 1790202713 (harness_error) wrote no status stream; its attempt reports
  // state the counts. A pass the grader marked not gradable is not one.
  const runsRoot = fixture();
  try {
    const cellDir = join(runsRoot, ARCHIVED_RUN, "memoryOFF", "cell-0000");
    writeFileSync(join(cellDir, "live.jsonl"), JSON.stringify({ kind: "cell.end", verdict: "FAIL", terminal_reason: "harness_error" }) + "\n");
    const probs = (n) => JSON.stringify({ gradable: true, problems: Array.from({ length: n }, (_, i) => ({ check: `c${i}` })) });
    writeFileSync(join(cellDir, "attempt-1-report.json"), probs(28));
    writeFileSync(join(cellDir, "attempt-2-report.json"), probs(27));
    writeFileSync(join(cellDir, "attempt-3-report.json"), JSON.stringify({ gradable: false, problems: [] }));
    const res = await read({ runsRoot, benchRoot: runsRoot });
    const archived = fixtureCards(res.patch.runs.list).find((c) => c.archived);
    assert.equal(archived.status, "harness_error");
    assert.equal(archived.problems_before, 28);
    assert.equal(archived.problems_after, 27, "the unmeasured third pass is not the last measurement");
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});
