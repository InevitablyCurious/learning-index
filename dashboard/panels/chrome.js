// ─────────────────────────────────────────────────────────────────────────────
// CHROME — top bar + provenance strip
//
// ── WHAT THE BAR IS FOR (v3) ────────────────────────────────────────────────
//
// One line, three facts, one control: WHAT is running, HOW LONG it has been
// running, and STOP. Everything else moved out.
//
// The previous bar carried a brand line, the stack id, the attestation label,
// a READ-ONLY claim and the tree chip. All of it was true and none of it was
// being read — an operator watching a three-hour cell looks at this strip for
// the cell's state and nothing else, and six chips competing for that glance is
// how the one that matters gets missed. The removed facts are not deleted from
// the board: attestation, org, leader and seed remain in the provenance strip
// directly below, which is where a provenance question is actually answered.
//
// NON-NEGOTIABLES THAT SURVIVED THE TRIM:
//  - A cell that has stopped must NEVER imply motion. The spinner animates for
//    running and grading only; every terminal state renders a static mark.
//  - STALLED stays its own loud branch — a wedged cell must never fall through
//    to "no run observed". The state is PRODUCER-STATED: it arrives from the
//    control plane's heartbeat liveness via reconcileRunLiveness, never from
//    the launch log's mtime (WO-HDR-FIX-01 — that proxy printed CELL STALLED
//    over a mid-turn cell whose own heartbeat never stopped).
//  - A stall is not a verdict. The chip says what the PRODUCER measured — the
//    harness's own heartbeat silence, and for how long — and never
//    FAILED / DEAD / ABORTED / CRASHED.
//  - The control-plane reach banner stays. STOP is a write, so when the browser
//    cannot reach :8718 the button is dead and the operator must be told why
//    BEFORE clicking, not after.
// ─────────────────────────────────────────────────────────────────────────────

import { esc, dur, nul, controlReachability } from "../board.js";
// STOP lives here now. The state and both legs of the protocol stay in
// runstart.js — this renders the control, it does not own it.
import { stopState } from "./runstart.js";
// The hamburger is the LAST thing in the bar, on purpose: it opens a surface
// that is not part of the measurement, so it sits past everything that is.
import { renderToolsButton } from "./tools.js";
// The dev-mode FACT belongs in the bar, not only in the drawer: the marker
// below reads it on every poll, before any surface is opened.
import { devModeState } from "./devmode.js";

/**
 * WHAT THE SPINNER IS SAYING.
 *
 * Four states, and the distinction that matters is MOTION vs NO MOTION: only a
 * cell that is actually doing work animates. Colour separates the four; the
 * animation separates "still going" from "over", because that is the question
 * being asked from across a room.
 *
 *   running   — the agent is working                    animated
 *   grading   — the gate suite is executing              animated, second hue
 *   failure   — stalled, or ended on a non-ok status     static, danger
 *   stopped   — ended cleanly, or nothing running        static, dim
 *
 * GRADING IS READ FROM THE PHASE, and the phase vocabulary is the harness's:
 * `conformance`, `backend` and `frontend` are the three gate runners, and
 * `verdict-*` is the scoring pass that follows them. Everything else
 * (`initial*`, `feedback-*`) is the agent's own work.
 */
/**
 * The four class names, written out in full.
 *
 * Interpolating the suffix into the class attribute would be shorter and is the
 * wrong shape: the style-coverage guard blanks template holes before reading
 * class attributes, so an interpolated suffix reaches it as a bare prefix
 * fragment that matches no rule. That guard exists because a missing CSS rule
 * renders SILENTLY — it once dropped the entire gate wall with every check
 * green — so the fix is to emit whole names rather than to weaken the reader.
 *
 * (This comment deliberately does not spell out the interpolated form: the
 * guard reads comments too, and an example of the bad shape would trip it.)
 */
const PULSE_CLASS = {
  running: "pulse-running",
  grading: "pulse-grading",
  failure: "pulse-failure",
  stopped: "pulse-stopped",
};

