// ─────────────────────────────────────────────────────────────────────────────
// OKP BENCH CONTROL PLANE — CONSUMABLE CONTRACT v1
//
// This module is the SINGLE definition of every shape the control plane emits.
// The dashboard consumes it; the designer designs against it. Diff this file
// against what `server.mjs` actually returns — nothing else is authoritative.
//
// ── WHY THIS IS A SEPARATE SERVICE FROM THE DASHBOARD ────────────────────────
//
// The dashboard (`../dashboard`) is READ-ONLY by construction: it serves GET
// only, mounts the bench repo `:ro`, runs as uid 1000, and never mounts the
// docker socket. Those are kernel-enforced facts, not policy, and they are what
// make "the dashboard corrupted a run" impossible rather than merely unlikely.
//
// Features that START runs cannot live there without destroying that property.
// So they live HERE, host-side, as a distinct process
// on a distinct port with a distinct trust level. The dashboard consumes this
// service as one more source module — and if this service is down, the board
// reports `unwired` and loses control affordances while keeping every
// measurement panel intact.
//
// ── THE FOUR RULES THIS CONTRACT INHERITS ────────────────────────────────────
//
//  1. EVERY FIELD IS NULLABLE. `null` means NOT OBSERVED and must render as an
//     explicit state — never as 0, never as absence. Three null-ish states stay
//     distinguishable: unobserved / unwired / zero.
//
//  2. A REJECTION CARRIES ITS REASON, VERBATIM. Every refusal shape on this
//     surface has a `reason` string written for a human to read on a stream.
//     There is no generic error. A control that is disabled without saying why
//     is indistinguishable from a control that is broken.
//
//  3. NOTHING HERE INVENTS A MEASUREMENT. This service starts processes and
//     proxies streams. It never computes a gate, a delta, or a verdict — those
//     come from RC-5 artifacts through the dashboard's own sources. A control
//     plane that also scores is a control plane that can flatter itself.
//
//  4. RAW MODEL OUTPUT IS LABELLED AS SUCH. The event stream carries the
//     subject model's working output. It is proxied verbatim, escaped at the
//     render layer, and never merged into a measured panel.
// ─────────────────────────────────────────────────────────────────────────────

export const CONTROL_CONTRACT_VERSION = "1.0";

// ── CAPABILITY DECLARATION ───────────────────────────────────────────────────
//
// The board asks what this service can actually DO before it renders a control.
// This exists because three of the four requested features are backed by real
// harness capabilities and one is NOT (see RESUME below). A UI that renders a
// button for an absent capability is the defect this declaration prevents.

/**
 * @typedef {Object} Capabilities
 * @property {boolean} start_run        — can launch a new cell
 * @property {boolean} resume_run       — ALWAYS FALSE. See RESUME_UNSUPPORTED.
 * @property {boolean} events           — can proxy the live event stream
 * @property {boolean} select_context   — can set context length per run
 */

