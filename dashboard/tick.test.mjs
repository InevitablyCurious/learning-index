// ─────────────────────────────────────────────────────────────────────────────
// LIVE NUMBER MOTION — the reading is never the animation's opinion
//
// WHY THIS EXISTS
//
// An animated counter is a second thing that decides what a number looks like,
// and this board's whole argument is that there is exactly one source for every
// measurement. The risk is not that the animation looks wrong — it is that a
// counter eases toward a value, gets interrupted by a faster tick, and settles
// on something the server never said. That would be indistinguishable from a
// correct reading, and it would be a fabricated measurement on the one surface
// that exists to refuse them.
//
// So the contract is pinned here: `odo()` always emits the authoritative value
// as BOTH `data-v` and visible text. The painter may only change how the text
// travels between readings — it can never be the reason a number is wrong, and
// a board whose script never ran still shows the right figure.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";

import { odo } from "./panels/tick.js";

const attr = (html, name) => (html.match(new RegExp(`${name}="([^"]*)"`)) ?? [])[1] ?? null;
const text = (html) => (html.match(/>([^<]*)<\/span>$/) ?? [])[1] ?? null;

test("the authoritative value is in the markup, not only in the animation", () => {
  // The board must read correctly with tick.js broken, absent or still loading.
  const html = odo(243836);
  assert.equal(attr(html, "data-v"), "243836");
  assert.equal(text(html), "243,836");
});

test("data-v is the RAW number — never the formatted one", () => {
  // The painter does arithmetic on this attribute. A formatted value here
  // ("1.5M", "243,836") parses to NaN or to 1.5, and the counter would either
  // stop moving or animate toward a number a million times too small.
  for (const [v, fmt] of [[1487972, "tok"], [83.21, "pct"], [52, "exact"]]) {
    const html = odo(v, { fmt });
    assert.equal(Number(attr(html, "data-v")), v);
  }
});

test("the format is declared, never inferred", () => {
  // The same total appears twice on this board — rounded in the headline, exact
  // in the breakdown. A counter that chose its own format could disagree with
  // the row above it.
  assert.equal(attr(odo(1487972, { fmt: "tok" }), "data-fmt"), "tok");
  assert.equal(text(odo(1487972, { fmt: "tok" })), "1.5M");
  assert.equal(text(odo(1487972)), "1,487,972");
  assert.equal(text(odo(83.21, { fmt: "pct" })), "83.21%");
});

test("the painter owns the text, so the morpher must not", () => {
  // dom.js syncs attributes and then leaves a preserved subtree alone. Without
  // this the board would overwrite the interpolated text ~5 times a second and
  // no animation could survive one frame.
  assert.match(odo(1), /data-preserve="1"/);
});

test("only rows that represent a SPEND opt into a floating delta", () => {
  // A rate is not a spend. "+0.03" of a percentage beside rows that mean tokens
  // would put two different kinds of number in one visual language.
  assert.match(odo(5, { float: true }), /data-float="on"/);
  assert.ok(!odo(5).includes("data-float"));
});

test("an unobserved value yields no counter at all", () => {
  // The caller falls back to its own null rendering. Emitting a zero here would
  // turn "we did not observe this" into "this is zero" — the single
  // substitution this board exists to refuse.
  for (const bad of [null, undefined, NaN, Infinity, -Infinity]) {
    assert.equal(odo(bad), null, `odo(${String(bad)})`);
  }
  assert.notEqual(odo(0), null, "but a real zero IS a reading and must render");
  assert.equal(text(odo(0)), "0");
});

test("the value survives the round trip the painter will make", () => {
  // What the painter reads back out of data-v must be exactly what went in;
  // this is the join between the two halves and the only place it is checked.
  for (const v of [0, 1, 52, 243836, 1487972, 83.21]) {
    assert.equal(Number(attr(odo(v), "data-v")), v);
  }
});
