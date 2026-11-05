// Extracted verbatim from control/control.test.mjs — WO-LI18 split A.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { confirmationToken } from "../contract.mjs";
import { readCloud, resolveCloudModel, cloudCatalog, CLOUD_MODELS, CONTEXT_ADVISORY_FLOOR } from "../cloud.mjs";
import { readBaselines, BASELINES_FILE, isArchivedRun, baselineId, identifyCell, collectOffCells, assembleBatchForCells } from "../baselines.mjs";
import { writeBatch, markVoid } from "../batch.mjs";
import { manifestArgFor, campaignDirName } from "../campaign.mjs";
import { mintTree } from "../tree.mjs";
import { readModelsLedger } from "../models-ledger.mjs";

import { BENCH, FIXTURE_FP, writeRun, writeCampaign, OFF_PASS, treeFixture, writeCellFingerprint, writeCellCost, costStamp } from "./_shared.mjs";

test("LEDGER: a completed OFF cell IS the baseline, and it opens + run — and + baseline stays open for a repeat", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  writeRun(root, "cumulative", { status: OFF_PASS });

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
  });
  const m = led.models[0];
  assert.equal(m.baseline.scorable, true);
  assert.equal(m.can_run.allowed, true);
  // Every Run in OFF mode is a baseline, and a floor already standing does not
  // ration the next one: repeats on the same fingerprint are averaged.
  assert.equal(m.can_baseline.allowed, true);
  assert.equal(m.can_baseline.reason, null, "an open gate states no refusal");

  // The card's own rooting carries the same verdict on the same floor.
  const row = led.baseline_rows.find((b) => b.model === "m-a");
  assert.ok(row, "a measured floor has no row in baseline_rows");
  assert.equal(row.can_run.allowed, true);
  assert.equal(row.run_count, 0, "no ON cell has been measured against it yet");
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: the per-fingerprint aggregate is surfaced on the payload the card renders", async () => {
  // The BASELINES card prints, per fingerprint, how many baselines were gathered
  // on exactly this code and what one cost on average. The aggregate is derived
  // in baselines.mjs; this pins that models-ledger carries it at the ROOT, so the
  // card reads one key instead of reaching into the floor index for it.
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  const dir = writeRun(root, "cumulative", {
    status: {
      type: "attempt", sequence_index: 0, attempt: 1, verdict: "FAIL",
      progress: { turns: 20, total_tokens: 5000, problems_before: 7 },
    },
  });
  writeCellCost(dir, 0, {
    record: costStamp({ context_peak: 100000, wall_seconds: 600, turns: 20, input_tokens: 1000 }),
  });

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
  });

  assert.equal(led.fingerprints.length, 1, "one measured baseline → one fingerprint row");
  const [fp] = led.fingerprints;
  assert.match(fp.fingerprint_hash, /^[0-9a-f]{64}$/);
  assert.equal(fp.model, "m-a");
  assert.equal(fp.baseline_count, 1);
  assert.equal(fp.avg.turns, 20);
  // Absent from the stamp → null, never 0: an unmeasured cost is not a free one.
  assert.equal(fp.avg.cache_write_tokens, null);
  rmSync(root, { recursive: true, force: true });
});

/** OFF_PASS plus the graded problem count the batch median is built from. */
const OFF_PASS_MEASURED = {
  ...OFF_PASS,
  progress: { ...OFF_PASS.progress, problems_before: 7 },
};

