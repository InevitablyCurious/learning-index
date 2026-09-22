// Pins the batch groundwork in baselines.mjs: the eight fingerprint inputs
// collected from the measured repo + run-manifest, and batch assembly —
// median over SCORED runs, voids excluded and never counted as failures —
// persisted to batch.json. Temp dirs for runDir; repo hashes are live.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { collectFingerprintInputs, assembleBatchForCells, collectCells } from "../baselines.mjs";
import { FINGERPRINT_INPUTS } from "../batch.mjs";

// Frozen by the Python compute_task_template_hash over task/backgammon/{scaffold,golden}.
// Byte-exact anchors — if these fail, the collector hashes the wrong trees.
const FROZEN_SCAFFOLD_HASH =
  "d7088d77051f58ad71e8b8201058a6733a35c964f0e2b5da6d2ff0f8491481ee";
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
    ...overrides,
  };
}

test("BASELINES-BATCH: assembleBatchForCells persists batch.json — scored/void split, median, fingerprint", async (t) => {
  const runDir = await makeRunDir(t, {
    requested_model: "local-llm-proxy/test-model",
    served_model: null,
    challenge: "backgammon",
    compact: true,
    worker_image_fingerprint: { image_id: "sha256:img-test", created: "2026-01-01T00:00:00Z" },
  });

  const cells = [
    cell({ sequence_index: 0, problems_before: 10 }),
    cell({ sequence_index: 1, void_instrument: true, terminal_reason: "transport_incomplete", problems_before: 3 }),
    cell({ sequence_index: 2, seeded_from_snapshot: "snap-1", problems_before: 4 }),
    cell({ sequence_index: 3, state: "not_started", gates: null, problems_before: null }),
    cell({ sequence_index: 4, context_exhausted: true, gates: null, problems_before: null }),
    cell({ sequence_index: 5, problems_before: 20 }),
    cell({ sequence_index: 6, problems_before: 30 }),
  ];

  // repoRoot omitted: defaults to the real repo resolved from the module.
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

  // Canonical order is contract (computeFingerprint canonicalizes by FINGERPRINT_INPUTS).
  assert.deepEqual(Object.keys(batch.fingerprint.values), INPUT_NAMES);
  assert.match(batch.fingerprint.hash, /^[0-9a-f]{64}$/);
  assert.equal(batch.fingerprint.values.model, "local-llm-proxy/test-model");
  assert.equal(batch.fingerprint.values.challenge, "backgammon");
  assert.equal(batch.fingerprint.values.compaction, true);
  assert.deepEqual(batch.fingerprint.values.worker_image, {
    image_id: "sha256:img-test",
    created: "2026-01-01T00:00:00Z",
  });
});

test("BASELINES-BATCH: a context-exhausted cell is excluded from the median, not treated as a failure", async (t) => {
  const runDir = await makeRunDir(t); // no manifest: identity fields null/false

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

test("BASELINES-BATCH: collectFingerprintInputs returns the eight inputs (frozen scaffold+golden anchors)", async (t) => {
  const runDir = await makeRunDir(t); // no manifest

  // repoRoot omitted: must default to the real repo resolved from the module.
  const values = await collectFingerprintInputs({ runDir });

  assert.deepEqual(Object.keys(values).sort(), [...INPUT_NAMES].sort());
  assert.equal(values.scaffold_hash, FROZEN_SCAFFOLD_HASH);
  assert.equal(values.golden_hash, FROZEN_GOLDEN_HASH);
  // grader/prompts hashes may drift — presence only.
  assert.match(values.chunk_plan_hash, /^[0-9a-f]{64}$/);
  assert.match(values.grader_hash, /^[0-9a-f]{64}$/);
  // No run-manifest: genuinely unidentifiable, never fabricated.
  assert.equal(values.model, null);
  assert.equal(values.challenge, null);
  assert.equal(values.compaction, false);
  assert.equal(values.worker_image, null);
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
