// ─────────────────────────────────────────────────────────────────────────────
// CORRIDOR DATA — the v2 cost contract, pinned.
//
// `panels/corridor-data.js` is the one place the board's v2 cost object and the
// live board payload become the corridor's run objects. Its whole contract is
// that "not observed" is `null` — never 0, never "". The v2 cost object nests
// its buckets under `phases` / `compactions`; a bucket nobody wrote stays null,
// and price/cost are TRI-STATE: a local model is `not_applicable` (it has no
// price by construction), a non-local model with no figure is `not_observed`,
// and only a finite number is a `value` — a real 0 included.
//
//     cd dashboard && node --test corridor-data.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  corridorRunsFromBoard,
  isLocalRun,
  observed,
  tokenBarFromProgress,
} from "./panels/corridor-data.js";

const NULL_BUCKET = {
  turns: null,
  input_tokens: null,
  output_tokens: null,
  reasoning_tokens: null,
  cache_read_tokens: null,
  cache_write_tokens: null,
  wall_seconds: null,
  compactions: null,
  context_peak: null,
  grades: null,
};

const NULL_TOTAL = {
  measured_seconds: null,
  turns: null,
  input_tokens: null,
  output_tokens: null,
  reasoning_tokens: null,
  cache_read_tokens: null,
  cache_write_tokens: null,
  compactions: null,
  context_peak: null,
  grades: null,
};

const GRADES = { count: 3, last: { total: 10, passed: 9, failed: 1 } };

// ── fixtures: the v2 cost object exactly as control/board/sources/cost.mjs
// emits it (nested under `phases` / `compactions`), on a run card. ─────────

function v2Cost(over = {}) {
  return {
    system_epoch: "2026-11-08",
    model: "cloud-model",
    provider: "router",
    outcome: "passed",
    terminal_reason: "all gates green",
    void: false,
    cell_wall_seconds: 300,
    measured_wall_seconds: 120.5,
    paused_seconds: 7,
    price: 0.4,
    cost_usd: 12.25,
    phases: {
      by_phase: [
        {
          name: "initial",
          layer: "build",
          build: {
            turns: 3,
            input_tokens: 100,
            output_tokens: 20,
            reasoning_tokens: 5,
            cache_read_tokens: 40,
            cache_write_tokens: 10,
            wall_seconds: 30,
            compactions: 1,
            context_peak: 12000,
            grades: GRADES,
          },
          troubleshooting: {},
        },
        {
          name: "feedback-1",
          layer: "repair",
          build: {},
          troubleshooting: { turns: 1, input_tokens: 50, wall_seconds: 12.5 },
        },
      ],
      build: {},
      troubleshooting: {},
      total: {
        turns: 4,
        input_tokens: 150,
        output_tokens: 20,
        reasoning_tokens: 5,
        cache_read_tokens: 40,
        cache_write_tokens: 10,
        wall_seconds: 42.5,
        compactions: 2,
        context_peak: 14000,
        grades: GRADES,
      },
    },
    compactions: {
      count: 2,
      positions: [
        { ts: 1791152000, measured_offset_s: 30, phase_index: 0, phase_kind: "build" },
      ],
    },
    ...over,
  };
}

function runCard(over = {}) {
  return {
    run_dir: "1791151982/campaign/m",
    sequence_index: 0,
    benchmark_id: "1791151982",
    archived: false,
    model: "cloud-model",
    status: "scored",
    ...over,
  };
}

const LEDGER = {
  models: [{ id: "local-qwen" }],
  baseline_rows: [{ model: "cloud-model", kind: "cloud" }],
};

function v2Board(cardOver = {}, costOver = {}, boardOver = {}) {
  return {
    runs: {
      list: [
        runCard({
          system_epoch: "2026-11-08",
          ...cardOver,
          cost: v2Cost(costOver),
        }),
      ],
    },
    by_cell: {},
    models_ledger: LEDGER,
    ...boardOver,
  };
}

// ── the full v2 run shape ───────────────────────────────────────────────────