test("LEDGER: a batch_void row names the changed input — void_input rides through to baseline_rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  writeRun(root, "cumulative", { status: OFF_PASS_MEASURED });

  // Assemble the batch, then void it on a named fingerprint input — the same
  // markVoid a stale-fingerprint read performs (batch.mjs).
  const runDir = join(root, "cumulative");
  const cells = (await collectOffCells(root)).filter((c) => c.model === "m-a");
  const batch = await assembleBatchForCells({ runDir, cells });
  markVoid(batch, "superseded", "grader_hash", "grader_hash changed since this batch ran");
  await writeBatch(runDir, batch);

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
  });
  const row = led.baseline_rows.find((b) => b.model === "m-a");
  assert.ok(row, "a void batch keeps its row");
  assert.equal(row.state, "void");
  assert.equal(row.reason, "batch_void");
  assert.equal(row.void_input, "grader_hash", "the changed input is named on the row, not just on the baseline");
  assert.equal(row.median, 7, "the stale median rides along, labelled void");
  assert.equal(row.scorable, false);
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: a VOID baseline counts as NO baseline and re-opens + baseline", async () => {
  // The failure this prevents: void numbers exist and look like success, so a
  // floor keyed on "a cell completed" would stand as the measurement an ON run's
  // Δ is read against — a Δ against the harness rather than the model.
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  const runDir = writeRun(root, "cumulative", {
    status: { type: "attempt", sequence_index: 0, verdict: "FAIL", terminal_reason: "transport_incomplete", progress: { turns: 2 } },
  });
  // The void verdict is the harness's, stamped into the cell's cost.json
  // (scripts/run_cumulative/runner.py) — never re-derived from the status row.
  writeCellCost(runDir, 0, {
    record: { outcome: "failed", phases: {}, void: { is_void: true, reason: "transport_incomplete" } },
  });

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
  });
  const m = led.models[0];
  assert.equal(m.baseline.scorable, false);
  assert.equal(m.baseline.voided, true);
  // A void cell is no baseline — and it is not a floor a run is measured
  // against either. The launch gate itself is CAPACITY ONLY: a baseline is
  // history an ON run is read against later, never a precondition.
  assert.equal(m.can_run.allowed, true, "nothing is in flight — the launch gate is capacity alone");
  assert.equal(m.can_run.reason, null);
  assert.equal(led.fingerprints.length, 0, "a void cell joins no fingerprint's average");
  assert.equal(m.can_baseline.allowed, true, "the operator must be able to re-measure");
  assert.match(m.can_baseline.reason ?? "", /^$|void/i);
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: a clean non-green cell is a real result, not a void instrument", async () => {
  // A model that fails every attempt is the bench's most important finding.
  // The cell ended cleanly — no truncation, no unrecovered anomaly — so calling
  // it an instrument fault would discard a capability result.
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  writeRun(root, "cumulative", {
    status: { type: "attempt", sequence_index: 0, verdict: "FAIL", terminal_reason: "stopped", progress: { turns: 40 } },
  });

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
  });
  assert.equal(led.models[0].baseline.scorable, true, "a capability FAIL is a usable floor");
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: a 7-round cell keeps round 7 — phases are observed, total is null", async () => {
  // Phases are unbounded: a cell keeps running attempts until it goes green or
  // the operator stops it, so `done` is the count the cell actually ran and
  // `total` is null. A clamp at an assumed ceiling would drop round 7 from the
  // record and invent a denominator the harness never agreed to.
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  writeCampaign(root, "cumulative", [
    { seq: 0, arm: "off", status: { ...OFF_PASS, sequence_index: 0 } },
    { seq: 1, arm: "on", status: { type: "attempt", sequence_index: 1, attempt: 1, verdict: "PASS", progress: { turns: 6 } } },
  ]);

  // Seven distinct graded attempts on the ON cell, in attempt order.
  const attempts = [JSON.stringify({ ...OFF_PASS, sequence_index: 0 })];
  for (let a = 1; a <= 7; a += 1) {
    attempts.push(JSON.stringify({
      type: "attempt",
      sequence_index: 1,
      attempt: a,
      verdict: a === 7 ? "PASS" : "FAIL",
      failed_gates: a === 7 ? [] : [`[A${a}] BUILD — gate ${a}`],
      progress: { turns: 4 + a },
    }));
  }
  writeFileSync(
    join(root, "cumulative", "manifest.status.jsonl"),
    `${attempts.join("\n")}\n`,
  );

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
  });
  const row = led.baseline_rows.find((b) => b.model === "m-a");
  assert.equal(row.run_count, 1);
  assert.equal(row.runs[0].cell.phases.done, 7, "round 7 is kept — the count is what the cell ran");
  assert.equal(row.runs[0].cell.phases.total, null, "unbounded — no denominator is invented");
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: an archived run never supplies a baseline", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  writeRun(root, "cumulative.wiped-recommission-20260813T0150", { status: OFF_PASS });

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
  });
  assert.equal(led.models[0].baseline.exists, false);
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: a cell in flight blocks EVERY button on ITS OWN model, never another model's", async () => {
  // The serial rule is PER MODEL (the N-slot ledger, run-ledger.mjs): a cell in
  // flight blocks every button on its own model's row — a per-row UI is exactly
  // where this gets broken, because each row looks independent — but it must
  // never block a DIFFERENT model. That is what lets N cells run concurrently
  // across models while one model stays serial.
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  writeRun(root, "cumulative", { status: OFF_PASS });           // m-a has a floor

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }, { id: "m-b", bench_eligible: true }],
    inFlightModels: new Set(["m-a"]),
  });
  assert.equal(led.run_in_flight, true, "the top-level aggregate mirrors: SOME model is in flight");

  const byId = Object.fromEntries(led.models.map((m) => [m.id, m]));
  // m-a: every button blocked, and the reason names the per-model serial rule.
  assert.equal(byId["m-a"].in_flight, true);
  assert.equal(byId["m-a"].can_baseline.allowed, false);
  assert.equal(byId["m-a"].can_run.allowed, false);
  assert.match(
    byId["m-a"].can_baseline.reason,
    /a cell for m-a is already in flight — this model is serial/,
    "the refusal names the model that is serial, never a global OFF-concurrency rule",
  );
  assert.match(byId["m-a"].can_run.reason, /already in flight/);
  // m-b: untouched by m-a's cell.
  assert.equal(byId["m-b"].in_flight, false);
  assert.equal(byId["m-b"].can_baseline.allowed, true, "another model's cell never blocks this floor");
  // …and its launch is open too: the gate is capacity alone, never a baseline.
  assert.equal(byId["m-b"].can_run.allowed, true, "a launch needs capacity, not a baseline");
  assert.equal(byId["m-b"].can_run.reason, null, "nothing is in flight for m-b, so nothing refuses it");

  // The floor row of the in-flight model must not offer a launch either.
  const row = led.baseline_rows.find((b) => b.model === "m-a");
  assert.equal(row.can_run.allowed, false, "a floor row must not offer a launch either");
  assert.match(row.can_run.reason, /already in flight/);
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: a floor on one model never blocks another model's + baseline", async () => {
  // THE DEFECT THIS PINS. The profile subject rule was applied to OFF cells as
  // well as ON, so freezing the first profile disabled [+ baseline] on every
  // OTHER bench model, and the whole bench silently locked to whichever model
  // was profiled first. The profile store is gone; this pins the surviving rule.
  //
  // A baseline is measured against nothing, and no other model's floor has any
  // bearing on it. A model's OWN floor does not block its next baseline either:
  // a repeat on the same fingerprint is what the average is made of. And a
  // launch is gated by capacity alone, so a model that has never been
  // baselined may still run — its Δ says "no baselines on this fingerprint".
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  writeRun(root, "cumulative", { status: OFF_PASS });           // m-a has a floor

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [
      { id: "m-a", bench_eligible: true },
      { id: "m-b", bench_eligible: true },
      { id: "m-c", bench_eligible: true },
    ],
  });

  const byId = Object.fromEntries(led.models.map((m) => [m.id, m]));
  // m-a is floored: a run against it is open, and so is another baseline.
  assert.equal(byId["m-a"].can_baseline.allowed, true);
  assert.equal(byId["m-a"].can_baseline.reason, null, "a standing floor is not a refusal");
  assert.equal(byId["m-a"].can_run.allowed, true);
  // Every other model may still measure its own floor — and launch.
  for (const id of ["m-b", "m-c"]) {
    assert.equal(byId[id].can_baseline.allowed, true, `${id} must be able to measure its own floor`);
    assert.equal(byId[id].can_baseline.reason, null, "an open gate states no refusal");
    assert.equal(byId[id].can_run.allowed, true, `${id} launches on capacity, never on a baseline`);
    assert.equal(byId[id].can_run.reason, null);
  }
  rmSync(root, { recursive: true, force: true });
});

