// ─────────────────────────────────────────────────────────────────────────────
// OVERLAY — dialogs that live OUTSIDE #root
//
// `render()` replaces the whole of #root.innerHTML every 2s. That is correct
// for a read-only board and fatal for an interactive dialog: a wholesale swap
// destroys select focus, a half-typed org id, and a scroll position. So modals
// mount here, as a sibling of #root, and survive the poll.
//
// ONE AT A TIME, AND THE ORDER IS DELIBERATE — the dialog that spends hours
// outranks the one that writes a file, and stacking two scrims would leave the
// operator unsure which dialog a click belongs to.
//
import { renderCreate, isCreateOpen, closeCreate } from "./panels/create.js";
import { renderResetModal, isResetOpen } from "./panels/treereset.js";
import { renderRestoreModal, isRestoreOpen } from "./panels/restore.js";
import { renderToolsDrawer, isToolsOpen, settleToolsFocus } from "./panels/tools.js";
import { patch } from "./dom.js";

export function renderOverlay(board) {
  let root = document.getElementById("overlay-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "overlay-root";
    document.body.appendChild(root);
  }

  // ── THE CREATE FLOW SITS ABOVE THE BOARD, BELOW THE RUN CONTROL ───────────
  //
  // PATCHED, NOT REPLACED. Mounting outside #root saved the dialog from the
  // board's swap, but this function then did the same thing to it: `innerHTML`
  // every 2s rebuilt the dialog, so a scrolled model list snapped back to the
  // top and a half-typed search box lost its caret. Surviving one wholesale
  // swap only to be destroyed by another is not survival. See dom.js.
  //
  // IT IS CHECKED BEFORE THE RUN CONTROL AND THAT ORDER IS LOAD-BEARING IN ONE
  // DIRECTION ONLY: the baseline branch CLOSES this flow before arming, so the
  // two are never open together. If a future path left both open, the run
  // control — the one that spends hours — is the one that must be on top, which
  // is why its check follows rather than precedes.
  // ── THE RESET QUESTION OUTRANKS EVERYTHING ───────────────────────────────
  //
  // Checked FIRST because it is the only overlay that acts on all the others'
  // subject matter. If a reset question and any other dialog were ever open at
  // once, the one an operator must answer deliberately is the one that has to be
  // on top — an obscured destructive confirmation is how a stray click becomes a
  // decision.
  if (isResetOpen()) {
    patch(root, renderResetModal(board));
    return;
  }

  // Restore ranks with reset and above the rest for the same reason: it replaces
  // everything the other dialogs are about.
  if (isRestoreOpen()) {
    patch(root, renderRestoreModal(board));
    return;
  }

  if (isCreateOpen()) {
    patch(root, renderCreate(board));
    return;
  }

  // ── THE DRAWER RANKS BELOW EVERY DIALOG ──────────────────────────────────
  //
  // It is a place to look, not a question to answer. If a dialog and the drawer
  // were ever open together the dialog is the one that must be on top, because
  // it is the one holding a decision — the inverse of the reset/restore rule
  // above, and for the same reason.
  if (isToolsOpen()) {
    patch(root, renderToolsDrawer(board));
    // AFTER the patch, never before: when the drawer was opened from a preflight
    // refusal it is pointed at one tool, and that row cannot be scrolled to
    // until it exists. Idempotent — it scrolls once per open.
    settleToolsFocus();
    return;
  }


  // ── THERE IS NO RUN-CONTROL MODAL ────────────────────────────────────────
  //
  // A second dialog used to open after the baseline sequence, asking the same
  // question a third time: it re-stated the model and arm the operator had just
  // chosen, and took a CONFIRM click. Two dialogs that both mean "confirm this
  // run" is one too many — the operator learns to click through whichever one
  // they see more often, which is exactly the reflex a destructive confirmation
  // must not build.
  //
  // BASELINE · 3 is now the confirmation and BASELINE · 4 is the launch. The
  // server's validation is unchanged: preview still mints the token that start
  // must carry, and a refusal lands as a red row on frame 4 in the server's own
  // words (panels/create.js: launchBaseline).

  patch(root, "");
}

export function closeOverlays() {
  closeCreate();
}
