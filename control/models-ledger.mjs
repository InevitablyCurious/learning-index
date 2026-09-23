// THE MODEL LEDGER — GET /api/models-ledger: one row per bench-eligible model,
// and one row per measured floor with its ON runs nested inside. Every gate is
// computed here, once, so a button and the server's rule cannot disagree.
//
//  1. An ON run needs its model's baseline complete and non-void.
//  2. An ON run is always the same model as its floor (self-paired).
//  3. Runs are serial PER MODEL: a cell in flight blocks its own model's
//     launches, never another model's (the N-slot ledger, run-ledger.mjs).
//
// One floor per model; a void baseline counts as no baseline, with the reason.

// The floor has one owner (baselines.mjs), shared with /api/baselines.
import { readBaselines, collectCells } from "./baselines.mjs";

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const int = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// The serial rule is per model, stated once for every surface: a cell in flight
// blocks its OWN model's launches, never another model's.
const serialReasonFor = (id) => `a cell for ${id} is already in flight — this model is serial`;

/**
 * Assemble GET /api/models-ledger. `inFlightModels` is the Set of model ids
 * with a live run, passed in from run-ledger.mjs (the one owner of run slots).
 */
export async function readModelsLedger({ runsRoot, benchModels, inFlightModels = new Set(), cloud = null }) {
  const eligible = (benchModels ?? []).filter((m) => m?.bench_eligible);

  // One derivation, attached to the payload too, so gates and quoted floors are
  // the same object.
  const baselines = await readBaselines({ runsRoot, models: eligible });

  // Every cell on disk, both arms, read once per poll.
  const allCells = await collectCells(runsRoot);

  const models = eligible.map((m) => {
    const id = str(m.id);
    const baseline = baselines.models[id] ?? {
      exists: false,
      scorable: false,
      candidates: 0,
      reason: `no floor was resolved for ${id}`,
    };
    // This model's own in-flight state; no other model's cell matters here.
    const inFlight = inFlightModels.has(id);

    // A baseline is gated by two things only: nothing in flight for THIS model,
    // and no valid floor already for it. No other model's state matters.
    const canBaseline = {
      allowed: !inFlight && !baseline.scorable,
      reason: inFlight
        ? serialReasonFor(id)
        : (baseline.scorable
          ? `${id} already has a valid baseline; re-baselining is a declared act, not a button`
          : null),
    };

    // An ON run needs a closed, valid floor of its own model — the same
    // baselineFor rule /api/run/start applies.
    const canRun = {
      allowed: !inFlight && baseline.scorable,
      reason: inFlight ? serialReasonFor(id) : (baseline.scorable ? null : runRefusal(baseline)),
    };

    return {
      id,
      upstream_model: str(m.upstream_model),
      resident: m.resident === true,
      declared_context: int(m.declared_context),
      max_context: int(m.max_context),
      baseline,
      // The ON cells measured against this floor (onRunsFor).
      runs: onRunsFor(baseline, allCells),
      // This model's own serial state; the top-level run_in_flight is the aggregate.
      in_flight: inFlight,
      can_baseline: canBaseline,
      can_run: canRun,
    };
  });

  return {
    ok: true,
    contract_version: MODELS_LEDGER_CONTRACT_VERSION,
    // The floor index, attached whole (also at /api/baselines and baselines.json).
    baselines,
    // The aggregate mirror of the per-model gates: is ANY model in flight.
    run_in_flight: inFlightModels.size > 0,
    serial_note:
      "one cell runs at a time per model: a model with a cell in flight is serial until that cell " +
      "closes. Different models may run concurrently — but the local model is a single resident " +
      "slot, so a second concurrent cell on the same model would contend for it and corrupt the " +
      "timing evidence of both.",
    models,
    // The card's own shape: measured floors at the root with their runs inside.
    // `models` answers the gates (including models that never ran); `baseline_rows`
    // lists only what was measured.
    baseline_rows: baselineRows({
      baselines,
      allCells,
      inFlightModels,
    }),
    counts: baselines.counts ?? { complete: 0, running: 0, void: 0, exhausted: 0 },
    // Every model a new baseline could start on, both substrates, each with its
    // resolved gate (what the [+ BASELINE] modal renders).
    startable: startableModels({ eligible, baselines, cloud, inFlightModels }),
    cloud: cloud
      ? {
          // The catalogue and a key report, never the key (cloud.mjs).
          router: cloud.router,
          providers: cloud.providers,
          models: cloud.models,
          key: cloud.key,
          spend_ceiling_usd: cloud.spend_ceiling_usd,
          spend_note: cloud.spend_note,
          can_start: cloud.can_start,
          can_start_reason: cloud.can_start_reason,
        }
      : null,
  };
}