test("CAMPAIGN: a second model gets its own directory; the first keeps runs/cumulative", async () => {
  // WHY THIS EXISTS. Every launch used to target runs/cumulative/manifest.json,
  // whose roster hash is frozen to ONE model. A baseline for a second model died
  // at startup with `roster hash drift detected` — so opening [+ baseline] for
  // every un-floored model is only honest if each model has somewhere to write.
  const root = mkdtempSync(join(tmpdir(), "okp-camp-"));
  mkdirSync(join(root, "cumulative"), { recursive: true });
  writeFileSync(join(root, "cumulative", "manifest.json"), JSON.stringify({
    roster: [{ model: "local-llm-proxy/m-a" }],
    schedule: [{ sequence_index: 0, memory_mode: "off", provider_pin: "m-a" }],
  }));

  // The owner keeps the default path — null means "pass no --manifest", so the
  // live campaign's invocation is byte-identical to what it has always been.
  assert.equal(await manifestArgFor("m-a", root), null);
  // Every other model is routed away from it.
  assert.equal(await manifestArgFor("m-b", root), join(root, "cumulative-m-b", "manifest.json"));

  // …and STABLY: a second call for the same model resolves to the same place,
  // so cell 2 continues the campaign cell 1 started.
  assert.equal(await manifestArgFor("m-b", root), join(root, "cumulative-m-b", "manifest.json"));
  rmSync(root, { recursive: true, force: true });
});

test("CAMPAIGN: a dotted model alias never produces an archive-shaped directory", () => {
  // `isArchivedRun()` reads ANY dot as the archive convention
  // (runs/cumulative.<why>-<date>). A directory named for `qwen3.6-…` would
  // therefore be treated as archived and its baseline would silently disappear
  // from the floor index — a measured ~3h cell, invisible, with no error.
  const name = campaignDirName("qwen3.6-35b-a3b-bench");
  assert.equal(name, "cumulative-qwen3-6-35b-a3b-bench");
  assert.equal(isArchivedRun(name), false, "the campaign directory must not read as archived");
  assert.equal(isArchivedRun("cumulative.void-truncation-20260812"), true, "…while a real archive still does");
});

test("CAMPAIGN: an unreadable legacy manifest never relocates the live campaign", async () => {
  // Corrupt manifest => the harness must fail loudly on the default path. Moving
  // the campaign to a fresh directory instead would present as the entire run
  // history having vanished.
  const root = mkdtempSync(join(tmpdir(), "okp-camp-"));
  mkdirSync(join(root, "cumulative"), { recursive: true });
  writeFileSync(join(root, "cumulative", "manifest.json"), "{ not json");
  assert.equal(await manifestArgFor("m-a", root), null, "a broken campaign is faced, not routed around");

  // Readable but model-less: also treated as "mine" rather than relocated.
  writeFileSync(join(root, "cumulative", "manifest.json"), JSON.stringify({ schedule: [] }));
  assert.equal(await manifestArgFor("m-a", root), null);

  // ABSENT is the different answer: nothing has claimed the default directory,
  // so this model names its own.
  rmSync(join(root, "cumulative"), { recursive: true, force: true });
  assert.equal(await manifestArgFor("m-a", root), join(root, "cumulative-m-a", "manifest.json"));
  rmSync(root, { recursive: true, force: true });
});

