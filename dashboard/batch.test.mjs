// ─────────────────────────────────────────────────────────────────────────────
// THE BATCH INSIDE A BASELINES ROW — its cells, its median, the ON run's Δ
//
// Pins what panels/ledger.js promises:
//
//  1. Every cell of the batch is listed — a void one too, with its reason. Voids
//     are never dropped: a batch that hid its failures would present fewer
//     samples with the confidence of more.
//  2. The row states the median and spread, and each cell's distance from the
//     median as the server computed it.
//  3. The Δ is against the AVERAGE of the baselines on the run's fingerprint, so
//     it is printed with the count it is over (`+1.4 turns vs 3 baselines`), and
//     a run with no computable Δ prints the server's reason and no number.
//  4. No cell of a batch is selectable. The pick — its button, its FLOOR tag, the
//     panel that posted it — is gone with the method it belonged to: a batch is
//     measured whole, and the average is what a Δ is over. There is no
//     panels/batch.js to import and no route to post to.
//
// Mock-fetch idiom from concurrency.test.mjs: globalThis.fetch is assigned
// BEFORE the module import; nothing reaches the network.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";

/** Every fetch the panel makes, and the canned answer it gets. */
const seen = [];
let respond = null;
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

globalThis.fetch = async (url, opts = {}) => {
  seen.push({ url: String(url), opts });
  return respond;
};

const { renderLedger, toggleBaselineRow, toggleSuperseded } = await import("./panels/ledger.js");

const cell = (i, over = {}) => ({
  sequence_index: i, state: "complete", scored: true, void_reason: null, problems: 20,
  vs_median: 0, turns: 300, tokens: 12_000_000, wall_seconds: 12_000,
  gates: null, verdict: "FAIL", terminal_reason: "stopped",
  context_exhausted: false, attempt_failures: [20, 19, 19], ...over,
});

/** s0000: 27 · s0001: 23 · s0002: void · s0003: 17 → median 23 (the 2026-09-22 batch). */
function batch(over = {}) {
  return {
    median: 23,
    spread: { min: 17, max: 27 },
    scored_count: 3,
    void_count: 1,
    cells: [
      cell(0, { problems: 27, vs_median: 4, attempt_failures: [27, 28, 27, 26, 24] }),
      cell(1, { problems: 23, vs_median: 0, attempt_failures: [23, 22, 22, 22, 22] }),
      cell(2, { state: "ended", scored: false, void_reason: "IncompleteBuildError", problems: null, vs_median: null, turns: null, tokens: null, wall_seconds: null, verdict: null, terminal_reason: "harness_error", attempt_failures: [] }),
      cell(3, { problems: 17, vs_median: -6, attempt_failures: [17, 17, 17, 17, 18] }),
    ],
    ...over,
  };
}

function row(over = {}) {
  return {
    id: "base-2131", model: "qwen3.6-35b", kind: "local", kind_label: "LOCAL", provider: "local-llm-proxy",
    state: "complete", scorable: true, reason: null,
    run_dir: "1790106437/local/x", sequence_index: 0, runs: [], run_count: 0, best: null,
    can_run: { allowed: false, reason: null }, batch: batch(), ...over,
  };
}

/** The ledger with one row, opened. */
function open(r) {
  const b = { control: { roster: null }, models_ledger: { baseline_rows: [r], counts: { complete: 0, running: 0, void: 0 }, startable: [], run_in_flight: false } };
  toggleBaselineRow(r.id);
  const html = renderLedger(b);
  toggleBaselineRow(r.id);
  return html;
}

/** One ON run's cell, as models-ledger.mjs onRunsFor shapes it. */
const onRun = (delta, over = {}) => ({
  seq: 1,
  started_at: "2026-11-04T10:00:00Z",
  run_dir: "1790106437/local/x",
  sequence_index: 9,
  cell: {
    run_dir: "1790106437/local/x", sequence_index: 9, state: "complete",
    phases: { done: 3, total: 3 }, turns: 31.4, tokens: null, wall_seconds: 720,
    gates: { passed: 90, total: 114 }, verdict: "FAIL", void_instrument: false,
    terminal_reason: "stopped", context_exhausted: false, build_chunks: null,
  },
  delta,
  ...over,
});

