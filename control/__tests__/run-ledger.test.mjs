// Pins the run-ledger contract — the N-slot registry keyed on control-plane
// run_id. Imported directly; the module Map is the only state, so every test
// unregisters what it registers and the ledger is empty at each test's start.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  newRunId,
  registerRun,
  unregisterRun,
  markRunFinished,
  getRun,
  liveRuns,
  runCount,
  inFlightModels,
} from "../run-ledger.mjs";

/** A complete RunRecord with a fresh run_id; override any field. */
function makeRecord(overrides = {}) {
  return {
    run_id: newRunId(),
    sequence_index: 0,
    model: "m-a",
    arm: "off",
    kind: "local",
    org: null,
    context: null,
    manifest_arg: null,
    pid: null,
    started_at: null,
    log_path: null,
    run_dir: null,
    finished: false,
    terminal_status: null,
    terminal_ok: null,
    ...overrides,
  };
}

test("RUN-LEDGER: newRunId is unique across 100 calls", () => {
  const ids = new Set();
  for (let i = 0; i < 100; i += 1) ids.add(newRunId());
  assert.equal(ids.size, 100);
});

test("RUN-LEDGER: registerRun + getRun round-trip; re-register overwrites by run_id", () => {
  const rec = makeRecord({ model: "m-round", sequence_index: 3 });
  assert.equal(registerRun(rec), rec, "registerRun returns the record");
  assert.equal(getRun(rec.run_id), rec, "getRun returns the same record");

  const next = { ...rec, pid: 4242 };
  registerRun(next);
  assert.equal(getRun(rec.run_id), next, "re-registering the same run_id overwrites the slot");

  assert.equal(unregisterRun(rec.run_id), true);
});

test("RUN-LEDGER: registerRun fails loud without a usable run_id", () => {
  assert.throws(() => registerRun(makeRecord({ run_id: null })), TypeError);
  assert.throws(() => registerRun(null), TypeError);
  assert.equal(runCount(), 0, "a refused registration leaves the ledger empty");
});

test("RUN-LEDGER: liveRuns excludes finished records", () => {
  const live = makeRecord({ model: "m-live" });
  const done = makeRecord({ model: "m-done", finished: true, terminal_status: "complete", terminal_ok: true });
  registerRun(live);
  registerRun(done);

  assert.deepEqual(liveRuns(), [live]);

  unregisterRun(live.run_id);
  unregisterRun(done.run_id);
});

test("RUN-LEDGER: runCount counts live runs only", () => {
  const a = makeRecord();
  const b = makeRecord({ finished: true, terminal_status: "failed", terminal_ok: false });
  assert.equal(runCount(), 0);

  registerRun(a);
  registerRun(b);
  assert.equal(runCount(), 1);

  // Finishing a run (overwrite by run_id) drops it from the count.
  registerRun({ ...a, finished: true, terminal_status: "complete", terminal_ok: true });
  assert.equal(runCount(), 0);

  unregisterRun(a.run_id);
  unregisterRun(b.run_id);
});

test("RUN-LEDGER: inFlightModels is the distinct models of live runs", () => {
  const a = makeRecord({ model: "m-x" });
  const b = makeRecord({ model: "m-x", sequence_index: 1 });
  const c = makeRecord({ model: "m-y" });
  const done = makeRecord({ model: "m-z", finished: true, terminal_status: "complete", terminal_ok: true });
  for (const r of [a, b, c, done]) registerRun(r);

  const models = inFlightModels();
  assert.ok(models instanceof Set);
  assert.deepEqual([...models].sort(), ["m-x", "m-y"], "distinct live models only; m-z is finished");

  for (const r of [a, b, c, done]) unregisterRun(r.run_id);
});

test("RUN-LEDGER: unregisterRun returns true, then false; the slot is gone", () => {
  const rec = makeRecord();
  registerRun(rec);
  assert.equal(unregisterRun(rec.run_id), true);
  assert.equal(unregisterRun(rec.run_id), false);
  assert.equal(getRun(rec.run_id), undefined);
});

test("RUN-LEDGER: markRunFinished flips finished + terminal facts; absent id is false", () => {
  assert.equal(markRunFinished("no-such-run"), false, "an absent run_id is false, not a throw");

  const rec = makeRecord({ model: "m-finish" });
  registerRun(rec);
  assert.equal(
    markRunFinished(rec.run_id, { terminal_status: "done", terminal_ok: true }),
    true,
  );
  const after = getRun(rec.run_id);
  assert.equal(after.finished, true);
  assert.equal(after.terminal_status, "done");
  assert.equal(after.terminal_ok, true);
  assert.deepEqual(liveRuns(), [], "a finished record leaves the live set");
  assert.equal(runCount(), 0);
  assert.deepEqual([...inFlightModels()], [], "its model is no longer in flight");
  // The slot stays as history — only unregisterRun removes it.
  assert.notEqual(after, undefined);

  // No options: an unvouched ending (wiped cell, vanished log).
  const bare = makeRecord({ model: "m-bare" });
  registerRun(bare);
  assert.equal(markRunFinished(bare.run_id), true);
  assert.equal(getRun(bare.run_id).finished, true);
  assert.equal(getRun(bare.run_id).terminal_status, null);
  assert.equal(getRun(bare.run_id).terminal_ok, null);

  unregisterRun(rec.run_id);
  unregisterRun(bare.run_id);
});
