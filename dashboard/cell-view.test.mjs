// ONE SUBJECT PER PAGE — every panel draws the strip's active cell. The board
// carries one view per cell (by_cell, keyed `<run_dir>::<seq>`); cellView lays
// the active cell's view over the board-wide sections. A cell with no view
// shows nothing of its own, never another cell's.
//
//     cd dashboard && node --test cell-view.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { cellView } from "./board.js";
import { setSelectedCell } from "./panels/cells.js";

const RD = "1790/local/x";
function board() {
  return {
    run: { model: "m", org_id: null },
    cells: {
      list: [
        { run_dir: RD, sequence_index: 0, running: true },
        { run_dir: RD, sequence_index: 1, running: true },
        { run_dir: RD, sequence_index: 2, running: true },
      ],
    },
    by_cell: {
      [`${RD}::0`]: { run: { phase: "initial-chunk-3", turns: 30 }, live: { session_id: "s0" }, suite: { gates: ["a"] }, learning: { session_id: "s0" } },
      [`${RD}::1`]: { run: { phase: "feedback-2", turns: 90 }, live: { session_id: "s1" }, suite: { gates: ["b"] }, learning: { session_id: "s1" } },
    },
  };
}

test("the view is the selected cell's, and switches with the selection", () => {
  setSelectedCell(1);
  const v1 = cellView(board());
  assert.equal(v1.run.phase, "feedback-2");
  assert.equal(v1.run.model, "m", "board-wide run fields stay");
  assert.equal(v1.live.session_id, "s1");
  assert.deepEqual(v1.suite.gates, ["b"]);
  assert.equal(v1.learning.session_id, "s1");
  setSelectedCell(0);
  const v0 = cellView(board());
  assert.equal(v0.run.turns, 30);
  assert.equal(v0.live.session_id, "s0");
});

test("a cell with no view yet shows nothing of its own — never another cell's", () => {
  setSelectedCell(2);
  const v = cellView(board());
  assert.equal(v.live, null);
  assert.equal(v.suite, null);
  assert.equal(v.learning, null);
  assert.equal(v.run.phase, undefined);
  setSelectedCell(null);
});
