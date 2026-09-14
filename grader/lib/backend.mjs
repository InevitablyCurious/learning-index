// The backend phase runner and its helpers, split out of report.mjs (pure
// mechanical move).
//
// Imports shared state/helpers back from ../report.mjs — a deliberate ESM cycle
// that is safe because `node report.mjs` is the sole entrypoint, every
// reference to those bindings below is inside a function body (never at
// top-level eval), and report.mjs defines all of its exports before main()
// runs. Do not "fix" the cycle by duplicating helpers — that would fork state.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GATES_DIR,
  MATCHER,
  ROSTER,
  TARGET,
  announceGateSet,
  notice,
  spawnRunner,
} from "../report.mjs";
import { isRunnerCrash, runnerFailureObserved, vitestGateResults } from "../gate-results.mjs";
import { stallCheckFor } from "./stall.mjs";
import {
  dedupeProblems,
  dedupeStrings,
  safeProblem,
  stripAnsi,
  truncate,
} from "./parse.mjs";

export function extractExpectedObserved(failureMessage, fallbackExpected) {
  const clean = stripAnsi(String(failureMessage ?? "")).trim();
  const expectedMatch = clean.match(/^Expected:\s*(.+)$/im);
  const observedMatch = clean.match(/^(?:Received|Actual|Observed):\s*(.+)$/im);

  if (expectedMatch && observedMatch) {
    return {
      expected: truncate(expectedMatch[1].trim(), 240),
      observed: truncate(observedMatch[1].trim(), 400),
    };
  }

  return {
    expected: fallbackExpected,
    observed: truncate(clean || "<no failure message>", 400),
  };
}

/**
 * Every backend gate file, in a stable order.
 *
 * Mirrors the `include` glob in `vitest.config.ts` — the runner decides WHICH
 * files exist; this only decides that they are invoked one at a time. Sorted so
 * slot order is reproducible across hosts.
 */
export function backendTestFiles() {
  const root = path.join(GATES_DIR, "backend");
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      // A DIRECTORY THAT CANNOT BE LISTED SILENTLY SHRINKS THE SUITE.
      //
      // Every test file under it goes un-invoked, so every gate it holds comes
      // back `not_run` — and `not_run` is an ABSENCE, so the phase still reports
      // as having executed and the run still publishes as gradable. The wall
      // draws those gates as "not yet tested", which is how a suite that never
      // ran half its files reads as a cell in progress.
      //
      // This is the B2.5 rule's own case: a handler that changes WHAT GETS
      // MEASURED must say so. It still returns — a partial suite is better than
      // no gates at all, and the roster fold already reports the shortfall — but
      // it no longer does it silently.
      notice("gates", "test_dir_unreadable", {
        level: "error",
        detail: {
          dir: path.relative(GATES_DIR, dir) || ".",
          error_code: error?.code ?? "unknown",
          consequence: "gates_in_this_dir_never_invoked",
        },
      });
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        out.push(path.relative(GATES_DIR, full));
      }
    }
  };
  walk(root);
  return out;
}

/**
 * THE BACKEND PHASE — ONE VITEST INVOCATION PER FILE.
 *
 * ── WHY NOT ONE INVOCATION FOR THE WHOLE SUITE ──────────────────────────────
 *
 * `vitest.config.ts` pins `fileParallelism:false` + `singleFork:true` because
 * every backend file binds the fixed port 8002 and they must not overlap. That
 * is correct and is preserved here: the loop `await`s each runner before
 * starting the next, so these run strictly one at a time, exactly as before.
 *
 * What is NOT preserved is the blast radius. In a single invocation all seven
 * files share one worker fork, and that fork's RPC to the vitest main process
 * has a fixed timeout which is NOT configurable in vitest 2.1.9. A test that
 * blocks the worker's event loop long enough kills the RPC —
 *
 *   Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 *
 * — and the run collapses, taking every file that had not run yet with it.
 *
 * MEASURED, 2026-08-17 minimax-m3 cell. `backend/gates-13-16.test.ts` holds two
 * SYNCHRONOUS CPU-bound gates (G14: 200 samples × 3 difficulties of
 * `chooseMoves`, then 25 seeded self-play games × 400 half-turns). Against the
 * golden implementation the whole backend suite finishes in 1.63s. Against that
 * cell's code the same two gates took 30.6s and 44.3s, blocked the loop, killed
 * the RPC, and cost the run all six OTHER files: 53 of 56 gates recorded
 * `not_run` on attempts 2 AND 3. Re-grading that worktree scores 69/71.
 *
 * The suite is not at fault and neither is the config — the file passes 7/7 when
 * run alone. The fault is that one slow file could silently un-measure six
 * others. Per-file invocation makes a stall cost ITS OWN file and nothing more,
 * and changes no assertion, so results stay comparable across the change.
 *
 * ONE PHASE, ONE OPEN/CLOSE PAIR. The `[report] phase=backend` lines bracket the
 * whole set (see `spawnPhase`) — the board must see one backend phase, not seven.
 */