test("a v2 card emits the full corridor run shape", () => {
  const { runs, truncated, total } = corridorRunsFromBoard(v2Board());

  assert.equal(total, 1);
  assert.equal(truncated, 0);
  assert.equal(runs.length, 1);

  const r = runs[0];
  assert.equal(r.key, "1791151982/campaign/m::0");
  assert.equal(r.model, "cloud-model");
  assert.equal(r.status, "completed", "a scored card is a completed run");
  assert.equal(r.outcome, "passed");
  assert.equal(r.outcome_detail, "all gates green");
  assert.equal(r.system_epoch, "2026-11-08");
  assert.equal(r.isV2, true);
  assert.equal(r.held, true, "paused_seconds > 0 is a hold");
  assert.equal(r.paused_seconds, 7);
  assert.deepEqual(r.price, { state: "value", value: 0.4 });
  assert.deepEqual(r.cost_usd, { state: "value", value: 12.25 });

  assert.deepEqual(r.total, {
    measured_seconds: 120.5,
    turns: 4,
    input_tokens: 150,
    output_tokens: 20,
    reasoning_tokens: 5,
    cache_read_tokens: 40,
    cache_write_tokens: 10,
    compactions: 2,
    context_peak: 14000,
    grades: GRADES,
  }, "the widened total carries every token class, the peak and the grades");

  assert.deepEqual(r.compaction, {
    count: 2,
    positions: [{ ts: 1791152000, measured_offset_s: 30, phase_index: 0, phase_kind: "build" }],
  }, "positions pass through as stated — never synthesized as offsets");
});

test("a paused run at zero is not held; an absent pause is not observed", () => {
  const zero = corridorRunsFromBoard(v2Board({}, { paused_seconds: 0 })).runs[0];
  assert.equal(zero.held, false, "a real 0 seconds paused is still not a hold");
  assert.equal(zero.paused_seconds, 0);

  const absent = corridorRunsFromBoard(v2Board({}, { paused_seconds: null })).runs[0];
  assert.equal(absent.held, false);
  assert.equal(absent.paused_seconds, null);
});

// ── phases: one entry per by_phase element, both bands shaped ───────────────

test("by_phase becomes one entry per phase with both bands shaped", () => {
  const r = corridorRunsFromBoard(v2Board()).runs[0];

  assert.equal(r.phases.length, 2);
  assert.equal(r.phases[0].name, "initial");
  assert.equal(r.phases[0].layer, "build");
  assert.deepEqual(r.phases[0].build, {
    turns: 3,
    input_tokens: 100,
    output_tokens: 20,
    reasoning_tokens: 5,
    cache_read_tokens: 40,
    cache_write_tokens: 10,
    wall_seconds: 30,
    compactions: 1,
    context_peak: 12000,
    grades: GRADES,
  });
  assert.deepEqual(r.phases[0].troubleshooting, NULL_BUCKET, "an empty band is all null, never 0");

  assert.equal(r.phases[1].name, "feedback-1");
  assert.equal(r.phases[1].layer, "repair");
  assert.deepEqual(r.phases[1].build, NULL_BUCKET);
  assert.equal(r.phases[1].troubleshooting.turns, 1);
  assert.equal(r.phases[1].troubleshooting.input_tokens, 50);
  assert.equal(r.phases[1].troubleshooting.wall_seconds, 12.5);
  assert.equal(r.phases[1].troubleshooting.output_tokens, null);
});

// ── total: measured seconds preference ──────────────────────────────────────

test("measured seconds prefer the measured wall, then the cell wall, then the phase roll-up", () => {
  const measured = corridorRunsFromBoard(v2Board({}, { measured_wall_seconds: null })).runs[0];
  assert.equal(measured.total.measured_seconds, 300, "cell wall before the phase roll-up");

  const phaseRoll = corridorRunsFromBoard(
    v2Board({}, { measured_wall_seconds: null, cell_wall_seconds: null }),
  ).runs[0];
  assert.equal(phaseRoll.total.measured_seconds, 42.5);

  const none = corridorRunsFromBoard(
    v2Board({}, { measured_wall_seconds: null, cell_wall_seconds: null, phases: { by_phase: [], total: {} } }),
  ).runs[0];
  assert.equal(none.total.measured_seconds, null, "nothing observed is null, NOT 0");
});

