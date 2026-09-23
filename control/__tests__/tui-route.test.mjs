// GET /api/tui — keyed on the cell's ADDRESS, `<run_dir>::<sequence_index>`:
// the key every per-cell read uses, and one that survives a control-plane
// restart (the ledger's run_id did not). No cell is a 400 — there is no
// "newest cell" to fall back to — and a cell whose cell.start record is absent
// answers 200 with "no session observed yet", spawning no capture.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// state.mjs reads the bench root once at import: point it at a temp dir first,
// so nothing here touches the real runs root. (node --test runs each file in
// its own process: this never leaks elsewhere.)
process.env.OKP_CONTROL_BENCH_ROOT = mkdtempSync(join(tmpdir(), "tui-route-bench-"));
const { routes } = await import("../routes/run.mjs");
const { RUNS_ROOT } = await import("../state.mjs");

function tuiRoute() {
  const r = routes.find((r) => r.method === "GET" && r.path === "/api/tui");
  assert.ok(r, "GET /api/tui route exists");
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

test("GET /api/tui with no cell, or a malformed one → 400, never a newest-cell fallback", async () => {
  for (const q of ["", "?cell=", "?cell=no-separator", "?cell=r%2Fx%3A%3A-1"]) {
    const res = fakeRes();
    await tuiRoute().handle({}, res, new URL(`http://x/api/tui${q}`));
    assert.equal(res.status, 400, q);
    assert.match(res.body.error, /cell required/);
  }
});

test("GET /api/tui?cell=<a cell that has not started> → 200 keyed on the cell, session unresolved", async () => {
  mkdirSync(RUNS_ROOT, { recursive: true });
  const runDir = relative(RUNS_ROOT, mkdtempSync(join(RUNS_ROOT, "tui-route-")));
  const cell = `${runDir}::0`;
  const res = fakeRes();
  await tuiRoute().handle({}, res, new URL(`http://x/api/tui?cell=${encodeURIComponent(cell)}`));

  assert.equal(res.status, 200);
  assert.equal(res.body.cell, cell, "response is keyed on the cell address");
  assert.equal(res.body.running, false);
  assert.equal(res.body.session_id, null);
  assert.match(res.body.reason, /no session observed yet/);
});
