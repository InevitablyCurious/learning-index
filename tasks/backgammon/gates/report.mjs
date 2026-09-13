#!/usr/bin/env node
import { spawnWithDeadline } from "./lib/runner.mjs";
import { describeWorkers, insufficientResources } from "./lib/workers.mjs";
import { stallCheckFor } from "./lib/stall.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  foldGateResults,
  loadRoster,
  makeMatcher,
  playwrightGateResults,
  vitestGateResults,
  runnerFailureObserved,
  isRunnerCrash,
} from "./gate-results.mjs";

const GATES_DIR = path.dirname(fileURLToPath(import.meta.url));

// ── NOTICES — this runner speaking for itself ────────────────────────────────
//
// The harness spawns this process and streams its stdout, so it COULD parse
// what it sees and relay it. That is the pattern the backend feed exists to
// replace: a consumer recovering by regex what a producer could have stated.
// The runner knows what happened to its own workers; it says so directly.
//
// The seam is `BENCH_LIVE_STREAM`, the same one a third-party backend gets.
// UNSET MEANS NO TELEMETRY IS WANTED — carry on, do not error: a gate run must
// never depend on a stream being there.
//
// NEVER THROWS, and never on the grading path. Telemetry about a failure must
// not become a second failure, and an unwritable stream costs a row on a feed,
// never a measurement.
const LIVE_STREAM_PATH = String(process.env.BENCH_LIVE_STREAM ?? "").trim();