// ── price / cost_usd: three states ─────────────────────────────────────────

test("price and cost_usd are tri-state", () => {
  // Local by PATH (the local proxy mounts at local/local-llm-proxy/).
  const byPath = corridorRunsFromBoard(
    v2Board({ run_dir: "local/local-llm-proxy/m" }, { price: null, cost_usd: null }, { models_ledger: null }),
  ).runs[0];
  assert.deepEqual(byPath.price, { state: "not_applicable" });
  assert.deepEqual(byPath.cost_usd, { state: "not_applicable" });

  // Local by LEDGER — N/A even if a figure was somehow recorded.
  const byLedger = corridorRunsFromBoard(v2Board({ model: "local-qwen" }, { price: 5, cost_usd: 9 })).runs[0];
  assert.deepEqual(byLedger.price, { state: "not_applicable" }, "a local model has no price by construction");
  assert.deepEqual(byLedger.cost_usd, { state: "not_applicable" });

  // Non-local with no figure: not observed — never 0.
  const cloudNull = corridorRunsFromBoard(v2Board({}, { price: null, cost_usd: null })).runs[0];
  assert.deepEqual(cloudNull.price, { state: "not_observed" });
  assert.deepEqual(cloudNull.cost_usd, { state: "not_observed" });

  // A real zero IS a value — a free run quote, not an absence.
  const zero = corridorRunsFromBoard(v2Board({}, { price: 0, cost_usd: 0 })).runs[0];
  assert.deepEqual(zero.price, { state: "value", value: 0 });
  assert.deepEqual(zero.cost_usd, { state: "value", value: 0 });
});

// ── absent v2 cost: honest degradation, never zero ─────────────────────────

test("a card with no v2 cost is entirely unobserved, never zero", () => {
  const board = {
    runs: { list: [runCard({ run_dir: "r1", benchmark_id: "1700000001" })] },
    by_cell: {},
    models_ledger: LEDGER,
  };
  const r = corridorRunsFromBoard(board).runs[0];

  assert.deepEqual(r.total, NULL_TOTAL);
  assert.deepEqual(r.phases, [], "no by_phase means no phase rows — never a guessed one");
  assert.equal(r.compaction, null, "no count and no positions is no reading");
  assert.equal(r.held, false);
  assert.equal(r.paused_seconds, null);
  assert.equal(r.isV2, false);
  assert.equal(r.system_epoch, null);
  assert.equal(r.outcome, "scored", "outcome falls back to the card's own status");
  assert.equal(r.outcome_detail, null);
  assert.deepEqual(r.price, { state: "not_observed" });
});

// ── cost source: card first, then the cell view ─────────────────────────────

test("a card without its own cost reads the cell view's cost", () => {
  const board = {
    runs: { list: [runCard({ run_dir: "r1", sequence_index: 2, benchmark_id: "1700000001" })] },
    by_cell: { "r1::2": { cost: v2Cost({ price: 1.5 }) } },
    models_ledger: LEDGER,
  };
  const r = corridorRunsFromBoard(board).runs[0];
  assert.equal(r.total.input_tokens, 150);
  assert.deepEqual(r.price, { state: "value", value: 1.5 });
});

test("the card's own cost wins over the cell view's", () => {
  const board = {
    runs: { list: [runCard({ run_dir: "r1", sequence_index: 2, cost: v2Cost({ price: 0.4 }) })] },
    by_cell: { "r1::2": { cost: v2Cost({ price: 9 }) } },
    models_ledger: LEDGER,
  };
  assert.deepEqual(corridorRunsFromBoard(board).runs[0].price, { state: "value", value: 0.4 });
});

// ── board degradation ──────────────────────────────────────────────────────

