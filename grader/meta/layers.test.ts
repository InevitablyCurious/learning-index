// LAYERED GRADING: the selector, the scoped verdict, and the map's completeness.
//
// Three rules, each one the difference between a partial pass and a lie:
//
//   1. `--layer N` grades layers 1..N and NOT the rest — the denominator is the
//      scope, not the whole suite.
//   2. A gate above the requested layer is `not_run` with cause `not_graded`,
//      never `fail` (it did not fail) and never absent (absence reads as pass).
//      It also cannot reach the verdict: a later layer's failure must not fail
//      an earlier layer's pass.
//   3. The layer map is complete. Every enumerated gate resolves through
//      `layers.json` or `roster.mjs` throws at enumeration — so an unmapped gate
//      cannot quietly become unclassified.
//
// The first two run on hand-built fixtures (pure functions, no runner, no
// target, no server). Only the completeness test spawns anything, because a
// completeness claim that does not enumerate is not a claim about the suite.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { foldGateResults, layerVerdict, selectedGateResults } from "../gate-results.mjs";
import { enumerateGates, stampLayers } from "../roster.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GRADER = path.resolve(HERE, "..");

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE SELECTOR
// ─────────────────────────────────────────────────────────────────────────────

describe("selectedGateResults — the layer selector", () => {
  const gates = [
    { id: "A", phase: "frontend", layer: 1 },
    { id: "B", phase: "frontend", layer: 2 },
    { id: "C", phase: "backend", layer: 3 },
    { id: "D", phase: "conformance", layer: 1 },
  ];
  const idsOf = (rows: any[]) => rows.map((g: any) => g.id).sort();
  const ALL = ["A", "B", "C", "D"];

  it("layer 1 selects layer 1 and nothing else", () => {
    const sel = selectedGateResults(gates, 1);
    expect(idsOf(sel)).toEqual(["A", "D"]);
    expect(idsOf(sel)).not.toContain("B");
    expect(idsOf(sel)).not.toContain("C");
  });

  it("layer 2 accumulates: layers 1..2, never layer 3", () => {
    const sel = selectedGateResults(gates, 2);
    expect(idsOf(sel)).toEqual(["A", "B", "D"]);
    expect(idsOf(sel)).not.toContain("C");
  });

  it("layer 3 is the whole suite", () => {
    const sel = selectedGateResults(gates, 3);
    expect(idsOf(sel)).toEqual(ALL);
    expect(sel.length).toBe(gates.length);
  });

  it("no layer requested keeps the full denominator, untouched", () => {
    const sel = selectedGateResults(gates, null);
    expect(idsOf(sel)).toEqual(ALL);
    // The default path is the SAME set the full run always used — not a filtered
    // copy that could drift from it.
    expect(sel).toBe(gates);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE SCOPED VERDICT
// ─────────────────────────────────────────────────────────────────────────────

const roster = {
  available: true,
  fingerprint: "x",
  gates: [
    {
      id: "F01",
      phase: "frontend",
      file: "frontend/a.spec.ts",
      layer: 1,
      full_name: "frontend > a > boots",
      test_name: "boots",
    },
    {
      id: "F02",
      phase: "frontend",
      file: "frontend/b.spec.ts",
      layer: 2,
      full_name: "frontend > b > rolls",
      test_name: "rolls",
    },
    {
      id: "E01",
      phase: "backend",
      file: "backend/c.test.ts",
      layer: 3,
      full_name: "backend > c > state",
      test_name: "state",
    },
  ],
};

const matcher = { unmatched: [] };
const phaseRan = { frontend: true, backend: true };
const row = (out: any, id: string) => out.gate_results.find((g: any) => g.id === id);

describe("layerVerdict + foldGateResults scoping — the scoped verdict", () => {
  it("folds an out-of-scope gate as not_graded, never as fail", () => {
    // E01 genuinely FAILED in this pass (a hit is left behind); the pass was
    // scoped to layers 1..2, so that failure is out of scope and must be stated
    // as not graded rather than inheriting a status this pass did not ask for.
    const out = foldGateResults({
      roster,
      matcher,
      observed: [{ id: "E01", status: "fail", phase: "backend", duration_ms: 10 }],
      phaseRan,
      timedOutFiles: null,
      layer: 2,
    });
    const e01 = row(out, "E01");
    expect(e01.status).toBe("not_run");
    expect(e01.not_run_cause).toBe("not_graded");
    expect(out.gate_results.some((g: any) => g.id === "E01" && g.status === "fail")).toBe(false);
    expect(out.gate_totals.fail).toBe(0);
    expect(out.gate_totals.not_run).toBe(3);

    // In scope and merely absent: not_run for a different reason, and NOT
    // labelled not_graded (it was graded; there was no result).
    for (const id of ["F01", "F02"]) {
      const g = row(out, id);
      expect(g.status).toBe("not_run");
      expect("not_run_cause" in g).toBe(false);
    }
  });

  it("greens the requested layers even when a later layer failed", () => {
    const out = foldGateResults({
      roster,
      matcher,
      observed: [
        { id: "F01", status: "pass", phase: "frontend", duration_ms: 5 },
        { id: "F02", status: "pass", phase: "frontend", duration_ms: 6 },
        { id: "E01", status: "fail", phase: "backend", duration_ms: 10 },
      ],
      phaseRan,
      timedOutFiles: null,
      layer: 2,
    });

    // The layer-2 denominator is exactly the graded layers.
    expect(out.gate_results
      .filter((g: any) => g.layer <= 2)
      .map((g: any) => g.id)
      .sort()).toEqual(["F01", "F02"]);
    expect(out.gate_totals.pass).toBe(2);
    expect(out.gate_totals.fail).toBe(0);

    expect(layerVerdict(out.gate_results, 2)).toBe(true);
    // Widening the scope to layer 3 exposes the failure the narrow pass did not
    // grade — the same rows, a different question.
    expect(layerVerdict(out.gate_results, 3)).toBe(false);
  });

  it("keeps the no-layer default exactly as it was: the failure is a failure", () => {
    const out = foldGateResults({
      roster,
      matcher,
      observed: [{ id: "E01", status: "fail", phase: "backend", duration_ms: 10 }],
      phaseRan,
      timedOutFiles: null,
    });
    const e01 = row(out, "E01");
    expect(e01.status).toBe("fail");
    expect("not_run_cause" in e01).toBe(false);
    expect(out.gate_totals.fail).toBe(1);
    expect(out.gate_totals.not_run).toBe(2);
    expect(layerVerdict(out.gate_results, null)).toBe(false);
  });

  it("stamps a numeric layer on every folded row, scoped or not", () => {
    const observed = [{ id: "E01", status: "fail", phase: "backend", duration_ms: 10 }];
    for (const layer of [1, 2, 3, null]) {
      const out = foldGateResults({
        roster,
        matcher,
        observed,
        phaseRan,
        timedOutFiles: null,
        layer,
      });
      for (const g of out.gate_results) {
        expect(typeof g.layer, `${g.id} layer with --layer ${layer}`).toBe("number");
        expect(Number.isInteger(g.layer)).toBe(true);
        expect(g.layer).toBeGreaterThanOrEqual(1);
        expect(g.layer).toBeLessThanOrEqual(3);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE MAP IS COMPLETE
//
// Two directions, both required. A gate missing from the map is an unmapped
// gate (roster.mjs throws on it). A map key naming nothing is an orphan: dead
// authority over a check that no longer exists, which stays green forever
// because nothing consults it.
// ─────────────────────────────────────────────────────────────────────────────

const layers = JSON.parse(fs.readFileSync(path.join(GRADER, "layers.json"), "utf8"));
const checks = JSON.parse(fs.readFileSync(path.join(GRADER, "checks.json"), "utf8"));

/** The map holds either the integer, or the integer alongside its reasoning. */
const layerOf = (key: string): unknown => {
  const entry = layers.checks[key];
  return entry !== null && typeof entry === "object" ? entry.layer : entry;
};

const CODE_PHASES = ["frontend", "backend"];

describe("layer map completeness — every enumerable gate is layered exactly once", () => {
  it("enumerates the whole suite with a layer on every gate", () => {
    let enumerated: any;
    // The completeness gate IS this call: stampLayers throws when any enumerated
    // gate has no layer, so a hole fails here rather than shipping unclassified.
    expect(() => {
      enumerated = enumerateGates();
    }).not.toThrow();

    const { gates, complete } = enumerated;
    expect(complete).toBe(true);
    expect(gates.length).toBeGreaterThanOrEqual(200);

    const ids = new Set(gates.map((g: any) => g.id));
    expect(ids.size).toBe(gates.length);

    for (const g of gates) {
      expect(typeof g.layer, `layer for gate ${g.id}`).toBe("number");
      expect(Number.isInteger(g.layer), `integer layer for gate ${g.id}`).toBe(true);
      expect(g.layer, `layer range for gate ${g.id}`).toBeGreaterThanOrEqual(1);
      expect(g.layer, `layer range for gate ${g.id}`).toBeLessThanOrEqual(3);
    }

    // The map is the ONLY authority on a gate's layer: a code gate stamped from
    // its token must carry exactly the layer the map states for that token.
    // (Conformance gates resolve through a setup title pattern instead, so they
    // are not checked against their token here — stampLayers decides those.)
    let checked = 0;
    for (const g of gates) {
      if (!CODE_PHASES.includes(g.phase)) continue;
      if (!(g.gate_token in layers.checks)) continue;
      checked += 1;
      expect(g.layer, `map layer for ${g.id} (${g.gate_token})`).toBe(layerOf(g.gate_token));
    }
    expect(checked).toBeGreaterThan(0);
  }, 120_000);

  it("refuses an unmapped gate instead of publishing it unclassified", () => {
    // The completeness gate above passes by NOT throwing, so prove the throw is
    // real: without it that assertion would be vacuous and a hole would ship.
    const unmapped = [{ id: "NO-SUCH-CHECK", phase: "backend", gate_token: "NO-SUCH-CHECK" }];
    expect(() => stampLayers(unmapped)).toThrow(/layer map incomplete/);
    expect("layer" in unmapped[0]).toBe(false);
  });

  it("holds exactly the checks.json check and setup keys — no orphan, no hole", () => {
    const mapKeys = new Set(Object.keys(layers.checks));
    const union = new Set([
      ...Object.keys(checks.checks),
      ...checks.setup.map((s: any) => s.key),
    ]);

    // No map key naming nothing.
    expect([...mapKeys].filter((k) => !union.has(k))).toEqual([]);
    // No check or setup entry left without a layer.
    expect([...union].filter((k) => !mapKeys.has(k))).toEqual([]);
    expect(mapKeys.size).toBe(union.size);

    for (const key of union) {
      const layer = layerOf(key);
      expect(Number.isInteger(layer), `layer for map key ${key}`).toBe(true);
      expect(layer, `layer range for map key ${key}`).toBeGreaterThanOrEqual(1);
      expect(layer, `layer range for map key ${key}`).toBeLessThanOrEqual(3);
    }
  });
});
