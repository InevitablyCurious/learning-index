// CHROME — the top bar and the provenance strip.
//
// The bar: what is running, how long, and STOP (provenance lives in the strip
// below). A stopped cell never implies motion. STALLED is its own loud state,
// stated by the control plane from the harness heartbeat (never log mtime), and
// names only what was measured — never FAILED or DEAD. The reach banner explains
// a dead STOP before anyone clicks it.

import { esc, dur, nul, controlReachability } from "../board.js";
// STOP renders here; its state and protocol live in runstart.js.
import { stopState } from "./runstart.js";
// The tools menu is last: it is not part of the measurement.
import { renderToolsButton } from "./tools.js";
// Dev mode is shown in the bar on every poll.
import { devModeState } from "./devmode.js";

/**
 * What the spinner says: only a cell doing work animates.
 *   running  the agent is working           animated
 *   grading  the gate suite is executing     animated, second hue
 *   failure  stalled, or ended not-ok        static, danger
 *   stopped  ended cleanly, or idle          static, dim
 * Grading is read from the phase: conformance, backend, frontend and verdict-*.
 */
/**
 * Whole class names, written out: the style-coverage test cannot see an
 * interpolated suffix. (Deliberately no example of that shape here: the test
 * reads comments too.)
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
  // Not a verdict, but the one state that should pull the eye.
  if (r.state === "stalled") return "failure";
  // `failed` (from the control plane): the harness is gone with no terminal record.
  if (r.state === "failed") return "failure";
  if (r.state === "complete") {
    // The control plane states whether the ending was good (terminal_ok):
    // true clean, false adverse, null unvouched (not ok, not a failure).
    return r.terminal_ok === false ? "failure" : "stopped";
  }
  return "stopped";
}

export function renderTopbar(board, { stale, lastError }) {
  const r = board.run ?? {};

  // A stale feed says so rather than freezing a number that looks live.
  const feed = stale
    ? `<span class="chip danger">FEED STALE — ${esc(lastError ?? "poll failed")}</span>`
    : "";

  // Ended without an ending: no process, no terminal record. Neither complete
  // nor stalled.
  const state =
    r.state === "failed"
      ? `<span class="chip danger">CELL ENDED — NO RESULT${r.terminal_status ? ` · ${esc(r.terminal_status)}` : ""}</span>`
      : r.state === "complete"
      ? `<span class="tag">CELL COMPLETE${r.terminal_status ? ` · ${esc(r.terminal_status)}` : ""}</span>`
      : r.state === "stalled"
        ? `<span class="chip danger">CELL STALLED${
            // The duration shown is the heartbeat's silence — the evidence the stall
            // verdict was actually based on.
            r.heartbeat_age_s === null || r.heartbeat_age_s === undefined
              ? ""
              : ` — SILENT ${esc(dur(r.heartbeat_age_s))}`
          }</span>`
        : r.state === "running"
          ? `<span class="tag on">RUNNING${r.elapsed_s !== null && r.elapsed_s !== undefined ? ` ${esc(dur(r.elapsed_s))}` : ""}</span>`
          : `<span class="chip dimchip">${nul("no run observed")}</span>`;

  // When the control plane is unreachable, the banner and a dead STOP say so.
  const reach = controlReachability(board);
  const pulse = runPulse(r);

  // Tri-state: null (unknown) shows "?", never OFF. OFF renders nothing.
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
 * STOP, only while a cell is in flight. Both legs render here, so the
 * confirmation appears where the button was pressed. The server's restatement
 * is shown verbatim.
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

/** Why the controls are dead, stated once at the top. */
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

  // Anything but anchor_verified is shown in the off-hue.
  const anchorHtml =
    anchor === null || anchor === undefined
      ? nul("anchor unobserved")
      : `<span class="${anchor === "anchor_verified" ? "bright" : "danger"}">${esc(anchor)}</span>`;

  const bit = (label, v) =>
    `${label} ${v === null || v === undefined ? nul("—") : esc(String(v))}`;

  // Attestation is plain label text, never a badge or tier.
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

/** Source health: an unwired source is a panel that stays null, not an error. */
function renderSourceHealth(board) {
  const s = board.sources ?? [];
  if (!s.length) return nul("no sources");
  const ok = s.filter((x) => x.ok).length;
  const down = s.filter((x) => !x.ok).map((x) => x.id);
  return `sources ${ok}/${s.length}${down.length ? ` · unwired: ${esc(down.join(", "))}` : ""}`;
}
