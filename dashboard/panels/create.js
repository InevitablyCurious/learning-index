// PANEL: [+ BASELINE] — local or cloud → model → (dev mode: seed) → challenge →
// confirm → launch. Every frame before the last is free; only START commits.
// An ON run starts at [+ run] on a baseline row and lands in this file's confirm
// frame (openCellConfirm), so both arms are configured through one surface.

import { esc } from "../board.js";
import { graderWorkerTarget, requireTodosOn } from "./switches.js";
import { renderSeedFrame, refreshSnapshots, seedWarning, armedSnapshotId } from "./snapshot.js";
import { isDevModeOn } from "./devmode.js";
import {
  challengeById,
  refreshChallenges,
  renderChallengeList,
  soleReadyChallenge,
} from "./challenge.js";

/**
 * The flow's state: what the operator is part-way through choosing. Local,
 * never on the board payload (a poll would erase it).
 */
const ui = {
  open: false,
  // b1 → b2 → bc → b3 → b4   (with b2s spliced in under dev mode)
  step: "b1",

  // ── the cell being configured ──
  kind: null,        // "local" | "cloud"
  model: null,       // the id from `startable`
  // null until the challenge step resolves it (one ready challenge pre-selects).
  challenge: null,
  query: "",
  provider: "all",
  // "off" for a baseline; "on" when entered from [+ run].
  arm: "off",
  org: null,
  // Tri-state: null = the server's default stands (it knows the context window);
  // true/false = the operator's override.
  compact: null,

  // "Working" and "refused" are different facts; never shown as each other.
  pending: false,
  refusal: null,

  // ── launch (frame b4) ── what the launch itself learned (preflight, accepted,
  // pid). The rows after it are derived from the live board (launchRows).
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
  ui.challenge = null;
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
 * Close the dialog. Closing never stops a run; it only drops this launch's
 * view of it.
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

// ── NAVIGATION ── back on the first step has nowhere to go; escape closes.

// The seed step (b2s) exists only in dev mode, so the step map is a function.
// Dev mode comes from the server's answer on the board, never a local flag.
const NEXT_BASE = { b1: "b2", b2: "bc", bc: "b3", b3: null, b4: null };
const BACK_BASE = { b2: "b1", bc: "b2", b3: "bc" };
const NEXT_DEV = { ...NEXT_BASE, b2: "b2s", b2s: "bc" };
const BACK_DEV = { ...BACK_BASE, b2s: "b2", bc: "b2s" };
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

/** The model this sequence is for (the seed step's arming call names it). */
export function createModel() {
  return ui.model;
}

export function setCreateChallenge(id) {
  ui.challenge = id;
}

export function setCreateKind(kind) {
  ui.kind = kind;
  // A model picked on one substrate is meaningless on the other.
  ui.model = null;
  ui.provider = "all";
  ui.compact = null;
}

export function setCreateModel(id) {
  ui.model = ui.model === id ? null : id;
  // An override belongs to the model it was made for (defaults follow the window).
  ui.compact = null;
}

/**
 * Flip the compaction toggle relative to what is shown, not to null, so the
 * first click always changes what the operator sees.
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
    case "bc": return baselineChallenge(board);
    case "b3": return baselineConfirm(ledger);
    case "b4": return launchProgress(board);
    // An unknown step is a map bug; fall back to the first frame.
    default: return baselineKind(ledger);
  }
}

/** Every frame goes through one shell: same geometry, back and CTA placement. */
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
 * The refusal, above the control that caused it: the machine code (quote this)
 * and the server's own words, never paraphrased.
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
 * One model. One that cannot be baselined is drawn dead with its reason, never
 * hidden (usually: it already has a floor).
 */
function modelLine(m) {
  const ok = m.can_baseline?.allowed === true;
  const on = ui.model === m.id;
  // The context caveat shows where the model is chosen: a window narrower than the
  // local aliases can end the cell early. Offered anyway; the operator decides.
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
 * The key is reported (presence, source, fingerprint), never requested: it is
 * resolved server-side from the environment or config/cloud.env.
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
 * Where compaction defaults on — a mirror of the server rule, used only to draw
 * the toggle before the preview returns. It decides nothing.
 */
const COMPACT_DEFAULT_CEILING = 524288;

function compactDefaultFor(m) {
  const ctx = Number(m?.context);
  if (!Number.isFinite(ctx) || ctx <= 0) return true; // unknown window → compact
  return ctx < COMPACT_DEFAULT_CEILING;
}

/**
 * BASELINE · 2b (dev mode only) — start from a captured build. The list,
 * seedability and the armed choice are all the control plane's answers. The CTA
 * is always enabled: "build from scratch" is a valid answer.
 */
function baselineSeed(ledger, board) {
  // Fire-and-forget: read on the next render, so a slow control plane never
  // blocks the frame.
  refreshSnapshots(ui.model);
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

function baselineChallenge(board) {
  // Fire-and-forget, as above.
  refreshChallenges();
  // One ready challenge starts selected; with two or more nothing is pre-picked.
  if (ui.challenge === null) ui.challenge = soleReadyChallenge();
  const picked = ui.challenge ? challengeById(ui.challenge) : null;
  return shell({
    step: "BASELINE · 3",
    branch: "start new baseline",
    title: "Pick the challenge",
    body: renderChallengeList(ui.challenge),
    note:
      "The challenge is what the cell builds and what the gates grade. It is pinned to "
      + "this baseline: every later cell builds the same one.",
    back: "‹ back",
    cta: picked ? `${picked.name.toUpperCase()} →` : "PICK A CHALLENGE",
    ctaAttr: picked ? `data-create-next="1"` : "",
    ctaOk: Boolean(picked),
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
    step: isOn ? "RUN · 1" : "BASELINE · 4",
    branch: isOn ? "run against the floor" : "start new baseline",
    title: "Confirm",
    body,
    headRight: compactControl(compactOn, compactDefault),
    // No back on the ON arm: it was entered from a baseline row.
    back: isOn ? null : "‹ back",
    cta: "START →",
    ctaAttr: `data-create-baseline-continue="1"`,
    ctaOk: Boolean(ui.model),
    final: true,
  });
}

/** The compaction toggle. Red when it is off against a default-on window. */
function compactControl(compactOn, compactDefault) {
  const overrideOff = compactOn === false && compactDefault === true;
  return `
    <button class="ccompact-btn${overrideOff ? " override" : ""}" data-create-compact="${compactOn ? "on" : "off"}" aria-pressed="${compactOn}">
      COMPACT: ${compactOn ? "ON" : "OFF"}
    </button>`;
}

/**
 * What turning compaction off costs, shown when it is off (harder when that
 * overrides a default). A warning, not a refusal.
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

// ── LAUNCH (frame BASELINE · 4) ── START runs preflight, preview (which mints
// the token) and start; a refusal lands as a red row in the server's own words.
// Every row is a real observation; one that cannot be observed says so.

/** Preflight is the one gate that runs BEFORE the launch and can refuse it. */
/**
 * `compact` so preflight checks what this run uses: compaction needs a tool
 * baked into the worker image, and a stale image fails silently.
 */
async function runPreflight({ model = null, compact = false } = {}) {
  const params = new URLSearchParams();
  if (model) params.set("model", model);
  if (compact) params.set("compact", "1");
  const query = params.toString();
  const res = await fetch(`/api/preflight${query ? `?${query}` : ""}`);
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
 * Which buttons fix a preflight refusal: failures grouped by the custom tool
 * that repairs them. Failures with no tool are still listed.
 */
export function remedyPlan(failed) {
  const byTool = new Map();
  const unfixable = [];
  for (const c of failed) {
    const r = c?.remedy;
    // A tool this installation doesn't have (a bare clone has no dev tools).
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
 * START: preflight (a hard gate), then preview, then start, stopping at the
 * first refusal.
 */
/**
 * Open the confirm frame for a cell, either arm. The ON arm gets the same frame
 * so its compaction setting is visible: a different setting from its floor
 * would make the delta measure compaction, not memory.
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

export async function launchCell({ model, kind, arm = null, org = null } = {}) {
  // The [+ run] path: the selection comes from a baseline row.
  if (model) { ui.model = model; ui.kind = kind ?? ui.kind; }
  ui.open = true;
  if (arm !== null) ui.arm = arm;
  if (org !== null) ui.org = org;
  ui.step = "b4";
  ui.launch = { startedAt: Date.now(), preflight: null, start: null, pid: null };

  try {
    ui.launch.preflight = { state: ROW.running };
    const pf = await runPreflight({
      model: ui.model,
      // Checked unless explicitly off: "not decided" probably compacts.
      compact: ui.compact !== false,
    });
    ui.launch.preflight = pf.ok
      ? { state: ROW.pass, detail: `${pf.total} checks passed` }
      : {
          state: ROW.fail,
          detail: `${pf.verdict.toUpperCase()} — ${pf.failed.map((c) => `${c.id ?? c.name}: ${c.detail ?? "failed"}`).join(" · ")}`,
        };
    ui.launch.remedies = pf.ok ? [] : pf.remedies;
    ui.launch.unfixable = pf.ok ? [] : pf.unfixable;
    if (!pf.ok) {
      // Nothing launched: the later rows stay pending, not failed.
      ui.launch.start = { state: ROW.pending, detail: "not attempted — preflight refused" };
      return;
    }

    ui.launch.start = { state: ROW.running };
    // Org is never guessed; the server refuses with org_required.
    const payload = { model: ui.model, arm: ui.arm ?? "off", kind: ui.kind };
    if ((ui.arm ?? "off") === "on" && ui.org) payload.org = ui.org;
    // Sent only when touched; an absent key applies the server's default.
    if (ui.compact !== null) payload.compact = ui.compact;
    // The challenge: the server refuses an unknown one, or a second challenge on a
    // baseline that already built another.
    if (ui.challenge) payload.challenge = ui.challenge;
    payload.requireTodos = requireTodosOn();
    // Grading machine share, read at send time and recorded with the run.
    payload.graderWorkerTarget = graderWorkerTarget();

    const pv = await fetch(`/api/run/preview`, {
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

    const res = await fetch(`/api/run/start`, {
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
 * The rows after the launch, derived from the live board (one account of the
 * run). Not yet happened = pending, not failed.
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
      // Start returns ok only after the child survives its startup window.
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

/** Whole class names: the style-coverage guard cannot see interpolated suffixes. */
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
 * The way out of a refusal: one button per tool, naming the checks it repairs.
 * A blocked tool is shown disabled with its reason.
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

  // Named, so pressing the buttons above doesn't read as a promise.
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

/** BASELINE · 4 — the launch as it happens. No CTA; CLOSE says what closing does. */
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
    step: "BASELINE · 5",
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
            ? "No cell was started. Press the button below — it opens the ☰ menu at the refresh that fixes it — press run there, then start again."
            : "No cell was started. Fix what preflight named, then start again.")
        : "Closing this leaves the run alone — the cell keeps going and the board tracks it from here.",
    cta: "CLOSE",
    ctaAttr: `data-create-cancel="1"`,
    ctaOk: true,
    final: true,
  });
}
