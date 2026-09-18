// SWITCHES — the drawer's MODES block. A switch shows a state by its position.
// The two look alike but have different owners:
//   DEV MODE       server state (control.capabilities.dev_mode): rendered and
//                  POSTed, never copied locally.
//   REQUIRE TODOS  a launch preference of this browser, sent with the next
//                  launch: localStorage.
// localStorage can throw on access (private windows, blocked storage); every read
// and write is wrapped and falls back to the default.

import { esc } from "../board.js";

const REQUIRE_TODOS_KEY = "okp.bench.requireTodos";

/**
 * Require-todos, default OFF: it changes what the agent does (a measurement
 * variable), so a change needs a fresh OFF floor.
 */
export function requireTodosOn() {
  try {
    return window.localStorage.getItem(REQUIRE_TODOS_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persist the preference. Silent no-op when storage is unavailable. */
export function setRequireTodos(on) {
  try {
    window.localStorage.setItem(REQUIRE_TODOS_KEY, on ? "1" : "0");
  } catch {
    /* Storage blocked: the choice just won't stick. */
  }
}

const GRADER_WORKER_TARGET_KEY = "okp.bench.graderWorkerTarget";

/** The default, also the container's fallback when nothing is sent. */
export const GRADER_TARGET_DEFAULT = 0.7;

/** Coarse on purpose: a dial, not a tuning surface. */
export const GRADER_TARGET_CHOICES = [0.25, 0.5, 0.7, 0.9, 1];

/**
 * How much of the grading machine to use, default 70%. Unlike require-todos this
 * is not a measurement variable: it changes how many grading workers start, never
 * the verdicts (scripts/verify_worker_parity.py checks this). A share of what is
 * free at grading time.
 */
export function graderWorkerTarget() {
  try {
    const raw = Number(window.localStorage.getItem(GRADER_WORKER_TARGET_KEY));
    if (Number.isFinite(raw) && raw > 0 && raw <= 1) return raw;
  } catch {
    /* Storage blocked: use the default. */
  }
  return GRADER_TARGET_DEFAULT;
}

/** Persist it. Silent no-op when storage is unavailable. */
export function setGraderWorkerTarget(fraction) {
  const n = Number(fraction);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return;
  try {
    window.localStorage.setItem(GRADER_WORKER_TARGET_KEY, String(n));
  } catch {
    /* Storage blocked: the choice just won't stick. */
  }
}

// ── debounce ── a switch gets double-tapped; repeat activations of the same
// control inside the window are swallowed (for dev mode a second POST would race
// the refreshing poll).

const lastFired = new Map();
export const SWITCH_DEBOUNCE_MS = 350;

export function debounced(key, ms = SWITCH_DEBOUNCE_MS) {
  const now = Date.now();
  const prev = lastFired.get(key) ?? 0;
  if (now - prev < ms) return true;
  lastFired.set(key, now);
  return false;
}

/** Test seam — the clock is not resettable otherwise. */
export function resetDebounce() {
  lastFired.clear();
}

// ── render ──

/**
 * One switch row: state is "on" | "off" | "unknown". Unknown (no answer from
 * the control plane) is never drawn as off.
 */
export function renderSwitch({ name, desc, state, attr, disabled = false, note = null, warn = null }) {
  const unknown = state === "unknown";
  const on = state === "on";
  const off = !on && !unknown;
  return `
    <div class="sw-row" data-state="${unknown ? "unknown" : on ? "on" : "off"}">
      <div class="sw-text">
        <span class="sw-name">${esc(name)}</span>
        <span class="sw-desc">${esc(desc)}</span>
      </div>
      <button class="sw${on ? " on" : ""}${unknown ? " unknown" : ""}"
              role="switch"
              aria-checked="${unknown ? "mixed" : String(on)}"
              aria-label="${esc(name)}"
              ${attr}="${on ? "off" : "on"}"
              ${disabled || unknown ? "disabled" : ""}>
        <span class="sw-track"><span class="sw-knob"></span></span>
      </button>
    </div>
    ${unknown ? `<div class="sw-note bad">${esc("no answer from the control plane — this is not OFF, it is no answer")}</div>` : ""}
    ${note ? `<div class="sw-note bad">${esc(note)}</div>` : ""}
    ${warn ? `<div class="sw-warn" role="note">${esc(warn)}</div>` : ""}`;
  void off;
}
