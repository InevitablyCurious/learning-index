// The frontend phase runner and its helpers, split out of report.mjs (pure
// mechanical move).
//
// Imports shared state/helpers back from ../report.mjs — a deliberate ESM cycle
// that is safe because `node report.mjs` is the sole entrypoint, every
// reference to those bindings below is inside a function body (never at
// top-level eval), and report.mjs defines all of its exports before main()
// runs. Do not "fix" the cycle by duplicating helpers — that would fork state.
import { MATCHER, announceGateSet, spawnPhase } from "../report.mjs";
import { playwrightGateResults, runnerFailureObserved } from "../gate-results.mjs";
import { stallCheckFor, stallObserved } from "./stall.mjs";
import {
  collectPlaywrightSpecs,
  dedupeProblems,
  dedupeStrings,
  extractPlaywrightRunError,
  firstNonEmptyLine,
  parseJsonObject,
  safeProblem,
  stripAnsi,
  truncate,
} from "./parse.mjs";

// What a failed page check found: its first failure, as it always was, and — besides it — every further
// finding the check raised deliberately (a soft assertion carrying its own [aspect: …]), so one moment can be
// told by the player and the team together: the player "I can't see some of the pieces", the team where they
// are drawn (Jerry, 2026-11-18). A check that did not finish keeps its one failure: a timeout's incidental
// second error is no finding.
const DID_NOT_FINISH = /Test timeout of \d+ms exceeded|Test timed out in \d+|STACK_TRACE_ERROR/;

export function frontendFailureMessages(spec) {
  for (const testEntry of spec.tests || []) {
    for (const result of testEntry.results || []) {
      if (result.status === "passed" || result.status === "skipped") {
        continue;
      }
      // The runner reports the first failure twice (result.error and result.errors[0]), differing only in
      // formatting: one failure is one finding, keyed by its first line.
      const all = [];
      const seen = new Set();
      const add = (m) => {
        if (typeof m !== "string" || !m) return;
        const key = stripAnsi(m).split("\n")[0].trim();
        if (seen.has(key)) return;
        seen.add(key);
        all.push(m);
      };
      const errors = Array.isArray(result.errors) ? result.errors : [];
      for (const e of errors) add(typeof e === "string" ? e : e?.message);
      if (all.length === 0) add(result.error?.message);
      if (all.length === 0) return [`status=${result.status || "unknown"}`];
      if (all.some((m) => DID_NOT_FINISH.test(m))) return [all[0]];
      return [all[0], ...all.slice(1).filter((m) => m.includes("[aspect:"))];
    }
  }
  return [];
}

export function specFailed(spec) {
  if (spec?.ok === false) {
    return true;
  }
  for (const testEntry of spec?.tests || []) {
    for (const result of testEntry?.results || []) {
      if (result.status !== "passed" && result.status !== "skipped") {
        return true;
      }
    }
  }
  return false;
}

export async function runFrontendPhase() {
  announceGateSet("frontend");
  const run = await spawnPhase("frontend", "npx", [
    "playwright",
    "test",
    "--project=chromium",
    "--reporter=json",
  ]);

  const problems = [];
  const failedGates = [];
  const report = parseJsonObject(run.stdout);

  if (report) {
    const specs = collectPlaywrightSpecs(report.suites);
    for (const spec of specs) {
      if (!specFailed(spec)) {
        continue;
      }

      const check = String(spec.title || "frontend:unknown").trim() || "frontend:unknown";
      const found = frontendFailureMessages(spec);
      const messages = found.length ? found : [extractPlaywrightRunError(report) || "frontend gate failed"];
      for (const message of messages) {
        problems.push(safeProblem(check, "gate passes", truncate(stripAnsi(message), 400)));
      }
      failedGates.push(check);
    }
  }

  // Same shape as the backend abort: nonzero exit, no failing test, so the
  // phase did not finish and its unreached gates are unmeasured, not failed.
  const aborted = !run.ok && problems.length === 0;
  if (aborted) {
    const runError = stripAnsi(String(extractPlaywrightRunError(report) ?? "")).trim();
    const observed = runError
      ? truncate(firstNonEmptyLine(runError), 400)
      : runnerFailureObserved("frontend", run);
    problems.push(safeProblem("frontend:boot", "frontend gates execute and pass", observed));
    failedGates.push("frontend:boot");
  }

  const uniqueFailedGates = dedupeStrings(failedGates);
  process.stderr.write(
    `[report] phase=frontend status=${run.ok ? "pass" : "fail"} problems=${problems.length}\n`,
  );
  // A stalled phase is a freeze the player sees. Same rule as the backend
  // files: the infra check stays for the artifacts, this is what reaches the
  // model.
  if (run.timedOut) {
    const stall = stallCheckFor("frontend");
    problems.push(safeProblem(stall, "the game keeps responding", stallObserved(run.elapsedMs)));
    failedGates.push(stall);
  }

  return {
    passed: run.ok,
    problems: dedupeProblems(problems),
    failedGates: uniqueFailedGates,
    gateResults: playwrightGateResults(report, MATCHER),
    aborted,
    timedOut: run.timedOut === true,
    skipped: run.skipped === true,
  };
}
