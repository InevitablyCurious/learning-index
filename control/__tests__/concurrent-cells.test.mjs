// ─────────────────────────────────────────────────────────────────────────────
// N-CONCURRENT-CELLS TESTS — the semantics the launcher→ledger migration
// introduced: readRunState reports EVERY live run (per-run can_start), the
// run ledger tracks N slots at once, the sequence-index cursor is atomic
// across concurrent starts, and /api/run/start launches a batch of N.
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
import { dirname, join } from "node:path";

import { allocateSequenceIndex, campaignDirName } from "../campaign.mjs";
import {
  inFlightModels,
  liveRuns,
  markRunFinished,
  newRunId,
  registerRun,
  runCount,
  unregisterRun,
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
    // The test process itself: pidAlive(process.pid) is true, so a record
    // matched by log_path classifies live without a ps-scan seam.
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
 * runDirOf resolves), with a controlled mtime for the newest-first ordering.
 * The log name matches runstate.mjs's scan pattern /^(off|on)-cell-|^cell-/.
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
      aliveProbe: async () => true,
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
        String(r.blocked_reason).includes(r.log_name),
        "the per-run reason names THIS cell's own log, never a global serial rule",
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

test("RUN STATE: multiple live runs are listed NEWEST-LOG-FIRST, each keyed by its run_id", async () => {
  const root = mkdtempSync(join(tmpdir(), "conc-multi-"));
  try {
    const runs = join(root, "runs");
    const dirA = campaignDirName("m-a");
    const dirB = campaignDirName("m-b");
    // A is a minute old, B is fresh: the ordering is by log mtime, newest first.
    const logA = writeLiveCell(runs, dirA, "off-cell-a.log", { ageMs: 60_000 });
    const logB = writeLiveCell(runs, dirB, "on-cell-b.log", { ageMs: 0 });

    const state = await readRunState({
      runsRoot: runs,
      launchers: [
        makeLauncher({ run_id: "run-alpha", model: "m-a", arm: "off", sequence_index: 3, log_path: logA, run_dir: dirA }),
        makeLauncher({ run_id: "run-beta", model: "m-b", arm: "on", sequence_index: 4, log_path: logB, run_dir: dirB }),
      ],
      aliveProbe: async () => true,
      heartbeatProbe: async () => 1000,
    });

    assert.equal(state.runs.length, 2);
    assert.deepEqual(
      state.runs.map((r) => r.log_name),
      ["on-cell-b.log", "off-cell-a.log"],
      "newest log first — the top-level mirror is runs[0]",
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
    assert.equal(markRunFinished(recs[0].run_id, { terminal_status: "done", terminal_ok: true }), true);
    assert.equal(runCount(), N - 1);
    assert.deepEqual([...inFlightModels()].sort(), ["m-x", "m-y", "m-z"]);

    // Finish the UNIQUE m-y run: its model drops out at once, and only it.
    assert.equal(markRunFinished(recs[2].run_id, { terminal_status: "done", terminal_ok: true }), true);
    assert.equal(runCount(), N - 2);
    assert.deepEqual(
      [...inFlightModels()].sort(),
      ["m-x", "m-z"],
      "a finished model with no live sibling is no longer in flight; the others are untouched",
    );
  } finally {
    for (const r of recs) unregisterRun(r.run_id);
  }
  assert.equal(runCount(), 0, "module state leaves no residue for the next test");
});

// ── the atomic sequence-index cursor ────────────────────────────────────────

test("CAMPAIGN: allocateSequenceIndex is atomic across concurrent starts, seeded from the manifest it never writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "conc-seq-"));
  try {
    const manifestArg = join(root, "cumulative-m-a", "manifest.json");
    mkdirSync(dirname(manifestArg), { recursive: true });
    writeFileSync(
      manifestArg,
      JSON.stringify({
        created_at: "2026-09-20T00:00:00Z",
        current_index: 7,
        // The bound the cursor must respect: the harness refuses
        // --sequence-index >= the schedule length (sequencer.py:168-175).
        // Length 20 covers every index this test allocates (7..19).
        schedule: Array.from({ length: 20 }, (_, i) => ({ sequence_index: i })),
      }),
    );
    const before = readFileSync(manifestArg, "utf8");

    // Sequential calls: consecutive from the seed.
    const seq = [];
    for (let i = 0; i < 5; i += 1) seq.push(await allocateSequenceIndex(manifestArg));
    assert.deepEqual(seq, [7, 8, 9, 10, 11], "seeded from manifest.current_index, +1 per call");

    // CONCURRENT calls — the N-start batch racing a sibling request: every
    // caller gets its own index. The seed promise is deduplicated and the
    // read-then-increment is synchronous, so no await sits between get and set.
    const conc = await Promise.all(
      Array.from({ length: 8 }, () => allocateSequenceIndex(manifestArg)),
    );
    assert.equal(new Set(conc).size, 8, "no two concurrent starts share an index");
    assert.deepEqual(
      [...conc].sort((a, b) => a - b),
      [12, 13, 14, 15, 16, 17, 18, 19],
      "the concurrent batch continues the same consecutive run",
    );

    // The cursor is in-memory only: the manifest is NEVER written — a running
    // cell's _checkpoint is a full-manifest atomic_write that would clobber it.
    assert.equal(readFileSync(manifestArg, "utf8"), before, "the manifest is untouched");

    // An absent manifest is a fresh campaign: no schedule exists to bound
    // against yet, so the cursor is unbounded and its first cell is index 0.
    const fresh = join(root, "no-such-campaign", "manifest.json");
    assert.deepEqual(
      [await allocateSequenceIndex(fresh), await allocateSequenceIndex(fresh)],
      [0, 1],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CAMPAIGN: allocateSequenceIndex refuses indices past the schedule length — the harness's range check, enforced upfront", async () => {
  const root = mkdtempSync(join(tmpdir(), "conc-seq-bound-"));
  try {
    const manifestArg = join(root, "cumulative-m-b", "manifest.json");
    mkdirSync(dirname(manifestArg), { recursive: true });
    writeFileSync(
      manifestArg,
      JSON.stringify({
        created_at: "2026-09-20T00:00:00Z",
        current_index: 0,
        schedule: Array.from({ length: 3 }, (_, i) => ({ sequence_index: i })),
      }),
    );

    // Within the bound: seeded-consecutive, exactly as before.
    assert.deepEqual(
      [
        await allocateSequenceIndex(manifestArg),
        await allocateSequenceIndex(manifestArg),
        await allocateSequenceIndex(manifestArg),
      ],
      [0, 1, 2],
      "indices inside the schedule length allocate as before",
    );

    // The 4th allocation is past the schedule: refused upfront, naming the
    // range — the harness would refuse --sequence-index 3 cell-by-cell
    // (sequencer.py:168-175), so the pre-flight loop refuses the whole batch
    // before any spawn. No clamp, no degrade to current_index selection.
    await assert.rejects(
      allocateSequenceIndex(manifestArg),
      /sequence_index 3 out of range: manifest schedule has 3 session_record\(s\); valid indices are 0\.\.2/,
      "an over-range index throws with the valid range named",
    );

    // The refusal throws BEFORE the increment: the over-range index is not
    // consumed, so a retry refuses identically (no silent cursor drift).
    await assert.rejects(
      allocateSequenceIndex(manifestArg),
      /sequence_index 3 out of range/,
      "the refused index is not burned — the cursor stays at the bound",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the start endpoint, source-pinned ───────────────────────────────────────

test("START: one request launches N cells — concurrency, atomic indices, per-cell argv/logs/ledger slots", () => {
  const src = readFileSync(join(HERE, "routes", "run.mjs"), "utf8");
  const start = src.indexOf('path: "/api/run/start"');
  assert.notEqual(start, -1, "the /api/run/start route disappeared");
  const end = src.indexOf('path: "/api/run/resume"', start);
  assert.notEqual(end, -1, "could not find the end of the start handler");
  const handler = src.slice(start, end);

  // 1. concurrency is parsed from the payload, defaults to 1, and a bad value
  //    is a named 400 — never a silent fallback.
  assert.match(handler, /payload\.concurrency/, "the handler reads concurrency from the payload");
  assert.match(handler, /concurrency === undefined \? 1/, "absent concurrency means 1");
  assert.match(handler, /bad_concurrency/, "a bad concurrency is refused by name");
  assert.match(
    handler,
    /Number\.isInteger\(concurrency\) \|\| concurrency < 1/,
    "positive integers only",
  );

  // 2. The whole batch is pre-flighted BEFORE the first spawn: N indices from
  //    the atomic cursor, N open logs — a half-launched batch is refused whole.
  assert.match(handler, /for \(let i = 0; i < concurrency; i \+= 1\)/, "the pre-flight loop runs N times");
  const allocAt = handler.indexOf("allocateSequenceIndex(");
  assert.ok(allocAt > -1, "the batch allocates from the campaign's atomic cursor");
  const spawnAt = handler.indexOf("spawn(PYTHON");
  assert.ok(spawnAt > -1, "the handler spawns the harness");
  assert.ok(allocAt < spawnAt, "every index is allocated in pre-flight, before any spawn");

  // 3. The per-cell argv differs in exactly one flag: its --sequence-index.
  assert.match(
    handler,
    /"--sequence-index", String\(cell\.sequence_index\)/,
    "each cell carries its own index on argv",
  );

  // 4. Every spawned cell takes an N-slot ledger slot, keyed on its run_id.
  assert.match(handler, /registerRun\(\{/, "each launched cell registers in the run ledger");
  assert.match(handler, /run_id: cell\.run_id/, "the slot is keyed on the control-plane run_id");

  // 5. N logs of one second stay distinct: the padded index suffix (and the
  //    name keeps runstate.mjs's /^(off|on)-cell-|^cell-/ scan pattern).
  assert.ok(
    handler.includes('${arm}-cell-${stamp}-s${String(sequenceIndex).padStart(4, "0")}.log'),
    "per-cell log names carry the padded sequence index — N logs of one second never collide",
  );

  // 6. The response is per cell: runs[] plus the tree health, never a bare ok.
  assert.match(handler, /ok: true,\s*\n\s*runs,/, "success carries runs[], one record per cell");
  assert.match(handler, /tree_error/, "and the tree health rides along");
});