function notice(source, event, { level = "info", detail = null } = {}) {
  if (!LIVE_STREAM_PATH) return false;
  try {
    const rec = { v: 1, ts: Date.now(), kind: "notice", source, event, level };
    // Nulls are DROPPED, not written — a null on the wire cannot be told apart
    // from "this producer does not set that field", and absence is a state
    // everywhere else on this stream.
    if (detail !== null && detail !== undefined) rec.detail = detail;
    fs.appendFileSync(LIVE_STREAM_PATH, `${JSON.stringify(rec)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) {
    return null;
  }
  const next = process.argv[idx + 1];
  return next && !next.startsWith("--") ? next : null;
}

// PREFLIGHT ASKS THE CONTAINER, not the host: only the container knows what it
// has been given. `--resources` reports and exits, running no gates.
if (process.argv.includes("--resources")) {
  const shortfallNow = insufficientResources();
  process.stdout.write(`${describeWorkers()}\n`);
  if (shortfallNow) {
    process.stderr.write(`${shortfallNow}\n`);
    process.exit(1);
  }
  process.exit(0);
}

const targetArg = argValue("--target");
const outArg = argValue("--out");
const rosterArg = argValue("--roster");
const attemptArg = argValue("--attempt");

// Null when absent or unparseable — the phase notice omits a null `attempt`
// from its detail rather than putting one on the wire (absence is a state).
const attemptParsed = Number.parseInt(attemptArg ?? "", 10);
const ATTEMPT = Number.isNaN(attemptParsed) ? null : attemptParsed;

const TARGET = path.resolve(
  targetArg || process.env.BENCH_TARGET || path.join(GATES_DIR, "..", "golden"),
);
const env = { ...process.env, BENCH_TARGET: TARGET };

const nowIso = new Date().toISOString();
const defaultOut = path.join(
  GATES_DIR,
  "..",
  "runs",
  `${nowIso.replace(/[:.]/g, "-")}-report.json`,
);
const OUT_FILE = path.resolve(outArg || defaultOut);
const OUT_DIR = path.dirname(OUT_FILE);

/**
 * Per-runner log file, beside the report it explains.
 *
 * The runner's output now streams to disk WHILE it runs (lib/runner.mjs), so
 * a runner killed on its deadline still leaves a readable trace of what it
 * managed to say — the in-memory copy alone used to die with the process.
 *   "conformance"        -> conformance.log
 *   "frontend"           -> frontend.log
 *   "backend <file>"     -> backend-<slug>.log  (e.g. backend-gates-13-16.log)
 */
function phaseLogPath(label) {
  const text = String(label ?? "");
  if (text.startsWith("backend ")) {
    const file = text.slice("backend ".length);
    const slug = path
      .basename(file)
      .replace(/\.test\.ts$/, "")
      .replace(/[^a-zA-Z0-9-]/g, "-");
    return path.join(OUT_DIR, `backend-${slug}.log`);
  }
  const slug = text.replace(/[^a-zA-Z0-9-]/g, "-") || "runner";
  return path.join(OUT_DIR, `${slug}.log`);
}

function stripAnsi(text) {
  return String(text ?? "").replace(/\u001B\[[0-9;]*m/g, "");
}

function truncate(text, max) {
  const clean = String(text ?? "").trim();
  if (clean.length <= max) {
    return clean;
  }
  return `${clean.slice(0, max)}…`;
}

// ── PER-GATE OUTCOMES (WO-GATE-ROSTER) ──────────────────────────────────────
//
// The folding logic lives in `gate-results.mjs` — pure, roster-parameterised
// and therefore directly testable. It cannot be exercised from here: running
// this file grades a real target, which boots a server on :8002 and cannot be
// done beside a live cell.
const ROSTER = loadRoster(rosterArg);
const MATCHER = makeMatcher(ROSTER);

/**
 * Announce the gate set a phase is about to execute.
 *
 * PER-PHASE-SET, NOT PER-TEST. `spawnPhase` below re-emits a child's output
 * only after the runner has ENDED (the live stream goes to the per-phase log
 * file, not to this stderr), so per-test hooks inside the runners would
 * arrive as a burst at phase end, which is not a live signal at all. This
 * line is written by THIS process before the child starts, so it streams
 * immediately, exactly like the existing `[report] phase=` marker that the
 * harness already republishes.
 *
 * It carries a COUNT, not 47 ids: gate identity already lives in the roster the
 * board reads, and republishing long slug ids (which contain spaces) through a
 * whitespace-delimited log line would corrupt them. The count is the one fact
 * the roster cannot supply — the runner attesting how many gates it is about to
 * execute, which is what makes roster/runner drift detectable at all.
 */
function announceGateSet(phase) {
  if (!ROSTER.available) return;
  const count = ROSTER.gates.filter((g) => g.phase === phase).length;
  process.stderr.write(`[report] gateset phase=${phase} count=${count}\n`);
}

function firstNonEmptyLine(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines[0] || "<empty>";
}

function textFromEntry(entry) {
  if (typeof entry === "string") {
    return entry;
  }
  if (entry && typeof entry === "object" && typeof entry.text === "string") {
    return entry.text;
  }
  return "";
}

function safeProblem(check, expected, observed) {
  return {
    check: String(check ?? "unknown"),
    expected: String(expected ?? ""),
    observed: String(observed ?? ""),
  };
}

function dedupeProblems(problems) {
  const seen = new Set();
  const out = [];
  for (const problem of problems) {
    const key = `${problem.check}\u0000${problem.expected}\u0000${problem.observed}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(problem);
  }
  return out;
}

function dedupeStrings(items) {
  return [...new Set(items.filter((item) => item && String(item).trim().length > 0))];
}

function parseJsonObject(text) {
  const raw = String(text ?? "").trim();
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    // keep going
  }

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function extractBalancedSegment(text, open, close, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;

  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === open) {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }

    if (ch === close) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return text.slice(start, i + 1);
      }
      if (depth < 0) {
        return null;
      }
    }
  }

  return null;
}

function parseProblemLine(line) {
  const clean = stripAnsi(line).trim();
  if (!clean.startsWith("PROBLEM ")) {
    return null;
  }
  const payload = clean.slice("PROBLEM ".length);
  const expectedMarker = ": expected ";
  const expectedIdx = payload.indexOf(expectedMarker);
  if (expectedIdx < 0) {
    return null;
  }

  const check = payload.slice(0, expectedIdx).trim();
  const tail = payload.slice(expectedIdx + expectedMarker.length);
  const observedMarker = ", observed ";
  const observedIdx = tail.indexOf(observedMarker);
  if (observedIdx < 0) {
    return null;
  }

  const expected = tail.slice(0, observedIdx).trim();
  const observed = tail.slice(observedIdx + observedMarker.length).trim();
  return safeProblem(check, expected, observed);
}

