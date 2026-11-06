// "DRAWN" IS A MEASUREMENT, NOT AN ATTRIBUTE — a tagged checker is not a piece.
//
// The conformance pregate counts checkers with `[data-color][data-loc]`, which
// asks the page what it did rather than measuring what a player can see. A page
// that tags thirty checkers and displays none of them passes that count on an
// empty board. `checkerDrawnVerdict` is the predicate that closes it, and this
// file is its evidence:
//
//   - each way a piece can be present-but-invisible rejects, with a reason that
//     names that one condition and nothing else;
//   - a real piece — numeric point, `bar`, `off` — is drawn;
//   - a board that only tags, without a real side or location, draws zero.
//
// Pure function, plain inputs: no browser, no page, no fixture. That is why it
// runs here in the meta suite (node env) rather than behind the renderer, and
// why the renderer-backed pregate can import it without carrying a DOM with it.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkerDrawnVerdict,
  countDrawnCheckers,
  type CheckerDrawnInput,
} from "../conformance/checker-drawn.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GRADER = path.resolve(HERE, "..");

/** One visible white checker on point 13, in a 1280x800 viewport. */
function valid(overrides: Partial<CheckerDrawnInput> = {}): CheckerDrawnInput {
  return {
    color: "white",
    loc: "13",
    display: "block",
    visibility: "visible",
    opacity: 1,
    width: 30,
    height: 30,
    left: 100,
    top: 100,
    right: 130,
    bottom: 130,
    viewportWidth: 1280,
    viewportHeight: 800,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. EACH WAY A PIECE IS PRESENT BUT NOT DRAWN
// ─────────────────────────────────────────────────────────────────────────────

describe("checkerDrawnVerdict — present is not drawn", () => {
  it("rejects a checker taken out of layout", () => {
    const verdict = checkerDrawnVerdict(valid({ display: "none" }));
    expect(verdict.drawn).toBe(false);
    expect(verdict.reason).toContain("display:none");
  });

  it("rejects a checker whose visibility is hidden", () => {
    const verdict = checkerDrawnVerdict(valid({ visibility: "hidden" }));
    expect(verdict.drawn).toBe(false);
    expect(verdict.reason).toContain("visibility");
  });

  it("rejects a zero-size checker", () => {
    const verdict = checkerDrawnVerdict(valid({ width: 0 }));
    expect(verdict.drawn).toBe(false);
    expect(verdict.reason).toContain("zero size");
  });

  it("rejects a fully transparent checker", () => {
    const verdict = checkerDrawnVerdict(valid({ opacity: 0 }));
    expect(verdict.drawn).toBe(false);
    expect(verdict.reason).toContain("transparent");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. A REAL PIECE IS DRAWN
// ─────────────────────────────────────────────────────────────────────────────

describe("checkerDrawnVerdict — a real piece on the board", () => {
  it("accepts a checker on a numeric point", () => {
    const verdict = checkerDrawnVerdict(valid({ loc: "13" }));
    expect(verdict.drawn).toBe(true);
    expect(verdict.reason).toBe("");
  });

  it("accepts a checker on the bar", () => {
    const verdict = checkerDrawnVerdict(valid({ loc: "bar" }));
    expect(verdict.drawn).toBe(true);
    expect(verdict.reason).toBe("");
  });

  it("accepts a checker on the off tray", () => {
    const verdict = checkerDrawnVerdict(valid({ loc: "off", color: "black" }));
    expect(verdict.drawn).toBe(true);
    expect(verdict.reason).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. TAGGED-ONLY CANNOT COUNT
// ─────────────────────────────────────────────────────────────────────────────

describe("checkerDrawnVerdict — a tag is not a piece", () => {
  it("rejects an absent data-color", () => {
    const verdict = checkerDrawnVerdict(valid({ color: "" }));
    expect(verdict.drawn).toBe(false);
    expect(verdict.reason).toContain("data-color");
  });

  it("rejects an absent data-loc", () => {
    const verdict = checkerDrawnVerdict(valid({ loc: "" }));
    expect(verdict.drawn).toBe(false);
    expect(verdict.reason).toContain("data-loc");
  });

  it("rejects a side the board does not have", () => {
    expect(checkerDrawnVerdict(valid({ color: "red" })).drawn).toBe(false);
  });

  it("rejects a location that is not a point, the bar or the tray", () => {
    expect(checkerDrawnVerdict(valid({ loc: "middle" })).drawn).toBe(false);
  });

  it("rejects a checker parked off-canvas", () => {
    const offLeft = checkerDrawnVerdict(valid({ left: -9999, right: -9969 }));
    expect(offLeft.drawn).toBe(false);
    expect(offLeft.reason).toContain("off-canvas");
    expect(checkerDrawnVerdict(valid({ left: 0, right: 0 })).drawn).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. COUNTING — what the "30 checkers drawn" gate actually asks
// ─────────────────────────────────────────────────────────────────────────────

describe("countDrawnCheckers — the board's drawn population", () => {
  it("counts the drawn and reports one reason per rejected checker", () => {
    const tally = countDrawnCheckers([
      valid({ loc: "13" }),
      valid({ loc: "bar", color: "black" }),
      valid({ loc: "6", display: "none" }),
    ]);
    expect(tally.count).toBe(2);
    expect(tally.rejected).toEqual(["data-loc 6 white checker is display:none"]);
  });

  it("counts nothing on a board that only tags its checkers", () => {
    expect(countDrawnCheckers([])).toEqual({ count: 0, rejected: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE LAYER MAP — this gate belongs to layer 2, and says so once
// ─────────────────────────────────────────────────────────────────────────────

describe("layers.json — the checker gates are layer 2", () => {
  it("classifies the render and testid checker gates as layer 2", () => {
    const map = JSON.parse(fs.readFileSync(path.join(GRADER, "layers.json"), "utf8"));
    expect(map.checks["REQ-RENDER/checker"]).toBe(2);
    expect(map.checks["REQ-TESTID/checker"]).toBe(2);
  });
});
