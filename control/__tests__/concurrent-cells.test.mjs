// ─────────────────────────────────────────────────────────────────────────────
// LIVE-RUN SET + ONE-CLICK LAUNCH TESTS — the semantics the launcher→ledger
// migration introduced: readRunState reports EVERY live run (per-run
// can_start), the run ledger tracks N slots at once, and /api/run/start
// launches exactly ONE cell per request.
//
// server.mjs listens at import and spawn has no mock seam, so the start
// handler is pinned as SOURCE TEXT — the existing precedent
// (launch-validation.test.mjs:267, launch-argv.test.mjs:15). No cell is
// launched here.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { campaignDirName, campaignTargetFor } from "../campaign.mjs";
import {
  evictRun,
  inFlightModels,
  liveRuns,
  newRunId,
  recordCellEnded,
  registerRun,
  runCount,
} from "../run-ledger.mjs";
import { readRunState } from "../runstate.mjs";

import { HERE } from "./_shared.mjs";

/** A complete ledger record with a fresh run_id; override any field. */
function makeLauncher(overrides = {}) {
  return {
    run_id: newRunId(),
    sequence_index: 0,
    model: "m-a",
    arm: "off",
    kind: "local",
    org: null,
    context: null,
    manifest_arg: null,
    // The test process itself: pidAlive(process.pid) is true, and the tests
    // inject scan: async () => null (a failed scan is indeterminate), so every
    // injected record is live-by-default without a ps-scan seam.
    pid: process.pid,
    started_at: Date.now(),
    log_path: null,
    run_dir: null,
    finished: false,
    terminal_status: null,
    terminal_ok: null,
    ...overrides,
  };
}

/**
 * A run dir on disk plus a launch log naming it (the PROGRESS-path shape
 * runDirOf resolves), with a controlled mtime. Enumeration never reads logs —
 * the mtime is a decoy the ordering test sets AGAINST started_at, so a
 * regression to mtime ordering fails. The log name matches runstate.mjs's
 * newestLog scan pattern /^(off|on)-cell-|^cell-/.
 */
function writeLiveCell(runs, dir, logName, { ageMs = 0 } = {}) {
  mkdirSync(join(runs, dir, "sessions"), { recursive: true });
  const logPath = join(runs, logName);
  writeFileSync(
    logPath,
    `PROGRESS step=worktree-git-init path=${join(runs, dir, "sessions", "cell", "worktree")}\n`,
  );
  const t = new Date(Date.now() - ageMs);
  utimesSync(logPath, t, t);
  return logPath;
}

// ── readRunState: the per-run set ───────────────────────────────────────────