/**
 * WHY `resume_run` IS PERMANENTLY FALSE, AND MUST STAY A DECLARED CAPABILITY
 * RATHER THAN A SILENTLY-ABSENT ROUTE:
 *
 * The harness has NO mid-cell checkpoint. WO-OBS-1 names this as open failure
 * mode #1 in its own report: "A cell that dies at minute 30 loses all 30
 * minutes; there is no checkpoint to resume from."
 *
 * `run_cumulative.py resume` exists but is a DIFFERENT operation — it requires
 * `--decision <DecisionManifest>` and drives the coordinator review flow, not
 * stall recovery.
 *
 * What IS available after a stalled cell is: archive the run directory and
 * start fresh (RUNBOOK §3a). That is a START, not a RESUME, and it discards
 * prior work. Shipping a "resume" button that silently means "restart from
 * zero" would be exactly the class of quiet lie the board's null-state rules
 * exist to prevent — so the capability reports false and carries the reason,
 * and the UI renders a disabled control that explains itself.
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

// ── MODEL ROSTER ─────────────────────────────────────────────────────────────
//
// Two independent sources, deliberately NOT merged into one number:
//
//   proxy   (:4545/v1/models)      — which bench aliases exist and are callable
//   runtime (:1234/api/v0/models)  — what is actually RESIDENT and at what
//                                     context length
//
// They are reported side by side because a mismatch between them is a known
// campaign-voiding defect: the RUNBOOK requires preflighting
// `loaded_context_length == 262144` after every model swap, because the proxy's
// own `/control/load` cannot set `parallel` and once shipped a 1h TTL that
// auto-unloaded a model mid-campaign (void cell). Collapsing "declared" and
// "resident" into a single field would hide precisely the discrepancy the
// operator must see BEFORE starting a run.

/**
 * @typedef {Object} ModelOption
 * @property {string}      id             — the alias to pass as --model
 * @property {string|null} upstream_model — the concrete model behind the alias
 * @property {string|null} purpose        — "okp-bench" | "interactive-*"
 * @property {boolean}     bench_eligible — purpose === "okp-bench"
 * @property {boolean}     resident       — currently loaded in the runtime
 * @property {number|null} declared_context — from WORKER_MODEL_REGISTRY
 * @property {number|null} max_context    — runtime ceiling, null if unobserved
 * @property {number|null} loaded_context — actual loaded ctx, null if unloaded
 * @property {boolean}     context_match  — declared === loaded (null-safe)
 */

/**
 * BENCH-ELIGIBLE IS NOT COSMETIC. The proxy serves interactive aliases
 * (Walter's daily driver slots) on the same endpoint as bench aliases. Starting
 * a benchmark against an interactive slot would contend with live use and
 * produce a measurement nobody can defend. The board must be able to separate
 * them, so the flag is computed here rather than left to a UI string match.
 */
export const BENCH_PURPOSE = "okp-bench";

// ── RUN STATE ────────────────────────────────────────────────────────────────
//
// EXACTLY ONE RUN AT A TIME. This is a hard property of the campaign, not a
// UI simplification: the RUNBOOK's binding local-model rules require serial
// execution ("One cell at a time; LM Studio is one instance, one loaded
// model. OFF-concurrency = 1"). The control plane enforces it server-side —
// a second start is REFUSED with a reason, never queued. A queue would let the
// UI imply a capability the instrument does not have.

/**
 * STALL IS DERIVED FROM THE LOG'S MTIME, NEVER FROM A PARSED TIMESTAMP.
 *
 * The harness writes NAIVE local timestamps ("2026-08-11 15:26:00", no offset)
 * and `Date.parse` resolves those against the READER's timezone. The dashboard
 * container runs UTC while the harness writes host local time, which produced a
 * CONSTANT phantom silence equal to the UTC offset — measured at 25560s (7.1h)
 * on a log written seconds earlier. That pinned the stall alarm on for every
 * run and made a genuine stall indistinguishable from the bug.
 *
 * mtime is an absolute epoch from the filesystem: no timezone ambiguity, no
 * agreement needed between writer and reader. Same fix as `run-log.mjs`.
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
 * THE CONFIRMATION TOKEN IS A RESTATEMENT, NOT A CHECKBOX.
 *
 * A run costs hours of machine time and can invalidate an in-flight campaign.
 * The client must echo back a token the server itself computed from the exact
 * parameters being submitted. This makes a mis-click structurally impossible:
 * a stale token (parameters changed since the preview) does not validate, so
 * the operator cannot confirm one configuration and start another.
 *
 * Deliberately NOT a nonce with server state — the token is a pure function of
 * the parameters, so it is verifiable, reproducible, and testable without a
 * session store.
 */
