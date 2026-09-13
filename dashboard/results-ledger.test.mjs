// ─────────────────────────────────────────────────────────────────────────────
// RESULTS-LEDGER READER — the durable completed-runs surface (WO-43)
//
// Zero dependencies. Stock `node --test`, no install, no build step:
//
//     cd okp-bench/dashboard && node --test
//
// WHAT THIS PINS: the ledger is the board's ONLY memory of past runs, so its
// reader must never turn a designed nothing into an error, and must never turn
// a partial file into a wrong history. These tests drive the REAL module over
// REAL files in a temp benchRoot:
//
//   · ABSENT ledger            → ok:false, plain reason (designed state)
//   · EMPTY ledger (post-reset)→ ok:false, plain reason (designed state)
//   · HALF-FLUSHED tail line   → tolerated, parsed records unaffected
//   · canonical record fields  → pass through UNRENAMED (writer's contract)
//   · newest-first ordering    → by timestamp, file order as tiebreak
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { read } from "./sources/results-ledger.mjs";

/** One ledger record in the shape the Python writer emits (WO-43 contract). */
function record({ seq = 0, task = "fix flaky auth test", ts = "2026-08-30T12:00:00Z" } = {}) {
  return {
    tree_id: "tree-test0001",
    run_id: "run-0001",
    task,
    org_id: "okp-org-0",
    model: "qwen3-coder-30b",
    arm: "off",
    sequence_index: seq,
    verdict: "FAIL",
    attempts_to_green: null,
    problems_before: 3,
    problems_after: 2,
    full_green: false,
    gate_totals: { gates: 65, passed: 62, failed: 3 },
    turns: 41,
    tokens: 152000,
    wall_seconds: 1200.5,
    wall_cost_usd: 0,
    recall: null,
    session_fp: "abc12345",
    session_id: "ses_test0001",
    timestamp: ts,
  };
}

async function benchWithLedger(lines) {
  const root = await mkdtemp(join(tmpdir(), "okp-dash-results-"));
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(
    join(root, "data", "results-ledger.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""),
    "utf8",
  );
  return root;
}

test("absent ledger is a designed state, reported not thrown", async () => {
  const root = await mkdtemp(join(tmpdir(), "okp-dash-results-"));
  try {
    const r = await read({ benchRoot: root });
    assert.equal(r.ok, false);
    assert.equal(r.patch, undefined);
    assert.match(r.reason, /no results ledger yet/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty ledger (post-reset) is a designed state", async () => {
  const root = await mkdtemp(join(tmpdir(), "okp-dash-results-"));
  try {
    await mkdir(join(root, "data"), { recursive: true });
    await writeFile(join(root, "data", "results-ledger.jsonl"), "", "utf8");
    const r = await read({ benchRoot: root });
    assert.equal(r.ok, false);
    assert.match(r.reason, /empty/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parses canonical records, fields unrenamed, patch key is `results`", async () => {
  const rec = record({ seq: 0 });
  const root = await benchWithLedger([rec]);
  try {
    const r = await read({ benchRoot: root });
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.patch.results));
    assert.equal(r.patch.results.length, 1);
    const got = r.patch.results[0];
    // THE CONTRACT: every canonical field survives the round-trip verbatim.
    for (const k of [
      "tree_id", "run_id", "task", "org_id", "model", "arm", "sequence_index",
      "verdict", "attempts_to_green", "problems_before", "problems_after",
      "full_green", "gate_totals", "turns", "tokens", "wall_seconds",
      "wall_cost_usd", "recall", "session_fp", "session_id", "timestamp",
    ]) {
      assert.deepEqual(got[k], rec[k], `field ${k} must pass through unrenamed`);
    }
    assert.equal(r.provenance.path, join(root, "data", "results-ledger.jsonl"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("half-flushed tail line is tolerated, good records unaffected", async () => {
  const a = record({ seq: 0, ts: "2026-08-30T10:00:00Z" });
  const b = record({ seq: 1, ts: "2026-08-30T11:00:00Z", task: "second task" });
  const root = await mkdtemp(join(tmpdir(), "okp-dash-results-"));
  try {
    await mkdir(join(root, "data"), { recursive: true });
    await writeFile(
      join(root, "data", "results-ledger.jsonl"),
      JSON.stringify(a) + "\n" + JSON.stringify(b) + "\n" + `{"tree_id": "trunc`,
      "utf8",
    );
    const r = await read({ benchRoot: root });
    assert.equal(r.ok, true);
    assert.equal(r.patch.results.length, 2);
    assert.ok(r.patch.results.every((x) => x.task !== undefined));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("newest-first ordering; absent timestamps keep file order below stamped", async () => {
  const older = record({ seq: 0, ts: "2026-08-30T09:00:00Z" });
  const newer = record({ seq: 1, ts: "2026-08-30T13:00:00Z" });
  const unstamped = record({ seq: 2, ts: null }); // written last, carries no stamp
  const root = await benchWithLedger([older, newer, unstamped]);
  try {
    const r = await read({ benchRoot: root });
    assert.equal(r.ok, true);
    const tasks = r.patch.results.map((x) => x.sequence_index);
    assert.deepEqual(tasks, [1, 0, 2]); // newest stamp first, then file order
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
