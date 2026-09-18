// PAINTER: LIVE NUMBER MOTION — counters climb to their new reading and the
// delta rises off the row, so it's visible which number moved.
//
// It animates the display, never the value: `data-v` holds the server's number
// and every animation ends exactly on it; a faster tick re-aims rather than
// queueing. The element is data-preserve, so patch() keeps data-v current while
// this owns the text; without the painter the correct number still shows.
// Under prefers-reduced-motion values snap and the delta fades in place.

import { tok } from "../board.js";

/** How long a counter takes to travel to its new reading. */
const CLIMB_MS = 620;

/**
 * The formatter is named on the element (the headline rounds, the breakdown
 * prints every digit), so a counter can't disagree with its row.
 */
function format(el, n) {
  switch (el.dataset.fmt) {
    case "tok":
      return tok(Math.round(n)) ?? "—";
    case "pct":
      return `${n.toFixed(2)}%`;
    default:
      return Math.round(n).toLocaleString();
  }
}

/** Deltas are exact counts. */
function formatDelta(d) {
  return `+${Math.round(d).toLocaleString()}`;
}

function prefersReducedMotion() {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

/**
 * Bring every `.odo` to its data-v; called after each patch. A counter
 * already on its value does nothing.
 */
export function paintTicks(root) {
  const scope = root ?? document;
  const reduced = prefersReducedMotion();

  for (const el of scope.querySelectorAll(".odo")) {
    const to = Number(el.dataset.v);
    if (!Number.isFinite(to)) continue;

    // First sight is not a change: never animate from zero on load.
    if (!Number.isFinite(el._odoAt)) {
      el._odoAt = to;
      el.textContent = format(el, to);
      continue;
    }

    const from = el._odoAt;
    if (from === to) continue;
    el._odoAt = to;

    // Only growth floats a delta; a drop is a reset or a new cell, not a spend.
    if (to > from && el.dataset.float === "on") floater(el, to - from, reduced);

    // A hidden tab snaps: requestAnimationFrame doesn't run there, so a climb
    // would freeze on a partial number the board never measured.
    if (reduced || isHidden()) {
      el.textContent = format(el, to);
      continue;
    }
    climb(el, from, to);
  }
}

function isHidden() {
  try {
    return document.visibilityState === "hidden";
  } catch {
    return false;
  }
}

/** Back from a hidden tab: land every counter on its published value now. */
export function snapTicks(root) {
  for (const el of (root ?? document).querySelectorAll(".odo")) {
    const to = Number(el.dataset.v);
    if (!Number.isFinite(to)) continue;
    cancelAnimationFrame(el._odoRaf ?? 0);
    el._odoRaf = 0;
    el._odoAt = to;
    el.textContent = format(el, to);
  }
}

/** Interpolate with ease-out, so the final digits are readable. */
function climb(el, from, to) {
  cancelAnimationFrame(el._odoRaf ?? 0);
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / CLIMB_MS);
    const eased = 1 - (1 - p) ** 3;
    el.textContent = format(el, from + (to - from) * eased);
    if (p < 1) {
      el._odoRaf = requestAnimationFrame(step);
      return;
    }
    // Always land on the exact value.
    el.textContent = format(el, to);
    el._odoRaf = 0;
  };
  el._odoRaf = requestAnimationFrame(step);
}

/**
 * The rising delta, parented to the row (not clipped by the number's box) and
 * removed on animationend.
 */
function floater(el, delta, reduced) {
  const host = el.closest(".tkrow, .big, .ph, .odo-host") ?? el.parentElement;
  if (!host) return;
  const chip = document.createElement("span");
  chip.className = `odo-float${reduced ? " still" : ""}`;
  chip.textContent = formatDelta(delta);
  chip.addEventListener("animationend", () => chip.remove(), { once: true });
  host.appendChild(chip);
  // Fallback cleanup where animationend never fires.
  setTimeout(() => chip.remove(), 4000);
}

/**
 * Markup helper for the `.odo` contract: the value is rendered as text and
 * data-v, so the row is right before the painter runs.
 */
export function odo(value, { fmt = "exact", float = false, cls = "" } = {}) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const shown =
    fmt === "tok" ? (tok(value) ?? "—") : fmt === "pct" ? `${value.toFixed(2)}%` : value.toLocaleString();
  return (
    `<span class="odo ${cls}" data-preserve="1" data-v="${String(value)}"`
    + ` data-fmt="${fmt}"${float ? ` data-float="on"` : ""}>${shown}</span>`
  );
}
