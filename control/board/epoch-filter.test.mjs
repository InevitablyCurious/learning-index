// ─────────────────────────────────────────────────────────────────────────────
// THE RUN-LANE VIEW — contract.mjs SYSTEM_EPOCH / isV2Run / filterBoardRuns /
// filterBoard, the helpers GET /api/board serves through.
//
// A card's lane comes from lib/run-class.mjs: "archived" (its path is under an
// archive root — the source prunes these at the walk, and the filter drops one
// defensively), "living" (v2 epoch) or "legacy" (pre-v2). The default view is
// the living lane alone; `includeHistorical` adds legacy; archived never
// surfaces. counts.archived_excluded is a SOURCE fact and is passed through
// untouched, so filtering cannot make the archive look like it never existed.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SYSTEM_EPOCH,
  isV2Run,
  filterBoardRuns,
  filterBoard,
} from "./contract.mjs";
import { SYSTEM_EPOCH as CLASSIFIER_EPOCH } from "./lib/run-class.mjs";

const living = (over = {}) => ({
  run_dir: "9999999999/local/model-a",
  sequence_index: 0,
  status: "scored",
  system_epoch: SYSTEM_EPOCH,
  class: "living",
  ...over,
});

const legacy = (over = {}) => ({
  run_dir: "legacy-model",
  sequence_index: 0,
  status: "scored",
  system_epoch: null,
  class: "legacy",
  ...over,
});

const archivedCard = (over = {}) => ({
  run_dir: "backups/1790000001/1780000001/local/model-old",
  sequence_index: 0,
  status: "scored",
  system_epoch: null,
  class: "archived",
  ...over,
});

test("SYSTEM_EPOCH is the v2 wire epoch, re-exported from the classifier", () => {
  assert.equal(SYSTEM_EPOCH, "2026-11-08");
  assert.equal(SYSTEM_EPOCH, CLASSIFIER_EPOCH, "one literal, never a second copy");
});

test("isV2Run: true only for the exact epoch string", () => {
  assert.equal(isV2Run(living()), true);
  assert.equal(isV2Run(legacy()), false);
  assert.equal(isV2Run({}), false);
  assert.equal(isV2Run({ system_epoch: "2026-11-09" }), false);
  assert.equal(isV2Run({ system_epoch: " 2026-11-08 " }), false); // not trimmed
  assert.equal(isV2Run(null), false);
});

test("filterBoardRuns: default keeps the living lane and drops legacy + archived", () => {
  const list = [living(), legacy(), archivedCard()];
  assert.deepEqual(filterBoardRuns(list), [list[0]]);
});

test("filterBoardRuns: includeHistorical keeps living + legacy, never archived", () => {
  const list = [living(), legacy(), archivedCard(), archivedCard({ class: "archived", system_epoch: SYSTEM_EPOCH })];
  const kept = filterBoardRuns(list, { includeHistorical: true });
  assert.deepEqual(kept, [list[0], list[1]], "an archived path never surfaces, even declaring the v2 epoch");
});

test("filterBoardRuns: a card with no class is re-classified from its path and epoch", () => {
  // No `class` (a stale cache / an unwired source): the classifier decides.
  const v2 = { run_dir: "9999999999/x", system_epoch: SYSTEM_EPOCH, status: "scored" };
  const old = { run_dir: "legacy-model", system_epoch: null, status: "scored" };
  const gone = { run_dir: "backups/1/2/x", system_epoch: null, status: "scored" };
  assert.deepEqual(filterBoardRuns([v2, old, gone]), [v2]);
  assert.deepEqual(filterBoardRuns([v2, old, gone], { includeHistorical: true }), [v2, old]);
});

test("filterBoardRuns: a non-array list is returned unchanged, never invented", () => {
  assert.equal(filterBoardRuns(null), null);
  assert.equal(filterBoardRuns(undefined), undefined);
  const obj = { total: 0 };
  assert.equal(filterBoardRuns(obj), obj);
});

test("filterBoardRuns never mutates the (cached) input array", () => {
  const list = [living(), legacy(), archivedCard()];
  filterBoardRuns(list);
  filterBoardRuns(list, { includeHistorical: true });
  assert.equal(list.length, 3);
});