test("BASELINES: the index is the single export, and it is written to disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-base-"));
  writeRun(root, "cumulative", { status: OFF_PASS });           // m-a floored
  const models = [{ id: "m-a", bench_eligible: true }, { id: "m-b", bench_eligible: true }];

  const idx = await readBaselines({ runsRoot: root, models });
  assert.equal(idx.ok, true);
  assert.equal(idx.models["m-a"].scorable, true);
  // A model with no OFF cell still gets an ENTRY carrying the reason — an
  // absent key is indistinguishable from "not on the bench".
  assert.equal(idx.models["m-b"].scorable, false);
  assert.match(idx.models["m-b"].reason, /no OFF cell has ever been run/);

  // STORED: the export lands on disk, and matches what was served.
  assert.equal(idx.stored.written, true);
  const onDisk = JSON.parse(readFileSync(join(root, BASELINES_FILE), "utf8"));
  assert.deepEqual(onDisk.models, idx.models);

  // Re-derived with nothing changed: same answer, and the file is NOT rewritten
  // — the mtime stays meaningful as "when the floor last changed".
  const again = await readBaselines({ runsRoot: root, models });
  assert.deepEqual(again.models, idx.models);
  assert.equal(again.stored.written, false);

  // THE LEDGER READS THIS SAME INDEX rather than deriving its own.
  const led = await readModelsLedger({ runsRoot: root, benchModels: models });
  assert.deepEqual(led.baselines.models, idx.models);
  for (const m of led.models) assert.deepEqual(m.baseline.scorable, idx.models[m.id].scorable);
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: a floor with no ON cell reports an empty run list, not an excuse", async () => {
  // A campaign whose schedule holds only the OFF slot has had nothing measured
  // against its floor. That is an EMPTY LIST, which the card states as "0" —
  // never a sentence about why the runs could not be attributed, because there
  // is no attribution step any more for one to fail at.
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  writeRun(root, "cumulative", { status: OFF_PASS });

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
  });
  const row = led.baseline_rows.find((b) => b.model === "m-a");
  assert.deepEqual(row.runs, []);
  assert.equal(row.run_count, 0);
  assert.equal(row.best, null, "no run means no best, never a zero delta");
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: the ON cells of the floor\'s own campaign ARE its runs, read off disk", async () => {
  // WHAT THIS REPLACED. Runs used to be whatever the profile store had recorded
  // at launch, joined back to a cell by a key the launcher wrote down. Nothing
  // is recorded now: a campaign schedules ONE model, slot 0 as the OFF floor and
  // every later slot an ON repetition of it, so the runs are simply the ON cells
  // in the floor\'s own directory. A cell started at the CLI therefore appears
  // here, where the profile store called it "real but unattributed".
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  const dir = writeCampaign(root, "cumulative", [
    { seq: 0, arm: "off", status: { ...OFF_PASS, sequence_index: 0 } },
    { seq: 1, arm: "on", status: { type: "attempt", sequence_index: 1, verdict: "PASS", progress: { turns: 6, total_tokens: 300, wall_seconds: 40 } } },
    { seq: 2, arm: "on", status: { type: "attempt", sequence_index: 2, verdict: "PASS", progress: { turns: 7, total_tokens: 350, wall_seconds: 45 } } },
  ]);
  // The OFF cell's cost stamp is what the fingerprint aggregate averages, and
  // the average is what a Δ is now measured against.
  writeCellCost(dir, 0, { record: costStamp({ turns: 9, wall_seconds: 60 }) });

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
  });
  const row = led.baseline_rows.find((b) => b.model === "m-a");
  assert.equal(row.run_count, 2, "both ON cells are runs; the OFF cell is the baseline, not a run");

  // NEWEST FIRST on the wire, and the ordinals are positions in the SCHEDULE —
  // a run's number never changes when a later one is added.
  assert.deepEqual(row.runs.map((r) => r.seq), [2, 1]);
  assert.deepEqual(row.runs.map((r) => r.sequence_index), [2, 1]);
  for (const r of row.runs) assert.ok(r.cell, "an ON cell on disk always carries its measurement");

  // Δ IS AGAINST THE AVERAGE OF THE BASELINES ON THIS FINGERPRINT — never one
  // picked cell — and `better` is a word, not the sign. Here the family is one
  // cell, so the average is that cell's 9 turns.
  const first = row.runs.find((r) => r.seq === 1);
  assert.equal(first.delta.computable, true);
  assert.equal(first.delta.turns, 6 - 9);
  assert.equal(first.delta.baseline_count, 1, "one baseline on this fingerprint");
  assert.match(first.delta.fingerprint, /^[0-9a-f]{64}$/, "the reading names the code it was measured on");
  assert.equal(first.delta.better, true, "fewer turns than the average is an improvement");

  // BEST IS EFFICIENCY ONLY and says so.
  assert.equal(row.best.run_seq, 1);
  assert.equal(row.best.turns, -3);
  assert.equal(row.best.axis, "efficiency");
  assert.match(row.best.note, /average of 1 baseline on this fingerprint/);
  rmSync(root, { recursive: true, force: true });
});

// ── CLOUD BASELINES ─────────────────────────────────────────────────────────

