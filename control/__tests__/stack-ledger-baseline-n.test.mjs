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

// ── PHASES: OBSERVED, NEVER CLAMPED ────────────────────────────────────────

test("a 7-round cell keeps round 7 — phases are observed, total is null", async () => {
  // Attempts are unbounded: a cell keeps running until it goes green or the
  // operator stops it. So `done` is the count the cell actually ran and `total`
  // is null. Clamping at an assumed ceiling would drop round 7 from the curve
  // and present an invented denominator as if the harness had agreed to one.
  const root = mkdtempSync(join(tmpdir(), "okp-baseline-n-"));
  try {
    writeRun(root, "cumulative", { arm: "off" });

    // Seven distinct graded attempts on the one scheduled cell, in attempt order.
    const attempts = [];
    for (let a = 1; a <= 7; a += 1) {
      attempts.push(JSON.stringify({
        type: "attempt",
        sequence_index: 0,
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

    const res = await readStack(root);
    assert.equal(res.ok, true);
    const cell = res.patch.stack.all[0];
    assert.equal(cell.phases.done, 7, "round 7 is kept — the count is what the cell ran");
    assert.equal(cell.phases.total, null, "unbounded — no denominator is invented");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
