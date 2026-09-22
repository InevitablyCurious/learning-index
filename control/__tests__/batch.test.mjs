// Pins the batch contract — the frozen scaffold-hash algorithm anchor,
// median over scored runs (voids excluded), signed deviation, fingerprint
// validity, and the batch.json record shape. Pure domain layer: temp dirs
// only, no server, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  FINGERPRINT_INPUTS,
  hashDir,
  computeFingerprint,
  fingerprintVerdict,
  medianOfScored,
  signedDeviation,
  contentionSummary,
  assembleBatch,
  markVoid,
  selectRun,
  batchPath,
  readBatch,
  writeBatch,
} from "../batch.mjs";

const ROOT = "/Users/jerrysmith/Desktop/TOKProject/Learning-Index";
// Frozen by the Python compute_task_template_hash over task/backgammon/scaffold.
// A byte-exact anchor on the hashDir algorithm — if this fails, hashDir does
// NOT replicate the Python digest and every fingerprint built on it is wrong.
const FROZEN_SCAFFOLD_HASH =
  "d7088d77051f58ad71e8b8201058a6733a35c964f0e2b5da6d2ff0f8491481ee";
const GRADER_EXCLUDE = new Set(["node_modules", ".git", "test-results"]);

/** A complete fingerprint values map; override any input. */
function makeValues(overrides = {}) {
  return {
    chunk_plan_hash: "chunk-1",
    grader_hash: "grader-1",
    model: "m-a",
    challenge: "backgammon",
    compaction: false,
    scaffold_hash: "scaffold-1",
    golden_hash: "golden-1",
    worker_image: { image_id: "sha256:img-1", created: "2026-01-01T00:00:00Z" },
    ...overrides,
  };
}

/** A batch with scored counts [20,22,24,26] → median 23, plus one void run. */
function makeBatch() {
  return assembleBatch({
    runDir: "/tmp/run-x",
    runs: [
      { sequence_index: 0, problem_count: 24, scored: true, void_reason: null },
      { sequence_index: 1, problem_count: null, scored: false, void_reason: "context exhausted" },
      { sequence_index: 2, problem_count: 26, scored: true, void_reason: null },
      { sequence_index: 3, problem_count: 22, scored: true, void_reason: null },
      { sequence_index: 4, problem_count: 20, scored: true, void_reason: null },
    ],
    fingerprint: computeFingerprint(makeValues()),
    now: "2026-01-01T00:00:00.000Z",
  });
}

test("BATCH: hashDir matches the frozen Python scaffold hash (algorithm anchor)", async () => {
  const scaffold = await hashDir(path.join(ROOT, "task/backgammon/scaffold"));
  assert.equal(scaffold, FROZEN_SCAFFOLD_HASH);

  // Reported, not asserted: live hashes of the other fingerprint dirs.
  const prompts = await hashDir(path.join(ROOT, "task/backgammon/prompts"));
  const golden = await hashDir(path.join(ROOT, "task/backgammon/golden"));
  const grader = await hashDir(path.join(ROOT, "grader"), { exclude: GRADER_EXCLUDE });
  console.log("hashDir scaffold:", scaffold);
  console.log("hashDir prompts :", prompts);
  console.log("hashDir golden  :", golden);
  console.log("hashDir grader  :", grader);
});

test("BATCH: hashDir is stable, changes with content, honors exclusion, throws on missing", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "batch-hashdir-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await fs.writeFile(path.join(dir, "a.txt"), "alpha");
  await fs.mkdir(path.join(dir, "sub"));
  await fs.writeFile(path.join(dir, "sub", "b.txt"), "beta");

  const h1 = await hashDir(dir);
  assert.equal(await hashDir(dir), h1, "stable digest across two calls");

  await fs.mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(dir, "node_modules", "pkg", "x.js"), "junk");
  assert.equal(
    await hashDir(dir, { exclude: new Set(["node_modules"]) }),
    h1,
    "file under an excluded segment is ignored",
  );
  assert.notEqual(await hashDir(dir), h1, "without exclusion the same file counts");

  await fs.writeFile(path.join(dir, "c.txt"), "gamma");
  assert.notEqual(
    await hashDir(dir, { exclude: new Set(["node_modules"]) }),
    h1,
    "adding a file changes the digest",
  );

  await assert.rejects(
    () => hashDir(path.join(dir, "missing")),
    "missing directory throws",
  );
});