test("DRIFT: the cloud catalogue matches CLOUD_ORCAROUTER_PROVIDER in config.py", () => {
  // The control plane is JS and the provider block is Python, so there is no
  // shared import — the same standing condition that makes roster.mjs mirror the
  // worker context registry. This is the test that makes the mirror safe: a
  // model added on one side and not the other fails here rather than presenting
  // to the operator as "that model does not exist".
  const src = readFileSync(join(BENCH, "harness", "rosters.py"), "utf8");
  const start = src.indexOf("CLOUD_ORCAROUTER_PROVIDER");
  assert.ok(start > -1, "CLOUD_ORCAROUTER_PROVIDER not found in config.py");

  // THE BLOCK'S ACTUAL EXTENT, not a fixed window. This test first read a
  // 4000-character slice, which covered the five models the block held at the
  // time and silently stopped covering it the moment the catalogue grew — the
  // failure mode being that the test still PASSES while checking a fraction of
  // the list. The models dict is delimited, so it is read by its delimiters.
  const mstart = src.indexOf('    "models": {', start);
  assert.ok(mstart > -1, "the provider block has no models dict");
  const mend = src.indexOf("\n    },\n", mstart);
  assert.ok(mend > mstart, "the models dict is not terminated");
  const block = src.slice(mstart, mend);

  const pyKeys = [...block.matchAll(/^\s{8}"([^"]+\/[^"]+)":\s*\{/gm)].map((m) => m[1]);
  assert.ok(pyKeys.length > 0, "no {provider}/{model} keys parsed out of the provider block");
  // THE COUNTS MUST AGREE. Two set-membership loops can both pass while the two
  // sides hold different numbers of entries if either contains a duplicate key,
  // so the size is asserted rather than inferred from them.
  assert.equal(
    pyKeys.length,
    Object.keys(CLOUD_MODELS).length,
    `config.py lists ${pyKeys.length} cloud models and the control plane mirrors ${Object.keys(CLOUD_MODELS).length}`,
  );

  for (const key of Object.keys(CLOUD_MODELS)) {
    assert.ok(
      pyKeys.includes(key),
      `cloud model '${key}' is mirrored here but absent from config.py's provider block`,
    );
  }
  // AND THE OTHER DIRECTION. A model present in Python and missing here is the
  // more damaging drift: the bench can run it and the board will not offer it.
  for (const key of pyKeys) {
    assert.ok(CLOUD_MODELS[key], `config.py offers '${key}' and the control plane does not mirror it`);
  }

  // THE LIMITS TRAVEL TOO. `context` and `output` are not decoration: the board
  // states them on the picker, and an output ceiling set below what the model
  // can emit truncates a response — which this bench classifies as a VOID
  // INSTRUMENT, a cell that burns hours and measures the harness. A mirror that
  // agreed on the model list and disagreed on its ceilings would be worse than
  // no mirror, because it would look correct.
  for (const key of pyKeys) {
    const entry = block.slice(block.indexOf(`"${key}":`));
    const lim = entry.match(/"limit":\s*\{"context":\s*(\d+),\s*"output":\s*(\d+)\}/);
    assert.ok(lim, `config.py entry for '${key}' has no parsable limit`);
    assert.equal(Number(lim[1]), CLOUD_MODELS[key].context, `context drift on '${key}'`);
    assert.equal(Number(lim[2]), CLOUD_MODELS[key].output, `output drift on '${key}'`);
  }
});

test("CLOUD: every mirrored model is shaped for the picker, and narrow windows are BADGED not hidden", () => {
  // THE CATALOGUE IS NOT FILTERED. Every model the provider offers is offered
  // here, because the benchmark measures an INFORMATION DELTA WITHIN one model:
  // the same model runs OFF then ON repeatedly, so it is its own control and its
  // context window cancels out of its own delta. A narrow window does not bias
  // the measurement, so hiding the model would be the picker deciding something
  // it has no standing to decide.
  //
  // What a narrow window does risk is the cell hitting the provider's context
  // ceiling mid-run. That is a runnability caveat, so it is SURFACED: the entry
  // carries its real window and a note, and the board badges it.
  for (const [key, m] of Object.entries(CLOUD_MODELS)) {
    assert.ok(m.output > 0, `'${key}' states no output ceiling`);
    assert.ok(m.context > 0, `'${key}' states no context window`);
    assert.ok(m.name && !m.name.includes("/"), `'${key}' has no readable label (got ${JSON.stringify(m.name)})`);
    assert.equal(key.split("/").length, 2, `'${key}' is not a {provider}/{model} key`);
  }

  // The advisory floor must reach the browser as data, not as a filter.
  const catalogue = cloudCatalog();
  assert.equal(catalogue.length, Object.keys(CLOUD_MODELS).length, "the catalogue drops models");
  for (const entry of catalogue) {
    const narrow = entry.context < CONTEXT_ADVISORY_FLOOR;
    assert.equal(entry.below_advisory_floor, narrow, `'${entry.key}' flag disagrees with its window`);
    if (narrow) {
      assert.ok(entry.context_note, `'${entry.key}' is below the floor and carries no note to show`);
      assert.match(entry.context_note, /compaction/i, `'${entry.key}' note omits the compaction caveat`);
    } else {
      assert.equal(entry.context_note, null, `'${entry.key}' is above the floor and should carry no note`);
    }
  }
});

test("CLOUD: a model key resolves to the provider and model the harness expects", () => {
  // `--cloud --provider <vendor> --model <model>` is what run_cumulative.py's
  // _compose_cloud_slug consumes; passing the whole key as --model would compose
  // orcarouter/anthropic/anthropic/... and be refused for a model the operator
  // never picked.
  const r = resolveCloudModel("anthropic/claude-opus-5");
  assert.equal(r.ok, true);
  assert.equal(r.provider, "anthropic");
  assert.equal(r.model, "claude-opus-5");
  assert.equal(r.slug, "orcarouter/anthropic/claude-opus-5");
});

test("CLOUD: an unknown or malformed model is refused BY NAME, with the alternatives", () => {
  const unknown = resolveCloudModel("acme/does-not-exist");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "cloud_model_unknown");
  assert.match(unknown.reason, /available:/);

  // A three-segment key is a composed slug that still carries its router.
  const malformed = resolveCloudModel("orcarouter/anthropic/claude-opus-5");
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, "cloud_model_malformed");
});

