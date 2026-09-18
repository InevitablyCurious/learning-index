// BENCH CONTROL PLANE — the shapes it emits.
//
// Rules every field follows:
//  1. Every field is nullable; null means not observed and renders as such.
//  2. Every refusal carries a human-readable `reason`.
//  3. Nothing here computes a gate, delta or verdict.
//  4. Raw model output is proxied verbatim, escaped at render, and labelled.

export const CONTROL_CONTRACT_VERSION = "1.0";

// ── CAPABILITIES ── the board asks what this service can do before it draws a
// control, so no button exists for an absent capability.

/**
 * @typedef {Object} Capabilities
 * @property {boolean} start_run        — can launch a new cell
 * @property {boolean} resume_run       — ALWAYS FALSE. See RESUME_UNSUPPORTED.
 * @property {boolean} events           — can proxy the live event stream
 * @property {boolean} select_context   — can set context length per run
 */

/**
 * Why resume_run is always false: the harness has no mid-cell checkpoint, and
 * `run_cumulative.py resume` is a different operation (the coordinator review
 * flow). After a stall the only option is a fresh start, which a "resume" button
 * would misrepresent.
 */
export const RESUME_UNSUPPORTED = {
  supported: false,
  reason:
    "no mid-cell checkpoint exists in the harness — a stalled cell cannot be " +
    "resumed, only archived and restarted from zero (RUNBOOK §3a). " +
    "`run_cumulative.py resume` is the coordinator-review flow and requires a " +
    "DecisionManifest; it is not stall recovery.",
  alternative: "archive_and_restart",
};

// ── MODEL ROSTER ── two sources, kept apart: the proxy (:4545, which bench
// aliases exist) and the runtime (:1234, what is resident and at what context).
// A mismatch between declared and loaded context voids a campaign, so it must
// stay visible.

/**
 * @typedef {Object} ModelOption
 * @property {string}      id             — the alias to pass as --model
 * @property {string|null} upstream_model — the concrete model behind the alias
 * @property {string|null} purpose        — "okp-bench" | "interactive-*"
 * @property {boolean}     bench_eligible — purpose === "okp-bench"
 * @property {boolean}     resident       — currently loaded in the runtime
 * @property {number|null} declared_context — the proxy's context_length for the alias
 * @property {number|null} max_context    — runtime ceiling, null if unobserved
 * @property {number|null} loaded_context — actual loaded ctx, null if unloaded
 * @property {boolean}     context_match  — declared === loaded (null-safe)
 */

/**
 * Bench-eligible is computed here: the proxy serves interactive aliases on the
 * same endpoint, and benchmarking one would contend with live use.
 */
export const BENCH_PURPOSE = "okp-bench";

// ── RUN STATE ── exactly one run at a time (one resident model). A second
// start is refused with a reason, never queued.

/**
 * Stall is judged from filesystem times, never a parsed log timestamp: the
 * harness writes naive local times, which read wrong in a UTC container.
 */
export const STALL_THRESHOLD_S = 900;

/**
 * @typedef {Object} RunState
 * @property {string}      state          — "idle" | "starting" | "running" | "stalled" | "complete" | "failed"
 * @property {string|null} run_dir        — active run directory name
 * @property {string|null} log_path       — the launch log being written
 * @property {number|null} pid            — launcher pid, null if unobserved
 * @property {string|null} model          — the pinned --model alias
 * @property {string|null} arm            — "on" | "off"
 * @property {string|null} session_id     — live opencode session
 * @property {number|null} started_at     — epoch ms
 * @property {number|null} log_silent_s   — seconds since last log write
 * @property {boolean}     can_start      — false while anything is in flight
 * @property {string|null} blocked_reason — WHY start is unavailable, verbatim
 */

// ── START REQUEST ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} StartRequest
 * @property {string}      model      — alias from the roster (required)
 * @property {"on"|"off"}  arm        — memory mode (required)
 * @property {string|null} org        — required for ON cells, rejected for OFF
 * @property {number|null} context    — context length; null = registry default
 * @property {string}      confirm    — MUST equal the confirmation token
 */

/**
 * The confirmation token is a pure function of the submitted parameters, so a
 * preview for one configuration cannot confirm a different one.
 */
export function confirmationToken({ model, arm, org, context, kind, compact, snapshotId }) {
  const parts = [
    `model=${model ?? ""}`,
    `arm=${arm ?? ""}`,
    `org=${org ?? ""}`,
    `context=${context ?? "default"}`,
    // The substrate is in the token: a local confirmation must not start a billed
    // cloud cell.
    `kind=${kind ?? "local"}`,
    // Compaction is in the token: it changes what the cell does and its scale.
    `compact=${compact === true ? "on" : "off"}`,
    // The armed snapshot is in the token: re-arming disarms the confirmation.
    `snapshotId=${snapshotId ?? ""}`,
  ];
  return parts.join("|");
}

/**
 * The restatement shown before START, composed by the server so the words read
 * are the words acted on.
 */
