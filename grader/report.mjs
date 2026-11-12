#!/usr/bin/env node
import { spawnWithDeadline } from "./lib/runner.mjs";
import { describeWorkers, insufficientResources } from "./lib/workers.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  foldGateResults,
  layerVerdict,
  loadRoster,
  makeMatcher,
} from "./gate-results.mjs";
import { runConformancePhase } from "./lib/conformance.mjs";
import { runBackendPhase } from "./lib/backend.mjs";
import { runFrontendPhase } from "./lib/frontend.mjs";
import { dedupeProblems, dedupeStrings, stripAnsi, truncate } from "./lib/parse.mjs";
import { loadLayerMap } from "./roster.mjs";

export const GATES_DIR = path.dirname(fileURLToPath(import.meta.url));

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

export function notice(source, event, { level = "info", detail = null } = {}) {
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

// ── LAYERS — grade a prefix of the suite ─────────────────────────────────────
//
// `--layer N` grades layers 1..N and reports every gate above N as
// `not_graded` (never `fail`): it did not fail, it was not asked. The layer of
// a gate is authored once in grader/layers.json and stamped onto the roster
// (roster.mjs), so the selector never carries a second copy of that map.
const layerArg = argValue("--layer");
const layerParsed = layerArg == null ? null : Number.parseInt(layerArg, 10);
if (layerArg != null && !(Number.isInteger(layerParsed) && layerParsed >= 1 && layerParsed <= 3)) {
  process.stderr.write(`[report] invalid --layer ${JSON.stringify(layerArg)}: must be 1, 2, or 3\n`);
  process.exit(2);
}
const LAYER = layerParsed;

// The layer a told problem belongs to, as layers.json places it: the check's own
// entry (a number or {layer}) — `[F03] …` → F03, `conformance:REQ-RENDER/x — …`
// → that requirement, a key ending in "/" covering its family — else the layer of
// the stage checks.json files it under. An id neither names is kept in every
// layer (1), never silently dropped.
const LAYER_MAP = LAYER == null ? null : loadLayerMap(GATES_DIR);
const STAGE_KEYS = LAYER == null
  ? []
  : (JSON.parse(fs.readFileSync(path.join(GATES_DIR, "checks.json"), "utf8")).stages ?? []).map((st) => ({
      stage: String(st.stage),
      keys: (st.checks ?? []).map(String),
    }));
const layerValue = (v) => (typeof v === "number" ? v : typeof v?.layer === "number" ? v.layer : null);
function problemLayer(check) {
  const raw = String(check ?? "");
  const id = /^\[([A-Z]+\d+)\]/.exec(raw)?.[1] ?? /(?:^|:)(REQ-[A-Z]+\/[^\s—]*)/.exec(raw)?.[1];
  if (!id) return 1;
  const own = layerValue(LAYER_MAP.checks[id]);
  if (own != null) return own;
  let best = null;
  for (const [key, v] of Object.entries(LAYER_MAP.checks)) {
    if (key.endsWith("/") && id.startsWith(key) && (best == null || key.length > best[0].length)) best = [key, v];
  }
  if (best && layerValue(best[1]) != null) return layerValue(best[1]);
  for (const { stage, keys } of STAGE_KEYS) {
    if (keys.some((k) => k === id || (k.endsWith("/") && id.startsWith(k)))) {
      const v = layerValue(LAYER_MAP.stages?.[stage]);
      if (v != null) return v;
    }
  }
  return 1;
}

// Null when absent or unparseable — the phase notice omits a null `attempt`
// from its detail rather than putting one on the wire (absence is a state).
const attemptParsed = Number.parseInt(attemptArg ?? "", 10);
const ATTEMPT = Number.isNaN(attemptParsed) ? null : attemptParsed;

export const TARGET = path.resolve(
  targetArg || process.env.BENCH_TARGET || path.join(GATES_DIR, "..", "task", "backgammon", "golden"),
);
const env = {
  ...process.env,
  BENCH_TARGET: TARGET,
  // The runners are this process's own children, so the selected layer travels
  // the same way the target does — one env read, no argv duplication.
  ...(LAYER != null ? { BENCH_LAYER: String(LAYER) } : {}),
};

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

// ── PER-GATE OUTCOMES (WO-GATE-ROSTER) ──────────────────────────────────────
//
// The folding logic lives in `gate-results.mjs` — pure, roster-parameterised
// and therefore directly testable. It cannot be exercised from here: running
// this file grades a real target, which boots a server on :8002 and cannot be
// done beside a live cell.
export const ROSTER = loadRoster(rosterArg);
export const MATCHER = makeMatcher(ROSTER);

// A LAYER RUN NEEDS LAYERS. Without them every phase is unplaceable, so a
// pass would either grade nothing or grade everything under a header claiming
// otherwise — both are a confident verdict about a scope nobody chose. Refuse
// at the door instead, with the reason on stderr.
if (LAYER != null && !ROSTER.available) {
  process.stderr.write(
    `[report] --layer requires a roster to scope the pass: ${ROSTER.reason ?? "no roster"}\n`,
  );
  process.exit(2);
}
if (LAYER != null && ROSTER.gates.some((g) => g.layer == null)) {
  process.stderr.write("[report] --layer requires a roster carrying per-gate layer (regenerate with roster.mjs); the supplied roster does not\n");
  process.exit(2);
}

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
export function announceGateSet(phase) {
  if (!ROSTER.available) return;
  const count = ROSTER.gates.filter((g) => g.phase === phase).length;
  process.stderr.write(`[report] gateset phase=${phase} count=${count}\n`);
}

/**
 * Announce a phase, then run its one command.
 *
 * `[report] phase=<name> …` IS A WIRE FORMAT. The python adapter
 * (`harness/adapters/challenge.py`) parses these lines out of stderr and
 * turns them into the board's live `gate-phase-start` / `gate-phase-end`
 * events: a line WITHOUT `status=` opens the phase, one WITH it closes it.
 * A second opener for the same phase would tell the board a new phase had
 * begun, so anything spawning more than one process per phase must use
 * `spawnRunner` and keep exactly one open/close pair around the whole set.
 */
export async function spawnPhase(phase, cmd, args) {
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
//   gates-13-16      5 tests x 60s (the server gates)    ->  300s (360s with the allowance)
//   gates-14-30      3 tests x 60s (the engine, self-play) -> 180s
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

// ── A BUDGET THE SIZE OF THE WORK ───────────────────────────────────────────
//
// One flat 900s for every file is the right ceiling and the wrong budget.
// `backend/gates-01-08.test.ts` takes 3ms against the golden, so 900s is
// 285,000x the reference — a candidate whose engine does not return sits there
// for fifteen minutes before anyone says so. Measured: a `for (let from = 1;
// from <= 24; from--)` typo in one candidate's `singleMoves` loops forever, and
// the suite waited out the full flat timeout to find out.
//
// So each file gets STARTUP_ALLOWANCE + its golden time x MULTIPLIER, clamped
// to the flat timeout. The allowance covers npx/vitest boot (~0.5s here, more
// on a loaded host) and is deliberately far larger than that; the multiplier
// covers a candidate that is correct but slow.
//
// CALIBRATION, against real candidates rather than taste. The worst measured
// legitimate slowdowns are in the tens: gates-13-16 went 1.63s -> 74.9s on the
// 2026-08-17 minimax-m3 cell (~46x), and G14's two gates took 87s and 151s on
// another. 1000x clears every one of those by more than an order of magnitude.
// The floor matters more than the multiplier for the fast files: it is what
// keeps a 3ms file from being handed a 3-second budget.
//
// A FILE WITH NO REFERENCE TIME KEEPS THE FLAT TIMEOUT. Never stricter than
// the behaviour before these numbers existed, so a new gate file cannot be
// failed by an omission in golden-timings.json.
const RUNNER_STARTUP_ALLOWANCE_MS = 60_000;
const RUNNER_GOLDEN_MULTIPLIER = 1000;

const GOLDEN_TIMINGS = (() => {
  try {
    const raw = fs.readFileSync(path.join(GATES_DIR, "golden-timings.json"), "utf8");
    return JSON.parse(raw)?.files ?? {};
  } catch {
    // Absent or unreadable: every file falls back to the flat timeout.
    return {};
  }
})();

// ── A FILE CANNOT LEGITIMATELY TAKE LONGER THAN ITS TESTS' OWN LIMITS ───────
//
// Every test has the vitest `testTimeout` (60s), and the file runs serially, so
// a file of N tests cannot take longer than the startup allowance plus N x 60s
// without a test being stuck past its own limit. That is the ceiling for the
// file, and it is far below the flat 900s for a small file: gates-14-30 (the
// engine's self-play, the gates that hang) holds 3 tests, 240s; gates-13-16
// holds 5, 360s. gates-09-12 holds 14, so it keeps its full 840s + allowance
// (still clamped to the flat ceiling). Counted from the file itself, so a gate
// added to a file raises its own ceiling and nothing has to be kept in step.
const VITEST_TEST_TIMEOUT_MS = 60_000;

function testCountOf(file) {
  try {
    const src = fs.readFileSync(path.join(GATES_DIR, file), "utf8");
    const n = (src.match(/\b(?:it|test)\(\s*["'`]/g) ?? []).length;
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** The deadline for one runner, from the reference time of the file it runs. */
export function runnerBudgetMs(label) {
  const s = String(label ?? "");
  for (const [file, goldenMs] of Object.entries(GOLDEN_TIMINGS)) {
    if (!s.includes(file)) continue;
    const scaled = RUNNER_STARTUP_ALLOWANCE_MS + Number(goldenMs) * RUNNER_GOLDEN_MULTIPLIER;
    if (!Number.isFinite(scaled) || scaled <= 0) break;
    const n = testCountOf(file);
    const ceiling = n === null ? RUNNER_TIMEOUT_MS : RUNNER_STARTUP_ALLOWANCE_MS + n * VITEST_TEST_TIMEOUT_MS;
    return Math.min(RUNNER_TIMEOUT_MS, ceiling, Math.round(scaled));
  }
  return RUNNER_TIMEOUT_MS;
}

export async function spawnRunner(label, cmd, args) {
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
  const deadlineMs = Math.min(runnerBudgetMs(label), remaining);

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

/**
 * RENDER-BLOCKED: WHY THE BOARD NEVER APPEARED.
 *
 * When an attempt dies before the "resolution point" — before any checker
 * carries a numeric data-loc — every downstream frontend gate throws the same
 * "numeric data-loc" complaint and the model cannot iterate on it. This
 * collapses the aggregated problems[] into WHICH cause happened, stated as one
 * structured fact (null, or {reason, evidence, gates}) in `render_blocked`.
 * A fourth cause sits PAST the resolution point: the checkers placed, but no
 * point ever rendered a visible triangle (geometry-not-drawn).
 *
 * The model-facing line is then spoken in TWO VOICES (see main()):
 *   - TEAM voice (REQ-STATE/*) names the technical CAUSE the integration team
 *     hit — server-not-answering / state-empty.
 *   - PLAYER voice (REQ-RENDER/*) names the visible SYMPTOM the player saw —
 *     blank-board (for either backend cause, OR no checker reached a numeric
 *     data-loc — no pieces to see) / geometry-not-drawn (the checkers placed
 *     but the board geometry never drew).
 * Both fire together when the resolution point is not reached; for
 * no-positions the team has nothing to add, so only the player speaks — and
 * geometry-not-drawn is player-only for the same reason.
 *
 * PRIORITY IS LOAD-BEARING: the frontend "numeric data-loc" throw fires in ALL
 * render-blocked cases, so it can only be attributed to no-positions once
 * server-not-answering and state-empty are ruled out. geometry-not-drawn
 * closes the ladder on its own distinct signal — gameReady's "board geometry
 * never drew" throw — which by definition only fires once a checker DID reach
 * a numeric data-loc.
 */
function deriveRenderBlocked(problems) {
  const stateProblems = problems.filter((p) => p.check.includes("REQ-STATE/state."));

  const emptyState = stateProblems.filter((p) => p.observed === "missing");
  if (emptyState.length > 0) {
    return {
      reason: "state-empty",
      evidence:
        "the backend answered /api/state but returned an empty state — required state fields are missing",
      gates: emptyState.map((p) => p.check),
    };
  }

  const neverEvaluated = stateProblems.filter((p) => p.observed.startsWith("never evaluated"));
  if (neverEvaluated.length > 0) {
    return {
      reason: "server-not-answering",
      evidence: "the backend did not answer /api/state — the state fields were never evaluated",
      gates: neverEvaluated.map((p) => p.check),
    };
  }

  const noPositions = problems.filter((p) => p.observed.includes("numeric data-loc"));
  if (noPositions.length > 0) {
    return {
      reason: "no-positions",
      evidence:
        "no checker reached a numeric data-loc — the board never settled past the first placed checker",
      gates: noPositions.map((p) => p.check),
    };
  }

  const geometryNotDrawn = problems.filter((p) => p.observed.includes("board geometry never drew"));
  if (geometryNotDrawn.length > 0) {
    // Placed is not shown: the player's line says "I can see the pieces" only
    // when gameReady counted some on screen (its "(N pieces showing)").
    const piecesShowing = Math.max(
      0,
      ...geometryNotDrawn.map((p) => Number(/\((\d+) pieces showing\)/.exec(p.observed)?.[1] ?? 0)),
    );
    return {
      reason: "geometry-not-drawn",
      evidence:
        "no point rendered a visible triangle — the checkers placed but the board geometry never drew",
      gates: geometryNotDrawn.map((p) => p.check),
      piecesShowing,
    };
  }

  return null;
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

/**
 * Does this phase hold any gate the requested layers cover?
 *
 * A phase whose gates are ALL above the requested layer has nothing to measure,
 * so running it would spend the board's time to produce rows that are reported
 * `not_graded` regardless. `backend` is the case that matters: it carries no
 * layer-1 or layer-2 gate at all, so `--layer 1|2` must not boot it.
 */
function phaseSelected(phase) {
  if (LAYER == null) return true;
  return ROSTER.gates.some(
    (g) => g.phase === phase && typeof g.layer === "number" && g.layer <= LAYER,
  );
}

/**
 * A phase this pass did not select. It never ran, so every field is neutral.
 *
 * THE SHAPE MIRRORS THE THREE RUNNERS' (lib/conformance.mjs,
 * lib/backend.mjs, lib/frontend.mjs) because `main()` and `gradability()` read
 * these fields directly: nothing aborted, nothing timed out, nothing was lost to
 * the suite budget, and `passed` is true — the phase did not fail, it was not
 * asked. No `[report] phase=` line is emitted for it, so the adapter opens no
 * phase the board would then wait to see close.
 */
function skippedPhase(phase) {
  process.stderr.write(`[report] skip phase=${phase} reason=no gate selected at layer ${LAYER}\n`);
  return {
    passed: true,
    problems: [],
    failedGates: [],
    gateResults: [],
    unreadable: false,
    timedOut: false,
    skipped: false,
    aborted: false,
    abortedFiles: [],
    timedOutFiles: [],
    skippedFiles: [],
  };
}

// ── BOARD CAPTURE — best-effort artifact, never a gate ──────────────────────
//
// Runs AFTER writeReport and after the verdict is decided, so there is nothing
// left for it to change: exit code, stdout and problems are all discarded, and
// nothing here reaches results, problems, failed_gates, gate_results or
// gate_totals. It saves attempt-N-board.png beside the report it illustrates
// (capture/board-capture.spec.ts under playwright.capture.config.ts — a config
// deliberately NOT among roster.mjs's three --list commands, so the gate
// roster is untouched).
//
// The deadline is the same mechanism every runner uses (spawnWithDeadline,
// lib/runner.mjs: detached spawn, SIGKILL of the whole process group), so a
// wedged browser cannot hang the grade. 120s is generous for npx boot + one
// server boot + a single test under Playwright's 30s default + a screenshot,
// and it still fits inside the margin to the harness's 3600s watchdog even
// when the 3300s suite budget was fully spent. The try/catch is the last wall:
// a capture bug must never throw out of main() and replace a written
// PASS/FAIL report with the fallback FAIL.
const CAPTURE_TIMEOUT_MS = 120_000;

async function captureBoard() {
  const attempt = String(ATTEMPT ?? 1);
  const pngPath = path.join(OUT_DIR, `attempt-${attempt}-board.png`);
  try {
    process.stderr.write(`[report] capture=board attempt=${attempt} dir=${OUT_DIR}\n`);
    const run = await spawnWithDeadline({
      cmd: "npx",
      args: [
        "playwright",
        "test",
        "--config",
        "playwright.capture.config.ts",
        "--project=chromium",
        "--reporter=json",
      ],
      cwd: GATES_DIR,
      env: {
        ...env,
        BENCH_ATTEMPT: attempt,
        BENCH_CAPTURE_DIR: OUT_DIR,
      },
      deadlineMs: CAPTURE_TIMEOUT_MS,
      logPath: path.join(OUT_DIR, "capture.log"),
    });
    // Observability only — the run's ok/status/problems are ignored by design.
    process.stderr.write(
      `[report] capture=board finished elapsed_ms=${run.elapsedMs} `
        + `png_exists=${fs.existsSync(pngPath)}\n`,
    );
  } catch {
    // Best-effort: a capture failure is invisible to the grade.
  }
}

async function main() {
  const conformance = phaseSelected("conformance")
    ? await runPhase("conformance", runConformancePhase)
    : skippedPhase("conformance");
  const backend = phaseSelected("backend")
    ? await runPhase("backend", runBackendPhase)
    : skippedPhase("backend");
  const frontend = phaseSelected("frontend")
    ? await runPhase("frontend", runFrontendPhase)
    : skippedPhase("frontend");
  const skippedPhases = ["conformance", "backend", "frontend"].filter((p) => !phaseSelected(p));

  const results = {
    conformance: conformance.passed,
    backend: backend.passed,
    frontend: frontend.passed,
  };

  // A LAYER RUN TELLS ONLY ITS LAYERS. The verdict is scoped by the fold; the
  // problem list is what the harness turns into told lines, so it is scoped the
  // same way. A layer-1 pass of the golden listed REQ-RENDER/die-reload (layer 3)
  // as "never evaluated", which would reach a model building only the board.
  const problems = dedupeProblems([
    ...conformance.problems,
    ...backend.problems,
    ...frontend.problems,
  ]).filter((p) => LAYER == null || problemLayer(p.check) <= LAYER);
  // Scoped like the problems: run 1794248721's layer-1 grade counted 60 failed
  // gates, 52 of them layer-2/3 gates this pass never graded (8 truly failed).
  const failedGates = dedupeStrings([
    ...conformance.failedGates,
    ...backend.failedGates,
    ...frontend.failedGates,
  ]).filter((check) => LAYER == null || problemLayer(check) <= LAYER);

  // RENDER-BLOCKED: one structured fact for the report, plus synthetic
  // problems in TWO VOICES so the model hears both what the integration team
  // hit and what the player actually saw. problems ONLY — failedGates is
  // deliberately untouched: these rows tell the cause, they are not scored
  // failures.
  const renderBlocked = deriveRenderBlocked(problems);
  if (renderBlocked) {
    const reason = renderBlocked.reason;
    // TELL THE CAUSE, NOT ITS SYMPTOMS. Every gate in renderBlocked.gates
    // died on the same render-blocked throw before reaching its own subject,
    // so its own line ("the triangles point outward", "the buttons aren't
    // labelled", "console errors") states something nobody observed — run
    // 1793876536 told a player 30 such lines about triangles that never drew.
    // REQ-RENDER/checker's "incorrect number of pieces" is the same collapse
    // (nothing drew, so the count is 0). These gates still score in
    // gate_results and failedGates; only the TOLD problem set drops them, and
    // the one cause line below stands for all of them. Runs after
    // deriveRenderBlocked so the classification is undisturbed. `problems` is
    // const, so splice in place, descending, to keep indices valid.
    const blockedChecks = new Set(renderBlocked.gates);
    for (let i = problems.length - 1; i >= 0; i -= 1) {
      if (
        blockedChecks.has(problems[i].check) ||
        problems[i].check.includes("REQ-RENDER/checker")
      ) {
        problems.splice(i, 1);
      }
    }
    // TEAM voice — the integration cause (only the two backend causes have
    // one; for no-positions and geometry-not-drawn the API answered fine and
    // the team has nothing to add).
    if (reason === "server-not-answering" || reason === "state-empty") {
      problems.push({
        check: `conformance:REQ-STATE/${reason} — the board cannot be rendered`,
        expected: "the board renders a placed checker",
        observed: reason,
      });
    }
    // PLAYER voice — the visible symptom (geometry-not-drawn for the
    // API-is-fine-and-checkers-placed cause; blank-board for the rest).
    const piecesShown = reason === "geometry-not-drawn" && renderBlocked.piecesShowing > 0;
    const symptom = piecesShown ? reason : "blank-board";
    problems.push({
      check: `conformance:REQ-RENDER/${symptom} — the board cannot be rendered`,
      expected: "the board renders a placed checker",
      observed: reason,
    });
    // geometry-not-drawn means pieces WERE placed (that is how it is told
    // apart). On a layer-1 pass, pieces are themselves a finding — the board
    // and buttons come first — and F91, which says so, died on the same
    // settle as every other blocked gate. Run 1794300137's first layer-1 grade
    // drew 30 pieces and no triangles and was told only the triangles.
    if (piecesShown && LAYER === 1) {
      problems.push({
        check: "[F91] REQ-RENDER — no pieces before the pieces layer",
        expected: "no pieces at layer 1",
        observed: "at layer 1 pieces are drawn on the board while the board itself never drew",
      });
    }
  }

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
    timedOutFiles: new Set(backend.timedOutFiles ?? []),
    layer: LAYER,
  });

  // THE VERDICT IS DECIDED AFTER THE FOLD, because only the fold knows which
  // gates this pass was asked to grade. Unscoped it stays exactly the phase
  // conjunction it always was; scoped it is the conjunction over layers 1..N,
  // where everything above N came back `not_graded` and is out of the
  // denominator rather than failing it.
  const verdict =
    LAYER == null
      ? (Object.values(results).every(Boolean) ? "PASS" : "FAIL")
      : (layerVerdict(folded.gate_results, LAYER) ? "PASS" : "FAIL");

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
    // WHICH PASS THIS WAS. Only present on a `--layer` run: an unscoped report
    // keeps its exact prior shape, and a scoped one states both the layers it
    // covered and the phases that therefore never booted — so a reader can tell
    // "not measured" from "not asked for" without diffing two reports.
    ...(LAYER != null ? { layer: LAYER, skipped_phases: skippedPhases } : {}),
    // ── IS THIS ATTEMPT A MEASUREMENT AT ALL? ────────────────────────────
    ...gradability({ backend, frontend, conformance, folded }),
    // AFTER both spreads, deliberately: nothing may shadow this field.
    render_blocked: renderBlocked,
  };

  writeReport(OUT_FILE, report);
  // ONE STREAM. A grading run writes only to stderr, and the report reaches
  // every reader as the file above. It used to repeat itself on stdout, and the
  // harness reads both streams through one pipe: the docker CLI copies each in
  // its own chunks, so the stdout line landed at an arbitrary byte of the
  // stderr log — mid-word in one attempt ("filBG_GATE_REPORT_JSON"), and inside
  // an em dash in the next, which is invalid UTF-8 and killed the cell (run
  // 1790355908, attempt 2).
  process.stderr.write(`[report] out=${OUT_FILE}\n`);

  // The report is on disk and the verdict is decided; the capture below is a
  // side effect that can neither change them nor throw (see captureBoard).
  await captureBoard();

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
    // The runner threw: nothing was measured, so no render-blocked cause can
    // be claimed.
    render_blocked: null,
  };

  try {
    writeReport(OUT_FILE, fallback);
    process.stderr.write(`[report] out=${OUT_FILE}\n`);
  } catch (err) {
    // No report file: the harness stops on the missing report and names it.
    process.stderr.write(`[report] could not write ${OUT_FILE}: ${err?.message ?? err}\n`);
  }

  process.exit(1);
});
