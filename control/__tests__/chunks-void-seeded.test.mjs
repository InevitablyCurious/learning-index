// ─────────────────────────────────────────────────────────────────────────────
// BUILD-CHUNKS FOLD + VOID-INSTRUMENT TESTS — split VERBATIM from
// control/control.test.mjs (lines 3952–4306). Local helpers kept here:
// CHUNKS_ATTEMPT_1, writeTwoAttemptRun, writeStampedRun.
// MIGRATED (run-state contract): the two RUN STATE tests now enumerate from
// durable launch RECORDS + a process scan (`aliveProbe` and log-file
// enumeration are gone); everything after them is byte-identical.
// The seeded-cell section is gone with snapshot seeding itself: no cell carries
// `seeded_from_snapshot`, so there is no seeded fold to pin.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STALL_THRESHOLD_S } from "../contract.mjs";
import { collectCells } from "../baselines.mjs";
import { campaignDirName } from "../campaign.mjs";
import { readRunState } from "../runstate.mjs";
import { writeCampaignCell, writeCellFingerprint, writeCellCost } from "./_shared.mjs";

test("RUN STATE: a killed CLI-launched run does not block reset", async () => {
  const root = mkdtempSync(join(tmpdir(), "runstate-dead-"));
  try {
    const runs = join(root, "runs");

    // Enumeration has exactly two sources: durable launch RECORDS and one
    // process SCAN — never launch-log files. A CLI-launched harness killed
    // mid-cell leaves no record and no live process, so an empty record set
    // over an empty SUCCESSFUL scan is nothing live. (Log recency alone once
    // called this "running" and refused reset for the full 15-minute stall
    // threshold; under the N-run semantics a killed run also DROPS OUT of
    // runs[] — logs are not read at all any more.)
    const state = await readRunState({
      runsRoot: runs,
      launchers: [],
      scan: async () => ({ bound: [], other: [] }),
    });

    assert.deepEqual(state.runs, [], "no record and no process is an abandoned run — nothing is live");
    assert.equal(state.live_count, 0);
    assert.equal(state.state, "idle", "with no record and no harness process, nothing is live");
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
  // What changed is the enumeration and what "gone quiet" MEANS. Enumeration
  // now comes from the durable launch RECORDS plus one process SCAN — never
  // from launch-log files — and "quiet" is a stopped HEARTBEAT over a LIVE
  // process. This test used to age the LOG and expect `stalled`, which encoded
  // log-mtime as a liveness signal — and that is precisely the inference that
  // put `CELL STALLED — SILENT 21:49` in the header of a working cell, because
  // the harness logs at phase boundaries and one phase ran 86 model turns. A
  // quiet log with a beating heart is just a long phase.
  const root = mkdtempSync(join(tmpdir(), "runstate-quiet-"));
  try {
    const runs = join(root, "runs");
    const dir = campaignDirName("qwen/qwen3.6-flash");
    writeCampaignCell(runs, dir, { gates: [{ id: "CONF" }], results: [] });

    // One durable launch record: the control plane spawned this cell and its
    // process still exists. `scan: async () => null` is a FAILED scan —
    // indeterminate never ends a run, so the record stays live by default.
    const record = {
      run_id: "run-quiet",
      sequence_index: 0,
      model: "m-a",
      arm: "off",
      kind: "local",
      org: null,
      context: null,
      manifest_arg: null,
      pid: process.pid,
      started_at: Date.now(),
      log_path: null,
      run_dir: dir,
      finished: false,
      terminal_status: null,
      terminal_ok: null,
    };

    // THE HEARTBEAT STOPPED — genuinely wedged.
    const wedged = await readRunState({
      runsRoot: runs,
      launchers: [record],
      scan: async () => null,
      heartbeatProbe: () => (STALL_THRESHOLD_S + 120) * 1000,
    });
    // Log recency alone once called this "failed" and OFFERED a reset while the
    // cell was still running — precisely the loss treeResetGate exists to
    // prevent. Quiet is not dead.
    assert.equal(wedged.state, "stalled");
    assert.equal(wedged.can_start, false, "a stalled-but-alive cell still holds the tree");
    // The block is PER RUN now — it names this cell's own state, never a
    // global OFF-concurrency rule (N cells may be live, each blocking itself).
    assert.match(String(wedged.blocked_reason), /this cell is stalled/);
    assert.match(String(wedged.blocked_reason), /already in flight/);
    assert.equal(wedged.runs.length, 1, "a stalled run is still a live run");
    assert.equal(wedged.runs[0].can_start, false, "per-run: this cell cannot be started again");

    // THE HEART IS BEATING — the cell is fine. It still blocks reset, because
    // it is still running.
    const working = await readRunState({
      runsRoot: runs,
      launchers: [record],
      scan: async () => null,
      heartbeatProbe: () => 2000,
    });
    assert.equal(working.state, "running", "a beating cell is not wedged, whatever the log says");
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

// ── VOID-INSTRUMENT: the harness's cost.json stamp is the single truth ───────
//
// RUNBOOK 5.10 has ONE definition — harness/cumulative/run_artifacts.py
// `cell_void()` — and scripts/run_cumulative/runner.py writes its verdict into
// the cell's cost.json as `void: { is_void, reason }`. This module used to
// re-derive that rule from the status stream, and the re-derivation had already
// drifted: it voided `harness_error` (not a void signal) and never read
// `observation_lost_turns` (a void signal). The tests below write the stamp and
// assert the fold follows it — never a second opinion.
//
// A cell that produced NO stamp predates the writer: pre-standard, and NOT void.
function writeStampedRun(root, { verdict = "FAIL", stamp = null } = {}) {
  const d = join(root, "cumulative");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "manifest.json"), JSON.stringify({
    created_at: "2026-09-04T00:00:00Z",
    schedule: [{ sequence_index: 0, memory_mode: "off", provider_pin: "m-a" }],
  }));
  const a1 = {
    type: "attempt", sequence_index: 0, attempt: 5, verdict,
    progress: { turns: 479, total_tokens: 297344, build_chunks: [] },
  };
  writeFileSync(join(d, "manifest.status.jsonl"), `${JSON.stringify(a1)}\n`);
  writeCellFingerprint(d, 0);
  if (stamp) writeCellCost(d, 0, { record: stamp });
  return d;
}

test("VOID-INSTRUMENT: a cell the harness stamped void folds as void — no second opinion", async () => {
  const root = mkdtempSync(join(tmpdir(), "void-stamped-"));
  try {
    writeStampedRun(root, {
      stamp: {
        outcome: "failed",
        phases: { total: { turns: 479, wall_seconds: 3600 } },
        void: { is_void: true, reason: "provider_truncation" },
      },
    });
    const cells = await collectCells(root);
    assert.equal(cells.length, 1);
    assert.equal(
      cells[0].void_instrument,
      true,
      "the harness said this cell measured itself — the fold must agree, or a corrupted cell stands as a model's floor",
    );
    assert.equal(
      cells[0].cost.void.reason,
      "provider_truncation",
      "the stamp's own reason rides on the attached cost record — the fold never invents one",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("VOID-INSTRUMENT: a LOOPING model is not void — the stamp says so", async () => {
  // Jerry's ruling, 2026-09-05: nudging on a loop is model behaviour, not a
  // void classifier. Measured on run 1788599410 — five graded attempts, 39/53
  // passing, discarded because all three anomalous turns were
  // `terminal: guard_abort` (clean `finish_reason: "tool-calls"`,
  // `truncations_seen: 0`, every one retried and recovered). The harness
  // counts only UNRECOVERED anomalies as a void signal, and stamps the cell
  // non-void accordingly.
  const root = mkdtempSync(join(tmpdir(), "void-loop-"));
  try {
    writeStampedRun(root, {
      stamp: {
        outcome: "failed",
        phases: { total: { turns: 479 } },
        void: { is_void: false, reason: null },
      },
    });
    const cells = await collectCells(root);
    assert.equal(
      cells[0].void_instrument,
      false,
      "a model the harness caught looping is a capability observation — voiding it deletes the finding",
    );
    assert.equal(cells[0].cost.void.reason, null, "a non-void stamp carries no reason");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("VOID-INSTRUMENT: a clean non-green cell (stamp non-void) is NOT void", async () => {
  const root = mkdtempSync(join(tmpdir(), "void-clean-"));
  try {
    // THE GENERIC RULE: any cell that ended for a reason other than an
    // instrument fault is NOT void — every ending is treated alike, none is
    // special-cased and none is capped. A plain FAIL is a stand-in for that
    // whole class, not a named exception.
    writeStampedRun(root, {
      stamp: { outcome: "failed", phases: {}, void: { is_void: false, reason: null } },
    });
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

test("VOID-INSTRUMENT: a cell with NO cost.json is not void — pre-standard is not a verdict", async () => {
  // Cells run before the stamp existed carry nothing to read. Absence is not an
  // instrument fault, so it must not void them; and because they carry no
  // phase total they fall outside every per-fingerprint aggregate anyway.
  const root = mkdtempSync(join(tmpdir(), "void-prestamp-"));
  try {
    writeStampedRun(root, { stamp: null });
    const cells = await collectCells(root);
    assert.equal(cells[0].cost, null, "no stamp → null, never a fabricated one");
    assert.equal(cells[0].void_instrument, false, "an absent stamp is pre-standard, never void");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
