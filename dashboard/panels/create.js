// ─────────────────────────────────────────────────────────────────────────────
// PANEL: [+ BASELINE] — a three-step sequence, then the launch
//
// ── WHAT THIS REPLACED ──────────────────────────────────────────────────────
//
//   [+ baseline]  on a model row → straight to a launch checklist, with the
//                 model decided by whichever row was clicked
//   [+ profile]   on a model row → a single tall form asking both frozen facts
//                 at once (profile.js)
//
// The card carries a single [+ BASELINE]. It asks the substrate, then the
// model, then confirms — in the order the answers matter, and with the model
// stated on the confirmation rather than implied by a click target.
//
// Forward advances, back retreats, escape closes, and every frame before the
// last is free. Only the final frame commits, because that one spends hours of
// compute and, on cloud, real money.
//
// ── THE PROFILE BRANCH IS GONE (2026-09-07) ─────────────────────────────────
//
// This flow used to open on a CHOOSER — "start a baseline" or "create benchmark
// profile" — and the second branch ran three more frames (PROFILE·1–3) asking
// which floor the profile was measured against and whose memories it could
// read. That experiment is not the one this bench runs: the measurement is
// self-paired, one model against its own floor, so there is no producer roster
// to declare and no transfer edge to preview. The branch, its frames and the
// chooser that offered them were removed together — a chooser with one option
// is a click that asks nothing.
//
// STARTING AN ON RUN IS NOT HERE EITHER. It begins at [+ run] on the baseline
// row it will be measured against, and lands in this file's own confirmation
// frame (openCellConfirm) so both arms are configured through one surface.
// ─────────────────────────────────────────────────────────────────────────────

import { esc } from "../board.js";
import { graderWorkerTarget, recordAtChunkEndOn, requireTodosOn } from "./switches.js";
import { renderSeedFrame, refreshSnapshots, seedWarning, armedSnapshotId } from "./snapshot.js";
import { isDevModeOn } from "./devmode.js";

/**
 * THE WHOLE FLOW'S STATE, in one object.
 *
 * Module-local and never on the board payload: it describes what the OPERATOR is
 * part-way through choosing, which no poll can know and every poll would erase.
 */
const ui = {
  open: false,
  // b1 → b2 → b3 → b4   (with b2s spliced in under dev mode)
  step: "b1",

  // ── the cell being configured ──
  kind: null,        // "local" | "cloud"
  model: null,       // the id from `startable`
  query: "",
  provider: "all",
  // Which arm this cell runs. Set by this flow's own frames (always "off" — a
  // baseline IS the control) and by [+ run] on a baseline row ("on").
  arm: "off",
  org: null,
  // TRI-STATE, AND IT MATTERS. `null` means the operator has not touched the
  // toggle, so the SERVER's default stands (it knows the model's window).
  // `true`/`false` are a deliberate override. Seeding this with a boolean at
  // open time would make every run carry a client-side opinion of a rule the
  // server owns, and the two would drift the first time the ceiling moved.
  compact: null,

  // The launch POST's own state. `pending` and `refusal` are never conflated:
  // "working" and "refused" are different facts and a surface that shows one for
  // the other sends the operator to fix the wrong thing.
  pending: false,
  refusal: null,

  // ── launch (frame b4) ──
  //
  // Everything the LAUNCH ITSELF learned, which no board poll can reconstruct
  // afterwards: whether preflight passed, whether the server accepted the start,
  // and the pid it returned. The rows that follow are derived from the live
  // board instead — see launchRows.
  launch: null,
};

/** A checklist row's state. `unobserved` is NOT a pass and never renders as one. */
const ROW = {
  pending: "pending",
  running: "running",
  pass: "pass",
  fail: "fail",
  unobserved: "unobserved",
};

export function openCreate() {
  ui.open = true;
  ui.step = "b1";
  ui.kind = null;
  ui.model = null;
  ui.query = "";
  ui.provider = "all";
  ui.arm = "off";
  ui.org = null;
  ui.compact = null;
  ui.pending = false;
  ui.refusal = null;
  ui.launch = null;
}

/**
 * Close the dialog.
 *
 * CLOSING NEVER STOPS A RUN. By the time the checklist is on screen the cell is
 * already live on the host; this dialog is a view of it, not a handle on it.
 * `ui.launch` is cleared because it describes one launch attempt and a stale
 * copy would reappear over the next one — the run itself is unaffected, and the
 * board behind this dialog carries it from here.
 */
export function closeCreate() {
  ui.open = false;
  ui.pending = false;
  ui.refusal = null;
  ui.launch = null;
}

export function isCreateOpen() {
  return ui.open;
}

export function createStep() {
  return ui.step;
}

/** What the launch POST needs. Read by board.js, which owns every fetch. */
export function createSelection() {
  return {
    kind: ui.kind,
    model: ui.model,
    compact: ui.compact,
  };
}

export function setCreatePending(v) {
  ui.pending = Boolean(v);
  if (ui.pending) ui.refusal = null;
}

export function setCreateRefusal(code, reason) {
  ui.refusal = { code: code ?? null, reason: reason ?? null };
  ui.pending = false;
}

// ── NAVIGATION ──────────────────────────────────────────────────────────────
//
// THE ORDER IS FIXED AND SHORT. One sequence of three, and `back` on the first
// step has nowhere to go — the dialog opens there, so retreating from it would
// be closing it, which is what escape and cancel are for.

