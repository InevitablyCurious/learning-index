// Deleting a run permanently.
//
// The rule these hold to: standardise the view, never the data. So the tests
// that matter most are the REFUSALS — an archive whose layout this code does
// not recognise, the live tree, a run in flight. Each one must leave the disk
// untouched and hand back a reason worth pasting.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { deleteRun, planRunDelete } from "./rundelete.mjs";
import { listRunCells } from "./history.mjs";

const CAMPAIGN = "local/prov/omlx/model-a";

function root() {
  return mkdtempSync(join(tmpdir(), "okp-del-"));
}

/** A tree with one cell, live or archived under `backups/<newer>/`. */
function writeTree(r, treeId, { under = null, cell = "cell-0000" } = {}) {
  const base = under ? join(r, "backups", under, treeId) : join(r, treeId);
  const cellDir = join(base, CAMPAIGN, "memoryOFF", cell);
  mkdirSync(join(cellDir, "worktree", "src"), { recursive: true });
  writeFileSync(join(base, CAMPAIGN, "manifest.json"), "{}");
  writeFileSync(join(cellDir, "transcript.md"), "# t\n");
  writeFileSync(join(cellDir, "worktree", "src", "server.ts"), "// x\n");
  if (under) {
    writeFileSync(join(r, "backups", under, "baselines.json"), "{}");
    writeFileSync(join(r, "backups", under, "results-ledger.jsonl"), "");
  }
  return base;
}

function setActive(r, id) {
  writeFileSync(join(r, "active-tree.json"), JSON.stringify({ active: id }));
}

test("plan: an archived run names the whole backup folder, sized and restated", async () => {
  const r = root();
  try {
    writeTree(r, "1788976174", { under: "1789023699" });
    setActive(r, "1789023699");
    const [row] = await listRunCells(r);
    const plan = await planRunDelete(r, row.benchmark_id, row.cell);

    assert.equal(plan.ok, true);
    assert.equal(plan.tree_id, "1788976174");
    assert.equal(plan.archived, true);
    assert.equal(plan.target, join(r, "backups", "1789023699"));
    assert.ok(plan.files >= 3, "the walk must actually count files");
    assert.match(plan.restatement, /Permanently delete run 1788976174/);
    assert.match(plan.restatement, /THIS IS NOT A RESET/);
    assert.match(plan.restatement, /baselines\.json is derived/);
    assert.match(plan.token, /^delete-run\|1788976174\|files=\d+\|bytes=\d+$/);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("delete: removes the folder and tidies an empty archive", async () => {
  const r = root();
  try {
    writeTree(r, "1788976174", { under: "1789023699" });
    setActive(r, "1789023699");
    const [row] = await listRunCells(r);
    const plan = await planRunDelete(r, row.benchmark_id, row.cell);

    const done = await deleteRun(r, row.benchmark_id, row.cell, plan.token);
    assert.equal(done.ok, true);
    assert.equal(existsSync(join(r, "backups", "1789023699")), false);
    assert.deepEqual(await listRunCells(r), [], "the run is gone from history");
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("delete: REFUSES a stale token and touches nothing", async () => {
  const r = root();
  try {
    const base = writeTree(r, "1788976174", { under: "1789023699" });
    setActive(r, "1789023699");
    const [row] = await listRunCells(r);

    const bad = await deleteRun(r, row.benchmark_id, row.cell, "delete-run|1788976174|files=1|bytes=1");
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "bad_confirmation");
    assert.ok(bad.restatement, "the operator is re-shown what is actually there");
    assert.equal(existsSync(base), true, "nothing may be removed on a bad token");
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("REFUSES the live tree, and says what to do instead", async () => {
  const r = root();
  try {
    writeTree(r, "1789023699");
    setActive(r, "1789023699");
    const [row] = await listRunCells(r);
    const plan = await planRunDelete(r, row.benchmark_id, row.cell);

    assert.equal(plan.ok, false);
    assert.equal(plan.code, "active_tree");
    assert.equal(plan.status, 409);
    assert.match(plan.reason, /Reset the bench from the board first/);
    assert.equal(existsSync(join(r, "1789023699")), true);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("a NON-active live tree is deletable", async () => {
  const r = root();
  try {
    writeTree(r, "1788600000");
    setActive(r, "9999999999");
    const [row] = await listRunCells(r);
    const plan = await planRunDelete(r, row.benchmark_id, row.cell);
    assert.equal(plan.ok, true);
    assert.equal(plan.archived, false);
    assert.equal(plan.target, join(r, "1788600000"));

    const done = await deleteRun(r, row.benchmark_id, row.cell, plan.token);
    assert.equal(done.ok, true);
    assert.equal(existsSync(join(r, "1788600000")), false);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("a run in flight blocks a LIVE tree, not an archived one", async () => {
  const r = root();
  try {
    // Archived: the harness writes to the active tree and nowhere else, so an
    // archived run is never the thing a live run is in the middle of.
    writeTree(r, "1788976174", { under: "1789023699" });
    // Live but not active: a real tree the harness could be writing to.
    writeTree(r, "1788600000");
    setActive(r, "9999999999");
    const rows = await listRunCells(r);

    const arch = rows.find((x) => x.archived);
    const okPlan = await planRunDelete(r, arch.benchmark_id, arch.cell, { runInFlight: true });
    assert.equal(okPlan.ok, true, "an archived run stays deletable during a run");

    const live = rows.find((x) => !x.archived);
    const blocked = await planRunDelete(r, live.benchmark_id, live.cell, { runInFlight: true });
    assert.equal(blocked.code, "run_in_flight");
    assert.match(blocked.reason, /Archived runs can be deleted while a run is going/);
    assert.equal(existsSync(join(r, "1788600000")), true);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("REFUSES an archive holding more than the one tree — and lists what it found", async () => {
  const r = root();
  try {
    // Two trees under one backup folder is not a layout the reset writes. It is
    // somebody else's data or a changed convention; either way, do not sweep it.
    writeTree(r, "1788976174", { under: "1789023699" });
    writeTree(r, "1788111111", { under: "1789023699" });
    setActive(r, "1789023699");
    const rows = await listRunCells(r);
    const plan = await planRunDelete(r, rows[0].benchmark_id, rows[0].cell);

    assert.equal(plan.ok, false);
    assert.equal(plan.code, "unrecognised_layout");
    assert.match(plan.reason, /expected exactly one/);
    assert.match(plan.reason, /Nothing was deleted/);
    assert.deepEqual(plan.found.sort(), ["1788111111", "1788976174"]);
    assert.equal(existsSync(join(r, "backups", "1789023699")), true);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("REFUSES an identifier that escapes the runs root", async () => {
  const r = root();
  try {
    for (const [run, cell] of [["..", "x"], ["backups", "../../etc"], ["", ""]]) {
      const plan = await planRunDelete(r, run, cell);
      assert.equal(plan.ok, false, `${run}/${cell} must not resolve`);
    }
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("never deletes the runs root itself", async () => {
  const r = root();
  try {
    const plan = await planRunDelete(r, ".", "");
    assert.equal(plan.ok, false);
    assert.equal(existsSync(r), true);
  } finally { rmSync(r, { recursive: true, force: true }); }
});
