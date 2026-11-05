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

export const CONTRACT_VERSION = "2.0";

/** Permanent provenance label. Never a badge. Never a tier. */
export const ATTESTATION = "bench-mock/self-declared";

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

    // ── THE PER-RUN CARDS ── owned by sources/runs.mjs: one card per run,
    // current-tree cells plus archived backups, newest tree first, with the
    // status breakdown. Null until the source answers; never a partial object.
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