// ── THE SEED STEP IS CONDITIONAL, SO THE MAP IS A FUNCTION ────────────────
//
// `b2s` (seed from a build snapshot) sits between the model picker and the
// confirmation, and EXISTS ONLY IN DEV MODE. A static map would have to either
// carry a step that silently does nothing when the mode is off, or be mutated
// at runtime — and a step machine you cannot read as a machine is how a flow
// grows a state nobody can reach.
//
// Dev mode is read from the SERVER's answer on the board payload, never from a
// local flag: the control plane refuses to arm a snapshot when the mode is off,
// so a board that offered the step anyway would be offering a dead end.
const NEXT_BASE = { b1: "b2", b2: "b3", b3: null, b4: null };
const BACK_BASE = { b2: "b1", b3: "b2" };
const NEXT_DEV = { ...NEXT_BASE, b2: "b2s", b2s: "b3" };
const BACK_DEV = { ...BACK_BASE, b2s: "b2", b3: "b2s" };
function steps(devOn) {
  return devOn ? { next: NEXT_DEV, back: BACK_DEV } : { next: NEXT_BASE, back: BACK_BASE };
}

export function createForward(devOn = false) {
  const next = steps(devOn).next[ui.step];
  if (next) ui.step = next;
}

export function createBack(devOn = false) {
  const prev = steps(devOn).back[ui.step];
  if (!prev) return;
  ui.step = prev;
  ui.refusal = null;
}

/** The model this sequence is for. Read by the seed step's arming call, which
 *  must name the model so the server can apply the same-model rule. */
export function createModel() {
  return ui.model;
}

export function setCreateKind(kind) {
  ui.kind = kind;
  // The model list is filtered by substrate, so a model chosen on one substrate
  // is meaningless on the other and must not survive the change.
  ui.model = null;
  ui.provider = "all";
  ui.compact = null;
}

export function setCreateModel(id) {
  ui.model = ui.model === id ? null : id;
  // AN OVERRIDE BELONGS TO THE MODEL IT WAS MADE FOR. The default follows the
  // model's context window, so carrying a deliberate "off" from a 1M model onto
  // a freshly-picked 200k one would silently disable compaction on exactly the
  // model that needs it most.
  ui.compact = null;
}

/**
 * Flip the compaction toggle, resolving the tri-state against what is CURRENTLY
 * shown rather than against `null`.
 *
 * `null` means "the server's default stands", and the operator is looking at
 * that default rendered as on or off. A first click has to move away from what
 * they can see — not from an internal placeholder — or the toggle appears not
 * to respond on whichever half of the roster defaults the other way.
 */
export function toggleCreateCompact(shown) {
  ui.compact = !(ui.compact ?? shown);
}

export function setCreateQuery(q) {
  ui.query = String(q ?? "");
}

export function setCreateProvider(p) {
  ui.provider = String(p ?? "all");
}

// ── RENDER ──────────────────────────────────────────────────────────────────

export function renderCreate(board) {
  if (!ui.open) return "";
  const ledger = board.models_ledger ?? null;

  return `
    <div class="modal-scrim" data-create-scrim="1">
      <div class="modal cmodal" role="dialog" aria-modal="true" aria-label="Start a benchmark cell">
        ${frame(board, ledger)}
      </div>
    </div>`;
}

function frame(board, ledger) {
  switch (ui.step) {
    case "b1": return baselineKind(ledger);
    case "b2": return baselineModel(ledger);
    case "b2s": return baselineSeed(ledger, board);
    case "b3": return baselineConfirm(ledger);
    case "b4": return launchProgress(board);
    // The sequence opens on b1 and every transition is from the map above, so
    // an unknown step is a bug in the map rather than an operator's doing.
    // Falling back to the FIRST frame is the only recovery that cannot show a
    // control the flow has not established the inputs for.
    default: return baselineKind(ledger);
  }
}

/**
 * THE FRAME SHELL — step label, branch, title, body, note, and the two controls.
 *
 * Every frame is drawn through here so the sequence cannot develop a different
 * geometry, a different back-affordance or a different place for its CTA
 * depending on which branch an operator took.
 */
function shell({ step, branch, title, body, note, back = "‹ back", cta, ctaAttr, ctaOk = true, final = false, headRight = "" }) {
  return `
    <div class="cframe${final ? " final" : ""}">
      <div class="chead">
        <span class="cstep">${esc(step)}</span>
        <span class="cbranch">${esc(branch)}</span>
        <span class="spacer"></span>
        <div class="chead-right">
          <button class="cclose" data-create-cancel="1" aria-label="close">esc</button>
          ${headRight}
        </div>
      </div>
      <span class="ctitle">${esc(title)}</span>
      <div class="cbody">${body}</div>
      ${note ? `<span class="cnote">${esc(note)}</span>` : ""}
      ${refusalBlock()}
      <div class="cfoot">
        ${back ? `<button class="cback" data-create-back="1">${esc(back)}</button>` : `<span></span>`}
        <span class="spacer"></span>
        ${cta
          ? `<button class="cta${final ? " final" : ""}" ${ctaAttr} ${ctaOk && !ui.pending ? "" : "disabled"}>${esc(ui.pending ? "…" : cta)}</button>`
          : ""}
      </div>
    </div>`;
}

/**
 * THE REFUSAL, IN THE OPERATOR'S FACE, directly above the control that caused
 * it — the answer appears where the question was asked.
 *
 * Both halves are shown and they are different things: `code` is the machine
 * reason, greppable and the thing to quote in a report; `reason` is the server's
 * own prose, verbatim and never paraphrased here. A paraphrase would be a SECOND
 * definition of why the server refused, free to drift from the first.
 */