test("CLOUD: the key report carries presence and a fingerprint, never the key", async () => {
  // This object is published to the browser. A leak here is a credential on the
  // wire, so the test asserts the absence of the secret rather than only the
  // presence of the report.
  const root = mkdtempSync(join(tmpdir(), "okp-cloud-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "cloud.env"), "ORCAROUTER_API_KEY=sk-secret-value\n");

  const cloud = await readCloud({ benchRoot: root, env: {} });
  assert.equal(cloud.key.present, true);
  assert.equal(cloud.key.source, "key_file");
  assert.equal(cloud.can_start, true);
  assert.match(cloud.key.fingerprint, /^[0-9a-f]{8}$/);
  assert.ok(
    !JSON.stringify(cloud).includes("sk-secret-value"),
    "the cloud report contains the API key — it is published to the browser and must never carry the secret",
  );
  rmSync(root, { recursive: true, force: true });
});

test("CLOUD: no key means the substrate refuses BEFORE anything is written", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-cloud-"));
  const cloud = await readCloud({ benchRoot: root, env: {} });
  assert.equal(cloud.key.present, false);
  assert.equal(cloud.can_start, false);
  // The path is named. "No key" with no location is a dead end for an operator
  // who believes they configured one.
  assert.match(cloud.can_start_reason, /cloud\.env/);
  rmSync(root, { recursive: true, force: true });
});

test("CLOUD: an exported key wins over the file, mirroring spend_key", async () => {
  // The spawned harness inherits the control plane's environment, so reporting
  // the file's key while the harness would use the environment's would be a
  // report about a run that is not the one about to happen.
  const root = mkdtempSync(join(tmpdir(), "okp-cloud-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "cloud.env"), "ORCAROUTER_API_KEY=from-file\n");

  const cloud = await readCloud({ benchRoot: root, env: { ORCAROUTER_API_KEY: "from-env" } });
  assert.equal(cloud.key.source, "environment");
  rmSync(root, { recursive: true, force: true });
});

test("CAMPAIGN: a cloud slug yields a FLAT campaign directory name", () => {
  // A slash in a directory name is not a name, it is a path. Left in, a cloud
  // baseline's campaign would land at runs/cumulative-anthropic/claude-opus-5 —
  // nested under a parent holding no manifest, so every reader that scans runs/
  // walks straight past it and the measurements are invisible on the board the
  // cell was launched from.
  const name = campaignDirName("anthropic/claude-opus-5");
  assert.ok(!name.includes("/"), `campaign dir '${name}' contains a path separator`);
  // Dots too: isArchivedRun() treats ANY dot as the archive convention, so a
  // dotted name would make the baseline silently vanish from the floor index.
  assert.ok(!isArchivedRun(campaignDirName("qwen/qwen3.8-max")));
  // Local names are UNCHANGED by the slash rule — no existing campaign moves.
  assert.equal(campaignDirName("qwen3.6-35b-a3b-bench"), "cumulative-qwen3-6-35b-a3b-bench");
});

test("BASELINE: a cloud OFF cell is identified by vendor, not by the router", () => {
  // provider_pin is built by _provider_pin_from_model, which returns the FIRST
  // segment for anything that is not a local-llm-proxy slug — the router. Read
  // naively, every cloud baseline in the bench resolves to the single identity
  // "orcarouter", folding four vendors' floors into one row and attributing all
  // of them to a model that does not exist.
  const cloud = identifyCell(
    { model: "orcarouter/anthropic/claude-opus-5", provider_pin: "orcarouter" },
    {},
  );
  assert.equal(cloud.kind, "cloud");
  assert.equal(cloud.id, "anthropic/claude-opus-5");
  assert.equal(cloud.provider, "anthropic");

  const local = identifyCell(
    { model: "local-llm-proxy/m-a", provider_pin: "m-a" },
    {},
  );
  assert.equal(local.kind, "local");
  assert.equal(local.id, "m-a");
});

test("BASELINE: the list is rooted in cells, so a cloud floor appears without a roster", async () => {
  // `models` is keyed by the local proxy roster because that is what a GATE
  // needs. `list` is derived from the CELLS, which is the only reason a cloud
  // floor — whose model the local proxy has never heard of — is findable at all.
  const root = mkdtempSync(join(tmpdir(), "okp-bl-"));
  const dir = join(root, "cumulative-anthropic-claude-opus-5");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    created_at: "2026-08-15T00:00:00Z",
    schedule: [{ sequence_index: 0, memory_mode: "off", model: "orcarouter/anthropic/claude-opus-5", provider_pin: "orcarouter" }],
  }));
  writeFileSync(join(dir, "manifest.status.jsonl"), `${JSON.stringify({
    type: "attempt", sequence_index: 0, attempt: 1, verdict: "PASS",
    gate_totals: { pass: 69, fail: 2, error: 0, not_run: 0, total: 71 },
    progress: { turns: 31, total_tokens: 900, wall_seconds: 120 },
  })}\n`);
  writeCellFingerprint(dir, 0);

  // NOTE the empty roster: this is the cold case where the local proxy is down.
  const idx = await readBaselines({ runsRoot: root, models: [] });
  assert.equal(idx.list.length, 1);
  const row = idx.list[0];
  assert.equal(row.model, "anthropic/claude-opus-5");
  assert.equal(row.kind, "cloud");
  assert.equal(row.state, "complete");
  assert.equal(row.turns, 31);
  assert.equal(row.gates.total, 71);
  assert.match(row.id, /^base-[0-9a-f]{4}$/);
  assert.deepEqual(idx.counts, { complete: 1, running: 0, void: 0, exhausted: 0 });
  rmSync(root, { recursive: true, force: true });
});

