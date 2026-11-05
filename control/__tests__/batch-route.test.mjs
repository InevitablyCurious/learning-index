// Pins the check of a batch's RECORDED fingerprint against the current code
// and the refusal that check produces: verifyAgainstCurrentCode (code inputs
// only) and baselineFor's batch_void answer. There is no operator pick any more
// — a batch is never selected, so nothing here mints or reads one, and the two
// routes that used to serve a pick (GET /api/batch, POST /api/batch/select) are
// gone with it. "The current code" is the fixture's (_shared.mjs), so no test
// reads the repo or docker.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assembleBatch,
  computeFingerprint,
  markVoid,
  writeBatch,
} from "../batch.mjs";
import { baselineFor, verifyAgainstCurrentCode } from "../baselines.mjs";
import { FIXTURE_FP, FIXTURE_CODE } from "./_shared.mjs";

/** A recorded fingerprint: the fixture's, which the fixture code matches. */
function syntheticValues(overrides = {}) {
  return { ...FIXTURE_FP, ...overrides };
}

/** A batch with scored counts {10,20,30} → median 20, plus one void run. */
function syntheticBatch(runDir, values = syntheticValues()) {
  return assembleBatch({
    runDir,
    runs: [
      { sequence_index: 0, problem_count: 10, scored: true, void_reason: null },
      { sequence_index: 1, problem_count: 20, scored: true, void_reason: null },
      { sequence_index: 2, problem_count: 30, scored: true, void_reason: null },
      { sequence_index: 3, problem_count: null, scored: false, void_reason: "void_instrument" },
    ],
    fingerprint: computeFingerprint(values),
  });
}

/** A minimal scorable OFF cell in the shape collectCells folds. */
function cell(overrides = {}) {
  return {
    id: "base-test",
    run_dir: "camp-x",
    sequence_index: 0,
    model: "m-x",
    kind: "local",
    provider: null,
    router: null,
    model_slug: "m-x",
    state: "complete",
    void_instrument: false,
    context_exhausted: false,
    gates: { passed: 1, failed: 0, error: 0, not_run: 0, total: 1 },
    terminal_reason: null,
    problems_before: 10,
    created_at: "2026-09-22T00:00:00Z",
    fingerprint: FIXTURE_FP,
    ...overrides,
  };
}

// ── verifyAgainstCurrentCode ───────────────────────────────────────────────

test("VERIFY: recorded code that matches the current code → unchanged", async () => {
  const batch = syntheticBatch("/tmp/never-read");
  assert.equal(await verifyAgainstCurrentCode(batch, { current: FIXTURE_CODE }), false);
  assert.equal(batch.void, false);
  assert.equal(batch.void_input, null);
});

test("VERIFY: a changed grader → superseded, naming it, the recorded fingerprint kept", async () => {
  const batch = syntheticBatch("/tmp/never-read");
  const changed = await verifyAgainstCurrentCode(batch, { current: { ...FIXTURE_CODE, grader_hash: "ff".repeat(32) } });
  assert.equal(changed, true);
  assert.equal(batch.void, true);
  assert.equal(batch.void_kind, "superseded");
  assert.equal(batch.void_input, "grader_hash");
  assert.match(batch.void_reason, /^grader_hash changed since this batch ran/);
  assert.deepEqual(batch.fingerprint.values, FIXTURE_FP);
});

test("VERIFY: a rebuilt worker image names worker_image", async () => {
  const batch = syntheticBatch("/tmp/never-read");
  await verifyAgainstCurrentCode(batch, {
    current: { ...FIXTURE_CODE, worker_image: { image_id: "sha256:other", created: "2026-09-02T00:00:00Z" } },
  });
  assert.equal(batch.void_input, "worker_image");
});

