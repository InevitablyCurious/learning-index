// Extracted verbatim from control/control.test.mjs — WO-LI18 split A.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { confirmationToken } from "../contract.mjs";
import { readCloud, resolveCloudModel, cloudCatalog, CLOUD_MODELS, CONTEXT_ADVISORY_FLOOR } from "../cloud.mjs";
import { readBaselines, BASELINES_FILE, isArchivedRun, baselineId, identifyCell, collectOffCells, assembleBatchForCells } from "../baselines.mjs";
import { selectRun, writeBatch, markVoid } from "../batch.mjs";
import { manifestArgFor, campaignDirName } from "../campaign.mjs";
import { mintTree } from "../tree.mjs";
import { readModelsLedger } from "../models-ledger.mjs";

import { BENCH, writeRun, writeCampaign, OFF_PASS, writeCampaignCell, treeFixture } from "./_shared.mjs";

/**
 * The operator's pick: assemble the batch for one model's OFF cells and select
 * `seq` as the floor. A single completed OFF cell is no longer a baseline by
 * itself — a floor exists only once the batch carries a selection.
 */
async function selectFloor(root, dir, model, seq = 0) {
  const cells = (await collectOffCells(root)).filter((c) => c.model === model);
  const runDir = join(root, dir);
  const batch = await assembleBatchForCells({ runDir, cells });
  selectRun(batch, seq);
  await writeBatch(runDir, batch);
}

test("LEDGER: a SELECTED OFF cell is the baseline, and it opens + run but not + baseline", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  writeRun(root, "cumulative", { status: OFF_PASS });
  await selectFloor(root, "cumulative", "m-a");

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
  });
  const m = led.models[0];
  assert.equal(m.baseline.scorable, true);
  assert.equal(m.can_run.allowed, true);
  // Re-baselining is a declared act (RUNBOOK 5.13), never a live button.
  assert.equal(m.can_baseline.allowed, false);

  // The card's own rooting carries the same verdict on the same floor.
  const row = led.baseline_rows.find((b) => b.model === "m-a");
  assert.ok(row, "a measured floor has no row in baseline_rows");
  assert.equal(row.can_run.allowed, true);
  assert.equal(row.run_count, 0, "no ON cell has been measured against it yet");
  rmSync(root, { recursive: true, force: true });
});

/** OFF_PASS plus the graded problem count the batch median is built from. */
const OFF_PASS_MEASURED = {
  ...OFF_PASS,
  progress: { ...OFF_PASS.progress, problems_before: 7 },
};

