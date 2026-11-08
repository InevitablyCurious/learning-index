// BENCH BOARD — JSON CONTRACT v2.0: the single definition of what the board
// consumes.
//
//  0. Correctness (gates passed / total) and efficiency (turns, tokens, wall
//     time) are two axes, shown side by side, never combined into a score.
//  1. Every field is nullable. unobserved (not measured yet), unwired (its
//     source isn't connected) and zero (measured, 0) stay visually distinct.
//  2. A serve (memory injected) is not an outcome, and an outcome is not
//     causation; the delta is the only causal surface.
//  3. Outcome is worked | didnt_work | unobserved; silence is not a vote.
//
// Deliberately absent (they don't exist upstream): verification tiers,
// ablation receipts, shadow recall.

import { SYSTEM_EPOCH, classifyRun } from "./lib/run-class.mjs";

export const CONTRACT_VERSION = "2.0";

/** Permanent provenance label. Never a badge. Never a tier. */
export const ATTESTATION = "bench-mock/self-declared";

// ── THE RUN LANES ───────────────────────────────────────────────────────────
// A run dir is classified ONCE, at the walk, by lib/run-class.mjs: "archived"
// (its path is under an archive root — pruned from the board entirely),
// "living" (it declares this epoch) or "legacy" (pre-v2, preserved on disk and
// reachable through `includeHistorical`). sources/runs.mjs stamps `class` on
// every card it emits; this module is the re-export home the rest of the board
// imports the epoch from, so there is exactly one wire literal.
//
// The board's DEFAULT VIEW is the living lane alone. The legacy runs stay
// reachable (`includeHistorical`), they are simply not what the current
// contract measures — so `GET /api/board` narrows runs.list, and
// `?include_historical=1` widens it back (a legacy card renders `—` downstream
// for each field it never stated). An archived card is never served in either
// mode.

export { SYSTEM_EPOCH };

/** Is this run card a v2-epoch run? Missing or null epoch is not. */
export function isV2Run(card) {
  return card?.system_epoch === SYSTEM_EPOCH;
}

/**
 * The card's lane. The card states it (`class`, stamped at the walk); a card
 * without one — a stale cache, an unwired source — is re-classified from the
 * path + epoch it does state, so the filter never invents a lane the classifier
 * would not have.
 */
function runClass(card) {
  if (card?.class === "archived" || card?.class === "living" || card?.class === "legacy") {
    return card.class;
  }
  return classifyRun({ relative: card?.run_dir, systemEpoch: card?.system_epoch });
}

/**
 * Filter a runs.list to the lanes the view shows. Pure: never mutates the input
 * (that array is part of getBoard's shared cache). Default = the living lane
 * only; `includeHistorical: true` = living + legacy. An archived card is never
 * served in either mode — the source prunes archive roots at the walk, so this
 * drop is defensive. A non-array list is returned unchanged — an unwired source
 * states its own absence, and a filter must not invent an empty list in its
 * place.
 */
export function filterBoardRuns(list, opts = {}) {
  const { includeHistorical = false } = opts;
  if (!Array.isArray(list)) return list;
  return list.filter((r) => {
    const cls = runClass(r);
    if (cls === "archived") return false;
    return includeHistorical ? true : cls === "living";
  });
}

/**
 * The board for ONE response: a SHALLOW COPY whose runs.list is the
 * lane-filtered cards and whose runs.counts is recomputed from those cards
 * (the exact shape sources/runs.mjs emits). archived_excluded is the ONE count
 * that is a source-level fact, not a property of the filtered list — it is
 * passed through, never recomputed, so filtering cannot make the archive look
 * as though it never existed. Every other section is the cached object itself,
 * untouched; the cache is never mutated.
 */
export function filterBoard(board, opts = {}) {
  const list = board?.runs?.list;
  if (!Array.isArray(list)) return board;
  const filtered = filterBoardRuns(list, opts);
  return {
    ...board,
    runs: {
      ...board.runs,
      list: filtered,
      counts: {
        total: filtered.length,
        live: filtered.filter((c) => c.status === "live").length,
        scored: filtered.filter((c) => c.status === "scored").length,
        void: filtered.filter((c) => c.status === "void").length,
        harness_error: filtered.filter((c) => c.status === "harness_error").length,
        living: filtered.filter((c) => runClass(c) === "living").length,
        legacy: filtered.filter((c) => runClass(c) === "legacy").length,
        archived_excluded: board.runs.counts?.archived_excluded ?? 0,
      },
    },
  };
}