// The six identity ingredients are CODE: a harness edit, a new commit, a dirty
// tree, a changed worker source, a new opencode version or a rebuilt grader
// image means the batch was measured by a DIFFERENT instrument. Reporting it as
// "same code" would measure a new run's Δ against a foreign average.
const CHANGED_IDENTITY = {
  harness_hash: "1".repeat(64),
  source_commit: "d".repeat(40),
  source_dirty: true,
  worker_source_digest: "2".repeat(64),
  opencode_version: "9.9.9-fixture",
  grader_image: { image: "grader-img-2", source_digest: "gd2" },
};

test("VERIFY: every identity ingredient is CODE — a change supersedes the batch and names it", async (t) => {
  for (const [name, changed] of Object.entries(CHANGED_IDENTITY)) {
    await t.test(name, async () => {
      const batch = syntheticBatch("/tmp/never-read");
      const ch = await verifyAgainstCurrentCode(batch, {
        current: { ...FIXTURE_CODE, [name]: changed },
      });
      assert.equal(ch, true, `${name} changed → the batch is void`);
      assert.equal(batch.void, true);
      assert.equal(batch.void_kind, "superseded");
      assert.equal(batch.void_input, name, "the changed input is named");
      assert.match(batch.void_reason, new RegExp(`^${name} changed since this batch ran`));
      assert.deepEqual(batch.fingerprint.values, FIXTURE_FP, "the recorded fingerprint is kept");
    });
  }
});

test("VERIFY: a superseded batch refuses to be a floor", async (t) => {
  const runsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "batch-route-id-"));
  t.after(() => fs.rm(runsRoot, { recursive: true, force: true }));

  const rel = "camp-id";
  const abs = path.join(runsRoot, rel);
  await writeBatch(abs, syntheticBatch(abs));

  // The instrument moved: the batch is current-checked against the new code.
  const b = await baselineFor("m-x", [cell({ run_dir: rel, problems_before: 30, sequence_index: 2 })], {
    runsRoot,
    current: async () => ({ ...FIXTURE_CODE, opencode_version: "9.9.9-fixture" }),
  });
  assert.equal(b.exists, false);
  assert.equal(b.voided, true);
  assert.equal(b.reason, "batch_void");
  assert.equal(b.void_input, "opencode_version", "the moved instrument is named, not the model");
});

test("VERIFY: model, challenge and compaction are the batch's own identity, never compared", async () => {
  const batch = syntheticBatch("/tmp/never-read", syntheticValues({ model: "another/model", compaction: true }));
  assert.equal(await verifyAgainstCurrentCode(batch, { current: FIXTURE_CODE }), false);
  assert.equal(batch.void, false);
});

test("VERIFY: an already-void batch is left as it is", async () => {
  const batch = syntheticBatch("/tmp/never-read");
  markVoid(batch, "mixed", "grader_hash", "s0000 and s0001 ran on different grader_hash");
  assert.equal(await verifyAgainstCurrentCode(batch, { current: { ...FIXTURE_CODE, golden_hash: "x" } }), false);
  assert.equal(batch.void_kind, "mixed");
});

// ── baselineFor void surfacing ─────────────────────────────────────────────

test("BASELINEFOR: a void batch refuses to be a floor — reason 'batch_void' + the changed input", async (t) => {
  const runsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "batch-route-bl-"));
  t.after(() => fs.rm(runsRoot, { recursive: true, force: true }));

  const rel = "camp-bl";
  const abs = path.join(runsRoot, rel);
  const batch = syntheticBatch(abs);
  markVoid(batch, "superseded", "grader_hash", "grader_hash changed since this batch ran");
  await writeBatch(abs, batch);

  const b = await baselineFor("m-x", [cell({ run_dir: rel, problems_before: 30, sequence_index: 2 })], { runsRoot });
  assert.equal(b.exists, false);
  assert.equal(b.scorable, false);
  assert.equal(b.voided, true);
  assert.equal(b.reason, "batch_void");
  assert.equal(b.void_input, "grader_hash", "the changed input is named");
  assert.equal(b.median, 20);
  assert.equal(b.candidates, 3, "the batch's scored_count rides along");
  assert.equal(b.sequence_index, 2);
});