function parseProblemsFromTextLines(text) {
  const out = [];
  const lines = String(text ?? "").split(/\r?\n/);
  for (const line of lines) {
    const parsed = parseProblemLine(line);
    if (parsed) {
      out.push(parsed);
    }
  }
  return out;
}

function parseProblemsFromErrorMessage(message) {
  const clean = stripAnsi(String(message ?? ""));
  const out = [];
  let idx = clean.indexOf("[");

  while (idx >= 0) {
    const segment = extractBalancedSegment(clean, "[", "]", idx);
    if (!segment) {
      break;
    }
    try {
      const parsed = JSON.parse(segment);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (
            item
            && typeof item === "object"
            && typeof item.check === "string"
            && Object.prototype.hasOwnProperty.call(item, "expected")
            && Object.prototype.hasOwnProperty.call(item, "observed")
          ) {
            out.push(safeProblem(item.check, item.expected, item.observed));
          }
        }
        if (out.length > 0) {
          return out;
        }
      }
    } catch {
      // keep searching for a parseable JSON array
    }

    idx = clean.indexOf("[", idx + 1);
  }

  return out;
}

function collectPlaywrightSpecs(suites, out = []) {
  if (!Array.isArray(suites)) {
    return out;
  }

  for (const suite of suites) {
    if (Array.isArray(suite?.specs)) {
      out.push(...suite.specs);
    }
    if (Array.isArray(suite?.suites)) {
      collectPlaywrightSpecs(suite.suites, out);
    }
  }
  return out;
}

function extractPlaywrightRunError(report) {
  if (!report || !Array.isArray(report.errors) || report.errors.length === 0) {
    return "";
  }

  for (const errorEntry of report.errors) {
    if (typeof errorEntry === "string" && errorEntry.trim()) {
      return stripAnsi(errorEntry.trim());
    }
    if (errorEntry && typeof errorEntry === "object") {
      if (typeof errorEntry.message === "string" && errorEntry.message.trim()) {
        return stripAnsi(errorEntry.message.trim());
      }
      const serialized = stripAnsi(JSON.stringify(errorEntry));
      if (serialized.trim()) {
        return serialized;
      }
    }
  }
  return "";
}

/**
 * Announce a phase, then run its one command.
 *
 * `[report] phase=<name> …` IS A WIRE FORMAT. The python adapter
 * (`bench/adapters/backgammon.py`) parses these lines out of stderr and
 * turns them into the board's live `gate-phase-start` / `gate-phase-end`
 * events: a line WITHOUT `status=` opens the phase, one WITH it closes it.
 * A second opener for the same phase would tell the board a new phase had
 * begun, so anything spawning more than one process per phase must use
 * `spawnRunner` and keep exactly one open/close pair around the whole set.
 */
async function spawnPhase(phase, cmd, args) {
  process.stderr.write(`\n[report] phase=${phase} target=${TARGET}\n`);
  return await spawnRunner(phase, cmd, args);
}

/**
 * Run one command inside an ALREADY-ANNOUNCED phase.
 *
 * Logs under `[report] runner=…`, which the adapter ignores — deliberately.
 * The phase boundary belongs to the caller.
 */
