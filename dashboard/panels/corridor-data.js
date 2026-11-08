// CORRIDOR DATA — the one place the board's v2 cost object and the live board
// payload become the corridor run objects the renderer draws.
//
// Honest degradation is the whole contract: "not observed" is `null`, never 0
// and never "". A missing wall_seconds is not a fast run; a missing compaction
// count is not zero compactions. Nothing here interpolates, zero-fills or
// guesses: an unobserved total field is `null`, an absent by_phase is
// `phases: []`, and a compaction list nobody stated is `positions: null`.
//
// PRICE HAS THREE STATES, NOT TWO. A local model has no price BY CONSTRUCTION
// (`not_applicable`), a non-local model with no figure was not measured
// (`not_observed`), and a finite number is a value. Collapsing either absence
// into 0 would quote a free run — so `price` / `cost_usd` are `{state,value?}`,
// and a real 0 stays `{state:"value", value:0}`.
//
// COST SOURCE: `card.cost` first, then `by_cell["<run_dir>::<seq>"].cost`. Both
// carry the v2 nested shape (`phases.by_phase`, `phases.total`, `compactions`),
// normalized upstream by control/board/sources/cost.mjs. A v1 stamp is null
// there and stays null here — this adapter never projects the old flat shape.
//
// Pure and dependency-free on purpose: no board.js, no DOM. The renderer
// imports corridorRunsFromBoard / observed from here.

/** The epoch a v2 run states; anything else is a v1 (or unstated) run. */
const V2_SYSTEM_EPOCH = "2026-11-08";

/** Lanes the corridor keeps by default: the active run(s) + the newest rest. */
const DEFAULT_CAP = 12;

