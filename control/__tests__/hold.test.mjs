// ─────────────────────────────────────────────────────────────────────────────
// HOLD TESTS — control/hold.mjs: reading a hold-ui.json (schema_version 2 only,
// v1 is no longer produced) and releasing it with an optional operator note.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readHold, releaseHold, MAX_NOTE_CHARS } from "../hold.mjs";

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
  max_attempts: 5,
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
  assert.equal(hold.max_attempts, 5);
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

test("HOLD: releaseHold writes an empty release file for a plain release", async () => {
  const { runs } = sandbox();
  const releasePath = join(runs, "t", "cell", "RELEASE_HOLD");
  writeHold(runs, "t/cell", {
    ...V2_HOLD,
    release: { method: "touch_file", path: releasePath, poll_interval_s: 2 },
  });
  const res = await releaseHold({ runsRoot: runs, runDirs: ["t"] });
  assert.equal(res.ok, true);
  assert.equal(res.path, releasePath);
  assert.equal(readFileSync(releasePath, "utf8"), "", "a plain release is empty");
});

test("HOLD: releaseHold writes the note as JSON content when a note is given", async () => {
  const { runs } = sandbox();
  const releasePath = join(runs, "t", "cell", "RELEASE_HOLD");
  writeHold(runs, "t/cell", {
    ...V2_HOLD,
    release: { method: "touch_file", path: releasePath, poll_interval_s: 2 },
  });
  const res = await releaseHold({ runsRoot: runs, runDirs: ["t"], note: "  off tray looks fixed  " });
  assert.equal(res.ok, true);
  assert.equal(res.operator_note, "off tray looks fixed");
  const written = JSON.parse(readFileSync(releasePath, "utf8"));
  assert.deepEqual(written, { note: "off tray looks fixed" });
});

test("HOLD: a blank note is a plain release; an over-long note is refused, not cut", async () => {
  const { runs } = sandbox();
  const releasePath = join(runs, "t", "cell", "RELEASE_HOLD");
  writeHold(runs, "t/cell", {
    ...V2_HOLD,
    release: { method: "touch_file", path: releasePath, poll_interval_s: 2 },
  });
  // Over the limit -> refused, nothing written, the run stays held.
  const tooLong = await releaseHold({ runsRoot: runs, runDirs: ["t"], note: "x".repeat(MAX_NOTE_CHARS + 1) });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.code, "note_too_long");
  assert.equal(existsSync(releasePath), false, "a refused release must not release the run");
  // Exactly at the limit -> kept whole.
  await releaseHold({ runsRoot: runs, runDirs: ["t"], note: "y".repeat(MAX_NOTE_CHARS) });
  assert.equal(JSON.parse(readFileSync(releasePath, "utf8")).note.length, MAX_NOTE_CHARS);
  // Blank note -> plain (empty) release; no temporary file left behind.
  await releaseHold({ runsRoot: runs, runDirs: ["t"], note: "   " });
  assert.equal(readFileSync(releasePath, "utf8"), "");
  assert.equal(existsSync(`${releasePath}.tmp`), false);
});

test("HOLD: release with no active hold is a harmless no-op", async () => {
  const { runs } = sandbox();
  const res = await releaseHold({ runsRoot: runs, runDirs: ["t"] });
  assert.equal(res.ok, true);
  assert.equal(res.released, true);
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

test("HOLD: a hold file left by a run that is not in flight is never shown or released", async () => {
  const { runs } = sandbox();
  const releasePath = join(runs, REAL_RUN_DIR, "memoryOFF", "cell-0000", "RELEASE_HOLD");
  writeHold(runs, `${REAL_RUN_DIR}/memoryOFF/cell-0000`, {
    ...V2_HOLD,
    release: { method: "touch_file", path: releasePath, poll_interval_s: 2 },
  });
  assert.equal(await readHold({ runsRoot: runs, runDirs: [] }), null);
  await releaseHold({ runsRoot: runs, runDirs: [] });
  assert.equal(existsSync(releasePath), false);
});

test("HOLD: a hold-ui.json inside the model's worktree is not a hold", async () => {
  const { runs } = sandbox();
  writeHold(runs, `${REAL_RUN_DIR}/memoryOFF/cell-0000/worktree`, V2_HOLD);
  assert.equal(await readHold({ runsRoot: runs, runDirs: [REAL_RUN_DIR] }), null);
});
