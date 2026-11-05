// ─────────────────────────────────────────────────────────────────────────────
// ARM-DELTA CELL VALIDITY — the scoring rule, and the per-cell record fold
//
// Zero dependencies. Stock `node --test`, no install, no build step:
//
//     cd Learning-Index/control && node --test
//
// WHAT THIS PINS, AND WHY IT EXISTS
//
// `cellValidity()` (contract.mjs) decides whether a cell may be scored at all.
// It used to gate a board-wide per-arm delta this module built from the status
// stream; that surface had no renderer and is gone, so the RULE is what stays —
// pinned here, in isolation, so the fabricated-lift defect cannot come back
// when a consumer of it lands:
//
//   1. A cell aborted by transport failure (VOID-INSTRUMENT, RUNBOOK rule 5.10)
//      must never be scored as a capability FAIL. The verdict is the harness's
//      own (`cost.json` `void.is_void`), never re-derived from signal fields.
//   2. A single-attempt cell cannot show resolved gates, so it scores a
//      guaranteed 0% and must be excluded rather than counted.
//
// The rest of the file drives the REAL status-stream module (readCell) over
// real records: one cell's own fold, never the newest cell's and never a sum
// across cells. The active-run ranking cases drive `_runtime.activeRun` — every
// per-cell source resolves the run through it.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cellValidity } from "./contract.mjs";
import { readCell } from "./sources/status-stream.mjs";

// ── fixture builders ─────────────────────────────────────────────────────────

/** One attempt record in the shape run_cumulative.py emits. */
function attempt({
  seq = 0,
  attempt: n = 1,
  mode = "off",
  gates = ["[G01] REQ-A — a", "[G02] REQ-B — b"],
  fullGreen = false,
  terminalReason = "gates_failed",
  lengthTruncations = 0,
  truncatedTurns = 0,
  unrecoveredAnomalyTurns = 0,
  verdict = "FAIL",
  turns = 100,
}) {
  return {
    type: "attempt",
    schema_version: 1,
    sequence_index: seq,
    attempt: n,
    memory_mode: mode,
    org_id: "okp-org-0",
    verdict,
    terminal_outcome: false,
    terminal_reason: terminalReason,
    termination_reason: terminalReason,
    provider_truncations: lengthTruncations,
    truncated_turns: truncatedTurns,
    unrecovered_anomaly_turns: unrecoveredAnomalyTurns,
    failed_gates: gates,
    progress: { turns, wall_seconds: 1000, full_green: fullGreen, failed_gates: gates },
  };
}