test("LEDGER: an UNSELECTED batch is a VISIBLE 'awaiting' row carrying the median — never silently dropped", async () => {
  // The failure this prevents: baselineFor answered awaiting_selection (a batch
  // exists, no floor does) but baselineList derived no flag from it, computed
  // state "none" and skipped the row — so the card never showed the batch the
  // operator has to pick from, and the model looked never-run.
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  writeRun(root, "cumulative", { status: OFF_PASS_MEASURED });
  // NO selectFloor: the batch assembles on first read, the selection never does.

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
  });
  const row = led.baseline_rows.find((b) => b.model === "m-a");
  assert.ok(row, "an awaiting-selection batch must appear in baseline_rows");
  assert.equal(row.state, "awaiting");
  assert.equal(row.reason, "awaiting_selection");
  assert.equal(row.scorable, false, "an unselected batch is not a floor");
  assert.equal(row.median, 7, "the batch median rides the row so the card can render it");
  assert.equal(row.void_input, null, "nothing is void here");
  assert.equal(row.candidates, 1, "the batch's scored-run count rides the row");
  assert.equal(row.can_run.allowed, false, "no floor — nothing may be measured against it");
  assert.equal(row.can_run.reason, "awaiting_selection");
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: a batch_void row names the changed input — void_input rides through to baseline_rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  writeRun(root, "cumulative", { status: OFF_PASS_MEASURED });

  // Assemble the batch, then void it on a named fingerprint input — the same
  // markVoid a stale-fingerprint read performs (batch.mjs).
  const runDir = join(root, "cumulative");
  const cells = (await collectOffCells(root)).filter((c) => c.model === "m-a");
  const batch = await assembleBatchForCells({ runDir, cells });
  markVoid(batch, "grader_hash", "grader/gate suite — a changed test changes what a failure count means");
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
  // gate keyed on "a cell completed" would green-light an ON run whose every Δ
  // is measured against the harness rather than the model.
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  writeRun(root, "cumulative", {
    status: { type: "attempt", sequence_index: 0, verdict: "FAIL", terminal_reason: "transport_incomplete", progress: { turns: 2 } },
  });

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
  });
  const m = led.models[0];
  assert.equal(m.baseline.scorable, false);
  assert.equal(m.baseline.voided, true);
  assert.equal(m.can_run.allowed, false, "nothing may be measured against a void floor");
  assert.equal(m.can_baseline.allowed, true, "the operator must be able to re-measure");
  assert.match(m.can_baseline.reason ?? "", /^$|void/i);
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: attempt_ceiling_reached is a real FAIL, not a void instrument", async () => {
  // A model that fails every attempt is the bench's most important finding.
  // Calling it an instrument fault would discard it.
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  writeRun(root, "cumulative", {
    status: { type: "attempt", sequence_index: 0, verdict: "FAIL", terminal_reason: "attempt_ceiling_reached", progress: { turns: 40 } },
  });
  await selectFloor(root, "cumulative", "m-a");

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
  });
  assert.equal(led.models[0].baseline.scorable, true, "a capability FAIL is a usable floor");
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
  await selectFloor(root, "cumulative", "m-a");

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
  assert.equal(byId["m-b"].can_run.allowed, false, "m-b still has no floor to run against");
  assert.ok(
    !/in flight/.test(String(byId["m-b"].can_run.reason)),
    "m-b's refusal is about its missing floor, not about a cell it does not have",
  );

  // The floor row of the in-flight model must not offer a launch either.
  const row = led.baseline_rows.find((b) => b.model === "m-a");
  assert.equal(row.can_run.allowed, false, "a floor row must not offer a launch either");
  assert.match(row.can_run.reason, /already in flight/);
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: a floor on one model never blocks another model's + baseline", async () => {
  // THE DEFECT THIS PINS. The profile subject rule was applied to OFF cells as
  // well as ON, so freezing the first profile disabled [+ baseline] on every
  // OTHER bench model — and since a run gates on a floor, no second model could
  // ever be benchmarked. The whole bench silently locked to whichever model was
  // profiled first, with four permanently disabled buttons to show for it. The
  // profile store is gone; this pins the surviving rule.
  //
  // A baseline is measured against nothing. One floor per model, and no other
  // model's floor has any bearing on it.
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  writeRun(root, "cumulative", { status: OFF_PASS });           // m-a has a floor
  await selectFloor(root, "cumulative", "m-a");

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [
      { id: "m-a", bench_eligible: true },
      { id: "m-b", bench_eligible: true },
      { id: "m-c", bench_eligible: true },
    ],
  });

  const byId = Object.fromEntries(led.models.map((m) => [m.id, m]));
  // m-a is floored: no second baseline, but a run against it is open.
  assert.equal(byId["m-a"].can_baseline.allowed, false);
  assert.match(byId["m-a"].can_baseline.reason, /already has a valid baseline/);
  assert.equal(byId["m-a"].can_run.allowed, true);
  // Every other model may still measure its own floor.
  for (const id of ["m-b", "m-c"]) {
    assert.equal(byId[id].can_baseline.allowed, true, `${id} must be able to measure its own floor`);
    assert.equal(byId[id].can_baseline.reason, null, "an open gate states no refusal");
    // …and nothing can be measured against a floor it does not have.
    assert.equal(byId[id].can_run.allowed, false);
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
  await selectFloor(root, "cumulative", "m-a");
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
  await selectFloor(root, "cumulative", "m-a");

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
  writeCampaign(root, "cumulative", [
    { seq: 0, arm: "off", status: { ...OFF_PASS, sequence_index: 0 } },
    { seq: 1, arm: "on", status: { type: "attempt", sequence_index: 1, verdict: "PASS", progress: { turns: 6, total_tokens: 300, wall_seconds: 40 } } },
    { seq: 2, arm: "on", status: { type: "attempt", sequence_index: 2, verdict: "PASS", progress: { turns: 7, total_tokens: 350, wall_seconds: 45 } } },
  ]);
  await selectFloor(root, "cumulative", "m-a");

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
  });
  const row = led.baseline_rows.find((b) => b.model === "m-a");
  assert.equal(row.run_count, 2, "both ON cells are runs; the OFF cell is the floor, not a run");

  // NEWEST FIRST on the wire, and the ordinals are positions in the SCHEDULE —
  // a run\'s number never changes when a later one is added.
  assert.deepEqual(row.runs.map((r) => r.seq), [2, 1]);
  assert.deepEqual(row.runs.map((r) => r.sequence_index), [2, 1]);
  for (const r of row.runs) assert.ok(r.cell, "an ON cell on disk always carries its measurement");

  // Δ IS AGAINST THIS ROW\'S FLOOR, and `better` is a word, not the sign.
  const first = row.runs.find((r) => r.seq === 1);
  assert.equal(first.delta.computable, true);
  assert.equal(first.delta.turns, 6 - 9);
  assert.equal(first.delta.better, true, "fewer turns than the floor is an improvement");

  // BEST IS EFFICIENCY ONLY and says so.
  assert.equal(row.best.run_seq, 1);
  assert.equal(row.best.turns, -3);
  assert.equal(row.best.axis, "efficiency");
  rmSync(root, { recursive: true, force: true });
});

