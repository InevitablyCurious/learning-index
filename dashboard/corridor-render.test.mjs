// ─────────────────────────────────────────────────────────────────────────────
// THE CORRIDOR RENDER — the v2 view, proven on fixtures.
//
// No v2 run exists in the tree yet, so this file is the corridor's only proof
// that the renderer consumes the v2 contract at all. It builds a run card
// exactly as `control/board/sources/cost.mjs` emits it (nested `phases` /
// `compactions`, tri-state price), runs it through the adapter, and then reads
// the HTML `renderCorridor` returns.
//
// WHY A DOM-FIXTURE TEST AND NOT A BROWSER: `renderCorridor` is a pure
// `board → HTML` function — it queries no DOM node, so its output is the whole
// artifact. `board.js` binds its listeners behind a boot guard, which is what
// makes importing this panel under Node possible at all.
//
// WHAT IT PINS
//
//   1. A v2 run is drawn WHOLE on the default view: per-phase build AND
//      troubleshooting bands with their names in visible text and their turns,
//      all five token classes, wall time, context peak, compaction positions
//      (and the count when only the count exists), the grade roll-up, the
//      outcome with its terminal reason, held time, and price/cost.
//   2. Price and cost are TRI-STATE: `N/A` for a local model (no price by
//      construction) and `—` for a cloud model that was not quoted. Two
//      absences, two glyphs, never a bare `0`.
//   3. The lane set is curated, never silently cut: the hidden runs are COUNTED
//      (`+3 historical`) and one click on the toggle draws them — including a v1
//      run (`system_epoch: null`) that the default cap hides.
//   4. Selection survives the lane set changing size (the 3-channel selected
//      lane is the caption's `▸` plus CSS rail and rim).
//
//     cd dashboard && node --test corridor-render.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { corridorRunsFromBoard } from "./panels/corridor-data.js";
import { renderCorridor, onCorridorInteraction } from "./panels/corridor.js";

const GRADES = { count: 3, last: { total: 10, passed: 9, failed: 1 } };

// ── fixtures: the v2 cost object, verbatim from cost.mjs's shape ────────────

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
          troubleshooting: { turns: 1, input_tokens: 50, wall_seconds: 12.5, context_peak: 14000 },
        },
      ],
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
      positions: [{ ts: 1791152000, measured_offset_s: 30, phase_index: 0, phase_kind: "build" }],
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

const v2Card = (cardOver = {}, costOver = {}) =>
  runCard({ system_epoch: "2026-11-08", ...cardOver, cost: v2Cost(costOver) });

const board = (list, over = {}) => ({ runs: { list }, by_cell: {}, models_ledger: LEDGER, ...over });

// ── interaction fixtures: `closest` is the only DOM method the handler uses ──

const click = (selector, dataset = {}) => ({
  closest: (sel) => (sel === selector ? { dataset } : null),
});

// ── 1. the whole v2 run, on the default view ────────────────────────────────

test("a v2 run renders whole on the default view", () => {
  const view = board([v2Card()]);

  // The fixture is real v2 data, not a hand-shaped HTML expectation: the adapter
  // reads it into the full run object first.
  const { runs, total } = corridorRunsFromBoard(view);
  assert.equal(total, 1);
  assert.equal(runs[0].isV2, true);
  assert.equal(runs[0].total.context_peak, 14000);
  assert.equal(runs[0].phases[1].name, "feedback-1");

  // A one-run board also forces the lane selection, which the totals row follows.
  const html = renderCorridor(view);

  // ── per-phase bands, both kinds, with names in VISIBLE text and turns ──
  assert.match(html, /class="corr-band corr-build"/, "the build phase draws a build band");
  assert.match(html, /class="corr-band corr-ts"/, "the feedback phase draws a troubleshooting band");
  assert.match(html, /class="corr-seg" data-phase="0"/, "phases are array-ordered — position 0 is the first phase");
  assert.match(html, /<span class="corr-segname">initial<\/span>/, "a phase name is rendered as text, not only a title");
  assert.match(html, /<span class="corr-segname">feedback-1<\/span>/);
  assert.match(html, /class="corr-segturns" data-turns="3"/, "phase 0's turns numeral");
  assert.match(html, /class="corr-segturns" data-turns="1"/, "phase 1's turns numeral");

  // ── all five token classes ──
  for (const k of ["in", "out", "reason", "cache", "cachewrite"]) {
    assert.ok(
      html.includes(`class="corr-total" data-k="${k}"`),
      `the totals row states the ${k} token class`,
    );
  }
  assert.match(html, /↑ 150/, "input tokens");
  assert.match(html, /↓ 20/, "output tokens");
  assert.match(html, /◆ 5/, "reasoning tokens");
  assert.match(html, /⚡ 40/, "cache-read tokens");
  assert.match(html, /✎ 10/, "cache-write tokens");

  // ── wall time, context peak ──
  assert.match(html, /⏱ 2:01/, "total.measured_seconds is rendered (120.5s → 2:01)");
  assert.match(html, /◧ 14K/, "total.context_peak is rendered");

  // ── compactions: positions AND the count ──
  assert.match(html, /class="corr-compacts" data-note="positions observed"/, "positions are drawn");
  assert.match(html, /class="corr-compact" style="left:24\.90%"/, "each position is placed on the axis");
  assert.match(html, /▮ 2/, "the compaction count is stated");
  assert.match(html, /data-k="cmp" data-basis="positions"/, "the count says it was positioned, not count-only");

  // ── grades: count and the last grade's passed/total/failed ──
  assert.match(
    html,
    /data-count="3" data-passed="9" data-total="10" data-failed="1"/,
    "grades carry count/passed/total/failed",
  );
  assert.match(html, /3 grades · 9\/10 last · 1 failed/, "and state them as text");

  // ── outcome, terminal reason and held time ──
  assert.match(html, /class="corr-outcome" data-observed="true">passed · all gates green/, "outcome + reason");
  assert.match(html, /held 0:07/, "held time is stated from paused_seconds");
  assert.match(html, /class="corr-holdcard"/, "a held run draws the hold card");
  assert.match(html, /class="corr-gate"/, "and the barrier on the track");

  // ── price / cost: a real figure, with its currency mark ──
  assert.match(html, /price \$0\.40/);
  assert.match(html, /cost \$12\.25/);
});