/** One cell's view (readCell) over the same records, in a run named "cumulative". */
async function cellFrom(records, seq) {
  const root = await mkdtemp(join(tmpdir(), "okp-dash-cell-"));
  try {
    const dir = join(root, "cumulative");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "manifest.status.jsonl"),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );
    return await readCell({
      runsRoot: root,
      benchRoot: root,
      config: {},
      cell: { run_dir: "cumulative", sequence_index: seq },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Two attempts on one cell, the second one dropping G01. */
function twoAttempts(seq, mode) {
  return [
    attempt({ seq, attempt: 1, mode, gates: ["[G01] REQ-A — a", "[G02] REQ-B — b"] }),
    attempt({ seq, attempt: 2, mode, gates: ["[G02] REQ-B — b"] }),
  ];
}

// ── cellValidity, in isolation ───────────────────────────────────────────────
//
// THE VERDICT IS READ, NEVER RE-DERIVED. The harness owns RUNBOOK 5.10 and
// stamps it into each cell's cost.json (`void: { is_void, reason }`,
// harness/cumulative/run_artifacts.py cell_void). These pin that this module
// obeys that stamp and that the status-stream fields it used to read
// (terminal_reason, provider_truncations, unrecovered_anomaly_turns, full_green)
// no longer decide anything here.

test("cellValidity: a void-instrument stamp is never scored — not a 0%", () => {
  const v = cellValidity({ void_instrument: true, attempt_count: 3 });
  assert.equal(v.scored, false);
  assert.equal(v.reason, "void_instrument");
});

test("cellValidity: the status-stream signal fields decide NOTHING", () => {
  // Every one of these used to void the cell on its own, and the copy had
  // already drifted from the owner: it missed `instrument_fault` and
  // `observation_lost_turns`. Only the harness's stamp may void a cell.
  const v = cellValidity({
    full_green: false,
    terminal_reason: "transport_incomplete",
    provider_truncations: 40,
    unrecovered_anomaly_turns: 11,
    truncated_turns: 9,
    attempt_count: 3,
  });
  assert.equal(v.scored, true, "no stamp, no void verdict");
  assert.equal(v.reason, null);
});

test("cellValidity: a RECOVERED loop-guard cell (truncated_turns > 0) SCORES", () => {
  // The 2026-09-05 fix, now the harness's to make: a looping model the harness
  // caught and recovered is a capability observation, not a broken instrument —
  // its stamp lands false. Voiding it here is what burned the 39/53 cell.
  const v = cellValidity({
    void_instrument: false,
    terminal_reason: "gates_failed",
    truncated_turns: 9,
    attempt_count: 2,
  });
  assert.equal(v.scored, true);
  assert.equal(v.reason, null);
});

test("cellValidity: a graded-fail (gates_failed) cell is a REAL capability fail and SCORES", () => {
  // A cell whose gates failed is the model failing to resolve gates, not a
  // broken instrument. The harness stamps it non-void; voiding it would hide a
  // genuine fail from the denominator.
  const v = cellValidity({
    void_instrument: false,
    full_green: false,
    terminal_reason: "gates_failed",
    attempt_count: 3,
  });
  assert.equal(v.scored, true);
  assert.equal(v.reason, null);
});

test("cellValidity: a GREEN terminal attempt scores despite earlier truncation", () => {
  // Rule 5.10: a green terminal attempt is scored regardless of truncation seen
  // on earlier attempts, so the harness never stamps such a cell void. This
  // module carries no green check of its own — the stamp already states it.
  const v = cellValidity({
    void_instrument: false,
    full_green: true,
    terminal_reason: "gates_green",
    truncated_turns: 9,
    provider_truncations: 40,
    attempt_count: 2,
  });
  assert.equal(v.scored, true);
});

test("cellValidity: a single-attempt cell is resolution_unmeasurable", () => {
  const v = cellValidity({ void_instrument: false, attempt_count: 1 });
  assert.equal(v.scored, false);
  assert.equal(v.reason, "resolution_unmeasurable");
});

test("cellValidity: a clean multi-attempt cell scores", () => {
  const v = cellValidity({ void_instrument: false, attempt_count: 2 });
  assert.equal(v.scored, true);
  assert.equal(v.reason, null);
});

// ── D4: non-attempt records must not be folded in as attempts ────────────────

test("an extraction record does not corrupt cell state", async () => {
  const res = await cellFrom(
    [
      ...twoAttempts(0, "off"),
      {
        type: "extraction",
        sequence_index: 0,
        memory_mode: "off",
        extraction_state: "invoked_cut_off",
        extraction_candidate_count: null,
        verdict: "SHOULD-BE-IGNORED",
      },
    ],
    0,
  );
  assert.equal(res.ok, true);
  assert.equal(res.patch.run.attempt.current, 2, "the extraction record is not an attempt");
  assert.equal(res.patch.run.turns, 100);
});

test("an archived record carrying no `type` is still read as an attempt", async () => {
  // First-generation records predate the `type` field. Dropping them would
  // silently discard historical cells.
  const [a1, a2] = twoAttempts(0, "off");
  delete a1.type;
  delete a2.type;
  const res = await cellFrom([a1, a2], 0);
  assert.equal(res.ok, true);
  assert.equal(res.patch.run.attempt.current, 2, "no `type` is read as an attempt");
  assert.equal(res.patch.run.arm, "off");
});

// ── ONE CELL ON SCREEN ───────────────────────────────────────────────────────

test("ONE CELL: readCell is the named cell's own record, never the newest cell's", async () => {
  const records = [
    attempt({ seq: 0, attempt: 1, mode: "off", turns: 11, truncatedTurns: 1 }),
    attempt({ seq: 1, attempt: 1, mode: "off", turns: 22, truncatedTurns: 2 }),
    attempt({ seq: 1, attempt: 2, mode: "off", turns: 33, truncatedTurns: 2 }),
  ];
  const zero = await cellFrom(records, 0);
  assert.equal(zero.patch.run.turns, 11);
  assert.equal(zero.patch.run.attempt.current, 1);
  assert.equal(zero.patch.honesty.transport.truncations, 1, "a cell's transport is its own, never a batch sum");
  const one = await cellFrom(records, 1);
  assert.equal(one.patch.run.attempt.current, 2);
  const none = await cellFrom(records, 7);
  assert.equal(none.ok, false, "a cell with no record says so rather than borrowing another's");
});

test("LOOP-GUARD: a recovered cell's truncated turns still reach the honesty metric", async () => {
  // A cell whose turns were truncated by a loop-guard the harness RECOVERED is
  // a completed measurement — and the recovered turns stay honest transport
  // data, reported rather than hidden.
  const res = await cellFrom(
    [
      attempt({ seq: 0, attempt: 1, mode: "off", truncatedTurns: 9, unrecoveredAnomalyTurns: 0 }),
      attempt({
        seq: 0,
        attempt: 2,
        mode: "off",
        gates: ["[G02] REQ-B — b"],
        truncatedTurns: 9,
        unrecoveredAnomalyTurns: 0,
      }),
    ],
    0,
  );
  assert.equal(res.patch.honesty.transport.truncations, 9, "truncated_turns still feeds the honesty metric");
});

// ── THE STALE-CORPSE DEFECT (measured live 2026-08-13) ───────────────────────
//
// `manifest.status.jsonl` is appended AT ATTEMPT END — roughly 30 minutes in.
// The previous rule checked "has a status file" BEFORE recency, so for the
// first half-hour of every run an ABANDONED run outranked the live one. Every
// per-cell source resolves the run through `activeRun`, so the ranking rule is
// pinned here rather than in each of them.
//
// The fix ranks on the manifest's own `created_at`. These pin it.

test("ACTIVE RUN: a fresh manifest-only run outranks an older run WITH a status stream", async () => {
  const root = await mkdtemp(join(tmpdir(), "okp-dash-fresh-"));
  try {
    // The corpse: has attempt records, declares an OLD start.
    const dead = join(root, "cumulative.abandoned");
    await mkdir(dead, { recursive: true });
    await writeFile(
      join(dead, "manifest.status.jsonl"),
      [attempt({ seq: 0, attempt: 1, mode: "off", gates: ["[G91] REQ-DEAD — dead"] })]
        .map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );
    await writeFile(
      join(dead, "manifest.json"),
      JSON.stringify({ org_id: "okp-org-0", created_at: "2026-08-12T07:04:09Z" }),
      "utf8",
    );

    // The live run: launched later, no attempt has closed yet, so NO status
    // file exists. This is the exact state of a run in its first 30 minutes.
    const live = join(root, "cumulative");
    await mkdir(live, { recursive: true });
    await writeFile(
      join(live, "manifest.json"),
      JSON.stringify({ org_id: "okp-org-0", created_at: "2026-08-13T05:13:49Z" }),
      "utf8",
    );

    const { activeRun } = await import("./sources/_runtime.mjs");
    const got = await activeRun(root);
    assert.equal(
      got?.name,
      "cumulative",
      "the newest DECLARED run wins even with no status stream — a corpse must never hold the screen",
    );
    assert.equal(got?.statusPath, null, "and it correctly reports having no attempt records yet");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ACTIVE RUN: created_at beats mtime, so an archived rename cannot win", async () => {
  // Archiving touches a directory long after its run ended. mtime would let a
  // freshly-renamed corpse outrank the live run; `created_at` cannot be moved
  // by a rename.
  const root = await mkdtemp(join(tmpdir(), "okp-dash-archive-"));
  try {
    const live = join(root, "cumulative");
    await mkdir(live, { recursive: true });
    await writeFile(
      join(live, "manifest.json"),
      JSON.stringify({ org_id: "x", created_at: "2026-08-13T05:13:49Z" }),
      "utf8",
    );

    const archived = join(root, "cumulative.void-truncation-20260812T0253");
    await mkdir(archived, { recursive: true });
    const am = join(archived, "manifest.json");
    await writeFile(am, JSON.stringify({ org_id: "x", created_at: "2026-08-12T07:04:09Z" }), "utf8");
    // Touched AFTER the live run's manifest — the archive/rename case.
    const later = new Date(Date.now() + 60_000);
    await utimes(am, later, later);

    const { activeRun } = await import("./sources/_runtime.mjs");
    const got = await activeRun(root);
    assert.equal(got?.name, "cumulative", "a later mtime must not beat an earlier declared start");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
