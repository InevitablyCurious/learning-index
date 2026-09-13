// ─────────────────────────────────────────────────────────────────────────────
// TUI MIRROR — THE FIT SOLVE
//
// WHY THIS EXISTS
//
// The mirror's size used to come from a constant written into the source:
//
//     export const CH_W = 8.4;   // "measured at 13px JetBrains Mono"
//
// Three things were wrong with it at once, and none of them could fail loudly.
// 8.4px is 0.6em at FOURTEEN px and the stylesheet renders thirteen. The font
// it named was never loading (both @font-face entries report status "error";
// the pinned URL 404s), so the board drew SF Mono. And a number in a source
// file cannot be re-measured when either of those changes. The box it produced
// reserved 1092px for a grid that drew 1017.5px — 6.8% of the card spent on
// nothing, and the scale factor derived from it was wrong by the same amount.
//
// The replacement measures the font the browser actually resolved and divides.
// That division is the part that can be wrong, so it is pinned here rather than
// eyeballed in a browser — the previous constant was eyeballed, and it survived
// months of looking approximately right.
//
// THE NUMBERS BELOW ARE MEASURED, NOT ASSUMED. Sweep of a real xterm.js 6.0.0
// Terminal at devicePixelRatio 2, 130 columns, --font resolving to SF Mono:
//
//     fontSize 6.0 -> 470.0px   cell 3.615
//     fontSize 6.5 -> 509.0px   cell 3.915
//     fontSize 7.0 -> 548.0px   cell 4.215
//     fontSize 7.2 -> 564.0px   cell 4.338
//     fontSize 7.4 -> 579.0px   cell 4.454
//     fontSize 8.0 -> 626.0px   cell 4.815
//
// cell/fontSize is 0.6023 +/- 0.0002 across that range, which is what makes a
// single division sufficient and a search unnecessary.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";

import { solveFontSize, TUI_COLS } from "./panels/tui.js";

/** The measured advance, in px of width per px of font size, per character. */
const RATIO = 0.6023;

/** What xterm will actually draw at a given font size, from the sweep above. */
const drawnWidth = (fontSize) => fontSize * RATIO * TUI_COLS;

test("the solved size FITS the container it was solved for", () => {
  // Every card width the board can produce, not one convenient example.
  for (let avail = 200; avail <= 1600; avail += 1) {
    const fs = solveFontSize(avail, RATIO);
    if (fs === null) continue;
    // The floor at FONT_MIN can exceed a very narrow container; that is the
    // bound doing its job, and the container clips rather than the text
    // becoming unreadable.
    if (fs <= 4) continue;
    assert.ok(
      drawnWidth(fs) <= avail,
      `${fs}px draws ${drawnWidth(fs).toFixed(1)}px into ${avail}px`,
    );
  }
});

test("it does not waste the card — at most one step below the largest size that fits", () => {
  // A fit that always returned the minimum would pass the test above. This is
  // the other half of the claim: the solve must be TIGHT, not merely safe.
  //
  // ONE STEP OF SLACK IS ALLOWED, and it is the deliberate cost of two
  // deliberate choices: the size is floored to a tenth, and it is solved
  // against FIT_MARGIN rather than the raw width. Both bias downward on
  // purpose — an overflowing terminal is CLIPPED and silently loses columns,
  // an undersized one leaves a hairline of background. The failure modes are
  // not symmetric, so the rounding is not either.
  for (let avail = 300; avail <= 1600; avail += 1) {
    const fs = solveFontSize(avail, RATIO);
    if (fs === null || fs <= 4 || fs >= 16) continue; // bounded, not solved
    const largestThatFits = Math.floor((avail / (RATIO * TUI_COLS)) * 10) / 10;
    assert.ok(
      largestThatFits - fs <= 0.1 + 1e-9,
      `${avail}px: solved ${fs}px but ${largestThatFits}px would still have fit`,
    );
  }
});

test("the card measured on this board solves to the sweep's best fit", () => {
  // 574px is the real content width of the transfer-curve card at 1265px of
  // viewport. From the sweep, 7.3px draws 571.6px and 7.4px draws 579.4px, so
  // 7.3 is the largest size that fits and is what the solve must choose.
  assert.equal(solveFontSize(574, RATIO), 7.3);
  assert.ok(drawnWidth(7.3) <= 574);
  assert.ok(drawnWidth(7.4) > 574);
});

test("the WebGL addon's cell quantisation is why it is not loaded", () => {
  // Swept against a real Terminal in this card at devicePixelRatio 2, the addon
  // could only produce cell widths of 3.5, 4.0 or 4.5 CSS px — whole device
  // pixels. This asserts the CONSEQUENCE that made it unusable: at 574px of
  // card, every achievable width either overflows or wastes ~9% of it. If a
  // future xterm makes cells fractional under WebGL, this test is what says the
  // decision can be revisited.
  const achievable = [3.5, 4.0, 4.5].map((cell) => cell * TUI_COLS);
  assert.deepEqual(achievable, [455, 520, 585]);
  const best = achievable.filter((w) => w <= 574).pop();
  assert.equal(best, 520);
  assert.ok((574 - best) / 574 > 0.09, "the waste that removing the addon recovered");
  // The DOM renderer's fractional cells do better on the same card.
  assert.ok(drawnWidth(solveFontSize(574, RATIO)) > best);
});

test("utilisation is high, not merely safe", () => {
  for (const avail of [420, 574, 700, 900, 1200]) {
    const used = drawnWidth(solveFontSize(avail, RATIO)) / avail;
    assert.ok(used > 0.97, `only ${(used * 100).toFixed(1)}% of ${avail}px used`);
  }
});

test("it is bounded at both ends", () => {
  assert.equal(solveFontSize(50, RATIO), 4, "never smaller than legible");
  assert.equal(solveFontSize(100000, RATIO), 16, "never larger than the board's own body text");
});

test("a container or font that could not be measured yields no answer", () => {
  // Returning a number here would be inventing a size from a failed
  // measurement — the exact move that produced the 8.4px constant.
  for (const bad of [0, -1, NaN, undefined, null]) {
    assert.equal(solveFontSize(bad, RATIO), null, `avail ${bad}`);
    assert.equal(solveFontSize(574, bad), null, `ratio ${bad}`);
  }
});
