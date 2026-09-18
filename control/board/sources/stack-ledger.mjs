// SOURCE: stack-ledger — the one source that deliberately spans run folders.
//
// The board's question is longitudinal (does the same model finish the same
// build in fewer turns as ON runs accumulate, and when does that stop?), and
// each cell lands in its own folder. Every cell stays separate and attributed:
// one ledger row and one curve point each; nothing merges two cells' facts.
//
// A stack is org_id + task + roster_hash + seed: a model swap starts a new
// stack. Cells that don't match the newest cell's key are excluded and counted.
//
// Gates have no denominator on disk (report.mjs writes failures only), so the
// total is the distinct gates ever observed failing, labelled `observed`, or
// null. Corpus size is not measured, so it is not claimed.

import { int, num, str, parseGate } from "../contract.mjs";
import { readTail, parseJsonl, readJson, statOrNull, listCampaignDirs } from "./_runtime.mjs";
import { join } from "node:path";

export const id = "stack-ledger";
export const fields = ["stack"];
export function describe() {
  return "cross-run cumulative stack — the longitudinal series behind the transfer curve";
}

/** Phases per cell: 1 build + 4 grades (= max_attempts 5). Chunks are internal to phase 1. */
const PHASES_PER_CELL = 5;

export async function read(ctx) {
  const runs = await collectRuns(ctx.runsRoot);
  if (!runs.length) {
    return { ok: false, reason: "no run directories with a manifest under runs root" };
  }

  const cells = [];
  for (const r of runs) cells.push(...cellsInRun(r));
  if (!cells.length) {
    return { ok: false, reason: "run directories present but none carry a scheduled cell" };
  }

  // Newest first: the stack is anchored on the most recent run.
  cells.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));

  const anchor = cells[0];
  const key = stackKey(anchor);
  const mine = [];
  const excluded = { total: 0, different_experiment: 0 };
  for (const c of cells) {
    if (stackKey(c) === key) mine.push(c);
    else {
      excluded.total += 1;
      excluded.different_experiment += 1;
    }
  }

  // Oldest first: a sequence, read left to right.
  mine.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));

  const universe = gateUniverse(mine);

  const rows = mine.map((c, i) => {
    return {
      seq: i,
      sequence_index: c.sequence_index,
      run_dir: c.run_dir,
      arm: c.arm,
      model: c.model,
      org_id: c.org_id,
      created_at: c.created_at,

      phases: { done: c.phases_done, total: PHASES_PER_CELL },
      chunk: c.chunk,

      // Efficiency — never combined with correctness.
      turns: c.turns,
      tokens: c.total_tokens,
      // What the token total is made of; absent stays null.
      tokens_breakdown: c.tokens_breakdown ?? null,
      wall_seconds: c.wall_seconds,

      // Correctness — never combined with efficiency.
      gates: {
        failed: c.failed_now,
        // The observed universe, not the suite size.
        total: universe.size || null,
        basis: universe.size ? "observed_failures_in_stack" : null,
        resolved: c.resolved,
      },

      verdict: c.verdict,
      state: c.state,
      terminal_reason: c.terminal_reason,
      // An instrument failure is never plotted as a capability result.
      void_instrument: c.void_instrument,
      // Nor a seeded cell (see the floor).
      seeded_from_snapshot: c.seeded_from_snapshot,
    };
  });

  // THE FLOOR: the newest OFF cell that completed and is neither void nor seeded.
  // A void cell (a transport failure, often stopping early with fewer turns) would
  // fake a regression across the curve; a seeded one skipped the build and sits on
  // a different scale. With no valid floor the newest OFF cell is still shown with
  // its flags and baseline_scorable false. Same rule as control/baselines.mjs.
  const offs = rows.filter((r) => r.arm === "off");
  const scorable = offs.filter(
    (r) => !r.void_instrument && !r.seeded_from_snapshot && r.state === "complete",
  );
  const baseline = scorable.length
    ? scorable[scorable.length - 1]
    : (offs.length ? offs[offs.length - 1] : null);
  const on = rows.filter((r) => r.arm === "on");

  return {
    ok: true,
    provenance: {
      path: ctx.runsRoot,
      runs: mine.length,
      spans_runs: true,
      stack_key: key,
    },
    patch: {
      stack: {
        id: key,
        // n=1 by design, labelled at the line.
        baseline,
        baseline_n: baseline ? 1 : 0,
        // False = a baseline exists but is void: no delta is valid.
        baseline_scorable: Boolean(
          baseline
            && !baseline.void_instrument
            && !baseline.seeded_from_snapshot
            && baseline.state === "complete",
        ),
        // Every OFF cell in this stack; more than one is shown, not hidden.
        baseline_candidates: offs.length,
        runs: on,
        all: rows,
        excluded,
        gate_universe: universe.size || null,
        gate_universe_note:
          "denominator is the count of distinct gates ever observed failing in this stack. " +
          "the harness publishes failed gates only — no suite total exists on disk.",
        state: stackState(baseline, on),
        phases_per_cell: PHASES_PER_CELL,
      },
    },
  };
}