function refusalBlock() {
  if (!ui.refusal) return "";
  const transport = ui.refusal.code === "transport_failed";
  return `
    <div class="freeze-refusal" role="alert">
      <span class="fr-head">${esc(transport ? "COULD NOT REACH THE CONTROL PLANE" : "THE CONTROL PLANE REFUSED THIS")}</span>
      <span class="fr-code">${esc(ui.refusal.code ?? "no code given")}</span>
      <span class="fr-reason">${esc(ui.refusal.reason ?? "no reason given")}</span>
      <span class="fr-note">${esc(transport
        ? "Nothing was written. The request never arrived — check that the control plane is running, then try again."
        : "Nothing was written. Change a choice above and try again — the store is unchanged.")}</span>
    </div>`;
}

/**
 * One selectable line. `kind` drives the whole visual grammar:
 *   on    picked
 *   off   pickable, not picked
 *   dead  refused, and the refusal is ON the line as its meta text
 *   ghost a non-control (a search box, a statement of fact)
 */
function line({ glyph, text, meta, kind = "off", attr = "" }) {
  return `
    <div class="cline ${esc(kind)}" ${attr}>
      <span class="cglyph">${esc(glyph)}</span>
      <span class="ctext">
        <span class="ct">${esc(text)}</span>
        ${meta ? `<span class="cm">${esc(meta)}</span>` : ""}
      </span>
    </div>`;
}

// ── BASELINE · 1 — local or cloud ───────────────────────────────────────────

function baselineKind(ledger) {
  const cloud = ledger?.cloud ?? null;
  const local = (ledger?.startable ?? []).filter((m) => m.kind === "local");
  const cloudModels = (ledger?.startable ?? []).filter((m) => m.kind === "cloud");

  const body = `
    ${line({
      glyph: ui.kind === "local" ? "●" : "○",
      text: "Local baseline",
      meta: `${local.length} bench alias${local.length === 1 ? "" : "es"} behind the relay proxy · unbilled`,
      kind: ui.kind === "local" ? "on" : "off",
      attr: `data-create-kind="local"`,
    })}
    ${cloudReady(cloud)
      ? line({
          glyph: ui.kind === "cloud" ? "●" : "○",
          text: "Cloud API baseline",
          meta: `${(cloud?.providers ?? []).length} providers · ${cloudModels.length} models · BILLED, ceiling $${Number(cloud?.spend_ceiling_usd ?? 0).toFixed(2)} per cell`,
          kind: ui.kind === "cloud" ? "on" : "off",
          attr: `data-create-kind="cloud"`,
        })
      : line({
          glyph: "✕",
          text: "Cloud API baseline",
          meta: cloud?.can_start_reason ?? "the control plane reports no cloud capability",
          kind: "dead",
        })}`;

  return shell({
    step: "BASELINE · 1",
    branch: "start new baseline",
    title: "Local or cloud?",
    body,
    note: "Cloud routes the cell straight at the vendor and is billed against a per-cell ceiling; local runs on the resident model and is not. Nothing else about the measurement changes.",
    cta: "→",
    ctaAttr: `data-create-next="1"`,
    ctaOk: Boolean(ui.kind),
  });
}

function cloudReady(cloud) {
  return Boolean(cloud) && cloud.can_start === true;
}

// ── BASELINE · 2 — the model under test ─────────────────────────────────────

function baselineModel(ledger) {
  const all = (ledger?.startable ?? []).filter((m) => m.kind === ui.kind);
  const providers = [...new Set(all.map((m) => m.provider).filter(Boolean))];

  const q = ui.query.trim().toLowerCase();
  const shown = all.filter((m) => {
    if (ui.provider !== "all" && m.provider !== ui.provider) return false;
    if (!q) return true;
    return `${m.id} ${m.label ?? ""}`.toLowerCase().includes(q);
  });

  const body = `
    <div class="cfilters">
      <input class="csearch" data-create-query="1" value="${esc(ui.query)}" placeholder="search models…" aria-label="search models">
      ${providers.length > 1
        ? `<select class="cprov" data-create-provider="1" aria-label="filter by provider">
             <option value="all"${ui.provider === "all" ? " selected" : ""}>provider — all</option>
             ${providers.map((p) => `<option value="${esc(p)}"${ui.provider === p ? " selected" : ""}>${esc(p)}</option>`).join("")}
           </select>`
        : ""}
      <span class="cshown">${esc(`${shown.length} shown`)}</span>
    </div>
    <div class="clist">
      ${shown.length
        ? shown.map(modelLine).join("")
        : `<div class="null">${esc(all.length ? "no model matches this filter" : "no model is available on this substrate")}</div>`}
    </div>
    ${ui.kind === "cloud" ? keyLine(ledger?.cloud ?? null) : ""}`;

  return shell({
    step: "BASELINE · 2",
    branch: "start new baseline",
    title: "Pick the model under test",
    body,
    note: "One model per baseline. A model that already has a valid floor cannot start another — re-baselining is a declared act (archive the run), not a button.",
    cta: "→",
    ctaAttr: `data-create-next="1"`,
    ctaOk: Boolean(ui.model),
  });
}

/**
 * ONE MODEL. A model that cannot be baselined is drawn dead WITH ITS REASON,
 * never hidden.
 *
 * Hiding it would answer the operator's actual question — "where is the model I
 * wanted" — with silence, and the most common reason (it already has a floor) is
 * the one they most need to see, because it means the thing they wanted is
 * already done.
 */
