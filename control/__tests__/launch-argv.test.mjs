// ─────────────────────────────────────────────────────────────────────────────
// LAUNCH ARGV TESTS — split VERBATIM from control/control.test.mjs
// (lines 5587–5646).
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { HERE } from "./_shared.mjs";

test("LAUNCH: the argv builder's flags come from `check` or from server state, never from an unnamed field", () => {
  // The launch route moved from server.mjs to routes/run.mjs (LI-14 phase 2).
  const src = readFileSync(join(HERE, "routes", "run.mjs"), "utf-8");

  // SCOPED TO THE LAUNCH BUILDER, not to every argv in the file. The first
  // version scanned all of them and flagged `cloudProvider`, which is a local
  // in an unrelated GET handler — a test that cries wolf gets disabled, and
  // then it catches nothing.
  //
  // The launch builder is the block that pushes the `run` subcommand. Read from
  // there to the end of its statement list.
  const start = src.indexOf('argv.push("run", "--mode", arm');
  assert.ok(start > 0, "the launch argv builder has moved — find it and re-scope this test");
  const region = src.slice(start, start + 1200);

  // The subcommand statement itself: the arm, and compaction always explicit
  // (the harness has no default).
  assert.match(
    region,
    /argv\.push\("run", "--mode", arm, compact \? "--compact" : "--no-compact"\)/,
    "the builder states the arm and the compaction choice",
  );

  const pushes = [...region.matchAll(/if \((\w+)\)\s*argv\.push\("--[\w-]+"/g)].map((m) => m[1]);
  const guarded = [...region.matchAll(/if \((\w+) != null\) \{\s*\n\s*argv\.push\("--[\w-]+"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(
    [...new Set([...pushes, ...guarded])],
    ["requireTodos", "devPause", "graderWorkerTarget"],
    "exactly three optional flags: the operator switches and the dev-mode pause",
  );

  // Every setting that comes from `check` must be destructured everywhere:
  // the argv builder sits inside one of these scopes and cannot see what it
  // did not name. `devPause` is deliberately NOT one of them — it is the
  // server's dev mode (devmode.mjs), and a pause that could arrive off the
  // wire is the per-run flag this control plane no longer has.
  const fromCheck = ["requireTodos", "graderWorkerTarget"];
  const destructures = [...src.matchAll(/const \{ model, arm[^}]*\} = check;/g)].map((m) => m[0]);
  assert.ok(destructures.length > 0, "no destructure of `check` found — has the shape moved?");

  for (const d of destructures) {
    for (const name of fromCheck) {
      assert.ok(
        d.includes(name),
        `\`${name}\` is pushed into the launch argv but missing from a destructure of ` +
          `\`check\`. That is not a parse error — it fails at LAUNCH with ` +
          `"${name} is not defined", after preflight has already passed.`,
      );
    }
    assert.ok(
      !d.includes("devPause"),
      "devPause must be resolved from dev mode by the route, never destructured from `check`",
    );
  }

  // And the preview must return each `check` field it hands over, or the
  // destructure above is reading a key nobody wrote. The success return lives in
  // finishValidate, which moved to lib/validate.mjs (LI-14 phase 1); the builder
  // and the destructures above are route code and live in routes/run.mjs.
  const validateSrc = readFileSync(join(HERE, "lib", "validate.mjs"), "utf-8");
  const ret = /return \{ ok: true, model, arm[^}]*\};/.exec(validateSrc);
  assert.ok(ret, "the preview no longer returns its usual shape");
  for (const name of fromCheck) {
    assert.ok(ret[0].includes(name), `preview does not return \`${name}\``);
  }
});

test("LAUNCH: the single run's argv names no cell position, and every flag it pushes is one the harness defines", () => {
  // One click appends ONE cell and the HARNESS owns the ordinal, so the
  // launcher states the arm and nothing about where the cell lands:
  // --sequence-index, --off-replicates and --on-budget all went with the
  // control-plane cursor. What remains must exist in the harness's own parser
  // (scripts/run_cumulative/__init__.py) — a flag nobody defines is an argparse
  // exit 2 seconds after launch, with the cell already recorded as started.
  const src = readFileSync(join(HERE, "routes", "run.mjs"), "utf-8");
  const start = src.indexOf('path: "/api/run/start"');
  assert.notEqual(start, -1, "the /api/run/start route disappeared");
  const end = src.indexOf('path: "/api/run/stop/preview"', start);
  assert.notEqual(end, -1, "could not find the end of the start handler");
  const handler = src.slice(start, end);

  for (const flag of ["--sequence-index", "--off-replicates", "--on-budget"]) {
    assert.ok(
      !handler.includes(`"${flag}"`),
      `${flag} must not be pushed — the harness assigns the cell's position itself`,
    );
  }

  const argvBlock = handler.slice(
    handler.indexOf("const argv = [RUN_SCRIPT];"),
    handler.indexOf("const stamp ="),
  );
  assert.ok(argvBlock.length > 0, "the argv builder has moved — find it and re-scope this test");
  const flags = [...new Set([...argvBlock.matchAll(/"(--[a-z][a-z-]*)"/g)].map((m) => m[1]))].sort();
  assert.deepEqual(
    flags,
    [
      "--cloud",
      "--compact",
      "--grader-worker-target",
      "--manifest",
      "--mode",
      "--model",
      "--no-compact",
      "--org",
      "--pause-after-grade",
      "--provider",
      "--require-todos",
      "--resume-checkpoint",
      "--resume-phase",
    ],
    "the whole launch argv, re-baselined to one cell per click",
  );

  const harnessArgv = readFileSync(
    join(HERE, "..", "scripts", "run_cumulative", "__init__.py"),
    "utf-8",
  );
  for (const flag of flags) {
    assert.ok(
      harnessArgv.includes(`"${flag}"`),
      `\`${flag}\` is pushed into the launch argv but the harness defines no such flag`,
    );
  }
});

// ── STREAM ERRORS MUST COUNT STREAM ERRORS (2026-09-11) ─────────────────────
//
// The slot read `error_totals.finalize_timeout_turns` — ONE narrow kind, a turn
// killed while the stream was FINALIZING. A plain `transport_error`, the stream
// dying mid-turn, is not that. Measured on a live run: the stream died on
// initial-chunk-2, the harness recorded it, and the board's counter never moved.
//
// A counter that reads zero through the failure it is named for is worse than
// no counter: it is an active assurance that nothing went wrong.