test("BATCH: medianOfScored excludes voids — never counted as failures", () => {
  const runs = [
    { problem_count: 24, scored: true },
    { problem_count: null, scored: false },
    { problem_count: 22, scored: true },
    { problem_count: 26, scored: true },
    { problem_count: null, scored: false },
    { problem_count: 20, scored: true },
  ];
  assert.equal(medianOfScored(runs), 23, "even scored count → mean of two middle");

  const odd = [
    { problem_count: 24, scored: true },
    { problem_count: 22, scored: true },
    { problem_count: 26, scored: true },
  ];
  assert.equal(medianOfScored(odd), 24, "odd scored count → middle element");

  assert.equal(
    medianOfScored([{ problem_count: null, scored: false }]),
    null,
    "all-void → null",
  );
  assert.equal(medianOfScored([]), null, "empty → null");
});

test("BATCH: signedDeviation is + worse, - better, null without a median", () => {
  assert.equal(signedDeviation(26, 23), 3);
  assert.equal(signedDeviation(20, 23), -3);
  assert.equal(signedDeviation(22, 23), -1);
  assert.equal(signedDeviation(10, null), null);
});

test("BATCH: fingerprintVerdict names the first changed input with its reason", () => {
  const fp = computeFingerprint(makeValues());

  assert.deepEqual(fingerprintVerdict(fp, computeFingerprint(makeValues())), {
    valid: true,
    changedInput: null,
    changedReason: null,
  });

  const graderChanged = fingerprintVerdict(
    fp,
    computeFingerprint(makeValues({ grader_hash: "grader-2" })),
  );
  assert.equal(graderChanged.valid, false);
  assert.equal(graderChanged.changedInput, "grader_hash");
  assert.equal(
    graderChanged.changedReason,
    "grader/gate suite — a changed test changes what a failure count means",
  );

  const imageChanged = fingerprintVerdict(
    fp,
    computeFingerprint(
      makeValues({ worker_image: { image_id: "sha256:img-2", created: "2026-01-01T00:00:00Z" } }),
    ),
  );
  assert.equal(imageChanged.valid, false);
  assert.equal(imageChanged.changedInput, "worker_image");

  const createdChanged = fingerprintVerdict(
    fp,
    computeFingerprint(
      makeValues({ worker_image: { image_id: "sha256:img-1", created: "2026-02-02T00:00:00Z" } }),
    ),
  );
  assert.equal(createdChanged.changedInput, "worker_image", "created is an identity field too");

  const compactionFlipped = fingerprintVerdict(
    fp,
    computeFingerprint(makeValues({ compaction: true })),
  );
  assert.equal(compactionFlipped.valid, false);
  assert.equal(compactionFlipped.changedInput, "compaction");

  const multi = fingerprintVerdict(
    fp,
    computeFingerprint(makeValues({ chunk_plan_hash: "chunk-2", grader_hash: "grader-2" })),
  );
  assert.equal(multi.changedInput, "chunk_plan_hash", "FIRST differing input in contract order");

  assert.equal(
    fingerprintVerdict(makeValues(), makeValues()).valid,
    true,
    "bare values maps are accepted",
  );
});

test("BATCH: computeFingerprint is insertion-order independent and canonical", () => {
  assert.deepEqual(
    FINGERPRINT_INPUTS.map((input) => input.name),
    [
      "chunk_plan_hash",
      "grader_hash",
      "model",
      "challenge",
      "compaction",
      "scaffold_hash",
      "golden_hash",
      "worker_image",
    ],
    "contract order is pinned",
  );

  const a = makeValues();
  const b = {};
  for (const key of Object.keys(a).reverse()) b[key] = a[key];
  const fa = computeFingerprint(a);
  const fb = computeFingerprint(b);
  assert.equal(fa.hash, fb.hash, "same values, different insertion order → same hash");
  assert.deepEqual(
    Object.keys(fa.values),
    FINGERPRINT_INPUTS.map((input) => input.name),
    "values copy is in canonical order",
  );
  assert.notEqual(
    fa.hash,
    computeFingerprint(makeValues({ model: "m-b" })).hash,
    "a changed value changes the hash",
  );
  assert.throws(
    () => computeFingerprint({ chunk_plan_hash: "x" }),
    /fingerprint input missing/,
    "a missing input fails loud instead of hashing an empty slot",
  );
});

