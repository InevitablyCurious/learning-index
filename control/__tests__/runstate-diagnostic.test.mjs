// ─────────────────────────────────────────────────────────────────────────────
// RUN-STATE DIAGNOSTIC TESTS — split VERBATIM from control/control.test.mjs
// (lines 2912–3258; shared treeFixture/campaignAt live in ./_shared.mjs).
// Local helpers kept here: NODE_WARNING_STDERR, writeGradabilityRun,
// trajectoryAttempts. Run: cd control && node --test
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { campaignDirName } from "../campaign.mjs";
import { readRunState } from "../runstate.mjs";
import { DEFAULT_RUN_DIR, foldGateStates, readWall } from "../wall.mjs";
import { firstMeaningfulLine, runnerFailureObserved } from "../../grader/gate-results.mjs";
import { BENCH, writeCampaignCell } from "./_shared.mjs";

test("RUN STATE: the resolved run directory is PUBLISHED, not dropped as null", async () => {
  const root = mkdtempSync(join(tmpdir(), "rundir-"));
  try {
    const runs = join(root, "runs");
    const dir = campaignDirName("minimax/minimax-m3");
    writeCampaignCell(runs, dir, {
      gates: [{ id: "CONF" }],
      results: [{ id: "CONF", status: "pass" }],
    });

    // A LIVE run publishes its resolved directory: per-run in runs[] and on the
    // top-level mirror of the newest live run.
    const state = await readRunState({
      runsRoot: runs,
      launchers: [],
      aliveProbe: async () => true,
      heartbeatProbe: async () => 1000,
    });
    assert.equal(state.runs.length, 1);
    assert.equal(
      state.runs[0].run_dir,
      dir,
      "the log names its run directory and the contract declares the field — publishing null " +
        "forces every run-scoped reader back onto a default that a per-model campaign invalidates",
    );
    assert.equal(state.run_dir, dir, "the top-level mirror carries the newest live run's directory");

    // AN ABANDONED RUN DROPS OUT. No terminal record and no process is not a
    // live run: it leaves runs[] at once, and with nothing live the top level
    // is the idle shape — run_dir null is correct THERE because there is no run.
    const dead = await readRunState({ runsRoot: runs, launchers: [], aliveProbe: async () => false });
    assert.deepEqual(dead.runs, [], "a killed run is not a live run and never re-enters the set");
    assert.equal(dead.live_count, 0);
    assert.equal(dead.state, "idle");
    assert.equal(dead.run_dir, null);
    assert.equal(dead.can_start, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WALL: a per-model campaign's outcomes are served, never a zeroed suite", async () => {
  const root = mkdtempSync(join(tmpdir(), "wall-campaign-"));
  try {
    const runs = join(root, "runs");
    const dir = campaignDirName("minimax/minimax-m3");
    writeCampaignCell(runs, dir, {
      gates: [{ id: "CONF" }, { id: "A" }, { id: "B" }],
      results: [
        { id: "CONF", status: "pass" },
        { id: "A", status: "fail" },
        { id: "B", status: "not_run" },
      ],
    });

    // What the server now passes: the run directory resolved from the log. The
    // run must be LIVE to resolve — an abandoned log drops out of runs[] and the
    // mirror goes idle, which is the drop-out truth pinned in the test above.
    const runDir = (
      await readRunState({
        runsRoot: runs,
        launchers: [],
        aliveProbe: async () => true,
        heartbeatProbe: async () => 1000,
      })
    ).run_dir;
    const wall = await readWall({ runsRoot: runs, runDir });

    assert.equal(wall.run_dir, dir);
    assert.equal(wall.suite_source, "run", "the run's own pinned roster is authoritative");
    assert.deepEqual(wall.totals, { passing: 1, failing: 1, untested: 1 });
    assert.deepEqual(wall.unwired, [], "outcomes exist, so nothing is unwired");

    // AND THE DEFAULT ALONE IS NOT THE ANSWER. Naming no run directory falls
    // back to `cumulative`, which this campaign never wrote — the read must
    // report that as unwired rather than as a suite nobody passed.
    const stale = await readWall({ runsRoot: runs, runDir: null });
    assert.equal(stale.run_dir, DEFAULT_RUN_DIR);
    assert.ok(
      stale.unwired.includes("gate-roster"),
      "an absent run directory is unwired-with-a-reason, never a wall of zeroes",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION: 53 UNMEASURED GATES, EXPLAINED BY A NODE WARNING.
//
// When a runner exits nonzero with no failing test, the suite did not finish and
// every gate it never reached is recorded `not_run`. That string is the ONLY
// account of why. On the 2026-08-17 minimax-m3 cell it was
// "(node:43741) PromiseRejectionHandledWarning: ... (rejection id: 19)" —
// stderr's first line, and pure boilerplate — recorded against 53 gates, twice.
// ─────────────────────────────────────────────────────────────────────────────

/** Verbatim stderr from that cell's aborted backend phase. */
const NODE_WARNING_STDERR = [
  "(node:43741) PromiseRejectionHandledWarning: Promise rejection was handled asynchronously (rejection id: 19)",
  "(Use `node --trace-warnings ...` to show where the warning was created)",
  "(node:43741) PromiseRejectionHandledWarning: Promise rejection was handled asynchronously (rejection id: 250)",
].join("\n");

test("DIAGNOSTIC: Node's own warnings are never mistaken for the failure", () => {
  assert.equal(
    firstMeaningfulLine(NODE_WARNING_STDERR),
    "",
    "a stderr made entirely of Node boilerplate yields NO explanation, rather than a confident wrong one",
  );
  assert.equal(
    firstMeaningfulLine(`${NODE_WARNING_STDERR}\nError: listen EADDRINUSE :::8002`),
    "Error: listen EADDRINUSE :::8002",
    "the real line is selected even when warnings precede it",
  );
});

test("DIAGNOSTIC: an aborted runner reports how it died and how far it got", () => {
  const observed = runnerFailureObserved(
    "backend",
    { status: 1, signal: null, stderr: NODE_WARNING_STDERR },
    { reported: 7, expected: 56 },
  );

  assert.match(observed, /runner exited 1/, "how the process ended");
  assert.match(observed, /reported 7 of 56 gate results/, "how far it got — the gap IS the finding");
  assert.match(observed, /no test failed/, "and that nothing was measured as failing");
  assert.ok(
    !observed.includes("PromiseRejectionHandledWarning"),
    "the warning that used to be the entire explanation does not appear",
  );
});

test("DIAGNOSTIC: a KILLED runner is not reported as one that merely exited", () => {
  const killed = runnerFailureObserved(
    "backend",
    { status: null, signal: "SIGKILL", stderr: "" },
    { reported: 0, expected: 56 },
  );
  assert.match(killed, /killed by SIGKILL/);

  const exited = runnerFailureObserved("backend", { status: 2, signal: null, stderr: "" }, {});
  assert.match(exited, /exited 2/);
  assert.ok(!exited.includes("killed"), "and the two are never conflated");
});

test("DIAGNOSTIC: a spawn failure names itself rather than the exit code", () => {
  const observed = runnerFailureObserved(
    "frontend",
    { error: new Error("spawn npx ENOENT"), stderr: "" },
    {},
  );
  assert.match(observed, /spawn failed: spawn npx ENOENT/);
});

// ─────────────────────────────────────────────────────────────────────────────
// GRADABILITY — an aborted runner does not publish a score.
//
// The minimax-m3 cell published `16/71 pass` with `backend:runner` sitting in
// `failed_gates`, so a harness abort reached the board as a gate the MODEL
// failed, inside a ratio that read like a result. That worktree scores 69/71.
// ─────────────────────────────────────────────────────────────────────────────

/** A status stream whose newest attempt carries an explicit gradability. */
function writeGradabilityRun(runs, dir, attempt) {
  mkdirSync(join(runs, dir), { recursive: true });
  writeFileSync(
    join(runs, dir, "gate-roster.json"),
    JSON.stringify({ total: 2, enumeration: { complete: true }, gates: [{ id: "A" }, { id: "B" }] }),
  );
  writeFileSync(
    join(runs, dir, "manifest.status.jsonl"),
    JSON.stringify({
      type: "attempt",
      attempt: 1,
      gate_results: [
        { id: "A", status: "pass" },
        { id: "B", status: "not_run" },
      ],
      ...attempt,
    }) + "\n",
  );
}

test("WALL: an ungradable attempt is published as ungradable, with its reason", async () => {
  const root = mkdtempSync(join(tmpdir(), "gradable-"));
  try {
    const runs = join(root, "runs");
    writeGradabilityRun(runs, "cumulative", {
      gradable: false,
      ungradable_reason: "backend gates-13-16.test.ts aborted without reporting a failing test",
      aborted_runners: ["backend gates-13-16.test.ts"],
    });

    const wall = await readWall({ runsRoot: runs, runDir: "cumulative" });
    assert.equal(wall.gradable, false);
    assert.match(wall.ungradable_reason, /aborted without reporting a failing test/);
    assert.deepEqual(wall.aborted_runners, ["backend gates-13-16.test.ts"]);

    // The squares are UNAFFECTED — gradability answers "was this measured",
    // never "did it pass", and must not repaint a single gate.
    assert.deepEqual(wall.totals, { passing: 1, failing: 0, untested: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WALL: gradability is null — never true — for an attempt recorded before the field", async () => {
  const root = mkdtempSync(join(tmpdir(), "gradable-legacy-"));
  try {
    const runs = join(root, "runs");
    writeGradabilityRun(runs, "cumulative", {});

    const wall = await readWall({ runsRoot: runs, runDir: "cumulative" });
    assert.equal(
      wall.gradable,
      null,
      "an attempt nothing checked is of UNKNOWN gradability; defaulting to true would vouch for it",
    );
    assert.equal(wall.ungradable_reason, null);
    assert.deepEqual(wall.aborted_runners, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WALL: a completed run is gradable and carries no reason", async () => {
  const root = mkdtempSync(join(tmpdir(), "gradable-ok-"));
  try {
    const runs = join(root, "runs");
    writeGradabilityRun(runs, "cumulative", { gradable: true, ungradable_reason: null, aborted_runners: [] });

    const wall = await readWall({ runsRoot: runs, runDir: "cumulative" });
    assert.equal(wall.gradable, true);
    assert.equal(wall.ungradable_reason, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── PER-FILE BACKEND INVOCATION ─────────────────────────────────────────────

test("REPORT: the backend phase spawns one runner PER FILE, under one phase marker", () => {
  const src = readFileSync(join(BENCH, "grader", "lib", "backend.mjs"), "utf8");
  const body = src.slice(src.indexOf("function runBackendPhase()"));

  assert.match(body, /for \(const file of backendTestFiles\(\)\)/, "the suite is invoked file by file");
  assert.match(body, /spawnRunner\(`backend \$\{file\}`/, "each file gets its own process");
  assert.ok(
    !/spawnPhase\(/.test(body),
    "and NOT via spawnPhase — a second `[report] phase=backend` opener would tell the board a new phase began",
  );

  // Exactly one open and one close for the whole set: the python adapter turns
  // these two lines into the board's gate-phase-start / gate-phase-end events.
  assert.equal((body.match(/\[report\] phase=backend target=/g) ?? []).length, 1, "one phase opener");
  assert.equal((body.match(/\[report\] phase=backend status=/g) ?? []).length, 1, "one phase closer");
});

// ─────────────────────────────────────────────────────────────────────────────
// TRAJECTORY — how many attempts a gate needed, folded once, server-side.
//
// Shapes taken from the real 2026-08-17 minimax-m3 stream, whose 71 gates
// followed exactly five paths across three attempts:
//   5  pass → pass → pass          clean
//   8  fail → pass → pass          recovered on 2
//   3  fail → fail → pass          recovered on 3
//   2  fail → fail → fail          failing
//  53  pass → not_run → not_run    the harness abort
// ─────────────────────────────────────────────────────────────────────────────

const trajectoryAttempts = (paths) => {
  const ids = Object.keys(paths);
  const rounds = Math.max(...ids.map((id) => paths[id].length));
  return Array.from({ length: rounds }, (_, i) => ({
    type: "attempt",
    attempt: i + 1,
    gate_results: ids
      .filter((id) => paths[id][i] !== undefined)
      .map((id) => ({ id, status: paths[id][i] })),
  }));
};

test("TRAJECTORY: first_pass_attempt is the EARLIEST pass, and ever_failed excludes not_run", () => {
  const paths = {
    clean: ["pass", "pass", "pass"],
    late2: ["fail", "pass", "pass"],
    late3: ["fail", "fail", "pass"],
    broken: ["fail", "fail", "fail"],
    aborted: ["pass", "not_run", "not_run"],
    regressed: ["pass", "fail", "pass"],
  };
  const roster = { gates: Object.keys(paths).map((id) => ({ id })) };
  const { gates } = foldGateStates({ roster, attempts: trajectoryAttempts(paths) });
  const by = Object.fromEntries(gates.map((g) => [g.id, g]));

  assert.deepEqual(
    { s: by.clean.state, f: by.clean.first_pass_attempt, e: by.clean.ever_failed },
    { s: "passing", f: 1, e: false },
  );
  assert.deepEqual(
    { s: by.late2.state, f: by.late2.first_pass_attempt, e: by.late2.ever_failed },
    { s: "passing", f: 2, e: true },
  );
  assert.deepEqual(
    { s: by.late3.state, f: by.late3.first_pass_attempt, e: by.late3.ever_failed },
    { s: "passing", f: 3, e: true },
  );
  assert.deepEqual(
    { s: by.broken.state, f: by.broken.first_pass_attempt, e: by.broken.ever_failed },
    { s: "failing", f: null, e: true },
  );

  // A gate that passed then went UNMEASURED is untested and has NOT failed —
  // colouring an abort as damage is the absence-reads-as-a-verdict defect.
  assert.deepEqual(
    { s: by.aborted.state, f: by.aborted.first_pass_attempt, e: by.aborted.ever_failed },
    { s: "untested", f: 1, e: false },
  );

  // pass → fail → pass: it passed first on attempt 1 AND it broke on the way.
  // Both facts are published; the panel needs `ever_failed` to render it honestly.
  assert.deepEqual(
    { s: by.regressed.state, f: by.regressed.first_pass_attempt, e: by.regressed.ever_failed },
    { s: "passing", f: 1, e: true },
  );
});

test("TRAJECTORY: the verdict is unchanged by it — totals still come from the LAST attempt", () => {
  const paths = {
    a: ["fail", "pass", "pass"],
    b: ["pass", "pass", "fail"],
    c: ["fail", "fail", "fail"],
  };
  const roster = { gates: Object.keys(paths).map((id) => ({ id })) };
  const { totals } = foldGateStates({ roster, attempts: trajectoryAttempts(paths) });
  assert.deepEqual(
    totals,
    { passing: 1, failing: 2, untested: 0 },
    "a gate that passed earlier and fails now is FAILING — the wall reports the current state of the code",
  );
});

test("TRAJECTORY: a single-attempt run marks every pass as first-attempt green", () => {
  const roster = { gates: [{ id: "x" }, { id: "y" }] };
  const attempts = [{ type: "attempt", attempt: 1, gate_results: [{ id: "x", status: "pass" }, { id: "y", status: "fail" }] }];
  const { gates } = foldGateStates({ roster, attempts });
  const by = Object.fromEntries(gates.map((g) => [g.id, g]));
  assert.equal(by.x.first_pass_attempt, 1);
  assert.equal(by.x.ever_failed, false);
  assert.equal(by.y.first_pass_attempt, null);
});


// ═════════════════════════════════════════════════════════════════════════════
// BENCHMARK TREE
//
// The layout decides where hours of measurement land and which of them a board
// can still see. Every rule below is one an operator would otherwise discover by
// losing a run.
// ═════════════════════════════════════════════════════════════════════════════



