// ─────────────────────────────────────────────────────────────────────────────
// PER-FINGERPRINT AGGREGATE — baselines.mjs `fingerprints`
//
// How many OFF baselines were gathered on EXACTLY this code, and what they cost.
// The rule being pinned: a cell counts only when its numbers are a measurement
// (complete, not void, not seeded, not context-exhausted-ungraded, stamped with a
// phase total, carrying a fingerprint the current input set can still hash), the
// grouping key is the fingerprint HASH (two cells on different inputs never
// share a row), and a field absent from every cell in a row averages to null —
// never 0.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readBaselines } from "../baselines.mjs";
import { FIXTURE_FP, writeRun, writeCellCost, writeCellFingerprint, costStamp } from "./_shared.mjs";

/** A completed, unseeded, non-void OFF cell's status row. */
const STATUS = (problems_before = 10) => ({
  type: "attempt", sequence_index: 0, attempt: 1, verdict: "FAIL",
  progress: { turns: 20, total_tokens: 5000, problems_before },
});

/** A tmp runs root. */
async function runsRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "baselines-agg-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

/** One cell: campaign dir + status row + recorded fingerprint + cost stamp. */
async function writeCell(root, dir, { model = "m-a", status = STATUS(), values = FIXTURE_FP, record }) {
  const d = writeRun(root, dir, { model, status });
  writeCellFingerprint(d, 0, { values });
  if (record) writeCellCost(d, 0, { record });
  return d;
}

// The 14-input fingerprint fixture, minus every input that comes after
// `worker_image` — the shape a cell recorded before the newer inputs existed.
const PRE_STANDARD_FP = {
  chunk_plan_hash: FIXTURE_FP.chunk_plan_hash,
  grader_hash: FIXTURE_FP.grader_hash,
  model: FIXTURE_FP.model,
  challenge: FIXTURE_FP.challenge,
  compaction: FIXTURE_FP.compaction,
  scaffold_hash: FIXTURE_FP.scaffold_hash,
  golden_hash: FIXTURE_FP.golden_hash,
  worker_image: FIXTURE_FP.worker_image,
};

// A different tree: the same model, the same everything else, one commit later.
const OTHER_COMMIT_FP = { ...FIXTURE_FP, source_commit: "d".repeat(40) };

test("BASELINES-AGGREGATE: two baselines on one fingerprint collapse into a single averaged row", async (t) => {
  const root = await runsRoot(t);
  // Cell A carries context_peak and no cache_write_tokens; cell B the reverse.
  await writeCell(root, "camp-a", {
    record: costStamp({
      context_peak: 100000, wall_seconds: 600, turns: 20,
      input_tokens: 1000, output_tokens: 200, reasoning_tokens: 50, cache_read_tokens: 500,
    }),
  });
  await writeCell(root, "camp-b", {
    record: costStamp({
      wall_seconds: 800, turns: 40,
      input_tokens: 3000, output_tokens: 400, reasoning_tokens: 150, cache_read_tokens: 1500,
    }),
  });

  const idx = await readBaselines({ runsRoot: root, models: [] });

  assert.equal(idx.contract_version, 2, "the index carries the aggregate; the shape changed");
  assert.equal(idx.fingerprints.length, 1, "same fingerprint → ONE row, not one per cell");
  const [row] = idx.fingerprints;
  assert.deepEqual(Object.keys(row), ["fingerprint_hash", "model", "baseline_count", "avg"]);
  assert.match(row.fingerprint_hash, /^[0-9a-f]{64}$/);
  assert.equal(row.model, "m-a");
  assert.equal(row.baseline_count, 2);
  assert.deepEqual(row.avg, {
    // Only cell A has it: the mean of the cells that measured it, not diluted by B.
    context_peak: 100000,
    wall_seconds: 700,
    turns: 30,
    input_tokens: 2000,
    output_tokens: 300,
    reasoning_tokens: 100,
    cache_read_tokens: 1000,
    // Absent from every cell → null. Never 0: an unmeasured cost is not a free one.
    cache_write_tokens: null,
  });

  // The note states the rule the row implements.
  assert.match(idx.note, /accumulates onto its fingerprint/);
});

