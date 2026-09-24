// ONE SUBJECT PER PAGE — every panel draws the strip's active run. The board
// carries one view per cell (by_cell, keyed `<run_dir>::<seq>`); cellView lays
// the active cell's view over the board-wide sections. The strip's cards come
// from board.runs (current tree + archived runs), so selection is a cellKey
// string — and an archived run's view, fetched once into the client's cache
// (outside the board), lays over exactly like a current cell's. A cell with
// no view shows nothing of its own, never another cell's.
//
//     cd dashboard && node --test cell-view.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { cellView, loadRunView } from "./board.js";
import { setSelectedCell } from "./panels/cells.js";

const RD = "1790/local/x";
const AR = "backups/1789474325/1789474112/local/x";

function board() {
  return {
    run: { model: "m", org_id: null },
    runs: {
      list: [
        { run_dir: RD, sequence_index: 0, archived: false, status: "live" },
        { run_dir: RD, sequence_index: 1, archived: false, status: "live" },
        { run_dir: RD, sequence_index: 2, archived: false, status: "live" },
      ],
      counts: { total: 3, live: 3, scored: 0, void: 0, harness_error: 0 },
    },
    by_cell: {
      [`${RD}::0`]: { run: { phase: "initial-chunk-3", turns: 30 }, live: { session_id: "s0" }, suite: { gates: ["a"] }, learning: { session_id: "s0" } },
      [`${RD}::1`]: { run: { phase: "feedback-2", turns: 90 }, live: { session_id: "s1" }, suite: { gates: ["b"] }, learning: { session_id: "s1" } },
    },
  };
}

test("the view is the selected cell's, and switches with the selection", () => {
  setSelectedCell(`${RD}::1`);
  const v1 = cellView(board());
  assert.equal(v1.run.phase, "feedback-2");
  assert.equal(v1.run.model, "m", "board-wide run fields stay");
  assert.equal(v1.live.session_id, "s1");
  assert.deepEqual(v1.suite.gates, ["b"]);
  assert.equal(v1.learning.session_id, "s1");
  setSelectedCell(`${RD}::0`);
  const v0 = cellView(board());
  assert.equal(v0.run.turns, 30);
  assert.equal(v0.live.session_id, "s0");
});

test("a cell with no view yet shows nothing of its own — never another cell's", () => {
  setSelectedCell(`${RD}::2`);
  const v = cellView(board());
  assert.equal(v.live, null);
  assert.equal(v.suite, null);
  assert.equal(v.learning, null);
  assert.equal(v.run.phase, undefined);
  setSelectedCell(null);
});

test("an archived run's fetched view lays over like any cell's", async () => {
  // The load (board.js loadRunView) keeps the /api/run-view answer in the
  // client's archived-view cache under the cell's address; from cellView's
  // side it is then indistinguishable from a server-built view.
  const b = board();
  const card = { run_dir: AR, sequence_index: 0, archived: true, status: "scored" };
  b.runs.list.unshift(card);
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      view: { run: { phase: "archived-record" }, honesty: {}, live: null, suite: null, learning: null, sources: null },
    }),
  });
  await loadRunView(card);
  setSelectedCell(`${AR}::0`);
  const v = cellView(b);
  assert.equal(v.run.phase, "archived-record");
  assert.equal(v.run.model, "m", "board-wide run fields stay");
  assert.equal(v.live, null, "an archived record states its own absence");
  assert.equal(v.run_view, null, "a loaded view has no load state to state");
  setSelectedCell(null);
});
