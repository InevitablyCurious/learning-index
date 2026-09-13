// ─────────────────────────────────────────────────────────────────────────────
// THE PHASE SPINE READS THE PRODUCER, NOT A PARSED LOG
//
// > A consumer must never derive a fact that a producer could state.
// >   — dev/priv/dev-benchmark-data.md §0
//
// THE DEFECT THIS PINS, measured on a live cell:
//
//   live.jsonl   phase.start feedback-1   ts 1788598797375
//                attempt.end attempt 1, verdict FAIL, 27 failed
//                                          ts 1788598797369
//   gate wall    36/53 passing
//   the spine    1 — BUILD · RUNNING
//
// The harness had stated the transition six milliseconds after closing the
// attempt. `sources/live-stream.mjs` handled every core kind EXCEPT
// `phase.start` and dropped it, so the spine read `run.phase` instead — which
// `sources/run-log.mjs` recovers by regex from PROGRESS lines in the launch
// log. Those lines are emitted by the build/serve loop, so the parsed phase
// stops moving exactly when the build ends. The board was reporting a build
// that had already been graded.
//
// This file asserts the precedence in both directions, because deleting the
// fallback would be the opposite error: `live.jsonl` is written from cell start,
// a run begun before it existed has none, and the tail window can scroll past
// every `phase.start` on a long cell.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";

import { spine, phaseIndex } from "./panels/live.js";

const RUNNING = { state: "running", chunk: { current: 6, total: 6 } };

/** The exact shape observed on disk when the defect was reproduced. */
function gradingBoard(over = {}) {
  return {
    live: {
      phase: "feedback-1",
      phase_ts: 1788598797375,
      attempts: [{ attempt: 1, verdict: "FAIL", failed: 27, ts: 1788598797369 }],
      ...over,
    },
  };
}

test("the STATED phase wins over the parsed one", () => {
  // run.phase is stale at the last build chunk; live.jsonl says grading began.
  const html = spine({ ...RUNNING, phase: "initial-chunk-6" }, gradingBoard());
  const build = html.slice(0, html.indexOf("2 —"));
  assert.ok(!build.includes("RUNNING"), "BUILD must not be running once the harness has left it");
  assert.match(build, /DONE/);
});

test("a build the harness has left stops pulsing its work orders", () => {
  // `r.chunk.current` KEEPS its value after the build ends, so the final tick
  // stayed `now` and went on pulsing through the whole of grading. Motion on
  // this board means "happening right now"; a tick that pulses after its phase
  // closed breaks that claim for every other animation on the card.
  const html = spine({ ...RUNNING, phase: "initial-chunk-6" }, gradingBoard());
  const build = html.slice(0, html.indexOf("2 —"));
  assert.ok(!build.includes('class="tick now"'), "no work order may be current once the build is done");
  assert.match(build, /all 6 work orders complete/);
});

test("the closed attempt's verdict is shown, from attempt.end", () => {
  // "already graded" must be legible on the row itself, not inferred by
  // comparing this column against the gate wall beside it.
  const html = spine({ ...RUNNING, phase: "initial-chunk-6" }, gradingBoard());
  assert.match(html, /FAIL · 27 failed/);
});

test("the attempt count and the gate wall now count the same thing", () => {
  // THIS TEST INVERTED, 2026-09-05, and the inversion is the point.
  //
  // It used to assert the row must NOT say "failed", because the wall counted
  // failing GATES (conformance being ONE gate) while this row counted
  // `attempt.end.failed` = `len(failed_gates)`, which listed each conformance
  // sub-problem separately. Measured across all five attempts of run
  // 1788599410 they ran a constant +10 apart, and calling both "failed" read as
  // a contradiction — so the row said "findings" instead.
  //
  // Conformance is now 65 real gates (`tasks/backgammon/gates/pregate.spec.ts`),
  // so one finding IS one gate. The workaround is removed rather than left
  // behind a condition that no longer holds — a stale relabelling is a second
  // vocabulary for one fact, which is the defect it was working around.
  const html = spine({ ...RUNNING, phase: "initial-chunk-6" }, gradingBoard());
  assert.match(html, /\d+ failed/);
  assert.ok(!html.includes("findings"), "the divergence is closed at the source");
});

test("the parsed phase is still used when the producer said nothing", () => {
  // Deleting the fallback would trade a lagging phase for no phase at all on
  // older runs and on long cells whose tail has scrolled past every
  // `phase.start`.
  const html = spine({ ...RUNNING, phase: "initial-chunk-3" }, { live: { phase: null, attempts: [] } });
  const build = html.slice(0, html.indexOf("2 —"));
  assert.match(build, /RUNNING/, "phase 1 is running per the launch log");
  assert.match(html, /work order 6 of 6/);
});

test("a fallback phase says so, rather than presenting itself as stated", () => {
  const derived = spine({ ...RUNNING, phase: "initial-chunk-3" }, { live: { phase: null, attempts: [] } });
  assert.match(derived, /recovered from the launch log/);
  const stated = spine({ ...RUNNING, phase: "initial-chunk-6" }, { live: { phase: "initial-chunk-6", attempts: [] } });
  assert.ok(!stated.includes("recovered from the launch log"));
});

test("an unparseable stated phase falls back rather than blanking the spine", () => {
  // A phase name this board has never seen must not erase the spine — the
  // fallback is exactly what an unknown future phase string should reach.
  const html = spine({ ...RUNNING, phase: "initial-chunk-2" }, { live: { phase: "some-future-phase", attempts: [] } });
  assert.match(html, /1 — BUILD/);
  assert.match(html, /RUNNING/);
});

test("phaseIndex maps the harness's vocabulary, and refuses what it does not know", () => {
  assert.equal(phaseIndex("initial"), 1);
  assert.equal(phaseIndex("initial-chunk-6"), 1);
  assert.equal(phaseIndex("feedback-1"), 2);
  assert.equal(phaseIndex("verdict-pass-1"), 2);
  assert.equal(phaseIndex("feedback-4"), 5);
  // Out of range and unknown both yield null so the caller can fall back,
  // rather than being clamped into a phase that was never reported.
  assert.equal(phaseIndex("feedback-9"), null);
  assert.equal(phaseIndex("who-knows"), null);
  assert.equal(phaseIndex(null), null);
});
