// Extracted verbatim from control/control.test.mjs — WO-LI18 split A.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newestLog } from "../runstate.mjs";
import { attemptRecords, foldGateStates, readStatusRecords, readWall, resolveRunDir } from "../wall.mjs";

import { BENCH } from "./_shared.mjs";

function fakeRoster() {
  return {
    schema_version: 1,
    total: 4,
    by_phase: { backend: 3, frontend: 1 },
    suite_fingerprint: "sha256:deadbeef",
    enumeration: { executed_tests: false, complete: true, incomplete_reason: null },
    gates: [
      { id: "G01", phase: "backend", req: "REQ-INIT", title: "initial position", gate_token: "G01", tier: "core" },
      { id: "G02", phase: "backend", req: "REQ-PIP", title: "pip count", gate_token: "G02", tier: "core" },
      { id: "G03", phase: "backend", req: "REQ-DICE", title: "dice", gate_token: "G03", tier: "core" },
      { id: "F01", phase: "frontend", req: "REQ-RENDER", title: "renders", gate_token: "F01", tier: "core" },
    ],
  };
}

test("WALL: a gate that never ran is never reported as passed", () => {
  // THE DEFECT THIS WHOLE SURFACE EXISTS TO REMOVE. Under `failed_gates` alone,
  // G03 (never executed) and G01 (executed, passed) were both simply "not in
  // the failing list" — indistinguishable, and the natural reading of that
  // silence is success.
  const roster = fakeRoster();
  const attempts = [
    {
      attempt: 1,
      gate_results: [
        { id: "G01", status: "pass" },
        { id: "G02", status: "fail" },
        { id: "G03", status: "not_run", reason: "phase aborted before execution" },
      ],
    },
  ];
  const { gates } = foldGateStates({ roster, attempts });
  const byId = Object.fromEntries(gates.map((g) => [g.id, g]));
  assert.equal(byId.G01.state, "passing");
  assert.equal(byId.G02.state, "failing");
  assert.equal(byId.G03.state, "untested", "a not_run gate must never be resolved");
  // A gate absent from the results array entirely is the same class of fact.
  assert.equal(byId.F01.state, "untested", "an unreported gate must never be resolved");
});

test("WALL: not_run is untested, but error is a failure", () => {
  // The two ways the three-way split goes wrong, pinned in one place.
  // `not_run`  — the runner never reached it. No measurement exists.
  // `error`    — it ran and could not complete. It has NOT been shown to work.
  const roster = fakeRoster();
  const attempts = [
    {
      attempt: 1,
      gate_results: [
        { id: "G01", status: "not_run" },
        { id: "G02", status: "error" },
      ],
    },
  ];
  const byId = Object.fromEntries(
    foldGateStates({ roster, attempts }).gates.map((g) => [g.id, g]),
  );
  assert.equal(byId.G01.state, "untested", "an unreached gate must not invent a red square");
  assert.equal(byId.G02.state, "failing", "a broken gate must not hide in the not-yet bucket");
});

test("WALL: totals partition the suite exactly", () => {
  // Every gate lands in exactly one of THREE states, so the totals must sum to
  // the suite size. If they ever do not, the board is rendering a suite that
  // does not exist.
  const roster = fakeRoster();
  const attempts = [
    { attempt: 1, gate_results: [{ id: "G01", status: "pass" }, { id: "G02", status: "fail" }] },
  ];
  const { gates, totals } = foldGateStates({ roster, attempts });
  const sum = totals.passing + totals.failing + totals.untested;
  assert.equal(sum, roster.total, "totals must sum to the suite total");
  assert.equal(sum, gates.length);
  assert.equal(Object.keys(totals).length, 3, "three states, and no more");
});

