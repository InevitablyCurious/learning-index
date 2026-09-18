// ─────────────────────────────────────────────────────────────────────────────
// RESET — start a new benchmark tree
//
// ── WHAT THE BUTTON DOES, IN ONE LINE ───────────────────────────────────────
//
// Mints `runs/<unix-seconds>/` and points the harness at it. The previous tree
// stays on disk and stops being read. NOTHING IS DELETED, and the confirm card
// says so in those words — an operator who believes a button deletes their
// measurements will not press it, and an operator who believes it does not when
// it does has been misled about the worst possible thing.
//
// ── WHY IT IS ARM→CONFIRM AND NOT A window.confirm() ────────────────────────
//
// The same protocol the run control uses, for the same reason: the SERVER
// composes the restatement and mints a token bound to what is actually on disk.
// A browser-composed "are you sure?" confirms the operator's belief about the
// state, not the state. Here the token binds to the active tree AND to the
// campaign list, so a cell that lands between arming and confirming invalidates
// the token and the operator is re-shown what changed.
//
// ── THE ONE REFUSAL ─────────────────────────────────────────────────────────
//
// A cell in flight. Rolling forward mid-run would leave the harness writing into
// a tree nothing reads. The server refuses it; this panel renders that refusal
// rather than hiding the button, because a control that vanishes teaches an
// operator nothing about why.
// ─────────────────────────────────────────────────────────────────────────────

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

export function resetState() {
  return ui;
}

export function isResetOpen() {
  return ui.open === true;
}

/** Open the modal and immediately ask the server what a reset would move. */
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

export function clearResetRefusal() {
  ui.refusal = null;
}

export function clearResetResult() {
  ui.result = null;
}

/** ARM. The server validates and mints a token bound to the tree on disk. */
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

/** CONFIRM. Carries the token; any drift is rejected server-side. */
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

    // ── THE BOARD GOES BACK TO ZERO, AND A RE-POLL IS NOT ENOUGH ────────────
    //
    // Panels hold their own client state — an expanded ledger row, a pinned
    // curve metric, a cached event window, a selected baseline. After a reset
    // every one of those refers to something that no longer exists, and the
    // board would show a mix of fresh server data and stale local selections.
    // A full reload is the only way to guarantee what was asked for: the bench
    // reads as brand new, with nothing carried over.
    window.location.reload();
  } catch (err) {
    ui.refusal = { code: "unreachable", reason: String(err?.message ?? err) };
    ui.pending = false;
    disarmReset();
  }
}

/**
 * THE BUTTON — in the BASELINES header, immediately right of [+ BASELINE].
 *
 * It sits there rather than in the top bar because that header is where an
 * operator already goes to change what the bench holds: [+ BASELINE] adds, this
 * clears. RED, because unlike everything else on that row it acts on all of it.
 */
export function renderResetButton(board) {
  if (!board?.control) return "";
  return `<button class="btn sm blreset" data-reset-open="1" ${ui.pending ? "disabled" : ""}
    title="reset all benchmark data — everything is backed up first">${ui.pending ? "…" : "RESET"}</button>`;
}

/**
 * THE TREE CHIP — top bar, informational only.
 *
 * Names the tree the harness is writing into. A board that shows measurements
 * without saying which tree they came from cannot be told apart from one still
 * showing a tree that was retired an hour ago.
 */
export function renderTreeChip(board) {
  const tree = board?.tree ?? null;
  if (!tree) return "";
  const id = tree.active ?? null;
  const n = Array.isArray(tree.live_campaigns) ? tree.live_campaigns.length : 0;
  return `<span class="chip" title="the benchmark tree the harness is writing into">TREE ${
    id ? esc(id) : "—"
  }${n ? ` · ${n} result${n === 1 ? "" : "s"}` : " · empty"}</span>`;
}

/**
 * THE MODAL — one question, two answers.
 *
 * The question is asked in the operator's terms ("all benchmark data"), and the
 * SERVER's own list of what will move is shown underneath it. A confirmation
 * that describes the act in general terms lets an operator agree to something
 * they would have refused had it been named.
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