function modelLine(m) {
  const ok = m.can_baseline?.allowed === true;
  const on = ui.model === m.id;
  // THE CONTEXT CAVEAT BELONGS WHERE THE MODEL IS CHOSEN, not only on the
  // confirmation later. Every model the provider lists is offered — the
  // benchmark measures a delta WITHIN one model, so a narrow window does not
  // bias its own result — but a window narrower than the local aliases run at
  // can end the cell early against the provider's ceiling, and that is the
  // operator's call to make with the number in front of them.
  const narrow = m.below_advisory_floor === true && Number.isFinite(m.context);
  const meta = ok
    ? [
        m.provider,
        narrow ? `${m.context.toLocaleString()} ctx — may hit the provider ceiling` : null,
        m.resident === true ? "resident" : m.resident === false ? "not resident — loads on first request" : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : (m.can_baseline?.reason ?? "not available");

  return line({
    glyph: ok ? (on ? "●" : "○") : "✕",
    text: m.id,
    meta,
    kind: ok ? (on ? "on" : "off") : "dead",
    attr: ok ? `data-create-model="${esc(m.id)}"` : "",
  });
}

/**
 * THE KEY, REPORTED — never requested.
 *
 * There is no field here and there must never be one. The credential is resolved
 * server-side from the same places the harness reads (the environment, then
 * `config/cloud.env`), and what reaches this browser is presence, source and an
 * eight-character fingerprint. A key typed into this modal would live in page
 * memory, in a POST body and in the browser's autofill store, to configure a
 * file that already sits on the same disk as the service that reads it.
 */
function keyLine(cloud) {
  const k = cloud?.key ?? null;
  if (!k) return "";
  return `
    <div class="ckey ${k.present ? "on" : "bad"}">
      <span class="ckey-head">${esc(k.present ? "API KEY RESOLVES" : "NO API KEY")}</span>
      <span class="ckey-body">${esc(
        k.present
          ? `read from ${k.source === "environment" ? "the control plane's environment" : k.source_detail ?? "the key file"} · fingerprint ${k.fingerprint}`
          : (k.reason ?? "no key could be resolved"),
      )}</span>
      <span class="ckey-note">${esc(
        "Resolved by the control plane and never sent to this browser. There is no field here to type one into.",
      )}</span>
    </div>`;
}

// ── BASELINE · 3 — confirm ──────────────────────────────────────────────────

/**
 * WHERE COMPACTION DEFAULTS ON — the panel's MIRROR of the server rule.
 *
 * The server decides (control/server.mjs `compactDefaultFor`), and the token is
 * minted from ITS answer. This exists so the toggle can be drawn in the right
 * position before the preview round-trip, and so the operator sees the state
 * they are about to confirm rather than a placeholder that flips under them.
 *
 * A mirror is a second copy and can drift, which is why it decides NOTHING: if
 * these ever disagree the server's answer is the one that runs, and the
 * confirmation frame shows the server's restatement, not this.
 */
const COMPACT_DEFAULT_CEILING = 524288;

function compactDefaultFor(m) {
  const ctx = Number(m?.context);
  if (!Number.isFinite(ctx) || ctx <= 0) return true; // unknown window → compact
  return ctx < COMPACT_DEFAULT_CEILING;
}

/**
 * BASELINE · 2b — start from a captured build instead of building one.
 *
 * DEV MODE ONLY, and reached only because `steps()` inserted it. The list, the
 * seedability of each row and the armed selection are all the control plane's
 * answers; this frame renders them and posts the operator's choice back. See
 * panels/snapshot.js for why none of that is decided here.
 *
 * The CTA is always enabled: "build from scratch" is a valid outcome of this
 * step and is the one an operator who opened it by accident needs.
 */
function baselineSeed(ledger, board) {
  // Fired on render, read on the next one — the same fire-and-forget shape the
  // ledger's stats strip uses, so a slow control plane cannot block the frame.
  refreshSnapshots(board?.control?.base_url, ui.model);
  const armed = armedSnapshotId();
  return shell({
    step: "BASELINE · 2b",
    branch: "start new baseline",
    title: "Seed from a build snapshot?",
    body: renderSeedFrame(ui.model),
    note:
      "Seeding skips the build phase and starts at the first troubleshooting round. "
      + "A seeded cell is a development run and is never a scorable floor.",
    back: "‹ back",
    cta: armed ? "SEEDED — CONTINUE →" : "NO SEED — CONTINUE →",
    ctaAttr: `data-create-next="1"`,
    ctaOk: true,
  });
}

function baselineConfirm(ledger) {
  const m = (ledger?.startable ?? []).find((x) => x.id === ui.model) ?? null;
  const cloud = ledger?.cloud ?? null;
  const isCloud = ui.kind === "cloud";
  const isOn = (ui.arm ?? "off") === "on";
  const compactDefault = compactDefaultFor(m);
  const compactOn = ui.compact ?? compactDefault;
  const ctx = Number(m?.context);
  const ctxWord = Number.isFinite(ctx) && ctx > 0 ? `${ctx.toLocaleString()} ctx` : "context unknown";

  const body = `
    ${line({ glyph: "✓", text: isCloud ? `cloud · ${m?.provider ?? "vendor"}` : "local · relay proxy", meta: isCloud ? (m?.slug ?? "") : "lm studio", kind: "on" })}
    ${line({ glyph: "✓", text: ui.model ?? "no model", meta: m?.label ?? "", kind: "on" })}
    ${isOn
      ? line({
          glyph: "✓",
          text: "MEMORY ON cell — measured against this model's floor",
          meta: ui.org ? `org ${ui.org}` : "the server requires an org and will refuse without one",
          kind: "on",
        })
      : line({ glyph: "✓", text: "CONTROL cell — memory off", meta: "this IS the floor; it is measured against nothing", kind: "on" })}
    ${isCloud
      ? line({
          glyph: "$",
          text: `billed · ceiling $${Number(cloud?.spend_ceiling_usd ?? 0).toFixed(2)} for this cell`,
          meta: cloud?.spend_note ?? "",
          kind: "off",
        })
      : ""}
    ${line({
      glyph: compactOn ? "✓" : "○",
      text: compactOn ? "compaction ON — compact between build chunks" : "compaction OFF — no compaction",
      meta: compactOn
        ? `${ctxWord} · after each of the 6 chunks, never during troubleshooting`
        : `${ctxWord} · the build keeps its full transcript`,
      kind: compactOn ? "on" : "off",
    })}
    ${compactOn === compactDefault ? "" : line({
      glyph: "·",
      text: `overriding the default for this model (${compactDefault ? "on" : "off"})`,
      meta: `models under ${COMPACT_DEFAULT_CEILING.toLocaleString()} ctx compact by default`,
      kind: "ghost",
    })}
    ${isOn
      ? line({
          glyph: "·",
          text: "compaction must match the floor this is measured against",
          meta: "a delta across a compacted and an uncompacted cell measures compaction, not memory",
          kind: "ghost",
        })
      : line({ glyph: "·", text: "this cell IS the floor", meta: "an OFF baseline is measured against nothing — it is what everything else is subtracted from", kind: "ghost" })}
    ${compactOn ? "" : compactOffWarning(compactDefault)}
    ${seedWarning()}`;

  return shell({
    step: isOn ? "RUN · 1" : "BASELINE · 3",
    branch: isOn ? "run against the floor" : "start new baseline",
    title: "Confirm",
    body,
    headRight: compactControl(compactOn, compactDefault),
    // NO BACK ON THE ON ARM. It was entered from a baseline row, not from this
    // flow's frames — there is no b2 model picker behind it to return to, and
    // offering one would drop the operator into a half-built baseline sequence.
    back: isOn ? null : "‹ back",
    // NO NOTE. This frame is the confirmation, and START starts the cell —
    // there is no second dialog to warn about any more.
    cta: "START →",
    ctaAttr: `data-create-baseline-continue="1"`,
    ctaOk: Boolean(ui.model),
    final: true,
  });
}

/**
 * THE HEADER COMPACTION TOGGLE, under `esc` at the card's top-right.
 *
 * A single button showing the current state; clicking it flips it. "COMPACT:
 * ON" → "COMPACT: OFF" in one click, nothing else.
 *
 * RED WHEN OFF OVERRIDES A DEFAULT-ON PRECONDITION. The model's context window
 * says compaction should be on (the "measured precondition"); turning it off is
 * an active removal of what the window asked for. That is the one case the
 * button turns red — the same `--danger` the summary warning below uses, so the
 * colour means the same thing in both places.
 */
function compactControl(compactOn, compactDefault) {
  const overrideOff = compactOn === false && compactDefault === true;
  return `
    <button class="ccompact-btn${overrideOff ? " override" : ""}" data-create-compact="${compactOn ? "on" : "off"}" aria-pressed="${compactOn}">
      COMPACT: ${compactOn ? "ON" : "OFF"}
    </button>`;
}

/**
 * WHAT TURNING COMPACTION OFF COSTS, said at the moment it is turned off.
 *
 * Shown only when the toggle is off, and worded harder when off is an OVERRIDE
 * of a default that wanted it on — because that is the case where the operator
 * has actively removed something the model's own context window asked for.
 *
 * This is a warning, not a refusal. The operator may have a reason to want an
 * uncompacted run (measuring the compaction effect itself, most obviously), and
 * the panel does not get to decide that. What it does get to do is make sure
 * nobody turns this off without being told what happens — the failure it
 * prevents is silent and only shows up hours later, as a repair phase that has
 * forgotten what it already tried.
 */
function compactOffWarning(defaultWasOn) {
  return `
    <div class="cwarn${defaultWasOn ? " override" : ""}" role="note">
      <span class="cwarn-head">${esc(
        defaultWasOn
          ? "COMPACTION OFF — AGAINST THE DEFAULT FOR THIS MODEL"
          : "COMPACTION OFF",
      )}</span>
      <span class="cwarn-body">${esc(
        "The six build chunks keep their full transcript, so the model reaches the " +
          "troubleshooting phase with the build still in its context. On a model " +
          "whose window fills during the build, the context limit is reached mid-run " +
          "and the model loses sight of which steps it already solved and why — it " +
          "then repeats work, re-breaks fixed gates, and the repair loop measures the " +
          "context ceiling instead of the model.",
      )}</span>
      <span class="cwarn-note">${esc(
        defaultWasOn
          ? "This model's context window is below the threshold where that starts happening. " +
            "Leave it off only if an uncompacted run is the thing being measured."
          : "This model has room to spare, so an uncompacted build is a reasonable choice here.",
      )}</span>
      <span class="cwarn-note">${esc(
        "Compacted and uncompacted cells sit on different turn and token scales. A delta " +
          "across the two measures compaction, not memory.",
      )}</span>
    </div>`;
}

// ── LAUNCH (frame BASELINE · 4) ─────────────────────────────────────────────
//
// ── WHY THE SECOND DIALOG IS GONE ───────────────────────────────────────────
//
// START used to arm the cell and hand off to a separate run-control screen that
// asked the same question again. Two dialogs meaning "confirm this run" is one
// too many: the operator learns to click through whichever they see more often,
// and the three frames before this one have already established the model, the
// substrate and the arm. This frame is what the second dialog should have been —
// not another question, but the ANSWER arriving.
//
// The server's validation did NOT go with it. `preview` still runs and still
// mints the token that `start` must carry, so the parameters are checked by the
// server exactly as before; the difference is that a refusal now lands as a red
// row here instead of as a fresh modal, and it lands in the SERVER'S OWN WORDS.
//
// ── WHAT THIS SURFACE IS FOR ────────────────────────────────────────────────
//
// So nobody has to ask an agent whether the run is actually working. Every row
// is a real observation with a named source. Nothing is inferred, nothing is
// optimistic, and a row that cannot be observed says `unobserved` rather than
// showing a checkmark it did not earn.

/** Preflight is the one gate that runs BEFORE the launch and can refuse it. */
/**
 * `compact` is passed so preflight checks the things THIS run will actually
 * use. Compaction depends on a tool baked into the worker image, and opencode
 * swallows plugin load errors — so a stale image reports nothing wrong right up
 * until the model is told to call a tool that is not there.
 */
async function runPreflight(base, { model = null, compact = false } = {}) {
  const params = new URLSearchParams();
  if (model) params.set("model", model);
  if (compact) params.set("compact", "1");
  const query = params.toString();
  const res = await fetch(`${base}/api/preflight${query ? `?${query}` : ""}`);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error(`preflight unreadable (HTTP ${res.status})`);
  const failed = (data.checks ?? []).filter((c) => c.status !== "pass");
  return {
    ok: data.verdict === "go" && (data.blocking_failures ?? 0) === 0,
    total: (data.checks ?? []).length,
    failed,
    verdict: data.verdict ?? "unknown",
    ...remedyPlan(failed),
  };
}

/**
 * WHICH BUTTON FIXES THIS.
 *
 * "Fix what preflight named, then start again" was the whole of the guidance,
 * and what preflight named was a shell command — so a refusal on the board sent
 * the operator to a terminal for something the board itself can do. Every
 * failure that a custom tool repairs now carries that tool, resolved by the
 * control plane against the real registry (`remedy`), and this turns the list of
 * failures into the SHORT list of distinct buttons to press.
 *
 * GROUPED BY TOOL, not one button per failed check: a stale image trips several
 * checks at once and they are all repaired by one press.
 *
 * WHAT HAS NO BUTTON IS STILL SAID. A campaign slot to archive, a dead hub, a
 * roster that disagrees with itself — none of those are a button, and quietly
 * dropping them would turn "press these two things" into a promise that the
 * launch will then succeed.
 */
export function remedyPlan(failed) {
  const byTool = new Map();
  const unfixable = [];
  for (const c of failed) {
    const r = c?.remedy;
    // `remedy_tool` present but `remedy` null means preflight named a tool this
    // installation does not have — a bare clone of bench/ has no dev tools. That
    // is not a button, and the check's own detail already names the fix in words.
    if (!r?.id) {
      unfixable.push(c);
      continue;
    }
    if (!byTool.has(r.id)) byTool.set(r.id, { ...r, checks: [] });
    byTool.get(r.id).checks.push(c);
  }
  return { remedies: [...byTool.values()], unfixable };
}

/**
 * START. Preflight, then preview, then start — in that order, stopping at the
 * first refusal.
 *
 * PREFLIGHT FIRST AND IT IS A HARD GATE. It is the only step here that can
 * refuse cheaply: everything it checks (ports, images, identity, disk) is a
 * precondition whose failure would otherwise surface hours in, or — as with a
 * stale worker image — not surface at all and quietly measure the wrong
 * substrate.
 */
/**
 * Open the CONFIRM frame for a cell — either arm.
 *
 * THE ON ARM GETS THE SAME FRAME, and that is the whole point of this function.
 * [+ run] used to jump straight to the launch checklist,
 * skipping confirmation entirely, which meant an ON cell could never be told
 * anything about how it was configured — including whether it would compact.
 * Since a compacted cell and an uncompacted one sit on different turn and token
 * scales, an ON cell that silently took a different setting from its OFF floor
 * would produce a delta measuring compaction rather than memory. One frame,
 * both arms, the toggle visible in each.
 */
export function openCellConfirm({ model, kind, arm = "off", org = null } = {}) {
  if (model) { ui.model = model; ui.kind = kind ?? ui.kind; }
  ui.open = true;
  ui.arm = arm;
  ui.org = org;
  ui.compact = null;
  ui.refusal = null;
  ui.launch = null;
  ui.step = "b3";
}

export async function launchCell(base, { model, kind, arm = null, org = null } = {}) {
  // Called for the [+ run] path too, where the selection comes from a baseline
  // row rather than this flow's own frames.
  if (model) { ui.model = model; ui.kind = kind ?? ui.kind; }
  ui.open = true;
  if (arm !== null) ui.arm = arm;
  if (org !== null) ui.org = org;
  ui.step = "b4";
  ui.launch = { startedAt: Date.now(), preflight: null, start: null, pid: null };

  try {
    ui.launch.preflight = { state: ROW.running };
    const pf = await runPreflight(base, {
      model: ui.model,
      // CHECKED UNLESS EXPLICITLY DISABLED. The tri-state's `null` means the
      // server's default stands, and that default is ON for every model narrow
      // enough to need it — so the safe reading of "not decided" is "will
      // probably compact". Checking when it turns out not to is ~15s wasted;
      // NOT checking when it does is a cell that silently never compacts.
      compact: ui.compact !== false,
    });
    ui.launch.preflight = pf.ok
      ? { state: ROW.pass, detail: `${pf.total} checks passed` }
      : {
          state: ROW.fail,
          detail: `${pf.verdict.toUpperCase()} — ${pf.failed.map((c) => `${c.id ?? c.name}: ${c.detail ?? "failed"}`).join(" · ")}`,
        };
    // Held on the launch, not on the row: the checklist row renders the reason,
    // and this renders the way out of it.
    ui.launch.remedies = pf.ok ? [] : pf.remedies;
    ui.launch.unfixable = pf.ok ? [] : pf.unfixable;
    if (!pf.ok) {
      // Nothing is launched. The remaining rows stay pending rather than being
      // marked failed — they were never attempted, and that is a different fact.
      ui.launch.start = { state: ROW.pending, detail: "not attempted — preflight refused" };
      return;
    }

    ui.launch.start = { state: ROW.running };
    // ORG IS NOT INVENTED HERE. An ON cell needs one and this flow has no way
    // to know it; the server refuses with `org_required` in its own words, and
    // that refusal lands on the checklist rather than being pre-empted by a
    // guess.
    const payload = { model: ui.model, arm: ui.arm ?? "off", kind: ui.kind };
    if ((ui.arm ?? "off") === "on" && ui.org) payload.org = ui.org;
    // ONLY SENT WHEN THE OPERATOR TOUCHED IT. `null` means they did not, and
    // omitting the key is how the server is told to apply its own default —
    // sending `false` for "untouched" would strip compaction from every model
    // whose window asked for it.
    if (ui.compact !== null) payload.compact = ui.compact;
    // PLAN BEFORE WORK — read from the settings drawer at SEND time, not held
    // in `ui`. It is a browser preference set on a different surface, and the
    // operator can flip it while this wizard is open.
    //
    // Unconditional, unlike compaction: compaction has a server-side default
    // that "unspecified" must reach, so omitting the key is meaningful there.
    // This has no server default — off is off — so always stating it is the
    // honest form, and a missing key would silently mean off anyway.
    payload.requireTodos = requireTodosOn();
    payload.recordAtChunkEnd = recordAtChunkEndOn();
    // MACHINE SHARE for grading. Read at SEND time like the two above, but not
    // the same KIND of setting: those change what the agent does and make two
    // runs incomparable, this only changes how many test workers the grading
    // container starts once the model is done. It travels with the run so the
    // value that graded a cell is the one recorded against it, rather than
    // whatever the drawer happened to say later.
    payload.graderWorkerTarget = graderWorkerTarget();

    const pv = await fetch(`${base}/api/run/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const pvData = await pv.json().catch(() => null);
    if (!pv.ok || pvData?.ok === false) {
      ui.launch.start = {
        state: ROW.fail,
        detail: `${pvData?.code ?? `HTTP ${pv.status}`}: ${pvData?.reason ?? "the control plane refused these parameters"}`,
      };
      return;
    }

    const res = await fetch(`${base}/api/run/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, confirm: pvData.token }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.ok === false) {
      ui.launch.start = {
        state: ROW.fail,
        detail: `${data?.code ?? `HTTP ${res.status}`}: ${data?.reason ?? "start refused"}`,
      };
      return;
    }

    ui.launch.pid = data.pid ?? null;
    ui.launch.start = { state: ROW.pass, detail: `accepted · pid ${data.pid ?? "?"}` };
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (ui.launch.preflight?.state === ROW.running) ui.launch.preflight = { state: ROW.fail, detail: msg };
    else ui.launch.start = { state: ROW.fail, detail: msg };
  }
}

