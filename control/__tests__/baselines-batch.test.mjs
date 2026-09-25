// Pins the batch groundwork in baselines.mjs: the eight fingerprint inputs
// collected from the measured repo + run-manifest, and batch assembly —
// median over SCORED runs, voids excluded and never counted as failures —
// persisted to batch.json. Temp dirs for runDir; repo hashes are live.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assembleBatchForCells, collectCells } from "../baselines.mjs";
import { FINGERPRINT_INPUTS, hashDir } from "../batch.mjs";
import { BENCH, FIXTURE_FP, setFixtureCode } from "./_shared.mjs";

// Frozen by the Python hash (harness/fingerprint.py dir_hash, and the older
// compute_task_template_hash) over task/backgammon/{scaffold,golden}. The
// scaffold's is declared by the challenge (challenge.json scaffold_hash, pinned
// by the Python freeze guard) and read from there, so a re-freeze changes one
// place.
const FROZEN_SCAFFOLD_HASH = JSON.parse(
  await fs.readFile(path.join(BENCH, "task", "backgammon", "challenge.json"), "utf8"),
).scaffold_hash;
const FROZEN_GOLDEN_HASH =
  "312720b56bd5b10f79da3a58cc034fbe977ce1a1b7f0512c1afdfc20e8ddd9eb";

const INPUT_NAMES = FINGERPRINT_INPUTS.map((i) => i.name);

