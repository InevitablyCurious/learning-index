// ─────────────────────────────────────────────────────────────────────────────
// GET /api/run-view — ONE run's per-cell view, built by the SAME assembly the
// board's by_cell uses (buildCellViews). This is the click target behind a
// board.runs card and the only way to view an ARCHIVED run.
//
// The fixture is an archived run under RUNS_ROOT/backups/…: the route must
// resolve it, build its view (log_path null → run-log states its absence,
// live-stream reads the archived cell's own live.jsonl), and refuse a missing
// run or a bad/escaping parameter with { ok:false, reason }.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// state.mjs reads the bench root and port once at import: point them at a
// temp dir and an unused port FIRST, so nothing here touches the real runs
// root and the gate-suite fetch dies fast instead of hitting a real control
// plane. (node --test runs each file in its own process: this never leaks.)
process.env.OKP_CONTROL_BENCH_ROOT = mkdtempSync(join(tmpdir(), "run-view-bench-"));
process.env.OKP_CONTROL_PORT = "8999";
const { routes } = await import("../routes/board.mjs");
const { RUNS_ROOT } = await import("../state.mjs");

const ARCHIVED_RUN = "backups/1790000002/1780000002/local/local-llm-proxy/omlx/model-x";

function runViewRoute() {
  const r = routes.find((r) => r.method === "GET" && r.path === "/api/run-view");
  assert.ok(r, "GET /api/run-view route exists");
  return r;
}

function fakeRes() {
  return {
    status: null,
    body: null,
    writeHead(code) { this.status = code; },
    end(text) { this.body = JSON.parse(text); },
  };
}

async function call(query) {
  const res = fakeRes();
  await runViewRoute().handle({}, res, new URL(`http://x/api/run-view${query}`));
  return res;
}

// The archived run: a campaign manifest and the cell's own live.jsonl.
mkdirSync(join(RUNS_ROOT, ARCHIVED_RUN, "memoryOFF", "cell-0000"), { recursive: true });
writeFileSync(
  join(RUNS_ROOT, ARCHIVED_RUN, "manifest.json"),
  JSON.stringify({ created_at: "2026-08-01T00:00:00Z" }),
);
writeFileSync(
  join(RUNS_ROOT, ARCHIVED_RUN, "memoryOFF", "cell-0000", "live.jsonl"),
  [
    JSON.stringify({ kind: "cell.start", cell_seq: 0, session_id: "ses_archived0000000000" }),
    JSON.stringify({ kind: "phase.start", phase: "initial-chunk-1" }),
    JSON.stringify({ kind: "attempt.end", attempt: 1, verdict: "FAIL", conformed: false, failed: 24 }),
    JSON.stringify({ kind: "cell.end", verdict: "FAIL", terminal_reason: "attempt_ceiling_reached" }),
  ].join("\n") + "\n",
);

test("GET /api/run-view on an archived run → { ok:true, view } with the per-cell sources stated", async () => {
  const q = `?run_dir=${encodeURIComponent(ARCHIVED_RUN)}&sequence_index=0`;
  const res = await call(q);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const view = res.body.view;
  assert.ok(view, "the view object is present");

  // The SAME six per-cell sources the board's by_cell runs, each stating its
  // own ok/reason.
  assert.ok(Array.isArray(view.sources), "view.sources is an array");
  assert.deepEqual(
    view.sources.map((s) => s.id).sort(),
    ["gate-suite", "learning", "live-stream", "opencode-serve", "run-log", "status-stream"],
  );
  for (const s of view.sources) {
    assert.equal(typeof s.ok, "boolean");
    if (!s.ok) assert.equal(typeof s.reason, "string", "an absence is stated, never silent");
  }

  // log_path null degrades gracefully: run-log STATES the absence…
  const runLog = view.sources.find((s) => s.id === "run-log");
  assert.equal(runLog.ok, false);
  assert.match(runLog.reason, /names no log/);
  // …while the archived cell's own stream still renders.
  const liveStream = view.sources.find((s) => s.id === "live-stream");
  assert.equal(liveStream.ok, true);
  assert.ok(view.live, "the live section is built from the archived stream");
});

test("GET /api/run-view on a missing run → { ok:false, reason }, never a view", async () => {
  const res = await call(
    `?run_dir=${encodeURIComponent("backups/1799999999/1789999999/local/x/y/model-z")}&sequence_index=0`,
  );
  assert.equal(res.status, 404);
  assert.equal(res.body.ok, false);
  assert.match(res.body.reason, /no such run/);
});

test("GET /api/run-view refuses missing, malformed and escaping parameters", async () => {
  const bad = [
    "", // no parameters at all
    "?sequence_index=0", // no run_dir
    `?run_dir=&sequence_index=0`, // empty run_dir
    `?run_dir=${encodeURIComponent(ARCHIVED_RUN)}`, // no sequence_index
    `?run_dir=${encodeURIComponent(ARCHIVED_RUN)}&sequence_index=abc`,
    `?run_dir=${encodeURIComponent(ARCHIVED_RUN)}&sequence_index=-1`,
    `?run_dir=${encodeURIComponent("../../..")}&sequence_index=0`, // escape
    `?run_dir=${encodeURIComponent("/etc")}&sequence_index=0`, // absolute
  ];
  for (const q of bad) {
    const res = await call(q);
    assert.equal(res.status, 400, q);
    assert.equal(res.body.ok, false, q);
    assert.equal(typeof res.body.reason, "string", q);
  }
});
