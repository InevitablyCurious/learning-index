// ─────────────────────────────────────────────────────────────────────────────
// BUILD-CHUNKS VOID + SEEDED-CELL TESTS — split VERBATIM from
// control/control.test.mjs (lines 3952–4306). Local helpers kept here:
// CHUNKS_ATTEMPT_1, writeTwoAttemptRun, writeTruncatedRun, writeSeededRun.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STALL_THRESHOLD_S } from "../contract.mjs";
import { collectCells, collectOffCells, baselineFor } from "../baselines.mjs";
import { campaignDirName } from "../campaign.mjs";
import { readRunState } from "../runstate.mjs";
import { readModelsLedger } from "../models-ledger.mjs";
import { writeCampaignCell } from "./_shared.mjs";

test("RUN STATE: a killed CLI-launched run does not block reset behind a fresh log", async () => {
  const root = mkdtempSync(join(tmpdir(), "runstate-dead-"));
  try {
    const runs = join(root, "runs");
    const dir = campaignDirName("qwen/qwen3.6-flash");
    writeCampaignCell(runs, dir, { gates: [{ id: "CONF" }], results: [] });

    // Log written moments ago, process gone: the state immediately after a
    // harness is killed mid-cell. Log recency alone called this "running" and
    // refused reset for the full 15-minute stall threshold.
    const state = await readRunState({
      runsRoot: runs,
      launcher: null,
      aliveProbe: async () => false,
    });

    assert.equal(state.state, "failed", "no terminal record and no process is an abandoned run");
    assert.equal(
      state.can_start,
      true,
      "reset/restore must not be refused over a process that is already gone",
    );
    assert.equal(state.blocked_reason, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RUN STATE: a LIVE run that has gone quiet still blocks reset", async () => {
  // ── INTENT PRESERVED, MECHANISM REPLACED ──────────────────────────────────
  //
  // The property this has always protected is the dangerous direction: never
  // OFFER a reset over a cell that is still running. That is unchanged and is
  // what the `can_start` assertions below hold.
  //
  // What changed is what "gone quiet" MEANS. This test used to age the LOG and
  // expect `stalled`, which encoded log-mtime as a liveness signal — and that
  // is precisely the inference that put `CELL STALLED — SILENT 21:49` in the
  // header of a working cell, because the harness logs at phase boundaries and
  // one phase ran 86 model turns. Quiet is now a stopped HEARTBEAT, and a
  // quiet log with a beating heart is just a long phase.
  const root = mkdtempSync(join(tmpdir(), "runstate-quiet-"));
  try {
    const runs = join(root, "runs");
    const dir = campaignDirName("qwen/qwen3.6-flash");
    writeCampaignCell(runs, dir, { gates: [{ id: "CONF" }], results: [] });

    const first = await readRunState({ runsRoot: runs, launcher: null, aliveProbe: async () => true });
    // Age the log well past the stall threshold, process still alive.
    const old = Date.now() / 1000 - (STALL_THRESHOLD_S + 120);
    utimesSync(first.log_path, old, old);

    // THE HEARTBEAT STOPPED — genuinely wedged.
    const wedged = await readRunState({
      runsRoot: runs,
      launcher: null,
      aliveProbe: async () => true,
      heartbeatProbe: async () => (STALL_THRESHOLD_S + 120) * 1000,
    });
    // Log recency alone once called this "failed" and OFFERED a reset while the
    // cell was still running — precisely the loss treeResetGate exists to
    // prevent. Quiet is not dead.
    assert.equal(wedged.state, "stalled");
    assert.equal(wedged.can_start, false, "a stalled-but-alive cell still holds the tree");
    assert.match(String(wedged.blocked_reason), /strictly serial/);

    // THE HEART IS BEATING — the same stale log, and the cell is fine. It still
    // blocks reset, because it is still running.
    const working = await readRunState({
      runsRoot: runs,
      launcher: null,
      aliveProbe: async () => true,
      heartbeatProbe: async () => 2000,
    });
    assert.equal(working.state, "running", "a stale log over a beating cell is a long phase");
    assert.equal(working.can_start, false, "still running, so reset stays refused");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── WO-CHUNKVIS-1: BUILD CHUNKS FOLD FIRST-NON-EMPTY ───────────────────────
//
// Build chunks exist ONLY on attempt 1 — attempts 2+ are single-prompt feedback
// drives that run no chunks and carry an empty list. Folding them by the
// `gate_totals` rule (last attempt wins) would blank the strip the instant
// attempt 2 landed, and the operator would watch the build record vanish from a
// cell that is merely still being graded.

const CHUNKS_ATTEMPT_1 = [
  { chunk: 1, state: "complete", marker: true },
  { chunk: 2, state: "complete", marker: true },
  { chunk: 3, state: "complete", marker: true },
  { chunk: 4, state: "died", marker: false, reason: "run_timeout" },
  { chunk: 5, state: "not_reached", marker: false },
  { chunk: 6, state: "not_reached", marker: false },
];

function writeTwoAttemptRun(root, { chunksOnFirst = true } = {}) {
  const d = join(root, "cumulative");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "manifest.json"), JSON.stringify({
    created_at: "2026-08-26T00:00:00Z",
    schedule: [{ sequence_index: 0, memory_mode: "off", provider_pin: "m-a" }],
  }));
  const a1 = { type: "attempt", sequence_index: 0, attempt: 1, verdict: "FAIL",
    progress: { turns: 9, total_tokens: 400,
      build_chunks: chunksOnFirst ? CHUNKS_ATTEMPT_1 : [] } };
  // Attempt 2: a feedback drive. No chunks ran, so the list is EMPTY.
  const a2 = { type: "attempt", sequence_index: 0, attempt: 2, verdict: "PASS",
    progress: { turns: 4, total_tokens: 120, build_chunks: [] } };
  writeFileSync(join(d, "manifest.status.jsonl"),
    `${JSON.stringify(a1)}\n${JSON.stringify(a2)}\n`);
  return d;
}

test("CHUNKS: attempt 2's empty list must not blank attempt 1's build record", async () => {
  const root = mkdtempSync(join(tmpdir(), "chunkvis-"));
  try {
    writeTwoAttemptRun(root);
    const cells = await collectCells(root);
    assert.equal(cells.length, 1);

    const chunks = cells[0].build_chunks;
    assert.ok(Array.isArray(chunks), "the build record must survive a later feedback attempt");
    assert.equal(chunks.length, 6);
    assert.deepEqual(chunks.map((c) => c.state), [
      "complete", "complete", "complete", "died", "not_reached", "not_reached",
    ]);
    assert.equal(chunks[3].reason, "run_timeout", "the culprit stays named");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CHUNKS: a cell that never ran a build reports null, never 'all incomplete'", async () => {
  const root = mkdtempSync(join(tmpdir(), "chunkvis-none-"));
  try {
    writeTwoAttemptRun(root, { chunksOnFirst: false });
    const cells = await collectCells(root);
    assert.equal(
      cells[0].build_chunks,
      null,
      "absent data must render as 'no data' — reporting six incomplete chunks would cry wolf",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── VOID-INSTRUMENT: truncated_turns/length_truncations live on the record,
// not on `progress` ──────────────────────────────────────────────────────────
//
// THE MEASURED DEFECT (found via a real OFF baseline, run 1788537083,
// qwen3.6-35b-a3b-bench): the harness scorer voided the cell
// (`provider_truncation`, 35 truncated turns) while this file's own fold
// reported `scorable: true` with a real 44/53 gate tally — the two void
// definitions the header comment says must never disagree, disagreeing. Cause:
// the fold read `p.truncated_turns` / `p.length_truncations` where
// `p = r.progress`, but the harness writes both fields as SIBLINGS of
// `progress`, not inside it. `int(undefined) ?? 0` is always zero, so the
// `truncated_turns > 0` void condition could never fire — a `terminal_reason`
// other than `transport_incomplete`/`harness_error` (e.g.
// `attempt_ceiling_reached`, which alone is NOT void — a model failing every
// attempt is a real capability result) then folded the cell as scorable no
// matter how many turns had been truncated.
// `unrecoveredAnomalyTurns` defaults to `truncatedTurns` so every existing caller
// keeps meaning "a genuine instrument anomaly". Pass 0 to write the loop-guard
// case: turns were anomalous, but the harness recovered every one of them.
function writeTruncatedRun(root, {
  terminalReason = "attempt_ceiling_reached",
  truncatedTurns = 35,
  unrecoveredAnomalyTurns = undefined,
} = {}) {
  const d = join(root, "cumulative");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "manifest.json"), JSON.stringify({
    created_at: "2026-09-04T00:00:00Z",
    schedule: [{ sequence_index: 0, memory_mode: "off", provider_pin: "m-a" }],
  }));
  const a1 = {
    type: "attempt", sequence_index: 0, attempt: 5, verdict: "FAIL",
    terminal_reason: terminalReason,
    truncated_turns: truncatedTurns,
    unrecovered_anomaly_turns: unrecoveredAnomalyTurns ?? truncatedTurns,
    length_truncations: 0,
    progress: { turns: 479, total_tokens: 297344, build_chunks: [] },
  };
  writeFileSync(join(d, "manifest.status.jsonl"), `${JSON.stringify(a1)}\n`);
  return d;
}

test("VOID-INSTRUMENT: a cell with truncated turns must fold as void, matching the harness scorer", async () => {
  const root = mkdtempSync(join(tmpdir(), "void-truncated-"));
  try {
    writeTruncatedRun(root);
    const cells = await collectCells(root);
    assert.equal(cells.length, 1);
    assert.equal(
      cells[0].void_instrument,
      true,
      "35 truncated turns must void the cell here exactly as harness/cumulative/run_artifacts.py voids it — a disagreement lets a corrupted cell stand as a model's floor",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("VOID-INSTRUMENT: a LOOPING model is not void — the ledger must agree with the scorer", async () => {
  // Jerry's ruling, 2026-09-05: nudging on a loop is model behaviour, not a
  // void classifier. Measured on run 1788599410 — five graded attempts, 39/53
  // passing, discarded because all three anomalous turns were
  // `terminal: guard_abort` (clean `finish_reason: "tool-calls"`,
  // `truncations_seen: 0`, every one retried and recovered).
  //
  // `truncated_turns` counts every anomaly including those aborts;
  // `unrecovered_anomaly_turns` counts only the anomalies the harness did NOT
  // recover — a recovered `guard_abort` / `provider_unavailable` /
  // `stream_finalize_timeout` never voids — and is what all three
  // implementations of this rule now read. This asserts the ledger half.
  const root = mkdtempSync(join(tmpdir(), "void-loop-"));
  try {
    writeTruncatedRun(root, { truncatedTurns: 3, unrecoveredAnomalyTurns: 0 });
    const cells = await collectCells(root);
    assert.equal(
      cells[0].void_instrument,
      false,
      "a model the harness caught looping is a capability observation — voiding it deletes the finding",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("VOID-INSTRUMENT: a clean attempt_ceiling_reached cell (no truncation) is NOT void", async () => {
  const root = mkdtempSync(join(tmpdir(), "void-clean-"));
  try {
    writeTruncatedRun(root, { truncatedTurns: 0 });
    const cells = await collectCells(root);
    assert.equal(
      cells[0].void_instrument,
      false,
      "a model failing every attempt with no instrument fault is a real capability result, not void",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── WO-SNAP-03: A SEEDED CELL IS NEVER A FLOOR ─────────────────────────────
//
// `seeded_from_snapshot` is written TOP-LEVEL on the attempt record — a sibling
// of `progress`, the same field-path trap as the truncation counters above. The
// producer ships in WO-SNAP-04; until then only these tests synthesize it, and
// the fold must already refuse it: a seeded cell skips the build, so its
// turn/token totals sit on a different scale than the floor a Δ is measured
// against. The property is bidirectional — seeded never scores, unseeded still
// does.
function writeSeededRun(root, { dir = "cumulative", snapshotId = "snap-fixture-1" } = {}) {
  const d = join(root, dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "manifest.json"), JSON.stringify({
    created_at: "2026-09-04T00:00:00Z",
    schedule: [{ sequence_index: 0, memory_mode: "off", provider_pin: "m-a" }],
  }));
  const a1 = {
    type: "attempt", sequence_index: 0, attempt: 5, verdict: "PASS",
    progress: { turns: 12, total_tokens: 900, build_chunks: [] },
  };
  // TOP-LEVEL — sibling of `progress`, never inside it.
  if (snapshotId !== null) a1.seeded_from_snapshot = snapshotId;
  writeFileSync(join(d, "manifest.status.jsonl"), `${JSON.stringify(a1)}\n`);
  return d;
}

test("SEEDED: a cell carrying seeded_from_snapshot folds with the id and never scores", async () => {
  const root = mkdtempSync(join(tmpdir(), "seeded-off-"));
  try {
    writeSeededRun(root);
    const cells = await collectCells(root);
    assert.equal(cells.length, 1);
    assert.equal(
      cells[0].seeded_from_snapshot,
      "snap-fixture-1",
      "the fold must carry the id from the TOP-LEVEL record field — reading r.progress.seeded_from_snapshot would silently null it",
    );

    const b = baselineFor("m-a", await collectOffCells(root));
    assert.equal(b.scorable, false, "a seeded cell must never become a model's floor — even complete, PASS, non-void");
    assert.equal(b.seeded, true);
    assert.equal(b.voided, undefined, "no voided flag — baselineList must compute state 'none' and drop the row");
    assert.equal(b.pending, undefined, "no pending flag either");
    assert.equal(
      b.reason,
      "seeded from snapshot `snap-fixture-1` — a seeded cell skips the build and sits on a different turn/token scale than the floor a Δ is measured against.",
      "the refusal sentence is spec'd verbatim — backticks, em-dash and Δ included",
    );

    // THE SAFETY PROPERTY, END TO END: the ledger's baseline_rows — what
    // PROFILE·1 renders — must not carry a row for the seeded cell's model.
    const led = await readModelsLedger({
      runsRoot: root,
      benchModels: [{ id: "m-a", bench_eligible: true }],
      runInFlight: false,
    });
    assert.equal(led.models[0].baseline.scorable, false);
    assert.equal(led.baseline_rows.length, 0, "state 'none' drops the row — a seeded cell never appears in baseline_rows");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SEEDED: the same cell WITHOUT the field stays a scorable floor", async () => {
  const root = mkdtempSync(join(tmpdir(), "seeded-clean-"));
  try {
    writeSeededRun(root, { snapshotId: null });
    const cells = await collectCells(root);
    assert.equal(cells[0].seeded_from_snapshot, null, "an absent field folds to null, never undefined");

    const b = baselineFor("m-a", await collectOffCells(root));
    assert.equal(b.scorable, true, "a complete, non-void, unseeded OFF cell is a valid floor");
    assert.equal(b.exists, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SEEDED: a model with BOTH a seeded and an unseeded OFF cell keeps the unseeded floor", async () => {
  const root = mkdtempSync(join(tmpdir(), "seeded-mixed-"));
  try {
    writeSeededRun(root, { dir: "cumulative-seeded" });
    writeSeededRun(root, { dir: "cumulative-real", snapshotId: null });
    const offCells = await collectOffCells(root);
    assert.equal(offCells.length, 2);

    const b = baselineFor("m-a", offCells);
    assert.equal(b.scorable, true, "the unseeded cell remains the floor");
    assert.equal(b.run_dir, "cumulative-real", "the resolved floor is the unseeded cell, whichever order the walk found them");
    assert.equal(b.candidates, 1, "the seeded cell is not a candidate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── run state publishes the boolean its callers read ────────────────────────
//
// THE MEASURED DEFECT: `running` was computed inside readRunState and never
// returned. Four call sites in server.mjs read `state.running` and all four got
// `undefined` — STOP refused every live cell, and the guard that stops
// worker-image-rebuild from rebuilding the substrate under a running cell never
// fired once.
//
// Pinned on the CONTRACT (the field exists and agrees with `state`) rather than
// on any one caller, because the bug was that the field was absent for all of
// them.
