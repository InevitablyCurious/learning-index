// ─────────────────────────────────────────────────────────────────────────────
// LAUNCH ARGV TESTS — split VERBATIM from control/control.test.mjs
// (lines 5587–5646).
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { HERE } from "./_shared.mjs";

test("LAUNCH: every setting the argv builder uses is destructured everywhere", () => {
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

  const pushes = [...region.matchAll(/if \((\w+)\)\s*argv\.push\("--[\w-]+"/g)].map((m) => m[1]);
  const guarded = [...region.matchAll(/if \((\w+) != null\) \{\s*\n\s*argv\.push\("--[\w-]+"/g)].map(
    (m) => m[1],
  );
  const used = [...new Set([...pushes, ...guarded])];
  assert.ok(used.length >= 2, `expected several launch settings, found ${used.join(", ")}`);

  // Every destructure of the preview result must carry all of them: the argv
  // builder sits inside one of these scopes and cannot see what it did not name.
  const destructures = [...src.matchAll(/const \{ model, arm[^}]*\} = check;/g)].map((m) => m[0]);
  assert.ok(destructures.length > 0, "no destructure of `check` found — has the shape moved?");

  for (const d of destructures) {
    for (const name of used) {
      assert.ok(
        d.includes(name),
        `\`${name}\` is pushed into the launch argv but missing from a destructure of ` +
          `\`check\`. That is not a parse error — it fails at LAUNCH with ` +
          `"${name} is not defined", after preflight has already passed.`,
      );
    }
  }

  // And the preview must return each one, or the destructure above is reading
  // a key nobody wrote. The success return lives in finishValidate, which
  // moved to lib/validate.mjs (LI-14 phase 1); the builder and the destructures
  // above are route code and live in routes/run.mjs.
  const validateSrc = readFileSync(join(HERE, "lib", "validate.mjs"), "utf-8");
  const ret = /return \{ ok: true, model, arm[^}]*\};/.exec(validateSrc);
  assert.ok(ret, "the preview no longer returns its usual shape");
  for (const name of used) {
    assert.ok(ret[0].includes(name), `preview does not return \`${name}\``);
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

