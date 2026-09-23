// BATCH VIEW — what the BASELINES row shows inside a batch (baselines.mjs batchView).
//
// The problem counts and scored/void verdicts come from the batch record — the
// numbers the median is taken over — never re-derived from the cells. Voids are
// listed, never dropped. The pick carries its distance from the median as a
// percentage (Jerry, 2026-09-22: Δ is against the picked baseline, which carries
// its own ±N% from the median).

import { test } from "node:test";
import assert from "node:assert/strict";
import { batchView } from "../baselines.mjs";

const cell = (i, over = {}) => ({
  sequence_index: i, state: "complete", turns: 300, tokens: 1, wall_seconds: 10,
  gates: null, verdict: "FAIL", terminal_reason: "attempt_ceiling_reached",
  context_exhausted: false, attempt_failures: [], ...over,
});

// The 2026-09-22 N=4 batch: 27, 23, void, 17 → median 23.
const batch = (over = {}) => ({
  median: 23, scored_count: 3, void_count: 1, selection: null,
  runs: [
    { sequence_index: 0, problem_count: 27, scored: true, void_reason: null },
    { sequence_index: 1, problem_count: 23, scored: true, void_reason: null },
    { sequence_index: 2, problem_count: null, scored: false, void_reason: "not_started" },
    { sequence_index: 3, problem_count: 17, scored: true, void_reason: null },
  ],
  ...over,
});
const cells = [cell(3), cell(0, { attempt_failures: [27, 28, 27, 26, 24] }), cell(2, { state: "not_started" }), cell(1)];

test("every cell, in order, voids included, with its distance from the median", () => {
  const v = batchView(cells, batch());
  assert.deepEqual(v.cells.map((c) => c.sequence_index), [0, 1, 2, 3]);
  assert.deepEqual(v.cells.map((c) => c.problems), [27, 23, null, 17]);
  assert.deepEqual(v.cells.map((c) => c.vs_median), [4, 0, null, -6]);
  assert.equal(v.cells[2].scored, false);
  assert.equal(v.cells[2].void_reason, "not_started");
  assert.deepEqual(v.cells[0].attempt_failures, [27, 28, 27, 26, 24]);
});

test("median, spread over scored cells only, and counts", () => {
  const v = batchView(cells, batch());
  assert.equal(v.median, 23);
  assert.deepEqual(v.spread, { min: 17, max: 27 });
  assert.equal(v.scored_count, 3);
  assert.equal(v.void_count, 1);
  assert.equal(v.pick, null);
});

test("the pick carries its signed deviation and its percentage of the median", () => {
  const v = batchView(cells, batch({ selection: { sequence_index: 0, signed_deviation: 4 } }));
  assert.deepEqual(v.pick, { sequence_index: 0, problems: 27, signed_deviation: 4, pct_from_median: 17.4 });
  assert.equal(v.cells[0].picked, true);
  assert.equal(v.cells.filter((c) => c.picked).length, 1);
});

test("with no batch record (still running) the cells carry no verdict", () => {
  const v = batchView([cell(0, { state: "not_started" }), cell(1, { state: "not_started" })], null);
  assert.equal(v.median, null);
  assert.equal(v.spread, null);
  assert.deepEqual(v.cells.map((c) => c.scored), [null, null]);
});
