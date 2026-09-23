// STOP A CONCURRENT BATCH — lib/lifecycle.mjs planStop.
//
// stopRun() refused whenever more than one run was live, so the board's STOP
// and RESET could not stop an N-cell batch at all (2026-09-23: 8 cells were
// cancelled by hand). And N cells of one campaign share one manifest path, so
// a run_dir-scoped scan finds every sibling: stopping cell by cell signalled
// each harness N times, and a second SIGINT can interrupt the teardown the
// first began. The plan signals each harness exactly once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { planStop } from "../lib/lifecycle.mjs";

const run = (seq, over = {}) => ({ run_id: null, pid: null, run_dir: "r/camp", sequence_index: seq, ...over });

test("eight cells of one campaign, no pids known: one scan, each harness once", async () => {
  let scans = 0;
  const procs = Array.from({ length: 8 }, (_, i) => ({ pid: 100 + i, pgid: 100 + i, cmd: "run_cumulative.py" }));
  const { targets } = await planStop(Array.from({ length: 8 }, (_, i) => run(i)), {
    ledger: () => null,
    alive: () => false,
    scan: async () => { scans += 1; return { bound: procs, other: [] }; },
  });
  assert.equal(scans, 1, "one scan per run dir, not per cell");
  assert.deepEqual(targets.map((t) => t.pid).sort(), procs.map((p) => p.pid));
});

test("ledger pids that are alive are used as is, and never doubled by a scan", async () => {
  const { targets } = await planStop([run(0, { run_id: "a" }), run(1, { run_id: "b" })], {
    ledger: (id) => ({ a: { pid: 10 }, b: { pid: 11 } })[id],
    alive: () => true,
    scan: async () => { throw new Error("no scan needed"); },
  });
  assert.deepEqual(targets, [{ pid: 10, pgid: 10, own: true }, { pid: 11, pgid: 11, own: true }]);
});

test("a harness that names no run dir is signalled only when it is the sole live run", async () => {
  const scan = async () => ({ bound: [], other: [{ pid: 7, pgid: 7 }] });
  const sole = await planStop([run(0, { run_dir: null })], { ledger: () => null, alive: () => false, scan });
  assert.deepEqual(sole.targets.map((t) => t.pid), [7]);
  const two = await planStop([run(0, { run_dir: null }), run(1, { run_dir: null })], { ledger: () => null, alive: () => false, scan });
  assert.deepEqual(two.targets, [], "an unattributable process is left alone, not guessed");
});

test("a failed scan is reported, not read as an empty machine", async () => {
  const out = await planStop([run(0)], { ledger: () => null, alive: () => false, scan: async () => null });
  assert.equal(out.scanFailed, true);
  assert.deepEqual(out.targets, []);
});