/** Which of the curve states the stack is in (one definition). */
export function stackState(baseline, on) {
  if (!baseline) return "no_baseline";

  // Void only for a cell that finished: a cell not started or still running also
  // has null turns, and must not be called an instrument failure.
  if (baseline.void_instrument) return "baseline_void";
  // Seeded is its own state (checked after void, as baselines.mjs does): the
  // cell ran fine but skipped the build, so it is not a floor. It is not a
  // "re-run it" case like void.
  if (baseline.seeded_from_snapshot) return "baseline_seeded";
  if (baseline.turns === null) return "baseline_pending";

  const plottable = on.filter((r) => !r.void_instrument && r.turns !== null);
  if (!plottable.length) return "baseline_only";
  if (plottable.length === 1) return "n1_on";
  // Regression: the newest plottable ON cell is at or above the floor (turns).
  const newest = plottable[plottable.length - 1];
  if (newest.turns >= baseline.turns) return "regression";
  return "curve";
}

function stackKey(c) {
  return [c.org_id ?? "-", c.task ?? "-", c.roster_hash ?? "-", c.seed ?? "-"].join("|");
}

/** Every distinct gate id ever seen failing across the stack's cells. */
function gateUniverse(cells) {
  const u = new Set();
  for (const c of cells) for (const g of c.gates_ever) u.add(g);
  return u;
}

async function collectRuns(runsRoot) {
  const out = [];
  // Live tree only: spanning runs must not mean spanning trees.
  for (const ent of await listCampaignDirs(runsRoot)) {
    const dir = ent.dir;
    const manifestPath = join(dir, "manifest.json");
    if (!(await statOrNull(manifestPath))?.isFile()) continue;
    const manifest = await readJson(manifestPath);
    if (!manifest) continue;
    const statusPath = join(dir, "manifest.status.jsonl");
    const statusStat = await statOrNull(statusPath);
    const status = statusStat?.isFile()
      ? parseJsonl(await readTail(statusPath))
      : [];
    out.push({ name: ent.name, dir, manifest, status });
  }
  return out;
}

/**
 * A run folder's cells: identity from the schedule (so a cell with no status
 * record still shows), measurement from the status stream by sequence_index.
 */
