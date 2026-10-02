// ─────────────────────────────────────────────────────────────────────────────
// LEARNING SOURCE — the pure folds behind the matrix + master validation
//
//     cd bench/dashboard && node --test learning.test.mjs
//
// Zero dependencies, stock `node --test`. These pin the pure functions the
// source builds on; the file walk and the JSON-lines reads are exercised
// against the live bench, not a fixture, because the shapes are verified on
// disk elsewhere.
//
// ── WHAT THIS PINS ──────────────────────────────────────────────────────────
//
//  1. THE MATRIX DENOMINATOR IS THE ENUMERATED ROSTER, or null. No roster →
//     no denominator; a fabricated count is the exact dishonesty the board
//     exists to prevent.
//  2. PASS AND FAIL BOTH LAND IN THE MATRIX. Unlike the status stream (which
//     carries failures only), the learning matrix draws a gate that passed.
//  3. THE ATTEMPT AXIS IS FIVE (1 build + 4 repair), never ten — the design
//     comp's 10-attempt grid was reconciled to the harness's max_attempts.
//  4. A NULL CELL IS "not yet run", DISTINCT from a measured fail — three kinds
//     of nothing stay separate (contract rule 1).
//  5. validateMaster mirrors the plugin's three checks: duplicate slugs,
//     unresolved parents, cycles. It flags a disagreement, never smothers it.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMatrix,
  validateMaster,
  normalizeLabel,
  CAPTURE_STATES,
  PHASES_PER_CELL,
} from "./sources/learning.mjs";
import { MAX_ATTEMPTS, emptyBoard } from "./contract.mjs";

test("the attempt axis is five: 1 build + 4 repair", () => {
  assert.equal(PHASES_PER_CELL, 5);
});

test("the board frame carries max_attempts for the screenshot tabs", () => {
  assert.equal(MAX_ATTEMPTS, 5);
  assert.equal(emptyBoard().max_attempts, 5);
});

test("the four capture states are the design's four", () => {
  assert.deepEqual(CAPTURE_STATES, ["unwired", "unobserved", "captured", "anomaly"]);
});

test("normalizeLabel slugs labels like the plugin", () => {
  assert.equal(normalizeLabel("Bearing Off"), "bearing_off");
  assert.equal(normalizeLabel("  bear-off  logic "), "bearoff_logic");
  // near-duplicates slug differently — the split is by design, not a defect
  assert.notEqual(normalizeLabel("bearing off"), normalizeLabel("bear-off logic"));
});

test("buildMatrix joins roster rows with per-attempt outcomes, pass AND fail", () => {
  const roster = {
    total: 3,
    enumeration: { complete: true },
    gates: [
      { id: "CONF", phase: "conformance", title: "state carries points" },
      { id: "G01", phase: "backend", title: "legal-move generation" },
      { id: "G02", phase: "backend", title: "bar re-entry" },
    ],
  };
  const outcomes = [
    { gate_id: "CONF", attempt: 1, predicate_outcome: "fail" },
    { gate_id: "CONF", attempt: 2, predicate_outcome: "pass" },
    { gate_id: "G01", attempt: 1, predicate_outcome: "pass" },
    { gate_id: "G02", attempt: 1, predicate_outcome: "fail" },
    { gate_id: "G02", attempt: 2, predicate_outcome: "fail" },
  ];

  const m = buildMatrix(roster, outcomes);

  assert.equal(m.total, 3);
  assert.equal(m.attempts, 5);
  assert.equal(m.by_phase.conformance, 1);
  assert.equal(m.by_phase.backend, 2);

  const conf = m.gates.find((g) => g.id === "CONF");
  assert.deepEqual(conf.outcomes, ["fail", "pass", null, null, null]);

  const g01 = m.gates.find((g) => g.id === "G01");
  assert.deepEqual(g01.outcomes, ["pass", null, null, null, null]);

  assert.equal(m.counts.outcomes_read, 5);
  assert.equal(m.counts.passing_total, 2);
});

test("no roster → no denominator, but the matrix still builds from outcomes", () => {
  const m = buildMatrix(null, [
    { gate_id: "G01", attempt: 1, predicate_outcome: "fail" },
  ]);
  assert.equal(m.total, null);
  assert.equal(m.gates.length, 1);
  assert.deepEqual(m.gates[0].outcomes, ["fail", null, null, null, null]);
});

test("a missing outcome is null — 'not yet run', never a fabricated fail", () => {
  const m = buildMatrix(
    { total: 1, gates: [{ id: "G01", phase: "backend", title: "x" }] },
    [],
  );
  assert.deepEqual(m.gates[0].outcomes, [null, null, null, null, null]);
  assert.equal(m.counts.outcomes_read, 0);
});

test("validateMaster passes a clean master and flags all three defect classes", () => {
  const clean = {
    session_goal: { traj_label: "traj0" },
    trajectories: [
      { traj_label: "server_setup", parent_traj_label: "traj0", knowledge: [] },
      { traj_label: "moves", parent_traj_label: "server_setup", knowledge: [] },
    ],
  };
  assert.deepEqual(validateMaster(clean), { valid: true, errors: [] });

  const dup = {
    session_goal: { traj_label: "traj0" },
    trajectories: [
      { traj_label: "server setup", knowledge: [] },
      { traj_label: "server_setup", knowledge: [] },
    ],
  };
  assert.equal(validateMaster(dup).valid, false);
  assert.ok(validateMaster(dup).errors.some((e) => e.includes("duplicate")));

  const unresolved = {
    session_goal: { traj_label: "traj0" },
    trajectories: [{ traj_label: "a", parent_traj_label: "never_emitted", knowledge: [] }],
  };
  assert.ok(validateMaster(unresolved).errors.some((e) => e.includes("unresolved")));

  const cycle = {
    session_goal: { traj_label: "traj0" },
    trajectories: [
      { traj_label: "a", parent_traj_label: "b", knowledge: [] },
      { traj_label: "b", parent_traj_label: "a", knowledge: [] },
    ],
  };
  assert.ok(validateMaster(cycle).errors.some((e) => e.includes("cycle")));
});

test("a master with no session_goal is invalid", () => {
  assert.equal(validateMaster({ trajectories: [] }).valid, false);
});
