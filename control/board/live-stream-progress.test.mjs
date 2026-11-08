// ─────────────────────────────────────────────────────────────────────────────
// SOURCE: live-stream — the `progress` fold on a cell's live.jsonl.
//
// The token axis is cumulative over the WHOLE cell, so these fixtures put the
// early turns physically LAST: a fold that trusted file position (or the 512KB
// tail) would undercount or scramble the segments. readCell is exercised
// against a real tmpdir so the file goes through the same readFile the board
// uses — no mocked fs.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCell } from "./sources/live-stream.mjs";

/** The canonical five + total, as the harness delta states them. */
function tok(input, output, reasoning, cache_read, cache_write) {
  return {
    input,
    output,
    reasoning,
    cache_read,
    cache_write,
    total: input + output + reasoning + cache_read + cache_write,
  };
}

/** A tmpdir bench with one cell directory, and the live.jsonl it is given. */
function fixture(lines) {
  const runsRoot = mkdtempSync(join(tmpdir(), "live-progress-"));
  const cellDir = join(runsRoot, "camp", "memoryOFF", "cell-0000");
  mkdirSync(cellDir, { recursive: true });
  const livePath = join(cellDir, "live.jsonl");
  writeFileSync(livePath, lines.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const ctx = { runsRoot, benchRoot: runsRoot, cell: { run_dir: "camp", sequence_index: 0 } };
  return { runsRoot, livePath, ctx };
}

function cellStart(session = "ses_1") {
  return { v: 1, ts: 10, kind: "cell.start", session_id: session, cell_seq: 0, arm: "off" };
}

/**
 * The token fixture. File order is deliberately NOT ts order: the compaction
 * is written before any turn, and the first turn (ts 1000) is written last.
 *   A ts1000 build       0 → 118
 *   B ts2000 build     118 → 171
 *   pause.start ts2500
 *   pause.end   ts2600
 *   C ts3000 troubleshooting 171 → 178
 *   compaction  ts3500 (tokens_before = 99999, the context peak)
 *   D ts4000 build     178 → 180
 *   pause.start ts5000 (leaves the cell paused)
 */
const TOKEN_FIXTURE = [
  { v: 1, ts: 3500, kind: "compaction", phase_index: 1, phase_kind: "troubleshooting", tokens_before: 99999 },
  { v: 1, ts: 4000, kind: "turn.tokens", phase_index: 2, phase_name: "Layer 2", phase_kind: "build", delta: tok(1, 1, 0, 0, 0), cumulative: tok(1, 1, 0, 0, 0) },
  { v: 1, ts: 2500, kind: "pause.start", pause_kind: "round", attempt: 1 },
  { v: 1, ts: 2600, kind: "pause.end", pause_kind: "round", held_s: 3 },
  cellStart(),
  { v: 1, ts: 3000, kind: "turn.tokens", phase_index: 1, phase_name: "Fix it", phase_kind: "troubleshooting", delta: tok(7, 0, 0, 0, 0), cumulative: tok(7, 0, 0, 0, 0) },
  { v: 1, ts: 2000, kind: "turn.tokens", phase_index: 1, phase_name: "Layer 1", phase_kind: "build", delta: tok(0, 3, 0, 50, 0), cumulative: tok(0, 3, 0, 50, 0) },
  { v: 1, ts: 1000, kind: "turn.tokens", phase_index: 1, phase_name: "Layer 1", phase_kind: "build", delta: tok(10, 5, 1, 100, 2), cumulative: tok(10, 5, 1, 100, 2) },
  { v: 1, ts: 5000, kind: "pause.start", pause_kind: "final", attempt: 2 },
];

test("live progress: totals are the sum of the DELTAS, in ts order", async () => {
  const { runsRoot, ctx } = fixture(TOKEN_FIXTURE);
  try {
    const res = await readCell(ctx);
    assert.equal(res.ok, true);

    // The pre-existing live fields survive untouched.
    const live = res.patch.live;
    assert.equal(live.session_id, "ses_1");
    assert.equal(live.cell_seq, 0);
    assert.equal(live.arm, "off");
    assert.equal(live.records, TOKEN_FIXTURE.length);

    const p = live.progress;
    assert.equal(p.available, true);
    assert.deepEqual(p.totals, tok(18, 9, 1, 150, 2)); // input 10+0+7+1, …
    assert.equal(p.totals.total, 180);
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("live progress: segments are turn-ordered with running start/end totals", async () => {
  const { runsRoot, ctx } = fixture(TOKEN_FIXTURE);
  try {
    const p = (await readCell(ctx)).patch.live.progress;
    assert.deepEqual(
      p.segments.map((s) => [s.ts, s.phase_kind, s.start_total, s.end_total]),
      [
        [1000, "build", 0, 118],
        [2000, "build", 118, 171],
        [3000, "troubleshooting", 171, 178],
        [4000, "build", 178, 180],
      ],
    );
    assert.deepEqual(p.segments[0].delta, tok(10, 5, 1, 100, 2));
    assert.equal(p.segments[0].phase_name, "Layer 1");
    assert.equal(p.segments[2].phase_index, 1);
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("live progress: byKind sums by phase kind, byPhaseKind by phase identity", async () => {
  const { runsRoot, ctx } = fixture(TOKEN_FIXTURE);
  try {
    const p = (await readCell(ctx)).patch.live.progress;
    assert.deepEqual(p.byKind.build, tok(11, 9, 1, 150, 2)); // A + B + D
    assert.deepEqual(p.byKind.troubleshooting, tok(7, 0, 0, 0, 0)); // C
    assert.deepEqual(
      p.byPhaseKind.map((e) => [e.phase_index, e.phase_kind, e.tokens.total]),
      [
        [1, "build", 171],
        [1, "troubleshooting", 7],
        [2, "build", 2],
      ],
    );
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("live progress: boundaries answer (phase_index, phase_kind) transitions", async () => {
  const { runsRoot, ctx } = fixture(TOKEN_FIXTURE);
  try {
    const p = (await readCell(ctx)).patch.live.progress;
    assert.deepEqual(p.boundaries, [
      { phase_index: 1, phase_kind: "troubleshooting", offset: 171 },
      { phase_index: 2, phase_kind: "build", offset: 178 },
    ]);
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("live progress: a compaction offset is the cumulative total, not tokens_before", async () => {
  const { runsRoot, ctx } = fixture(TOKEN_FIXTURE);
  try {
    const p = (await readCell(ctx)).patch.live.progress;
    assert.deepEqual(p.compactions, [
      { ts: 3500, tokens_before: 99999, offset: 178 },
    ]);
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("live progress: paused toggles on pause.start/pause.end, ts order wins", async () => {
  const { runsRoot, ctx } = fixture(TOKEN_FIXTURE); // ends on pause.start
  const released = fixture([
    cellStart(),
    { v: 1, ts: 1000, kind: "turn.tokens", phase_index: 1, phase_kind: "build", delta: tok(1, 0, 0, 0, 0) },
    { v: 1, ts: 3000, kind: "pause.end", pause_kind: "round", held_s: 2 },
    { v: 1, ts: 2000, kind: "pause.start", pause_kind: "round" },
  ]);
  try {
    assert.equal((await readCell(ctx)).patch.live.progress.paused, true);
    // ts order (not file order): pause.start at 2000 precedes pause.end at 3000.
    const res = await readCell(released.ctx);
    assert.equal(res.patch.live.progress.paused, false);
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
    rmSync(released.runsRoot, { recursive: true, force: true });
  }
});

test("live progress: no turn.tokens states unavailable and zero-fills nothing", async () => {
  const { runsRoot, ctx } = fixture([cellStart("ses_old"), { v: 1, ts: 20, kind: "cell.end", verdict: "worked" }]);
  try {
    const res = await readCell(ctx);
    assert.equal(res.ok, true);
    const p = res.patch.live.progress;
    assert.equal(p.available, false);
    assert.equal(p.totals, undefined, "absence is not a zero total");
    assert.equal(p.byKind, undefined);
    assert.equal(p.segments, undefined);
    assert.equal(p.boundaries, undefined);
    assert.equal(p.compactions, undefined);
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("live progress: an unknown phase_kind folds into the unknown bucket", async () => {
  const { runsRoot, ctx } = fixture([
    cellStart(),
    { v: 1, ts: 1000, kind: "turn.tokens", phase_index: 9, phase_kind: "grade", delta: tok(2, 3, 0, 0, 0) },
  ]);
  try {
    const p = (await readCell(ctx)).patch.live.progress;
    assert.deepEqual(p.byKind.unknown, tok(2, 3, 0, 0, 0));
    assert.equal(p.byKind.build.total, 0, "the named bucket is zero, not missing");
    assert.deepEqual(p.segments[0].phase_kind, "grade", "the segment keeps the record's own spelling");
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});
