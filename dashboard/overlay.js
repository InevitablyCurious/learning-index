// OVERLAY — dialogs mounted outside #root, patched in place, so focus, typed
// text and scroll survive the board's refresh. One at a time, in a deliberate
// order.
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

  // Reset outranks everything (it acts on what every other dialog is about).
  if (isResetOpen()) {
    patch(root, renderResetModal(board));
    return;
  }

  // Restore ranks with reset, for the same reason.
  if (isRestoreOpen()) {
    patch(root, renderRestoreModal(board));
    return;
  }

  if (isCreateOpen()) {
    patch(root, renderCreate(board));
    return;
  }

  // The tools drawer ranks below every dialog: it holds no decision.
  if (isToolsOpen()) {
    patch(root, renderToolsDrawer(board));
    // After the patch, so a row the drawer was pointed at exists to scroll to.
    settleToolsFocus();
    return;
  }


  // No run-control modal: BASELINE · 3 is the confirmation and BASELINE · 4 the
  // launch (panels/create.js).

  patch(root, "");
}

