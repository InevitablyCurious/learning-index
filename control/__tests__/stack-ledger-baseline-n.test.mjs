// ─────────────────────────────────────────────────────────────────────────────
// THE FLOOR'S n — baseline_n IS THE ARMED SNAPSHOT'S REAL DEPTH
//
// A seeded chain stacks builds: the baseline cell started n snapshots deep,
// so the curve's floor must carry that n or every delta against it lies.
// stack-ledger resolves the armed snapshot (config/armed-snapshot.json →
// <runsRoot>/snapshots/<id>/snapshot.json) and sets baseline_n from its
// snapshot_depth: default 1 when nothing is armed or the manifest predates
// depth capture (same `or 1` default as load_snapshot), and 0 when the stack
// has no baseline cell at all — no floor carries no n.
//
// Fixture pattern: control/board/arm-delta-validity.test.mjs drives the full
// read() the same way — one manifest is enough to produce a baseline cell.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeRun } from "./_shared.mjs";

/** Arm <id> and lay its manifest at <runsRoot>/snapshots/<id>/snapshot.json. */
function armSnapshot(root, id, manifest) {
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "config", "armed-snapshot.json"),
    JSON.stringify({ snapshot_id: id }),
  );
  mkdirSync(join(root, "snapshots", id), { recursive: true });
  writeFileSync(join(root, "snapshots", id, "snapshot.json"), JSON.stringify(manifest));
}

async function readStack(root) {
  const { read } = await import("../board/sources/stack-ledger.mjs");
  return read({ runsRoot: root, benchRoot: root, config: {} });
}

test("armed snapshot's snapshot_depth becomes baseline_n", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-baseline-n-"));
  try {
    // The floor cell: a scheduled OFF slot with no status is still the
    // baseline (pending, not void — see arm-delta-validity).
    writeRun(root, "cumulative", { arm: "off" });
    armSnapshot(root, "snap-1", { snapshot_depth: 3 });

    const res = await readStack(root);
    assert.equal(res.ok, true);
    assert.ok(res.patch.stack.baseline, "the OFF cell is the baseline");
    assert.equal(res.patch.stack.baseline_n, 3, "the floor's n is the armed snapshot's real depth");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("armed manifest without snapshot_depth defaults baseline_n to 1", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-baseline-n-"));
  try {
    writeRun(root, "cumulative", { arm: "off" });
    armSnapshot(root, "snap-1", { id: "snap-1" }); // captured before depth existed

    const res = await readStack(root);
    assert.equal(res.ok, true);
    assert.equal(res.patch.stack.baseline_n, 1, "a pre-depth manifest reads as n=1, never 0 or null");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unarmed stack defaults baseline_n to 1", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-baseline-n-"));
  try {
    writeRun(root, "cumulative", { arm: "off" });

    const res = await readStack(root);
    assert.equal(res.ok, true);
    assert.equal(res.patch.stack.baseline_n, 1, "nothing armed — a from-scratch floor is n=1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no baseline cell means baseline_n 0, whatever is armed", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-baseline-n-"));
  try {
    writeRun(root, "cumulative", { arm: "on" }); // ON-only stack: no floor exists
    armSnapshot(root, "snap-1", { snapshot_depth: 3 });

    const res = await readStack(root);
    assert.equal(res.ok, true);
    assert.equal(res.patch.stack.baseline, null);
    assert.equal(res.patch.stack.baseline_n, 0, "no floor carries no n — 0, not the armed depth");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
