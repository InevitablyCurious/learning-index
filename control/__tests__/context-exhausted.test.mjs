// CONTEXT EXHAUSTED on the BASELINES card. The harness stops a cell whose
// session ran out of room (harness/context_budget.py) and records
// terminal_reason "context_exhausted". A graded stop is a real floor with the
// label; a stop during the build graded nothing and is not a floor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readBaselines } from "../baselines.mjs";

function campaign(records) {
  const root = mkdtempSync(join(tmpdir(), "ctx-bl-"));
  const dir = join(root, "cumulative-anthropic-claude-opus-5");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    created_at: "2026-09-16T00:00:00Z",
    schedule: [{ sequence_index: 0, memory_mode: "off", model: "orcarouter/anthropic/claude-opus-5", provider_pin: "orcarouter" }],
  }));
  writeFileSync(join(dir, "manifest.status.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return root;
}

test("CONTEXT EXHAUSTED: stopped after grading is a floor, labelled", async () => {
  const root = campaign([
    { type: "attempt", sequence_index: 0, attempt: 1, verdict: "FAIL", terminal_reason: "context_exhausted",
      gate_totals: { pass: 99, fail: 18, error: 0, not_run: 0, total: 117 },
      progress: { turns: 200, total_tokens: 900, wall_seconds: 120 } },
  ]);
  const idx = await readBaselines({ runsRoot: root, models: [] });
  const row = idx.list[0];
  assert.equal(row.state, "complete");
  assert.equal(row.scorable, true, "running out of room is a result, not an instrument fault");
  assert.equal(row.context_exhausted, true);
  assert.equal(row.gates.total, 117);
  rmSync(root, { recursive: true, force: true });
});

test("CONTEXT EXHAUSTED: stopped during the build graded nothing and is not a floor", async () => {
  const root = campaign([
    { type: "attempt", sequence_index: 0, attempt: 1, verdict: "FAIL", terminal_reason: "context_exhausted",
      progress: { turns: 80, total_tokens: 900, wall_seconds: 120 } },
  ]);
  const idx = await readBaselines({ runsRoot: root, models: [] });
  const row = idx.list[0];
  assert.equal(row.state, "exhausted");
  assert.equal(row.scorable, false);
  assert.equal(row.context_exhausted, true);
  assert.match(row.reason, /ran out of context during the build/);
  assert.deepEqual(idx.counts, { complete: 0, running: 0, void: 0, exhausted: 1 });
  rmSync(root, { recursive: true, force: true });
});