export async function runBackendPhase() {
  announceGateSet("backend");
  process.stderr.write(`\n[report] phase=backend target=${TARGET}\n`);

  const problems = [];
  const failedGates = [];
  const merged = { testResults: [] };
  const abortedFiles = [];
  // Timeouts are tracked SEPARATELY from crashes. Both leave gates unmeasured,
  // but "the runner died" and "the code under test never returned" send an
  // operator to different places, and the gradability reason has to say which.
  const timedOutFiles = [];
  const skippedFiles = [];
  // Files whose WORKER died mid-run. Collected here and applied at the fold, so
  // the gates that never reported carry the cause of their absence rather than
  // being indistinguishable from gates nobody reached.
  const diedFiles = new Set();
  let allOk = true;

  const expected = ROSTER.available
    ? ROSTER.gates.filter((g) => g.phase === "backend").length
    : null;

  for (const file of backendTestFiles()) {
    const tmpOutput = path.join(
      os.tmpdir(),
      `bg-vitest-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );

    const run = await spawnRunner(`backend ${file}`, "npx", [
      "vitest",
      "run",
      file,
      "--reporter=json",
      `--outputFile=${tmpOutput}`,
    ]);
    if (!run.ok) allOk = false;

    let report = null;
    if (fs.existsSync(tmpOutput)) {
      try {
        report = JSON.parse(fs.readFileSync(tmpOutput, "utf8"));
      } catch (error) {
        const observed = truncate(
          stripAnsi(error instanceof Error ? error.message : String(error)),
          400,
        );
        problems.push(
          safeProblem(`backend:report-parse ${file}`, "vitest json report can be parsed", observed),
        );
        failedGates.push(`backend:report-parse ${file}`);
      }
    }

    let failuresHere = 0;
    if (report && Array.isArray(report.testResults)) {
      merged.testResults.push(...report.testResults);
      for (const suite of report.testResults) {
        for (const assertion of suite.assertionResults || []) {
          if (assertion.status !== "failed") continue;
          failuresHere += 1;

          const check =
            String(assertion.title || "").trim()
            || String(assertion.fullName || "").match(/(\[[A-Z]\d{2}\][^\n]*)/)?.[1]
            || String(assertion.fullName || "backend:unknown").trim()
            || "backend:unknown";
          const rawFailure = (assertion.failureMessages || []).join("\n\n");
          const eo = extractExpectedObserved(rawFailure, "backend gate assertion passes");
          problems.push(safeProblem(check, eo.expected, eo.observed));
          failedGates.push(check);
        }
      }
    }

    // THE ABORT CASE, NOW NAMED. A file that exits nonzero with no failing
    // assertion did not finish, and the gate is attributed to THAT FILE rather
    // than to "backend" — which is the difference between "one file stalled"
    // and "the backend phase is broken".
    //
    // A CRASH AFTER A FAILURE IS STILL A CRASH (2026-08-24). The zero-failure
    // condition alone could not see a runner that DIED PART-WAY: vitest exits 1
    // when tests fail, but a process killed by a signal (a V8 heap OOM aborts
    // with SIGABRT) or exiting on any other code did not finish its file. When
    // such a crash struck after some tests had already failed, `failuresHere`
    // was nonzero, the abort went unrecorded, and the run reported gradable
    // with no aborted runners while gates it never reached were published as
    // not_run. Measured on a real run: gates-13-16 OOM'd after G13's three
    // failures and G14/G15/G16 were silently left unmeasured, three times over.
    //
    // Exit 1 is vitest's "tests failed" and is NOT a crash. Everything else
    // nonzero is the process dying.
    // ── THE DEATH THE CRASH DETECTOR STRUCTURALLY CANNOT SEE ────────────────
    //
    // `isRunnerCrash` inspects the MAIN vitest process. When a WORKER FORK dies
    // mid-file, main notices nothing: it writes its JSON with every unreported
    // test as `pending` and exits 1 — indistinguishable from an ordinary failed
    // run by exit status alone. Measured on a real run: exit 1, no signal, three
    // real assertion failures recorded, and four gates published as `not_run`
    // with `aborted_runners: []`. The candidate code was later proven innocent —
    // the exact same source measured all seven gates when nothing killed the
    // worker.
    //
    // THE FINGERPRINT IS RIGHT HERE, in scope, a few lines above: a file whose
    // report carries UNREPORTED assertions ALONGSIDE measured ones. A worker
    // that died took its queue with it, so the tests it had not flushed come
    // back pending while its earlier siblings are fully measured. A file nobody
    // ran at all has no measured assertions, and a file that finished has no
    // pending ones — only a death mid-file produces both.
    //
    // SAFE HERE ONLY BECAUSE THE SUITE HAS NO DELIBERATE SKIPS. Verified: no
    // `.skip`, `.todo` or `describe.skip` anywhere under backend/ or frontend/.
    // The day a gate is legitimately skipped this becomes a false positive, and
    // the notice is where that shows up first — which is the right place for it
    // to show up.
    //
    // THIS REPORTS. IT DOES NOT SCORE. The abort condition below is unchanged
    // and still decides gradability, because widening it would change which
    // cells count as measured — a scoring change, and not one instrumentation
    // may make on its own. What was missing was anyone SAYING a worker died;
    // that gap is closed here, and what to do about it stays a decision.
    const assertionsHere = (report?.testResults ?? []).flatMap(
      (suite) => suite.assertionResults ?? [],
    );
    const unreportedHere = assertionsHere.filter(
      (a) => a.status === "pending" || a.status === "skipped" || a.status === "todo",
    ).length;
    const measuredHere = assertionsHere.length - unreportedHere;
    if (unreportedHere > 0 && measuredHere > 0) {
      diedFiles.add(file);
      notice("gates", "worker_died_mid_file", {
        level: "error",
        detail: {
          file,
          measured: measuredHere,
          unreported: unreportedHere,
          exit_status: run.status ?? null,
          exit_signal: run.signal ?? null,
          // The raw report is deleted below and is the only place suite-level
          // detail lives, so the counts that identify this death travel out now.
          scored_as_abort: false,
        },
      });
    }

    const crashed = isRunnerCrash(run);
    if (!run.ok && (failuresHere === 0 || crashed)) {
      const reported = (report?.testResults ?? []).reduce(
        (n, suite) => n + (suite.assertionResults?.length ?? 0),
        0,
      );
      const gate = `backend:runner ${file}`;
      problems.push(
        safeProblem(
          gate,
          "backend gates execute and pass",
          runnerFailureObserved(`backend ${file}`, run, { reported, expected }),
        ),
      );
      failedGates.push(gate);
      abortedFiles.push(file);
      if (run.timedOut) {
        timedOutFiles.push(file);
        // The model-facing half. `backend:runner <file>` stays for the scored
        // artifacts and the operator; this is the sentence a person would say.
        const stall = stallCheckFor(`backend ${file}`);
        problems.push(
          safeProblem(stall, "the game keeps responding", `${file} did not finish`),
        );
        failedGates.push(stall);
      }
      if (run.skipped) skippedFiles.push(file);
    }

    try {
      if (fs.existsSync(tmpOutput)) fs.unlinkSync(tmpOutput);
    } catch {
      // best effort
    }
  }

  const uniqueFailedGates = dedupeStrings(failedGates);
  process.stderr.write(
    `[report] phase=backend status=${allOk ? "pass" : "fail"} problems=${problems.length}\n`,
  );
  return {
    passed: allOk,
    problems: dedupeProblems(problems),
    failedGates: uniqueFailedGates,
    // EVERY assertion is recorded, not only the failures — recording only
    // failures is exactly what made a pass indistinguishable from an absence.
    gateResults: vitestGateResults(merged, MATCHER, { diedFiles }),
    abortedFiles,
    timedOutFiles,
    skippedFiles,
  };
}