export function runPulse(run) {
  const r = run ?? {};
  const phase = typeof r.phase === "string" ? r.phase : "";
  const grading =
    phase === "conformance" ||
    phase === "backend" ||
    phase === "frontend" ||
    phase.startsWith("verdict-");

  if (r.state === "running") return grading ? "grading" : "running";
  // A stall is not a failure verdict — but it is the one terminal-looking state
  // that needs the eye pulled to it, so it takes the danger mark.
  if (r.state === "stalled") return "failure";
  // `failed` arrives from the control plane's liveness probe (server.mjs
  // reconcileRunLiveness): the harness is gone and left no terminal record.
  // Without this branch it fell to the default and rendered as `stopped`, which
  // reads as a clean ending for a cell that did not have one.
  if (r.state === "failed") return "failure";
  if (r.state === "complete") {
    // THE CONTROL PLANE STATES THIS; THE BOARD DOES NOT DERIVE IT.
    //
    // This read `t === "ok" || t === "complete"` off `terminal_status` — a
    // second copy of the Python terminal vocabulary, and neither string is
    // emitted by any Python file in the repo. It was dead only because the
    // control plane had the SAME drift and never let `state` reach `complete`;
    // repairing that alone would have turned every clean cell's pulse to
    // failure. `terminal_ok` is the producer's own answer: `true` clean,
    // `false` ended adversely (a walk-gate halt), `null` ended without saying
    // how — unknown is not ok, but it is not a failure verdict either.
    return r.terminal_ok === false ? "failure" : "stopped";
  }
  return "stopped";
}

export function renderTopbar(board, { stale, lastError }) {
  const r = board.run ?? {};

  // The feed being stale is information. Say it plainly rather than freezing a
  // number that looks live.
  const feed = stale
    ? `<span class="chip danger">FEED STALE — ${esc(lastError ?? "poll failed")}</span>`
    : "";

  // ENDED WITHOUT AN ENDING. The process is gone and the log carries no terminal
  // record — an interrupt, a STOP, or a crash that unwound through a traceback.
  // It is NOT "complete" (nothing concluded) and NOT "stalled" (nothing is
  // wedged; there is no process left to wedge). Naming it as either would be a
  // claim the board cannot support.
  const state =
    r.state === "failed"
      ? `<span class="chip danger">CELL ENDED — NO RESULT${r.terminal_status ? ` · ${esc(r.terminal_status)}` : ""}</span>`
      : r.state === "complete"
      ? `<span class="tag">CELL COMPLETE${r.terminal_status ? ` · ${esc(r.terminal_status)}` : ""}</span>`
      : r.state === "stalled"
        ? `<span class="chip danger">CELL STALLED${
            // THE PRODUCER'S MEASUREMENT RIDES WITH ITS VERDICT
            // (run-liveness.mjs carries heartbeat_age_s from /api/run). The
            // stall is stated by the harness's own heartbeat, so the duration
            // shown is the heartbeat's silence — rendering log_silent_s here
            // would cite evidence the verdict was not based on, and that proxy
            // is the measured false-positive (WO-HDR-FIX-01).
            r.heartbeat_age_s === null || r.heartbeat_age_s === undefined
              ? ""
              : ` — SILENT ${esc(dur(r.heartbeat_age_s))}`
          }</span>`
        : r.state === "running"
          ? `<span class="tag on">RUNNING${r.elapsed_s !== null && r.elapsed_s !== undefined ? ` ${esc(dur(r.elapsed_s))}` : ""}</span>`
          : `<span class="chip dimchip">${nul("no run observed")}</span>`;

  // WRITES → CONTROL PLANE was a CLAIM, and it is false when the browser cannot
  // reach the control plane. The claim is gone from the bar; the CONSEQUENCE
  // (the banner, and a dead STOP) is what remains, which is the half that
  // changes what an operator does.
  const reach = controlReachability(board);
  const pulse = runPulse(r);

  // DEV MODE, IN THE BAR. Tri-state, and UNKNOWN must NEVER render as OFF:
  // `null` (control plane unreachable, or no dev_mode capability) says "?" —
  // silence and a confident "off" are different facts. OFF renders as nothing.
  const dm = devModeState(board);
  const devModeMark = dm === null
    ? `<span class="devmode-unknown">DEV MODE ?</span>`
    : dm.enabled
      ? `<span class="devmode-on">DEV MODE ON</span>`
      : "";

  return `
  <div class="topbar">
    <span class="${PULSE_CLASS[pulse] ? `pulse ${PULSE_CLASS[pulse]}` : "pulse pulse-stopped"}" role="img" aria-label="${esc(pulse)}"></span>
    <span class="chip dimchip shrink">${r.model ? esc(r.model) : nul("model unobserved")}</span>
    <span class="vr"></span>
    ${state}
    ${devModeMark}
    ${stopSlot(r, reach)}
    <span class="spacer"></span>
    ${feed}
    <a class="histnav" href="/history" aria-label="Run history">history</a>
    ${renderToolsButton()}
  </div>
  ${reach.ok ? "" : reachBanner(reach)}`;
}