export function confirmationToken({ model, arm, org, context, kind, compact, snapshotId }) {
  const parts = [
    `model=${model ?? ""}`,
    `arm=${arm ?? ""}`,
    `org=${org ?? ""}`,
    `context=${context ?? "default"}`,
    // ── THE SUBSTRATE IS PART OF THE FINGERPRINT ────────────────────────────
    //
    // `kind` decides whether this cell runs on the resident local model or is
    // routed to a vendor API that bills for it. That is the largest difference
    // any single parameter here makes, and the token exists precisely so that a
    // parameter the operator did not confirm cannot be swapped in after the
    // preview. Omitted, a token minted for a local cell would be a valid
    // confirmation for a cloud one carrying the same model id — a run the
    // operator never saw a restatement for, and one that spends money.
    `kind=${kind ?? "local"}`,
    // ── COMPACTION IS PART OF THE FINGERPRINT ───────────────────────────────
    //
    // It changes what the cell DOES: six extra model turns, a session compacted
    // at every chunk boundary, and a turn/token scale that no uncompacted cell
    // shares. Left out, a token minted for a compacted run would be a valid
    // confirmation for an uncompacted one — the operator reads one restatement
    // and a different cell starts, which is the single failure this token
    // exists to make structurally impossible.
    `compact=${compact === true ? "on" : "off"}`,
    // ── THE ARMED SNAPSHOT IS PART OF THE FINGERPRINT ───────────────────────
    //
    // A confirmation binds to the snapshot that was armed when it was minted.
    // Left out, arming a different snapshot between preview and start would
    // still validate the old token — the operator would confirm one snapshot
    // and start another. Changing the armed snapshot disarms the confirmation.
    `snapshotId=${snapshotId ?? ""}`,
  ];
  return parts.join("|");
}

/**
 * The human-readable restatement the UI must display before START fires. The
 * SERVER composes this so the words the operator reads are the words the server
 * will act on — a client-composed summary can drift from the payload.
 */
export function restatement({ model, arm, org, context, kind, cloud = null, compact = false }) {
  const armWord = arm === "on" ? "MEMORY ON" : arm === "off" ? "CONTROL" : "UNKNOWN ARM";
  const isCloud = kind === "cloud";
  return [
    `Start a ${armWord} cell`,
    `subject model: ${model ?? "(none)"}`,
    // NAMED IN THE OPERATOR'S OWN RESTATEMENT, not left to be inferred from the
    // model id. The restatement is the last thing read before a run starts, and
    // "this one is billed" must not be the one fact it omits.
    isCloud
      ? `substrate: CLOUD — routed to ${cloud?.provider ?? "a vendor"} via ${cloud?.slug ?? "the router"}, and BILLED`
      : "substrate: LOCAL — the resident model behind the relay proxy, unbilled",
    `context: ${context ? `${context} tokens` : "registry default (262144)"}`,
    // STATED EITHER WAY, never only when it is on. "compaction: off" is a fact
    // about how this cell will run and about which other cells it can be read
    // beside; an operator who sees nothing cannot tell a cell that declined
    // compaction from one that was never offered it.
    compact
      ? "compaction: ON — the session is compacted after each of the six build " +
        "chunks (never during repair), costing one model turn per chunk"
      : "compaction: OFF — the build runs uncompacted, and the repair phase " +
        "starts with whatever context the build left",
    org ? `org: ${org}` : "org: not applicable to a control cell",
  ].join("\n");
}

// ── EVENT STREAM ─────────────────────────────────────────────────────────────
//
// Proxied from the worker's `opencode serve` at GET /event (text/event-stream).
//
// VERIFIED, NOT ASSUMED (2026-08-12): the worker image pins opencode 1.18.1
// (docker/worker/Dockerfile:4) while the host CLI is 1.18.15. Both were probed
// directly — `/event` exists on both and the Event union carries an IDENTICAL
// 89 variants on each (set difference empty in both directions). The
// `session.next.*` family this contract depends on is present on the pinned
// worker build. Re-verify on any OPENCODE_VERSION bump.
//
// FOUR KINDS, mapped from ~89 upstream variants. The mapping is deliberately
// LOSSY: the board shows what an operator can act on, and an unmapped event is
// reported in a counter rather than silently dropped, so "we are not showing
// you everything" stays visible.

