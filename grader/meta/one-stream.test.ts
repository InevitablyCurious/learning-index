import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// A GRADING RUN WRITES ONE STREAM.
//
// The harness reads the grading container's stdout and stderr through one pipe
// (harness/adapters/challenge/grading.py), and the docker CLI copies each
// stream in its own chunks. A line written to the other stream lands at an
// arbitrary byte of this one: mid-word in one attempt, inside an em dash in the
// next — invalid UTF-8, and the cell died on it (run 1790355908, attempt 2).
// Only the `--resources` preflight, which reports and exits before any grading,
// writes to stdout.
// ─────────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT = fs.readFileSync(path.resolve(HERE, "..", "report.mjs"), "utf8");

describe("the grading run writes one stream", () => {
  it("report.mjs writes to stdout only inside the --resources preflight", () => {
    const start = REPORT.indexOf('if (process.argv.includes("--resources"))');
    const end = REPORT.indexOf("process.exit(0);", start);
    expect(start, "the --resources preflight block").toBeGreaterThan(-1);
    expect(end, "the --resources preflight exit").toBeGreaterThan(start);
    const outside = [...REPORT.matchAll(/process\.stdout/g)]
      .map((m) => m.index ?? -1)
      .filter((i) => i < start || i > end)
      .map((i) => REPORT.slice(0, i).split("\n").length);
    expect(outside, "report.mjs lines writing to stdout during a grading run").toEqual([]);
  });
});