test("a missing board, no runs list, or a null list yields no runs", () => {
  for (const board of [null, {}, { runs: { list: null }, by_cell: {} }, { runs: { list: "x" } }]) {
    assert.deepEqual(
      corridorRunsFromBoard(board),
      { runs: [], truncated: 0, total: 0 },
      `empty contract for ${JSON.stringify(board)}`,
    );
  }
});

// ── isLocalRun: path, local roster, substrate rows ─────────────────────────

test("isLocalRun reads the path, the local roster, and the substrate rows", () => {
  assert.equal(isLocalRun({ run_dir: "local/local-llm-proxy/x", model: null }, {}), true);
  assert.equal(isLocalRun({ cell: "local/local-llm-proxy/x/cell-0000", model: null }, {}), true);
  assert.equal(
    isLocalRun({ run_dir: "r", model: "m" }, { models_ledger: { models: [{ id: "m" }] } }),
    true,
    "the local bench roster names it",
  );
  assert.equal(
    isLocalRun({ run_dir: "r", model: "m" }, { models_ledger: { models: { m: { kind: "local" } } } }),
    true,
    "a dict keyed by model id is accepted too",
  );
  assert.equal(
    isLocalRun({ run_dir: "r", model: "m" }, { models_ledger: { baseline_rows: [{ model: "m", kind: "cloud" }] } }),
    false,
  );
  assert.equal(isLocalRun({ run_dir: "r", model: "m" }, { models_ledger: null }), false);
  assert.equal(isLocalRun({ run_dir: "r", model: null }, { models_ledger: { models: [{ id: "other" }] } }), false);
});

// ── curation: active first, cap 12, truncated, showAll ─────────────────────

/** `n` cards, index `i` carrying run id 1700000000+i; only listed ones active. */
function manyCards(n, { activeIndexes = [] } = {}) {
  const list = [];
  for (let i = 0; i < n; i += 1) {
    list.push(
      runCard({
        run_dir: `run-${i}`,
        benchmark_id: String(1700000000 + i),
        archived: !activeIndexes.includes(i),
        status: "void",
      }),
    );
  }
  return { runs: { list }, by_cell: {}, models_ledger: null };
}

test("the default cap keeps 12, active runs first and the newest after them", () => {
  const { runs, truncated, total } = corridorRunsFromBoard(manyCards(15, { activeIndexes: [2, 9] }));

  assert.equal(total, 15, "total is every card seen, before curation");
  assert.equal(runs.length, 12);
  assert.equal(truncated, 3);
  assert.deepEqual(runs.slice(0, 2).map((r) => r.key), ["run-9::0", "run-2::0"], "active runs lead, newest first");
  assert.deepEqual(
    runs.slice(2).map((r) => r.key),
    ["run-14::0", "run-13::0", "run-12::0", "run-11::0", "run-10::0",
      "run-8::0", "run-7::0", "run-6::0", "run-5::0", "run-4::0"],
    "the newest of the rest fill the remaining room; the oldest are hidden, never silently",
  );
});

test("showAll disables the cap and hides nothing", () => {
  const { runs, truncated, total } = corridorRunsFromBoard(
    manyCards(15, { activeIndexes: [7] }),
    { showAll: true },
  );
  assert.equal(total, 15);
  assert.equal(runs.length, 15);
  assert.equal(truncated, 0);
  assert.equal(runs[0].key, "run-7::0", "the active run still leads");
});

test("opts.cap overrides the default without ever dropping an active run", () => {
  const capped = corridorRunsFromBoard(manyCards(9, { activeIndexes: [1] }), { cap: 3 });
  assert.deepEqual(capped.runs.map((r) => r.key), ["run-1::0", "run-8::0", "run-7::0"]);
  assert.equal(capped.truncated, 6);

  // More active runs than the cap: every active one stays, none is hidden.
  const activeHeavy = corridorRunsFromBoard(manyCards(6, { activeIndexes: [0, 2, 4] }), { cap: 2 });
  assert.deepEqual(activeHeavy.runs.map((r) => r.key), ["run-4::0", "run-2::0", "run-0::0"]);
  assert.equal(activeHeavy.truncated, 3);
});