/**
 * WHY `user` EXISTS AS A KIND (WO-FEEDBACK-1).
 *
 * The harness renders gate results into prose and delivers it to the model as
 * if a person had typed it. That message is the single most consequential input
 * the model receives, and it appeared NOWHERE on this board: the worker's SSE
 * stream shows what the model DID with the message, never what it was given,
 * and the PROGRESS log carries only a length and a fingerprint
 * (`step=user-event-sidecar chars=1287 text_fp=c02b9470`).
 *
 * The rows are sourced from the harness's append-only user-events sidecar and
 * carry the text VERBATIM — never summarised, re-wrapped or prettified, because
 * the whole reason to look at them is to judge whether they read like something
 * a person would actually send. A surface that cleaned them up would answer a
 * different question.
 *
 * They are `user` and not `harness` deliberately. On this board they ARE user
 * turns; that is precisely the fiction under test, and filing them under
 * `harness` would quietly answer the question the operator opened the feed to
 * judge.
 */

/**
 * WHY `harness` EXISTS AS A KIND (WO-GRADE-VIS-1).
 *
 * Every other kind describes what the AGENT did, sourced from the worker's
 * `opencode serve` event stream. But between attempts the agent is IDLE BY
 * DESIGN while the harness grades its work — so the agent feed correctly goes
 * silent, and nothing on the board distinguished "grading" from "wedged".
 * Measured 2026-08-12: a 32-minute grade during which the operator had no
 * signal at all and had to ask an agent to inspect process stacks.
 *
 * These rows come from the harness's own PROGRESS lines (`step=gate-phase-*`),
 * tailed from the run log rather than the serve stream. They share the feed
 * because grading and agent work are one chronological narrative — the whole
 * value is seeing the handoff — and carry their own kind so they can be
 * filtered out when only agent activity is wanted.
 */

/**
 * Grading stall ALARM threshold, in seconds.
 *
 * DELIBERATELY MUCH SMALLER than the harness's own gate timeout
 * (DEFAULT_GATE_TIMEOUT_S = 3600s, backgammon.py). Two different jobs:
 * this is a VISUAL signal that must fire early so a human can look, while the
 * timeout is a DESTRUCTIVE kill that must fire late so it never truncates a
 * slow-but-working grade. Alarm << timeout, by construction.
 *
 * Evidence for 600: healthy grades measured at 45s and 113s; the pathological
 * one ran 1918s. 600s is >5x the healthy wall (no false alarms) and would have
 * surfaced the 2026-08-12 stall ~22 minutes before it actually ended.
 */
export const GATE_STALL_THRESHOLD_S = 600;

/**
 * Upstream event type -> board kind. Anything absent from this map is counted
 * as `unmapped` and never rendered as one of the four kinds.
 *
 * NOTE ON `session.next.retried`: mapped to `lifecycle`, NOT `error`. Post
 * WO-NUDGE-INF-1 a retry is the system working as designed — nudges are
 * unbounded and recovered turns are excluded from scoring. Rendering a retry in
 * the fail colour would read as alarm at exactly the moment the instrument is
 * behaving correctly.
 */
/**
 * WHICH EVENTS THIS WORKER ACTUALLY EMITS — VERIFIED AT RUNTIME, NOT FROM THE
 * SCHEMA.
 *
 * The `/doc` OpenAPI Event union advertises 89 variants including a full
 * `session.next.*` family (tool.called, reasoning.started, step.ended …). That
 * family belongs to opencode's NEXT session engine. The pinned bench worker
 * does not run that engine, so those events are in the schema and NEVER on the
 * wire. An earlier version of this map was built from the schema and mapped
 * 5 of 1635 live events (99.7% unmapped) — schema presence is NOT runtime
 * emission, and only a live capture settles it.
 *
 * What the worker really emits, confirmed by a 45s capture against a running
 * cell (ses_00b54ddb…): `message.part.updated` carrying a full Part is the
 * substantive channel — the Part's OWN `type` (tool / reasoning / step-start /
 * step-finish / patch / text) is what distinguishes a tool call from a thought.
 * So the kind cannot be decided by the envelope type alone; see kindOf().
 *
 * `message.part.delta` is the token-by-token stream. It is the highest-volume
 * event by an order of magnitude (172 of 208 in that capture) and carries no
 * standalone meaning — the completed part arrives separately as
 * `message.part.updated`. Mapping it would flood the feed with one row per
 * token, so it is deliberately IGNORED rather than rendered.
 */
