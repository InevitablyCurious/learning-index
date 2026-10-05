// FIT — one screen: the runs strip, the transfer-curve + live-build row and the
// gate wall sit inside the window with no scroll. Reads layout, writes only
// sizes (custom properties on the row), so it is safe to call after every patch;
// patch() drops the inline sizes each tick and this puts them straight back in
// the same task, before anything paints.
//
// The row's height is what the screen leaves after everything above and below it.
// The TUI card's width follows from that height (130 columns × 40 rows, so the
// terminal fills the card both ways); live build splits whatever width is left.

import { tuiHostWidthForHeight } from "./tui.js";
import { fitBuild } from "./build.js";

const NARROW = 1100; // matches the stylesheet's single-column step
const ROW_MIN = 320;
const ROW_MAX = 480;
const BOTTOM_PAD = 8;

export function fitTopRow() {
  const row = document.querySelector(".axes-row");
  if (!row) return;
  const wall = document.querySelector(".panel.wall");
  if (window.innerWidth < NARROW || !wall) {
    row.style.removeProperty("--rowh");
    row.style.removeProperty("--axes-cols");
    fitBuild();
    return;
  }

  // Height: the screen minus everything above the row and below it up to the wall.
  const rowBox = row.getBoundingClientRect();
  const wallBox = wall.getBoundingClientRect();
  const other = wallBox.bottom - rowBox.top - rowBox.height; // gap + wall; independent of the row's height
  const top = rowBox.top + window.scrollY; // everything above the row
  const budget = window.innerHeight - top - other - BOTTOM_PAD;
  const rowH = Math.round(Math.max(ROW_MIN, Math.min(ROW_MAX, budget)));
  row.style.setProperty("--rowh", `${rowH}px`);

  // Width: on the TUI tab the card is as wide as its height needs.
  const curve = row.querySelector(".curve");
  const screen = curve?.querySelector(".tui-screen");
  if (screen) {
    const cs = getComputedStyle(screen);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const hostH = screen.clientHeight - padY;
    const hostW = tuiHostWidthForHeight(hostH);
    if (hostW) {
      const chrome = curve.offsetWidth - (screen.clientWidth - padX);
      const cardW = Math.min(Math.round(rowBox.width * 0.6), hostW + chrome);
      row.style.setProperty("--axes-cols", `${cardW}px minmax(0,1fr)`);
    }
  } else {
    row.style.removeProperty("--axes-cols");
  }
  fitBuild();
}
