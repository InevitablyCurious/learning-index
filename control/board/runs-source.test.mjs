// ─────────────────────────────────────────────────────────────────────────────
// SOURCE: runs — one card per cell of the LIVE tree, and NOTHING from an
// archive root.
//
// The fixture is a whole bench in a tmpdir:
//   · an active tree with one scored v2 cell (launch record + batch + manifest
//     with `system_epoch`, status stream, live.jsonl)                 → living
//   · a legacy FLAT campaign (manifest without `system_epoch`, no status
//     stream, an empty-ish live.jsonl ending harness_error)            → legacy
//   · an archived campaign under backups/<stamp>/<oldTree>/…           → PRUNED
//
// The archived campaign is a complete, readable run on purpose: its absence
// from the list is the prune, not a missing fixture.
//
// Tree ids are chosen so the fixture outranks any real tree (9999999999) and
// the archive under-ranks it (1780000001): order assertions hold even if a real
// bench is running while the suite runs (readRunState's process scan is
// machine-wide). Assertions target the fixture's cards by run_dir for the same
// reason.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { read, id, fields, attemptDelta } from "./sources/runs.mjs";
import { getBoard } from "./lib/board-build.mjs";

const CURRENT_TREE = "9999999999";
const CURRENT_RUN = `${CURRENT_TREE}/local/local-llm-proxy/omlx/model-a`;
const LEGACY_RUN = "legacy-model";
const STAMP = "1790000001";
const OLD_TREE = "1780000001";
const ARCHIVED_RUN = `backups/${STAMP}/${OLD_TREE}/local/local-llm-proxy/omlx/model-old`;

/** The card contract: EXACTLY these keys, in this order, on every card. */
const CARD_KEYS = [
  "run_dir", "sequence_index", "benchmark_id", "cell", "archived", "class",
  "model", "arm", "status", "problems_before", "problems_after",
  "problems_fixed", "problems_broke", "context_peak", "context_window",
  "turns", "loop_errors", "stalled_limit_errors", "system_epoch", "cost",
];

const notice = (event, terminal) =>
  JSON.stringify({ kind: "notice", event, detail: { terminal } });
const cutoff = () =>
  JSON.stringify({ kind: "notice", event: "length_cutoff", detail: { nudged: true, reason: "nudged" } });