test("RUN STATE: two live runs each block THEMSELVES — can_start is per run, the top level blocks while ANY is live", async () => {
  const root = mkdtempSync(join(tmpdir(), "conc-canstart-"));
  try {
    const runs = join(root, "runs");
    const dirA = campaignDirName("m-a");
    const dirB = campaignDirName("m-b");
    const logA = writeLiveCell(runs, dirA, "off-cell-a.log");
    const logB = writeLiveCell(runs, dirB, "on-cell-b.log");

    const state = await readRunState({
      runsRoot: runs,
      launchers: [
        makeLauncher({ run_id: "run-alpha", model: "m-a", arm: "off", sequence_index: 7, log_path: logA, run_dir: dirA }),
        makeLauncher({ run_id: "run-beta", model: "m-b", arm: "on", sequence_index: 8, log_path: logB, run_dir: dirB }),
      ],
      scan: async () => null,
      heartbeatProbe: async () => 1000,
    });

    assert.equal(state.runs.length, 2, "both live runs are listed — the set is not a single slot");
    assert.equal(state.live_count, 2);
    assert.deepEqual(
      state.runs.map((r) => r.run_id).sort(),
      ["run-alpha", "run-beta"],
    );
    for (const r of state.runs) {
      assert.equal(r.state, "running");
      assert.equal(r.running, true);
      assert.equal(r.can_start, false, "per-run: a cell in flight cannot be started again");
      assert.match(String(r.blocked_reason), /already in flight/);
      assert.ok(
        String(r.blocked_reason).includes(r.run_dir),
        "the per-run reason names THIS cell's own run_dir, never a global serial rule",
      );
      assert.equal(r.launched_by, "control-plane");
      assert.equal(r.liveness, "live");
      assert.equal(r.heartbeat_age_s, 1);
    }
    // The top-level mirror: blocked while ANY live run exists.
    assert.equal(state.can_start, false, "top level: no start while any cell is live");
    assert.equal(state.running, true);
    assert.equal(state.state, "running");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RUN STATE: multiple live runs are listed NEWEST-STARTED-AT-FIRST, each keyed by its run_id", async () => {
  const root = mkdtempSync(join(tmpdir(), "conc-multi-"));
  try {
    const runs = join(root, "runs");
    const dirA = campaignDirName("m-a");
    const dirB = campaignDirName("m-b");
    // A started a minute ago, B just started: the ordering is by started_at,
    // newest first. The log mtimes are set the OTHER way (A's log fresh, B's
    // old) so a regression to mtime ordering would fail.
    const logA = writeLiveCell(runs, dirA, "off-cell-a.log", { ageMs: 0 });
    const logB = writeLiveCell(runs, dirB, "on-cell-b.log", { ageMs: 60_000 });

    const state = await readRunState({
      runsRoot: runs,
      launchers: [
        makeLauncher({ run_id: "run-alpha", model: "m-a", arm: "off", sequence_index: 3, log_path: logA, run_dir: dirA, started_at: Date.now() - 60_000 }),
        makeLauncher({ run_id: "run-beta", model: "m-b", arm: "on", sequence_index: 4, log_path: logB, run_dir: dirB, started_at: Date.now() }),
      ],
      scan: async () => null,
      heartbeatProbe: async () => 1000,
    });

    assert.equal(state.runs.length, 2);
    assert.deepEqual(
      state.runs.map((r) => r.log_name),
      ["on-cell-b.log", "off-cell-a.log"],
      "newest started_at first — the top-level mirror is runs[0]",
    );
    assert.deepEqual(state.runs.map((r) => r.run_id), ["run-beta", "run-alpha"]);
    assert.deepEqual(state.runs.map((r) => r.run_dir), [dirB, dirA], "distinct run dirs, each on its own entry");

    // The per-run entry contract: exactly the keys the board reads.
    assert.deepEqual(Object.keys(state.runs[0]).sort(), [
      "arm", "blocked_reason", "can_start", "heartbeat_age_s", "launched_by",
      "liveness", "log_name", "log_path", "log_silent_s", "model", "pid",
      "run_dir", "run_id", "running", "sequence_index", "session_id",
      "started_at", "state", "terminal_ok", "terminal_status",
    ]);

    // WHICH CELL, not just which run. Every other field is identical across a
    // batch of one model and arm; the index is what an operator selects on.
    assert.deepEqual(state.runs.map((r) => r.sequence_index), [4, 3]);

    // The legacy top-level surface mirrors the NEWEST live run.
    assert.equal(state.log_name, "on-cell-b.log");
    assert.equal(state.run_dir, dirB);
    assert.equal(state.model, "m-b");
    assert.equal(state.pid, process.pid);
    assert.equal(state.live_count, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the N-slot ledger ───────────────────────────────────────────────────────

test("RUN-LEDGER: N slots are tracked at once; finishing one frees its model only when it was the last", () => {
  const recs = [
    makeLauncher({ model: "m-x", sequence_index: 0 }),
    makeLauncher({ model: "m-x", sequence_index: 1 }),
    makeLauncher({ model: "m-y", sequence_index: 2 }),
    makeLauncher({ model: "m-z", sequence_index: 3 }),
  ];
  const N = recs.length;
  try {
    for (const r of recs) registerRun(r);
    assert.equal(runCount(), N, "every concurrent cell holds its own slot");
    assert.equal(liveRuns().length, N);
    assert.deepEqual(
      [...inFlightModels()].sort(),
      ["m-x", "m-y", "m-z"],
      "in flight is the DISTINCT models, not one entry per run",
    );

    // Finish one of the two m-x runs: m-x is STILL in flight — its sibling lives.
    // The ledger is UNBOUND here (no initLedger in this file): recordCellEnded
    // has nothing durable to merge → false, but the cache slot is evicted all
    // the same, which is what these pure-cache assertions read.
    assert.equal(recordCellEnded(recs[0].run_id, null, { reason: "ended" }), false);
    assert.equal(runCount(), N - 1);
    assert.deepEqual([...inFlightModels()].sort(), ["m-x", "m-y", "m-z"]);

    // Finish the UNIQUE m-y run: its model drops out at once, and only it.
    assert.equal(recordCellEnded(recs[2].run_id, null, { reason: "ended" }), false);
    assert.equal(runCount(), N - 2);
    assert.deepEqual(
      [...inFlightModels()].sort(),
      ["m-x", "m-z"],
      "a finished model with no live sibling is no longer in flight; the others are untouched",
    );
  } finally {
    for (const r of recs) evictRun(r.run_id);
  }
  assert.equal(runCount(), 0, "module state leaves no residue for the next test");
});

// ── the cell's ordinal: the campaign log's own length ───────────────────────

test("CAMPAIGN: the target's sequence_index is the recorded log's length — a restart re-derives it, never re-issues it", async () => {
  const root = mkdtempSync(join(tmpdir(), "conc-ordinal-"));
  try {
    const runs = join(root, "runs");
    const dir = campaignDirName("m-a");
    mkdirSync(join(runs, dir), { recursive: true });
    const manifestArg = join(runs, dir, "manifest.json");

    // A fresh campaign: no manifest yet, so this click appends cell 0.
    const fresh = await campaignTargetFor({ model: "m-a", kind: "local" }, runs);
    assert.equal(fresh.manifest_arg, manifestArg);
    assert.equal(fresh.sequence_index, 0, "no recorded log means the first click is ordinal 0");

    // One cell recorded — and a STALE current_index, which is exactly what made
    // a restart re-issue an index: the control plane used to seed a cursor from
    // it, and a --sequence-index run never advanced it. The log's own length is
    // the ordinal the harness will stamp.
    writeFileSync(manifestArg, JSON.stringify({
      created_at: "2026-09-20T00:00:00Z",
      current_index: 0,
      schedule: [{ sequence_index: 0, memory_mode: "off" }],
      session_records: [{ sequence_index: 0 }],
    }));

    const first = await campaignTargetFor({ model: "m-a", kind: "local" }, runs);
    assert.equal(first.sequence_index, 1, "the next append is the log's length, never a stored counter");
    assert.equal(
      (await campaignTargetFor({ model: "m-a", kind: "local" }, runs)).sequence_index,
      1,
      "a second read of the same durable state answers the same thing — there is no cursor to carry",
    );

    // The harness appends; the next click follows the grown log.
    writeFileSync(manifestArg, JSON.stringify({
      schedule: [{ sequence_index: 0 }, { sequence_index: 1 }],
      session_records: [{ sequence_index: 0 }, { sequence_index: 1 }],
    }));
    assert.equal(
      (await campaignTargetFor({ model: "m-a", kind: "local" }, runs)).sequence_index,
      2,
      "each click appends one cell and the next click reads the grown log",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the start endpoint: ONE click = ONE run, source-pinned ───────────────────

test("START: one request launches exactly ONE cell — no concurrency, no cursor, no plan band", () => {
  const src = readFileSync(join(HERE, "routes", "run.mjs"), "utf8");
  const start = src.indexOf('path: "/api/run/start"');
  assert.notEqual(start, -1, "the /api/run/start route disappeared");
  // The NEXT route after start bounds the slice: there is one path per route
  // entry, so the following `path:` literal is the handler's end.
  const end = src.indexOf('path: "/api/run/stop/preview"', start);
  assert.notEqual(end, -1, "could not find the end of the start handler");
  const handler = src.slice(start, end);

  // 1. There is no batch: no count is parsed, nothing is refused for one, and
  //    no loop launches more than the single cell this request is.
  assert.doesNotMatch(handler, /concurrency/, "the handler must not read a cell count from the payload");
  assert.doesNotMatch(handler, /bad_concurrency/, "no cell count means no count refusal");
  assert.doesNotMatch(handler, /for \(let i = 0/, "a request is not a loop over cells");

  // 2. The sequence cursor is gone: the harness appends the cell itself, so the
  //    launcher allocates nothing and hands over no index or plan size.
  assert.doesNotMatch(handler, /allocateSequenceIndex/, "the launcher allocates no index");
  assert.doesNotMatch(handler, /"--sequence-index"/, "the harness assigns its own append ordinal");
  assert.doesNotMatch(handler, /"--off-replicates"/, "there is no band to plan");
  assert.doesNotMatch(handler, /"--on-budget"/, "there is no band to grow");
  assert.doesNotMatch(handler, /offBand|recordedOffBand|no_baseline|on_band_mismatch/,
    "the recorded-band refusals went with the band");

  // 3. Exactly one process: the argv array is spawned once, as built.
  const spawns = [...handler.matchAll(/spawn\(PYTHON/g)];
  assert.equal(spawns.length, 1, `expected exactly one spawn, found ${spawns.length}`);
  assert.match(handler, /spawn\(PYTHON, argv,/, "the one spawn takes the single argv array");
  assert.match(
    handler,
    /argv\.push\("run", "--mode", arm, compact \? "--compact" : "--no-compact"\)/,
    "the harness is told the arm and nothing about cell position",
  );

  // 4. One ledger slot, one durable record, keyed on this run's id.
  assert.equal([...handler.matchAll(/registerRun\(\{/g)].length, 1, "one run, one ledger slot");
  assert.match(handler, /run_id: runId/, "the slot is keyed on the control-plane run_id");
  assert.match(handler, /sequence_index: sequenceIndex/, "the record carries the campaign's claim");

  // 5. The response is the single-run shape the dashboard consumer reads — not
  //    a per-cell runs[] array.
  assert.match(handler, /sendJson\(res, 200, \{ ok: true, pid, log_path: logPath, tree_error \}\)/);
  assert.doesNotMatch(handler, /\bruns,\n/, "no runs[] array in the response");

  // 6. The pause is the SERVER's dev mode, never a request field.
  assert.match(handler, /resolveDevMode\(\{ benchRoot: BENCH_ROOT \}\)/, "dev mode is read server-side");
  assert.match(handler, /if \(devPause\) argv\.push\("--pause-after-grade"\)/);
  assert.doesNotMatch(handler, /payload\.pauseAfterGrade/, "the pause never comes off the wire");
});

