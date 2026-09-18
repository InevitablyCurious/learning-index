// GATE WALL — the gate roster (gate-roster.json, write-once) folded with the
// test outcomes (manifest.status.jsonl gate_results). Each gate is passing,
// failing or untested, from the last completed test run only; no phase and no
// live or provisional signal.
//
// Separately, each gate carries its trajectory — first_pass_attempt and
// ever_failed, folded across all attempts — because attempts-to-green is what
// the bench measures. It never changes `state`, the sole verdict.
//
// Read-only: reads two files, never writes, spawns or signals.

import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { attachGateDetail } from "./gate-detail.mjs";
import { listChallenges } from "./challenges.mjs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** How long the enumerator may take before the suite is reported unknown. */
const ROSTER_ENUMERATE_TIMEOUT_MS = 60_000;

/** The contract version the board can assert against. */
export const WALL_CONTRACT_VERSION = 2;

/**
 * Last resort only, for a bench with no cell log: the caller resolves the
 * active run from the cell log. A missing directory is reported as unwired.
 */
export const DEFAULT_RUN_DIR = "cumulative";

/**
 * Resolve `?run_dir=` safely: confined to the runs root. Nested paths are
 * allowed (the tree layout); empty, `.` and `..` segments, backslashes, absolute
 * paths and NUL are refused, and the resolved path must sit under the root.
 */
export function resolveRunDir(runsRoot, raw) {
  const name = String(raw ?? "").trim() || DEFAULT_RUN_DIR;
  if (name.includes("\\") || name.includes("\0")) return null;
  if (name.startsWith("/")) return null;

  const segments = name.split("/");
  if (!segments.length) return null;
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") return null;
  }

  const full = resolve(join(runsRoot, name));
  const rootWithSep = resolve(runsRoot) + sep;
  if (!full.startsWith(rootWithSep)) return null;
  return { name, path: full };
}

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The suite, enumerated from the harness's own roster.mjs when no run has a
 * pinned roster yet (a wiped bench). Execution-free: it only lists tests.
 * Never written to disk (an unpinned copy could go stale), but memoized in
 * memory for 30s: at ~1.9s a call on every /api/wall it timed out the board's
 * control-plane read.
 */
const ROSTER_CACHE_TTL_MS = 30_000;
// Keyed by benchRoot: one root's suite must never answer for another.
const rosterCache = new Map(); // benchRoot -> { at, value }

async function enumerateSuite(benchRoot) {
  // Cached even when null, so a failing enumerator isn't retried every poll.
  const hit = rosterCache.get(benchRoot);
  if (hit && Date.now() - hit.at < ROSTER_CACHE_TTL_MS) return hit.value;
  const value = await enumerateSuiteUncached(benchRoot);
  rosterCache.set(benchRoot, { at: Date.now(), value });
  return value;
}

async function enumerateSuiteUncached(benchRoot) {
  const script = join(benchRoot, "grader", "roster.mjs");
  // Via a temp file, not stdout: roster.mjs exits right after writing, which
  // truncates an async stdout pipe.
  const out = join(
    tmpdir(),
    `okp-wall-roster-${process.pid}-${randomUUID()}.json`,
  );
  try {
    if (!(await fs.stat(script)).isFile()) return null;
    await execFileAsync("node", [script, "--out", out], {
      cwd: join(benchRoot, "grader"),
      timeout: ROSTER_ENUMERATE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = await readJsonOrNull(out);
    return Array.isArray(parsed?.gates) && parsed.gates.length > 0 ? parsed : null;
  } catch {
    // Never fabricate: an enumerator that cannot run leaves the suite unknown.
    return null;
  } finally {
    await fs.rm(out, { force: true }).catch(() => {});
  }
}

/**
 * Read the status stream, bounded. A truncated first line or an unparseable
 * line is skipped, never fatal.
 */
export async function readStatusRecords(path, { bytes = 4 * 1024 * 1024 } = {}) {
  let text;
  try {
    const st = await fs.stat(path);
    if (!st.isFile()) return null;
    const fh = await fs.open(path, "r");
    try {
      const start = Math.max(0, st.size - bytes);
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      text = buf.toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    } finally {
      await fh.close().catch(() => {});
    }
  } catch {
    return null;
  }

  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* fragment — skip, never abort */
    }
  }
  return out;
}