// ── the per-response board: filtered list + truthful counts, nothing else ──

function fixture() {
  return {
    contract_version: "2.0",
    generated_at: 1,
    runs: {
      list: [
        living({ run_dir: "9999999999/a", sequence_index: 0, status: "scored" }),
        living({ run_dir: "9999999999/a", sequence_index: 1, status: "live" }),
        living({ run_dir: "9999999999/d", sequence_index: 0, status: "harness_error" }),
        living({ run_dir: "9999999999/e", sequence_index: 0, status: "void" }),
        legacy({ run_dir: "legacy-1", sequence_index: 0, status: "scored" }),
        legacy({ run_dir: "legacy-2", sequence_index: 0, status: "void" }),
        archivedCard({ run_dir: "backups/1/2/x", sequence_index: 0, status: "scored" }),
      ],
      counts: {
        total: 7,
        live: 1,
        scored: 3,
        void: 2,
        harness_error: 1,
        living: 4,
        legacy: 2,
        archived_excluded: 261,
      },
    },
    // Sections that must survive the filter by reference, untouched.
    provenance: { attestation: "bench-mock/self-declared" },
    by_cell: { "9999999999/a::0": { run: {} } },
    sources: [{ id: "runs", ok: true, fields: [], reason: null, ms: 1 }],
    cells: { ok: true, list: [] },
  };
}

test("filterBoard: default → the living lane only, counts recomputed from it", () => {
  const board = fixture();
  const out = filterBoard(board);

  assert.equal(out.runs.list.length, 4);
  assert.ok(out.runs.list.every((c) => c.class === "living"));
  assert.deepEqual(out.runs.counts, {
    total: 4,
    live: 1,
    scored: 1,
    void: 1,
    harness_error: 1,
    living: 4,
    legacy: 0,
    archived_excluded: 261,
  });
});

test("filterBoard: includeHistorical → living + legacy, counts match the full list", () => {
  const board = fixture();
  const out = filterBoard(board, { includeHistorical: true });

  assert.equal(out.runs.list.length, 6);
  assert.equal(out.runs.list.some((c) => c.class === "archived"), false);
  assert.deepEqual(out.runs.counts, {
    total: 6,
    live: 1,
    scored: 2,
    void: 2,
    harness_error: 1,
    living: 4,
    legacy: 2,
    archived_excluded: 261,
  });
});

test("filterBoard: archived_excluded survives a view where every card is filtered out", () => {
  const board = fixture();
  board.runs.list = [legacy(), legacy({ run_dir: "legacy-3" })];
  board.runs.counts = {
    total: 2, live: 0, scored: 2, void: 0, harness_error: 0,
    living: 0, legacy: 2, archived_excluded: 261,
  };

  const out = filterBoard(board);
  assert.deepEqual(out.runs.list, []);
  assert.deepEqual(out.runs.counts, {
    total: 0,
    live: 0,
    scored: 0,
    void: 0,
    harness_error: 0,
    living: 0,
    legacy: 0,
    archived_excluded: 261,
  });
});

test("filterBoard: other board sections are the cached objects themselves, untouched", () => {
  const board = fixture();
  const out = filterBoard(board);

  assert.equal(out.provenance, board.provenance);
  assert.equal(out.by_cell, board.by_cell);
  assert.equal(out.sources, board.sources);
  assert.equal(out.cells, board.cells);
  assert.equal(out.contract_version, board.contract_version);
  assert.equal(out.generated_at, board.generated_at);
});

test("filterBoard never mutates the cached board (list, counts, runs identity)", () => {
  const board = fixture();
  const listBefore = board.runs.list;
  const countsBefore = { ...board.runs.counts };

  filterBoard(board);
  filterBoard(board, { includeHistorical: true });

  assert.equal(board.runs.list, listBefore);
  assert.equal(board.runs.list.length, 7);
  assert.deepEqual(board.runs.counts, countsBefore);
});

test("filterBoard: an unwired runs section (null) is passed through, not invented", () => {
  const board = { ...fixture(), runs: null };
  assert.equal(filterBoard(board), board);
});
