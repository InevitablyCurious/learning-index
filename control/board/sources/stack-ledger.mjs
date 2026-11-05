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
import { resolveArmed } from "../../snapshots.mjs";
import { readCellCost } from "../../baselines.mjs";
import { join } from "node:path";

export const id = "stack-ledger";
export const fields = ["stack"];
export function describe() {
  return "cross-run cumulative stack — the longitudinal series behind the transfer curve";
}

export async function read(ctx) {
  const runs = await collectRuns(ctx.runsRoot);
  if (!runs.length) {
    return { ok: false, reason: "no run directories with a manifest under runs root" };
  }

  const cells = [];
  for (const r of runs) cells.push(...(await cellsInRun(r)));
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

      phases: { done: c.phases_done, total: null },
      chunk: c.chunk,

      // Efficiency — never combined with correctness.
      turns: c.turns,
      tokens: c.tokens,
      // What the token total is made of; a kind the stamp omits stays null.
      tokens_breakdown: c.tokens_breakdown,
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

  // The floor's n is the armed snapshot's real depth: a seeded chain stacks
  // builds, so the baseline cell started n snapshots deep. Default 1 when
  // nothing is armed, the manifest is unreadable, or it predates depth capture
  // (same `or 1` default as load_snapshot / readSnapshot).
  const armed = await resolveArmed({ benchRoot: ctx.benchRoot });
  let depth = 1;
  if (armed?.snapshot_id) {
    const m = await readJson(
      join(ctx.runsRoot, "snapshots", String(armed.snapshot_id), "snapshot.json"),
    );
    if (Number.isInteger(m?.snapshot_depth)) depth = m.snapshot_depth;
  }

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
        // One OFF cell, labelled at the line; its n is the armed snapshot's depth.
        baseline,
        baseline_n: baseline ? depth : 0,
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
        phases_per_cell: null,
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
 * record still shows), measurement from the status stream by sequence_index,
 * and the void verdict from the cell's own cost stamp.
 */
async function cellsInRun(run) {
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
        turns: null,
        wall_seconds: null,
        terminal: false,
        terminal_reason: null,
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
    // No token counter is read here on purpose. A status row's `work_*` counters
    // are that ATTEMPT's, phase-scoped; folding them per cell by last-write-wins
    // would show the final attempt's spend as the whole cell's. The cell's tokens
    // come from its own `cost.json` `phases.total` below — one read per cell.
    const wall = num(p.wall_seconds);
    if (wall !== null) c.wall_seconds = Math.round(wall);
    if (r.terminal_outcome === true || str(r.terminal_reason)) c.terminal = true;
    c.terminal_reason = str(r.terminal_reason) ?? c.terminal_reason;
    // Sticky, and read from the record itself (not `progress`).
    c.seeded_from_snapshot = str(r.seeded_from_snapshot) ?? c.seeded_from_snapshot;
  }

  // Session records, keyed by the same index as the schedule.
  const sessions = new Map();
  for (const s of Array.isArray(m.session_records) ? m.session_records : []) {
    sessions.set(int(s.sequence_index) ?? 0, s);
  }

  const out = [];
  for (const s of schedule) {
    const seq = int(s.sequence_index) ?? 0;
    const meas = records.get(seq) ?? null;
    const sess = sessions.get(seq) ?? null;

    const attempts = meas ? [...meas.attempts.keys()].sort((a, b) => a - b) : [];
    const lastSet = attempts.length ? meas.attempts.get(attempts[attempts.length - 1]) : null;
    const firstSet = attempts.length ? meas.attempts.get(attempts[0]) : null;
    const arm = str(s.memory_mode) ?? str(sess?.memory_mode);

    // ONE read of this cell's cost stamp: it is the harness's authority on both
    // what the cell cost (`phases.total`) and whether it measured the model or
    // itself (`void.is_void`). Nothing here re-derives either.
    const cost = await readCellCost(cellDirFor(run.dir, arm, seq));
    const tokens = costTokens(cost);

    out.push({
      run_dir: run.name,
      sequence_index: seq,
      created_at: created,
      task,
      roster_hash: rosterHash,
      seed,
      org_id: str(s.org_id) ?? orgId,
      arm,
      model: str(s.provider_pin) ?? str(s.model) ?? str(sess?.model),

      // Phases from attempt records; no record = 0 phases, a real measurement.
      phases_done: meas ? attempts.length : 0,
      chunk: { current: null, total: 6 },

      turns: meas?.turns ?? null,
      tokens: tokens.total_tokens,
      // What the token total is made of; a kind the stamp omits stays null.
      tokens_breakdown: tokens.breakdown,
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

      // RUNBOOK 5.10, read off the harness's own stamp: cost.json's
      // `void.is_void` (harness/cumulative/run_artifacts.py cell_void, written by
      // scripts/run_cumulative/runner.py beside fingerprint.json) is the single
      // truth. Re-deriving it from the status stream here duplicated that rule and
      // had drifted from it. A cell with no stamp is pre-standard or still
      // running — not void.
      void_instrument: cost?.void?.is_void === true,

      // As stated by the harness that seeded it.
      seeded_from_snapshot: meas?.seeded_from_snapshot ?? null,
    });
  }
  return out;
}

/** A cell's directory: <campaign>/memory<ARM>/cell-NNNN (harness path layout). */
function cellDirFor(runDir, arm, seq) {
  return join(
    runDir,
    `memory${String(arm ?? "unknown").toUpperCase()}`,
    `cell-${String(seq).padStart(4, "0")}`,
  );
}

/**
 * A cell's token totals off its cost stamp's `phases.total` — the only place all
 * five kinds exist, with `output_tokens` generation-only and reasoning beside it.
 * An absent kind is null (unknown), never 0: a cell with no stamp, or a stamp
 * with no `phases.total`, shows null throughout rather than inheriting an
 * attempt's partial counters. The total is the sum of the kinds observed — never
 * a subset presented as a whole.
 */
function costTokens(cost) {
  const total = cost?.phases?.total ?? null;
  const breakdown = {
    input: int(total?.input_tokens),
    output: int(total?.output_tokens),
    reasoning: int(total?.reasoning_tokens),
    cache_read: int(total?.cache_read_tokens),
    cache_write: int(total?.cache_write_tokens),
  };
  const kinds = Object.values(breakdown).filter((v) => v !== null);
  return {
    breakdown,
    total_tokens: kinds.length ? kinds.reduce((a, b) => a + b, 0) : null,
  };
}
