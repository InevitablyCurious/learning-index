// THE TUI PUSH PATH, KEYED BY CELL ADDRESS — each SSE subscriber receives the
// frame of the cell IT selected (`<run_dir>::<sequence_index>`). A subscriber
// with no cell gets nothing: there is no "newest cell" default to guess with.
// Grouping is pure; the push loop runs against a stub /api/tui server
// in-process (no real cell, no containers).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { groupTuiSubscribers, tuiTick } from "./lib/tui.mjs";
import { streamClients } from "./lib/state.mjs";

const A = "r/x::0";
const B = "r/x::1";

test("groupTuiSubscribers groups frame subscribers by cell; no cell, no group", () => {
  const a1 = { okpWantsTui: true, okpTuiCell: A };
  const a2 = { okpWantsTui: true, okpTuiCell: A };
  const b1 = { okpWantsTui: true, okpTuiCell: B };
  const none = { okpWantsTui: true, okpTuiCell: null };
  const unset = { okpWantsTui: true }; // field never set
  const blank = { okpWantsTui: true, okpTuiCell: "" };
  const off = { okpWantsTui: false, okpTuiCell: A };

  const early = { okpWantsTui: true, okpTuiCell: A, okpBoardSent: false };
  const groups = groupTuiSubscribers([a1, a2, b1, none, unset, blank, off, early]);
  assert.equal(groups.size, 2);
  assert.deepEqual(groups.get(A), [a1, a2]);
  assert.deepEqual(groups.get(B), [b1]);
  assert.equal(groups.has(null), false, "no default group");
  assert.ok(!groups.get(A).includes(early), "no frame before the client's board frame — it would be erased");
});

test("tuiTick pushes each cell's group its own frame, keyed", async (t) => {
  const payloads = {
    [A]: { cell: A, session_id: "ses_a", status: "running", frame: [["a1"], ["a2"]] },
    [B]: { cell: B, session_id: "ses_b", status: "running", frame: [["b1"]] },
  };
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    assert.equal(url.pathname, "/api/tui");
    requests.push(url.searchParams.get("cell"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payloads[url.searchParams.get("cell")]));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const cfg = { controlUrl: `http://127.0.0.1:${server.address().port}` };

  function fakeClient(cell, wantsTui = true) {
    return {
      okpWantsTui: wantsTui,
      okpTuiCell: cell,
      patches: [],
      write(chunk) {
        const m = /^event: patch\ndata: (.+)\n\n$/.exec(chunk);
        assert.ok(m, `patch frame shape: ${chunk}`);
        this.patches.push(JSON.parse(m[1]));
      },
    };
  }
  const clientA = fakeClient(A);
  const clientB = fakeClient(B);
  const clientNone = fakeClient(null);
  const clientOff = fakeClient(A, false);
  for (const c of [clientA, clientB, clientNone, clientOff]) streamClients.add(c);
  t.after(() => {
    for (const c of [clientA, clientB, clientNone, clientOff]) streamClients.delete(c);
    server.close();
  });

  // First tick: both watchers get a FULL frame, each for its own cell.
  await tuiTick(cfg);
  assert.equal(clientA.patches.length, 1);
  assert.equal(clientA.patches[0].tui.cell, A);
  assert.deepEqual(clientA.patches[0].tui.frame, [["a1"], ["a2"]]);
  assert.equal(clientB.patches.length, 1);
  assert.equal(clientB.patches[0].tui.cell, B);
  assert.equal(clientNone.patches.length, 0, "a client with no cell is sent no frames");
  assert.equal(clientOff.patches.length, 0, "a client without tui=1 gets no frames");
  assert.deepEqual(requests.sort(), [A, B].sort(), "only cells someone watches are fetched");

  // Unchanged terminals send nothing (per-cell memo).
  await tuiTick(cfg);
  assert.equal(clientA.patches.length, 1);
  assert.equal(clientB.patches.length, 1);

  // One row of A changes: A gets a cell-keyed SPLICE; B's watcher gets nothing.
  payloads[A].frame = [["a1"], ["CHANGED"]];
  await tuiTick(cfg);
  assert.equal(clientA.patches.length, 2);
  const splice = clientA.patches[1].tui_rows;
  assert.equal(splice.cell, A);
  assert.deepEqual(splice.rows, [[1, ["CHANGED"]]]);
  assert.equal(splice.meta.session_id, "ses_a");
  assert.equal(splice.meta.frame, undefined, "the frame rides rows, not meta");
  assert.equal(clientB.patches.length, 1, "the other cell did not change");

  // A second client joins A (a tile switch back, or another tab), terminal
  // unchanged: it has no frame to splice into, so it gets a FULL frame, and
  // the client already watching gets nothing new.
  const lateA = fakeClient(A);
  streamClients.add(lateA);
  t.after(() => streamClients.delete(lateA));
  await tuiTick(cfg);
  assert.equal(lateA.patches.length, 1);
  assert.equal(lateA.patches[0].tui.cell, A);
  assert.deepEqual(lateA.patches[0].tui.frame, [["a1"], ["CHANGED"]]);
  assert.equal(clientA.patches.length, 2, "the existing watcher is not re-sent the frame");

  // Next change: both A watchers now hold a frame and get the same splice.
  payloads[A].frame = [["NEW"], ["CHANGED"]];
  await tuiTick(cfg);
  assert.deepEqual(lateA.patches[1].tui_rows.rows, [[0, ["NEW"]]]);
  assert.deepEqual(clientA.patches[2].tui_rows.rows, [[0, ["NEW"]]]);
});
