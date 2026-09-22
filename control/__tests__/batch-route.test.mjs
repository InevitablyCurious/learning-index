// Pins the fingerprint-invalidation VERIFICATION and the batch HTTP surface:
// verifyBatchFingerprint (injected inputs + the live-repo default path),
// readBatchForRunDir (a detected void is PERSISTED; an absent batch is
// {ok:false}), baselineFor's batch_void refusal, selectRun's signed deviation,
// and the two routes — GET /api/batch, POST /api/batch/select — including the
// 400/404/409 refusals. Temp dirs for run dirs; default-path repo hashes are
// live (the baselines-batch.test.mjs tolerance).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import {
  assembleBatch,
  computeFingerprint,
  markVoid,
  selectRun,
  writeBatch,
} from "../batch.mjs";
import {
  assembleBatchForCells,
  baselineFor,
  readBatchForRunDir,
  verifyBatchFingerprint,
} from "../baselines.mjs";

// The routes capture RUNS_ROOT at import time (state.mjs reads
// OKP_CONTROL_BENCH_ROOT once), so the fake bench root must be in the env
// BEFORE routes/roster.mjs is first imported — hence the dynamic import below.
// node --test runs each file in its own process: this never leaks elsewhere.
// (batch.mjs/baselines.mjs are state-free — static imports above are safe.)
const BENCH_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "batch-route-bench-"));
process.env.OKP_CONTROL_BENCH_ROOT = BENCH_ROOT;
const { routes } = await import("../routes/roster.mjs");
const RUNS_ROOT = path.join(BENCH_ROOT, "runs");

/** A complete fingerprint values map that can never match the live repo. */
function syntheticValues(overrides = {}) {
  return {
    chunk_plan_hash: "aa".repeat(32),
    grader_hash: "bb".repeat(32),
    scaffold_hash: "cc".repeat(32),
    golden_hash: "dd".repeat(32),
    model: "test/model",
    challenge: "backgammon",
    compaction: false,
    worker_image: { image_id: "sha256:img-test", created: "2026-01-01T00:00:00Z" },
    ...overrides,
  };
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
    seeded_from_snapshot: null,
    context_exhausted: false,
    gates: { passed: 1, failed: 0, error: 0, not_run: 0, total: 1 },
    terminal_reason: null,
    problems_before: 10,
    created_at: "2026-09-22T00:00:00Z",
    ...overrides,
  };
}

// ── verifyBatchFingerprint ─────────────────────────────────────────────────

test("VERIFY: injected currentInputs that match → void:false, batch untouched", async () => {
  const values = syntheticValues();
  const batch = syntheticBatch("/tmp/never-read", values);
  const out = await verifyBatchFingerprint(batch, { currentInputs: values });
  assert.equal(out.void, false);
  assert.equal(out.void_input, null);
  assert.equal(out.batch, batch, "the same batch object comes back");
  assert.equal(batch.void, false);
  assert.equal(batch.void_input, null);
});

test("VERIFY: one changed input (grader_hash) → void:true naming it, batch marked", async () => {
  const batch = syntheticBatch("/tmp/never-read");
  const out = await verifyBatchFingerprint(batch, {
    currentInputs: syntheticValues({ grader_hash: "ff".repeat(32) }),
  });
  assert.equal(out.void, true);
  assert.equal(out.void_input, "grader_hash");
  assert.equal(batch.void, true, "markVoid mutated the batch in place");
  assert.equal(batch.void_input, "grader_hash");
  assert.equal(
    batch.void_reason,
    "grader/gate suite — a changed test changes what a failure count means",
  );
});

test("VERIFY: a changed worker_image object names worker_image", async () => {
  const batch = syntheticBatch("/tmp/never-read");
  const out = await verifyBatchFingerprint(batch, {
    currentInputs: syntheticValues({
      worker_image: { image_id: "sha256:img-other", created: "2026-01-01T00:00:00Z" },
    }),
  });
  assert.equal(out.void, true);
  assert.equal(out.void_input, "worker_image");
  assert.equal(batch.void_input, "worker_image");
});

