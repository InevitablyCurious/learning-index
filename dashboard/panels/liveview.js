// PANEL: LIVE VIEW — the running cell's terminal, always on screen.
//
// The card is the TUI mirror and nothing else. There is no tab to select: the
// board subscribes to terminal frames from the moment it loads, keyed to the
// cell it is drawing (board.js follows the live cell), so a run that starts
// shows up here by itself.

import { renderTuiBody } from "./tui.js";

export function renderLiveView(board) {
  return `
    <section class="panel curve">
      <div class="phead">
        <span class="ttl">LIVE VIEW</span>
        <span class="sub"></span>
      </div>
      ${renderTuiBody(board)}
    </section>`;
}
