// Pins the run-ledger contract — the live-cell cache over the durable cell
// registry (cell-registry.mjs). The Map holds ONLY live records
// (finished === false): registerRun stores a normalized COPY and, once
// initLedger has bound a runs root, write-throughs a durable JSON;
// recordCellEnded merges the end durably and evicts the slot; evictRun is a
// pure cache delete. The module Map persists for the process, so every test
// evicts what it registers, and the initLedger test runs LAST (it binds
// module state; nothing unbinds it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  newRunId,
  initLedger,
  registerRun,
  evictRun,
  recordCellEnded,
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
  // getRun reads the stored COPY: deep-equal to the input with finished
  // normalized to false — never the caller's object itself.
  assert.deepEqual(getRun(rec.run_id), { ...rec, finished: false });
  assert.notEqual(getRun(rec.run_id), rec, "registerRun stores a copy, not the caller's object");

  const next = { ...rec, pid: 4242 };
  registerRun(next);
  assert.deepEqual(
    getRun(rec.run_id),
    { ...next, finished: false },
    "re-registering the same run_id overwrites the slot",
  );

  // The Map holds only live records: even a finished:true input stores live.
  const stale = makeRecord({ finished: true, terminal_status: "complete", terminal_ok: true });
  registerRun(stale);
  assert.equal(getRun(stale.run_id).finished, false, "registerRun normalizes finished to false");

  assert.equal(evictRun(rec.run_id), true);
  assert.equal(evictRun(stale.run_id), true);
});

test("RUN-LEDGER: registerRun fails loud without a usable run_id", () => {
  assert.throws(() => registerRun(makeRecord({ run_id: null })), TypeError);
  assert.throws(() => registerRun(null), TypeError);
  assert.equal(runCount(), 0, "a refused registration leaves the ledger empty");
});

test("RUN-LEDGER: liveRuns/runCount hold only live slots; recordCellEnded drops the slot", () => {
  const rec = makeRecord({ model: "m-live" });
  registerRun(rec);

  assert.deepEqual(liveRuns(), [{ ...rec, finished: false }], "liveRuns is every Map value");
  assert.equal(runCount(), 1);

  // Ledger UNBOUND (no initLedger): nothing durable to merge → false, but the
  // cache slot is evicted all the same.
  assert.equal(recordCellEnded(rec.run_id, null, { reason: "stopped by operator" }), false);
  assert.equal(getRun(rec.run_id), undefined, "recordCellEnded evicts the cache slot");
  assert.equal(runCount(), 0);
  assert.deepEqual(liveRuns(), []);
});

test("RUN-LEDGER: inFlightModels is the distinct models of live runs", () => {
  const a = makeRecord({ model: "m-x" });
  const b = makeRecord({ model: "m-x", sequence_index: 1 });
  const c = makeRecord({ model: "m-y" });
  const done = makeRecord({ model: "m-z" });
  for (const r of [a, b, c, done]) registerRun(r);

  // Ending a run drops its model from the gate.
  recordCellEnded(done.run_id, null, { reason: "exit not observed" });

  const models = inFlightModels();
  assert.ok(models instanceof Set);
  assert.deepEqual([...models].sort(), ["m-x", "m-y"], "distinct live models only; m-z has ended");

  for (const r of [a, b, c]) assert.equal(evictRun(r.run_id), true);
});

test("RUN-LEDGER: evictRun is a pure cache delete — returns true, then false; the slot is gone", () => {
  const rec = makeRecord();
  registerRun(rec);
  assert.equal(evictRun(rec.run_id), true);
  assert.equal(getRun(rec.run_id), undefined);
  assert.equal(evictRun(rec.run_id), false, "an absent run_id is false, not a throw");
});

// LAST: initLedger binds module state (RUNS_ROOT) for the process lifetime.
test("RUN-LEDGER: initLedger + registerRun write a durable record; recordCellEnded records the end on disk", () => {
  const root = join(mkdtempSync(join(tmpdir(), "ledger-")), "runs");
  const rec = makeRecord({ model: "m-durable", run_dir: "cumulative" });
  try {
    initLedger(root);
    registerRun(rec);

    // run_dir "cumulative" has no tree-id first segment → the flat layout.
    const path = join(root, "launches", `${rec.run_id}.json`);
    assert.ok(existsSync(path), "registerRun write-throughs a durable JSON");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ...rec, finished: false });

    assert.equal(
      recordCellEnded(rec.run_id, "cumulative", { reason: "exit not observed" }),
      true,
      "a durable record was merged",
    );
    const after = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(after.finished, true, "the on-disk record is finished");
    assert.equal(after.ended.reason, "exit not observed");
    assert.equal(getRun(rec.run_id), undefined, "the cache slot is evicted");
  } finally {
    // The Map persists for the process: evict this test's record so no live
    // slot leaks, then remove the temp root.
    evictRun(rec.run_id);
    rmSync(root, { recursive: true, force: true });
  }
});
