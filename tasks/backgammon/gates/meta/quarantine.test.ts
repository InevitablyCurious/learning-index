// The flaky-test canon, enforced rather than documented.
//
//   "If a test is ever determined to be flaky, it is excluded from the grading
//    suite. Period."  — 2026-09-11
//
// The reason it is absolute: a gate that flips on byte-identical code moves
// `resolved_count`, which is the convergence signal `06` reads as DIFFICULTY.
// So its noise does not stay local — it manufactures and erases the very
// repair curves the benchmark exists to measure, and nothing downstream can
// tell that movement from a real one.
//
// These tests make the exclusion structural. Documentation alone would let a
// quarantined gate drift back into the roster the first time somebody moved a
// file or widened a glob.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATES = path.resolve(HERE, "..");
const QUARANTINE = path.join(GATES, "quarantine");

function quarantinedFiles() {
  if (!fs.existsSync(QUARANTINE)) return [];
  return fs.readdirSync(QUARANTINE).filter((f) => f.endsWith(".test.ts"));
}

describe("a quarantined test cannot vote", () => {
  it("the graded vitest config cannot reach quarantine/", () => {
    const cfg = fs.readFileSync(path.join(GATES, "vitest.config.ts"), "utf-8");
    const include = /include:\s*\[([^\]]*)\]/.exec(cfg);
    expect(include, "vitest.config.ts no longer declares an include list").toBeTruthy();
    // Scoped to backend/**, so a quarantine directory is unreachable by
    // construction rather than by an exclusion somebody could delete.
    expect(include![1]).toMatch(/backend/);
    expect(include![1]).not.toMatch(/quarantine/);
  });

  it("the grader walks only backend/, so it cannot pick one up", () => {
    const report = fs.readFileSync(path.join(GATES, "report.mjs"), "utf-8");
    const walk = /function backendTestFiles\(\)[\s\S]*?\n}/.exec(report);
    expect(walk).toBeTruthy();
    expect(walk![0]).toMatch(/path\.join\(GATES_DIR, "backend"\)/);
    expect(walk![0]).not.toMatch(/quarantine/);
  });

  it("no quarantined gate token survives in the graded suite", () => {
    // The failure this catches: extracting a gate but leaving its old copy, so
    // the flaky assertion is still running under the same token.
    for (const file of quarantinedFiles()) {
      const src = fs.readFileSync(path.join(QUARANTINE, file), "utf-8");
      for (const token of new Set([...src.matchAll(/\[([A-Z]+\d+)\]/g)].map((m) => m[1]))) {
        for (const dir of ["backend", "frontend", "conformance"]) {
          const root = path.join(GATES, dir);
          if (!fs.existsSync(root)) continue;
          const walk = (d: string): string[] =>
            fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
              e.isDirectory()
                ? walk(path.join(d, e.name))
                : e.name.endsWith(".ts")
                  ? [path.join(d, e.name)]
                  : [],
            );
          for (const f of walk(root)) {
            const body = fs.readFileSync(f, "utf-8");
            const live = body
              .split("\n")
              .filter((l) => l.includes(`[${token}]`) && !l.trimStart().startsWith("//"));
            expect(
              live,
              `${token} is quarantined but still declared in ${path.relative(GATES, f)}`,
            ).toEqual([]);
          }
        }
      }
    }
  });

  it("no quarantined gate keeps a feedback line", () => {
    // `feedback.json`'s own guard requires every key to address a real gate. A
    // line for a gate nobody can fail is dead weight that would fail that
    // guard — the line lives in the quarantined file's header instead, so
    // re-admitting the gate restores both halves together.
    const feedback = JSON.parse(fs.readFileSync(path.join(GATES, "feedback.json"), "utf-8"));
    for (const file of quarantinedFiles()) {
      const src = fs.readFileSync(path.join(QUARANTINE, file), "utf-8");
      for (const token of new Set([...src.matchAll(/\[([A-Z]+\d+)\]/g)].map((m) => m[1]))) {
        expect(
          Object.keys(feedback.gates ?? {}),
          `${token} is quarantined but still has a feedback override`,
        ).not.toContain(token);
      }
    }
  });

  it("every quarantined test states its evidence and what is now unmeasured", () => {
    // Quarantining hides a requirement. That is acceptable ONLY if the gap is
    // written down where the next person will find it — an honest gap beats a
    // dishonest measurement, but only if it is legible as a gap.
    for (const file of quarantinedFiles()) {
      const src = fs.readFileSync(path.join(QUARANTINE, file), "utf-8");
      expect(src, `${file} must say it is not graded`).toMatch(/NOT A GRADED GATE/);
      expect(src, `${file} must carry the evidence of flakiness`).toMatch(/Evidence/i);
      expect(src, `${file} must say what is now unmeasured`).toMatch(/UNMEASURED/i);
      expect(src, `${file} must say what re-admitting it requires`).toMatch(/COMES BACK/i);
    }
  });

  it("the canon itself is written down next to the tests it governs", () => {
    const readme = fs.readFileSync(path.join(QUARANTINE, "README.md"), "utf-8");
    // Whitespace-tolerant: the phrase wraps in prose, and reflowing a document
    // to satisfy a regex is the regex being wrong.
    expect(readme.replace(/\s+/g, " ")).toMatch(/excluded from the grading suite/i);
    expect(readme).toMatch(/resolved_count/);
  });
});
