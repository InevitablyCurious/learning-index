// A gate in a file that timed out carries a stated cause; one that is merely
// absent does not (every skipped test is absent too).
import { describe, expect, it } from "vitest";
import { foldGateResults } from "../gate-results.mjs";

const roster = {
  available: true,
  fingerprint: "x",
  gates: [
    { id: "A", phase: "backend", file: "backend/hung.test.ts" },
    { id: "B", phase: "backend", file: "backend/fine.test.ts" },
  ],
};

describe("foldGateResults not_run causes", () => {
  it("states timed_out for the gates of a timed-out file, and only those", () => {
    const out = foldGateResults({
      roster,
      matcher: { unmatched: [] },
      observed: [],
      phaseRan: { backend: true },
      timedOutFiles: new Set(["backend/hung.test.ts"]),
    });
    const a = out.gate_results.find((g: any) => g.id === "A");
    const b = out.gate_results.find((g: any) => g.id === "B");
    expect(a.not_run_cause).toBe("timed_out");
    expect("not_run_cause" in b).toBe(false);
  });

  it("states nothing when no file timed out", () => {
    const out = foldGateResults({ roster, matcher: { unmatched: [] }, observed: [], phaseRan: { backend: true } });
    expect(out.gate_results.every((g: any) => !("not_run_cause" in g))).toBe(true);
  });
});