export function observed(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** An absent/garbage value is "not observed". A real 0 is a real observation. */
function num(v) {
  return observed(v) ? v : null;
}

function str(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** The first OBSERVED candidate, or null — never the first present one. */
function firstObserved(values) {
  for (const v of values) if (observed(v)) return v;
  return null;
}

// ── buckets ──────────────────────────────────────────────────────────────────

/**
 * One v2 bucket, null-safe and verbatim: the five token classes, turns, wall,
 * compactions, context peak and the grader roll-up. `grades` is passed through
 * whole (an object) or null; nothing is synthesized.
 */
function bucket(src) {
  const b = isObj(src) ? src : {};
  return {
    turns: num(b.turns),
    input_tokens: num(b.input_tokens),
    output_tokens: num(b.output_tokens),
    reasoning_tokens: num(b.reasoning_tokens),
    cache_read_tokens: num(b.cache_read_tokens),
    cache_write_tokens: num(b.cache_write_tokens),
    wall_seconds: num(b.wall_seconds),
    compactions: num(b.compactions),
    context_peak: num(b.context_peak),
    grades: isObj(b.grades) ? b.grades : null,
  };
}

/**
 * The run's whole-cell total. Seconds prefer the cell's own measured wall (the
 * harness measuring itself is not a measurement of the model), then the cell
 * wall, then the phase roll-up; tokens/compactions/peak/grades come from the
 * v2 `phases.total` bucket, with the compaction list's count as the fallback.
 */
function totalFrom(cost) {
  const phases = isObj(cost.phases) ? cost.phases : {};
  const t = isObj(phases.total) ? phases.total : {};
  return {
    measured_seconds: firstObserved([
      cost.measured_wall_seconds,
      cost.cell_wall_seconds,
      t.wall_seconds,
    ]),
    turns: num(t.turns),
    input_tokens: num(t.input_tokens),
    output_tokens: num(t.output_tokens),
    reasoning_tokens: num(t.reasoning_tokens),
    cache_read_tokens: num(t.cache_read_tokens),
    cache_write_tokens: num(t.cache_write_tokens),
    compactions: num(t.compactions) ?? num(cost.compactions?.count),
    context_peak: num(t.context_peak),
    grades: isObj(t.grades) ? t.grades : null,
  };
}

/**
 * One entry per `phases.by_phase` element, in the order the harness wrote them.
 * Both sub-buckets are always shaped (all-null when the phase had none) so the
 * renderer can draw a build band and a troubleshooting band without guessing
 * which one exists.
 */
function phasesFrom(cost) {
  const byPhase = cost?.phases?.by_phase;
  if (!Array.isArray(byPhase)) return [];
  return byPhase.map((entry) => {
    const e = isObj(entry) ? entry : {};
    return {
      name: str(e.name),
      layer: str(e.layer),
      build: bucket(e.build),
      troubleshooting: bucket(e.troubleshooting),
    };
  });
}

/**
 * The compaction reading for one run: count from the total (phases roll-up
 * first, list count second) and the positions exactly as stated — objects
 * `{ts, measured_offset_s, phase_index, phase_kind}` in v2, never synthesized.
 * Null when neither a count nor a list exists.
 */
function compactionFrom(cost, totalCompactions) {
  const c = isObj(cost.compactions) ? cost.compactions : null;
  const count = totalCompactions ?? num(c?.count);
  const positions = Array.isArray(c?.positions) ? c.positions : null;
  if (count === null && positions === null) return null;
  return { count, positions };
}

// ── price: three states ─────────────────────────────────────────────────────

/**
 * A local model has no price by construction, a non-local model with no figure
 * was not measured, a finite number is a value. Never a bare 0 for an absence.
 */
function triState(raw, local) {
  if (local) return { state: "not_applicable" };
  if (observed(raw)) return { state: "value", value: raw };
  return { state: "not_observed" };
}

/** The local proxy mounts under `local/local-llm-proxy/`, so its paths say so. */
function pathSaysLocal(card) {
  for (const p of [card?.run_dir, card?.cell]) {
    if (typeof p === "string" && p.toLowerCase().includes("local")) return true;
  }
  return false;
}

/**
 * The ledger's kind for one model, or null when it never names the model.
 * `models` is the local bench roster (array of {id,…}); `baseline_rows` /
 * `startable` name their substrate explicitly (`kind`), and a dict keyed by
 * model id is accepted too so either indexing works.
 */
function ledgerKind(board, model) {
  const ml = board?.models_ledger;
  if (!model || !isObj(ml)) return null;

  if (isObj(ml.models)) {
    const row = ml.models[model];
    if (isObj(row)) return str(row.kind) ?? "local";
  }
  if (Array.isArray(ml.models)) {
    const row = ml.models.find((r) => isObj(r) && r.id === model);
    if (row) return str(row.kind) ?? "local";
  }
  for (const list of [ml.baseline_rows, ml.list, ml.startable]) {
    if (!Array.isArray(list)) continue;
    const row = list.find((r) => isObj(r) && (r.model === model || r.id === model));
    if (row) return str(row.kind);
  }
  return null;
}

/** True when EITHER the card's path is local OR the ledger calls the model local. */
export function isLocalRun(card, board) {
  if (pathSaysLocal(card)) return true;
  return ledgerKind(board, card?.model ?? null) === "local";
}

// ── status ──────────────────────────────────────────────────────────────────

function statusOf(state, cardStatus) {
  if (state === "running") return "running";
  if (cardStatus === "scored") return "completed";
  if (cardStatus === "void" || cardStatus === "harness_error") return "failed";
  return "unobserved";
}

// ── one card → one corridor run ─────────────────────────────────────────────

/**
 * A run's recency key: epoch seconds. `benchmark_id` (the run id the harness
 * stamps) or the run_dir's leading segment; an unparseable card sorts oldest
 * (0), never newest.
 */
function recencyKey(card) {
  for (const raw of [card?.benchmark_id, String(card?.run_dir ?? "").split("/")[0]]) {
    const m = /^(\d+)/.exec(String(raw ?? ""));
    if (m) return Number(m[1]);
  }
  return 0;
}

function runFrom(card, board) {
  const key = `${card.run_dir}::${card.sequence_index}`;
  const view = isObj(board.by_cell?.[key]) ? board.by_cell[key] : {};
  const run = isObj(view.run) ? view.run : {};
  // The card is the wider read (it covers archived runs too); by_cell is the
  // current-tree cell view. Card first, per the board's source documentation.
  const cost = isObj(card.cost) ? card.cost : isObj(view.cost) ? view.cost : null;
  const c = cost ?? {};
  // Only the CELL view carries the during-the-run stream (`live`), never a card:
  // a living run's token progress lives at by_cell[key].live.progress.
  const progress = isObj(view.live?.progress) ? view.live.progress : null;

  const model = run.model ?? card.model ?? c.model ?? null;
  const total = totalFrom(c);
  const pausedSeconds = num(c.paused_seconds);
  const local = isLocalRun({ run_dir: card.run_dir, cell: card.cell, model }, board);

  return {
    key,
    model,
    status: statusOf(run.state, card.status),
    outcome: c.outcome ?? card.status ?? null,
    outcome_detail: str(c.terminal_reason),
    system_epoch: card.system_epoch ?? null,
    isV2: card.system_epoch === V2_SYSTEM_EPOCH,
    held: observed(pausedSeconds) && pausedSeconds > 0,
    paused_seconds: pausedSeconds,
    price: triState(c.price, local),
    cost_usd: triState(c.cost_usd, local),
    total,
    phases: phasesFrom(c),
    compaction: compactionFrom(c, total.compactions),
    progress,
  };
}

// ── live token progress → bar geometry ──────────────────────────────────────

/** One turn's share of the run's own running total, clamped to the bar. */
function sharePct(part, whole) {
  if (!observed(part) || !observed(whole) || whole <= 0) return 0;
  return Math.min(100, Math.max(0, (part / whole) * 100));
}

/**
 * The PROGRESS bar's geometry for a LIVE run, folded from the board's
 * `live.progress` payload (control/board/sources/live-stream.mjs). Three honest
 * states, never a zero-fill:
 *
 *   · `available:false` — the payload is absent, or the run predates
 *     `turn.tokens`. No totals, no segments: the renderer says "unavailable".
 *   · `empty:true` — progress exists but no token has been spent yet. The total
 *     is 0 by construction and the bar says "awaiting first token".
 *   · a bar — one segment per turn, its width the turn's share of THIS run's
 *     total; boundary lines and compaction notches are offsets on that same
 *     axis. Every render is a pure function of the latest payload: a later turn
 *     rescales earlier widths, it never adds a fabricated one.
 *
 * Per-lane normalization: `total` is the run's own, so each lane's bar is 100%
 * of itself.
 */
export function tokenBarFromProgress(progress) {
  if (!isObj(progress) || progress.available !== true) return { available: false };

  const paused = progress.paused === true;
  const total = isObj(progress.totals) ? num(progress.totals.total) : null;
  if (total === null || total <= 0) {
    return {
      available: true,
      empty: true,
      paused,
      total: 0,
      segments: [],
      boundaries: [],
      compactions: [],
    };
  }

  const segments = (Array.isArray(progress.segments) ? progress.segments : []).map((raw) => {
    const s = isObj(raw) ? raw : {};
    const delta = isObj(s.delta) ? s.delta : {};
    return {
      phase_index: num(s.phase_index),
      phase_kind: str(s.phase_kind),
      phase_name: str(s.phase_name),
      ts: num(s.ts),
      tokens: s.delta ?? null,
      widthPct: sharePct(delta.total, total),
    };
  });

  const boundaries = (Array.isArray(progress.boundaries) ? progress.boundaries : [])
    .filter((b) => isObj(b) && observed(b.offset))
    .map((b) => ({
      phase_index: num(b.phase_index),
      phase_kind: str(b.phase_kind),
      offsetPct: sharePct(b.offset, total),
    }));

  const compactions = (Array.isArray(progress.compactions) ? progress.compactions : [])
    .filter((x) => isObj(x) && observed(x.offset))
    .map((x) => ({
      ts: num(x.ts),
      tokens_before: num(x.tokens_before),
      offsetPct: sharePct(x.offset, total),
    }));

  return {
    available: true,
    empty: false,
    paused,
    total,
    totals: progress.totals,
    byKind: progress.byKind,
    segments,
    boundaries,
    compactions,
  };
}

// ── the run set ─────────────────────────────────────────────────────────────

/**
 * The corridor's run set, curated. Active (non-archived) runs always lead and
 * are never dropped; within each group the newest run leads. Beyond the active
 * runs the cap keeps the most recent (cap - activeCount) non-active runs.
 *
 * Returns `{ runs, truncated, total }` — `total` is every card seen, `truncated`
 * is how many the cap hid (0 with `showAll`), never a silent omission.
 */
export function corridorRunsFromBoard(board, opts = {}) {
  const list = isObj(board) ? board.runs?.list : null;
  if (!Array.isArray(list)) return { runs: [], truncated: 0, total: 0 };

  const cards = [];
  for (const card of list) {
    if (!isObj(card)) continue;
    cards.push({ card, recency: recencyKey(card) });
  }
  const total = cards.length;

  // Active first, then newest run first; within one run, batch order.
  cards.sort(
    (a, b) =>
      (a.card.archived === true ? 1 : 0) - (b.card.archived === true ? 1 : 0) ||
      b.recency - a.recency ||
      (a.card.sequence_index ?? 0) - (b.card.sequence_index ?? 0),
  );

  const showAll = opts.showAll === true;
  const cap = showAll ? Infinity : observed(opts.cap) ? opts.cap : DEFAULT_CAP;

  let kept = cards;
  if (Number.isFinite(cap)) {
    const active = cards.filter((x) => x.card.archived !== true);
    const room = Math.max(0, cap - active.length);
    kept = active.concat(cards.filter((x) => x.card.archived === true).slice(0, room));
  }

  return {
    runs: kept.map((x) => runFrom(x.card, board)),
    truncated: total - kept.length,
    total,
  };
}