/** A tmpdir run dir, optionally carrying a run-manifest. */
async function makeRunDir(t, manifest) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "baselines-batch-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  if (manifest !== undefined) {
    await fs.writeFile(
      path.join(dir, "manifest.run-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  }
  return dir;
}

/** A minimal OFF cell in the shape collectCells folds; override any field. */
function cell(overrides = {}) {
  return {
    sequence_index: 0,
    state: "complete",
    void_instrument: false,
    seeded_from_snapshot: null,
    context_exhausted: false,
    gates: { passed: 1, failed: 0, error: 0, not_run: 0, total: 1 },
    terminal_reason: null,
    problems_before: 0,
    contention: null,
    // What the cell recorded it ran on (harness/fingerprint.py).
    fingerprint: FIXTURE_FP,
    ...overrides,
  };
}

test("BASELINES-BATCH: assembleBatchForCells persists batch.json — scored/void split, median, fingerprint", async (t) => {
  const runDir = await makeRunDir(t);

  const cells = [
    cell({ sequence_index: 0, problems_before: 10 }),
    cell({ sequence_index: 1, void_instrument: true, terminal_reason: "transport_incomplete", problems_before: 3 }),
    cell({ sequence_index: 2, seeded_from_snapshot: "snap-1", problems_before: 4 }),
    cell({ sequence_index: 3, state: "not_started", gates: null, problems_before: null }),
    cell({ sequence_index: 4, context_exhausted: true, gates: null, problems_before: null }),
    cell({ sequence_index: 5, problems_before: 20 }),
    cell({ sequence_index: 6, problems_before: 30 }),
  ];

  const batch = await assembleBatchForCells({ runDir, cells });

  // Persisted atomically, and byte-identical to the returned record.
  const onDisk = JSON.parse(await fs.readFile(path.join(runDir, "batch.json"), "utf8"));
  assert.deepEqual(onDisk, batch);

  assert.equal(batch.scored_count, 3);
  assert.equal(batch.void_count, 4);
  assert.equal(batch.median, 20); // median of {10,20,30}; voids never enter
  assert.equal(batch.selection, null);
  assert.equal(batch.void, false);

  assert.deepEqual(
    batch.runs.map((r) => [r.sequence_index, r.problem_count, r.scored, r.void_reason]),
    [
      [0, 10, true, null],
      [1, null, false, "void_instrument"],
      [2, null, false, "seeded_from_snapshot"],
      [3, null, false, "not_started"],
      [4, null, false, "context_exhausted"],
      [5, 20, true, null],
      [6, 30, true, null],
    ],
  );

  // The fingerprint is what the CELLS recorded, in canonical order — never the repo.
  assert.deepEqual(Object.keys(batch.fingerprint.values), INPUT_NAMES);
  assert.match(batch.fingerprint.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(batch.fingerprint.values, FIXTURE_FP);
});

test("BASELINES-BATCH: a cell that ran without recording makes the batch unfingerprinted — never a floor", async (t) => {
  const runDir = await makeRunDir(t);
  const batch = await assembleBatchForCells({
    runDir,
    cells: [cell({ sequence_index: 0, problems_before: 5 }), cell({ sequence_index: 1, problems_before: 6, fingerprint: null })],
  });
  assert.equal(batch.void, true);
  assert.equal(batch.void_kind, "unfingerprinted");
  assert.equal(batch.fingerprint, null, "no fingerprint is made up for it");
  assert.match(batch.void_reason, /s0001 recorded nothing/);
});

test("BASELINES-BATCH: cells that ran on different inputs make the batch mixed, naming the input", async (t) => {
  const runDir = await makeRunDir(t);
  const batch = await assembleBatchForCells({
    runDir,
    cells: [
      cell({ sequence_index: 0, problems_before: 5 }),
      cell({ sequence_index: 1, problems_before: 6, fingerprint: { ...FIXTURE_FP, grader_hash: "x".repeat(64) } }),
    ],
  });
  assert.equal(batch.void, true);
  assert.equal(batch.void_kind, "mixed");
  assert.equal(batch.void_input, "grader_hash");
  assert.match(batch.void_reason, /s0000 and s0001 ran on different grader_hash/);
});

test("BASELINES-BATCH: a batch whose recorded code differs from the current code is superseded", async (t) => {
  const runDir = await makeRunDir(t);
  setFixtureCode({ golden_hash: "n".repeat(64) });
  t.after(() => setFixtureCode());
  const batch = await assembleBatchForCells({ runDir, cells: [cell({ problems_before: 5 })] });
  assert.equal(batch.void, true);
  assert.equal(batch.void_kind, "superseded");
  assert.equal(batch.void_input, "golden_hash");
  assert.deepEqual(batch.fingerprint.values, FIXTURE_FP, "the recorded fingerprint is kept, not overwritten");
});

test("BASELINES-BATCH: a context-exhausted cell is excluded from the median, not treated as a failure", async (t) => {
  const runDir = await makeRunDir(t);

  const cells = [
    cell({ sequence_index: 0, problems_before: 24 }),
    cell({ sequence_index: 1, context_exhausted: true, gates: null, problems_before: null }),
    cell({ sequence_index: 2, problems_before: 22 }),
    cell({ sequence_index: 3, problems_before: 26 }),
  ];

  const batch = await assembleBatchForCells({ runDir, cells });

  assert.equal(batch.median, 24); // median of {22,24,26} — the void is absent, not a zero
  assert.equal(batch.scored_count, 3);
  assert.equal(batch.void_count, 1);
  assert.deepEqual(batch.runs[1], {
    sequence_index: 1,
    problem_count: null,
    scored: false,
    void_reason: "context_exhausted",
    contention: null,
  });
});

test("BASELINES-BATCH: hashDir matches the Python hash of the frozen scaffold and golden, byte for byte", async () => {
  // harness/fingerprint.py records these at a cell's start with the same
  // algorithm; the control plane re-hashes the current tree with hashDir to
  // compare. If these drift, every batch would read as superseded.
  assert.equal(await hashDir(path.join(BENCH, "task", "backgammon", "scaffold")), FROZEN_SCAFFOLD_HASH);
  assert.equal(await hashDir(path.join(BENCH, "task", "backgammon", "golden")), FROZEN_GOLDEN_HASH);
});

test("BASELINES-BATCH: per-run contention rides onto batch.runs[] and the summary aggregates scored runs only", async (t) => {
  const runDir = await makeRunDir(t);
  const crowded = {
    http_429_count: 2, http_402_count: null, retry_count: 3, upstream_error_count: 1,
    max_request_ms: 900, median_request_ms: 120, wall_near_timeout: true,
  };
  const quiet = {
    http_429_count: 0, http_402_count: 0, retry_count: 0, upstream_error_count: 0,
    max_request_ms: 200, median_request_ms: 90, wall_near_timeout: false,
  };
  const cells = [
    cell({ sequence_index: 0, problems_before: 10, contention: crowded }),
    cell({ sequence_index: 1, problems_before: 20, contention: quiet }),
    cell({
      sequence_index: 2, void_instrument: true, terminal_reason: "transport_incomplete",
      problems_before: 5, contention: { ...crowded, http_429_count: 50 },
    }),
    cell({ sequence_index: 3, state: "not_started", gates: null, problems_before: null }),
  ];

  const batch = await assembleBatchForCells({ runDir, cells });

  assert.deepEqual(batch.runs[0].contention, crowded);
  assert.deepEqual(batch.runs[1].contention, quiet);
  assert.equal(batch.runs[2].contention.http_429_count, 50,
    "a void run still SAYS its conditions — it is only kept out of the summary");
  assert.equal(batch.runs[3].contention, null, "never measured → null, never fabricated");

  assert.deepEqual(batch.contention, {
    http_429_count: 2, // SUM 2 + 0; the void run's 50 never enters
    http_402_count: 0, // SUM; null contributes nothing
    retry_count: 3, // SUM 3 + 0
    upstream_error_count: 1, // SUM 1 + 0
    max_request_ms: 900, // MAX over scored
    median_request_ms: 120, // MAX over scored
    wall_near_timeout: true, // ANY over scored
  });
});

test("BASELINES-BATCH: collectCells folds the seven contention covariates out of the status stream's progress dicts", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "baselines-contention-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const camp = path.join(root, "cumulative");
  await fs.mkdir(camp, { recursive: true });
  await fs.writeFile(path.join(camp, "manifest.json"), JSON.stringify({
    created_at: "2026-09-22T00:00:00Z",
    schedule: [
      { sequence_index: 0, memory_mode: "off", provider_pin: "m-a" },
      { sequence_index: 1, memory_mode: "off", provider_pin: "m-a" },
    ],
  }), "utf8");

  // The covariates arrive FLAT in `progress` (ProgressVector.to_dict).
  const a1 = {
    type: "attempt", sequence_index: 0, attempt: 1, verdict: "FAIL",
    progress: {
      turns: 9, http_429_count: 2, http_402_count: null, retry_count: 3,
      upstream_error_count: 1, max_request_ms: 900, median_request_ms: 120,
      wall_near_timeout: true,
    },
  };
  // A later attempt that measured nothing must not blank the measurement
  // (sticky per field, like every other fold measurement).
  const a2 = {
    type: "attempt", sequence_index: 0, attempt: 2, verdict: "PASS",
    progress: {
      turns: 4, http_429_count: null, http_402_count: null, retry_count: null,
      upstream_error_count: null, max_request_ms: null, median_request_ms: null,
      wall_near_timeout: null,
    },
  };
  // A cell whose contention was never measured at all (spend DB unavailable):
  // the keys are simply absent from `progress`.
  const b1 = {
    type: "attempt", sequence_index: 1, attempt: 1, verdict: "PASS",
    progress: { turns: 7 },
  };
  await fs.writeFile(
    path.join(camp, "manifest.status.jsonl"),
    [a1, a2, b1].map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8",
  );

  const cells = await collectCells(root);
  assert.equal(cells.length, 2);
  const bySeq = Object.fromEntries(cells.map((c) => [c.sequence_index, c]));

  assert.deepEqual(bySeq[0].contention, {
    http_429_count: 2, http_402_count: null, retry_count: 3, upstream_error_count: 1,
    max_request_ms: 900, median_request_ms: 120, wall_near_timeout: true,
  }, "measured values survive a later all-null record; null stays null (never 0)");

  assert.deepEqual(bySeq[1].contention, {
    http_429_count: null, http_402_count: null, retry_count: null, upstream_error_count: null,
    max_request_ms: null, median_request_ms: null, wall_near_timeout: null,
  }, "never measured → all seven null, never 0/false");
});

test("BASELINES-BATCH: collectCells reads each cell's recorded fingerprint, null where none was written", async (t) => {
  const { writeRun } = await import("./_shared.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "baselines-fp-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const status = { type: "attempt", sequence_index: 0, attempt: 1, verdict: "FAIL", progress: { problems_before: 4 } };
  writeRun(root, "with-fp", { status });
  const bare = path.join(root, "without-fp");
  await fs.mkdir(bare, { recursive: true });
  await fs.writeFile(path.join(bare, "manifest.json"), JSON.stringify({ schedule: [{ sequence_index: 0, memory_mode: "off", provider_pin: "m-b" }] }));
  await fs.writeFile(path.join(bare, "manifest.status.jsonl"), `${JSON.stringify(status)}\n`);

  const cells = await collectCells(root);
  assert.deepEqual(cells.find((c) => c.run_dir === "with-fp").fingerprint, FIXTURE_FP);
  assert.equal(cells.find((c) => c.run_dir === "without-fp").fingerprint, null);
});

test("BASELINES-BATCH: a picked floor turns superseded on the next read once the code moves", async (t) => {
  const { writeRun } = await import("./_shared.mjs");
  const { baselineFor, collectOffCells } = await import("../baselines.mjs");
  const { readBatch, selectRun, writeBatch } = await import("../batch.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "baselines-sup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  writeRun(root, "camp", {
    status: { type: "attempt", sequence_index: 0, attempt: 1, verdict: "FAIL", progress: { problems_before: 4 } },
  });
  const cells = await collectOffCells(root);
  await baselineFor("m-a", cells, { runsRoot: root });
  const batch = await readBatch(path.join(root, "camp"));
  selectRun(batch, 0);
  await writeBatch(path.join(root, "camp"), batch);
  assert.equal((await baselineFor("m-a", cells, { runsRoot: root })).scorable, true, "current code: a floor");

  setFixtureCode({ grader_hash: "z".repeat(64) });
  t.after(() => setFixtureCode());
  const after = await baselineFor("m-a", cells, { runsRoot: root });
  assert.equal(after.scorable, false, "the selection does not rescue it");
  assert.equal(after.reason, "batch_void");
  assert.equal(after.void_kind, "superseded");
  assert.equal(after.void_input, "grader_hash");
  assert.equal((await readBatch(path.join(root, "camp"))).void, true, "and the void is persisted");
});

test("BASELINES-BATCH: a stored batch whose fingerprint its cells never recorded is stale, and re-assembles void", async (t) => {
  const { batchIsStale } = await import("../baselines.mjs");
  const runDir = await makeRunDir(t);
  const recorded = [cell({ sequence_index: 0, problems_before: 5 })];
  const batch = await assembleBatchForCells({ runDir, cells: recorded });
  assert.equal(batchIsStale(batch, recorded), false, "matches what its cells recorded");

  // The same batch, read against cells that recorded nothing — the pre-fix
  // state, where the fingerprint came from the repo at assembly.
  const bare = [cell({ sequence_index: 0, problems_before: 5, fingerprint: null })];
  assert.equal(batchIsStale(batch, bare), true);
  const again = await assembleBatchForCells({ runDir, cells: bare });
  assert.equal(again.void_kind, "unfingerprinted");
  assert.equal(batchIsStale(again, bare), false, "and, once void for that reason, stays settled");
});

test("BASELINES-BATCH: a cell that died before its first graded attempt is 'ended', void with its exception — not 'not_started'", async (t) => {
  // 2026-09-22, s0002: four hours of build, then IncompleteBuildError in
  // chunk 5. No attempt record was ever written, so it read as not_started.
  const { writeCampaign, writeCellFingerprint } = await import("./_shared.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "baselines-ended-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const status = (seq, n) => ({ type: "attempt", sequence_index: seq, attempt: 1, verdict: "FAIL", progress: { problems_before: n } });
  const d = writeCampaign(root, "camp", [
    { seq: 0, arm: "off", status: status(0, 27) },
    { seq: 1, arm: "off" },
    { seq: 2, arm: "off" },
    { seq: 3, arm: "off" },
  ]);
  // s0001 ran and died; s0002 is still going; s0003 never began.
  for (const seq of [1, 2]) writeCellFingerprint(d, seq);
  await fs.writeFile(
    path.join(d, "memoryOFF", "cell-0001", "live.jsonl"),
    `${JSON.stringify({ kind: "cell.start", cell_seq: 1 })}\n${JSON.stringify({ kind: "cell.end", cell_seq: 1, terminal_reason: "harness_error", terminal_exception: "IncompleteBuildError" })}\n`,
  );

  const cells = await collectCells(root);
  const bySeq = new Map(cells.map((c) => [c.sequence_index, c]));
  assert.equal(bySeq.get(1).state, "ended");
  assert.equal(bySeq.get(1).terminal_exception, "IncompleteBuildError");
  assert.equal(bySeq.get(2).state, "started", "began, no end recorded");
  assert.equal(bySeq.get(3).state, "not_started", "never began");

  const batch = await assembleBatchForCells({ runDir: d, cells });
  assert.equal(batch.runs.find((r) => r.sequence_index === 1).void_reason, "IncompleteBuildError");
});