export function restatement({ model, arm, org, context, kind, cloud = null, compact = false }) {
  const armWord = arm === "on" ? "MEMORY ON" : arm === "off" ? "CONTROL" : "UNKNOWN ARM";
  const isCloud = kind === "cloud";
  return [
    `Start a ${armWord} cell`,
    `subject model: ${model ?? "(none)"}`,
    // "This one is billed" is always stated.
    isCloud
      ? `substrate: CLOUD — routed to ${cloud?.provider ?? "a vendor"} via ${cloud?.slug ?? "the router"}, and BILLED`
      : "substrate: LOCAL — the resident model behind the relay proxy, unbilled",
    `context: ${context ? `${context} tokens` : "registry default (262144)"}`,
    // Stated either way, on or off.
    compact
      ? "compaction: ON — the session is compacted after each of the six build " +
        "chunks (never during repair), costing one model turn per chunk"
      : "compaction: OFF — the build runs uncompacted, and the repair phase " +
        "starts with whatever context the build left",
    org ? `org: ${org}` : "org: not applicable to a control cell",
  ].join("\n");
}

// ── EVENT STREAM ── proxied from the worker's `opencode serve` GET /event and
// mapped to a few kinds. Lossy on purpose; unmapped events are counted, not
// dropped silently. Re-verify the mapping on any opencode version bump.

/**
 * `user` rows are the harness's feedback messages, which reach the model as if
 * a person typed them. Shown verbatim from the user-events sidecar, and filed as
 * `user` because that is the fiction under test.
 */

/**
 * `harness` rows are the harness's grading steps (PROGRESS lines), so the feed
 * shows grading instead of going silent between attempts.
 */

/**
 * Grading stall alarm (seconds): a visual signal, far below the harness's
 * destructive gate timeout (3600s). Healthy grades run ~45–113s.
 */
export const GATE_STALL_THRESHOLD_S = 600;

/**
 * Upstream event type → board kind; anything absent is counted as unmapped.
 * `session.next.retried` is lifecycle, not error: a retry is the system working.
 */
/**
 * Mapped from what the worker actually emits (checked live), not the schema,
 * which advertises session.next.* events the pinned worker never sends. The Part's
 * own type (tool, reasoning, patch …) decides the kind; see kindOf().
 * message.part.delta (per-token) is ignored.
 */
// ── NOTICES ── a process reporting something it did or had done to it.
// `source` is who speaks, `event` what happened. Python owns the vocabulary
// (harness/live_stream.py); control.test.mjs pins both sides. Services outside
// this repo are reported by the control plane under `control`.
export const NOTICE_SOURCES = ["harness", "gates", "worker", "sequencer", "control"];

/** Three levels; debug is noise and critical has no clear edge against error. */
export const NOTICE_LEVELS = ["info", "warn", "error"];

export const EVENT_MAP = {
  // Substantive: kind is refined from the Part's own type by kindOf().
  "message.part.updated": "lifecycle",

  // File writes; `patch` parts are handled in kindOf().
  "file.edited": "file",

  // Terminal + error states.
  "session.error": "error",
  "session.idle": "lifecycle",

  // Session-level lifecycle.
  "session.compacted": "lifecycle",
  "session.status": "lifecycle",
};

/**
 * Part types that map to a kind on `message.part.updated`. `text` is left to
 * the transcript.
 */
export const PART_KIND = {
  tool: "tool",
  reasoning: "thinking",
  patch: "file",
  "step-start": "lifecycle",
  "step-finish": "lifecycle",
};

/** Envelope types that are real but deliberately never rendered as rows. */
export const EVENT_IGNORED = new Set([
  "message.part.delta",   // one row per token — the completed part is enough
  "server.heartbeat",
  "server.connected",
  "file.watcher.updated", // fires for every fs change, not agent activity
  "message.updated",
  "session.updated",
  "session.diff",
  "message.part.removed",
  "message.removed",
]);

/**
 * @typedef {Object} BoardEvent
 * @property {string}      id        — upstream evt_ id
 * @property {string}      kind      — "tool" | "file" | "thinking" | "error" | "lifecycle" | "harness" | "user"
 * @property {string}      type      — the raw upstream type, always preserved
 * @property {number|null} at        — epoch ms, null if upstream omitted it
 * @property {string|null} session_id
 * @property {string|null} tool      — tool name, `tool` kind only
 * @property {string|null} file      — path, `file` kind only
 * @property {string|null} text      — payload text, TRUNCATED (see below)
 * @property {boolean}     truncated — whether `text` was cut
 */

/**
 * Event text is truncated and the ring capped, so a long-open drawer cannot
 * exhaust browser memory. The ring keeps more than the render cap so filters
 * show the last N matching rows, not matches within the last N rows.
 */
export const EVENT_TEXT_MAX = 400;
export const EVENT_RING_MAX = 2000;

/** The design's render cap — how many rows the feed draws at once. */
export const EVENT_RENDER_CAP = 400;

// ── REFUSAL SHAPE ────────────────────────────────────────────────────────────

/** Every refusal. `reason` is for a person and is rendered verbatim. */
export function refuse(code, reason, extra = {}) {
  return { ok: false, code, reason, ...extra };
}