/** Attempt records, oldest first, with a usable attempt number. */
export function attemptRecords(records) {
  return (records ?? [])
    .filter((r) => r?.type === "attempt")
    .map((r) => ({ ...r, attempt: Number.isFinite(Number(r.attempt)) ? Number(r.attempt) : 1 }))
    .sort((a, b) => a.attempt - b.attempt);
}

/**
 * Fold the roster against the last completed test run: the latest result
 * wins, so a regression reads red. A gate with no result is untested, and the
 * totals sum to the suite size.
 */
export function foldGateStates({ roster, attempts }) {
  const gates = roster?.gates ?? [];

  // gate id → latest status (attempts scanned oldest → newest).
  const latest = new Map();
  // The trajectory: first_pass_attempt (earliest pass, or null) and ever_failed
  // (any outright failure; not_run excluded — unmeasured is not failed).
  const firstPass = new Map();
  const everFailed = new Map();
  // Why a gate went unmeasured, when the runner stated a cause.
  const unmeasuredCause = new Map();
  let anyOutcomesPublished = false;

  for (const record of attempts) {
    const results = Array.isArray(record.gate_results) ? record.gate_results : null;
    if (!results) continue;
    anyOutcomesPublished = true;
    for (const result of results) {
      if (!result?.id) continue;
      latest.set(result.id, result.status);

      // A later attempt that measured normally clears an earlier cause.
      if (typeof result.not_run_cause === "string" && result.status === "not_run") {
        unmeasuredCause.set(result.id, result.not_run_cause);
      } else {
        unmeasuredCause.delete(result.id);
      }

      if (result.status === "pass") {
        if (!firstPass.has(result.id)) firstPass.set(result.id, record.attempt);
      } else if (result.status !== "not_run" && result.status !== undefined && result.status !== null) {
        everFailed.set(result.id, true);
      }
    }
  }

  const out = gates.map((gate) => {
    const status = latest.get(gate.id) ?? null;

    // not_run (never reached) → untested; error (ran, couldn't complete) → failing;
    // absent → untested.
    let state;
    if (status === "pass") state = "passing";
    else if (status === null || status === undefined || status === "not_run") state = "untested";
    else state = "failing";

    return {
      id: gate.id,
      req: gate.req ?? null,
      title: gate.title ?? null,
      state,
      // Published for every gate, so the board never infers a missing field.
      first_pass_attempt: firstPass.get(gate.id) ?? null,
      ever_failed: everFailed.get(gate.id) === true,
      // Non-null only where the runner blamed the instrument.
      unmeasured_cause: unmeasuredCause.get(gate.id) ?? null,
    };
  });

  const tally = (state) => out.filter((g) => g.state === state).length;

  // Unmeasured: gates the runner explicitly published as not_run (a worker that
  // died mid-file leaves this fingerprint). Still `untested` for colour, and
  // counted outside `totals` so the totals still sum to the suite.
  const unmeasured = [...latest.values()].filter((status) => status === "not_run").length;

  return {
    gates: out,
    unmeasured,
    totals: {
      passing: tally("passing"),
      failing: tally("failing"),
      untested: tally("untested"),
    },
    outcomes_published: anyOutcomesPublished,
  };
}

/**
 * Assemble GET /api/wall. Never 500, never fabricate: a run with no roster
 * returns ok:true, suite.total:null and unwired:["gate-roster"] with a reason.
 */
