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

export function firstFrontendFailureMessage(spec) {
  for (const testEntry of spec.tests || []) {
    for (const result of testEntry.results || []) {
      if (result.status === "passed" || result.status === "skipped") {
        continue;
      }

      if (result.error?.message) {
        return result.error.message;
      }
      if (Array.isArray(result.errors) && result.errors.length > 0) {
        if (typeof result.errors[0] === "string") {
          return result.errors[0];
        }
        if (result.errors[0]?.message) {
          return result.errors[0].message;
        }
      }
      return `status=${result.status || "unknown"}`;
    }
  }
  return "";
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
      const message = firstFrontendFailureMessage(spec)
        || extractPlaywrightRunError(report)
        || "frontend gate failed";
      problems.push(
        safeProblem(
          check,
          "gate passes",
          truncate(stripAnsi(message), 400),
        ),
      );
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