/**
 * Why [+ run] is refused on a floor that is not scorable, in words. The batch
 * states are codes on the record (baselines.mjs); a refusal is read by a person.
 */
function runRefusal(b) {
  if (b.reason === "awaiting_selection") return "pick a floor from this batch first — an ON run is measured against one picked cell";
  if (b.reason === "batch_void") {
    return `this batch can never be a floor — ${b.void_reason ?? "it is void"}`;
  }
  return b.reason;
}

/** One row per measured floor, every gate resolved here. */
function baselineRows({ baselines, allCells, inFlightModels }) {
  const rows = Array.isArray(baselines?.list) ? baselines.list : [];

  return rows.map((b) => {
    // Runs against this row's own floor.
    const runs = onRunsFor(b, allCells);
    // This floor's own model in flight; another model's cell does not block it.
    const inFlight = inFlightModels.has(b.model);

    // Needs a closed, valid floor; running and void refuse with different
    // reasons (wait vs archive and re-run).
    const canRun = {
      allowed: !inFlight && b.scorable === true,
      reason: inFlight ? serialReasonFor(b.model) : (b.scorable ? null : runRefusal(b)),
    };

    return {
      ...b,
      // From the manifest, not the id's shape.
      kind_label: b.kind === "cloud" ? "CLOUD" : "LOCAL",
      // Newest first; `seq` keeps the schedule position.
      runs: [...runs].reverse(),
      run_count: runs.length,
      best: bestDelta(runs, b),
      can_run: canRun,
    };
  });
}

/**
 * Every model a baseline could start on, one list with a `kind` field.
 * Refusals, in order: serial (a cell in flight for THIS model), floor (already
 * has one), key (cloud without a key — refused here, before a campaign folder
 * is built).
 */
function startableModels({ eligible, baselines, cloud, inFlightModels }) {
  const out = [];

  for (const m of eligible) {
    const id = str(m.id);
    if (!id) continue;
    const b = baselines.models[id] ?? null;
    const inFlight = inFlightModels.has(id);
    out.push({
      id,
      kind: "local",
      provider: "local-llm-proxy",
      label: id,
      resident: m.resident === true,
      context: int(m.declared_context),
      has_baseline: b?.scorable === true,
      can_baseline: {
        allowed: !inFlight && b?.scorable !== true,
        reason: inFlight
          ? serialReasonFor(id)
          : (b?.scorable
            ? `${id} already has a valid baseline (${b.id ?? "floor"}); re-baselining is a declared act, not a button`
            : null),
      },
    });
  }

  for (const m of cloud?.models ?? []) {
    // Cloud floors are found in the cell-derived list (the local roster has never
    // heard of them).
    const row = (baselines.list ?? []).find((b) => b.model === m.key) ?? null;
    const keyed = cloud?.key?.present === true;
    const inFlight = inFlightModels.has(m.key);
    out.push({
      id: m.key,
      kind: "cloud",
      provider: m.provider,
      label: m.name,
      slug: m.slug,
      resident: null,
      context: m.context,
      // Carried so the picker can show the narrow-context caveat.
      below_advisory_floor: m.below_advisory_floor === true,
      context_note: m.context_note ?? null,
      has_baseline: row?.scorable === true,
      can_baseline: {
        allowed: !inFlight && row?.scorable !== true && keyed,
        reason: inFlight
          ? serialReasonFor(m.key)
          : (row?.scorable
            ? `${m.key} already has a valid baseline (${row.id}); re-baselining is a declared act, not a button`
            : keyed
              ? null
              : (cloud?.can_start_reason ?? "no cloud API key resolves, so a cloud cell cannot authenticate")),
      },
    });
  }

  return out;
}

