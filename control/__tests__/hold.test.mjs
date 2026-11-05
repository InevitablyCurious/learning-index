// ─────────────────────────────────────────────────────────────────────────────
// HOLD TESTS — control/hold.mjs: reading a hold-ui.json (schema_version 2 only,
// v1 is no longer produced). The hold is a dev-mode pause the operator attends;
// the harness owns its release, so this module only reads.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readHold } from "../hold.mjs";

const HOLD_FILE = "hold-ui.json";

function sandbox() {
  const runs = mkdtempSync(join(tmpdir(), "okp-hold-"));
  return { runs };
}

function writeHold(runs, relDir, data) {
  const dir = join(runs, relDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, HOLD_FILE);
  writeFileSync(path, `${JSON.stringify(data)}\n`);
  return path;
}

const V2_HOLD = {
  url: "http://localhost:18311",
  ui_healthy: true,
  boot_detail: "healthy",
  ui_pid: 1234,
  container_name: "bench-cell-x",
  worktree: "/runs/t/cell/worktree",
  live_view_url: "http://127.0.0.1:8719",
  server_log: "/runs/t/cell/hold-ui-server.log",
  started_at: "2026-10-14T12:00:00Z",
  status: "held",
  schema_version: 2,
  kind: "round",
  attempt: 2,
  max_attempts: null,
  told_text: "I'm still seeing the off tray drawn over some points.",
  grade: {
    report_path: "/runs/t/cell/attempt-2-report.json",
    verdict: "FAIL",
    conformed: false,
    failed_gates: ["F01"],
    n_problems: 3,
    results: { conformance: false, backend: true, frontend: false },
  },
  release: {
    method: "touch_file",
    path: join("/runs/t/cell", "RELEASE_HOLD"),
    poll_interval_s: 2,
  },
  bind: { expected_host: "127.0.0.1", lan_reachable: false, lan_address: null },
};

test("HOLD: readHold returns the v2 fields (kind/attempt/told_text/grade) and held_seconds", async () => {
  const { runs } = sandbox();
  const holdPath = writeHold(runs, "t/cell", V2_HOLD);
  const hold = await readHold({ runsRoot: runs, runDirs: ["t"] });

  assert.ok(hold, "a v2 hold must be read");
  assert.equal(hold.schema_version, 2);
  assert.equal(hold.kind, "round");
  assert.equal(hold.attempt, 2);
  // UNBOUNDED is null: readHold preserves whatever hold-ui.json carries, so a
  // held cell with no attempt cap reads back as null (never a fallback 5).
  assert.equal(hold.max_attempts, null);
  assert.equal(hold.told_text, "I'm still seeing the off tray drawn over some points.");
  assert.equal(hold.grade.verdict, "FAIL");
  assert.equal(hold.grade.report_path, "/runs/t/cell/attempt-2-report.json");
  assert.equal(hold.hold_path, holdPath);
  assert.equal(typeof hold.held_seconds, "number");
});

test("HOLD: readHold refuses schema_version 1 (no longer produced) as invalid", async () => {
  const { runs } = sandbox();
  writeHold(runs, "t/cell", { ...V2_HOLD, schema_version: 1 });
  const hold = await readHold({ runsRoot: runs, runDirs: ["t"] });
  assert.equal(hold.invalid_schema, true);
  assert.equal(hold.schema_version, 1);
  assert.match(hold.reason, /only v2/);
});

// The real layout: <run_dir>/memoryOFF/cell-0000/hold-ui.json sits seven
// directories below runs/. A whole-tree scan capped at depth 6 never found it,
// so the board showed no hold while the harness waited (2026-10-14 proof run).
const REAL_RUN_DIR = "1791462105/local/local-llm-proxy/omlx/qwen3-6-35b-a3b-bench";

test("HOLD: a hold in a live run's cell directory is found at the real depth", async () => {
  const { runs } = sandbox();
  const holdPath = writeHold(runs, `${REAL_RUN_DIR}/memoryOFF/cell-0000`, V2_HOLD);
  const hold = await readHold({ runsRoot: runs, runDirs: [REAL_RUN_DIR] });
  assert.equal(hold?.hold_path, holdPath);
  assert.equal(hold?.kind, "round");
});

test("HOLD: a hold file left by a run that is not in flight is never shown", async () => {
  const { runs } = sandbox();
  writeHold(runs, `${REAL_RUN_DIR}/memoryOFF/cell-0000`, V2_HOLD);
  assert.equal(await readHold({ runsRoot: runs, runDirs: [] }), null);
});

test("HOLD: a hold-ui.json inside the model's worktree is not a hold", async () => {
  const { runs } = sandbox();
  writeHold(runs, `${REAL_RUN_DIR}/memoryOFF/cell-0000/worktree`, V2_HOLD);
  assert.equal(await readHold({ runsRoot: runs, runDirs: [REAL_RUN_DIR] }), null);
});