function writeJsonl(path, records) {
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** gate_results entries: {id, status, phase, duration_ms}, as the harness writes them. */
const gateResults = (fails, passes) => [
  ...fails.map((gid) => ({ id: gid, status: "fail", phase: "verify", duration_ms: 1 })),
  ...passes.map((gid) => ({ id: gid, status: "pass", phase: "verify", duration_ms: 1 })),
];

/**
 * One attempt record carrying BOTH gate fields, as real records do: the
 * colliding `failed_gates` titles (default: three distinct tests under one
 * bare token, the run-1791151982 [G10] shape — a delta keyed on them sees one
 * gate, not three) and the `gate_results` roster ids the delta must key on.
 */
const G10_TITLES = [
  "[G10] REQ-WINCLASS — classifies single when loser has already borne off",
  "[G10] REQ-WINCLASS — classifies gammon when loser has no off, no bar",
  "[G10] REQ-WINCLASS — a gammon win scores double points",
];
function attemptRec(attempt, fails, passes, failedGates = G10_TITLES) {
  return {
    type: "attempt", sequence_index: 0, attempt, memory_mode: "off",
    failed_gates: failedGates,
    gate_results: gateResults(fails, passes),
    progress: { turns: 10, problems_before: fails.length, problems_after: fails.length },
  };
}

function fixture() {
  const runsRoot = mkdtempSync(join(tmpdir(), "runs-source-"));

  // ── the active tree: a v2 campaign ──
  writeFileSync(
    join(runsRoot, "active-tree.json"),
    JSON.stringify({ active: CURRENT_TREE, created_at: null, history: [] }),
  );
  const campaign = join(runsRoot, CURRENT_RUN);
  mkdirSync(join(campaign, "memoryOFF", "cell-0000"), { recursive: true });
  writeFileSync(
    join(campaign, "manifest.json"),
    JSON.stringify({
      created_at: "2026-11-08T00:00:00Z",
      system_epoch: "2026-11-08", // the v2 declaration → class "living"
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

  // ── a LEGACY FLAT campaign: no tree id, no system_epoch, and (the common
  // old shape) no manifest.status.jsonl — the stream is the only witness. ──
  const legacy = join(runsRoot, LEGACY_RUN);
  mkdirSync(join(legacy, "memoryOFF", "cell-0000"), { recursive: true });
  writeFileSync(join(legacy, "manifest.json"), JSON.stringify({ created_at: "2026-08-01T00:00:00Z" }));
  writeFileSync(
    join(legacy, "memoryOFF", "cell-0000", "live.jsonl"),
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

  // ── an ARCHIVED campaign, complete and readable: it must never surface ──
  const oldCampaign = join(runsRoot, ARCHIVED_RUN);
  mkdirSync(join(oldCampaign, "memoryOFF", "cell-0000"), { recursive: true });
  writeFileSync(
    join(oldCampaign, "manifest.json"),
    JSON.stringify({ created_at: "2026-08-01T00:00:00Z", system_epoch: "2026-11-08" }),
  );
  writeFileSync(join(runsRoot, "backups", STAMP, "results-ledger.jsonl"), "");
  writeFileSync(
    join(oldCampaign, "memoryOFF", "cell-0000", "live.jsonl"),
    [
      JSON.stringify({ kind: "heartbeat", ts: 1 }),
      JSON.stringify({ kind: "cell.end", verdict: "FAIL", terminal_reason: "harness_error" }),
    ].join("\n") + "\n",
  );

  return runsRoot;
}

/** The fixture's own cards, in list order (any external run is filtered out). */
function fixtureCards(list) {
  return list.filter((c) => c.run_dir === CURRENT_RUN || c.run_dir === LEGACY_RUN);
}

test("runs source: id/fields contract", () => {
  assert.equal(id, "runs");
  assert.deepEqual(fields, ["runs"]);
});

test("runs source: enumerates the live root only — the archived campaign never surfaces", async () => {
  const runsRoot = fixture();
  try {
    const res = await read({ runsRoot, benchRoot: runsRoot });
    assert.equal(res.ok, true);
    const { list, counts } = res.patch.runs;

    const cards = fixtureCards(list);
    assert.deepEqual(cards.map((c) => c.run_dir), [CURRENT_RUN, LEGACY_RUN],
      "the v2 tree cell and the legacy flat campaign; nothing else from this root");
    assert.equal(cards[0].class, "living");
    assert.equal(cards[1].class, "legacy");

    // The prune, stated directly: no card names the archive, whatever its epoch.
    assert.equal(list.some((c) => c.run_dir === ARCHIVED_RUN), false);
    assert.equal(list.some((c) => String(c.run_dir ?? "").startsWith("backups/")), false);
    assert.equal(list.some((c) => c.class === "archived"), false, "archived is unrepresentable at the source");

    // counts is a breakdown of the emitted list by status, whatever else ran.
    assert.equal(counts.total, list.length);
    assert.equal(counts.live + counts.scored + counts.void + counts.harness_error, counts.total);
    assert.equal(counts.living + counts.legacy, counts.total, "every card is one lane");
    assert.equal(counts.living, list.filter((c) => c.class === "living").length);
    assert.equal(counts.legacy, list.filter((c) => c.class === "legacy").length);
    // One archived campaign home in the fixture; the unit is the run dir, not the cell.
    assert.equal(counts.archived_excluded, 1);
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
    const [current, legacy] = fixtureCards(res.patch.runs.list);

    for (const card of [current, legacy]) {
      assert.deepEqual(Object.keys(card), CARD_KEYS, "the card shape is the shared contract");
    }

    // Living: the launch record states model/arm; the manifest states the
    // measurement and the epoch; the scorecard states the verdict; the stream
    // states the kills.
    assert.deepEqual(current, {
      run_dir: CURRENT_RUN,
      sequence_index: 0,
      benchmark_id: CURRENT_TREE,
      cell: "local/local-llm-proxy/omlx/model-a/memoryOFF/cell-0000",
      archived: false,
      class: "living",
      model: "m-current",
      arm: "off",
      status: "scored",
      problems_before: 23,
      problems_after: 12,
      problems_fixed: null, // one attempt, no gate_results — no identity delta
      problems_broke: null,
      context_peak: 120000,
      context_window: 131072,
      turns: 42,
      loop_errors: 1,
      stalled_limit_errors: 2, // 1 turn_stalled + 1 length_cutoff
      system_epoch: "2026-11-08",
      cost: null, // the fixture writes no cost.json
    });

    // Legacy: no manifest.status.jsonl — every unrecorded measurement is null
    // ("not recorded"), NEVER 0; the status is the cell.end terminal_reason; the
    // counts come from the notices; the arm from the harness's own dir name.
    assert.deepEqual(legacy, {
      run_dir: LEGACY_RUN,
      sequence_index: 0,
      benchmark_id: LEGACY_RUN,
      cell: "memoryOFF/cell-0000",
      archived: false,
      class: "legacy",
      model: null,
      arm: "off",
      status: "harness_error",
      problems_before: null,
      problems_after: null,
      problems_fixed: null,
      problems_broke: null,
      context_peak: null,
      context_window: null,
      turns: null,
      loop_errors: 2, // turn_truncated_retried + recovery_budget_exhausted, guard_abort
      stalled_limit_errors: 2, // 1 turn_stalled + 1 length_cutoff
      system_epoch: null, // its manifest.json declares no epoch
      cost: null,
    });
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("runs source: a legacy run's status is its scorecard's verdict — scored is not passed", async () => {
  const runsRoot = fixture();
  try {
    const modelDir = join(runsRoot, LEGACY_RUN);
    const livePath = join(modelDir, "memoryOFF", "cell-0000", "live.jsonl");
    // A FAILING cell (never green, never PASS) that the harness scored. Its
    // terminal reason is an ordinary non-void one: a non-green ended cell is
    // just that, with no special name.
    writeFileSync(livePath, JSON.stringify({ kind: "cell.end", verdict: "FAIL", terminal_reason: "stopped" }) + "\n");
    writeFileSync(
      join(modelDir, "manifest.scorecard.json"),
      JSON.stringify({ scored_sessions: 1, void_instrument: [], not_scored: [] }),
    );
    let res = await read({ runsRoot, benchRoot: runsRoot });
    let legacy = fixtureCards(res.patch.runs.list).find((c) => c.run_dir === LEGACY_RUN);
    assert.equal(legacy.status, "scored", "a failing cell the harness scored is scored");
    assert.equal(legacy.turns, null);
    // No notices in this stream: a live stream with none reads 0, not null.
    assert.equal(legacy.loop_errors, 0);

    // The harness dropped it (run 1790200233: instrument_fault, once shown SCORED).
    writeFileSync(
      join(modelDir, "manifest.scorecard.json"),
      JSON.stringify({ scored_sessions: 0, void_instrument: [{ sequence_index: 0, void_reason: "instrument_fault" }], not_scored: [] }),
    );
    res = await read({ runsRoot, benchRoot: runsRoot });
    legacy = fixtureCards(res.patch.runs.list).find((c) => c.run_dir === LEGACY_RUN);
    assert.equal(legacy.status, "void");
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("runs source: a CURRENT run's status is its scorecard's too — never the BASELINES batch record", async () => {
  // Run 1790258326 (scored FAIL by the harness) read VOID while current and
  // SCORED once archived: the current path read batch.json, which marks a run
  // not-scored when it is no baseline floor. That is baseline eligibility, not
  // measurement — the harness's scorecard is the measurement.
  const runsRoot = fixture();
  try {
    const campaign = join(runsRoot, CURRENT_RUN);
    writeFileSync(
      join(campaign, "batch.json"),
      JSON.stringify({
        schema_version: 1, run_dir: CURRENT_RUN,
        runs: [{ sequence_index: 0, problem_count: null, scored: false, void_reason: "void_instrument" }],
        median: null,
      }),
    );
    let res = await read({ runsRoot, benchRoot: runsRoot });
    let current = fixtureCards(res.patch.runs.list).find((c) => c.run_dir === CURRENT_RUN);
    assert.equal(current.status, "scored", "the harness scored it; the batch only says it is no floor");

    writeFileSync(
      join(campaign, "manifest.scorecard.json"),
      JSON.stringify({ scored_sessions: 0, void_instrument: [{ sequence_index: 0, void_reason: "instrument_fault" }], not_scored: [] }),
    );
    res = await read({ runsRoot, benchRoot: runsRoot });
    current = fixtureCards(res.patch.runs.list).find((c) => c.run_dir === CURRENT_RUN);
    assert.equal(current.status, "void", "a cell the harness dropped is void, current or legacy");
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("runs source: peak context counts the cell.end peak — a last round that never reached grading", async () => {
  // Run 1790258326: its last attempt.end said 192,334; the round after it ran
  // out of room at 256,688 and never reached grading, so only cell.end states
  // it. The card said 192k while the TUI said 256k.
  const runsRoot = fixture();
  try {
    const live = join(runsRoot, CURRENT_RUN, "memoryOFF", "cell-0000", "live.jsonl");
    const stream = (endPeak) => writeFileSync(live, [
      JSON.stringify({ kind: "attempt.end", attempt: 1, verdict: "FAIL", failed: 3, context_peak: 120000, context_window: 131072 }),
      JSON.stringify({ kind: "cell.end", verdict: "FAIL", terminal_reason: "context_exhausted", context_peak: endPeak, context_window: 131072 }),
    ].join("\n") + "\n");

    stream(130500);
    let res = await read({ runsRoot, benchRoot: runsRoot });
    let current = fixtureCards(res.patch.runs.list).find((c) => c.run_dir === CURRENT_RUN);
    assert.equal(current.context_peak, 130500, "the cell's own peak, beyond every attempt.end");
    assert.equal(current.context_window, 131072);

    stream(90000);
    res = await read({ runsRoot, benchRoot: runsRoot });
    current = fixtureCards(res.patch.runs.list).find((c) => c.run_dir === CURRENT_RUN);
    assert.equal(current.context_peak, 120000, "the largest stated peak wins; a smaller one never lowers it");
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("runs source: a run that aborted before its status stream reads problems from the grader's reports", async () => {
  // Run 1790202713 (harness_error) wrote no status stream; its attempt reports
  // state the counts. A pass the grader marked not gradable is not one.
  const runsRoot = fixture();
  try {
    const cellDir = join(runsRoot, LEGACY_RUN, "memoryOFF", "cell-0000");
    writeFileSync(join(cellDir, "live.jsonl"), JSON.stringify({ kind: "cell.end", verdict: "FAIL", terminal_reason: "harness_error" }) + "\n");
    const probs = (n) => JSON.stringify({ gradable: true, problems: Array.from({ length: n }, (_, i) => ({ check: `c${i}` })) });
    writeFileSync(join(cellDir, "attempt-1-report.json"), probs(28));
    writeFileSync(join(cellDir, "attempt-2-report.json"), probs(27));
    writeFileSync(join(cellDir, "attempt-3-report.json"), JSON.stringify({ gradable: false, problems: [] }));
    const res = await read({ runsRoot, benchRoot: runsRoot });
    const legacy = fixtureCards(res.patch.runs.list).find((c) => c.run_dir === LEGACY_RUN);
    assert.equal(legacy.status, "harness_error");
    assert.equal(legacy.problems_before, 28);
    assert.equal(legacy.problems_after, 27, "the unmeasured third pass is not the last measurement");
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("runs source: a swap the counts hide — 3 → 3, but one gate fixed and one broke", async () => {
  // The card used to read "problems 3 → 3": attempt 1 fails {A,B,C}, attempt 2
  // fails {B,C,D} — a swap the counts cannot show. The identity delta keys on
  // gate_results[].id; the colliding failed_gates titles (three [G10] tests,
  // one bare token) must never be keyed on, and passing gates (P, and A once
  // fixed) must never count as failed.
  const runsRoot = fixture();
  try {
    writeJsonl(join(runsRoot, CURRENT_RUN, "manifest.status.jsonl"), [
      attemptRec(1, ["A", "B", "C"], ["P"]),
      attemptRec(2, ["B", "C", "D"], ["A", "P"]),
    ]);
    const res = await read({ runsRoot, benchRoot: runsRoot });
    const current = fixtureCards(res.patch.runs.list).find((c) => c.run_dir === CURRENT_RUN);
    assert.equal(current.problems_before, 3);
    assert.equal(current.problems_after, 3, "the counts are unchanged — that is the whole problem");
    assert.equal(current.problems_fixed, 1, "A failed in the first attempt, not the last");
    assert.equal(current.problems_broke, 1, "D failed in the last attempt, not the first");
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("runs source: an empty living root yields no cards and zero counts", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "runs-empty-"));
  try {
    const res = await read({ runsRoot, benchRoot: runsRoot });
    assert.equal(res.ok, true);
    const { list, counts } = res.patch.runs;

    // readRunState's process scan is machine-wide, so a live run on this machine
    // could still produce a card — but never one naming a dir in THIS root.
    assert.equal(list.filter((c) => c.run_dir && existsSync(join(runsRoot, c.run_dir))).length, 0);
    assert.equal(counts.archived_excluded, 0);
    assert.equal(counts.total, list.length);
    assert.equal(counts.living + counts.legacy, counts.total);
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("runs source: the SSE board path serves the pruned set and the archive count", async () => {
  // The dashboard consumes getBoard() raw on /api/stream (no filterBoard), so
  // the prune has to hold at the source the stream serves.
  const runsRoot = fixture();
  try {
    const board = await getBoard({ benchRoot: runsRoot, runsRoot, pollMs: 0, controlUrl: "http://127.0.0.1:9" });
    assert.ok(Array.isArray(board.runs?.list), "the runs source answered");
    assert.equal(board.runs.list.some((c) => c.class === "archived"), false);
    assert.equal(board.runs.list.some((c) => String(c.run_dir ?? "").startsWith("backups/")), false);
    assert.equal(board.runs.counts.archived_excluded, 1);
    assert.equal(board.runs.counts.total, board.runs.list.length);
    assert.equal(board.runs.counts.living + board.runs.counts.legacy, board.runs.counts.total);
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("runs source: attemptDelta — pure fix, pure regression, swap, and the conservative null", () => {
  // Pure fix: {A,B} → {B}. One fixed, nothing broke.
  assert.deepEqual(
    attemptDelta([attemptRec(1, ["A", "B"], []), attemptRec(2, ["B"], ["A"])]),
    { fixed: 1, broke: 0 },
  );
  // Pure regression: {B} → {A,B}.
  assert.deepEqual(
    attemptDelta([attemptRec(1, ["B"], []), attemptRec(2, ["A", "B"], [])]),
    { fixed: 0, broke: 1 },
  );
  // The swap at the helper level: {A,B,C} → {B,C,D}.
  assert.deepEqual(
    attemptDelta([attemptRec(1, ["A", "B", "C"], ["P"]), attemptRec(2, ["B", "C", "D"], ["A", "P"])]),
    { fixed: 1, broke: 1 },
  );
  // Conservative: fewer than two attempts with a usable gate_results array —
  // one attempt, a null gate_results, no records at all — compute nothing.
  assert.equal(attemptDelta([attemptRec(1, ["A"], [])]), null);
  assert.equal(
    attemptDelta([attemptRec(1, ["A"], []), { type: "attempt", attempt: 2, gate_results: null }]),
    null,
  );
  assert.equal(attemptDelta([]), null);
});