// ── THE RUNS UNDER A BASELINE ── read off disk. A campaign schedules one
// model: slot 0 is the OFF floor, every later slot an ON repetition. So a floor's
// runs are the ON cells in its own campaign, in schedule order — CLI-launched
// cells included. The OFF cell is the floor itself and is not a run.

const PHASE_TOTAL = 3;
const ON_ARM = "on";

/** The ON cells against one baseline, oldest first; none without a run_dir. */
function onRunsFor(baseline, allCells) {
  const runDir = str(baseline?.run_dir);
  if (!runDir) return [];

  return (allCells ?? [])
    .filter((c) => c.run_dir === runDir && c.arm === ON_ARM)
    .sort((a, b) => (a.sequence_index ?? 0) - (b.sequence_index ?? 0))
    .map((cell, i) => ({
      // "run 06": position among this floor's ON cells, stable as runs are added.
      seq: i + 1,
      started_at: cell.created_at ?? null,
      model: cell.model,
      kind: cell.kind,
      run_dir: cell.run_dir,
      sequence_index: cell.sequence_index,
      cell: {
        run_dir: cell.run_dir,
        sequence_index: cell.sequence_index,
        state: cell.state,
        phases: cell.phases ?? { done: 0, total: PHASE_TOTAL },
        turns: cell.turns,
        tokens: cell.tokens,
        wall_seconds: cell.wall_seconds,
        gates: cell.gates,
        verdict: cell.verdict,
        void_instrument: cell.void_instrument === true,
        terminal_reason: cell.terminal_reason,
        context_exhausted: cell.context_exhausted === true,
        build_chunks: cell.build_chunks ?? null,
      },
      delta: deltaOf(cell, baseline),
    }));
}

/**
 * Δ against the floor this run is nested under (same model by construction).
 * No number while the cell runs, when either side is void or unscored, or when a
 * turn count is unobserved.
 */
function deltaOf(cell, baseline) {
  if (!cell) return null;
  if (cell.state !== "complete") {
    return { computable: false, reason: "withheld until the cell closes", turns: null, tokens: null };
  }
  if (cell.void_instrument) {
    return {
      computable: false,
      reason: "void instrument — these numbers measure the harness, not the model",
      turns: null,
      tokens: null,
    };
  }
  if (!baseline?.scorable) {
    return { computable: false, reason: "no valid floor to measure against", turns: null, tokens: null };
  }
  if (cell.turns === null || baseline.turns === null || baseline.turns === undefined) {
    return { computable: false, reason: "turns unobserved on one side", turns: null, tokens: null };
  }

  const turns = cell.turns - baseline.turns;
  const tokens =
    cell.tokens !== null && baseline.tokens !== null && baseline.tokens !== undefined
      ? cell.tokens - baseline.tokens
      : null;

  return {
    computable: true,
    reason: null,
    turns,
    tokens,
    // Named: fewer turns (a negative Δ) is better.
    better: turns < 0,
  };
}

/** The best run under a baseline by turns only — efficiency, labelled as such. */
function bestDelta(runs, baseline) {
  const scored = runs.filter((r) => r.delta?.computable === true);
  if (!scored.length) return null;
  const best = scored.reduce((a, b) => (b.delta.turns < a.delta.turns ? b : a));
  return {
    run_seq: best.seq,
    turns: best.delta.turns,
    tokens: best.delta.tokens,
    better: best.delta.better,
    axis: "efficiency",
    note: "fewest turns against this model's floor. Turns only — it says nothing about gates.",
  };
}

// 2: the profile level was removed (a breaking shape change).
const MODELS_LEDGER_CONTRACT_VERSION = 2;
