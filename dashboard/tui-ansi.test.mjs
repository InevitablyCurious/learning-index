// ─────────────────────────────────────────────────────────────────────────────
// TUI FRAME → TERMINAL BYTES
//
// WHY THIS EXISTS
//
// The mirror carried a colour bug for the entire life of the panel and nothing
// caught it. The capture (control/tui.mjs) resolves every colour — truecolor,
// 256-colour and the basic palette — to a `#rrggbb` string before it reaches
// the board. The old renderer then ran that string through:
//
//     const n = Number(v);                       // Number("#2fe07a") -> NaN
//     return n >= 0 && n < ANSI.length ? ... : "inherit";
//
// so EVERY cell on screen rendered `color:inherit;background:inherit`. Measured
// on the live board: 303 spans, two distinct inline styles, one computed
// colour. The panel's own header claimed "colour fidelity preserved" while
// discarding all of it, and every test passed the whole time — because the only
// assertions were that some text appeared somewhere in the markup.
//
// A colour that silently degrades to the inherited one is invisible in exactly
// the way a missing CSS rule is: nothing throws, nothing logs, and the screen
// looks plausible. That is why the conversion is pinned here rather than
// eyeballed.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";

import { toAnsi } from "./panels/tui.js";

const ESC = "\x1b";

test("a hex foreground becomes a truecolor SGR — the regression this file exists for", () => {
  const out = toAnsi([[{ t: "ok", fg: "#2fe07a", bg: null, bold: false }]]);
  assert.ok(out.includes(`${ESC}[38;2;47;224;122m`), `no truecolor SGR in: ${JSON.stringify(out)}`);
  assert.ok(out.includes("ok"));
});

test("a hex background becomes a truecolor SGR on the 48 base", () => {
  const out = toAnsi([[{ t: "x", fg: null, bg: "#010203", bold: false }]]);
  assert.ok(out.includes(`${ESC}[48;2;1;2;3m`));
});

test("an unset channel emits NO colour rather than a guessed one", () => {
  const out = toAnsi([[{ t: "plain", fg: null, bg: null, bold: false }]]);
  assert.ok(!out.includes("38;2"), "a null foreground must not invent a colour");
  assert.ok(!out.includes("48;2"), "a null background must not invent a colour");
});

test("a malformed colour is DROPPED, never coerced", () => {
  // Terminal output is model-authored and arrives through the capture. A value
  // that is not a hex triple is absence of colour, not a colour to salvage —
  // coercion is precisely what produced the original defect.
  for (const bad of ["inherit", "#fff", "red", "", "#zzzzzz", 3, undefined, {}]) {
    const out = toAnsi([[{ t: "c", fg: bad, bg: bad, bold: false }]]);
    assert.ok(!out.includes("38;2"), `fg ${JSON.stringify(bad)} must not emit colour`);
    assert.ok(!out.includes("48;2"), `bg ${JSON.stringify(bad)} must not emit colour`);
    assert.ok(out.includes("c"), "the text itself must survive a bad colour");
  }
});

test("bold is carried", () => {
  assert.ok(toAnsi([[{ t: "b", fg: null, bg: null, bold: true }]]).includes(`${ESC}[1m`));
  assert.ok(!toAnsi([[{ t: "b", fg: null, bg: null, bold: false }]]).includes(`${ESC}[1m`));
});

test("every row is ABSOLUTELY addressed, so a wrap cannot bleed into the next", () => {
  // The rows are written at full width. Without a CUP before each one, a row
  // that fills the last column leaves the terminal in its pending-wrap state
  // and the following row lands one line low — the whole frame shears.
  const rows = [
    [{ t: "one", fg: null, bg: null, bold: false }],
    [{ t: "two", fg: null, bg: null, bold: false }],
    [{ t: "three", fg: null, bg: null, bold: false }],
  ];
  const out = toAnsi(rows);
  assert.ok(out.startsWith(`${ESC}[H`), "the frame must home the cursor first");
  assert.ok(out.includes(`${ESC}[1;1Hone`) || out.includes(`${ESC}[1;1H${ESC}[0mone`));
  assert.ok(out.includes(`${ESC}[2;1H`), "row 2 must be addressed absolutely");
  assert.ok(out.includes(`${ESC}[3;1H`), "row 3 must be addressed absolutely");
});

test("each run resets first, so style cannot leak across runs", () => {
  const out = toAnsi([[
    { t: "a", fg: "#ff0000", bg: null, bold: true },
    { t: "b", fg: null, bg: null, bold: false },
  ]]);
  const bAt = out.indexOf("b");
  const resetBeforeB = out.lastIndexOf(`${ESC}[0m`, bAt);
  const boldAt = out.indexOf(`${ESC}[1m`);
  assert.ok(resetBeforeB > boldAt, "the second run must reset the first run's bold");
});

test("the frame ends reset — the terminal is not left holding an attribute", () => {
  assert.ok(toAnsi([[{ t: "z", fg: "#112233", bg: null, bold: true }]]).endsWith(`${ESC}[0m`));
});

test("an empty frame is a valid frame, not a crash", () => {
  assert.equal(typeof toAnsi([]), "string");
});
