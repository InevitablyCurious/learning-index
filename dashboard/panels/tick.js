// ─────────────────────────────────────────────────────────────────────────────
// PAINTER: LIVE NUMBER MOTION — climbing counters and spend floaters
//
// A running cell moves four or five numbers every couple of seconds, and until
// now every one of them just swapped from one string to another. Nothing said
// WHICH number moved, by HOW MUCH, or that anything had happened at all — an
// operator watching the board could not tell a live cell from a stalled one
// without reading the clock. This makes the change itself legible: the value
// climbs to its new reading, and the delta rises off the row and fades.
//
// ── IT ANIMATES THE READING, NEVER THE MEASUREMENT ──────────────────────────
// The number in the DOM is always the server's number. This only controls how
// the display TRAVELS to it: `data-v` carries the authoritative value, the text
// is interpolated toward it, and every animation ends exactly on `data-v`. A
// counter that eased toward a value it then rounded, or that kept its own
// running total, would be a second source of truth for a measurement — which is
// the one thing this board does not permit. Interrupting an animation mid-flight
// (a faster tick) snaps the arithmetic to the newest value and re-aims; it never
// queues, so the display cannot fall behind the truth.
//
// ── WHY `data-preserve` ─────────────────────────────────────────────────────
// dom.js syncs attributes and then leaves a preserved subtree's children alone.
// That is exactly the split needed here: `patch()` keeps `data-v` current on
// every board tick while this painter owns the text node. Without it the morpher
// would overwrite the interpolated text ~5 times a second and no animation could
// survive a single frame.
//
// The element still renders its final value as ordinary text, so a board with
// this painter broken or absent shows the correct number, unanimated. Motion is
// an enhancement; the reading is not.
//
// ── REDUCED MOTION IS HONOURED, AND STILL TELLS YOU ─────────────────────────
// Under `prefers-reduced-motion` nothing travels: values snap and the delta
// appears in place and fades. The information is the delta, not the movement, so
// it is not withheld from someone who cannot watch things fly.
// ─────────────────────────────────────────────────────────────────────────────

import { tok } from "../board.js";

/** How long a counter takes to travel to its new reading. */
const CLIMB_MS = 620;

/**
 * Format a raw number the way its row wants it.
 *
 * The formatter is named on the element rather than inferred, because the same
 * value is shown two ways on this board — the headline rounds to `1.5M`, the
 * breakdown prints every digit — and a counter that picked its own format could
 * disagree with the row above it.
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

/** Deltas are always shown as exact counts — a rounded `+0.1M` says nothing. */
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
 * Bring every `.odo` on the board to its current `data-v`.
 *
 * Called after each patch, alongside the other out-of-band painters. Cheap on
 * the common path: an element already sitting on its value does nothing at all.
 */
export function paintTicks(root) {
  const scope = root ?? document;
  const reduced = prefersReducedMotion();

  for (const el of scope.querySelectorAll(".odo")) {
    const to = Number(el.dataset.v);
    if (!Number.isFinite(to)) continue;

    // FIRST SIGHT IS NOT A CHANGE. A counter that animated from zero on the
    // first paint would show a spend that never happened — and would do it
    // again on every reload, which is how a board teaches people to distrust it.
    if (!Number.isFinite(el._odoAt)) {
      el._odoAt = to;
      el.textContent = format(el, to);
      continue;
    }

    const from = el._odoAt;
    if (from === to) continue;
    el._odoAt = to;

    // Only growth is a spend. A total that fell is a new cell, a reset or a
    // correction — none of which is "+N spent", so none of them float.
    if (to > from && el.dataset.float === "on") floater(el, to - from, reduced);

    // ── A HIDDEN TAB SNAPS. THIS IS A CORRECTNESS RULE, NOT AN OPTIMISATION ──
    //
    // `requestAnimationFrame` does not fire in a background tab, but the board's
    // stream does — so a value arriving while hidden would start a climb that
    // never runs a frame, and the element would sit on whatever partial figure
    // the last visible frame had painted. The number on screen would be one this
    // board never measured, and nothing about it would look wrong.
    //
    // Snapping costs an animation nobody is watching and removes the only path
    // by which this painter could display a fabricated reading.
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

/**
 * Coming back from a hidden tab, land every counter on its published value.
 *
 * Belt to the brace above: any climb that was in flight when the tab went away
 * had its frames cancelled by the browser, and this is what guarantees the board
 * is showing `data-v` and not the frame it stopped on — without waiting for the
 * next tick, which for an idle bench may be a long way off.
 */
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

/**
 * Interpolate the displayed value.
 *
 * Ease-out: the jump is most legible at the start, and settling slowly onto the
 * final digits is what makes the number readable rather than a blur.
 */
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
    // ALWAYS LAND ON THE EXACT VALUE, never on the last interpolated one.
    el.textContent = format(el, to);
    el._odoRaf = 0;
  };
  el._odoRaf = requestAnimationFrame(step);
}

/**
 * The rising delta.
 *
 * Parented to the row rather than the value so it cannot be clipped by the
 * number's own box, and removed on `animationend` so a long run does not
 * accumulate thousands of dead nodes. If several land at once they stack
 * naturally — each is its own element with its own lifetime.
 */
function floater(el, delta, reduced) {
  const host = el.closest(".tkrow, .big, .ph, .odo-host") ?? el.parentElement;
  if (!host) return;
  const chip = document.createElement("span");
  chip.className = `odo-float${reduced ? " still" : ""}`;
  chip.textContent = formatDelta(delta);
  chip.addEventListener("animationend", () => chip.remove(), { once: true });
  host.appendChild(chip);
  // A browser that reports no animation (a hidden tab, a stripped stylesheet)
  // never fires `animationend`, so nothing would ever clean these up.
  setTimeout(() => chip.remove(), 4000);
}

/**
 * Markup helper — the one place the `.odo` contract is written down.
 *
 * `value` is the authoritative number and is rendered as text as well as
 * `data-v`, so the row is correct before this painter has ever run.
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