test("WALL: `unmeasured` counts stated non-results, never gates nobody reached", () => {
  // THE TWO ABSENCES ARE NOT THE SAME FACT. A gate the stream has not mentioned
  // is not reached yet — normal, and the whole suite looks like that early in a
  // cell. A gate the runner explicitly published as `not_run` is one it reached
  // the phase for and produced no verdict against: four of those, with their
  // siblings measured normally, is the fingerprint a grading worker leaves when
  // it dies mid-file. Counting them together would peg the footer at the suite
  // size for the first minutes of every healthy run and say nothing.
  const roster = fakeRoster();

  // G01 measured, G02 explicitly not_run, the rest never mentioned.
  const { totals, unmeasured, gates } = foldGateStates({
    roster,
    attempts: [
      { attempt: 1, gate_results: [{ id: "G01", status: "pass" }, { id: "G02", status: "not_run" }] },
    ],
  });
  assert.equal(unmeasured, 1, "only the stated non-result counts");

  // IT IS A SUBSET, NOT A BUCKET. The three states still partition the suite,
  // and `not_run` still colours as untested — the wall invents no verdict.
  assert.equal(totals.passing + totals.failing + totals.untested, roster.total);
  assert.equal(Object.keys(totals).length, 3, "three states, and no more");
  assert.ok(unmeasured <= totals.untested, "unmeasured is contained by untested");
  assert.equal(gates.find((g) => g.id === "G02").state, "untested");

  // A RUN THAT HAS PUBLISHED NOTHING HAS NO UNMEASURED GATES — it has no
  // measurements at all, which is a different statement and already carried by
  // `outcomes_published`.
  assert.equal(foldGateStates({ roster, attempts: [] }).unmeasured, 0);
});

test("WALL: the LAST completed test run wins — a fixed gate turns green", () => {
  // The wall reports the current state of the code, not the history of how it
  // got there. Attempt 2 supersedes attempt 1 outright.
  const roster = fakeRoster();
  const attempts = [
    { attempt: 1, gate_results: [{ id: "G01", status: "fail" }, { id: "G02", status: "fail" }] },
    { attempt: 2, gate_results: [{ id: "G01", status: "pass" }, { id: "G02", status: "fail" }] },
  ];
  const byId = Object.fromEntries(
    foldGateStates({ roster, attempts }).gates.map((g) => [g.id, g]),
  );
  assert.equal(byId.G01.state, "passing", "fixed in attempt 2");
  assert.equal(byId.G02.state, "failing", "still broken in attempt 2");
});

test("WALL: a gate that REGRESSED reads red, not green", () => {
  // The mirror image, and the reason the fold takes the latest result rather
  // than "passed at least once". A gate that passed attempt 1 and broke in
  // attempt 2 is broken NOW, and a wall that showed it green would be reporting
  // a pass that no longer holds.
  const roster = fakeRoster();
  const attempts = [
    { attempt: 1, gate_results: [{ id: "G01", status: "pass" }] },
    { attempt: 2, gate_results: [{ id: "G01", status: "fail" }] },
  ];
  const byId = Object.fromEntries(
    foldGateStates({ roster, attempts }).gates.map((g) => [g.id, g]),
  );
  assert.equal(byId.G01.state, "failing");
});

test("WALL: a gate row carries NO phase and no live signal", () => {
  // The wall is a dumb surface: the server hands it the verdict, the two
  // identities needed to check a square against the log (`id`, unique per
  // test; `gate_token`, the grouping token), and — since the trajectory
  // split — two facts about RECORDED HISTORY. Nothing else.
  //
  // The invariant this test exists for is unchanged and is asserted explicitly
  // below: no phase, and nothing live. `first_pass_attempt` / `ever_failed` are
  // folded from completed attempts already on disk, so they cannot reintroduce
  // the in-flight ambers this rebuild removed. `state` is still the only field
  // that answers pass/fail.
  const roster = fakeRoster();
  const attempts = [{ attempt: 1, gate_results: [{ id: "G01", status: "pass" }] }];
  const [row] = foldGateStates({ roster, attempts }).gates;
  // `unmeasured_cause` joins the row because the PANEL consumes it: an
  // instrument fault and a gate nobody reached are both unmeasured, drew
  // identically, and are not the same fact. It is folded from completed
  // attempts on disk like the two trajectory facts beside it, so it cannot
  // reintroduce an in-flight state. An earlier attempt at this put a derived
  // count on the row that no surface read; that one was rightly rejected.
  assert.deepEqual(
    Object.keys(row).sort(),
    ["ever_failed", "first_pass_attempt", "gate_token", "id", "req", "state", "title", "unmeasured_cause"],
  );

  // THE ACTUAL PROHIBITION, stated as itself rather than as a key count.
  for (const forbidden of ["phase", "live", "in_flight", "provisional", "attempts", "status"]) {
    assert.ok(!(forbidden in row), `a gate row must not carry "${forbidden}"`);
  }
});

