// The conformance phase runner, split out of report.mjs (pure mechanical move).
//
// Imports shared state/helpers back from ../report.mjs — a deliberate ESM cycle
// that is safe because `node report.mjs` is the sole entrypoint, every
// reference to those bindings below is inside the function body (never at
// top-level eval), and report.mjs defines all of its exports before main()
// runs. Do not "fix" the cycle by duplicating helpers — that would fork state.
import { MATCHER, announceGateSet, spawnPhase } from "../report.mjs";
import { playwrightGateResults } from "../gate-results.mjs";
import { stallCheckFor } from "./stall.mjs";
import {
  collectPlaywrightSpecs,
  dedupeProblems,
  dedupeStrings,
  extractPlaywrightRunError,
  parseJsonObject,
  parseProblemsFromErrorMessage,
  parseProblemsFromTextLines,
  safeProblem,
  stripAnsi,
  textFromEntry,
  truncate,
} from "./parse.mjs";

export async function runConformancePhase() {
  announceGateSet("conformance");
  const run = await spawnPhase("conformance", "npx", [
    "playwright",
    "test",
    "--config",
    "playwright.conformance.config.ts",
    "--reporter=json",
  ]);

  const problems = [];
  const failedGates = [];

  const parsed = parseJsonObject(run.stdout);
  if (parsed) {
    const specs = collectPlaywrightSpecs(parsed.suites);
    for (const spec of specs) {
      for (const testEntry of spec.tests || []) {
        for (const result of testEntry.results || []) {
          for (const stderrEntry of result.stderr || []) {
            const text = textFromEntry(stderrEntry);
            problems.push(...parseProblemsFromTextLines(text));
          }

          if (result.error?.message) {
            problems.push(...parseProblemsFromErrorMessage(result.error.message));
          }

          for (const err of result.errors || []) {
            if (err?.message) {
              problems.push(...parseProblemsFromErrorMessage(err.message));
            }
          }
        }
      }
    }
  }

  if (problems.length === 0) {
    problems.push(...parseProblemsFromTextLines(`${run.stdout}\n${run.stderr}`));
  }

  const prefixed = dedupeProblems(problems).map((problem) => {
    const check = `conformance:${problem.check}`;
    failedGates.push(check);
    return safeProblem(check, problem.expected, truncate(stripAnsi(problem.observed), 400));
  });

  // ── NO FABRICATED FINDING WHEN THE PHASE IS UNREADABLE ────────────────────
  //
  // This used to synthesise a `conformance:boot` problem — "server boots on
  // :8002 and passes pre-gate" — whenever the phase failed and nothing parsed.
  // That is a FALLBACK in the scored path, and the bench works one way: fail
  // loud, never carry on by a different route.
  //
  // It also actively hid a defect. Splitting the pre-gate into 65 tests dropped
  // the `PROBLEM` lines this function parses, so `problems` came back empty on
  // a phase that had 11 real failures. Instead of stopping, this manufactured a
  // single boot complaint and the run continued for several attempts producing
  // degraded feedback. A loud failure here would have surfaced it on attempt 1.
  //
  // A phase that failed and cannot be read is an INSTRUMENT failure, not a
  // capability result. It is reported as such below (`gradability`) — the same
  // honest mechanism an aborted backend runner already uses — and no invented
  // problem reaches `failed_gates`, the attempt count, or the repair prompt.
  const unreadable = !run.ok && prefixed.length === 0;
  if (unreadable) {
    // NAMED, exactly as an aborted backend file or a dead frontend runner is
    // named — `conformance:runner`, never `conformance:boot`. The old name
    // asserted a boot failure, which is a CLAIM about the code under test; this
    // one says the runner could not be read, which is a claim about the
    // harness. Prefixed as harness-infra so it is recorded in the artifacts and
    // never reaches the repair prompt.
    const observed =
      stripAnsi(
        String(
          run.stderr || extractPlaywrightRunError(parsed) || run.stdout || run.error?.message || "",
        ),
      ).trim() || "<no output>";
    const named = safeProblem(
      "conformance:runner",
      "the conformance phase runs and reports its findings",
      truncate(observed, 400),
    );
    prefixed.push(named);
    failedGates.push(named.check);
    process.stderr.write(
      "[report] phase=conformance UNREADABLE — failed with no parseable PROBLEM "
      + "lines. This attempt is NOT a measurement; see ungradable_reason.\n",
    );
  }

  const uniqueFailedGates = dedupeStrings(failedGates);
  process.stderr.write(
    `[report] phase=conformance status=${run.ok ? "pass" : "fail"} problems=${prefixed.length}\n`,
  );
  // ── THIS NOTE INVERTED, 2026-09-05 ──────────────────────────────────────
  //
  // It used to read: the `conformance:REQ-*` entries are SUB-CHECKS inside the
  // single `[CONF]` spec, not gates, and are deliberately NOT mapped onto
  // roster ids because "doing so would invent gates the suite does not
  // contain."
  //
  // The suite now contains them. `pregate.spec.ts` declares one test per check
  // (65 of them), so `playwrightGateResults` below maps each to a real roster
  // gate exactly as it does for backend and frontend — nothing is invented.
  //
  // `failedGates` still carries the `conformance:REQ-*` strings, and that is
  // deliberate: they are what `problems` is keyed on, and the repair prompt
  // resolves its per-check feedback lines through those keys
  // (`_CONF_KEY_RE` in adapters/challenge.py). One finding is now one gate, so
  // the count here and the count on the wall agree.
  // A stalled phase is a freeze the player sees. Same rule as the backend
  // files: the infra check stays for the artifacts, this is what reaches the
  // model.
  if (run.timedOut) {
    const stall = stallCheckFor("conformance");
    problems.push(safeProblem(stall, "the game keeps responding", "conformance did not finish"));
    failedGates.push(stall);
  }

  return {
    passed: run.ok,
    unreadable,
    timedOut: run.timedOut === true,
    skipped: run.skipped === true,
    problems: prefixed,
    failedGates: uniqueFailedGates,
    gateResults: playwrightGateResults(parsed, MATCHER),
  };
}