/** The empty board every source merges into; zero wired sources still renders. */
export function emptyBoard() {
  return {
    contract_version: CONTRACT_VERSION,
    generated_at: Date.now(),
    // Top-level by design: the frontend reads board-root keys.
    // null = no round cap; consumers derive the observed count.
    max_attempts: null,

    run: {
      org_id: null,
      model: null,
      arm: null, // "on" | "off" | null
      cell_label: null,
      started_at: null,
      elapsed_s: null,
      phase: null,
      chunk: { current: null, total: null },
      attempt: { current: null, max: null },
      turns: null,
      // Five categories + the injected-block estimate. A category a source cannot
      // observe stays null; the panel never totals a subset.
      tokens: {
        input: null,
        output: null,
        reasoning: null,
        cache_read: null,
        cache_write: null,
        injected_block: null,
      },
      // stalled and failed come only from the control plane's /api/run verdict (via
      // reconcileRunLiveness); no source derives them.
      state: null,
      session_id: null,
      // Launch-log age: informational only, never liveness.
      log_silent_s: null,
      // Seconds since the harness's own heartbeat — the STALLED chip's duration.
      heartbeat_age_s: null,
      terminal_status: null,
    },

    // ── THE DURING-THE-RUN STREAM ── owned by sources/live-stream.mjs
    // (LIVE-STREAM.md). A backend owns its namespace; unknown namespaces are still
    // shown.
    live: {
      session_id: null,
      cell_seq: null,
      arm: null,
      attempt: null,
      // Where the cell is, as the harness stated it (phase.start).
      phase: null,
      phase_ts: null,
      phases: [],
      records: 0,
      gates: [],
      gate_counts: { pass: 0, fail: 0, other: 0 },
      attempts: [],
      backends: [],
      ext: [],
      // ── LIVE TOKEN PROGRESS ── folded from the WHOLE live.jsonl, in ts
      // order (a 512KB tail would silently undercount early turns). `totals`
      // is the sum of every turn.tokens DELTA's five fields, never the
      // session-scoped `cumulative` (a new session resets it). `segments` is
      // one per turn record: start_total is the running total before that
      // turn's delta, end_total after (delta.total may be 0 — kept). A
      // `boundaries` entry is emitted whenever consecutive segments change
      // (phase_index, phase_kind), offset = the new segment's start_total.
      // A compaction's `offset` is the end_total of the last segment at or
      // before its ts (0 when none); its `tokens_before` is the harness's
      // context peak, kept verbatim and NEVER used as the offset.
      //   available: false when no turn.tokens record exists (older runs) —
      //   no totals/byKind/segments keys are emitted, never zero-filled.
      progress: {
        available: false,
        paused: false, // pause.start -> true, pause.end -> false (ts order)
        totals: null, // {input, output, reasoning, cache_read, cache_write, total}
        byKind: null, // {build: {five+total}, troubleshooting: {…}, unknown: {…}}
        // [{ phase_index, phase_kind, tokens: {five+total} }] — one per
        // distinct (phase_index, phase_kind), chronological.
        byPhaseKind: [],
        // [{ phase_index, phase_kind, phase_name, ts, delta: {five+total},
        //    start_total, end_total }] — turn-ordered.
        segments: [],
        // [{ phase_index, phase_kind, offset }] — offset = start_total of the
        // segment that begins a new (phase_index, phase_kind).
        boundaries: [],
        // [{ ts, tokens_before, offset }] — offset = end_total of the last
        // segment with ts <= compaction.ts (0 if none).
        compactions: [],
      },
    },

    provenance: {
      attestation: ATTESTATION,
      gate_mode: null, // auto-approve | human | null
      gate_mode_source: null,
      policy_version: null,
      policy_anchor_status: null,
      worker_image_fp: null,
      leader_fp: null,
      corpus: "benchmark",
      seed: null,
    },

    // ── THE GATE SUITE ── the gate wall's only source, GET /api/wall
    // (control/wall.mjs): roster × gate_results. Every gate is passing, failing or
    // untested; total null means unknowable, with the reason in unwired_reasons.
    suite: null,

    // ── THE LEDGER ── GET /api/models-ledger, every launch gate resolved
    // server-side.
    //   models         one row per bench model (what a gate needs)
    //   baseline_rows  one row per measured floor, runs nested (the BASELINES card)
    //   startable      every model on both substrates with its gate
    //   cloud          catalogue, spend ceiling, key {present, source, fingerprint}
    // null = gates could not be evaluated: no controls drawn.
    models_ledger: null,

    episodes: [], // newest first

    recall_moment: null,

    honesty: {
      coverage: {
        concluded: null,
        total: null,
        note: "uncovered episodes count as neither positive nor negative",
      },
      unresolved: null,
      guard_detections: {},
      recall_latency_ms: { p50: null, p95: null, n: 0 },

      // ── THE COST OF THE RUN, IN TWO PARTS (never summed) ──
      //   wasted_turns    burned before the gated trigger could fire
      //   recovered_turns real turns excluded from scoring (guard/finalize-killed)
      wasted_turns: null,
      recovered_turns: null,

      serves: {
        sent: null,
        rejected: null,
        confirmed_on_chain: null,
        note: "delivery, not outcome",
      },
      transport: {
        truncations: null,
        finalize_timeouts: null,
        finalize_timeout_turns: null,
        guard_aborts: null,
        // Unbounded: a climbing count against a phase that never advances is a
        // wedged relay.
        recovery_nudges: null,
        recoveries: null,
      },
    },

    // ── TOOL JOBS ── owned by sources/tool-jobs.mjs (records in
    // control/tooljobs.mjs, persisted to data/tool-jobs.json). The refresh and
    // custom tools run as tracked jobs: the drawer renders their live output,
    // elapsed time and verdicts from here. null = source not wired.
    tool_jobs: null,
    // One record per cell of the current batch — what the cell strip selects
    // on. Null until a run exists; never a partial object.
    cells: null,

    // ── THE PER-RUN CARDS ── owned by sources/runs.mjs: one card per cell of the
    // LIVE tree (archive roots pruned at the walk), newest tree first, each
    // stamped `living` or `legacy`, with the status breakdown plus
    // counts.archived_excluded. Null until the source answers; never a partial
    // object.
    runs: null,

    sources: [],
  };
}

