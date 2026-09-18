// DEV MODE — the drawer section that toggles the control plane's mode. It
// unlocks snapshot seeding (never a scorable floor); a mode, not a per-run
// checkbox, so it can't be reached by accident. The state is the server's
// (control.capabilities.dev_mode): a toggle POSTs and re-reads. Unreachable
// renders UNKNOWN, never OFF.

import { esc } from "../board.js";
import { renderSwitch } from "./switches.js";

const ui = {
  busy: false,
  // The server's last answer to a write (a refusal, mostly).
  result: null,
};

/** Dev mode from the board payload; null when unreachable (unknown, not off). */
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

/** Send the wanted value, not a local flip (which would race the poll). */
export async function setDevMode(enabled) {
  ui.busy = true;
  ui.result = null;
  try {
    const res = await fetch(`/api/devmode`, {
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

// ── render ──

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

  // Unknown is its own switch position (see switches.js).
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
