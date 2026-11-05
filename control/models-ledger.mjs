// THE MODEL LEDGER — GET /api/models-ledger: one row per bench-eligible model,
// and one row per measured baseline with its ON runs nested inside. Every gate
// is computed here, once, so a button and the server's rule cannot disagree.
//
//  1. A launch is gated by capacity alone: a cell in flight for that model. No
//     baseline is required to start — a baseline is a history an ON run is read
//     against later, never a key that unlocks it.
//  2. An ON run is always the same model as the baselines it is read against
//     (self-paired).
//  3. Runs are serial PER MODEL: a cell in flight blocks its own model's
//     launches, never another model's (the N-slot ledger, run-ledger.mjs).
//
// A baseline is not rationed: every Run in OFF mode measures one, and repeats on
// the same fingerprint are averaged (baselines.mjs `fingerprints`). A void
// baseline counts as no baseline, with the reason. An ON Δ is measured against
// that AVERAGE — adding a baseline is the only thing that moves it.

// The baseline has one owner (baselines.mjs), carried whole inside this payload.
import { readBaselines, collectCells } from "./baselines.mjs";
// The one canonicalizer: an ON cell's recorded fingerprint and an OFF cell's are
// hashed the same way, which is what lets a Δ find its family.
import { computeFingerprint } from "./batch.mjs";

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

    // A baseline is gated by ONE thing: nothing in flight for THIS model. A
    // floor already standing does not close the gate — a second measurement of
    // the same fingerprint is how an average is earned, so re-baselining is an
    // ordinary act, not a ceremony. No other model's state matters.
    const canBaseline = {
      allowed: !inFlight,
      reason: inFlight ? serialReasonFor(id) : null,
    };

    // A launch is gated by ONE thing in this model's own state: nothing in
    // flight. A baseline is not a precondition — the Δ is read against the
    // fingerprint's average after the fact, and says so when there is none.
    const canRun = {
      allowed: !inFlight,
      reason: inFlight ? serialReasonFor(id) : null,
    };

    return {
      id,
      upstream_model: str(m.upstream_model),
      resident: m.resident === true,
      declared_context: int(m.declared_context),
      max_context: int(m.max_context),
      baseline,
      // The ON cells measured against this model's baselines (onRunsFor).
      runs: onRunsFor(id, allCells, baselines.fingerprints),
      // This model's own serial state; the top-level run_in_flight is the aggregate.
      in_flight: inFlight,
      can_baseline: canBaseline,
      can_run: canRun,
    };
  });

  return {
    ok: true,
    contract_version: MODELS_LEDGER_CONTRACT_VERSION,
    // The baseline index, attached whole (and written to baselines.json).
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
    // How many baselines were gathered on each exact code state and what one
    // cost on average (baselines.mjs `fingerprints`). Surfaced at the root so the
    // card reads it without digging into the floor index.
    fingerprints: baselines.fingerprints ?? [],
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

/** One row per measured baseline, every gate resolved here. */
function baselineRows({ baselines, allCells, inFlightModels }) {
  const rows = Array.isArray(baselines?.list) ? baselines.list : [];

  return rows.map((b) => {
    // Runs read against this model's baselines.
    const runs = onRunsFor(b.model, allCells, baselines?.fingerprints);
    // This baseline's own model in flight; another model's cell does not block it.
    const inFlight = inFlightModels.has(b.model);

    // The same gate the model row carries: capacity alone. A void or exhausted
    // row is a row about the past, not a lock on the next launch — its own
    // `reason` still says why it is not a baseline.
    const canRun = {
      allowed: !inFlight,
      reason: inFlight ? serialReasonFor(b.model) : null,
    };

    return {
      ...b,
      // From the manifest, not the id's shape.
      kind_label: b.kind === "cloud" ? "CLOUD" : "LOCAL",
      // Newest first; `seq` keeps the schedule position.
      runs: [...runs].reverse(),
      run_count: runs.length,
      best: bestDelta(runs),
      can_run: canRun,
    };
  });
}

/**
 * Every model a baseline could start on, one list with a `kind` field.
 * Refusals, in order: serial (a cell in flight for THIS model), key (cloud
 * without a key — refused here, before a campaign folder is built). A floor
 * already standing is NOT a refusal: a repeat baseline on the same fingerprint
 * is what the average is made of.
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
        allowed: !inFlight,
        reason: inFlight ? serialReasonFor(id) : null,
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
        allowed: !inFlight && keyed,
        reason: inFlight
          ? serialReasonFor(m.key)
          : keyed
            ? null
            : (cloud?.can_start_reason ?? "no cloud API key resolves, so a cloud cell cannot authenticate"),
      },
    });
  }

  return out;
}

// ── THE RUNS OF A MODEL ── read off disk. A campaign is per MODEL, so its OFF
// slots (the baselines) and its ON slots share one run_dir; the ON cells are
// selected by MODEL rather than by that dir, so a memory-ON run started on a
// model with no baseline yet is still listed (it has a Δ to earn later). Runs
// come in schedule order — CLI-launched cells included. The OFF cells are the
// baselines and are not runs.

const ON_ARM = "on";

/** The ON cells of one model, oldest first. */
function onRunsFor(model, allCells, fingerprints) {
  if (!model) return [];

  return (allCells ?? [])
    .filter((c) => c.model === model && c.arm === ON_ARM)
    .sort((a, b) => (a.sequence_index ?? 0) - (b.sequence_index ?? 0))
    .map((cell, i) => ({
      // "run 06": position among this model's ON cells, stable as runs are added.
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
        phases: cell.phases ?? { done: 0, total: null },
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
      delta: deltaOf(cell, fingerprints),
    }));
}

/**
 * Δ against the AVERAGE of every baseline gathered on this run's fingerprint —
 * never a single picked cell, so adding a baseline is the only thing that moves
 * it and an earlier run's Δ is stable forever after.
 *
 * No number while the cell runs, when either side is void or unscored, when the
 * cell carries no fingerprint to place it by, or when no baseline has yet been
 * gathered on that fingerprint (a zero would claim a comparison nobody made).
 * Every branch carries `baseline_count` and `fingerprint`, so the reading is
 * always "measured against N baselines on this code".
 */
function deltaOf(cell, fingerprints) {
  if (!cell) return null;
  if (cell.state !== "complete") {
    return {
      computable: false,
      reason: "withheld until the cell closes",
      turns: null,
      tokens: null,
      baseline_count: 0,
      fingerprint: null,
    };
  }
  if (cell.void_instrument) {
    return {
      computable: false,
      reason: "void instrument — these numbers measure the harness, not the model",
      turns: null,
      tokens: null,
      baseline_count: 0,
      fingerprint: null,
    };
  }

  let hash = null;
  try {
    hash = computeFingerprint(cell.fingerprint).hash;
  } catch {
    // An incomplete or pre-standard record: it belongs to no fingerprint.
    hash = null;
  }
  if (!hash) {
    return {
      computable: false,
      reason: "this cell recorded no fingerprint, so it belongs to no baseline family",
      turns: null,
      tokens: null,
      baseline_count: 0,
      fingerprint: null,
    };
  }

  const group = (fingerprints ?? []).find((f) => f.fingerprint_hash === hash) ?? null;
  if (!group || !(group.baseline_count > 0)) {
    return {
      computable: false,
      reason: "no baselines on this fingerprint",
      turns: null,
      tokens: null,
      baseline_count: 0,
      fingerprint: hash,
    };
  }

  const avg = group.avg ?? {};
  const baseTurns = num(avg.turns);
  if (baseTurns === null || !Number.isFinite(cell.turns)) {
    return {
      computable: false,
      reason: "turns unobserved on one side",
      turns: null,
      tokens: null,
      baseline_count: group.baseline_count,
      fingerprint: hash,
    };
  }

  const turns = cell.turns - baseTurns;

  return {
    computable: true,
    reason: null,
    turns,
    // Tokens are averaged BY KIND in the forever baseline (input, output,
    // reasoning, cache read/write — AGGREGATE_COST_FIELDS) while a cell records
    // one `total_tokens`, so there is no averaged total to subtract and summing
    // the kinds would compare two different units. Reported as unobserved rather
    // than invented; the per-kind averages ride `fingerprints[].avg`.
    tokens: null,
    // Named: fewer turns (a negative Δ) is better.
    better: turns < 0,
    // The average it was measured against: how many baselines, on which code.
    baseline_count: group.baseline_count,
    fingerprint: hash,
  };
}

/** A finite number, or null — an unmeasured side is never a zero. */
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The best run of a baseline by turns only — efficiency, labelled as such. */
function bestDelta(runs) {
  const scored = runs.filter((r) => r.delta?.computable === true);
  if (!scored.length) return null;
  const best = scored.reduce((a, b) => (b.delta.turns < a.delta.turns ? b : a));
  return {
    run_seq: best.seq,
    turns: best.delta.turns,
    tokens: best.delta.tokens,
    better: best.delta.better,
    axis: "efficiency",
    note:
      `fewest turns against the average of ${best.delta.baseline_count} `
      + `${best.delta.baseline_count === 1 ? "baseline" : "baselines"} on this fingerprint. `
      + "Turns only — it says nothing about gates.",
  };
}

// 2: the profile level was removed (a breaking shape change).
// 3: a Δ is measured against the fingerprint's AVERAGE, not a picked cell — the
//    per-run delta carries `baseline_count` and `fingerprint`, and a batch record
//    no longer carries a `pick`.
const MODELS_LEDGER_CONTRACT_VERSION = 3;