// ── EVERY RUNNER HAS A DEADLINE ─────────────────────────────────────────────
//
// Measured on run 1789076475: the candidate's `maxPlies` computed its used-die
// bit with `dice.indexOf(m.die)`, which returns the FIRST index of that value —
// so on doubles `[3,3,3,3]` every move set bit 0, the used mask never advanced,
// and the search never terminated. E01 spun forever.
//
// Nothing could stop it. Vitest's own `testTimeout` cannot fire against a
// SYNCHRONOUS loop — the candidate's recursion never yields, so the timer that
// would cancel it never runs (the same defect class the harness's watchdog
// comment already records). `spawnSync` then blocks with no deadline of its
// own, so the phase never returned, and the harness's 3600s whole-gate
// watchdog was the only thing left to fire. It killed the process group with
// the suite one file in.
//
// THE COST WAS THE WHOLE MEASUREMENT. Not "E01 failed" — no report was written
// at all. 118 gates, one bad function, zero scored, and the repair loop had
// nothing to tell the model because no attempt report existed.
//
// A per-runner deadline makes the blast radius one FILE. The other runners
// still execute, their gates still score, and the gates behind the wall come
// back `not_run` with a cause that names the timeout instead of vanishing.
//
// The cap is per runner, not per suite, and deliberately generous: the golden
// grades every backend file in seconds, so ten minutes is not a slow machine,
// it is code that does not return. `BENCH_RUNNER_TIMEOUT_MS` overrides it for
// a genuinely slow host.
// ── THE NUMBER, AND WHY IT IS THIS NUMBER ───────────────────────────────────
//
// A cap that can fire on a SLOW BUT CORRECT candidate manufactures a failure,
// which is worse than the hang it prevents. So it is set above the worst case a
// candidate can legitimately reach, computed from the configured per-test
// limits and the fact that everything runs serially (`workers: 1`,
// `fileParallelism: false`, `singleFork`):
//
//   conformance     65 tests, work in beforeAll, 30s   ->  ~60s
//   gates-01-08      8 tests x 60s (vitest testTimeout) ->  480s
//   gates-09-12     14 tests x 60s                      ->  840s   <- the max
//   gates-13-16      7 tests x 60s                      ->  420s
//   backend/edge     9 tests x 60s                      ->  540s
//   frontend        15 tests x 30s (playwright default) ->  465s
//
// Measured for scale: the golden grades all six in 14.4s; a real failing
// candidate (run 1788804359, 96/118) took 129s, because every failing assertion
// waits out its own timeout — a worse candidate is a slower suite.
//
// 900s clears the 840s worst case with room and is 7x the worst real candidate.
// Nothing legitimate reaches it; only code that does not return does.
const RUNNER_TIMEOUT_MS = (() => {
  const raw = Number(process.env.BENCH_RUNNER_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 900_000;
})();

// ── THE SUITE ALWAYS PRODUCES A REPORT ──────────────────────────────────────
//
// This is the property that was actually lost on run 1789076475, and it matters
// more than any individual gate: the harness's own 3600s watchdog killed the
// process group, so NO attempt report was written at all. Not "E01 failed" —
// nothing. 118 gates unscored, and the repair loop had nothing to tell the
// model because there was no report to read.
//
// So the suite owns a budget BELOW the harness's, and every runner's deadline
// is clamped to whatever remains of it. The arithmetic guarantee: the last
// runner cannot outlive the budget, so `report.mjs` always reaches its own
// write. The watchdog stops being the thing that ends grading.
//
// Runners that never start because the budget is gone are reported as skipped,
// with their gates `not_run` — an honest absence, never a pass and never a
// candidate failure.
const SUITE_BUDGET_MS = (() => {
  const raw = Number(process.env.BENCH_SUITE_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 3_300_000;
})();

const SUITE_STARTED_AT = Date.now();
const suiteRemainingMs = () => SUITE_BUDGET_MS - (Date.now() - SUITE_STARTED_AT);

async function spawnRunner(label, cmd, args) {
  process.stderr.write(
    `[report] runner=${label} cmd=${cmd} ${args.join(" ")}\n`,
  );

  // CLAMPED TO WHAT IS LEFT. A runner starting late with a full 900s of its own
  // could outlive the suite budget and hand the ending back to the harness
  // watchdog — the exact outcome this exists to prevent.
  const remaining = suiteRemainingMs();
  if (remaining <= 0) {
    process.stderr.write(
      `[report] runner=${label} SKIPPED — the ${Math.round(SUITE_BUDGET_MS / 1000)}s suite `
        + "budget is spent. Its gates are recorded not_run; a report is still written.\n",
    );
    return {
      ok: false,
      status: null,
      signal: null,
      error: null,
      timedOut: false,
      skipped: true,
      elapsedMs: 0,
      stdout: "",
      stderr: "",
    };
  }
  const deadlineMs = Math.min(RUNNER_TIMEOUT_MS, remaining);

  // ASYNC SPAWN + PROCESS-GROUP KILL (lib/runner.mjs). The old `spawnSync`
  // timeout killed only the DIRECT `npx` child; a surviving descendant (the
  // vitest/playwright worker executing candidate code) held the inherited
  // stdio pipe, so `spawnSync` never returned, `writeReport` never ran, and
  // the report was lost. The helper spawns detached and SIGKILLs the whole
  // group on the deadline, streaming output to a per-phase log as it goes.
  const run = await spawnWithDeadline({
    cmd,
    args,
    cwd: GATES_DIR,
    env,
    deadlineMs,
    logPath: phaseLogPath(label),
  });
  const elapsedMs = run.elapsedMs;

  // A timeout is recorded as its own fact rather than folded into "the runner
  // failed": a file that was KILLED for not returning and a file that exited
  // nonzero on a broken test are different findings, and the gradability
  // reason has to be able to say which.
  // EVERY runner reports its wall time, not just the ones that blow the cap.
  // The cap is only defensible against real numbers, and the numbers have to be
  // visible in the log of the run that is being judged — not rediscovered later
  // on a different machine.
  process.stderr.write(
    `[report] runner=${label} finished elapsed_ms=${elapsedMs} `
      + `limit_ms=${deadlineMs} headroom=${(deadlineMs / Math.max(elapsedMs, 1)).toFixed(1)}x `
      + `suite_remaining_ms=${Math.max(suiteRemainingMs(), 0)}\n`,
  );

  if (run.timedOut) {
    process.stderr.write(
      `[report] runner=${label} TIMED OUT after ${elapsedMs}ms `
        + `(limit ${deadlineMs}ms); killed. Its gates cannot be measured; `
        + "the remaining runners continue.\n",
    );
  }

  const stdout = String(run.stdout ?? "");
  const stderr = String(run.stderr ?? "");

  if (stdout) {
    process.stderr.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
  }
  if (stderr) {
    process.stderr.write(stderr.endsWith("\n") ? stderr : `${stderr}\n`);
  }
  if (run.error) {
    // `label`, not `phase` — `phase` is not in scope here and never was. It
    // stayed latent because `run.error` was only ever set by a genuine spawn
    // failure; adding a deadline made ETIMEDOUT set it too, and the
    // ReferenceError took down the whole grader on the first timeout.
    process.stderr.write(`[report] runner=${label} spawn_error=${run.error.message}\n`);
  }

  // The helper already returns the exact field contract this function used to
  // build by hand: { ok, status, signal, error, timedOut, skipped, elapsedMs,
  // stdout, stderr }. A RUNNER THAT WAS KILLED IS NOT A RUNNER THAT FAILED —
  // `signal` carries the terminating signal so "vitest was killed mid-suite"
  // and "vitest exited 1 on a broken test" never reach the report as the same
  // nonzero status.
  return run;
}

// ── RESOURCES, BEFORE ANY PHASE ─────────────────────────────────────────────
//
// Replaces the host-Node floor check, which existed only while grading could
// run on an uncontrolled machine. The runtime is now the image's, so there is
// nothing to assert about it.
//
// What DOES still have to be asserted is room to work. Starting a grading pass
// that cannot fit a single browser ends in an OOM kill part-way through, and an
// OOM kill is recorded as gates failing — a machine that was busy, certified as
// a candidate that was wrong. Sized against FREE memory, because the operator
// may already have containers running.
const shortfall = insufficientResources();
if (shortfall) {
  process.stderr.write(`[report] ABORT — ${shortfall}\n`);
  process.exit(2);
}
process.stderr.write(`[report] ${describeWorkers()}\n`);

async function runConformancePhase() {
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
  // (`_CONF_KEY_RE` in adapters/backgammon.py). One finding is now one gate, so
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

function extractExpectedObserved(failureMessage, fallbackExpected) {
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
function backendTestFiles() {
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
async function runBackendPhase() {
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

function firstFrontendFailureMessage(spec) {
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

function specFailed(spec) {
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

async function runFrontendPhase() {
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
    problems.push(safeProblem(stall, "the game keeps responding", "frontend did not finish"));
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

function writeReport(outPath, payload) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * GRADABLE, OR NOT A SCORE.
 *
 * ── WHY AN ATTEMPT NEEDS THIS ───────────────────────────────────────────────
 *
 * `not_run` is honest about a single gate: it was not measured. What the report
 * could not say is that the ATTEMPT as a whole stopped being a measurement.
 *
 * On the 2026-08-17 minimax-m3 cell a stalled worker cost six of seven backend
 * files. The report published `16/71 pass` and pushed `backend:runner` into
 * `failed_gates` — so a harness abort arrived at the board as a gate the MODEL
 * failed, inside a ratio that read like a score. Re-grading that worktree gives
 * 69/71. Nothing in the artifact marked the number as unusable.
 *
 * A runner that aborts leaves gates unmeasured FOR HARNESS REASONS. The pass
 * count that survives is a lower bound on an unknown, not a result, and it must
 * never be compared against a run that completed. This states that in the
 * artifact so a consumer can refuse it rather than average it in.
 *
 * THE VERDICT IS UNTOUCHED. A cell that genuinely failed a gate still reads
 * FAIL — gradability answers "was this measured", not "did it pass", and
 * collapsing the two would let a broken harness launder a real failure.
 */
function gradability({ backend, frontend, conformance, folded }) {
  const aborted = [
    ...(backend.abortedFiles ?? []).map((f) => `backend ${f}`),
    ...(frontend.aborted ? ["frontend"] : []),
    // A conformance phase that FAILED and produced nothing readable is in the
    // same class: the gates did not fail, the instrument did. It used to
    // manufacture a `conformance:boot` problem and publish as gradable, which
    // is how a phase with 11 real failings passed for a single boot complaint.
    ...(conformance?.unreadable ? ["conformance"] : []),
  ];

  if (aborted.length === 0) {
    return {
      gradable: true,
      ungradable_reason: null,
      aborted_runners: [],
      timed_out_runners: [],
      skipped_runners: [],
    };
  }

  // A DEADLINE IS ITS OWN FINDING. Folding it into "did not finish" loses the
  // one fact that points at the cause: the runner was killed because the code
  // under test never returned, which is the candidate's engine, not the
  // instrument. Measured on run 1789076475 (`maxPlies` recursing forever on
  // doubles), where the absence of any per-runner deadline cost all 118 gates.
  const timedOut = [
    ...(backend.timedOutFiles ?? []).map((f) => `backend ${f}`),
    ...(frontend.timedOut ? ["frontend"] : []),
    ...(conformance?.timedOut ? ["conformance"] : []),
  ];
  const skipped = [
    ...(backend.skippedFiles ?? []).map((f) => `backend ${f}`),
    ...(frontend.skipped ? ["frontend"] : []),
    ...(conformance?.skipped ? ["conformance"] : []),
  ];

  const unmeasured = (folded.gate_results ?? []).filter((g) => g.status === "not_run").length;
  return {
    gradable: false,
    ungradable_reason:
      `${aborted.join(", ")} did not finish, leaving ${unmeasured} `
      + "gate(s) unmeasured — the pass count below is a lower bound on an unknown, not a score, "
      + "and must not be compared against a completed run"
      + (timedOut.length
        ? `. ${timedOut.join(", ")} was KILLED ON A DEADLINE: the code under test did not `
          + "return, so those gates could not be measured at all. Every other runner still ran."
        : "")
      + (skipped.length
        ? `. ${skipped.join(", ")} never started — the suite budget was already spent, so `
          + "those gates are unmeasured for instrument reasons and are not the candidate's."
        : ""),
    aborted_runners: aborted,
    timed_out_runners: timedOut,
    skipped_runners: skipped,
  };
}

// Per-gate live streaming is not wired — the phase runners speak on this
// stderr only when they complete — so the phase is the smallest honest unit of
// wall clock: one notice after each phase completes, carrying its duration.
function buildPhaseDetail(phase, attempt, durationMs) {
  const detail = { phase, duration_ms: durationMs };
  if (attempt !== null) {
    detail.attempt = attempt;
  }
  return detail;
}

async function runPhase(phase, fn) {
  const before = Date.now();
  const result = await fn();
  const durationMs = Date.now() - before;
  notice("gates", "gate_phase_duration", {
    level: "info",
    detail: buildPhaseDetail(phase, ATTEMPT, durationMs),
  });
  return result;
}

async function main() {
  const conformance = await runPhase("conformance", runConformancePhase);
  const backend = await runPhase("backend", runBackendPhase);
  const frontend = await runPhase("frontend", runFrontendPhase);

  const results = {
    conformance: conformance.passed,
    backend: backend.passed,
    frontend: frontend.passed,
  };

  const problems = dedupeProblems([
    ...conformance.problems,
    ...backend.problems,
    ...frontend.problems,
  ]);
  const failedGates = dedupeStrings([
    ...conformance.failedGates,
    ...backend.failedGates,
    ...frontend.failedGates,
  ]);

  const verdict = Object.values(results).every(Boolean) ? "PASS" : "FAIL";

  // A phase "ran" when its runner produced at least one per-test result. That
  // distinguishes "the phase executed and this gate still has no result" from
  // "the phase never got far enough to execute anything", which are different
  // reasons for the same not_run and must not be collapsed (invariant I-2).
  const phaseRan = {
    conformance: conformance.gateResults.length > 0,
    backend: backend.gateResults.length > 0,
    frontend: frontend.gateResults.length > 0,
  };
  const folded = foldGateResults({
    roster: ROSTER,
    matcher: MATCHER,
    observed: [...conformance.gateResults, ...backend.gateResults, ...frontend.gateResults],
    phaseRan,
  });

  const report = {
    target: TARGET,
    timestamp: nowIso,
    results,
    verdict,
    conformed: results.conformance,
    problems,
    // UNCHANGED, deliberately: every existing consumer of the gate report reads
    // this key and it keeps its exact prior meaning and shape.
    failed_gates: failedGates,
    // WO-GATE-ROSTER additions. Purely additive — nothing above is altered.
    ...folded,
    // ── IS THIS ATTEMPT A MEASUREMENT AT ALL? ────────────────────────────
    ...gradability({ backend, frontend, conformance, folded }),
  };

  writeReport(OUT_FILE, report);
  process.stderr.write(`[report] out=${OUT_FILE}\n`);
  process.stdout.write(`BG_GATE_REPORT_JSON ${JSON.stringify(report)}\n`);
  process.exit(verdict === "PASS" ? 0 : 1);
}

main().catch((error) => {
  const fatalObserved = truncate(
    stripAnsi(error instanceof Error ? `${error.message}\n${error.stack || ""}` : String(error)),
    400,
  );
  const fallback = {
    target: TARGET,
    timestamp: nowIso,
    results: {
      conformance: false,
      backend: false,
      frontend: false,
    },
    verdict: "FAIL",
    conformed: false,
    problems: [
      {
        check: "runner:exception",
        expected: "report runner executes without uncaught exceptions",
        observed: fatalObserved,
      },
    ],
    failed_gates: ["runner:exception"],
    // The runner threw. Nothing was measured, so there is no score to publish.
    gradable: false,
    ungradable_reason:
      "the gate runner threw before it could grade — no phase produced results, so this attempt "
      + "is not a measurement of the code under test",
    aborted_runners: [],
    timed_out_runners: [],
    skipped_runners: [],
    // The runner died. NOTHING was measured, so every roster gate is not_run —
    // never fail (the gates did not fail, the harness did) and never absent
    // (absence reads as pass). Invariants I-3 and I-4.
    ...foldGateResults({
      roster: ROSTER,
      matcher: MATCHER,
      observed: [],
      phaseRan: { conformance: false, backend: false, frontend: false },
    }),
  };

  try {
    writeReport(OUT_FILE, fallback);
    process.stderr.write(`[report] out=${OUT_FILE}\n`);
  } catch {
    // ignore secondary write failure; still emit JSON line
  }

  process.stdout.write(`BG_GATE_REPORT_JSON ${JSON.stringify(fallback)}\n`);
  process.exit(1);
});