test("BATCH: assembleBatch computes counts + median and initializes selection/void", () => {
  const fingerprint = computeFingerprint(makeValues());
  const now = "2026-09-22T00:00:00.000Z";
  const batch = assembleBatch({
    runDir: "/tmp/run-x",
    runs: [
      { sequence_index: 0, problem_count: 24, scored: true, void_reason: null },
      { sequence_index: 1, scored: false, void_reason: "context exhausted" },
      { sequence_index: 2, problem_count: 22, scored: true, void_reason: null },
      { sequence_index: 3, problem_count: 26, scored: true },
    ],
    fingerprint,
    now,
  });

  assert.equal(batch.schema_version, 1);
  assert.equal(batch.run_dir, "/tmp/run-x");
  assert.equal(batch.created_at, now);
  assert.equal(batch.updated_at, now);
  assert.equal(batch.fingerprint, fingerprint);
  assert.equal(batch.scored_count, 3);
  assert.equal(batch.void_count, 1);
  assert.equal(batch.median, 24);
  assert.equal(batch.selection, null);
  assert.equal(batch.void, false);
  assert.equal(batch.void_input, null);
  assert.equal(batch.void_reason, null);

  assert.deepEqual(
    batch.runs[1],
    { sequence_index: 1, problem_count: null, scored: false, void_reason: "context exhausted", contention: null },
    "void run normalized: problem_count null",
  );
  assert.deepEqual(
    batch.runs[3],
    { sequence_index: 3, problem_count: 26, scored: true, void_reason: null, contention: null },
    "missing void_reason normalized to null",
  );
});

test("BATCH: contentionSummary sums counts, maxes latencies, ANYs wall_near_timeout — scored runs only", () => {
  const run = (scored, contention) => ({ scored, contention });
  const runs = [
    run(true, {
      http_429_count: 2, http_402_count: null, retry_count: 1, upstream_error_count: 0,
      max_request_ms: 500, median_request_ms: 120, wall_near_timeout: false,
    }),
    run(true, {
      http_429_count: 3, http_402_count: 1, retry_count: null, upstream_error_count: 2,
      max_request_ms: 900, median_request_ms: 80, wall_near_timeout: true,
    }),
    // A void run never enters the summary — the same population as the median.
    run(false, {
      http_429_count: 100, http_402_count: 100, retry_count: 100, upstream_error_count: 100,
      max_request_ms: 100000, median_request_ms: 100000, wall_near_timeout: true,
    }),
  ];
  assert.deepEqual(contentionSummary(runs), {
    http_429_count: 5, // SUM 2 + 3
    http_402_count: 1, // SUM; null contributes nothing
    retry_count: 1, // SUM; null contributes nothing
    upstream_error_count: 2, // SUM 0 + 2
    max_request_ms: 900, // MAX
    median_request_ms: 120, // MAX
    wall_near_timeout: true, // ANY
  });

  // A field no scored run measured is null — never a fabricated 0/false.
  const unmeasured = [
    run(true, {
      http_429_count: null, http_402_count: null, retry_count: null, upstream_error_count: null,
      max_request_ms: null, median_request_ms: null, wall_near_timeout: null,
    }),
    run(true, null), // no contention object at all
  ];
  assert.deepEqual(contentionSummary(unmeasured), {
    http_429_count: null, http_402_count: null, retry_count: null, upstream_error_count: null,
    max_request_ms: null, median_request_ms: null, wall_near_timeout: null,
  });
  assert.deepEqual(contentionSummary([]), contentionSummary(unmeasured), "empty → all null");

  // A measured false stays false — ANY is not "truthy-or-null".
  assert.equal(
    contentionSummary([run(true, { wall_near_timeout: false })]).wall_near_timeout,
    false,
  );
});

