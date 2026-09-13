// ─────────────────────────────────────────────────────────────────────────────
// BENCH DASHBOARD — JSON CONTRACT v2.0
//
// This module is the SINGLE definition of what the board consumes. Diff it
// against what the backend actually emits.
//
// THE QUESTION THE BOARD ANSWERS: does a growing memory corpus make the SAME
// local model finish the SAME build in fewer turns, fewer tokens and less time
// — and at which ON run does that stop being true? (It asked "at what corpus
// size" until the corpus dimension was stripped — see sources/stack-ledger.mjs.)
//
// FOUR RULES THAT ARE NOT STYLE CHOICES:
//
//   0. CORRECTNESS AND EFFICIENCY ARE TWO AXES, NEVER ONE NUMBER.
//        correctness  gates passed / total
//        efficiency   turns · tokens · wall time
//      They are reported adjacent, at equal weight, and are NEVER multiplied,
//      averaged, weighted or collapsed into a score. A run can be faster AND
//      worse — that is a real and important outcome, and any presentation that
//      lets faster-and-worse read as a win is a broken presentation.
//
//   1. Every field is nullable. `null` means NOT OBSERVED and must render as an
//      explicit state — never as 0, never as absence. Three distinct null-ish
//      states exist and must stay visually distinguishable:
//        unobserved  — the thing was not measured yet
//        unwired     — the data source that would carry it is not connected
//        zero        — it WAS measured and the value is 0 (a real result)
//
//   2. Serve ≠ outcome ≠ causation.
//        serve   claims a memory was injected into context. NOT that it helped.
//        outcome claims the episode resolved or didn't. NOT that memory caused it.
//        delta   is the ONLY causal surface on the board.
//      No panel may present a serve count as a success metric.
//
//   3. Outcome is TRI-STATE: worked | didnt_work | unobserved.
//      Silence is not a vote. `unobserved` is a third thing, not a failure.
//
// ABSENT BY RULING — do not add fields for these, they do not exist upstream:
//   - verification tiers T0–T4   (no such field in the system)
//   - ablation receipts          (not implemented)
//   - shadow recall              (would break arm comparability; killed)
// ─────────────────────────────────────────────────────────────────────────────

export const CONTRACT_VERSION = "2.0";

/** Gate-level counts cluster within cell. Below this, NO delta and NO CI. */
export const MIN_CELLS_PER_ARM = 3;

/**
 * Phases per cell. FIVE — one build and (max_attempts − 1) grades.
 * max_attempts = 5 (config.py), so a cell is 1 BUILD + 4 GRADEs.
 *
 *   1   BUILD   harness label `initial`
 *   2   GRADE   verdict-pass-1 / feedback-1
 *   …   GRADE   …
 *   5   GRADE   verdict-pass-4 / feedback-4
 *
 * The six work orders are CHUNKS INTERNAL TO PHASE 1. Rendering "6 phases"
 * (an earlier misreading) makes a cell in phase 2 look 1/6 done when it is
 * 2/5 done.
 */
export const PHASES_PER_CELL = 5;

/** Permanent provenance label. Never a badge. Never a tier. */
export const ATTESTATION = "bench-mock/self-declared";

/**
 * The empty board. Every source module merges INTO this shape, so a board with
 * zero wired sources still renders — as a deliberate all-null instrument, which
 * is exactly what the first hours of a run look like.
 */