test("LEDGER: the floor\'s own OFF cell is never listed as a run against itself", async () => {
  // A Δ of a cell against itself is zero, and it would sit at the top of every
  // list looking like a measurement. The arm is the filter: only ON cells are
  // runs. This also replaces the old wrong-arm check — a recorded key could
  // point at the OFF cell and adopt its numbers for an ON run, inverting the
  // sign of every Δ. Nothing is recorded now, so that state is unreachable.
  const root = mkdtempSync(join(tmpdir(), "okp-mled-"));
  writeCampaign(root, "cumulative", [
    { seq: 0, arm: "off", status: { ...OFF_PASS, sequence_index: 0 } },
    { seq: 1, arm: "on", status: { type: "attempt", sequence_index: 1, verdict: "PASS", progress: { turns: 6 } } },
  ]);
  await selectFloor(root, "cumulative", "m-a");

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
  });
  const row = led.baseline_rows.find((b) => b.model === "m-a");
  assert.equal(row.sequence_index, 0, "the floor is slot 0");
  assert.equal(row.run_count, 1);
  assert.deepEqual(row.runs.map((r) => r.sequence_index), [1], "slot 0 is the floor, not a run against it");
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
  await selectFloor(root, "cumulative-anthropic-claude-opus-5", "anthropic/claude-opus-5");

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

    // A legacy flat campaign beside the tree. A DIFFERENT model, because the
    // list is one row per model — two m-a floors would fold into a single row.
    writeRun(runs, "cumulative-legacy-model", { model: "m-b", status: OFF_PASS });

    await selectFloor(runs, rel, "m-a");
    await selectFloor(runs, "cumulative-legacy-model", "m-b");

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

test("TOKEN: the armed snapshot is part of the confirmation fingerprint", () => {
  // A confirmation binds to the snapshot armed when it was minted. Omitted
  // from the token, arming a different snapshot between preview and start
  // would still validate the old confirmation — the operator confirms one
  // snapshot and the run reads another. Arming ANY snapshot after an
  // unset-snapshot preview must likewise invalidate the pending confirmation.
  assert.notEqual(
    confirmationToken({ model: "m", arm: "off", snapshotId: "snap-a" }),
    confirmationToken({ model: "m", arm: "off", snapshotId: "snap-b" }),
  );
  assert.notEqual(
    confirmationToken({ model: "m", arm: "off", snapshotId: null }),
    confirmationToken({ model: "m", arm: "off", snapshotId: "snap-a" }),
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
  await selectFloor(root, "cumulative", "m-a");

  const led = await readModelsLedger({
    runsRoot: root,
    benchModels: [{ id: "m-a", bench_eligible: true }],
    cloud: await readCloud({ benchRoot: root, env: {} }),
  });

  const local = led.startable.find((s) => s.id === "m-a");
  // It already has a floor, so re-baselining is refused — and the refusal names
  // the declared act that IS the way to do it.
  assert.equal(local.can_baseline.allowed, false);
  assert.match(local.can_baseline.reason, /declared act/);

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
  await selectFloor(root, "cumulative", "m-a");

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

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION: THE GATE WALL READ A RUN DIRECTORY THAT NO LONGER EXISTS.
//
// Campaigns became per-model (`campaignDirName` → `runs/cumulative-<model>`)
// while every run-scoped read still defaulted to the literal `"cumulative"`.
// Nothing failed loudly: `readWall` found no pinned roster there, enumerated the
// live suite instead, found no `manifest.status.jsonl`, and served a TRUE
// denominator with zero outcomes against it. The board printed `0/71 passing`
// over 71 empty squares while the run's own artifacts recorded 16 passing and
// 2 failing — the exact "measured and passed" vs "not measured" confusion the
// wall was rebuilt to make impossible.
//
// The old suite could not catch this: every fixture named its run directory
// `cumulative`, so the stale default was correct in the tests and wrong only on
// disk. These two assert the join the server actually depends on — the run
// directory is RESOLVED FROM THE LOG, and a per-model campaign folds normally.
// ─────────────────────────────────────────────────────────────────────────────

/** A campaign directory with a pinned roster and one attempt's outcomes. */