// ── helpers used by every source ──

/** Coerce to int, or null. Never NaN, never a silent 0. */
export function int(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Coerce to float, or null. */
export function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function str(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

/**
 * Parse a harness gate string into a stable id (the grid slot key). Two real
 * shapes: "[G04] REQ-MOVES — …" and "conformance:REQ-STATE/state.points".
 */
export function parseGate(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  const bracket = s.match(/^\[([A-Z]\d+)\]\s*([A-Z][A-Z0-9-]*)\s*[—–-]?\s*(.*)$/);
  if (bracket) {
    return {
      id: bracket[1],
      req: bracket[2] || null,
      title: bracket[3]?.trim() || null,
      raw: s,
    };
  }

  // The locator is the identity; anything after a dash is prose.
  const conf = s.match(/^conformance:([A-Z][A-Z0-9-]*)\/(.+)$/);
  if (conf) {
    const [locator, ...rest] = conf[2].split(/\s+[—–-]\s+/);
    return {
      id: `C:${locator.trim()}`,
      req: conf[1],
      title: rest.length ? rest.join(" - ").trim() : locator.trim(),
      raw: s,
    };
  }

  return { id: s.slice(0, 48), req: null, title: s, raw: s };
}

/** p50/p95 from a sample array. Returns nulls (not zeros) when empty. */
export function percentiles(samples) {
  const xs = (samples ?? []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!xs.length) return { p50: null, p95: null, n: 0 };
  const at = (q) => xs[Math.min(xs.length - 1, Math.floor(q * (xs.length - 1)))];
  return { p50: at(0.5), p95: at(0.95), n: xs.length };
}

export function median(xs) {
  const a = (xs ?? []).filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * Can this cell enter the arm delta? Returns { scored } or
 * { scored: false, reason }.
 *   void instrument: RUNBOOK 5.10 — the harness failed to measure, so the cell is
 *     never scored as a capability FAIL (that would fake lift for the memory
 *     arm). The verdict is the harness's OWN: cost.json's `void.is_void`
 *     (harness/cumulative/run_artifacts.py cell_void), attached to the cell as
 *     `void_instrument` by the source that read it. This function must never
 *     re-derive the rule from status-stream fields — that copy missed
 *     instrument_fault and observation_lost_turns and had drifted from the owner.
 *   resolution unmeasurable: a single attempt cannot show resolved gates, so it
 *     would score a guaranteed 0%.
 */
export function cellValidity(cell) {
  const c = cell ?? {};

  if (c.void_instrument === true) return { scored: false, reason: "void_instrument" };

  const attempts = c.attempts instanceof Map ? c.attempts.size : int(c.attempt_count) ?? 0;
  if (attempts < 2) return { scored: false, reason: "resolution_unmeasurable" };

  return { scored: true, reason: null };
}
