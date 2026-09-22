// THE TUI PUSH PATH, KEYED BY run_id — each SSE subscriber receives the frame
// of the cell IT selected, not whichever single cell the unkeyed path saw
// last. Grouping is pure; the push loop runs against a stub /api/tui server
// in-process (no real cell, no containers).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { groupTuiSubscribers, tuiTick } from "./lib/tui.mjs";
import { streamClients } from "./lib/state.mjs";

test("groupTuiSubscribers groups frame subscribers by run_id", () => {
  const a1 = { okpWantsTui: true, okpTuiRunId: "run-a" };
  const a2 = { okpWantsTui: true, okpTuiRunId: "run-a" };
  const b1 = { okpWantsTui: true, okpTuiRunId: "run-b" };
  const def = { okpWantsTui: true, okpTuiRunId: null };
  const legacy = { okpWantsTui: true }; // field never set → default group
  const blank = { okpWantsTui: true, okpTuiRunId: "" }; // ?run_id= → default
  const off = { okpWantsTui: false, okpTuiRunId: "run-a" };

  const groups = groupTuiSubscribers([a1, a2, b1, def, legacy, blank, off]);
  assert.equal(groups.size, 3);
  assert.deepEqual(groups.get("run-a"), [a1, a2]);
  assert.deepEqual(groups.get("run-b"), [b1]);
  assert.deepEqual(groups.get(null), [def, legacy, blank]);
});

test("tuiTick pushes each run_id group its own cell's frame, keyed", async (t) => {
  const payloads = {
    "run-a": { run_id: "run-a", session_id: "ses_a", status: "running", frame: [["a1"], ["a2"]] },
    default: { run_id: "newest-run", session_id: "ses_d", status: "running", frame: [["d1"]] },
  };
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    assert.equal(url.pathname, "/api/tui");
    requests.push(url.search);
    const runId = url.searchParams.get("run_id");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(runId ? payloads[runId] : payloads.default));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const cfg = { controlUrl: `http://127.0.0.1:${server.address().port}` };

  function fakeClient(runId, wantsTui = true) {
    return {
      okpWantsTui: wantsTui,
      okpTuiRunId: runId,
      patches: [],
      write(chunk) {
        const m = /^event: patch\ndata: (.+)\n\n$/.exec(chunk);
        assert.ok(m, `patch frame shape: ${chunk}`);
        this.patches.push(JSON.parse(m[1]));
      },
    };
  }
  const clientA = fakeClient("run-a");
  const clientD = fakeClient(null);
  const clientOff = fakeClient("run-a", false);
  for (const c of [clientA, clientD, clientOff]) streamClients.add(c);
  t.after(() => {
    for (const c of [clientA, clientD, clientOff]) streamClients.delete(c);
    server.close();
  });

  // First tick: both watchers get a FULL frame, each for its own cell.
  await tuiTick(cfg);
  assert.equal(clientA.patches.length, 1);
  assert.equal(clientA.patches[0].tui.run_id, "run-a");
  assert.deepEqual(clientA.patches[0].tui.frame, [["a1"], ["a2"]]);
  assert.equal(clientD.patches.length, 1);
  assert.equal(clientD.patches[0].tui.run_id, "newest-run");
  assert.equal(clientOff.patches.length, 0, "a client without tui=1 gets no frames");
  assert.deepEqual(requests.sort(), ["", "?run_id=run-a"].sort());

  // Unchanged terminals send nothing (per-run_id memo).
  await tuiTick(cfg);
  assert.equal(clientA.patches.length, 1);
  assert.equal(clientD.patches.length, 1);

  // One row of run-a changes: run-a gets a run_id-keyed SPLICE; the default
  // cell's watcher gets nothing (memo isolation between cells).
  payloads["run-a"].frame = [["a1"], ["CHANGED"]];
  await tuiTick(cfg);
  assert.equal(clientA.patches.length, 2);
  const splice = clientA.patches[1].tui_rows;
  assert.equal(splice.run_id, "run-a");
  assert.deepEqual(splice.rows, [[1, ["CHANGED"]]]);
  assert.equal(splice.meta.session_id, "ses_a");
  assert.equal(splice.meta.frame, undefined, "the frame rides rows, not meta");
  assert.equal(clientD.patches.length, 1, "the default cell did not change");
});