// ── THE NOTICE VOCABULARY — mirrored from Python, pinned by a drift test ─────
//
// `notice` is the live-stream kind on which a PROCESS reports something it did
// or something done to it. Every other core kind marks a step of the RUN; this
// is the one that carries what the machinery has to say about itself.
//
// TWO AXES. `source` is WHO is speaking, `event` is WHAT happened. That split is
// what makes one merged feed readable: with rows from the harness, the gate
// runner, the control plane and a contributor's own services in a single list,
// `source` is the only thing separating a benchmark fact from local
// surroundings, so it is the filter the chips are built on.
//
// NOT A NEW VOCABULARY. 46 of the harness's 63 log calls already read
// `component.event_name key=value`; the dotted prefix IS this axis. What was
// missing was anywhere for those lines to go but a log file.
//
// MIRRORED, NOT SHARED. Python owns the definition (`bench/live_stream.py`) and
// there is no import across the language boundary, so `control.test.mjs` pins
// the two sides in both directions — the same standing condition that makes the
// cloud catalogue and the terminal statuses mirrors.
//
// EXTERNAL SOURCES ARE ABSENT ON PURPOSE and never get an entry. A service
// outside this repo announces nothing; the control plane observes it and reports
// under `control`, naming what it watched in `detail`. See `LiveStream.notice`.
export const NOTICE_SOURCES = ["harness", "gates", "worker", "sequencer", "control"];

/**
 * Severity. Three, not five: `debug` is noise on a surface an operator watches
 * to judge a run's health, and `critical` has no statable boundary against
 * `error` — a level whose edge nobody can name gets applied inconsistently, and
 * the feed's severity filter is only ever as good as its boundary.
 */
export const NOTICE_LEVELS = ["info", "warn", "error"];

export const EVENT_MAP = {
  // Substantive: kind is refined from the Part's own type by kindOf().
  "message.part.updated": "lifecycle",

  // File writes. `file.edited` is the editor's own signal; `patch` parts carry
  // the batched file list and are handled in kindOf().
  "file.edited": "file",

  // Terminal + error states.
  "session.error": "error",
  "session.idle": "lifecycle",

  // Session-level lifecycle.
  "session.compacted": "lifecycle",
  "session.status": "lifecycle",
};

/**
 * Part types that map to a kind when they arrive on `message.part.updated`.
 * `text` is excluded on purpose: assistant prose belongs in the TRANSCRIPT tab,
 * not in an activity feed where it would drown the tool calls.
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
 * Reasoning deltas arrive token-by-token and are unbounded. The proxy truncates
 * each payload and caps the retained ring buffer, because an operator watching
 * a 12-hour run must not be able to exhaust the browser's memory by leaving a
 * drawer open. The cap is stated on the surface (`showing last N of M`) rather
 * than applied silently.
 *
 * RING_MAX (retained server-side) is deliberately LARGER than the design's
 * 400-row render cap. If they were equal, every filter would immediately hit
 * the buffer floor: filtering to ERROR would show only the errors inside the
 * last 400 events rather than the last 400 errors, and the operator would
 * conclude there were fewer errors than there were. Retaining more than is
 * rendered is what makes the filter chips honest.
 */
export const EVENT_TEXT_MAX = 400;
export const EVENT_RING_MAX = 2000;

/** The design's render cap — how many rows the feed draws at once. */
export const EVENT_RENDER_CAP = 400;

// ── REFUSAL SHAPE ────────────────────────────────────────────────────────────

/**
 * Every refusal on this surface. `reason` is written for a human reading a
 * stream, not for a log grep — it is rendered verbatim in the control region.
 */
export function refuse(code, reason, extra = {}) {
  return { ok: false, code, reason, ...extra };
}