export function emptyBoard() {
  return {
    contract_version: CONTRACT_VERSION,
    generated_at: Date.now(),

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
      // FIVE CATEGORIES + the injected-block estimate. `reasoning` and the
      // two cache figures were absent until WO-TOKENS-ALL: the board summed
      // input+output and presented it as the cell's token total, which on a
      // reasoning model omitted the largest category of the three. Sources
      // that cannot observe a category leave it null and the panel says
      // "unobserved" — it never silently totals a subset.
      tokens: {
        input: null,
        output: null,
        reasoning: null,
        cache_read: null,
        cache_write: null,
        injected_block: null,
      },
      // running | stalled | complete | failed | idle | null.
      // `stalled` and `failed` are PRODUCER-STATED: they land on the board only
      // from the control plane's GET /api/run verdict via reconcileRunLiveness
      // (run-liveness.mjs). No dashboard source derives them — the stall fact
      // is the harness's own 15s live.jsonl heartbeat, which only the control
      // plane reads (WO-HDR-FIX-01).
      state: null,
      session_id: null,
      // Launch-log mtime age. A DEBUG FACT, never a liveness gate: deriving
      // `stalled` from it printed CELL STALLED over a mid-turn cell, because
      // the harness writes PROGRESS at phase boundaries, not continuously.
      log_silent_s: null,
      // The producer's liveness measurement: seconds since the harness's own
      // heartbeat. Carried onto the board by reconcileRunLiveness with the
      // control plane's verdict; it is the duration the STALLED chip renders,
      // so the verdict and its evidence come from one source.
      heartbeat_age_s: null,
      terminal_status: null,
    },

    // ── THE DURING-THE-RUN STREAM ─────────────────────────────────────────
    // Owned solely by sources/live-stream.mjs. See LIVE-STREAM.md.
    //
    // The benchmark owns the core kinds; a memory BACKEND owns its namespace
    // and the opaque payload inside it. `ext` is reported for namespaces this
    // board has never heard of, because a board that silently drops an
    // unrecognised backend cannot claim any backend can plug in.
    live: {
      session_id: null,
      cell_seq: null,
      arm: null,
      attempt: null,
      // WHERE THE CELL IS, STATED BY THE HARNESS. `phase.start` is a core kind
      // and this contract did not carry it, so the phase spine read a phase
      // recovered by regex from the launch log instead — and lagged by the
      // whole of a grading pass. See sources/live-stream.mjs.
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

    // ── THE LONGITUDINAL SERIES ───────────────────────────────────────────
    // Owned solely by sources/stack-ledger.mjs — the ONE source that spans run
    // directories, because a cumulative campaign writes each cell to its own.
    //
    // TWO AXES, ADJACENT AND EQUAL, NEVER BLENDED:
    //   turns/tokens/wall_seconds  EFFICIENCY
    //   gates{failed,total}        CORRECTNESS
    // Nothing in this contract multiplies, averages or ranks them together. An
    // ON cell CAN be faster and worse; that must read as exactly that.
    stack: {
      id: null,
      state: null, // curve state, decided by stackState() in sources/stack-ledger.mjs
      baseline: null, // the ONE OFF cell. n=1 BY DESIGN, never a distribution
      baseline_n: 0,
      baseline_scorable: false,
      baseline_candidates: 0,
      runs: [], // ON cells, oldest first — the curve reads left to right
      all: [],
      excluded: { total: 0, different_experiment: 0 },
      // The denominator is the count of gates OBSERVED FAILING, not the suite
      // size. The harness publishes failed gates only (report.mjs writes no
      // total), so a suite size does not exist on disk and is never invented.
      gate_universe: null,
      gate_universe_note: null,
      phases_per_cell: PHASES_PER_CELL,
    },

    // ── HOLD FOR REVIEW ───────────────────────────────────────────────────
    // null = no hold file. The panel renders NOTHING — not an empty box, not a
    // spinner. Absence is a specified state, not an omission.
    // RELEASE IS NEVER BLOCKED BY A DEAD UI: when ui_healthy is false no link
    // is shown (handing over a dead URL wastes the operator's time twice) but
    // the release control is always present.
    hold: null,

    // ── THE LEARNING VIEW ────────────────────────────────────────────────────
    // The in-session extraction capture: the model's OWN account of what it
    // learned this cell, merged into a mark-keyed master, plus the gate×attempt
    // matrix and the harness-produced learning ledger. Owned by
    // sources/learning.mjs; rendered by panels/learning.js (MATRIX / CLAIMS /
    // LIVE). null = no active run yet (a designed state, never an error).
    //
    // HONESTY RULES THE PANEL CARRIES: window labels come from
    // learning-ledger.json (never computed client-side); polarity is
    // do-this/do-not-do (never pass/fail colours); session_goal.text in the
    // master is a MOCKED placeholder (the real goal reads from the manifest);
    // the OFF-cell capture is not persisted (unbound worktree → ephemeral
    // tmpfs) and reads `unwired`, never synthesised.
    learning: null,

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

    arm_delta: {
      sufficient: false,
      min_cells_per_arm: MIN_CELLS_PER_ARM,
      a: armSlot(),
      b: armSlot(),
      delta: null,
      ci: null, // stays null: gates cluster within cell (see note below)
      statement: null,
      note: "gate-level results are clustered within cell — 68 gates from one cell are not 68 independent samples. no CI over gate counts.",
    },

    // ── THE GATE SUITE — THE GATE WALL'S ONE AND ONLY SOURCE ─────────────────
    //
    // Served whole by the control plane's GET /api/wall (control/wall.mjs), which
    // folds the two artifacts the board must NOT stitch itself: the write-once
    // gate-roster.json and the per-attempt gate_results.
    //
    // THERE IS NO SECOND WALL. A local derivation from the status stream used to
    // sit beside this one; it could only describe gates OBSERVED FAILING, so a
    // gate that passed was never drawn at all, and it rendered nowhere. `suite`
    // is the true enumerated universe, which is what lets the wall answer "what
    // has NOT been tested" — a question no client-side fold over failure lists
    // can answer.
    //
    // EVERY GATE HAS EXACTLY ONE OF THREE STATES: passing, failing, untested.
    // No phase, no attempt axis, no live signal. The server assigns the state;
    // the panel picks the colour.
    //
    // NULL IS A DESIGNED STATE. `total: null` means the suite size is UNKNOWABLE
    // (a run predating the roster artifact) and must never render as 0. The
    // reason lives in `unwired_reasons` and is meant to be shown, not swallowed.
    suite: null,

    // ── THE LEDGER — the model universe AND the baselines, in one payload ─────
    //
    // Served whole by GET /api/models-ledger (control/models-ledger.mjs), which
    // resolves EVERY launch gate server-side: whether a baseline may be run,
    // and whether an ON cell may start against it.
    //
    // The board renders these verdicts and derives none of them. A button whose
    // enabled state disagreed with the refusal /api/run/start would actually
    // apply is worse than no button at all.
    //
    // TWO ROOTINGS OF THE SAME FACTS, because two surfaces ask two questions:
    //
    //   models        one row per bench-eligible model, floor hanging off each.
    //                 What a GATE needs — "may this model start a baseline" has
    //                 to be answerable for a model that has never run anything.
    //   baseline_rows one row per MEASURED floor, with the ON runs measured
    //                 against it nested inside. What the BASELINES card is
    //                 (dashboard/panels/ledger.js).
    //   startable     every model on BOTH substrates with its own gate — what
    //                 the [+ BASELINE] flow offers.
    //   cloud         the vendor catalogue, the spend ceiling, and whether an
    //                 API key RESOLVES. Never the key itself: what crosses the
    //                 wire is {present, source, fingerprint}. See control/cloud.mjs.
    //
    // NULL MEANS THE GATES COULD NOT BE EVALUATED, which is not the same as
    // "nothing is allowed" — the panel says so and draws no controls rather than
    // drawing ungated ones.
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

      // ── THE HONEST COST OF THE RUN, IN TWO PARTS ──────────────────────────
      // These are DIFFERENT costs and must not be summed into one number:
      //
      //   wasted_turns    turns burned BEFORE the gated trigger could fire
      //                   (an episode opened but never armed). The price of
      //                   requiring a second failure under the same key.
      //
      //   recovered_turns turns that really happened, burned real tokens, and
      //                   are deliberately EXCLUDED from scoring (guard-killed
      //                   + finalize-killed). Post WO-NUDGE-INF-1 the harness
      //                   nudges these indefinitely rather than dying.
      //
      // Showing only one understates what the run actually cost.
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
        // UNBOUNDED post WO-NUDGE-INF-1. A climbing count against a phase that
        // never advances is the wedged-relay signature — the accepted failure
        // mode that now relies on someone watching the stream.
        recovery_nudges: null,
        recoveries: null,
      },
    },

    history: [],

    sources: [],
  };
}