/**
 * THE ROWS AFTER THE LAUNCH ARE DERIVED FROM THE LIVE BOARD, not remembered.
 *
 * The board already streams over SSE, so these re-evaluate on every frame with
 * no polling of their own. Deriving rather than recording also means the
 * checklist cannot drift from what the rest of the board is showing — there is
 * one account of the run, and this is a view of it.
 *
 * PENDING vs FAILED. A row that has not happened YET is pending, not failed. A
 * cell takes minutes to reach its first phase, and marking those minutes red
 * would train the operator to ignore red.
 */
export function launchRows(board) {
  const L = ui.launch;
  if (!L) return [];

  const run = board?.run ?? {};
  const ctl = board?.control?.run ?? null;
  const launched = L.start?.state === ROW.pass;
  const dead = run.state === "failed" || run.state === "complete";

  // Once the launch itself failed nothing downstream was ever attempted.
  const after = (observed, detail, pendingDetail) => {
    if (!launched) return { state: ROW.pending, detail: "not attempted" };
    if (observed) return { state: ROW.pass, detail };
    // The cell ended without this ever being seen — it is not coming.
    if (dead) return { state: ROW.fail, detail: "the cell ended before this was observed" };
    return { state: ROW.running, detail: pendingDetail };
  };

  const suiteTotal = board?.suite?.suite?.total ?? null;

  return [
    { id: "preflight", label: "Preflight", src: "12 checks · control plane", ...(L.preflight ?? { state: ROW.pending }) },
    { id: "launch", label: "Launch accepted", src: "POST /api/run/start", ...(L.start ?? { state: ROW.pending }) },
    {
      id: "harness",
      label: "Harness alive",
      src: "process probe",
      // The start response ALREADY proves this: the control plane confirms the
      // child survived its startup window before returning ok, which is what
      // catches a harness that dies on a usage error seconds after spawn.
      ...(!launched
        ? { state: ROW.pending, detail: "not attempted" }
        : ctl && ctl.running === false && !dead
          ? { state: ROW.fail, detail: "the process probe no longer sees the harness" }
          : { state: ROW.pass, detail: `survived startup · pid ${L.pid ?? "?"}` }),
    },
    {
      id: "suite",
      label: "Gate suite enumerated",
      src: "gate-roster.json",
      ...after(
        Number.isFinite(suiteTotal) && suiteTotal > 0,
        `${suiteTotal} gates — the denominator every result is scored against`,
        "the harness enumerates the suite at cell start",
      ),
    },
    {
      id: "session",
      label: "Cell session opened",
      src: "opencode serve",
      ...after(Boolean(run.session_id), `session ${String(run.session_id ?? "").slice(0, 18)}…`, "waiting for the cell to open its session"),
    },
    {
      id: "phase",
      label: "Model responding",
      src: "first phase",
      ...after(Boolean(run.phase), `phase ${run.phase}`, "the model loads on first request — this is the first turn landing"),
    },
  ];
}

