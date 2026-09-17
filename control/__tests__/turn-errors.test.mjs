// LOOP / STREAM / STALLED ERRORS are counted from each cell's live stream, so
// they move while a run is going and still read after a run that stopped or
// errored without writing a scorecard (run 1789658586: 21 loop kills, "—").
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectStats, turnErrors } from "../runstats.mjs";

const notice = (event, terminal) => JSON.stringify({ kind: "notice", event, detail: { terminal } });

function run(cells) {
  const root = mkdtempSync(join(tmpdir(), "turn-errors-"));
  cells.forEach((lines, i) => {
    const dir = join(root, "memoryOFF", `cell-000${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "live.jsonl"), lines.join("\n") + "\n");
  });
  return root;
}

test("kills are counted by kind across every cell, with no scorecard", async () => {
  const root = run([
    [
      notice("turn_truncated_retried", "guard_abort"),
      notice("turn_truncated_retried", "guard_abort"),
      notice("recovery_budget_exhausted", "guard_abort"),
      notice("turn_truncated_retried", "transport_error"),
      JSON.stringify({ kind: "notice", event: "context_exhausted", detail: {} }),
    ],
    [notice("turn_truncated_retried", "turn_stalled"), notice("snapshot_validity_relaxed")],
  ]);
  assert.deepEqual(await turnErrors(root), { loop: 3, stream: 1, stalled: 1 });
  const stats = await collectStats({ runDir: root, runsRoot: root });
  const byId = Object.fromEntries(stats.bench.map((s) => [s.id, s]));
  assert.deepEqual(byId.loop_errors, { id: "loop_errors", label: "LOOP ERRORS", state: "ok", value: 3 });
  assert.equal(byId.stream_errors.value, 1);
  assert.equal(byId.stalled_errors.value, 1);
  rmSync(root, { recursive: true, force: true });
});

test("a run with no live stream falls back to the scorecard, and to unavailable without one", async () => {
  const root = mkdtempSync(join(tmpdir(), "turn-errors-old-"));
  assert.equal(await turnErrors(root), null);
  const stats = await collectStats({ runDir: root, runsRoot: root });
  assert.equal(stats.bench.find((s) => s.id === "loop_errors").state, "unavailable");
  rmSync(root, { recursive: true, force: true });
});

test("the run dir arrives relative to the runs root, as the control plane passes it", async () => {
  const root = mkdtempSync(join(tmpdir(), "turn-errors-rel-"));
  const rel = join("1789658586", "local", "p", "m");
  const dir = join(root, rel, "memoryOFF", "cell-0000");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "live.jsonl"), notice("turn_truncated_retried", "guard_abort") + "\n");
  const stats = await collectStats({ runDir: rel, runsRoot: root });
  assert.equal(stats.bench.find((s) => s.id === "loop_errors").value, 1);
  rmSync(root, { recursive: true, force: true });
});
