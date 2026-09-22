// Pins the batch groundwork in baselines.mjs: the eight fingerprint inputs
// collected from the measured repo + run-manifest, and batch assembly —
// median over SCORED runs, voids excluded and never counted as failures —
// persisted to batch.json. Temp dirs for runDir; repo hashes are live.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { collectFingerprintInputs, assembleBatchForCells } from "../baselines.mjs";
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
