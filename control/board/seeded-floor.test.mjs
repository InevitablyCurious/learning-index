// ─────────────────────────────────────────────────────────────────────────────
// A SEEDED CELL IS NEVER THE TRANSFER CURVE'S FLOOR
//
// THE SAFETY PROPERTY, from dev-benchmark-snapshot.md §5:
//
//   > A seeded cell folds `scorable: false`, with a stated reason.
//
// It is the whole dummy-proofing of the snapshot feature. A seeded cell skips
// the build, so its turns, tokens and wall time sit on a scale no unseeded cell
// shares; a delta measured against it measures the absence of a build, not the
// presence of memory.
//
// ── WHY THIS FILE EXISTS SEPARATELY FROM control/baselines.mjs' TESTS ───────
//
// `control/baselines.mjs:445` has enforced this since WO-SNAP-03. THIS surface
// did not. `sources/stack-ledger.mjs` folds the status record INDEPENDENTLY for
// the transfer curve, and had zero references to seeding anywhere — a seeded OFF
// cell is `complete` and non-void, so it passed the floor filter and would have
// been drawn as the baseline every ON run is measured against, while the ledger
// beside it refused the very same cell.
//
// It was recorded as OPEN item (a) in dev-benchmark-snapshot-progress.md and was
// only ever theoretical because seeding was CLI-only. Putting a snapshot picker
// on the board makes it one click away, so it is closed here — before the
// picker, not after it.
//
// Two surfaces disagreeing about whether a cell is a measurement is worse than
// either being wrong alone: the viewer cannot tell which half to believe.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";

import { stackState } from "./sources/stack-ledger.mjs";

const floor = (over = {}) => ({
  arm: "off",
  state: "complete",
  turns: 300,
  void_instrument: false,
  seeded_from_snapshot: null,
  ...over,
});

test("a seeded baseline is refused as a floor, and says so in its own state", () => {
  const s = stackState(floor({ seeded_from_snapshot: "1788591737915" }), []);
  assert.equal(s, "baseline_seeded");
});

test("SEEDED IS NOT VOID — they are opposite claims about the cell", () => {
  // A void baseline is an instrument failure and the operator should re-run it.
  // A seeded baseline ran perfectly and is simply not a floor. Collapsing them
  // would have the board telling an operator to re-run a deliberate dev-mode
  // seed as though something had broken.
  assert.equal(stackState(floor({ void_instrument: true }), []), "baseline_void");
  assert.notEqual(
    stackState(floor({ seeded_from_snapshot: "abc" }), []),
    stackState(floor({ void_instrument: true }), []),
  );
});

test("a cell that is BOTH seeded and void reports void", () => {
  // Void is checked first here, matching the order the curve already used. The
  // ordering is arbitrary between two disqualifications but must be STATED —
  // what matters is that neither can produce a scorable floor.
  const s = stackState(floor({ void_instrument: true, seeded_from_snapshot: "abc" }), []);
  assert.equal(s, "baseline_void");
});

test("an unseeded baseline is unaffected", () => {
  // The guard must not cost a healthy floor. `null` and absent both mean
  // unseeded — a record written before the field existed has no opinion.
  assert.equal(stackState(floor(), [{ arm: "on", turns: 200, void_instrument: false }]), "n1_on");
  const noField = { arm: "off", state: "complete", turns: 300, void_instrument: false };
  assert.equal(stackState(noField, []), "baseline_only");
});

test("seeded is decided before pending, so a seeded cell never reads as unreported", () => {
  // `turns === null` is true of a cell that has not reported yet. A seeded cell
  // still in flight must report as seeded rather than as pending, or the
  // operator is told to wait for a floor that will never be one.
  assert.equal(
    stackState(floor({ seeded_from_snapshot: "abc", turns: null }), []),
    "baseline_seeded",
  );
});