/**
 * Whole class names per state — the style-coverage guard blanks template holes
 * before reading class attributes, so an interpolated suffix reaches it as a
 * bare prefix that matches no rule, and a missing rule renders silently.
 */
const ROW_CLASS = {
  pending: "ck-row ck-pending",
  running: "ck-row ck-running",
  pass: "ck-row ck-pass",
  fail: "ck-row ck-fail",
  unobserved: "ck-row ck-unobserved",
};

/** One checklist row. The glyph carries the state; colour is never the only cue. */
function checkRow(r) {
  const glyph = {
    pending: `<span class="ck-g ck-pending">·</span>`,
    running: `<span class="ck-g ck-spin"></span>`,
    pass: `<span class="ck-g ck-pass">✓</span>`,
    fail: `<span class="ck-g ck-fail">✗</span>`,
    unobserved: `<span class="ck-g ck-unobs">?</span>`,
  }[r.state] ?? `<span class="ck-g ck-pending">·</span>`;

  return `
    <div class="${ROW_CLASS[r.state] ?? "ck-row ck-pending"}">
      ${glyph}
      <span class="ck-label">${esc(r.label)}</span>
      <span class="ck-src">${esc(r.src)}</span>
      ${r.detail ? `<span class="ck-detail">${esc(r.detail)}</span>` : ""}
    </div>`;
}

