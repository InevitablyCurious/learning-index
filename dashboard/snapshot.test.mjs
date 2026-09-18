// ─────────────────────────────────────────────────────────────────────────────
// SEED PICKER ORDER — DEEPEST SNAPSHOT FIRST
//
// A seed skips the build, so the deeper the snapshot the more of the build it
// skips: the picker leads with the deepest capture, and each row says its
// depth (n=). The sort is a pure helper, so the order is pinnable without a
// DOM. `?? 1` mirrors the backend's default for snapshots captured before
// depth was recorded (control/snapshots.mjs writes manifest.snapshot_depth).
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";

import { sortSeedsByDepth } from "./panels/snapshot.js";

test("seedable rows come back depth-descending — deepest first", () => {
  const rows = [
    { id: "shallow", snapshot_depth: 1 },
    { id: "deepest", snapshot_depth: 5 },
    { id: "middle", snapshot_depth: 3 },
  ];
  assert.deepEqual(
    sortSeedsByDepth(rows).map((r) => r.id),
    ["deepest", "middle", "shallow"],
  );
});

test("equal depths keep their original order (stable)", () => {
  const rows = [
    { id: "p", snapshot_depth: 3 },
    { id: "q", snapshot_depth: 1 },
    { id: "r", snapshot_depth: 3 },
    { id: "s", snapshot_depth: 1 },
  ];
  assert.deepEqual(
    sortSeedsByDepth(rows).map((r) => r.id),
    ["p", "r", "q", "s"],
    "ties must not reorder: within a depth the captured order stands",
  );
});

test("missing, undefined and null snapshot_depth all count as 1", () => {
  const rows = [
    { id: "missing" },
    { id: "undefined", snapshot_depth: undefined },
    { id: "null", snapshot_depth: null },
    { id: "two", snapshot_depth: 2 },
    { id: "one", snapshot_depth: 1 },
  ];
  assert.deepEqual(
    sortSeedsByDepth(rows).map((r) => r.id),
    ["two", "missing", "undefined", "null", "one"],
    "pre-depth captures sort as n=1 — stable among themselves, behind any deeper row",
  );
});

test("the input array is not mutated — the helper returns a copy", () => {
  const rows = [
    { id: "a", snapshot_depth: 1 },
    { id: "b", snapshot_depth: 2 },
  ];
  const before = rows.map((r) => r.id);
  const out = sortSeedsByDepth(rows);
  assert.deepEqual(rows.map((r) => r.id), before, "the caller's array keeps its order");
  assert.notEqual(out, rows, "a copy, not the same array");
});