test("WALL: run_dir is confined to a child of the runs root", () => {
  // The value reaches an fs path. Traversal would let a caller read arbitrary
  // JSON off the host through a read-only endpoint.
  assert.equal(resolveRunDir("/runs", "../../etc"), null);
  assert.equal(resolveRunDir("/runs", "/etc/passwd"), null);
  // ── NESTED IS NOW LEGAL, TRAVERSAL IS STILL NOT ─────────────────────────
  //
  // The separator ban was correct for a flat layout where every run directory
  // was a direct child. Under the benchmark tree a campaign home IS a path
  // (`<tree>/<substrate>/<router>/<provider>/<model>`), so rejecting separators
  // outright would refuse every legitimate run_dir on a bench that is running
  // normally. The containment property is unchanged and asserted below.
  assert.equal(resolveRunDir("/runs", "a/b")?.name, "a/b", "a nested campaign home resolves");
  assert.equal(
    resolveRunDir("/runs", "1787310000/local/local-llm-proxy/omlx/model-x")?.name,
    "1787310000/local/local-llm-proxy/omlx/model-x",
    "a full tree path resolves",
  );
  // Every escape still refused — each segment is validated before resolution,
  // and the resolved path must still sit under the root.
  assert.equal(resolveRunDir("/runs", "a/../../etc"), null, "traversal through a nested path");
  assert.equal(resolveRunDir("/runs", "a/./b"), null, "a dot segment");
  assert.equal(resolveRunDir("/runs", "a//b"), null, "an empty segment");
  assert.equal(resolveRunDir("/runs", "/etc/passwd"), null, "an absolute path");
  assert.equal(resolveRunDir("/runs", ".."), null);
  assert.equal(resolveRunDir("/runs", "cumulative")?.name, "cumulative");
  assert.equal(resolveRunDir("/runs", "")?.name, "cumulative", "empty falls back to the default run dir");
});

// ── THE WIPE BOUNDARY ───────────────────────────────────────────────────────
//
// Cell logs are written to the runs ROOT; the run state they describe lives in
// `runs/<run_dir>/`. Archiving or wiping a run moves the directory and leaves
// the log, so the log outlives its own data.
//
// MEASURED 2026-08-13: after a wipe, `runs/off-cell-20260813T051334.log`
// remained at the root and every reader resolved it as the live run. /api/wall
// served `suite.total:null` (the run dir was gone) beside `grading.active:true
// phase:frontend stalled:true silent_s:4848` parsed out of that dead log — a
// wiped bench reporting a run in progress, which the operator could not clear
// without hand-deleting files after every wipe.