test("recency falls back to the run_dir's leading epoch segment", () => {
  const board = {
    runs: {
      list: [
        runCard({ run_dir: "1791151000/campaign/m", benchmark_id: null, archived: true }),
        runCard({ run_dir: "1791159000/campaign/m", benchmark_id: null, archived: true }),
      ],
    },
    by_cell: {},
    models_ledger: null,
  };
  assert.deepEqual(
    corridorRunsFromBoard(board).runs.map((r) => r.key),
    ["1791159000/campaign/m::0", "1791151000/campaign/m::0"],
  );
});

// ── observed ───────────────────────────────────────────────────────────────

test("observed is a finite number, and nothing else", () => {
  assert.equal(observed(5), true);
  assert.equal(observed(0), true, "a real zero is an observation");
  assert.equal(observed(null), false);
  assert.equal(observed(undefined), false);
  assert.equal(observed(NaN), false);
  assert.equal(observed(Infinity), false);
  assert.equal(observed("3"), false, "a numeric string is not a measured number");
});

// ── the live token bar: during-the-run geometry ────────────────────────────
// `tokenBarFromProgress` is a PURE read of `live.progress` (folded by
// control/board/sources/live-stream.mjs): per-lane normalization, widths from
// each turn's delta, and three states that never collapse into a zero-fill.

function tokDelta(input = 0, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0) {
  return {
    input,
    output,
    reasoning,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    total: input + output + reasoning + cacheRead + cacheWrite,
  };
}

/** A progress payload whose totals/segments agree, exactly as the folder emits it. */
function progressOf(deltas, over = {}) {
  let running = 0;
  const totals = tokDelta();
  const segments = deltas.map((delta, i) => {
    const start_total = running;
    running += delta.total;
    totals.input += delta.input;
    totals.output += delta.output;
    totals.reasoning += delta.reasoning;
    totals.cache_read += delta.cache_read;
    totals.cache_write += delta.cache_write;
    totals.total += delta.total;
    return {
      phase_index: 0,
      phase_kind: i % 2 === 0 ? "build" : "troubleshooting",
      phase_name: `phase-${i}`,
      ts: 1000 + i,
      delta,
      start_total,
      end_total: running,
    };
  });
  return {
    available: true,
    paused: false,
    totals,
    byKind: {},
    byPhaseKind: [],
    segments,
    boundaries: [],
    compactions: [],
    ...over,
  };
}

const sumWidths = (bar) => bar.segments.reduce((n, s) => n + s.widthPct, 0);

test("live token bar: segment widths sum to 100 at every payload", () => {
  const bar = tokenBarFromProgress(progressOf([tokDelta(20), tokDelta(50), tokDelta(30)]));
  assert.equal(bar.available, true);
  assert.equal(bar.empty, false);
  assert.equal(bar.total, 100);
  assert.deepEqual(bar.segments.map((s) => s.widthPct), [20, 50, 30]);
  assert.ok(Math.abs(sumWidths(bar) - 100) < 1e-9, "every step tiles the run's own 100%");
});

test("live token bar: a later turn rescales earlier widths, never the other way", () => {
  const before = tokenBarFromProgress(progressOf([tokDelta(20), tokDelta(50), tokDelta(30)]));
  const after = tokenBarFromProgress(
    progressOf([tokDelta(20), tokDelta(50), tokDelta(30), tokDelta(100)]),
  );
  assert.equal(after.total, 200);
  assert.ok(Math.abs(sumWidths(after) - 100) < 1e-9, "the new total is still 100% of the bar");
  for (let i = 0; i < before.segments.length; i += 1) {
    assert.ok(
      after.segments[i].widthPct <= before.segments[i].widthPct,
      `segment ${i} must shrink (or hold), never grow: ${after.segments[i].widthPct} > ${before.segments[i].widthPct}`,
    );
  }
});

