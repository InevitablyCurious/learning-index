// ─────────────────────────────────────────────────────────────────────────────
// TOKEN TOTALS — a cell's spend is its cost stamp's, never an attempt's
//
// Zero dependencies. Stock `node --test`, no install, no build step:
//
//     cd bench/control && node --test
//
// WHAT THIS PINS, AND WHY IT EXISTS
//
// Cell token totals live in each cell's `cost.json` under `phases.total`
// (scripts/run_cumulative/runner.py; PhaseCost in
// harness/adapters/challenge/models.py). A `type:"attempt"` status row carries
// PER-ATTEMPT, phase-scoped `work_*` counters instead.
//
// Two readers kept consuming those per-attempt counters with cell-level
// last-write-wins, so a multi-attempt cell published its LAST attempt's numbers
// as the whole cell's — an undercount that looks like a measurement. Both now
// read `cost.json` `phases.total` through control/baselines.mjs:readCellCost,
// one read per cell. These drive the REAL source modules so the defect cannot
// come back.
//
// The other half of the rule: `phases.total.output_tokens` is generation-only
// and `reasoning_tokens` sits BESIDE it, while an attempt's `work_output_tokens`
// folded reasoning in — hence the board field is `output`, not
// `output_and_reasoning` (contract.mjs declares the five categories separately).
//
// And absent means unknown, never 0: a cell with no stamp shows null throughout,
// even when its attempt rows are full of numbers.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCell } from "./sources/status-stream.mjs";

// ── fixture builders ─────────────────────────────────────────────────────────

/** Cell directory as the harness lays it out: <campaign>/memory<ARM>/cell-NNNN. */
function cellDir(runDir, seq, arm = "off") {
  return join(runDir, `memory${arm.toUpperCase()}`, `cell-${String(seq).padStart(4, "0")}`);
}

/**
 * ONE ATTEMPT's row, in the shape run_cumulative.py emits: its own `work_*`
 * counters, its own `progress`. Both are attempt-scoped — which is exactly why
 * neither may stand in for the cell.
 */
function attemptRow({ seq = 0, n = 1, mode = "off", workIn = 111, workOut = 222 } = {}) {
  const gates = ["[G01] REQ-A — a"];
  return {
    type: "attempt",
    sequence_index: seq,
    attempt: n,
    memory_mode: mode,
    org_id: "okp-org-0",
    verdict: "FAIL",
    terminal_outcome: false,
    terminal_reason: "gates_failed",
    failed_gates: gates,
    work_input_tokens: workIn,
    work_output_tokens: workOut,
    work_reasoning_tokens: 33,
    work_cache_read_tokens: 44,
    work_cache_write_tokens: 55,
    work_total_tokens: workIn + workOut,
    // Deliberately loud: nothing here may be mistaken for the cell total.
    progress: {
      turns: 40,
      wall_seconds: 600,
      failed_gates: gates,
      total_tokens: 999_999,
      input_tokens: 888_888,
      output_tokens: 777_777,
    },
  };
}

/** A cell's cost stamp, where the harness writes it (sibling of fingerprint.json). */
async function writeCost(runDir, seq, total, { arm = "off" } = {}) {
  const dir = cellDir(runDir, seq, arm);
  await mkdir(dir, { recursive: true });
  const record = {
    outcome: "failed",
    // `total` omitted entirely when a test passes none: absent-means-unknown.
    phases: total ? { total } : {},
    void: { is_void: false, reason: null },
  };
  await writeFile(join(dir, "cost.json"), `${JSON.stringify(record)}\n`, "utf8");
}

