// The per-cell views are split one section per cell, so a write in one cell
// resends that cell's view alone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { granularSignatures } from "./lib/broadcast.mjs";

test("by_cell is split per cell address", () => {
  const sig = granularSignatures({
    by_cell: { "r/x::0": { run: { turns: 1 } }, "r/x::1": { run: { turns: 2 } } },
  });
  assert.equal(sig["by_cell.r/x::0"], JSON.stringify({ run: { turns: 1 } }));
  assert.equal(sig["by_cell.r/x::1"], JSON.stringify({ run: { turns: 2 } }));
  assert.equal(sig.by_cell, undefined, "never one blob for every cell");
});
