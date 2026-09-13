// ─────────────────────────────────────────────────────────────────────────────
// THE MODEL LEDGER — one row per bench-eligible model, and one row per measured
// floor with the ON runs measured against it nested inside.
//
// Served whole by GET /api/models-ledger. The board renders it and decides
// nothing: every gate below is computed HERE, once, so the button an operator
// sees and the rule the server enforces cannot disagree. A disabled button that
// the server would have accepted is a lie; an enabled button the server refuses
// is worse.
//
// ── THE THREE RULES THIS SURFACE EXISTS TO EXPRESS ──────────────────────────
//
//  1. An ON run cannot start until the model's baseline is COMPLETE and NON-VOID.
//  2. An ON run is always the SAME MODEL as the floor it is measured against.
//  3. Runs are SERIAL, never parallel — one cell in flight across the whole
//     bench, not one per model.
//
// ── THE MEASUREMENT IS SELF-PAIRED, SO THE NESTING IS TWO LEVELS ────────────
//
// The benchmark measures the INFORMATION DELTA of one model against its own
// floor: the same model, the same task, OFF once and then ON repeatedly until
// the results stop improving. It does not rank models against each other, and
// "model A's memories consumed by model B" is not an experiment this instrument
// runs. So a run has exactly two coordinates — WHICH FLOOR and WHICH ATTEMPT —
// and the card is baseline → runs, with nothing in between.
//
// A third level used to sit here: the memory PROFILE, which froze a producer-
// model allowlist so a cross-model transfer could be declared. It was removed
// in full (2026-09-07). It never filtered anything — no recall path has ever
// carried a producer allowlist — and under the self-paired measurement its
// subject axis was degenerate, because a profile only ever appeared beneath its
// own subject's baseline. What it uniquely carried, the run→cell join, was
// never actually its to carry: see THE RUNS UNDER A BASELINE below.
//
// ── BASELINE OWNERSHIP: PER MODEL (operator ruling, 2026-08-13) ─────────────
//
// One OFF cell per model, shared by every ON run of that model. A model with
// three OFF cells has one baseline and two superseded attempts;
// `baseline.measured_before` carries its timestamp so an operator can see the
// floor predates the runs measured against it.
//
// ── VOID IS NOT COMPLETE ────────────────────────────────────────────────────
//
// A void-instrument baseline is treated as NO BASELINE: [+ baseline] re-enables
// and the reason is stated. A void cell ran to completion and produced numbers,
// which is exactly why this must be explicit — those numbers are an instrument
// artifact, and a Δ measured against them is invalid in a way nothing
// downstream can detect.
// ─────────────────────────────────────────────────────────────────────────────

// THE FLOOR HAS ONE OWNER. This file used to derive it inline; every gate below
// now reads the same index that /api/baselines serves and baselines.json
// records, so a button here and a floor quoted anywhere else cannot disagree.
import { readBaselines, collectCells } from "./baselines.mjs";

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const int = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Assemble GET /api/models-ledger.
 *
 * `run_in_flight` is passed in rather than re-derived: the run state has ONE
 * owner (runstate.mjs), and a second derivation here could disagree with the
 * refusal /api/run/start actually applies.
 */
