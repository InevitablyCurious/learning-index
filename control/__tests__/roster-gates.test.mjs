// Extracted verbatim from control/control.test.mjs — WO-LI18 split A.
import { test } from "node:test";
import assert from "node:assert/strict";

import { assignIds, parsePlaywrightList, parseVitestList, suiteFingerprint, tierOf } from "../../grader/roster.mjs";
import { foldGateResults, normalizeStatus } from "../../grader/gate-results.mjs";

test("ROSTER: a colliding token falls back to a slug instead of merging gates", () => {
  // [G10] covers five separate tests in the real suite. Using the bare token as
  // an id would silently merge them into one square and drop four gates from
  // the denominator.
  const gates = assignIds([
    { gate_token: "G01", phase: "backend", file: "backend/a.test.ts", full_name: "s > [G01] one" },
    { gate_token: "G10", phase: "backend", file: "backend/b.test.ts", full_name: "s > [G10] first" },
    { gate_token: "G10", phase: "backend", file: "backend/b.test.ts", full_name: "s > [G10] second" },
  ]);
  assert.equal(gates[0].id, "G01", "a token identifying exactly one test IS the id");
  assert.notEqual(gates[1].id, "G10");
  assert.notEqual(gates[1].id, gates[2].id, "colliding tokens must not produce colliding ids");
  assert.equal(gates[1].gate_token, "G10", "the token survives for grouping");
});

test("ROSTER: the fingerprint changes when the suite changes, not when it is reordered", () => {
  // The fingerprint's whole job is detecting that the suite changed mid-campaign
  // — which invalidates cross-cell gate comparison. A reorder is not a change.
  const a = [{ id: "G01" }, { id: "G02" }];
  const b = [{ id: "G02" }, { id: "G01" }];
  const c = [{ id: "G01" }, { id: "G03" }];
  assert.equal(suiteFingerprint(a), suiteFingerprint(b), "order must not affect the fingerprint");
  assert.notEqual(suiteFingerprint(a), suiteFingerprint(c));
});

test("ROSTER: the list parsers read what the runners actually print", () => {
  const vit = parseVitestList(
    "backend/gates-01-08.test.ts > Backgammon backend gates 01-08 > [G01] REQ-INIT — initial position\n" +
      "not a test line\n",
  );
  assert.equal(vit.length, 1);
  assert.equal(vit[0].file, "backend/gates-01-08.test.ts");
  assert.deepEqual(vit[0].chain, ["Backgammon backend gates 01-08", "[G01] REQ-INIT — initial position"]);

  const pw = parsePlaywrightList(
    "Listing tests:\n" +
      "  [chromium] › core.spec.ts:108:1 › [F01] REQ-RENDER — page loads\n" +
      "Total: 1 test in 1 file\n",
  );
  assert.equal(pw.length, 1, "the banner and the total are not tests");
  assert.equal(pw[0].file, "core.spec.ts");
  assert.equal(pw[0].line, 108);
  assert.deepEqual(pw[0].chain, ["[F01] REQ-RENDER — page loads"]);
});

test("GATE RESULTS: every roster gate appears exactly once, not_run included", () => {
  // INVARIANT I-4 stated as a shape: the output array is the roster, always.
  const roster = {
    available: true,
    fingerprint: "sha256:x",
    gates: [
      { id: "G01", phase: "backend", file: "a.test.ts", full_name: "one", test_name: "one" },
      { id: "G02", phase: "backend", file: "a.test.ts", full_name: "two", test_name: "two" },
    ],
    byKey: new Map(),
  };
  const matcher = { unmatched: [] };
  const folded = foldGateResults({
    roster,
    matcher,
    observed: [{ id: "G01", status: "pass", phase: "backend", duration_ms: 3 }],
    phaseRan: { backend: true },
  });
  assert.equal(folded.gate_results.length, 2);
  const g2 = folded.gate_results.find((r) => r.id === "G02");
  assert.equal(g2.status, "not_run");
  assert.match(g2.reason, /produced no result/);
  assert.deepEqual(folded.gate_totals, { total: 2, pass: 1, fail: 0, not_run: 1, error: 0 });
});

test("GATE RESULTS: with no roster, the denominator is null — never zero", () => {
  // INVARIANT I-2. Zero reads as "nothing was missed"; null reads as "unknown".
  // Only one of those is true when the suite is unknown.
  const folded = foldGateResults({
    roster: { available: false, reason: "no --roster supplied", gates: [], byKey: new Map() },
    matcher: { unmatched: [] },
    observed: [{ id: "G01", status: "pass" }],
    phaseRan: {},
  });
  assert.equal(folded.gate_totals.total, null);
  assert.equal(folded.gate_totals.not_run, null);
  assert.equal(folded.gate_roster.available, false);
  assert.match(folded.gate_roster.reason, /no --roster/);
});

test("GATE RESULTS: a runner's status words map onto the published vocabulary", () => {
  assert.equal(normalizeStatus("passed").status, "pass");
  assert.equal(normalizeStatus("failed").status, "fail");
  // A test that blew its own timeout DID run and did NOT satisfy the gate.
  assert.equal(normalizeStatus("timedOut").status, "fail");
  // Skipped and interrupted did NOT run — and must never read as pass.
  assert.equal(normalizeStatus("skipped").status, "not_run");
  assert.equal(normalizeStatus("interrupted").status, "not_run");
  // An unknown word is surfaced as an error, never quietly treated as a pass.
  assert.equal(normalizeStatus("wat").status, "error");
});

test("ROSTER: tiers partition the suite without shrinking it", () => {
  // A tier says what KIND of gate this is so the board can render an edge-case
  // square differently and a scorecard can quote a core-only bar. It is NOT a
  // way to make a gate optional — `total` stays the true enumerated count
  // (invariant I-1), and tiers only slice it.
  const tiers = { fallback: "core", rules: [{ tier: "edge", path_segment: "edge" }] };
  assert.equal(tierOf("backend/edge/edge-gates.test.ts", tiers), "edge");
  assert.equal(tierOf("backend/gates-01-08.test.ts", tiers), "core");
  // Substring matches must not count — only a whole path SEGMENT named `edge`.
  assert.equal(tierOf("edges.spec.ts", tiers), "core", "edges.spec.ts is a core frontend file");
  assert.equal(tierOf("backend/hedge/x.test.ts", tiers), "core");
  // No rules at all: everything is labelled, nothing is dropped.
  assert.equal(tierOf("anything.test.ts", { fallback: "core", rules: [] }), "core");
});

// ─────────────────────────────────────────────────────────────────────────────
// GRADED TEXT (WO-FEEDBACK-1)
//
// The harness renders gate results into prose and hands it to the model as a
// user turn. These pin the one property that makes the surface worth having:
// the text is carried VERBATIM. A surface that cleaned it up would answer a
// different question than the one an operator opens it to judge.
// ─────────────────────────────────────────────────────────────────────────────

