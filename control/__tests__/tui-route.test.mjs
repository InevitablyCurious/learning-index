// GET /api/tui — run_id selection: an unknown run_id is a 404 (never a silent
// fall back to the newest cell), and a registered run whose cell.start record
// is absent still answers 200 keyed on its run_id (session unresolved → the
// mirror reports "no session observed yet" without spawning a capture).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { routes } from "../routes/run.mjs";
import { registerRun, unregisterRun } from "../run-ledger.mjs";

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

test("GET /api/tui?run_id=<unknown> → 404, never a newest-cell fallback", async () => {
  const res = fakeRes();
  await tuiRoute().handle(
    {},
    res,
    new URL("http://x/api/tui?run_id=does-not-exist"),
  );
  assert.equal(res.status, 404);
  assert.match(res.body.error, /unknown run_id does-not-exist/);
});

test("GET /api/tui?run_id=<registered> → 200 keyed on run_id, session unresolved", async (t) => {
  const runId = "test-run-tui-route";
  registerRun({
    run_id: runId,
    sequence_index: 0,
    model: "m-a",
    arm: "off",
    kind: "bench",
    org: null,
    context: null,
    manifest_arg: null,
    pid: null,
    started_at: null,
    log_path: null,
    // A real but empty dir: no cell.start record exists, so the session and
    // serve_url resolve to null without touching the actual runs root.
    run_dir: mkdtempSync(`${tmpdir()}/tui-route-`),
    finished: false,
    terminal_status: null,
    terminal_ok: null,
  });
  t.after(() => unregisterRun(runId));

  const res = fakeRes();
  await tuiRoute().handle({}, res, new URL(`http://x/api/tui?run_id=${runId}`));

  assert.equal(res.status, 200);
  assert.equal(res.body.run_id, runId, "response is keyed on the run identity");
  assert.equal(res.body.running, false);
  assert.equal(res.body.session_id, null);
  assert.match(res.body.reason, /no session observed yet/);
});