/**
 * THE WAY OUT OF A REFUSAL.
 *
 * Rendered only under a preflight refusal, and only when the control plane
 * resolved at least one failure to a tool that this installation actually has.
 *
 * ONE BUTTON PER TOOL, each naming the checks it repairs, because a stale image
 * trips several checks at once and pressing rebuild three times is not three
 * fixes. A blocked tool is shown DISABLED with its own reason rather than
 * hidden: "the button that would fix this cannot run, and here is why" is
 * information; a missing button is not.
 */
function remedyBlock() {
  const remedies = ui.launch?.remedies ?? [];
  const unfixable = ui.launch?.unfixable ?? [];
  if (!remedies.length && !unfixable.length) return "";

  const buttons = remedies
    .map((r) => {
      const wired = r.status === "wired";
      const fixes = r.checks.map((c) => c.name).join(", ");
      return `
        <div class="fx-row">
          <button class="btn sm primary" ${wired ? "" : "disabled"}
            data-preflight-fix="${esc(r.id)}"
            data-preflight-fix-why="${esc(fixes)}">${esc(r.name)}</button>
          <span class="fx-fixes">fixes ${esc(fixes)}</span>
          ${wired ? "" : `<span class="fx-blocked">${esc(r.blocked_reason ?? "this tool is not available from the board")}</span>`}
        </div>`;
    })
    .join("");

  // Named, never silently dropped — otherwise pressing the buttons above reads
  // as a promise that the next launch will go through.
  const rest = unfixable.length
    ? `<div class="fx-manual">No button for: ${esc(
        unfixable.map((c) => c.name).join(", "),
      )} — the reason above says what to do.</div>`
    : "";

  return `
    <div class="fx-block">
      <span class="fx-head">${remedies.length ? "FIX IT FROM HERE" : "NOTHING HERE CAN FIX THIS"}</span>
      ${buttons}
      ${rest}
    </div>`;
}