export async function readWall({ runsRoot, runDir, benchRoot = null }) {
  const target = resolveRunDir(runsRoot, runDir);
  if (!target) {
    return {
      ok: false,
      code: "bad_run_dir",
      reason: `run_dir must be a single directory name under the runs root; got ${JSON.stringify(String(runDir ?? ""))}`,
    };
  }

  // The run's own pinned roster wins; the live enumeration is only for no run.
  let roster = await readJsonOrNull(join(target.path, "gate-roster.json"));
  let rosterSource = roster ? "run" : null;
  if (!roster && benchRoot) {
    roster = await enumerateSuite(benchRoot);
    if (roster) rosterSource = "enumerated";
  }
  const records = await readStatusRecords(join(target.path, "manifest.status.jsonl"));
  const attempts = attemptRecords(records);

  const unwired = [];
  const reasons = {};

  if (!roster || !Array.isArray(roster.gates) || roster.gates.length === 0) {
    unwired.push("gate-roster");
    reasons["gate-roster"] =
      `no readable gate-roster.json in runs/${target.name} and the suite could not be enumerated ` +
      "from the harness — the suite size is unknowable, not zero";
  }

  const folded = roster
    ? foldGateStates({ roster, attempts })
    // No roster, no denominator: every count unknown, never zero.
    : { gates: [], totals: null, unmeasured: null, outcomes_published: false };

  if (roster && !folded.outcomes_published) {
    unwired.push("gate-outcomes");
    reasons["gate-outcomes"] =
      "the suite is known but no attempt record carries gate_results yet — per-gate outcomes land " +
      "in manifest.status.jsonl when a test run completes, so this is the normal state early in a cell";
  }

  const currentAttempt = attempts.length > 0 ? attempts[attempts.length - 1].attempt : null;

  // Is the ratio a score or a lower bound? The harness states gradability per
  // attempt (report.mjs); passed through. null = recorded before the field existed.
  const last = attempts.length > 0 ? attempts[attempts.length - 1] : null;
  const gradable = last ? (last.gradable ?? null) : null;

  // Each square's hover-card detail (see gate-detail.mjs).
  const graderDir = benchRoot ? await graderDirFor(benchRoot, target.path) : null;
  const detailedGates = await attachGateDetail({
    gates: folded.gates,
    attempts,
    runPath: target.path,
    graderDir,
  });

  return {
    ok: true,
    contract_version: WALL_CONTRACT_VERSION,
    run_dir: target.name,
    // "run" (pinned to this run) or "enumerated" (live, no run yet).
    suite_source: rosterSource,
    suite: {
      // The true enumerated count, or null.
      total: roster ? Number(roster.total ?? roster.gates.length) : null,
      fingerprint: roster?.suite_fingerprint ?? null,
      complete: roster ? roster.enumeration?.complete !== false : false,
      incomplete_reason: roster?.enumeration?.incomplete_reason ?? null,
      captured_at: roster?.captured_at ?? null,
    },
    // Which test run these results came from.
    attempt: Number.isFinite(currentAttempt) ? currentAttempt : null,
    // true, false, or null (recorded before the field existed).
    gradable,
    ungradable_reason: last?.ungradable_reason ?? null,
    aborted_runners: Array.isArray(last?.aborted_runners) ? last.aborted_runners : [],
    gates: detailedGates,
    totals: folded.totals,
    // A subset of untested, outside totals.
    unmeasured: folded.unmeasured ?? null,
    unwired,
    unwired_reasons: reasons,
  };
}

/**
 * The grading suite a campaign was built against (its manifest's challenge,
 * or the only one installed); unknown otherwise.
 */
async function graderDirFor(benchRoot, runPath) {
  const recorded = String((await readJsonOrNull(join(runPath, "manifest.run-manifest.json")))?.challenge ?? "");
  const challenges = await listChallenges(benchRoot);
  const chosen = recorded
    ? challenges.find((c) => c.id === recorded)
    : challenges.length === 1 ? challenges[0] : null;
  return chosen?.grader_dir ?? null;
}