// ── 2. price/cost are tri-state: N/A ≠ — ────────────────────────────────────

test("price and cost render three distinct states, never a bare zero", () => {
  const view = board([
    // Cloud, no figure: NOT OBSERVED → em dash.
    v2Card({ run_dir: "1791151982/campaign/m", benchmark_id: "1791151982" }, { price: null, cost_usd: null }),
    // Local by path: NOT APPLICABLE → N/A, even though the run has cost rows.
    runCard({
      run_dir: "local/local-llm-proxy/m",
      benchmark_id: "1791151900",
      model: "local-qwen",
      system_epoch: "2026-11-08",
      cost: v2Cost({ model: "local-qwen", price: null, cost_usd: null }),
    }),
  ]);

  const html = renderCorridor(view);

  assert.match(html, /price —/, "an unquoted cloud run is 'not observed'");
  assert.match(html, /cost —/);
  assert.match(html, /price N\/A/, "a local model has no price by construction");
  assert.match(html, /cost N\/A/);
  assert.ok(!/price 0(?!\.)/.test(html), "an absence is never rendered as a bare 0");
});

// ── 3. the lane set: counted, and drawable ──────────────────────────────────

test("the toggle states the hidden runs and showAll draws them", () => {
  // 15 archived runs, newest first: the cap keeps 12, so 3 are hidden.
  const list = [];
  for (let i = 0; i < 15; i += 1) {
    list.push(
      runCard({
        run_dir: `run-${i}`,
        benchmark_id: String(1700000000 + i),
        archived: true,
        model: `model-${i}`,
        status: "scored",
      }),
    );
  }
  const view = board(list);

  const capped = renderCorridor(view);
  assert.match(capped, /class="corr-toggle" data-show-all="true"/, "a capped lane set offers the toggle");
  assert.match(capped, /\+3 historical/, "and states how many runs it is not drawing");
  // `▸ ` is a persisted lane pick, not part of the ordering claim.
  assert.match(capped, /class="corr-lane-label">(?:▸ )?model-14/, "the newest run leads");
  assert.ok(!capped.includes("model-0"), "the oldest run is hidden by the cap");

  // The click flips module state and asks for a re-render.
  assert.equal(onCorridorInteraction(click(".corr-toggle")), true, "the toggle is an interaction");

  const all = renderCorridor(view);
  assert.match(all, /class="corr-toggle is-on" data-show-all="false"/, "the control inverts");
  assert.match(all, /show recent only/);
  assert.match(all, /class="corr-lane-label">(?:▸ )?model-0/, "the hidden v1 run is drawn once every run is shown");
  assert.equal((all.match(/data-lane="/g) ?? []).length, 15, "all 15 lanes are drawn");

  // Back to the recent set, so module state is clean for later tests.
  assert.equal(onCorridorInteraction(click(".corr-toggle")), true);
  assert.ok(!renderCorridor(view).includes("model-0"));
});

// ── 4. selection survives the lane set growing, via all three channels ─────

test("selection survives the toggle and keeps its non-colour channels", () => {
  const list = [];
  for (let i = 0; i < 15; i += 1) {
    list.push(
      runCard({ run_dir: `run-${i}`, benchmark_id: String(1700000000 + i), archived: true, model: `model-${i}` }),
    );
  }
  const view = board(list);

  // Pick lane 1 (model-13).
  assert.equal(onCorridorInteraction(click(".corr-lane", { lane: "1" })), true);
  const before = renderCorridor(view);
  assert.equal((before.match(/corr-lane is-selected/g) ?? []).length, 1, "exactly one lane is selected");
  assert.match(before, /class="corr-lane-label">▸ model-13/, "the caption marks the pick with ▸");

  // Grow the set; the pick must survive it.
  onCorridorInteraction(click(".corr-toggle"));
  const after = renderCorridor(view);
  assert.equal((after.match(/corr-lane is-selected/g) ?? []).length, 1, "still exactly one lane is selected");
  assert.match(after, /class="corr-lane-label">▸ model-13/, "and it is still lane 1");

  // A pick that the SHRUNKEN set no longer contains is dropped, never kept
  // stale: the second half of the reconciliation, on the same control.
  onCorridorInteraction(click(".corr-lane", { lane: "14" }));
  assert.match(renderCorridor(view), /class="corr-lane-label">▸ model-0/, "the oldest run can be picked while shown");
  onCorridorInteraction(click(".corr-toggle"));
  const shrunk = renderCorridor(view);
  assert.equal((shrunk.match(/corr-lane is-selected/g) ?? []).length, 0, "an out-of-range pick is no pick");
  assert.ok(!shrunk.includes("model-0"), "and the lane set is back to the recent cap");
});

// ── 5. an empty board is a designed zero, not a broken render ──────────────

test("no runs renders the empty track and no toggle", () => {
  const html = renderCorridor({ runs: { list: [] }, by_cell: {} });
  assert.match(html, /class="corr-empty"/);
  assert.ok(!html.includes("corr-toggle"), "nothing is hidden when there is nothing to draw");
});