test("BATCH: assembleBatch carries per-run contention and surfaces the scored-only summary", () => {
  const crowded = {
    http_429_count: 1, http_402_count: 0, retry_count: 2, upstream_error_count: null,
    max_request_ms: 300, median_request_ms: 100, wall_near_timeout: false,
  };
  const batch = assembleBatch({
    runDir: "/tmp/run-c",
    runs: [
      { sequence_index: 0, problem_count: 10, scored: true, void_reason: null, contention: crowded },
      {
        sequence_index: 1, problem_count: null, scored: false, void_reason: "void_instrument",
        contention: {
          http_429_count: 9, http_402_count: 9, retry_count: 9, upstream_error_count: 9,
          max_request_ms: 9999, median_request_ms: 9999, wall_near_timeout: true,
        },
      },
      {
        sequence_index: 2, problem_count: 20, scored: true, void_reason: null,
        contention: {
          http_429_count: 4, http_402_count: null, retry_count: 1, upstream_error_count: 3,
          max_request_ms: 800, median_request_ms: 50, wall_near_timeout: true,
        },
      },
    ],
    fingerprint: computeFingerprint(makeValues()),
    now: "2026-09-22T00:00:00.000Z",
  });

  assert.deepEqual(batch.runs[0].contention, crowded, "per-run covariates ride on the record");
  assert.notEqual(batch.runs[0].contention, crowded, "normalized by copy — never aliases the caller");
  assert.equal(batch.runs[1].contention.http_429_count, 9,
    "a void run still SAYS its conditions — it is only kept out of the summary");
  assert.deepEqual(batch.contention, {
    http_429_count: 5, // 1 + 4; the void run's 9 never enters
    http_402_count: 0, // 0 + null
    retry_count: 3, // 2 + 1
    upstream_error_count: 3, // null + 3
    max_request_ms: 800, // MAX over scored
    median_request_ms: 100, // MAX over scored
    wall_near_timeout: true, // ANY over scored
  });
  // Contention is deliberately NOT fingerprinted: the canonical values stay
  // the eight contract inputs (pinned by the FINGERPRINT_INPUTS order test).
  assert.deepEqual(
    Object.keys(batch.fingerprint.values),
    FINGERPRINT_INPUTS.map((input) => input.name),
  );
});

test("BATCH: selectRun stores the signed deviation and fails loud otherwise", () => {
  const batch = makeBatch();
  assert.equal(batch.median, 23);

  selectRun(batch, 2);
  assert.deepEqual(batch.selection, {
    sequence_index: 2,
    problem_count: 26,
    signed_deviation: 3,
  });
  assert.notEqual(batch.updated_at, "2026-01-01T00:00:00.000Z", "updated_at touched");

  selectRun(batch, 4);
  assert.equal(batch.selection.signed_deviation, -3, "re-selecting a better run");

  assert.throws(() => selectRun(batch, 99), /no scored run with sequence_index 99/);
  assert.throws(() => selectRun(batch, 1), /no scored run with sequence_index 1/, "void run");
});

test("BATCH: markVoid flags the batch with the changed input", () => {
  const batch = makeBatch();
  markVoid(batch, "grader_hash", "grader/gate suite changed");
  assert.equal(batch.void, true);
  assert.equal(batch.void_input, "grader_hash");
  assert.equal(batch.void_reason, "grader/gate suite changed");
  assert.notEqual(batch.updated_at, "2026-01-01T00:00:00.000Z", "updated_at touched");
});

test("BATCH: writeBatch/readBatch round-trip; readBatch nulls on absent or corrupt", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "batch-io-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const runDir = path.join(base, "nested", "run");
  assert.equal(batchPath(runDir), path.join(runDir, "batch.json"));

  const batch = makeBatch();
  await writeBatch(runDir, batch);
  assert.deepEqual(await readBatch(runDir), batch, "round-trip deep-equal");

  const leftovers = (await fs.readdir(runDir)).filter((name) => name !== "batch.json");
  assert.deepEqual(leftovers, [], "atomic rename leaves no temp debris");

  assert.equal(await readBatch(path.join(base, "empty")), null, "absent → null");

  const corrupt = path.join(base, "corrupt");
  await fs.mkdir(corrupt, { recursive: true });
  await fs.writeFile(path.join(corrupt, "batch.json"), "{not json");
  assert.equal(await readBatch(corrupt), null, "unparseable → null");
});
