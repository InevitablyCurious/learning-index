// CONTEXT EXHAUSTED on the BASELINES card: the state column names it, a note
// under the row says what it means, and a run nested under a floor says it too.
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderLedger } from "./panels/ledger.js";

const row = (over = {}) => ({
  id: "base-f15d", model: "qwen3.6-35b-a3b-bench", kind: "local", kind_label: "LOCAL",
  state: "complete", scorable: true, run_dir: "1789580246/local/x", sequence_index: 0,
  turns: 200, gates: { passed: 99, total: 117 }, runs: [], run_count: 0, best: null,
  can_run: { allowed: true, reason: null }, ...over,
});
const board = (rows, counts) => ({
  control: { roster: null },
  models_ledger: { baseline_rows: rows, counts, startable: [], run_in_flight: false },
});

test("a floor that ran out of room says CONTEXT EXHAUSTED and what its numbers are", () => {
  const html = renderLedger(board([row({ context_exhausted: true })], { complete: 1, running: 0, void: 0, exhausted: 0 }));
  assert.match(html, /class="blstate complete ctx">CONTEXT EXHAUSTED</);
  assert.ok(html.includes("the last graded round is its result"));
  assert.ok(html.includes("99/117"));
});

test("a row stopped during the build is labelled and says it is not a floor", () => {
  const reason = "the last OFF cell for qwen ran out of context during the build and was stopped before anything was graded";
  const html = renderLedger(board(
    [row({ state: "exhausted", scorable: false, gates: null, context_exhausted: true, reason })],
    { complete: 0, running: 0, void: 0, exhausted: 1 },
  ));
  assert.match(html, /class="blstate exhausted ctx">CONTEXT EXHAUSTED</);
  assert.ok(html.includes(reason));
  assert.ok(html.includes("1 context exhausted"));
});

test("a normal floor carries no label", () => {
  const html = renderLedger(board([row()], { complete: 1, running: 0, void: 0 }));
  assert.ok(!html.includes("CONTEXT EXHAUSTED"));
});