export async function readModelsLedger({ runsRoot, benchModels, runInFlight, blockedReason, cloud = null }) {
  const eligible = (benchModels ?? []).filter((m) => m?.bench_eligible);

  // ONE DERIVATION, FOR EVERY ROW AND FOR THE WIRE. The same index is attached
  // to the payload below, so the gate a button carries and the floor a reader
  // quotes are literally the same object rather than two agreeing computations.
  const baselines = await readBaselines({ runsRoot, models: eligible });

  // EVERY CELL ON DISK, BOTH ARMS — the other half of the join below. Read once
  // here rather than per row: a bench with six floors would otherwise walk every
  // run directory six times per poll to answer the same question.
  const allCells = await collectCells(runsRoot);

  // ── ONE FACT ABOUT THE BENCH, NOT ABOUT ANY ROW ─────────────────────────
  //
  // It was computed inside the per-model loop, which was harmless while one
  // shape consumed it and became a trap the moment a second did: the baseline
  // rows and the startable list need the identical answer, and re-deriving the
  // serial rule beside a copy of it is exactly how one surface ends up offering
  // a launch the other has already refused. Hoisted, there is one of it.
  //
  // SERIAL FIRST, AND BENCH-WIDE. One cell in flight blocks every launch button
  // on every model — not just that model's. This is the rule most easily broken
  // by a per-row UI, because each row looks independent.
  const serialNote = runInFlight
    ? (blockedReason ?? "a cell is already in flight — bench runs are serial, never parallel")
    : null;

  const models = eligible.map((m) => {
    const id = str(m.id);
    const baseline = baselines.models[id] ?? {
      exists: false,
      scorable: false,
      candidates: 0,
      reason: `no floor was resolved for ${id}`,
    };
    // Hoisted above — see the block before this loop. Bound to a local name so
    // the gate expressions below read exactly as they did when each row
    // computed its own.
    const serialBlock = serialNote;

    // A BASELINE IS GATED BY TWO THINGS AND NOTHING ELSE: no cell may be in
    // flight (runs are serial), and this model must not already have a valid
    // floor (one per model, re-baselining is a declared act rather than a
    // button). No other model's floor has any bearing on it.
    //
    // IT ONCE ALSO CARRIED THE PROFILE SUBJECT RULE, AND THAT WAS WRONG. A
    // baseline is measured against nothing — it IS the floor. Enforced here,
    // the first frozen profile silently disabled [+ baseline] on every other
    // bench model permanently, so a four-model bench could never acquire its
    // second floor.
    const canBaseline = {
      allowed: !runInFlight && !baseline.scorable,
      reason: serialBlock
        ?? (baseline.scorable
          ? `${id} already has a valid baseline; re-baselining is a declared act, not a button`
          : null),
    };

    // AN ON RUN NEEDS A CLOSED, VALID FLOOR OF ITS OWN MODEL. That is the whole
    // gate, and it is the same one /api/run/start applies (`baseline_required`,
    // server.mjs) — the two read `baselineFor` so they cannot disagree.
    const canRun = {
      allowed: !runInFlight && baseline.scorable,
      reason: serialBlock ?? (baseline.scorable ? null : baseline.reason),
    };

    return {
      id,
      upstream_model: str(m.upstream_model),
      resident: m.resident === true,
      declared_context: int(m.declared_context),
      max_context: int(m.max_context),
      baseline,
      // The ON cells measured against this model's floor, read off disk. See
      // onRunsFor().
      runs: onRunsFor(baseline, allCells),
      can_baseline: canBaseline,
      can_run: canRun,
    };
  });

  return {
    ok: true,
    contract_version: MODELS_LEDGER_CONTRACT_VERSION,
    // THE FLOOR INDEX, ATTACHED WHOLE. Also served on its own at
    // /api/baselines and recorded to runs/baselines.json — this copy rides the
    // ledger so a board that already fetches the ledger needs no second call to
    // reference the floors, and cannot end up holding two different vintages of
    // the same answer.
    baselines,
    // Stated once at the top as well as per-model: the serial rule is a
    // property of the BENCH, and a reader scanning rows should not have to
    // infer it from every row carrying the same reason.
    run_in_flight: Boolean(runInFlight),
    run_blocked_reason: runInFlight ? (blockedReason ?? "a cell is already in flight") : null,
    serial_note:
      "one cell runs at a time across the whole bench. The local model is a single resident slot, " +
      "so a second concurrent cell would contend for it and corrupt the timing evidence of both.",
    models,
    // ── THE CARD'S OWN SHAPE: BASELINES AT THE ROOT ──────────────────────
    //
    // The same facts as `models` above, rooted the other way up, because the
    // two answer different questions and the surface asks the second one.
    //
    // `models` is the MODEL UNIVERSE with a floor hanging off each row, which
    // is what a gate needs: "may this model start a baseline" has to be
    // answerable for a model that has never run anything. Rendered directly, it
    // puts a row on screen for every model the bench could theoretically
    // measure, most of them empty, and buries the one real measurement among
    // five statements of intent.
    //
    // `baseline_rows` is the MEASUREMENTS, with the ON runs measured against
    // each one nested inside it. A run has no meaning apart from the floor it is
    // subtracted from — that is the argument the nesting makes — and a baseline
    // that does not exist yet has no row, because the card lists what was
    // measured rather than what could be.
    baseline_rows: baselineRows({
      baselines,
      allCells,
      serialBlock: serialNote,
    }),
    counts: baselines.counts ?? { complete: 0, running: 0, void: 0 },
    // ── WHAT A NEW BASELINE COULD BE STARTED ON ──────────────────────────
    //
    // Every model on both substrates, each carrying its own resolved gate. This
    // is what the [+ BASELINE] modal renders, and it is computed HERE for the
    // reason the header of this file gives: a picker that offers a model the
    // launch would refuse teaches the operator that the UI lies, and the lesson
    // generalises to every other control on the board.
    startable: startableModels({ eligible, baselines, cloud, serialBlock: serialNote }),
    cloud: cloud
      ? {
          // The catalogue and the key REPORT — never the key. See cloud.mjs.
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
 * ONE ROW PER MEASURED FLOOR, with the ON runs measured against it nested inside.
 *
 * EVERY GATE IS RESOLVED HERE AND THE CARD RENDERS THE VERDICT. That is the
 * whole thesis of this file: the card that re-derived even one gate would
 * eventually disagree with the server about a run that costs hours.
 */
function baselineRows({ baselines, allCells, serialBlock }) {
  const rows = Array.isArray(baselines?.list) ? baselines.list : [];

  return rows.map((b) => {
    // THE RUNS, AGAINST THIS ROW'S OWN FLOOR. `b` is the baseline they are
    // nested under, so a Δ computed here is a Δ against the cell the operator
    // can see one line above it — which is the entire reason the nesting is the
    // shape it is.
    const runs = onRunsFor(b, allCells);

    // AN ON RUN NEEDS A CLOSED, VALID FLOOR — the same rule the model rows
    // apply, re-stated against this row's own baseline. A running baseline has
    // no total to compare against, and a void one has numbers that measure the
    // harness; both refuse, and they refuse differently because the operator's
    // next move differs (wait, versus archive and re-run).
    const canRun = {
      allowed: !serialBlock && b.scorable === true,
      reason: serialBlock ?? (b.scorable ? null : b.reason),
    };

    return {
      ...b,
      // UPPERCASED FOR THE COLUMN, resolved from the manifest rather than from
      // the id's shape. The design's KIND column is two words and this is the
      // one place that decides which.
      kind_label: b.kind === "cloud" ? "CLOUD" : "LOCAL",
      // NEWEST FIRST. `onRunsFor` returns schedule order (oldest first, which is
      // the order the campaign ran them in); reversing here rather than in the
      // browser keeps the `seq` ordinals — positions in the schedule — correct.
      runs: [...runs].reverse(),
      run_count: runs.length,
      best: bestDelta(runs, b),
      can_run: canRun,
    };
  });
}

/**
 * EVERY MODEL A BASELINE COULD BE STARTED ON, both substrates, each gated.
 *
 * LOCAL AND CLOUD ARE ONE LIST WITH A `kind` FIELD, not two lists. The modal
 * asks "local or cloud?" and then filters — so a single list with the substrate
 * on each row is the shape the picker actually consumes, and it means the two
 * branches cannot drift into applying different rules to the same question.
 *
 * THE THREE REFUSALS, in the order they bind:
 *   serial      a cell is in flight; nothing may start anywhere on the bench
 *   floor       this model already has a valid one — re-baselining is a declared
 *               act (archive the run), not a button
 *   key         cloud only, and it is checked HERE rather than at the vendor so
 *               the picker refuses before a campaign directory is built
 */
function startableModels({ eligible, baselines, cloud, serialBlock }) {
  const out = [];

  for (const m of eligible) {
    const id = str(m.id);
    if (!id) continue;
    const b = baselines.models[id] ?? null;
    out.push({
      id,
      kind: "local",
      provider: "local-llm-proxy",
      label: id,
      resident: m.resident === true,
      context: int(m.declared_context),
      has_baseline: b?.scorable === true,
      can_baseline: {
        allowed: !serialBlock && b?.scorable !== true,
        reason: serialBlock
          ?? (b?.scorable
            ? `${id} already has a valid baseline (${b.id ?? "floor"}); re-baselining is a declared act, not a button`
            : null),
      },
    });
  }

  for (const m of cloud?.models ?? []) {
    // The floor for a cloud model is keyed by its `{provider}/{model}` key, and
    // the list export is derived from the CELLS rather than the roster, which is
    // the only reason a cloud floor is findable at all — the local proxy roster
    // has never heard of it.
    const row = (baselines.list ?? []).find((b) => b.model === m.key) ?? null;
    const keyed = cloud?.key?.present === true;
    out.push({
      id: m.key,
      kind: "cloud",
      provider: m.provider,
      label: m.name,
      slug: m.slug,
      resident: null,
      context: m.context,
      // Carried through so the model PICKER can state the caveat, not just the
      // confirmation card. A window narrower than the local aliases run at does
      // not bias a within-model delta, but it can end the cell early against the
      // provider's ceiling — which the operator should weigh while choosing.
      below_advisory_floor: m.below_advisory_floor === true,
      context_note: m.context_note ?? null,
      has_baseline: row?.scorable === true,
      can_baseline: {
        allowed: !serialBlock && row?.scorable !== true && keyed,
        reason: serialBlock
          ?? (row?.scorable
            ? `${m.key} already has a valid baseline (${row.id}); re-baselining is a declared act, not a button`
            : keyed
              ? null
              : (cloud?.can_start_reason ?? "no cloud API key resolves, so a cloud cell cannot authenticate")),
      },
    });
  }

  return out;
}

// ── THE RUNS UNDER A BASELINE ───────────────────────────────────────────────
//
// ── WHY THIS IS READ OFF DISK AND NOT OUT OF AN ATTRIBUTION FILE ────────────
//
// This used to be `joinRuns`: the ON runs of a baseline were whatever the
// profile store had RECORDED at launch, joined back to a cell by a `run_dir` +
// `sequence_index` pair the launcher wrote down. That machinery existed because
// a profile was a free-floating object that had to be told which cells belonged
// to it. It brought three distinct failure states with it — a run with no key
// (launched before the key shipped), a key pointing at a directory that is no
// longer on disk, and a key that resolved to the wrong arm — each of which the
// panel had to explain in a sentence.
//
// None of that is necessary, and none of it ever was. A campaign IS the
// experiment: `bench/cumulative/ordering.py` schedules ONE model per campaign,
// slot 0 as the OFF floor and every later slot an ON repetition of that same
// model. So the runs measured against a floor are simply the ON cells in the
// floor's OWN campaign directory, in schedule order, and `collectCells` already
// reads every one of them from the manifests that every other measurement on
// the board is read from.
//
// The consequence worth stating: a cell started at the CLI now appears here.
// Under the profile store it did not — it was "real but unattributed", because
// the control plane had not observed the launch. That distinction was never
// about the measurement; it was about which process pressed the button. The
// manifest records the cell either way.
//
// ── THE ARM IS THE FILTER, AND IT IS NOT A GUESS ────────────────────────────
//
// Only ON cells are runs. The OFF cell in the same campaign is the floor itself
// (it is the row these are nested under), and including it would draw a run
// whose Δ against itself is zero — a measurement of nothing, at the top of
// every list.

const PHASE_TOTAL = 3;
const ON_ARM = "on";

/**
 * The ON cells measured against one baseline, oldest first.
 *
 * A baseline with no `run_dir` (a floor that resolved to no cell at all) has no
 * campaign to read, so it has no runs — an empty list, never an error.
 */
function onRunsFor(baseline, allCells) {
  const runDir = str(baseline?.run_dir);
  if (!runDir) return [];

  return (allCells ?? [])
    .filter((c) => c.run_dir === runDir && c.arm === ON_ARM)
    .sort((a, b) => (a.sequence_index ?? 0) - (b.sequence_index ?? 0))
    .map((cell, i) => ({
      // The ordinal the run rows carry ("run 06"). It is the position among
      // this floor's ON cells, so it is stable: a run's number never changes
      // when a later one is added.
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
        build_chunks: cell.build_chunks ?? null,
      },
      delta: deltaOf(cell, baseline),
    }));
}

/**
 * Δ AGAINST THE FLOOR THIS RUN IS NESTED UNDER.
 *
 * `baseline` is passed in rather than looked up, because a Δ against another
 * model's floor is a capability comparison wearing a memory-lift label — the
 * single most expensive mistake this board can make look ordinary. The runs are
 * read out of the floor's own campaign, so the two are the same model by
 * construction rather than by a check.
 *
 * FOUR REFUSALS BEFORE A NUMBER, each stating which fact is missing:
 * a running cell has no total; a void cell measured the instrument; an unscored
 * floor cannot be subtracted from; and an unobserved turn count is not a zero.
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
    // NAMED, NOT INFERRED FROM THE SIGN. Fewer turns is better and a negative Δ
    // is therefore an improvement — which is the opposite of the convention a
    // reader brings to a number with a minus in front of it. The board renders
    // this word; it does not re-derive the polarity.
    better: turns < 0,
  };
}

/**
 * THE BEST RUN UNDER A BASELINE — fewest turns against the floor.
 *
 * EFFICIENCY ONLY, AND SAID SO. This is a turns comparison and nothing else: it
 * does not know whether the run that took fewest turns also passed fewer gates.
 * The board's hard rule is that the two axes are never combined into one number,
 * so this one is LABELLED with its axis wherever it is drawn rather than being
 * presented as "best" without qualification.
 */
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

// ── 2 (2026-09-07) ─────────────────────────────────────────────────────────
// The profile level was removed. `baseline_rows[]` lost `profiles`,
// `profile_count` and `can_profile`, and gained `runs`, `run_count`, `best` and
// `can_run`; `models[]` lost `profiles`, `baseline.shared_by` and `can_profile`,
// and gained `runs` and `can_run`; the payload lost `orphaned_profiles`. This is
// a breaking shape change, so the version says so rather than a reader
// discovering it by finding a field absent.
const MODELS_LEDGER_CONTRACT_VERSION = 2;
