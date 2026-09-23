// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION: the live stream is written into the CELL directory.
//
// `LiveStream.for_run(run_dir)` is called from `backgammon.py::run_cell`, where
// `run_dir` is the cell's directory — so the file lands at
// `<campaign>/memory<ARM>/cell-<seq>/live.jsonl`, one level BELOW the campaign
// directory `activeRun()` resolves. Both readers used to join the bare filename
// onto `run.dir`, which opened a path that never exists and reported
// "no live.jsonl yet" — a reason indistinguishable from a run that legitimately
// never wrote a stream. The gate wall and the learning matrix therefore stayed
// empty for the entire life of every run.
//
// These tests pin the three facts that fix depends on.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cellLiveStreamPath } from "../control/board/sources/_runtime.mjs";
import * as liveStream from "../control/board/sources/live-stream.mjs";
import * as learning from "../control/board/sources/learning.mjs";

const ROSTER = {
  total: 3,
  enumeration: { complete: true },
  gates: [
    { id: "CONF", phase: "conformance", title: "conformance pre-gate" },
    { id: "backend/a.test.ts::alpha", phase: "backend", title: "alpha" },
    { id: "frontend/b.test.ts::beta", phase: "frontend", title: "beta" },
  ],
};

const STREAM = [
  { v: 1, ts: 1, kind: "cell.start", session_id: "ses_LIVE", cell_seq: 0, arm: "off" },
  { v: 1, ts: 2, kind: "gate.result", session_id: "ses_LIVE", attempt: 1, id: "CONF", status: "pass", phase: "conformance" },
  { v: 1, ts: 3, kind: "gate.result", session_id: "ses_LIVE", attempt: 1, id: "backend/a.test.ts::alpha", status: "fail", phase: "backend" },
  { v: 1, ts: 4, kind: "attempt.end", session_id: "ses_LIVE", attempt: 1, verdict: "fail", failed: 1 },
  { v: 1, ts: 5, kind: "gate.result", session_id: "ses_LIVE", attempt: 2, id: "backend/a.test.ts::alpha", status: "pass", phase: "backend" },
];