/** The ledger with one row, opened, holding one ON run. */
const withRun = (delta, over = {}) =>
  open(row({ runs: [onRun(delta)], run_count: 1, best: null, ...over }));

// ── A: the row and its cells ─────────────────────────────────────────────────

test("the row states cells, median and spread", () => {
  const html = open(row());
  assert.match(html, /4 · 3 scored · <span class="danger">1 void<\/span>/);
  assert.match(html, /23 <span class="note">\(17–27\)<\/span>/);
  assert.match(html, /MEASURED/, "a closed batch is measured, not awaiting an operator");
});

test("every cell is listed with its trajectory — the void one too, with its reason", () => {
  const html = open(row());
  for (const s of ["s0000", "s0001", "s0002", "s0003"]) assert.ok(html.includes(s), s);
  assert.ok(html.includes("27 → 28 → 27 → 26 → 24"));
  assert.ok(html.includes("17 → 17 → 17 → 17 → 18"));
  assert.ok(html.includes("void · IncompleteBuildError"), "a cell that died in the build says what it died of");
  assert.ok(html.includes("+4") && html.includes("−6") && html.includes("±0"), "distance from the median, signed");
});

test("a superseded batch folds into its own group and says why", () => {
  const r = row({
    state: "void", scorable: false, reason: "batch_void", void_kind: "superseded", void_input: "grader_hash",
    void_reason: "grader_hash changed since this batch ran — grader/gate suite",
  });
  const folded = open(r);
  assert.ok(folded.includes("SUPERSEDED — 1 batch"), "the group is named with its count");
  assert.ok(!folded.includes("s0000"), "folded by default: its cells are not drawn");

  toggleSuperseded();
  const html = open(r);
  toggleSuperseded();
  assert.ok(html.includes("SUPERSEDED — grader_hash changed"));
  assert.ok(html.includes("grader_hash changed since this batch ran"), "the reason sentence is on screen");
  assert.ok(!html.includes(">batch_void<"), "the raw reason code is not printed");
});

test("an unfingerprinted batch says so, and the live list says no batch is a baseline", () => {
  const html = open(row({
    state: "void", scorable: false, reason: "batch_void", void_kind: "unfingerprinted", void_input: null,
    void_reason: "s0000 recorded nothing about what it ran on — there is nothing to bind this batch to",
  }));
  assert.ok(html.includes("No batch is a baseline right now"));
  toggleSuperseded();
  const open2 = open(row({ state: "void", scorable: false, reason: "batch_void", void_kind: "unfingerprinted", void_reason: "s0000 recorded nothing" }));
  toggleSuperseded();
  assert.ok(open2.includes("UNFINGERPRINTED"));
});

test("a void batch is named as such, and is not called a baseline", () => {
  // A live void row is one the code has not placed by a known input kind:
  // stateWord's own fallback, rather than a stale "FLOOR".
  const html = open(row({ state: "void", scorable: false, reason: "batch_void", void_kind: null, void_reason: "x" }));
  assert.ok(html.includes("VOID — NOT A BASELINE"));
});

// ── B: the Δ, and the count it is over ───────────────────────────────────────

test("a computable Δ prints the signed turn delta WITH the baseline count it is over", () => {
  const html = withRun({ computable: true, reason: null, turns: 1.4, tokens: null, better: false, baseline_count: 3, fingerprint: "a".repeat(64) });
  assert.ok(html.includes("+1.4 turns vs 3 baselines"), "the number and its evidence, together");
  assert.match(html, /class="danger">\+1\.4 turns vs 3 baselines — worse than baseline/, "more turns than the average is worse");
});

test("a better-than-baseline Δ is bright and carries no 'worse' suffix", () => {
  const html = withRun({ computable: true, reason: null, turns: -2.25, tokens: null, better: true, baseline_count: 1, fingerprint: "a".repeat(64) });
  assert.match(html, /class="bright">−2\.3 turns vs 1 baseline</, "singular, and the minus is the improvement");
  assert.ok(!html.includes("worse than baseline"));
});

test("a Δ over one baseline says 'baseline', not 'baselines'", () => {
  const html = withRun({ computable: true, reason: null, turns: 0, tokens: null, better: true, baseline_count: 1, fingerprint: "a".repeat(64) });
  assert.ok(html.includes("±0 turns vs 1 baseline"));
  assert.ok(!html.includes("1 baselines"));
});