test("BASELINES-AGGREGATE: a different fingerprint (one commit later) forms its own row and never mixes", async (t) => {
  const root = await runsRoot(t);
  await writeCell(root, "camp-a", {
    model: "m-a",
    record: costStamp({ context_peak: 100000, turns: 20 }),
  });
  await writeCell(root, "camp-b", {
    model: "m-a",
    record: costStamp({ context_peak: 140000, turns: 40 }),
  });
  await writeCell(root, "camp-c", {
    model: "m-b",
    values: OTHER_COMMIT_FP,
    record: costStamp({ context_peak: 9000, turns: 10, cache_read_tokens: 0, cache_write_tokens: 0 }),
  });

  const idx = await readBaselines({ runsRoot: root, models: [] });

  assert.equal(idx.fingerprints.length, 2, "two fingerprints, two rows — the hash is the grouping key");
  // Sorted by model, then the most-repeated fingerprint first.
  const [a, b] = idx.fingerprints;
  assert.equal(a.model, "m-a");
  assert.equal(a.baseline_count, 2);
  assert.equal(a.avg.context_peak, 120000);
  assert.equal(a.avg.turns, 30);
  assert.equal(b.model, "m-b");
  assert.equal(b.baseline_count, 1);
  assert.equal(
    b.avg.context_peak,
    9000,
    "the other fingerprint's cell is not averaged into this one — a mixed row would price two different trees as one",
  );
  // A measured zero stays zero; only an ABSENT field is null.
  assert.equal(b.avg.cache_read_tokens, 0);
  assert.equal(b.avg.cache_write_tokens, 0);
});

test("BASELINES-AGGREGATE: void, seeded and pre-standard cells are excluded from the count", async (t) => {
  const root = await runsRoot(t);
  // The one cell that counts.
  await writeCell(root, "camp-counted", { record: costStamp({ turns: 30, wall_seconds: 600 }) });
  // The harness stamped this one void: its numbers measure the harness.
  await writeCell(root, "camp-void", {
    record: { outcome: "failed", phases: { total: { turns: 999 } }, void: { is_void: true, reason: "provider_truncation" } },
  });
  // Seeded: skips the build, sits on a different scale.
  await writeCell(root, "camp-seeded", {
    status: { ...STATUS(), seeded_from_snapshot: "snap-1" },
    record: costStamp({ turns: 777 }),
  });
  // Pre-standard: the record predates the inputs it takes to hash a fingerprint,
  // so it belongs to no fingerprint at all.
  await writeCell(root, "camp-prestd", { values: PRE_STANDARD_FP, record: costStamp({ turns: 555 }) });

  const idx = await readBaselines({ runsRoot: root, models: [] });

  assert.equal(idx.fingerprints.length, 1);
  const [row] = idx.fingerprints;
  assert.equal(row.baseline_count, 1, "only the cell that measured the model counts");
  assert.equal(row.avg.turns, 30, "neither the void, the seeded nor the pre-standard cell is averaged in");
  assert.equal(row.avg.wall_seconds, 600);
});

test("BASELINES-AGGREGATE: rotated runs still count — the aggregate reads backups, the floor walk does not", async (t) => {
  const root = await runsRoot(t);
  await writeCell(root, "camp-live", { record: costStamp({ turns: 20 }) });
  // A reset rotates benchmark data into backups/<stamp>/<campaign>; the count of
  // baselines gathered on a fingerprint must survive that.
  await writeCell(root, path.join("backups", "20260101", "camp-rotated"), {
    record: costStamp({ turns: 40 }),
  });

  const idx = await readBaselines({ runsRoot: root, models: [] });

  assert.equal(idx.off_cells_seen, 1, "the floor walk stays live-only — a rotated run is not a floor");
  assert.equal(idx.fingerprints.length, 1);
  assert.equal(idx.fingerprints[0].baseline_count, 2, "the aggregate counts the rotated cell too");
  assert.equal(idx.fingerprints[0].avg.turns, 30);
});