function armSlot() {
  return {
    cells: 0,
    gates_resolved: null,
    gates_total: null,
    resolution_rate: null,
    median_turns_to_green: null,
    // Cells observed for this arm but kept OUT of the numbers above, by reason.
    // An excluded cell must never read as a measured 0 — that is the whole
    // point of the three-kinds-of-nothing rule.
    excluded: excludedSlot(),
  };
}

function excludedSlot() {
  return { total: 0, void_instrument: 0, resolution_unmeasurable: 0 };
}

// ── helpers used by every source module ──────────────────────────────────────

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
 * Parse a raw gate string from the harness `failed_gates` list into a stable
 * identity. The harness emits two shapes, both real:
 *
 *   "[G04] REQ-MOVES — legal-move generation (blocked points + hits)"
 *   "conformance:REQ-STATE/state.points"
 *
 * `id` must be STABLE across attempts and across arms — it is the grid slot key
 * and the thing a skeptic diffs against the raw log.
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

  // "conformance:REQ-STATE/state.winner — /api/state response carries ..."
  // The locator is the stable identity; anything after an em/en dash is prose.
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
 * Decide whether a cell may enter the arm delta at all, and why not if not.
 *
 * This MIRRORS the scorecard's canonical rule — it does not invent a second
 * one. The authority is `harness/cumulative/run_artifacts.py` (the
 * VOID-INSTRUMENT gate, WO-NIGHT2-1b) implementing RUNBOOK rule 5.10. If that
 * rule changes, this changes with it; two divergent definitions of "does this
 * cell count" is precisely the class of drift the board exists to expose.
 *
 * Returns `{ scored: true }` or `{ scored: false, reason }`.
 *
 * VOID-INSTRUMENT (rule 5.10): a non-green terminal attempt carrying a
 * provider-side truncation signal is an instrument failure, NEVER a capability
 * FAIL. Scoring it as 0% resolution attributes the transport's failure to the
 * model — and on the control arm that manufactures apparent lift for the
 * memory arm, which is the single most damaging thing this board could do.
 * A green terminal attempt is scored regardless of earlier truncation.
 *
 * RESOLUTION_UNMEASURABLE: "resolved" is defined as red in an earlier attempt
 * and absent in the latest, so it is underivable from a single attempt. Such a
 * cell would otherwise contribute 0 to the numerator and its FULL gate count
 * to the denominator — a guaranteed 0% that is an artifact of when the cell
 * stopped, not a measurement of anything. Excluding it is the only coherent
 * choice: the same code that concedes it cannot measure resolution must not
 * then assert a rate.
 */
