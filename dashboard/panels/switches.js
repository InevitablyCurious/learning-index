// ─────────────────────────────────────────────────────────────────────────────
// SWITCHES — the drawer's MODES block
//
// ── WHY A SWITCH AND NOT A BUTTON ───────────────────────────────────────────
//
// A button says "do this". A switch says "this is how things are". The two
// controls at the top of the drawer are STATES the board is in, not actions the
// operator fires, and they were being drawn as buttons whose label had to spell
// out the state ("DEV MODE: ON") because the shape carried none of it. A switch
// carries the state in its position, which is why it reads at a glance.
//
// ── TWO SWITCHES, TWO DIFFERENT OWNERS — AND THIS MATTERS ───────────────────
//
// They look identical and they are NOT the same kind of thing:
//
//   DEV MODE       SERVER state. Lives in `control.capabilities.dev_mode`,
//                  refreshed by every poll. This surface renders it and POSTs
//                  to change it — it never keeps a copy. A panel that
//                  optimistically flipped a local value would show ON for a
//                  server that had refused.
//
//   REQUIRE TODOS  A LAUNCH PREFERENCE belonging to this browser. It is not
//                  server state at all: it rides the launch payload for the
//                  NEXT cell, so remembering the operator's last answer is
//                  exactly right, and localStorage is the correct home.
//
// So only one of them persists locally. Doing it to both would give dev mode a
// second source of truth, which is the defect its own panel warns about.
//
// ── STORAGE CAN THROW, AND ABSENCE IS NOT FALSE ─────────────────────────────
//
// Private windows, cleared site data, and browsers set to block storage all
// make localStorage throw on ACCESS, not just return null. Every read and write
// is wrapped, and a failure degrades to the default (off) rather than breaking
// the drawer. A value that cannot be stored is a preference that does not
// persist — never a broken board.
// ─────────────────────────────────────────────────────────────────────────────

import { esc } from "../board.js";

const REQUIRE_TODOS_KEY = "okp.bench.requireTodos";

/**
 * Read the require-todos preference. Default OFF.
 *
 * OFF is the honest default because turning it on CHANGES WHAT THE AGENT DOES —
 * it is a measurement variable, not a convenience. A run with it on and a run
 * with it off are not measuring the same thing, and the OFF floor has to be
 * re-established after a change.
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
    /* storage blocked — the session keeps working, the choice just will not stick */
  }
}

const GRADER_WORKER_TARGET_KEY = "okp.bench.graderWorkerTarget";

/** The default, and the one the container falls back to when nothing is sent. */
export const GRADER_TARGET_DEFAULT = 0.7;

/** Fractions offered. Coarse on purpose — this is a dial, not a tuning surface. */
export const GRADER_TARGET_CHOICES = [0.25, 0.5, 0.7, 0.9, 1];

/**
 * Read how much of the grading machine to use. Default 70%.
 *
 * ── NOT THE SAME CLASS AS THE SWITCHES ABOVE ────────────────────────────────
 *
 * `REQUIRE TODOS` and `RECORD AT CHUNK END` change WHAT THE AGENT DOES, so they
 * are measurement variables and a run with each setting is not comparable with
 * the other. This is not: it changes only how many test workers the GRADING
 * container starts, after the model is finished. The gates it runs and the
 * verdicts they produce are identical.
 *
 * That claim is not taken on trust — `scripts/verify_worker_parity.py` grades
 * the golden at one worker and at the maximum and requires them to agree gate
 * for gate. If they ever disagree, this stops being a preference and becomes a
 * defect.
 *
 * The fraction is of what is FREE at grading time, not of what the machine has:
 * the operator may already have containers running, and sizing against the
 * total would start browsers into memory that is already spoken for.
 */
export function graderWorkerTarget() {
  try {
    const raw = Number(window.localStorage.getItem(GRADER_WORKER_TARGET_KEY));
    if (Number.isFinite(raw) && raw > 0 && raw <= 1) return raw;
  } catch {
    /* storage blocked — fall through to the default */
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
    /* storage blocked — the session works, the choice does not stick */
  }
}

// ── debounce ────────────────────────────────────────────────────────────────
//
// A switch is a thing people double-tap. Without a guard that is two POSTs, and
// for dev mode the second races the poll that refreshes the first. `guard`
// swallows repeat activations of the SAME control inside the window; different
// controls never block each other.

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

// ── render ──────────────────────────────────────────────────────────────────

/**
 * One switch row.
 *
 * `state` is "on" | "off" | "unknown". UNKNOWN is a first-class position: a
 * control plane that did not answer must not be drawn as OFF, exactly as the
 * dev-mode panel has always insisted.
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