function cellsInRun(run) {
  const m = run.manifest;
  const schedule = Array.isArray(m.schedule) ? m.schedule : [];
  if (!schedule.length) return [];

  const created = Date.parse(str(m.created_at) ?? "") || null;
  const task = str(m.task);
  const rosterHash = str(m.roster_hash);
  const seed = int(m.seed);
  const orgId = str(m.org_id);

  const records = new Map(); // sequence_index -> folded measurement
  for (const r of run.status) {
    if (r.type !== undefined && r.type !== "attempt") continue;
    const seq = int(r.sequence_index) ?? 0;
    if (!records.has(seq)) {
      records.set(seq, {
        attempts: new Map(),
        gates_ever: new Set(),
        failed_now: null,
        verdict: null,
        seeded_from_snapshot: null,
        unrecovered_anomaly_turns: 0,
        turns: null,
        total_tokens: null,
        // Per-category breakdown: null (never 0) when the record predates capture.
        tk_input: null,
        tk_output_and_reasoning: null,
        tk_reasoning: null,
        tk_cache_read: null,
        tk_cache_write: null,
        wall_seconds: null,
        terminal: false,
        terminal_reason: null,
        full_green: false,
        length_truncations: 0,
        truncated_turns: 0,
      });
    }
    const c = records.get(seq);
    const p = r.progress ?? {};

    const raw = Array.isArray(r.failed_gates)
      ? r.failed_gates
      : Array.isArray(p.failed_gates)
        ? p.failed_gates
        : null;
    const attempt = int(r.attempt);
    if (attempt !== null && raw) {
      const set = new Set();
      for (const g of raw) {
        const parsed = parseGate(g);
        if (!parsed) continue;
        set.add(parsed.id);
        c.gates_ever.add(parsed.id);
      }
      c.attempts.set(attempt, set);
    }

    c.verdict = str(r.verdict) ?? c.verdict;
    c.turns = int(p.turns) ?? c.turns;
    // total_tokens is every token processed (input, output incl. reasoning, both
    // cache figures). Falls back to work_total_tokens only when it is absent.
    c.total_tokens =
      int(p.total_tokens) ??
      int(r.work_total_tokens) ??
      c.total_tokens;

    // The split the curve stacks. work_output_tokens includes reasoning; records
    // from before capture stay null (drawn as a legacy bar).
    c.tk_input = int(r.work_input_tokens) ?? int(p.input_tokens) ?? c.tk_input;
    c.tk_output_and_reasoning =
      int(r.work_output_tokens) ?? int(p.output_tokens) ?? c.tk_output_and_reasoning;
    c.tk_reasoning = int(r.work_reasoning_tokens) ?? c.tk_reasoning;
    c.tk_cache_read = int(r.work_cache_read_tokens) ?? c.tk_cache_read;
    c.tk_cache_write = int(r.work_cache_write_tokens) ?? c.tk_cache_write;
    const wall = num(p.wall_seconds);
    if (wall !== null) c.wall_seconds = Math.round(wall);
    if (r.terminal_outcome === true || str(r.terminal_reason)) c.terminal = true;
    c.terminal_reason = str(r.terminal_reason) ?? c.terminal_reason;
    c.full_green = p.full_green === true;
    c.length_truncations = Math.max(c.length_truncations, int(r.length_truncations) ?? 0);
    c.truncated_turns = Math.max(c.truncated_turns, int(r.truncated_turns) ?? 0);
    // The unrecovered-anomaly subset is what the void rule reads; truncated_turns
    // also counts recovered loops and never decides a measurement.
    c.unrecovered_anomaly_turns = Math.max(
      c.unrecovered_anomaly_turns,
      int(r.unrecovered_anomaly_turns) ?? 0,
    );
    // Sticky, and read from the record itself (not `progress`).
    c.seeded_from_snapshot = str(r.seeded_from_snapshot) ?? c.seeded_from_snapshot;
  }

  // Session records, keyed by the same index as the schedule.
  const sessions = new Map();
  for (const s of Array.isArray(m.session_records) ? m.session_records : []) {
    sessions.set(int(s.sequence_index) ?? 0, s);
  }

  return schedule.map((s) => {
    const seq = int(s.sequence_index) ?? 0;
    const meas = records.get(seq) ?? null;
    const sess = sessions.get(seq) ?? null;

    const attempts = meas ? [...meas.attempts.keys()].sort((a, b) => a - b) : [];
    const lastSet = attempts.length ? meas.attempts.get(attempts[attempts.length - 1]) : null;
    const firstSet = attempts.length ? meas.attempts.get(attempts[0]) : null;

    return {
      run_dir: run.name,
      sequence_index: seq,
      created_at: created,
      task,
      roster_hash: rosterHash,
      seed,
      org_id: str(s.org_id) ?? orgId,
      arm: str(s.memory_mode) ?? str(sess?.memory_mode),
      model: str(s.provider_pin) ?? str(s.model) ?? str(sess?.model),

      // Phases from attempt records; no record = 0 phases, a real measurement.
      phases_done: meas ? Math.min(attempts.length, PHASES_PER_CELL) : 0,
      chunk: { current: null, total: 6 },

      turns: meas?.turns ?? null,
      total_tokens: meas?.total_tokens ?? null,
      tokens_breakdown: {
        input: meas?.tk_input ?? null,
        output_and_reasoning: meas?.tk_output_and_reasoning ?? null,
        reasoning: meas?.tk_reasoning ?? null,
        cache_read: meas?.tk_cache_read ?? null,
        cache_write: meas?.tk_cache_write ?? null,
      },
      wall_seconds: meas?.wall_seconds ?? null,

      failed_now: lastSet ? lastSet.size : null,
      resolved:
        firstSet && lastSet && attempts.length >= 2
          ? [...firstSet].filter((g) => !lastSet.has(g)).length
          : null,
      gates_ever: meas ? meas.gates_ever : new Set(),

      verdict: meas?.verdict ?? null,
      state: !meas ? "not_started" : meas.terminal ? "complete" : "running",
      terminal_reason: meas?.terminal_reason ?? null,

      // RUNBOOK 5.10: an unrecovered provider-side anomaly on a non-green ending is
      // an instrument failure, never plotted. Reads unrecovered_anomaly_turns, like
      // run_artifacts.py and control/baselines.mjs.
      void_instrument: meas
        ? !meas.full_green &&
          (meas.terminal_reason === "transport_incomplete" ||
            meas.length_truncations > 0 ||
            meas.unrecovered_anomaly_turns > 0)
        : false,

      // As stated by the harness that seeded it.
      seeded_from_snapshot: meas?.seeded_from_snapshot ?? null,
    };
  });
}