test("WIPE: a cell log whose run directory is gone is not resolved as the live run", async () => {
  const root = mkdtempSync(join(tmpdir(), "wipe-"));
  try {
    const runs = join(root, "runs");
    mkdirSync(runs, { recursive: true });
    // The exact post-wipe shape: the run dir archived away, the log left behind.
    mkdirSync(join(runs, "cumulative.wiped-sim", "sessions"), { recursive: true });
    writeFileSync(
      join(runs, "off-cell-orphan.log"),
      "PROGRESS step=worktree-git-init path=" +
        join(runs, "cumulative", "sessions", "cell", "worktree") +
        "\nPROGRESS step=gate-phase-start phase=frontend\n",
    );

    assert.equal(
      await newestLog(runs),
      null,
      "an orphan log describes a run that no longer exists and is not live",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WIPE: a cell log whose run directory still exists IS resolved as live", async () => {
  const root = mkdtempSync(join(tmpdir(), "wipe-"));
  try {
    const runs = join(root, "runs");
    mkdirSync(join(runs, "cumulative", "sessions"), { recursive: true });
    writeFileSync(
      join(runs, "off-cell-live.log"),
      "PROGRESS step=worktree-git-init path=" +
        join(runs, "cumulative", "sessions", "cell", "worktree") +
        "\n",
    );

    const log = await newestLog(runs);
    assert.ok(log, "a log whose run dir exists is still the live run");
    assert.equal(log.run_dir, "cumulative");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WIPE: a fresh log that has not yet named a run dir is live, not orphaned", async () => {
  const root = mkdtempSync(join(tmpdir(), "wipe-"));
  try {
    const runs = join(root, "runs");
    mkdirSync(runs, { recursive: true });
    // A just-launched cell prints banner lines before any artifact path.
    writeFileSync(join(runs, "off-cell-new.log"), "This is mini-swe-agent version 2.4.5.\n");

    const log = await newestLog(runs);
    assert.ok(log, "a log that has not named a run dir yet must not be discarded");
    assert.equal(log.run_dir, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WIPE: an orphan is skipped in favour of an older log that is still live", async () => {
  const root = mkdtempSync(join(tmpdir(), "wipe-"));
  try {
    const runs = join(root, "runs");
    mkdirSync(join(runs, "cumulative", "sessions"), { recursive: true });

    const livePath = join(runs, "off-cell-live.log");
    writeFileSync(
      livePath,
      "PROGRESS step=worktree-git-init path=" + join(runs, "cumulative", "s", "w") + "\n",
    );
    // Newer by mtime, but its run dir is gone: recency must not beat existence.
    const orphanPath = join(runs, "off-cell-orphan.log");
    writeFileSync(
      orphanPath,
      "PROGRESS step=worktree-git-init path=" + join(runs, "cumulative.gone", "s", "w") + "\n",
    );
    utimesSync(livePath, new Date(1000), new Date(1000));
    utimesSync(orphanPath, new Date(9000), new Date(9000));

    const log = await newestLog(runs);
    assert.equal(log?.name, "off-cell-live.log", "the newest LIVE log wins, not the newest log");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WALL: a wiped bench shows the suite defined and every gate untested", async () => {
  const root = mkdtempSync(join(tmpdir(), "wiped-"));
  try {
    const runs = join(root, "runs");
    mkdirSync(runs, { recursive: true });

    const wall = await readWall({ runsRoot: runs, runDir: null, benchRoot: BENCH });

    assert.equal(wall.ok, true);
    assert.equal(wall.suite_source, "enumerated", "the suite came from the harness, not a run");
    // The count is whatever the harness enumerates — asserted as a real number
    // rather than a literal, so adding a gate does not fail this test.
    assert.ok(wall.suite.total > 0, "the suite size is known");
    assert.equal(
      wall.totals.untested,
      wall.suite.total,
      "every gate is untested: defined, not yet evaluated",
    );
    assert.equal(wall.totals.passing, 0);
    assert.equal(
      wall.totals.failing,
      0,
      "a bench that has not run must never read as everything-failed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WALL: the suite denominator is never fabricated when the harness cannot be reached", async () => {
  const root = mkdtempSync(join(tmpdir(), "noharness-"));
  try {
    const runs = join(root, "runs");
    mkdirSync(runs, { recursive: true });
    // benchRoot with no gates dir: the enumerator cannot run.
    const wall = await readWall({ runsRoot: runs, runDir: null, benchRoot: root });

    assert.equal(wall.ok, true, "a missing enumerator is a state, not a 500");
    assert.equal(wall.suite.total, null, "unknowable stays null, never 0 (invariant I-2)");
    assert.ok(wall.unwired.includes("gate-roster"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WALL: a run's own pinned roster wins over live enumeration", async () => {
  const root = mkdtempSync(join(tmpdir(), "pinned-"));
  try {
    const runs = join(root, "runs");
    mkdirSync(join(runs, "cumulative"), { recursive: true });
    // A roster pinned to this run describes the suite it was GRADED against and
    // must not be replaced by today's suite, or every comparison re-baselines.
    writeFileSync(
      join(runs, "cumulative", "gate-roster.json"),
      JSON.stringify({
        schema_version: 1,
        total: 2,
        suite_fingerprint: "sha256:pinned",
        gates: [
          { id: "G01", phase: "backend", tier: "core" },
          { id: "G02", phase: "backend", tier: "core" },
        ],
      }),
    );

    const wall = await readWall({ runsRoot: runs, runDir: "cumulative", benchRoot: BENCH });
    assert.equal(wall.suite_source, "run", "the pinned roster is authoritative");
    assert.equal(wall.suite.total, 2);
    assert.equal(wall.suite.fingerprint, "sha256:pinned");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WALL: a truncated status stream yields every intact record before the tear", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wall-"));
  try {
    const path = join(dir, "manifest.status.jsonl");
    writeFileSync(
      path,
      '{"type":"attempt","attempt":1,"gate_results":[]}\n' +
        '{"type":"turn_terminal"}\n' +
        '{"type":"attempt","attempt":2,"gate_r',
    );
    const records = await readStatusRecords(path);
    assert.equal(records.length, 2, "the intact records survive");
    assert.equal(attemptRecords(records).length, 1, "the torn attempt record is not invented");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the producer side ───────────────────────────────────────────────────────