/**
 * BASELINE · 4 — the launch, as it happens.
 *
 * NO CTA. There is nothing left to confirm and nothing here to decide: the cell
 * is running (or it was refused, and the reason is on screen). The only control
 * is CLOSE, and it says what closing does — because a dialog over a live run
 * that offers a bare ✕ leaves the operator guessing whether dismissing it kills
 * the cell.
 */
function launchProgress(board) {
  const rows = launchRows(board);
  const failed = rows.find((r) => r.state === "fail") ?? null;
  const done = rows.every((r) => r.state === "pass");

  const head = failed
    ? `<span class="ck-head bad">${esc(failed.id === "preflight" ? "PREFLIGHT REFUSED — NOTHING STARTED" : "SOMETHING FAILED")}</span>`
    : done
      ? `<span class="ck-head ok">RUNNING</span>`
      : `<span class="ck-head">STARTING…</span>`;

  return shell({
    step: "BASELINE · 4",
    branch: ui.model ? esc(ui.model) : "start new baseline",
    title: "Launch",
    body: `
      ${head}
      <div class="ck-list">${rows.map(checkRow).join("")}</div>
      ${failed && failed.id === "preflight" ? remedyBlock() : ""}
`,
    // Back would return to a confirmation for a cell that is already running.
    back: null,
    note:
      failed && failed.id === "preflight"
        ? ((ui.launch?.remedies ?? []).length
            ? "No cell was started. Press the tool below — this closes and opens it in Settings — then start again."
            : "No cell was started. Fix what preflight named, then start again.")
        : "Closing this leaves the run alone — the cell keeps going and the board tracks it from here.",
    cta: "CLOSE",
    ctaAttr: `data-create-cancel="1"`,
    ctaOk: true,
    final: true,
  });
}
