// ─────────────────────────────────────────────────────────────────────────────
// RUN CARDS — the strip is per-run, and a card states exactly six things
//
//     cd dashboard && node --test run-cards.test.mjs
//
// WHAT THIS PINS
//
//   1. THE STRIP ALWAYS RENDERS. The old `<2` guard hid the strip for a single
//      run; one run is the board's ordinary state and zero runs is a stated
//      absence, never a missing section.
//   2. SIX THINGS, NOTHING ELSE. Status header (dot + identity + tag),
//      problems before → after, peak context / window, turns, loop errors,
//      stalled/limit. No progress bar, no meta line, no sparkline.
//   3. NULL IS "NOT RECORDED". A field no artifact stated is never 0 and never
//      derived — producer states, consumer reads.
//   4. SELECTION IS THE CELL ADDRESS. data-cell-pick carries the cellKey
//      (`<run_dir>::<seq>`), so an ARCHIVED run is selectable like any other.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderCells, setSelectedCell, activeCell } from "./panels/cells.js";

const RD = "1790237137/local/local-llm-proxy/omlx";
const AR = "backups/1789474325/1789474112/local/local-llm-proxy/omlx";

/** A card in the exact board.runs.list contract shape (runs.mjs). */
function card(over = {}) {
  return {
    run_dir: RD, sequence_index: 0, archived: false, model: "m", arm: "off",
    status: "live",
    problems_before: 28, problems_after: 26,
    context_peak: 129000, context_window: 262144,
    turns: 312, loop_errors: 2, stalled_limit_errors: 1,
    ...over,
  };
}

function boardWith(list) {
  return {
    runs: {
      list,
      counts: {
        total: list.length,
        live: list.filter((c) => c.status === "live").length,
        scored: list.filter((c) => c.status === "scored").length,
        void: list.filter((c) => c.status === "void").length,
        harness_error: list.filter((c) => c.status === "harness_error").length,
      },
    },
  };
}

/** The first card's markup, out of the rendered strip. */
function firstCard(html) {
  return html.slice(html.indexOf("<button"), html.indexOf("</button>") + 9);
}

