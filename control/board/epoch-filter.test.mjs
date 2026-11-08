// ─────────────────────────────────────────────────────────────────────────────
// THE SYSTEM-EPOCH VIEW — contract.mjs SYSTEM_EPOCH / isV2Run /
// filterBoardRuns / filterBoard, the helpers GET /api/board serves through.
//
// The board's default view is the v2 epoch alone: the 263 pre-v2 runs declared
// no `system_epoch` (null on their cards) and are reachable only with
// `include_historical`. These tests pin that the default drops them, the
// historical view returns the SAME array, the filter never mutates the shared
// cache input, and the per-response copy recomputes runs.counts while leaving
// every other board section untouched.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SYSTEM_EPOCH,
  isV2Run,
  filterBoardRuns,
  filterBoard,
} from "./contract.mjs";

const v2 = (over = {}) => ({
  run_dir: "runs/a",
  sequence_index: 0,
  status: "scored",
  system_epoch: SYSTEM_EPOCH,
  ...over,
});

const v1 = (over = {}) => ({
  run_dir: "runs/b",
  sequence_index: 0,
  status: "scored",
  system_epoch: null,
  ...over,
});

test("SYSTEM_EPOCH is the v2 wire epoch", () => {
  assert.equal(SYSTEM_EPOCH, "2026-11-08");
});

test("isV2Run: true only for the exact epoch string", () => {
  assert.equal(isV2Run(v2()), true);
  assert.equal(isV2Run(v1()), false);
  assert.equal(isV2Run({}), false);
  assert.equal(isV2Run({ system_epoch: "2026-11-09" }), false);
  assert.equal(isV2Run({ system_epoch: " 2026-11-08 " }), false); // not trimmed
  assert.equal(isV2Run(null), false);
});

test("filterBoardRuns: default keeps v2-epoch cards and drops null/missing", () => {
  const list = [v2(), v1(), { run_dir: "runs/c", status: "live" }];
  const kept = filterBoardRuns(list);
  assert.deepEqual(kept, [list[0]]);
});

test("filterBoardRuns: the 263-card pre-v2 board collapses to the v2 set (empty today)", () => {
  const list = Array.from({ length: 263 }, (_, i) =>
    v1({ run_dir: `backups/${i}`, sequence_index: i }),
  );
  assert.deepEqual(filterBoardRuns(list), []);
});

test("filterBoardRuns: includeHistorical returns ALL runs", () => {
  const list = [v2(), v1(), { run_dir: "runs/c" }];
  const all = filterBoardRuns(list, { includeHistorical: true });
  assert.equal(all.length, 3);
  assert.deepEqual(all, list);
});

test("filterBoardRuns: a non-array list is returned unchanged, never invented", () => {
  assert.equal(filterBoardRuns(null), null);
  assert.equal(filterBoardRuns(undefined), undefined);
  const obj = { total: 0 };
  assert.equal(filterBoardRuns(obj), obj);
});

test("filterBoardRuns: an explicit epoch overrides the default", () => {
  const list = [v2(), v1({ system_epoch: "2026-11-09" })];
  assert.deepEqual(filterBoardRuns(list, { epoch: "2026-11-09" }), [list[1]]);
});

test("filterBoardRuns never mutates the (cached) input array", () => {
  const list = [v2(), v1()];
  filterBoardRuns(list);
  filterBoardRuns(list, { includeHistorical: true });
  assert.equal(list.length, 2);
});

// ── the per-response board: filtered list + truthful counts, nothing else ──

function fixture() {
  return {
    contract_version: "2.0",
    generated_at: 1,
    runs: {
      list: [
        v2({ run_dir: "runs/a", sequence_index: 0, status: "scored" }),
        v2({ run_dir: "runs/a", sequence_index: 1, status: "live" }),
        v2({ run_dir: "runs/d", sequence_index: 0, status: "harness_error" }),
        v2({ run_dir: "runs/e", sequence_index: 0, status: "void" }),
        v1({ run_dir: "backups/1", sequence_index: 0, status: "scored" }),
        v1({ run_dir: "backups/2", sequence_index: 0, status: "void" }),
        { run_dir: "backups/3", sequence_index: 0, status: "scored" },
      ],
      counts: { total: 7, live: 1, scored: 3, void: 2, harness_error: 1 },
    },
    // Sections that must survive the filter by reference, untouched.
    provenance: { attestation: "bench-mock/self-declared" },
    by_cell: { "runs/a::0": { run: {} } },
    sources: [{ id: "runs", ok: true, fields: [], reason: null, ms: 1 }],
    cells: { ok: true, list: [] },
  };
}

test("filterBoard: default → v2-epoch list only, counts recomputed from it", () => {
  const board = fixture();
  const out = filterBoard(board);

  assert.equal(out.runs.list.length, 4);
  assert.ok(out.runs.list.every(isV2Run));
  assert.deepEqual(out.runs.counts, {
    total: 4,
    live: 1,
    scored: 1,
    void: 1,
    harness_error: 1,
  });
});

test("filterBoard: includeHistorical → every card, counts match the full list", () => {
  const board = fixture();
  const out = filterBoard(board, { includeHistorical: true });

  assert.equal(out.runs.list.length, 7);
  assert.deepEqual(out.runs.counts, {
    total: 7,
    live: 1,
    scored: 3,
    void: 2,
    harness_error: 1,
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

test("filterBoard: an all-pre-v2 board serves an empty list with truthful zero counts", () => {
  const board = fixture();
  board.runs.list = [v1(), v1()];
  board.runs.counts = { total: 2, live: 0, scored: 2, void: 0, harness_error: 0 };

  const out = filterBoard(board);
  assert.deepEqual(out.runs.list, []);
  assert.deepEqual(out.runs.counts, {
    total: 0,
    live: 0,
    scored: 0,
    void: 0,
    harness_error: 0,
  });
});
