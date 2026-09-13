// ─────────────────────────────────────────────────────────────────────────────
// DEV MODE — the settings-drawer section that toggles the control plane's mode
//
// ── WHAT THIS GATES, AND WHY IT IS A MODE RATHER THAN A CHECKBOX ────────────
//
// Dev mode unlocks capabilities that help while ITERATING ON the benchmark and
// are wrong for MEASURING with it. The first is build-snapshot seeding: starting
// a cell from an already-built worktree instead of rebuilding the scaffolding,
// which turns a multi-hour build into nothing and produces a cell that is NOT a
// scorable floor.
//
// That last clause is why this is a mode and not a per-run checkbox. The
// capability is safe because a seeded cell can never become a floor; the mode
// exists so the capability cannot be reached by an operator who did not go
// looking for it.
//
// ── THE STATE IS THE SERVER'S, AND THIS PANEL ONLY RENDERS IT ───────────────
//
// Nothing here holds a local opinion of whether dev mode is on. The value comes
// from the board payload (`control.capabilities.dev_mode`, refreshed by every
// poll) and a toggle POSTs and then re-reads. A panel that optimistically
// flipped its own copy would show ON for a server that had refused.
//
// ── UNREACHABLE IS NOT OFF ──────────────────────────────────────────────────
//
// When the control plane does not answer, the board's whole `control` block is
// absent. This renders UNKNOWN, never OFF. Drawing a confident OFF for a service
// that did not reply is the same defect as reporting a stalled cell from
// silence — the answer to "no signal" is "no signal".
// ─────────────────────────────────────────────────────────────────────────────

import { esc } from "../board.js";
import { renderSwitch } from "./switches.js";

const ui = {
  busy: false,
  // The server's last word on a WRITE — a refusal, most importantly. Cleared on
  // the next successful toggle.
  result: null,
};

/**
 * Read dev-mode state out of the board payload.
 *
 * Returns `null` when the control plane is unreachable, which every caller must
 * treat as UNKNOWN rather than falsy-off.
 */
export function devModeState(board) {
  const caps = board?.control?.capabilities;
  if (!caps || typeof caps !== "object") return null;
  const dm = caps.dev_mode;
  if (!dm || typeof dm.enabled !== "boolean") return null;
  return dm;
}

/** True only when the server SAYS on. Unknown is not on. */
export function isDevModeOn(board) {
  return devModeState(board)?.enabled === true;
}

export function isDevModeBusy() {
  return ui.busy;
}

/**
 * Toggle the mode.
 *
 * Sends the value we want, not a flip of a local copy: the server owns the
 * current value, and a flip computed here would race the poll that refreshes it.
 */
export async function setDevMode(base, enabled) {
  ui.busy = true;
  ui.result = null;
  try {
    const res = await fetch(`${base}/api/devmode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: Boolean(enabled) }),
    });
    const data = await res.json().catch(() => null);
    ui.result =
      data ?? { ok: false, code: `HTTP ${res.status}`, reason: "the control plane returned nothing readable" };
  } catch (err) {
    ui.result = { ok: false, code: "unreachable", reason: String(err?.message ?? err) };
  } finally {
    ui.busy = false;
  }
}

// ── render ───────────────────────────────────────────────────────────────────

function sourceWord(source) {
  return (
    {
      environment: "pinned by the control plane's environment",
      environment_malformed: "the environment setting is unreadable",
      state_file: "stored on this machine",
      state_file_malformed: "the stored file is unreadable",
      default: "not configured — the default",
    }[source] ?? source
  );
}

export function renderDevModeSection(board) {
  const dm = devModeState(board);

  // UNKNOWN is its own switch position — never a styled OFF. See switches.js.
  if (dm === null) {
    return renderSwitch({
      name: "DEV MODE",
      desc: "Unlocks capabilities for iterating on the benchmark itself. Off is the correct state whenever you are measuring.",
      state: "unknown",
      attr: "data-devmode-set",
    });
  }

  return `${renderSwitch({
    name: "DEV MODE",
    desc: "Unlocks capabilities for iterating on the benchmark itself. Off is the correct state whenever you are measuring.",
    state: dm.enabled ? "on" : "off",
    attr: "data-devmode-set",
    disabled: !dm.settable || ui.busy,
    note: !dm.settable
      ? (dm.settable_reason ?? "this cannot be changed from the board")
      : dm.reason ?? null,
    warn: dm.enabled
      ? "While this is on, the board offers cells that are NOT scorable floors. A seeded cell skips the build phase and sits on a different turn and token scale than a floor — the bench refuses it as a baseline, deliberately. Turn this off when you go back to measuring."
      : null,
  })}
    <div class="sw-note">${esc(sourceWord(dm.source))}</div>
    ${
      ui.result && ui.result.ok === false
        ? `<div class="sw-note bad"><strong>${esc(ui.result.code ?? "refused")}</strong> — ${esc(ui.result.reason ?? "no reason given")}</div>`
        : ""
    }`;
}