test("BASELINES: a tree-layout campaign carries the FULL relative run_dir, not the leaf", async () => {
  // A row keyed by the LEAF (`qwen3-6-35b-a3b-bench`) names a directory that
  // does not exist under the runs root — the campaign lives at
  // <tree>/<substrate>/<router>/<provider>/<model> — so an operator following
  // it finds nothing, and the same model in two trees would collide on the id
  // derived from it. A flat campaign's leaf IS its full relative path, so
  // pre-tree history keeps the run_dir it has always had.
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });
    const t = await mintTree(runs, { now: 1787310000_000 });

    const rel = join(t.active, "local", "local-llm-proxy", "omlx", "qwen3-6-35b-a3b-bench");
    const dir = join(runs, rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      created_at: "2026-08-20T00:00:00Z",
      schedule: [{ sequence_index: 0, memory_mode: "off", provider_pin: "m-a" }],
    }));
    writeFileSync(join(dir, "manifest.status.jsonl"), `${JSON.stringify(OFF_PASS)}\n`);
    writeCellFingerprint(dir, 0);

    // A legacy flat campaign beside the tree. A DIFFERENT model, because the
    // list is one row per model — two m-a floors would fold into a single row.
    writeRun(runs, "cumulative-legacy-model", { model: "m-b", status: OFF_PASS });


    const idx = await readBaselines({ runsRoot: runs, models: [] });
    assert.equal(idx.list.length, 2);

    const treeRow = idx.list.find((r) => r.model === "m-a");
    assert.equal(treeRow.state, "complete");
    assert.equal(treeRow.run_dir, rel, "the full runs-root-relative path — the one that is findable on disk");

    const flatRow = idx.list.find((r) => r.model === "m-b");
    assert.equal(flatRow.run_dir, "cumulative-legacy-model", "a flat campaign's leaf is its full path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("BASELINE: an id is stable across derivations and distinct per cell", async () => {
  // An operator quotes this id in a report. It is derived from the run directory
  // and the schedule index rather than from a counter, so it survives a service
  // restart and cannot be reassigned to a different cell.
  assert.equal(baselineId("cumulative", 0), baselineId("cumulative", 0));
  assert.notEqual(baselineId("cumulative", 0), baselineId("cumulative", 1));
  assert.notEqual(baselineId("cumulative", 0), baselineId("cumulative-m-b", 0));
  assert.match(baselineId("cumulative", 0), /^base-[0-9a-f]{4}$/);
});

test("TOKEN: the substrate is part of the confirmation fingerprint", () => {
  // `kind` decides whether the cell runs on the resident local model or is
  // routed to a vendor that bills for it — the largest difference any single
  // parameter makes. Omitted from the token, a confirmation minted for a local
  // cell would be valid for a cloud one carrying the same model id: a run the
  // operator never saw a restatement for, and one that spends money.
  const base = { model: "m", arm: "off", org: null, context: null };
  assert.notEqual(
    confirmationToken({ ...base, kind: "local" }),
    confirmationToken({ ...base, kind: "cloud" }),
  );
});

test("LEDGER: startable spans both substrates and gates each one separately", async () => {
  // The [+ PROFILE] modal's baseline branch renders this list. A picker that
  // offers a model the launch would refuse teaches the operator that the UI
  // lies, and the lesson generalises to every other control on the board.
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "cloud.env"), "ORCAROUTER_API_KEY=k\n");
  writeRun(root, "cumulative", { status: OFF_PASS });

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
    cloud: await readCloud({ benchRoot: root, env: {} }),
  });

  const local = led.startable.find((s) => s.id === "m-a");
  // It already has a floor — which is now reported as information, not a gate:
  // a repeat baseline is how a fingerprint earns an average.
  assert.equal(local.has_baseline, true, "the standing floor is still stated");
  assert.equal(local.can_baseline.allowed, true);
  assert.equal(local.can_baseline.reason, null, "a standing floor is not a refusal");

  const cloud = led.startable.find((s) => s.id === "anthropic/claude-opus-5");
  assert.equal(cloud.kind, "cloud");
  assert.equal(cloud.can_baseline.allowed, true);
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: with no key, every cloud model refuses and says which key is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [],
    cloud: await readCloud({ benchRoot: root, env: {} }),
  });
  const cloudRows = led.startable.filter((s) => s.kind === "cloud");
  assert.ok(cloudRows.length > 0);
  for (const row of cloudRows) {
    assert.equal(row.can_baseline.allowed, false);
    assert.match(row.can_baseline.reason, /ORCAROUTER_API_KEY/);
  }
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: a cell in flight blocks its OWN model's rows on BOTH substrates, never another model's", async () => {
  // The serial rule is a per-model property of the BENCH, applied identically
  // to a local row and a cloud row — and it is the rule most easily broken by a
  // per-row UI, because each row looks independent.
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "cloud.env"), "ORCAROUTER_API_KEY=k\n");
  writeRun(root, "cumulative", { status: OFF_PASS });

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
    inFlightModels: new Set(["m-a", "anthropic/claude-opus-5"]),
    cloud: await readCloud({ benchRoot: root, env: {} }),
  });

  const byId = Object.fromEntries(led.startable.map((s) => [s.id, s]));
  // The two in-flight models are blocked, each on its own substrate.
  assert.equal(byId["m-a"].can_baseline.allowed, false);
  assert.match(byId["m-a"].can_baseline.reason, /already in flight/);
  assert.equal(byId["anthropic/claude-opus-5"].can_baseline.allowed, false);
  assert.match(byId["anthropic/claude-opus-5"].can_baseline.reason, /already in flight/);
  // EVERY OTHER cloud model is untouched — the gate is per model, not global.
  const others = led.startable.filter((s) => s.kind === "cloud" && s.id !== "anthropic/claude-opus-5");
  assert.ok(others.length > 0, "the catalogue offers more than one cloud model");
  for (const s of others) {
    assert.equal(s.can_baseline.allowed, true, `${s.id} has no cell in flight and a key resolves`);
  }

  // The only measured floor is m-a's, and its model is in flight.
  for (const b of led.baseline_rows) {
    assert.equal(b.can_run.allowed, false);
    assert.match(b.can_run.reason, /already in flight/);
  }
  rmSync(root, { recursive: true, force: true });
});