test("VERIFY: default path re-collects live inputs — fresh batch valid, edited manifest voids naming 'model'", async (t) => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "batch-route-run-"));
  t.after(() => fs.rm(runDir, { recursive: true, force: true }));
  const manifestPath = path.join(runDir, "manifest.run-manifest.json");
  const manifest = {
    requested_model: "local-llm-proxy/test-model",
    challenge: "backgammon",
    compact: false,
    worker_image_fingerprint: null,
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  // repoRoot omitted: the REAL repo, live hashes (baselines-batch tolerance).
  const batch = await assembleBatchForCells({ runDir, cells: [cell({ run_dir: runDir })] });

  const fresh = await verifyBatchFingerprint(batch);
  assert.equal(fresh.void, false, "assembled from the current inputs → valid");
  assert.equal(fresh.void_input, null);

  // Same repo, changed run identity: the default path (no injection) must
  // detect it and name the input — repo hashes are unchanged, so the first
  // differing input in contract order is `model`.
  await fs.writeFile(
    manifestPath,
    JSON.stringify({ ...manifest, requested_model: "local-llm-proxy/other-model" }, null, 2),
    "utf8",
  );
  const drifted = await verifyBatchFingerprint(batch);
  assert.equal(drifted.void, true);
  assert.equal(drifted.void_input, "model");
});

// ── readBatchForRunDir ─────────────────────────────────────────────────────

test("READ: absent batch → {ok:false}; a stale fingerprint is voided AND persisted", async (t) => {
  const runsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "batch-route-runs-"));
  t.after(() => fs.rm(runsRoot, { recursive: true, force: true }));

  const missing = await readBatchForRunDir({ runsRoot, runDir: "no-such-campaign" });
  assert.deepEqual(missing, { ok: false, error: "no batch for run_dir" });

  // A synthetic fingerprint can never match the live repo: the FIRST input in
  // contract order (chunk_plan_hash) is the one named.
  const abs = path.join(runsRoot, "camp-stale");
  await writeBatch(abs, syntheticBatch(abs));

  const out = await readBatchForRunDir({ runsRoot, runDir: "camp-stale" });
  assert.equal(out.ok, true);
  assert.equal(out.batch.void, true);
  assert.equal(out.batch.void_input, "chunk_plan_hash");

  const onDisk = JSON.parse(await fs.readFile(path.join(abs, "batch.json"), "utf8"));
  assert.equal(onDisk.void, true, "the void is persisted, not just returned");
  assert.equal(onDisk.void_input, "chunk_plan_hash");
});

// ── baselineFor void surfacing ─────────────────────────────────────────────

test("BASELINEFOR: a void batch refuses to be a floor — reason 'batch_void' + the changed input, even with a persisted selection", async (t) => {
  const runsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "batch-route-bl-"));
  t.after(() => fs.rm(runsRoot, { recursive: true, force: true }));

  const rel = "camp-bl";
  const abs = path.join(runsRoot, rel);
  const batch = syntheticBatch(abs);
  selectRun(batch, 2); // a selection does NOT rescue a void batch
  markVoid(batch, "grader_hash", "grader/gate suite — a changed test changes what a failure count means");
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

// ── selectRun signed deviation ─────────────────────────────────────────────

test("SELECT: selectRun stores signed_deviation = problem_count − median, + worse / − better", () => {
  const batch = syntheticBatch("/tmp/never-read"); // median 20 over {10,20,30}
  assert.equal(batch.median, 20);

  selectRun(batch, 2);
  assert.deepEqual(batch.selection, {
    sequence_index: 2,
    problem_count: 30,
    signed_deviation: 10,
  }, "+ = worse than the median");

  selectRun(batch, 0);
  assert.deepEqual(batch.selection, {
    sequence_index: 0,
    problem_count: 10,
    signed_deviation: -10,
  }, "− = better than the median");

  assert.throws(
    () => selectRun(batch, 3),
    /no scored run with sequence_index 3/,
    "a void run is never selectable",
  );
});

// ── the HTTP routes ────────────────────────────────────────────────────────

function route(method, p) {
  const r = routes.find((candidate) => candidate.method === method && candidate.path === p);
  assert.ok(r, `${method} ${p} is registered`);
  return r;
}

function fakeRes() {
  return {
    status: null,
    body: null,
    writeHead(code) { this.status = code; },
    end(text) { this.body = JSON.parse(text); },
  };
}

/** A req whose body readBody() consumes — Buffers, like the real socket. */
function fakeReq(body) {
  return Readable.from([Buffer.from(JSON.stringify(body))]);
}

/** A real batch under the fake runs root, assembled against the LIVE repo. */
async function seedLiveBatch(rel, counts) {
  const abs = path.join(RUNS_ROOT, rel);
  await fs.mkdir(abs, { recursive: true });
  await fs.writeFile(
    path.join(abs, "manifest.run-manifest.json"),
    JSON.stringify({
      requested_model: `local-llm-proxy/${rel}`,
      challenge: "backgammon",
      compact: false,
    }),
    "utf8",
  );
  await assembleBatchForCells({
    runDir: abs,
    cells: counts.map((n, i) => cell({ run_dir: rel, sequence_index: i, problems_before: n })),
  });
  return abs;
}