test("a non-computable Δ prints the reason and NO number", () => {
  // No baseline was gathered on this run's fingerprint: the server refuses the
  // comparison, and a 0 here would claim one nobody made.
  const html = withRun({ computable: false, reason: "no baselines on this fingerprint", turns: null, tokens: null, baseline_count: 0, fingerprint: "a".repeat(64) });
  const cellHtml = html.match(/<span class="delta">(.*)<\/span>/)?.[1] ?? "";
  assert.match(cellHtml, /^<span class="null">no baselines on this fingerprint<\/span>$/, "the server's own sentence, plainly");
  assert.ok(!/turns vs/.test(cellHtml), "no count, no delta");
  assert.ok(!cellHtml.includes("Δ"), "and no Δ prefix pretending a measurement");
});

// ── C: nothing can be picked ─────────────────────────────────────────────────

test("no cell of a batch is selectable — no pick button, no FLOOR tag, no pick state", () => {
  const html = open(row({ state: "complete" })) + open(row({ state: "awaiting" }));
  assert.ok(!html.includes("data-batch-pick"), "the pick button and its handler are gone");
  assert.ok(!/>pick</.test(html), "no pick control is rendered");
  assert.ok(!html.includes("AWAITING PICK"), "control no longer emits the state, so the panel cannot print it");
  assert.ok(!html.includes(">FLOOR<"), "no cell is marked as a chosen floor");
  assert.ok(!html.includes("bc-picked"), "and none is styled as one");
  assert.ok(!html.includes("batch-dir"), "the pick carried the run_dir it posted to; that surface is gone");
});

test("panels/batch.js no longer exists, so there is no module to post /api/batch/select", async () => {
  await assert.rejects(
    () => import("./panels/batch.js"),
    (err) => err.code === "ERR_MODULE_NOT_FOUND",
    "the module that posted the pick must be gone, not merely unused",
  );
});

// ── D: the per-fingerprint aggregate ────────────────────────────────────────

test("the card prints the per-fingerprint aggregate: count and average, absent as —", () => {
  // ledger.fingerprints is how many baselines were gathered on each exact code
  // state and what one cost on average. The count IS the evidence that
  // re-baselining happened; the averages are over the cells that measured a
  // field, so an unmeasured one reads — and never a fabricated zero.
  const board = {
    models_ledger: {
      baseline_rows: [],
      counts: { complete: 0, running: 0, void: 0 },
      startable: [],
      run_in_flight: false,
      fingerprints: [
        {
          fingerprint_hash: "a".repeat(64),
          model: "qwen3.6-35b",
          baseline_count: 3,
          avg: {
            context_peak: 32768, wall_seconds: 720, turns: 30, input_tokens: 45000,
            output_tokens: 200, reasoning_tokens: null, cache_read_tokens: 1200, cache_write_tokens: null,
          },
        },
        {
          // A cell whose stamp omitted every averaged field: measured, but with
          // nothing to average. Each of these must read —, never 0.
          fingerprint_hash: "b".repeat(64),
          model: "qwen3.6-35b",
          baseline_count: 1,
          avg: {
            context_peak: null, wall_seconds: null, turns: null, input_tokens: null,
            output_tokens: null, reasoning_tokens: null, cache_read_tokens: null, cache_write_tokens: null,
          },
        },
      ],
    },
  };
  const html = renderLedger(board);
  assert.ok(html.includes("PER FINGERPRINT — 2"), "the strip names itself and its row count");
  assert.ok(html.includes("fp aaaaaaaa"), "eight characters of the hash, not all sixty-four");
  assert.ok(html.includes("3 baselines"), "the count per fingerprint");
  assert.ok(html.includes("ctx 32,768"), "the average context peak");
  assert.ok(html.includes("wall 12:00"), "the average wall time");
  assert.ok(html.includes("30 turns"));
  assert.ok(html.includes("45K tok"), "token averages use the board's tok()");
  assert.ok(html.includes("1 baseline ·"), "a single baseline is not '1 baselines'");
  assert.ok(html.includes("ctx <span class=\"null\">—</span>"), "an unmeasured average reads —");
  assert.ok(!/(?<![\d.])0 (turns|tok|baselines)/.test(html), "never a fabricated zero");
});