test("the strip renders with a SINGLE run — the <2 hide is gone", () => {
  setSelectedCell(null);
  const html = renderCells(boardWith([card()]));
  assert.match(html, /class="cellcard/, "one run renders a card");
  assert.ok(html.includes("RUNS · 1 run"), "the header counts the single run");
  assert.ok(!html.includes("1 runs"), "and pluralises it honestly");
});

test("zero runs still renders the strip, stating the absence", () => {
  const html = renderCells(boardWith([]));
  assert.ok(html.includes("no runs recorded"), "an empty strip is a stated absence, not a hidden section");
});

test("a card states exactly the six things — no bar, no meta line", () => {
  const one = firstCard(renderCells(boardWith([card()])));
  assert.ok(one.includes("cc-head"), "the status header");
  assert.equal((one.match(/class="cc-f"/g) ?? []).length, 5, "five field rows under the header");
  assert.ok(!one.includes("cc-bar"), "no progress bar");
  assert.ok(!one.includes("cc-meta"), "no meta line");
  assert.ok(one.includes("problems"), "field: problems");
  assert.ok(one.includes("28 → 26"), "problems before → after");
  assert.ok(one.includes("peak ctx"), "field: peak context");
  assert.ok(one.includes("129k / 262k"), "peak / window, compacted");
  assert.ok(one.includes("turns"), "field: turns");
  assert.ok(one.includes(">312<"), "turns stated");
  assert.ok(one.includes("loop errors"), "field: loop errors");
  assert.ok(one.includes(">2<"), "loop errors stated");
  assert.ok(one.includes("stall/limit"), "field: stalled/limit");
  assert.ok(one.includes(">1<"), "stalled/limit stated");
});

test("null is 'not recorded' — never 0, never derived, never half a pair", () => {
  const html = renderCells(boardWith([card({
    problems_before: 28, problems_after: null,
    context_peak: null, context_window: 262144,
    turns: null, loop_errors: null, stalled_limit_errors: null,
  })]));
  assert.equal((html.match(/not recorded/g) ?? []).length, 5, "every unstated field says so");
  assert.ok(!html.includes("28 →"), "a half-stated pair is not half-rendered");
  assert.ok(!html.includes(">0<"), "and a null never renders as 0");
});

// ── problems as IDENTITY: +broke (red) / −fixed (green), never a net count ──

test("a swap renders BOTH deltas — never net-zero, never the count pair", () => {
  const one = firstCard(renderCells(boardWith([card({ problems_fixed: 1, problems_broke: 1 })])));
  assert.ok(one.includes('<span class="cc-delta bad">+1</span>'), "broke renders +N red");
  assert.ok(one.includes('<span class="cc-delta good">−1</span>'), "fixed renders −N green (U+2212)");
  assert.ok(one.indexOf("cc-delta bad") < one.indexOf("cc-delta good"), "broke (+) leads, fixed (−) follows");
  assert.ok(!one.includes("→"), "identity data replaces the before → after pair");
});

test("a pure fix renders −N green only", () => {
  const one = firstCard(renderCells(boardWith([card({ problems_fixed: 1, problems_broke: 0 })])));
  assert.ok(one.includes('<span class="cc-delta good">−1</span>'), "fixed renders −N green");
  assert.ok(!one.includes("cc-delta bad"), "nothing broke, so no red delta");
  assert.ok(!one.includes("+"), "and no + glyph anywhere on the card");
  assert.ok(!one.includes("→"), "identity data replaces the count pair");
});

test("a pure regression renders +N red only", () => {
  const one = firstCard(renderCells(boardWith([card({ problems_fixed: 0, problems_broke: 1 })])));
  assert.ok(one.includes('<span class="cc-delta bad">+1</span>'), "broke renders +N red");
  assert.ok(!one.includes("cc-delta good"), "nothing fixed, so no green delta");
  assert.ok(!one.includes("−"), "and no − glyph anywhere on the card");
  assert.ok(!one.includes("→"), "identity data replaces the count pair");
});

test("status → tag text and dot", () => {
  const cases = [
    ["live", "LIVE", "cc-live"],
    ["scored", "SCORED", "cc-scored"],
    ["void", "VOID", "cc-void"],
    ["harness_error", "HARNESS ERROR", "cc-harness"],
  ];
  for (const [status, text, dot] of cases) {
    const html = renderCells(boardWith([card({ status })]));
    assert.ok(html.includes(`>${text}</span>`), `${status} tags ${text}`);
    assert.ok(html.includes(`cc-dot ${dot}`), `${status} dots ${dot}`);
  }
  // Void and harness-error cards are dimmed and marked, never hidden.
  assert.ok(renderCells(boardWith([card({ status: "void" })])).includes("cc-is-void"));
  assert.ok(renderCells(boardWith([card({ status: "harness_error" })])).includes("cc-is-harness"));
});

test("an archived run renders as a card, addressed by its cellKey", () => {
  const html = renderCells(boardWith([card(), card({ run_dir: AR, sequence_index: 3, archived: true, status: "scored" })]));
  assert.ok(html.includes(`data-cell-pick="${AR}::3"`), "the pick value is the cellKey, not a bare index");
  assert.ok(html.includes("74112·s0003"), "the identity is the INNER archived tree id + seq");
  assert.ok(html.includes("37137·s0000"), "a current card's identity is its run_dir's tree id + seq");
});

test("selection is the cellKey; the picked card is marked, and a stale pick falls back", () => {
  const b = boardWith([card({ status: "scored" }), card({ sequence_index: 1, status: "live" }), card({ sequence_index: 2, status: "void" })]);
  setSelectedCell(null);
  assert.equal(activeCell(b).sequence_index, 1, "with no pick the strip follows the first live card (the producer sorts newest-tree-first)");

  setSelectedCell(`${RD}::2`);
  assert.equal(activeCell(b).sequence_index, 2, "a void run is selectable like any other");
  const html = renderCells(b);
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1, "exactly one card is pressed");
  assert.ok(html.includes(`class="cellcard cc-is-void on" data-cell-pick="${RD}::2"`), "and it is the picked one, still marked void");

  setSelectedCell("gone::9");
  assert.equal(activeCell(b).sequence_index, 1, "a pick that left the strip falls back rather than blanking the board");

  const noLive = boardWith([card({ status: "scored" }), card({ sequence_index: 1, status: "void" })]);
  setSelectedCell(null);
  assert.equal(activeCell(noLive).sequence_index, 0, "with nothing live the first card leads");
});