// ── THE Δ IS THE FINGERPRINT AVERAGE, AND ADDING A BASELINE IS THE ONLY THING
// THAT MOVES IT ──────────────────────────────────────────────────────────────
//
// A Δ used to be read against one picked cell, so re-picking the floor shifted
// the number shown for every run already measured against it. The average of
// every baseline on the same fingerprint cannot do that: a baseline added on the
// SAME code moves the average (and the Δ with it, and the Δ says how many
// baselines that was), a run added beside it moves nothing, and a baseline on a
// DIFFERENT fingerprint belongs to another family entirely.

/**
 * One campaign of m-a: OFF baselines (a cost stamp each — that is what the
 * per-fingerprint average is made of) followed by ON runs.
 */
function writeAverageCampaign(root, { baselines, ons }) {
  const slots = [
    ...baselines.map((turns, i) => ({
      seq: i,
      arm: "off",
      status: { type: "attempt", sequence_index: i, verdict: "FAIL", progress: { turns, problems_before: 7 } },
    })),
    ...ons.map((turns, i) => ({
      seq: baselines.length + i,
      arm: "on",
      status: {
        type: "attempt",
        sequence_index: baselines.length + i,
        verdict: "PASS",
        progress: { turns },
      },
    })),
  ];
  const dir = writeCampaign(root, "cumulative", slots);
  baselines.forEach((turns, i) => writeCellCost(dir, i, { record: costStamp({ turns }) }));
  return dir;
}

/** The ledger as the card reads it, plus the first (oldest) ON run of m-a. */
async function readLedgerRun(root) {
  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
  });
  return { led, run: led.models[0].runs[0] };
}

test("LEDGER: a Δ is the fingerprint average, and it says how many baselines that is", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  writeAverageCampaign(root, { baselines: [20, 30], ons: [22] });

  const { led, run } = await readLedgerRun(root);
  // The average is derived from the OFF cells on exactly this code.
  assert.equal(led.fingerprints.length, 1);
  const [fp] = led.fingerprints;
  assert.equal(fp.baseline_count, 2);
  assert.equal(fp.avg.turns, 25, "the mean of 20 and 30 — neither cell on its own");

  assert.equal(run.delta.computable, true);
  assert.equal(run.delta.turns, 22 - 25, "the Δ is against the average, not a picked cell");
  assert.equal(run.delta.baseline_count, 2, "the reading says how many baselines it is over");
  assert.equal(run.delta.fingerprint, fp.fingerprint_hash, "and which code that was");
  assert.match(run.delta.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(run.delta.better, true, "fewer turns than the average is an improvement");
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: adding a baseline is the only thing that moves a Δ", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  const step = () => readLedgerRun(root);

  // Two baselines (20, 30) and one ON run (22) → 22 − 25.
  writeAverageCampaign(root, { baselines: [20, 30], ons: [22] });
  let s = await step();
  assert.equal(s.run.delta.turns, 22 - 25);
  assert.equal(s.run.delta.baseline_count, 2);

  // A THIRD baseline on the same code moves the average, and the Δ with it.
  writeAverageCampaign(root, { baselines: [20, 30, 40], ons: [22] });
  s = await step();
  assert.equal(s.run.cell.turns, 22, "still the same ON run");
  assert.equal(s.run.delta.turns, 22 - 30, "the average moved (25 → 30), so the Δ did");
  assert.equal(s.run.delta.baseline_count, 3, "and it now says it is over three");

  // Another RUN beside it moves nothing — a run is not a baseline.
  writeAverageCampaign(root, { baselines: [20, 30, 40], ons: [22, 5] });
  s = await step();
  assert.equal(s.run.cell.turns, 22, "the run read is still the first ON run");
  assert.equal(s.run.delta.turns, 22 - 30, "a run added beside it leaves the Δ alone");
  assert.equal(s.run.delta.baseline_count, 3);

  // A baseline on a DIFFERENT fingerprint is another family: it changes neither.
  const other = writeRun(root, "cumulative-other-code", {
    status: { type: "attempt", sequence_index: 0, verdict: "FAIL", progress: { turns: 99, problems_before: 7 } },
  });
  writeCellFingerprint(other, 0, { values: { ...FIXTURE_FP, source_commit: "e".repeat(40) } });
  writeCellCost(other, 0, { record: costStamp({ turns: 99 }) });

  s = await step();
  assert.equal(s.led.fingerprints.length, 2, "a second family of baselines now exists");
  assert.equal(s.run.delta.turns, 22 - 30, "a baseline on another code never enters this Δ");
  assert.equal(s.run.delta.baseline_count, 3, "nor its count");
  const own = s.led.fingerprints.find((f) => f.fingerprint_hash === s.run.delta.fingerprint);
  assert.equal(own.baseline_count, 3, "this fingerprint still holds exactly its three baselines");
  assert.equal(own.avg.turns, 30);
  rmSync(root, { recursive: true, force: true });
});