/** A campaign directory the cell reader can read: manifest + the status stream. */
async function writeRun(root, records) {
  const dir = join(root, "cumulative");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({
      org_id: "okp-org-0",
      created_at: "2026-08-13T05:13:49Z",
      task: "backgammon-cumulative-primary",
      roster_hash: "abc",
      seed: 20260709,
      schedule: [{ sequence_index: 0, memory_mode: "off", provider_pin: "m-a" }],
      session_records: [],
    }),
    "utf8",
  );
  if (records) {
    await writeFile(
      join(dir, "manifest.status.jsonl"),
      `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
      "utf8",
    );
  }
  return dir;
}

/** Run a source over a fresh temp root and hand back its patch. */
async function onRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "okp-dash-tokcost-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The cell's own view (status-stream readCell). */
async function cellView(root) {
  const res = await readCell({
    runsRoot: root,
    benchRoot: root,
    config: {},
    cell: { run_dir: "cumulative", sequence_index: 0 },
  });
  assert.equal(res.ok, true, `status-stream should read: ${res.reason ?? ""}`);
  return res.patch.run;
}

// ── the cell total is the stamp's, never the last attempt's ──────────────────

/** Two attempts with DIFFERENT per-attempt counters: last-write-wins would lie. */
function twoAttempts() {
  return [
    attemptRow({ n: 1, workIn: 111, workOut: 222 }),
    attemptRow({ n: 2, workIn: 333, workOut: 444 }),
  ];
}

/** The full five-way split, all different, so no field can borrow another's. */
const TOTAL = {
  input_tokens: 1_000,
  output_tokens: 200,
  reasoning_tokens: 150,
  cache_read_tokens: 4_000,
  cache_write_tokens: 500,
};

test("status-stream: a cell's tokens are cost.json phases.total, not the last attempt's work_*", async () => {
  await onRoot(async (root) => {
    const dir = await writeRun(root, twoAttempts());
    await writeCost(dir, 0, TOTAL);

    const run = await cellView(root);
    assert.deepEqual(
      { ...run.tokens, injected_block: undefined },
      {
        input: 1_000,
        output: 200,
        reasoning: 150,
        cache_read: 4_000,
        cache_write: 500,
        injected_block: undefined,
      },
    );
    assert.notEqual(run.tokens.input, 333, "the second attempt's counters are not the cell's");
    assert.notEqual(run.tokens.output, 444);
  });
});

// ── output is generation-only; reasoning sits beside it ─────────────────────

test("output is phases.total.output_tokens (generation-only), reasoning separate", async () => {
  await onRoot(async (root) => {
    const dir = await writeRun(root, twoAttempts());
    await writeCost(dir, 0, TOTAL);

    const run = await cellView(root);
    assert.equal(run.tokens.output, 200, "output is RAW generation, reasoning excluded");
    assert.equal(run.tokens.reasoning, 150, "reasoning is its own category");
    assert.equal(
      run.tokens.output,
      TOTAL.output_tokens,
      "no fold of reasoning into output — the field is `output`, not `output_and_reasoning`",
    );
    assert.equal(run.tokens.output, 200);
    assert.equal(run.tokens.reasoning, 150);
  });
});

// ── absent is unknown, never 0 ──────────────────────────────────────────────

test("a cell with NO cost.json shows null tokens, even when its rows are full of numbers", async () => {
  await onRoot(async (root) => {
    await writeRun(root, twoAttempts()); // rows carry work_* and progress totals
    // No cost stamp written at all.

    const run = await cellView(root);
    assert.equal(run.tokens.input, null, "no fallback to work_input_tokens or progress.input_tokens");
    assert.equal(run.tokens.output, null);
    assert.equal(run.tokens.reasoning, null);
    assert.equal(run.tokens.cache_read, null);
    assert.equal(run.tokens.cache_write, null);
  });
});

test("a stamp with no phases.total (void/pre-standard) shows null tokens too", async () => {
  await onRoot(async (root) => {
    const dir = await writeRun(root, twoAttempts());
    await writeCost(dir, 0, null); // phases: {} — the stamp exists, the total does not

    const run = await cellView(root);
    assert.equal(run.tokens.input, null, "no total on the stamp is unknown, not 0");
    assert.equal(run.tokens.input, null);
    assert.equal(run.tokens.output, null);
  });
});

test("a PARTIAL stamp sums only the kinds it observed — never a zero for the missing ones", async () => {
  await onRoot(async (root) => {
    const dir = await writeRun(root, twoAttempts());
    // A local model: no cache figures, no reasoning key (to_dict omits absent keys).
    await writeCost(dir, 0, { input_tokens: 10, output_tokens: 20 });

    const run = await cellView(root);
    assert.equal(run.tokens.input, 10);
    assert.equal(run.tokens.output, 20);
    assert.equal(run.tokens.reasoning, null, "unobserved, not 0");
    assert.equal(run.tokens.cache_read, null);
    assert.equal(run.tokens.cache_write, null);
  });
});
