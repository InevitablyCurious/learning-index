import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stallObserved, stallCheckFor, STALL_AREAS } from "../lib/stall.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// A BUDGET THE SIZE OF THE WORK, AND A REPORT THAT SAYS HOW LONG IT WAITED.
//
// One flat 900s for every gate file is the right ceiling and the wrong budget:
// `backend/gates-01-08.test.ts` runs in ~3ms against the golden, so a candidate
// whose engine never returns held the suite for fifteen minutes before anyone
// said so. Measured on a real cell — `for (let from = 1; from <= 24; from--)`
// in the candidate's `singleMoves`, counting down from 1 forever.
//
// These tests do not re-derive the formula (that would only restate the code).
// They pin the two properties that matter: a fast file gets a budget nowhere
// near the flat ceiling, and the heavy file keeps enough room for a slow but
// CORRECT candidate.
// ─────────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GRADER = path.resolve(HERE, "..");

const timings = JSON.parse(
  fs.readFileSync(path.join(GRADER, "golden-timings.json"), "utf8"),
).files as Record<string, number>;

// Mirrors report.mjs. Importing it would execute main() and grade the golden.
const STARTUP_MS = 60_000;
const MULTIPLIER = 1000;
const FLAT_MS = 900_000;
const budget = (goldenMs: number) =>
  Math.min(FLAT_MS, Math.round(STARTUP_MS + goldenMs * MULTIPLIER));

describe("the per-file budget is scaled to the reference time", () => {
  it("has a reference time for every backend gate file", () => {
    const onDisk: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".test.ts")) onDisk.push(path.relative(GRADER, full));
      }
    };
    walk(path.join(GRADER, "backend"));
    // A file with no reference time still runs — it falls back to the flat
    // timeout — so this is a prompt to re-measure, not a correctness gate.
    expect(Object.keys(timings).sort()).toEqual(onDisk.sort());
  });

  it("gives a millisecond-scale file a budget far below the flat ceiling", () => {
    const fast = timings["backend/gates-01-08.test.ts"];
    expect(fast).toBeLessThan(50);
    // The whole point: a non-terminating candidate is caught in about a
    // minute rather than fifteen.
    expect(budget(fast)).toBeLessThan(120_000);
  });

  it("still allows a slow but correct candidate orders of magnitude of room", () => {
    // The worst measured legitimate slowdowns are in the tens: gates-13-16
    // went 1.63s -> 74.9s on the 2026-08-17 minimax-m3 cell, and G14's two
    // gates took 87s and 151s on another candidate.
    const heavy = timings["backend/gates-13-16.test.ts"];
    expect(budget(heavy)).toBeGreaterThan(300_000);
    for (const [file, goldenMs] of Object.entries(timings)) {
      expect(budget(goldenMs) / Math.max(goldenMs, 1)).toBeGreaterThan(1000);
      expect(budget(goldenMs), `${file} exceeds the flat ceiling`).toBeLessThanOrEqual(FLAT_MS);
    }
  });
});

describe("the stall finding names the wait", () => {
  it("writes the seconds in the shape the harness reads back", () => {
    // The harness substitutes this number into the `{seconds}` placeholder in
    // the hand-written symptom line. Its matcher is /(\d+)\s*s\b/.
    expect(stallObserved(63_000)).toBe("no response after 63s");
    expect(stallObserved(63_000)).toMatch(/(\d+)\s*s\b/);
  });

  it("never reports a zero wait", () => {
    // "It hung for 0 seconds" is a false report; a sub-second kill still
    // means the tester saw nothing come back.
    expect(stallObserved(0)).toBe("no response after 1s");
    expect(stallObserved(undefined)).toBe("no response after 1s");
  });

  it("rounds to whole seconds, because a person would", () => {
    expect(stallObserved(62_400)).toBe("no response after 62s");
    expect(stallObserved(62_600)).toBe("no response after 63s");
  });

  it("routes each runner to a situation a tester could have been in", () => {
    expect(stallCheckFor("backend backend/gates-01-08.test.ts")).toBe("REQ-RESPONSIVE/moving");
    expect(stallCheckFor("backend backend/edge/edge-gates.test.ts")).toBe(
      "REQ-RESPONSIVE/awkwardroll",
    );
    expect(stallCheckFor("conformance")).toBe("REQ-RESPONSIVE/startup");
    // Every area it can name must be one the feedback files cover.
    for (const area of STALL_AREAS) {
      expect(fs.existsSync(
        path.join(GRADER, "..", "task/backgammon/prompts/failures", `REQ-RESPONSIVE-${area}.md`),
      )).toBe(true);
    }
  });
});
