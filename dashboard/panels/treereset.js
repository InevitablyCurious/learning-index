// RESET — move all benchmark data into runs/backups/<unix-seconds>/ and start a
// new tree. Nothing is deleted, and the confirmation says so. Preview then
// confirm: the server writes the restatement and mints a token bound to what is
// on disk, so anything that changes in between invalidates it. A cell in
// flight is stopped first, and the confirmation says so.

import { esc } from "../board.js";

const ui = {
  open: false,
  armed: false,
  token: null,
  restatement: null,
  moves: [],
  pending: false,
  refusal: null,
  result: null,
};

export function isResetOpen() {
  return ui.open === true;
}

/** Open the modal and ask the server what a reset would move. */
export function openReset() {
  ui.open = true;
  ui.refusal = null;
  ui.result = null;
  disarmReset();
}

export function closeReset() {
  ui.open = false;
  ui.refusal = null;
  disarmReset();
}

export function disarmReset() {
  ui.armed = false;
  ui.token = null;
  ui.restatement = null;
  ui.moves = [];
}

/** Arm: the server validates and mints a token. */
export async function armReset() {
  ui.pending = true;
  ui.refusal = null;
  ui.result = null;
  try {
    const res = await fetch(`/api/tree/reset/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.ok === false) {
      ui.refusal = { code: data?.code ?? `HTTP ${res.status}`, reason: data?.reason ?? "reset refused" };
      disarmReset();
    } else {
      ui.armed = true;
      ui.token = data?.token ?? null;
      ui.restatement = data?.restatement ?? null;
      ui.moves = Array.isArray(data?.moves) ? data.moves : [];
    }
  } catch (err) {
    ui.refusal = { code: "unreachable", reason: String(err?.message ?? err) };
    disarmReset();
  } finally {
    ui.pending = false;
  }
}

/** Confirm with the token; any drift is rejected server-side. */
export async function commitReset() {
  if (!ui.token) {
    disarmReset();
    return;
  }
  ui.pending = true;
  try {
    const res = await fetch(`/api/tree/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: ui.token }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.ok === false) {
      ui.refusal = { code: data?.code ?? `HTTP ${res.status}`, reason: data?.reason ?? "reset refused" };
      ui.pending = false;
      disarmReset();
      return;
    }

    // A full reload: every panel's local selections refer to data that no longer
    // exists.
    window.location.reload();
  } catch (err) {
    ui.refusal = { code: "unreachable", reason: String(err?.message ?? err) };
    ui.pending = false;
    disarmReset();
  }
}

/**
 * The RESET button, beside [+ BASELINE]: that header is where the bench's
 * contents change. Red, because it acts on all of it.
 */
export function renderResetButton(board) {
  if (!board?.control) return "";
  return `<button class="btn sm blreset" data-reset-open="1" ${ui.pending ? "disabled" : ""}
    title="reset all benchmark data — everything is backed up first">${ui.pending ? "…" : "RESET"}</button>`;
}

/**
 * The modal: the question in the operator's terms, and the server's own list
 * of what will move underneath.
 */
export function renderResetModal(board) {
  if (!ui.open) return "";

  const body = ui.refusal
    ? `<div class="rm-refusal"><span class="rm-code">${esc(ui.refusal.code ?? "")}</span>${esc(
        ui.refusal.reason,
      )}</div>`
    : ui.restatement
      ? `<pre class="rm-list">${esc(ui.restatement)}</pre>`
      : `<div class="rm-wait">checking what is on the bench…</div>`;

  const canContinue = Boolean(ui.token) && !ui.pending && !ui.refusal;

  return `
    <div class="modal-scrim" data-reset-scrim="1">
      <div class="modal rmodal" role="dialog" aria-modal="true" aria-label="Reset all benchmark data">
        <div class="rm-head">RESET</div>
        <div class="rm-q">Are you sure you want to reset all benchmark data?</div>
        <div class="rm-sub">Data will be saved as backup.</div>
        ${body}
        <div class="rm-foot">
          <button class="btn sm" data-reset-cancel="1">‹ back</button>
          <button class="btn sm blreset" data-reset-confirm="1" ${canContinue ? "" : "disabled"}>${
            ui.pending ? "…" : "continue"
          }</button>
        </div>
      </div>
    </div>`;
}