/** A campaign whose stream sits where the harness actually writes it. */
async function fixture({ stream = STREAM, outcomes = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "livestream-"));
  const runs = join(root, "runs");
  const campaign = join(runs, "9999000000", "cloud", "p", "m", "mm");
  const cell = join(campaign, "memoryOFF", "cell-0000");
  await mkdir(cell, { recursive: true });
  await writeFile(
    join(campaign, "manifest.json"),
    JSON.stringify({ created_at: "2099-01-01T00:00:00Z", org_id: "o", task: "t", roster: [{ model: "synthetic/model" }] }),
  );
  await writeFile(join(campaign, "gate-roster.json"), JSON.stringify(ROSTER));
  if (stream) await writeFile(join(cell, "live.jsonl"), stream.map((r) => JSON.stringify(r)).join("\n") + "\n");
  if (outcomes) {
    await writeFile(join(campaign, "predicate-outcomes.jsonl"), outcomes.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  const address = { run_dir: "9999000000/cloud/p/m/mm", sequence_index: 0 };
  return { ctx: { runsRoot: runs, benchRoot: root, cell: address }, runs, campaign, cell, address };
}

test("cellLiveStreamPath finds the cell's stream in its own directory, not the campaign root", async () => {
  const { runs, cell, address } = await fixture();
  assert.equal(await cellLiveStreamPath(runs, address), join(cell, "live.jsonl"));
});

test("cellLiveStreamPath returns null rather than guessing when the cell does not exist", async () => {
  const { runs, address } = await fixture({ stream: null });
  assert.equal(await cellLiveStreamPath(runs, { ...address, sequence_index: 7 }), null);
  assert.equal(await cellLiveStreamPath(runs, null), null);
  assert.equal(await cellLiveStreamPath(runs, { run_dir: address.run_dir }), null);
});

// ── TWO CELLS, EACH ITS OWN ──────────────────────────────────────────────────
// A campaign holds one cell dir per concurrent cell. The resolver used to
// return whichever stream had the NEWEST mtime, so with N cells writing the
// board flipped between them with every write. Each address now resolves its
// own stream, whatever the other cells' mtimes.

test("cellLiveStreamPath resolves each cell's own stream, whatever the mtimes", async () => {
  const root = await mkdtemp(join(tmpdir(), "livestream2-"));
  const runs = join(root, "runs");
  const cells = [0, 1].map((n) => join(runs, "camp", "memoryOFF", `cell-000${n}`));
  for (const c of cells) {
    await mkdir(c, { recursive: true });
    await writeFile(join(c, "live.jsonl"), JSON.stringify(STREAM[0]) + "\n");
  }
  const [a, b] = cells.map((c) => join(c, "live.jsonl"));
  await utimes(a, new Date(1000), new Date(1000));
  await utimes(b, new Date(2000), new Date(2000));
  assert.equal(await cellLiveStreamPath(runs, { run_dir: "camp", sequence_index: 0 }), a, "cell 0 is cell 0 even when cell 1 wrote last");
  assert.equal(await cellLiveStreamPath(runs, { run_dir: "camp", sequence_index: 1 }), b);
});

test("gate wall reads verdicts from the cell-directory stream; later attempt wins", async () => {
  const { ctx } = await fixture();
  const res = await liveStream.readCell(ctx);
  assert.equal(res.ok, true, res.reason);
  const { live } = res.patch;
  assert.equal(live.session_id, "ses_LIVE");
  assert.equal(live.arm, "off");
  assert.equal(live.attempt, 2);
  // alpha failed on attempt 1 and passed on attempt 2 — the repair supersedes.
  const alpha = live.gates.find((g) => g.id === "backend/a.test.ts::alpha");
  assert.equal(alpha.status, "pass");
  assert.equal(alpha.attempt, 2);
  assert.deepEqual(live.gate_counts, { pass: 2, fail: 0, other: 0 });
});

test("learning matrix fills from the live stream before any post-mortem file exists", async () => {
  const { ctx } = await fixture();
  const { learning: L } = (await learning.readCell(ctx)).patch;
  // Session resolution no longer waits for predicate-outcomes.jsonl.
  assert.equal(L.session_id, "ses_LIVE");
  assert.equal(L.attempt.current, 2);
  assert.equal(L.cell.memory_mode, "off");
  assert.equal(L.cell.sequence_index, 0);
  const byId = new Map(L.matrix.gates.map((g) => [g.id, g.outcomes]));
  assert.deepEqual(byId.get("CONF"), ["pass", null, null, null, null]);
  // The repair trajectory is visible while the cell is still running.
  assert.deepEqual(byId.get("backend/a.test.ts::alpha"), ["fail", "pass", null, null, null]);
  // A gate the stream never named stays untested — the stream only ADDS.
  assert.deepEqual(byId.get("frontend/b.test.ts::beta"), [null, null, null, null, null]);
  assert.equal(L.matrix.total, 3);
});

test("predicate-outcomes.jsonl stays authoritative once the campaign writes it", async () => {
  const { ctx } = await fixture({
    outcomes: [
      // Disagrees with the live stream on CONF, and names the final session.
      { gate_id: "CONF", attempt: 1, predicate_outcome: "fail", session_id: "ses_FINAL", memory_mode: "off", sequence_index: 0 },
      { gate_id: "frontend/b.test.ts::beta", attempt: 2, predicate_outcome: "pass", session_id: "ses_FINAL", sequence_index: 0 },
      // Another cell's row in the same campaign file: never this cell's matrix.
      { gate_id: "frontend/b.test.ts::beta", attempt: 3, predicate_outcome: "fail", session_id: "ses_OTHER", sequence_index: 1 },
    ],
  });
  const { learning: L } = (await learning.readCell(ctx)).patch;
  assert.equal(L.session_id, "ses_FINAL");
  const byId = new Map(L.matrix.gates.map((g) => [g.id, g.outcomes]));
  // Post-mortem overwrites the live verdict for the same (gate, attempt)...
  assert.deepEqual(byId.get("CONF"), ["fail", null, null, null, null]);
  // ...while live-only rows are retained rather than dropped.
  assert.deepEqual(byId.get("backend/a.test.ts::alpha"), ["fail", "pass", null, null, null]);
  assert.deepEqual(byId.get("frontend/b.test.ts::beta"), [null, "pass", null, null, null]);
});

// ── THE TRAJECTORY SURVIVES THE FOLD ────────────────────────────────────────
//
// The gate runner re-grades the WHOLE suite on every attempt, so a gate that
// passed on attempt 1 emits `pass` again on attempt 2. The source used to keep
// only the newest record per gate, which destroyed the trajectory; the wall
// then had nothing to compute "first passed on attempt N" from and used the
// newest attempt instead. Measured on a live run: 65 gates that passed first
// try all rendered as `recovered` with a "2" in them, claiming a repair that
// never happened. Attempts-to-green is a headline measurement of this bench.

const REGRADED = [
  { v: 1, ts: 1, kind: "cell.start", session_id: "ses_T", cell_seq: 0, arm: "off" },
  // attempt 1: one pass, one fail
  { v: 1, ts: 2, kind: "gate.result", session_id: "ses_T", attempt: 1, id: "CONF", status: "pass", phase: "conformance" },
  { v: 1, ts: 3, kind: "gate.result", session_id: "ses_T", attempt: 1, id: "backend/a.test.ts::alpha", status: "fail", phase: "backend" },
  { v: 1, ts: 4, kind: "attempt.end", session_id: "ses_T", attempt: 1, verdict: "FAIL", failed: 1 },
  // attempt 2: the whole suite is re-graded — CONF passes AGAIN, alpha repairs
  { v: 1, ts: 5, kind: "gate.result", session_id: "ses_T", attempt: 2, id: "CONF", status: "pass", phase: "conformance" },
  { v: 1, ts: 6, kind: "gate.result", session_id: "ses_T", attempt: 2, id: "backend/a.test.ts::alpha", status: "pass", phase: "backend" },
  { v: 1, ts: 7, kind: "attempt.end", session_id: "ses_T", attempt: 2, verdict: "PASS", failed: 0 },
];

test("a re-graded pass does not overwrite the attempt a gate FIRST passed on", async () => {
  const { ctx } = await fixture({ stream: REGRADED });
  const { live } = (await liveStream.readCell(ctx)).patch;
  const byId = new Map(live.gates.map((g) => [g.id, g]));

  // Passed first try, re-graded pass on attempt 2. It never failed, so it is
  // green — NOT a repair, and it carries no attempt number on the wall.
  const conf = byId.get("CONF");
  assert.equal(conf.status, "pass");
  assert.equal(conf.first_pass_attempt, 1, "a re-grade must not push first_pass_attempt to 2");
  assert.equal(conf.ever_failed, false);

  // Genuinely repaired: failed on 1, passed on 2.
  const alpha = byId.get("backend/a.test.ts::alpha");
  assert.equal(alpha.status, "pass");
  assert.equal(alpha.first_pass_attempt, 2);
  assert.equal(alpha.ever_failed, true);
});

test("the wall draws a digit only on the gate that actually needed repair", async () => {
  const { ctx } = await fixture({ stream: REGRADED });
  const { live } = (await liveStream.readCell(ctx)).patch;

  const { renderWall } = await import("./panels/wall.js");
  const gates = [
    { id: "CONF", state: "untested" },
    { id: "backend/a.test.ts::alpha", state: "untested" },
    { id: "frontend/b.test.ts::beta", state: "untested" },
  ];
  const html = renderWall({ suite: { suite: { total: 3 }, gates, totals: null, attempt: null }, live });

  // Exactly one numbered square, and it is the repair.
  const marks = [...html.matchAll(/<span class="gcell (\w+)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(
    marks,
    [["green", ""], ["recovered", "2"], ["unobserved", ""]],
    "green-first-try must stay unnumbered; only the repaired gate carries its attempt",
  );
});

test("the cell's phase and chunk are the producer's phase.start, not the log's last finished chunk", async () => {
  const { ctx } = await fixture({
    stream: [
      { v: 1, ts: 1, kind: "cell.start", session_id: "ses_P", cell_seq: 0, arm: "off" },
      { v: 1, ts: 2, kind: "phase.start", phase: "initial-chunk-2" },
      { v: 1, ts: 3, kind: "phase.start", phase: "initial-chunk-3" },
    ],
  });
  const { run } = (await liveStream.readCell(ctx)).patch;
  assert.equal(run.phase, "initial-chunk-3");
  assert.equal(run.chunk.current, 3);
  // No phase.start: nothing stated, so nothing overwrites run-log's answer.
  const bare = await fixture({ stream: [{ v: 1, ts: 1, kind: "cell.start", session_id: "s", cell_seq: 0 }] });
  assert.equal((await liveStream.readCell(bare.ctx)).patch.run, null);
});