/**
 * STOP, IN THE BAR.
 *
 * Rendered only while a cell is actually in flight — a STOP button with nothing
 * to stop is a control that teaches the operator its clicks do not matter.
 *
 * BOTH LEGS RENDER HERE. The arm→confirm protocol is unchanged, but the confirm
 * leg has to appear on THIS surface: `previewStop` mints a restatement into
 * module state, and if the surface that paints it is not on screen the operator
 * sees nothing happen and the cell keeps running. That exact dead end already
 * cost a session on the run-start path (see overlay.js) — it is not repeated
 * here.
 *
 * The server's restatement is shown VERBATIM. It names the pid and what is
 * discarded, and paraphrasing it would be a second, drifting description of an
 * irreversible act.
 */
function stopSlot(run, reach) {
  const live = run?.state === "running" || run?.state === "stalled";
  if (!live) return "";
  if (!reach.ok) {
    return `<button class="tb-stop" disabled title="${esc(reach.reason)}">STOP</button>`;
  }

  const s = stopState();
  if (!s.armed) {
    return `
      <button class="tb-stop" data-stop-open="1" ${s.busy ? "disabled" : ""}>${
        s.busy ? "CHECKING…" : "STOP"
      }</button>
      ${s.error ? `<span class="chip danger">${esc(s.error)}</span>` : ""}`;
  }

  return `
    <span class="tb-stopwrap">
      <button class="tb-stop armed" data-stop-confirm="1" ${s.busy ? "disabled" : ""}>${
        s.busy ? "STOPPING…" : "CONFIRM STOP"
      }</button>
      <button class="tb-keep" data-stop-cancel="1" ${s.busy ? "disabled" : ""}>keep running</button>
      ${s.restatement ? `<span class="tb-restate">${esc(s.restatement)}</span>` : ""}
      ${s.error ? `<span class="chip danger">${esc(s.error)}</span>` : ""}
    </span>`;
}

/**
 * Why the controls are dead, stated ONCE at the top of the board rather than
 * per-button. The operator learns it before clicking, not after a failure.
 */
function reachBanner(reach) {
  return `
  <div class="reach-warn" role="alert">
    <span class="rw-head">CONTROL PLANE NOT REACHABLE</span>
    <span class="rw-body">${esc(reach.reason)}</span>
    <span class="rw-note">${esc("The board itself is fully live — everything you can see is real and current. Only the controls that write are unavailable.")}</span>
  </div>`;
}

export function renderProvenance(board) {
  const p = board.provenance ?? {};
  const anchor = p.policy_anchor_status;

  // anchor_verified is the only good state; anything else means the run should
  // not be trusted, and it is shown in the one off-hue rather than quietly.
  const anchorHtml =
    anchor === null || anchor === undefined
      ? nul("anchor unobserved")
      : `<span class="${anchor === "anchor_verified" ? "bright" : "danger"}">${esc(anchor)}</span>`;

  const bit = (label, v) =>
    `${label} ${v === null || v === undefined ? nul("—") : esc(String(v))}`;

  // ATTESTATION MOVED HERE FROM THE TOP BAR, and it is still PLAIN LABEL TEXT —
  // never a badge, never a tier. It is provenance, not a credential, and this
  // strip is where the rest of the provenance already lives.
  return `
  <div class="prov">
    <span>${bit("policy", p.policy_version)} · ${anchorHtml}</span>
    <span>${esc(p.attestation ?? "bench-mock/self-declared")}</span>
    <span>${bit("worker", p.worker_image_fp)}</span>
    <span>${bit("org", board.run?.org_id)}</span>
    <span>${bit("leader", p.leader_fp)}</span>
    <span>${bit("seed", p.seed)}</span>
    <span>clock: harness wall, not agent-reported</span>
    <span class="spacer"></span>
    <span>serial by contract — one session, one cell, HTTP 409 on overlap</span>
    <span>${renderSourceHealth(board)}</span>
  </div>`;
}

/**
 * Source health. An unwired source is NOT an error — it is a panel that will
 * stay null, and saying which one prevents a viewer reading an empty panel as
 * a broken board.
 */
function renderSourceHealth(board) {
  const s = board.sources ?? [];
  if (!s.length) return nul("no sources");
  const ok = s.filter((x) => x.ok).length;
  const down = s.filter((x) => !x.ok).map((x) => x.id);
  return `sources ${ok}/${s.length}${down.length ? ` · unwired: ${esc(down.join(", "))}` : ""}`;
}
