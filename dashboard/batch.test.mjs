// ─────────────────────────────────────────────────────────────────────────────
// THE BATCH INSIDE A BASELINES ROW — its cells, its median, the operator's pick
//
// Pins what panels/ledger.js cellsSection + panels/batch.js promise:
//
//  1. Every cell of the batch is listed — a void one too, with its reason and
//     no pick button. Voids are never dropped: a batch that hid its failures
//     would present fewer samples with the confidence of more.
//  2. While the batch can hold a floor — awaiting a pick, or already holding
//     one — every SCORED cell has a pick button, so the floor can be re-picked
//     (re-baselining is ordinary). A void batch (fingerprint changed) has none —
//     a floor never rides stale numbers — and a picked cell shows FLOOR.
//  3. The row states the median and spread, and the pick's distance from the
//     median as a percentage, as the server computed it.
//  4. pickRun POSTs /api/batch/select with {run_dir, sequence_index}.
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

const { pickRun } = await import("./panels/batch.js");
const { renderLedger, toggleBaselineRow, toggleSuperseded } = await import("./panels/ledger.js");

const cell = (i, over = {}) => ({
  sequence_index: i, state: "complete", scored: true, void_reason: null, problems: 20,
  vs_median: 0, picked: false, turns: 300, tokens: 12_000_000, wall_seconds: 12_000,
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
    pick: null,
    ...over,
  };
}

function row(over = {}) {
  return {
    id: "base-2131", model: "qwen3.6-35b", kind: "local", kind_label: "LOCAL", provider: "local-llm-proxy",
    state: "awaiting", scorable: false, reason: "awaiting_selection",
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

const picks = (html) => [...html.matchAll(/data-batch-pick="(\d+)"/g)].map((m) => m[1]);

// ── A: the row and its cells ─────────────────────────────────────────────────

test("the row states cells, median and spread, and awaits a pick", () => {
  const html = open(row());
  assert.match(html, /4 · 3 scored · <span class="danger">1 void<\/span>/);
  assert.match(html, /23 <span class="note">\(17–27\)<\/span>/);
  assert.ok(html.includes("AWAITING PICK"));
});

test("every cell is listed with its trajectory — the void one too, with its reason", () => {
  const html = open(row());
  for (const s of ["s0000", "s0001", "s0002", "s0003"]) assert.ok(html.includes(s), s);
  assert.ok(html.includes("27 → 28 → 27 → 26 → 24"));
  assert.ok(html.includes("17 → 17 → 17 → 17 → 18"));
  assert.ok(html.includes("void · IncompleteBuildError"), "a cell that died in the build says what it died of");
  assert.ok(html.includes("+4") && html.includes("−6") && html.includes("±0"), "distance from the median, signed");
});

test("while awaiting, every SCORED cell gets a pick button; the void cell gets none", () => {
  assert.deepEqual(picks(open(row())), ["0", "1", "3"]);
});

test("a superseded batch folds into its own group, offers no pick, and says why", () => {
  const r = row({
    state: "void", reason: "batch_void", void_kind: "superseded", void_input: "grader_hash",
    void_reason: "grader_hash changed since this batch ran — grader/gate suite",
  });
  const folded = open(r);
  assert.ok(folded.includes("SUPERSEDED — 1 batch"), "the group is named with its count");
  assert.ok(!folded.includes("s0000"), "folded by default: its cells are not drawn");

  toggleSuperseded();
  const html = open(r);
  toggleSuperseded();
  assert.deepEqual(picks(html), []);
  assert.ok(html.includes("SUPERSEDED — grader_hash changed"));
  assert.ok(html.includes("grader_hash changed since this batch ran"), "the reason sentence is on screen");
  assert.ok(!html.includes(">batch_void<"), "the raw reason code is not printed");
});

test("an unfingerprinted batch says so, and the live list says no batch can be a floor", () => {
  const html = open(row({
    state: "void", reason: "batch_void", void_kind: "unfingerprinted", void_input: null,
    void_reason: "s0000 recorded nothing about what it ran on — there is nothing to bind this batch to",
  }));
  assert.ok(html.includes("No batch can be a floor right now"));
  toggleSuperseded();
  const open2 = open(row({ state: "void", reason: "batch_void", void_kind: "unfingerprinted", void_reason: "s0000 recorded nothing" }));
  toggleSuperseded();
  assert.ok(open2.includes("UNFINGERPRINTED"));
});

test("a picked batch shows the floor with its distance from the median", () => {
  const cells = batch().cells.map((c) => ({ ...c, picked: c.sequence_index === 0 }));
  const html = open(row({
    state: "complete", scorable: true, reason: null,
    batch: batch({ cells, pick: { sequence_index: 0, problems: 27, signed_deviation: 4, pct_from_median: 17.4 } }),
  }));
  assert.ok(html.includes("s0000 · 27"));
  assert.ok(html.includes("+17.4% vs median"));
  assert.ok(html.includes(">FLOOR<"), "the picked cell is marked");
});

test("a floored batch still offers a re-pick — re-baselining is an ordinary act", () => {
  // A floor is no longer rationed to one per model: every Run is a baseline, and
  // a second batch on the same fingerprint is averaged with the first. Picking a
  // different scored cell as the floor is therefore a live control, not an
  // archived ceremony — POST /api/batch/select accepts it on a non-void batch.
  const cells = batch().cells.map((c) => ({ ...c, picked: c.sequence_index === 0 }));
  const html = open(row({
    state: "complete", scorable: true, reason: null,
    batch: batch({ cells, pick: { sequence_index: 0, problems: 27, signed_deviation: 4, pct_from_median: 17.4 } }),
  }));
  assert.deepEqual(picks(html), ["1", "3"], "the other scored cells can take the floor; the picked one is marked FLOOR");
  assert.ok(!picks(html).includes("2"), "a void cell is never pickable");
});

// ── B: the network act ───────────────────────────────────────────────────────

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

// ── C: the two network acts ──────────────────────────────────────────────────

test("pickRun POSTs /api/batch/select with {run_dir, sequence_index}", async () => {
  seen.length = 0;
  respond = json({ ok: true, batch: { selection: { sequence_index: 2 } } });
  await pickRun("base-1234/cumulative", 2);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "/api/batch/select");
  assert.equal(seen[0].opts.method, "POST");
  assert.equal(seen[0].opts.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(seen[0].opts.body), {
    run_dir: "base-1234/cumulative",
    sequence_index: 2,
  });
});

test("pickRun throws on a refusal, carrying the server's message", async () => {
  seen.length = 0;
  respond = json({ ok: false, error: "batch is void: grader_hash" }, 409);
  await assert.rejects(
    () => pickRun("base-1234/cumulative", 0),
    /batch select refused: HTTP 409 — batch is void: grader_hash/,
  );
});