export function cellValidity(cell) {
  const c = cell ?? {};

  const terminalGreen = c.full_green === true;
  if (!terminalGreen) {
    const truncationSignal =
      str(c.terminal_reason) === "transport_incomplete" ||
      (int(c.length_truncations) ?? 0) > 0 ||
      (int(c.unrecovered_anomaly_turns) ?? 0) > 0;
    if (truncationSignal) return { scored: false, reason: "void_instrument" };
  }

  const attempts = c.attempts instanceof Map ? c.attempts.size : int(c.attempt_count) ?? 0;
  if (attempts < 2) return { scored: false, reason: "resolution_unmeasurable" };

  return { scored: true, reason: null };
}

/**
 * Decide whether a delta may be shown at all, and phrase it in words.
 *
 * HARD RULE: below MIN_CELLS_PER_ARM the delta stays null and the board renders
 * "COLLECTING". A number here with n=1 is the thing a skeptical engineer kills
 * you with. `ci` stays null permanently for gate rates — the samples are
 * clustered within cell and a binomial CI over them would be a lie.
 *
 * `cells` counts SCORED cells only. Excluded cells are reported separately on
 * each arm slot and never reach this threshold — otherwise three void cells
 * would unlock a delta computed from nothing.
 */
export function finalizeDelta(delta) {
  const a = delta.a;
  const b = delta.b;
  const sufficient = a.cells >= MIN_CELLS_PER_ARM && b.cells >= MIN_CELLS_PER_ARM;
  delta.sufficient = sufficient;

  if (!sufficient || a.resolution_rate === null || b.resolution_rate === null) {
    delta.delta = null;
    delta.statement = null;
    return delta;
  }

  delta.delta = a.resolution_rate - b.resolution_rate;
  const pct = (x) => `${Math.round(x * 100)}%`;
  delta.statement =
    `memory-on resolves ${pct(a.resolution_rate)} of gates vs ` +
    `${pct(b.resolution_rate)} control, across ${a.cells} and ${b.cells} cells.`;
  return delta;
}