test("live token bar: a zero-delta segment freezes prior geometry at zero width", () => {
  const base = tokenBarFromProgress(progressOf([tokDelta(20), tokDelta(50), tokDelta(30)]));
  const withZero = tokenBarFromProgress(
    progressOf([tokDelta(20), tokDelta(50), tokDelta(30), tokDelta(0)]),
  );
  assert.equal(withZero.total, base.total, "a zero delta does not move the total");
  assert.deepEqual(
    withZero.segments.slice(0, base.segments.length).map((s) => s.widthPct),
    base.segments.map((s) => s.widthPct),
    "prior segments keep the exact same geometry",
  );
  assert.equal(withZero.segments.at(-1).widthPct, 0);
});

test("live token bar: boundaries and compactions are offsets on the token axis", () => {
  const progress = progressOf([tokDelta(20), tokDelta(50), tokDelta(30)], {
    boundaries: [
      { phase_index: 1, phase_kind: "troubleshooting", offset: 70 },
      { phase_index: 2, phase_kind: "build", offset: NaN },
    ],
    compactions: [
      { ts: 2000, tokens_before: 99999, offset: 90 },
      { ts: 2001, tokens_before: 1, offset: Infinity },
    ],
  });
  const bar = tokenBarFromProgress(progress);
  assert.deepEqual(bar.boundaries, [
    { phase_index: 1, phase_kind: "troubleshooting", offsetPct: 70 },
  ], "a non-finite offset is not a position");
  assert.deepEqual(bar.compactions, [{ ts: 2000, tokens_before: 99999, offsetPct: 90 }]);
});

test("live token bar: an available-but-unspent run is the empty state, not a zero bar", () => {
  const bar = tokenBarFromProgress({
    available: true,
    paused: true,
    totals: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, total: 0 },
    byKind: null,
    segments: [],
    boundaries: [],
    compactions: [],
  });
  assert.deepEqual(bar, {
    available: true,
    empty: true,
    paused: true,
    total: 0,
    segments: [],
    boundaries: [],
    compactions: [],
  });
});

test("live token bar: absence is unavailable, never zeros", () => {
  for (const p of [null, undefined, {}, { available: false }]) {
    assert.deepEqual(
      tokenBarFromProgress(p),
      { available: false },
      `no live token stream for ${JSON.stringify(p)}`,
    );
  }
});

test("live token bar: each lane is 100% of its OWN total (per-lane independence)", () => {
  const board = {
    runs: {
      list: [
        runCard({ run_dir: "rA", benchmark_id: "1700000001" }),
        runCard({ run_dir: "rB", benchmark_id: "1700000002" }),
      ],
    },
    by_cell: {
      "rA::0": { live: { progress: progressOf([tokDelta(60), tokDelta(40)]) } },
      "rB::0": { live: { progress: progressOf([tokDelta(10), tokDelta(30)]) } },
    },
    models_ledger: LEDGER,
  };
  const runs = corridorRunsFromBoard(board).runs;
  const a = tokenBarFromProgress(runs.find((r) => r.key === "rA::0").progress);
  const b = tokenBarFromProgress(runs.find((r) => r.key === "rB::0").progress);

  assert.equal(a.total, 100);
  assert.equal(b.total, 40);
  assert.deepEqual(a.segments.map((s) => s.widthPct), [60, 40]);
  assert.deepEqual(b.segments.map((s) => s.widthPct), [25, 75], "each bar is normalized to itself");
});

test("run.progress is the raw cell-view payload, or null when no stream exists", () => {
  const withLive = corridorRunsFromBoard({
    runs: { list: [runCard({ run_dir: "rL", benchmark_id: "1700000003" })] },
    by_cell: { "rL::0": { live: { progress: { available: false, paused: false } } } },
    models_ledger: null,
  }).runs[0];
  assert.deepEqual(withLive.progress, { available: false, paused: false });

  const without = corridorRunsFromBoard({
    runs: { list: [runCard({ run_dir: "rN", benchmark_id: "1700000004" })] },
    by_cell: {},
    models_ledger: null,
  }).runs[0];
  assert.equal(without.progress, null, "no cell view is no progress, never a fabricated object");
});
