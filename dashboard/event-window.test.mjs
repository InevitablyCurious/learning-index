// ─────────────────────────────────────────────────────────────────────────────
// EVENT-WINDOW PINNING
//
// The live feed's `user`/`harness` chips count the WHOLE ring, but the rows
// behind those counts aged out of the ≤400-row client windows and became
// unfilterable — the chip said 12, the filter could show fewer. The fix PINS
// grading rows (kind "user"/"harness") at BOTH independent window layers:
//
//   1. sources/control-plane.mjs — the server's source window (exported
//      `capWindow`, unit-tested directly below).
//   2. board.js — the browser's accumulated window. board.js runs in the
//      browser and must not import server-side source modules, so it inlines
//      an identical helper; this file pins that wiring from source, the way
//      dom-patch.test.mjs and style-coverage.test.mjs do (no DOM exists in
//      this repo's test environment).
//
// The cap now applies only to the five agent kinds
// (tool/file/thinking/error/lifecycle).
//
// Importing sources/control-plane.mjs is side-effect-free — its top level is
// declarations only.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { capWindow } from "./sources/control-plane.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFile(join(HERE, rel), "utf8");

/** Strip comments so a rule is never satisfied or broken by prose ABOUT it. */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ── THE PURE HELPER ─────────────────────────────────────────────────────────

test("grading rows are pinned even when agent rows exceed the cap", () => {
  const rows = [
    { seq: 1, kind: "user" },
    { seq: 2, kind: "harness" },
    ...Array.from({ length: 10 }, (_, i) => ({ seq: 3 + i, kind: "tool" })),
  ];
  const out = capWindow(rows, 4);
  const kinds = out.map((r) => r.kind);
  assert.ok(kinds.includes("user"), "the user row must survive any trim");
  assert.ok(kinds.includes("harness"), "the harness row must survive any trim");
  // The cap applies to the agent kinds: the OLDEST agent rows are what drop.
  assert.deepEqual(
    out.filter((r) => r.kind === "tool").map((r) => r.seq),
    [9, 10, 11, 12],
  );
  assert.equal(out.length, 6, "2 pinned + 4 capped");
});

test("non-grading rows are capped at exactly cap", () => {
  const agentKinds = ["tool", "file", "thinking", "error", "lifecycle"];
  const rows = Array.from({ length: 25 }, (_, i) => ({ seq: i + 1, kind: agentKinds[i % 5] }));
  const out = capWindow(rows, 10);
  assert.equal(out.length, 10);
  assert.deepEqual(
    out.map((r) => r.seq),
    [16, 17, 18, 19, 20, 21, 22, 23, 24, 25],
  );
});

test("the merged window stays in ascending seq order", () => {
  // Pinned rows can be older OR newer than the kept agent rows; the merge must
  // re-sort rather than concatenate pinned-first.
  const rows = [
    { seq: 5, kind: "tool" },
    { seq: 2, kind: "user" },
    { seq: 9, kind: "harness" },
    { seq: 6, kind: "file" },
    { seq: 7, kind: "error" },
    { seq: 8, kind: "tool" },
  ];
  const out = capWindow(rows, 3);
  assert.deepEqual(
    out.map((r) => r.seq),
    [2, 6, 7, 8, 9],
  );
});

test("a window within the cap is returned unchanged", () => {
  const rows = [
    { seq: 1, kind: "user" },
    { seq: 2, kind: "tool" },
    { seq: 3, kind: "harness" },
  ];
  const out = capWindow(rows, 400);
  assert.deepEqual(out, rows);
  assert.equal(out, rows, "the common path must not churn a copy every poll");
});

test("rows without a seq do not break the sort", () => {
  const rows = [
    { kind: "user" }, // no seq — pinned
    { seq: 4, kind: "tool" },
    { kind: "harness" }, // no seq — pinned
    { seq: 2, kind: "file" },
    { seq: 3, kind: "thinking" },
  ];
  const out = capWindow(rows, 2);
  assert.equal(out.length, 4, "2 pinned + 2 kept");
  assert.deepEqual(
    out.map((r) => r.seq ?? null),
    [null, null, 2, 3],
    "undefined seq sorts as 0, ahead of the numbered rows",
  );
});

// ── THE WIRING, PINNED FROM SOURCE (both layers) ────────────────────────────

test("the browser window trim is grading-aware", async () => {
  const src = code(await read("board.js"));
  assert.match(
    src,
    /function capWindow\s*\(/,
    "board.js must inline the capWindow helper — it cannot import the " +
      "server-side source module",
  );
  assert.match(
    src,
    /r\.kind === "user" \|\| r\.kind === "harness"/,
    "the browser pin predicate must cover BOTH grading kinds, identical to " +
      "sources/control-plane.mjs",
  );
  assert.match(
    src,
    /eventRows = capWindow\(eventRows, EVENT_WINDOW_CAP\)/,
    "the SSE events handler must trim through capWindow",
  );
  assert.equal(
    /eventRows\.slice\(eventRows\.length - EVENT_WINDOW_CAP\)/.test(src),
    false,
    "a raw slice trim on eventRows would silently drop grading rows again",
  );
});

test("the source-side window trim is grading-aware", async () => {
  const src = code(await read("sources/control-plane.mjs"));
  assert.match(src, /export function capWindow\s*\(/);
  assert.match(
    src,
    /eventWindow = capWindow\(\[\.\.\.eventWindow, \.\.\.fresh\], EVENT_WINDOW_CAP\)/,
    "the delta merge must trim through capWindow",
  );
  assert.equal(
    /eventWindow\.slice\(eventWindow\.length - EVENT_WINDOW_CAP\)/.test(src),
    false,
    "a raw slice trim on eventWindow would silently drop grading rows again",
  );
});