test("GET /api/batch: missing run_dir → 400; unknown run_dir → 404", async () => {
  const noParam = fakeRes();
  await route("GET", "/api/batch").handle({}, noParam, new URL("http://x/api/batch"));
  assert.equal(noParam.status, 400);
  assert.deepEqual(noParam.body, { ok: false, error: "run_dir required" });

  const unknown = fakeRes();
  await route("GET", "/api/batch").handle(
    {},
    unknown,
    new URL("http://x/api/batch?run_dir=no-such-campaign"),
  );
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, { ok: false, error: "no batch" });
});

test("GET /api/batch → 200 with the batch; POST /api/batch/select persists the selection + signed deviation", async (t) => {
  const rel = "camp-route";
  const abs = await seedLiveBatch(rel, [10, 20, 30]);
  t.after(() => fs.rm(abs, { recursive: true, force: true }));

  const got = fakeRes();
  await route("GET", "/api/batch").handle({}, got, new URL(`http://x/api/batch?run_dir=${rel}`));
  assert.equal(got.status, 200);
  assert.equal(got.body.ok, true);
  assert.equal(got.body.batch.median, 20);
  assert.equal(got.body.batch.scored_count, 3);
  assert.equal(got.body.batch.void_count, 0);
  assert.equal(got.body.batch.void, false, "assembled from live inputs → verification passes");
  assert.equal(got.body.batch.selection, null);
  assert.deepEqual(got.body.batch.runs.map((r) => r.sequence_index), [0, 1, 2]);
  assert.match(got.body.batch.fingerprint.hash, /^[0-9a-f]{64}$/, "the fingerprint rides along");

  // Pick the worst run: +10 against the median.
  const sel = fakeRes();
  await route("POST", "/api/batch/select").handle(
    fakeReq({ run_dir: rel, sequence_index: 2 }),
    sel,
    new URL("http://x/api/batch/select"),
  );
  assert.equal(sel.status, 200);
  assert.equal(sel.body.ok, true);
  assert.deepEqual(sel.body.batch.selection, {
    sequence_index: 2,
    problem_count: 30,
    signed_deviation: 10,
  });

  // Persisted — a second GET reads the selection back from disk.
  const again = fakeRes();
  await route("GET", "/api/batch").handle({}, again, new URL(`http://x/api/batch?run_dir=${rel}`));
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.batch.selection, sel.body.batch.selection);
});

test("POST /api/batch/select: void batch → 409 naming the changed input; unscored index → 400; missing run_dir → 400", async (t) => {
  // Void: a synthetic fingerprint can never match the live repo, so the read
  // inside the route voids + persists it before the 409.
  const rel = "camp-void";
  const abs = path.join(RUNS_ROOT, rel);
  await fs.mkdir(abs, { recursive: true });
  t.after(() => fs.rm(abs, { recursive: true, force: true }));
  await writeBatch(abs, syntheticBatch(abs));

  const voided = fakeRes();
  await route("POST", "/api/batch/select").handle(
    fakeReq({ run_dir: rel, sequence_index: 0 }),
    voided,
    new URL("http://x/api/batch/select"),
  );
  assert.equal(voided.status, 409);
  assert.deepEqual(voided.body, { ok: false, error: "batch is void: chunk_plan_hash" });

  const onDisk = JSON.parse(await fs.readFile(path.join(abs, "batch.json"), "utf8"));
  assert.equal(onDisk.void, true, "the 409 came from a PERSISTED void");
  assert.equal(onDisk.void_input, "chunk_plan_hash");

  // Unscored index against a valid batch → 400 with selectRun's own message.
  const goodAbs = await seedLiveBatch("camp-select-400", [5]);
  t.after(() => fs.rm(goodAbs, { recursive: true, force: true }));
  const absent = fakeRes();
  await route("POST", "/api/batch/select").handle(
    fakeReq({ run_dir: "camp-select-400", sequence_index: 99 }),
    absent,
    new URL("http://x/api/batch/select"),
  );
  assert.equal(absent.status, 400);
  assert.deepEqual(absent.body, { ok: false, error: "no scored run with sequence_index 99" });

  // Missing run_dir → 400, mirroring the GET convention (never a 500 on join).
  const noDir = fakeRes();
  await route("POST", "/api/batch/select").handle(
    fakeReq({ sequence_index: 0 }),
    noDir,
    new URL("http://x/api/batch/select"),
  );
  assert.equal(noDir.status, 400);
  assert.deepEqual(noDir.body, { ok: false, error: "run_dir required" });
});
