import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// [F35]–[F38] REQ-LAYOUT — the page the build prompt asks for (chunk-04,
// Jerry 2026-09-25): "The board should be on the left and fill the screen,
// with all the roll, double and other buttons and game info on the right —
// about 80% of the width for the board and 20% for the buttons. That's on an
// ordinary laptop screen, 1280×800 or 1440×900, with nothing to scroll."
//
// Measured on a fresh game at both sizes. "The board" is what is DRAWN — the
// span of the points, the bar and the off tray — never the element that holds
// it: a board keeping its shape inside a wider box leaves margins the player
// sees as empty space (the reference's box is 86% of a 1920px window while
// its drawn board is 76%). The reference measures 76%/79% of the width and
// 88%/89% of the height at the two sizes; the bands below leave it room.

const SIZES = [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
];
// What the prompt puts on the right. The scores may sit anywhere (the
// reference shows them in its top bar), and the dice are drawn where the page
// chooses — the same chunk says "visible on the board".
const RIGHT_SIDE = [
  "rollBtn", "doubleBtn", "undoBtn", "endTurnBtn", "cube", "pipWhite", "pipBlack",
  "turnIndicator", "message", "difficulty", "newGameBtn",
];
const BUTTONS = ["rollBtn", "doubleBtn", "undoBtn", "endTurnBtn", "newGameBtn", "difficulty"];
// The marker naming each item on the right, whose line names it when it isn't
// showing (Jerry, 2026-09-26: "name buttons"). Written out in full so the
// source scan finds each one's lines (tests/test_player_stages.py).
const ASPECT_OF: Record<string, string> = {
  rollBtn: "[aspect: roll]",
  doubleBtn: "[aspect: double]",
  undoBtn: "[aspect: undo]",
  endTurnBtn: "[aspect: endturn]",
  newGameBtn: "[aspect: newgame]",
  difficulty: "[aspect: difficulty]",
  cube: "[aspect: cube]",
  pipWhite: "[aspect: pipwhite]",
  pipBlack: "[aspect: pipblack]",
  turnIndicator: "[aspect: turn]",
  message: "[aspect: message]",
};
// The name each button's label carries (the build prompt, chunk-04: "the
// buttons read Roll, Double, Undo, End Turn and New Game").
const BUTTON_NAMES: Record<string, string> = {
  rollBtn: "roll",
  doubleBtn: "double",
  undoBtn: "undo",
  endTurnBtn: "end turn",
  newGameBtn: "new game",
};
const BOARD_SHARE = { min: 0.7, max: 0.88 };
const BOARD_HEIGHT_MIN = 0.7;
const BUTTON_MIN = { w: 60, h: 24 };

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Control extends Box {
  shown: boolean;
  clipped: boolean;
  tag: string;
  // Nothing in it to show: no text and nothing drawn inside. An empty message
  // box on a fresh game is not information hidden from the player (run
  // 1790401782: an empty `message`, 0 px wide, told as "game info I need
  // aren't showing").
  empty: boolean;
}
interface Layout {
  size: string;
  vw: number;
  vh: number;
  scrollW: number;
  scrollH: number;
  boardScrollsSideways: boolean;
  trayDrawn: boolean;
  trayClearOfPoints: boolean;
  drawn: Box | null;
  controls: Record<string, Control | null>;
}

async function openAt(page: Page, size: { width: number; height: number }): Promise<Layout> {
  await page.setViewportSize(size);
  await page.goto("/");
  // A page that never shows its board is the load check's complaint, told
  // there (a needs marker, harness/adapters/challenge/stages.py).
  await expect(page.locator('[data-testid="board"]'), "[needs: F01]").toBeVisible();
  await page.request.post("/api/new", { data: {} });
  await page.reload();
  await expect(page.locator('[data-testid="board"]'), "[needs: F01]").toBeVisible();
  return page.evaluate(
    ({ ids, buttons }) => {
      // The off tray is part of the drawn board only while it sits on the
      // board: a tray standing outside the board's frame is the tray check's
      // complaint (F32 offboard), and counting it stretched "the board" over
      // the button panel — told as a board not on the left and buttons on top
      // of it, neither of which the player saw (run 1790359593).
      const frame = document.querySelector<HTMLElement>('[data-testid="board"]')?.getBoundingClientRect();
      const onFrame = (r: DOMRect) =>
        !!frame &&
        r.left >= frame.left - 2 &&
        r.top >= frame.top - 2 &&
        r.right <= frame.right + 2 &&
        r.bottom <= frame.bottom + 2;
      const drawnEls = [
        ...document.querySelectorAll<HTMLElement>('[data-testid="point"],[data-testid="bar"]'),
        ...[...document.querySelectorAll<HTMLElement>('[data-testid="off-tray"]')].filter((el) =>
          onFrame(el.getBoundingClientRect()),
        ),
      ]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0);
      const drawn = drawnEls.length
        ? (() => {
            const x0 = Math.min(...drawnEls.map((r) => r.left));
            const x1 = Math.max(...drawnEls.map((r) => r.right));
            const y0 = Math.min(...drawnEls.map((r) => r.top));
            const y1 = Math.max(...drawnEls.map((r) => r.bottom));
            return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
          })()
        : null;
      const controls: Record<string, unknown> = {};
      // What is drawn on top at a control decides whether a player sees it: a
      // control the board is drawn over is not showing, however its own style
      // reads (run 1790439223's difficulty and New Game sat under the board's
      // points; its difficulty check was told "nothing actually changes"). The
      // controls are made hit-testable for the reading — a page may let clicks
      // pass through its info boxes — and put back after it.
      const probe = document.createElement("style");
      probe.textContent = ids
        .map((id) => `[data-testid="${id}"], [data-testid="${id}"] * { pointer-events: auto !important; }`)
        .join("\n");
      document.head.appendChild(probe);
      const onTop = (el: HTMLElement, r: DOMRect) => {
        for (const fy of [0.5, 0.25, 0.75]) {
          for (const fx of [0.5, 0.25, 0.75]) {
            const x = r.left + r.width * fx;
            const y = r.top + r.height * fy;
            if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
            const hit = document.elementFromPoint(x, y);
            if (hit && (hit === el || el.contains(hit))) return true;
          }
        }
        return false;
      };
      for (const id of ids) {
        const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
        if (!el) {
          controls[id] = null;
          continue;
        }
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const shown =
          r.width > 0 &&
          r.height > 0 &&
          cs.visibility !== "hidden" &&
          cs.display !== "none" &&
          Number(cs.opacity) > 0.05 &&
          (onTop(el, r) || !(r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight));
        // A squished button cuts its own label off; a <select> reports its
        // option list, not its face, so only buttons are read for this.
        const clipped =
          buttons.includes(id) && el.tagName === "BUTTON"
            ? el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1
            : false;
        const empty = !(el.textContent ?? "").trim() && !el.querySelector("img,svg,canvas,button,select,input,option");
        controls[id] = { x: r.left, y: r.top, w: r.width, h: r.height, shown, clipped, tag: el.tagName, empty };
      }
      probe.remove();
      const board = document.querySelector<HTMLElement>('[data-testid="board"]');
      const tray = document.querySelector<HTMLElement>('[data-testid="off-tray"]')?.getBoundingClientRect();
      return {
        size: `${innerWidth}×${innerHeight}`,
        vw: innerWidth,
        vh: innerHeight,
        scrollW: document.documentElement.scrollWidth,
        scrollH: document.documentElement.scrollHeight,
        // A board wider than its box makes the player scroll only when it
        // scrolls. Overflow that is shown or clipped is no scrollbar: checkers
        // hanging 7 px over the frame were told as "I have to scroll to see the
        // whole game" on a page that did not scroll (run 1790365975).
        boardScrollsSideways: board
          ? ["auto", "scroll"].includes(getComputedStyle(board).overflowX) &&
            board.scrollWidth > board.clientWidth + 1
          : false,
        trayDrawn: !!tray && tray.width > 0 && tray.height > 0,
        trayClearOfPoints:
          !!tray &&
          ![...document.querySelectorAll<HTMLElement>('[data-testid="point"]')].some((el) => {
            const p = el.getBoundingClientRect();
            // The same sliver rule as board-geometry.ts overlaps(): 4 px each way.
            return (
              Math.min(tray.right, p.right) - Math.max(tray.left, p.left) > 3 &&
              Math.min(tray.bottom, p.bottom) - Math.max(tray.top, p.top) > 3
            );
          }),
        drawn,
        controls,
      };
    },
    { ids: RIGHT_SIDE, buttons: BUTTONS },
  ) as Promise<Layout>;
}

function drawnBoard(layout: Layout): Box {
  // No points, bar or tray drawn is the render checks' complaint.
  expect(layout.drawn, "[needs: REQ-RENDER/point]").not.toBeNull();
  return layout.drawn as Box;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

test("[F35] REQ-LAYOUT — board and controls placement", async ({ page }) => {
  for (const size of SIZES) {
    const layout = await openAt(page, size);
    const board = drawnBoard(layout);
    expect(
      board.x <= 0.1 * layout.vw,
      `at ${layout.size} the board starts at x=${Math.round(board.x)}, not at the left`,
    ).toBeTruthy();
    for (const [id, c] of Object.entries(layout.controls)) {
      // Missing is the testid check's finding; not showing is F38's; an empty
      // box has nothing to place.
      if (!c || !c.shown || c.empty) continue;
      expect(
        c.x >= board.x + board.w - 2,
        `at ${layout.size} ${id} (x=${Math.round(c.x)}) is not right of the board (it ends at x=${Math.round(board.x + board.w)})`,
      ).toBeTruthy();
    }
  }
});

test("[F36] REQ-LAYOUT — the board takes about 80% of the width", async ({ page }) => {
  for (const size of SIZES) {
    const layout = await openAt(page, size);
    // The board's width includes its off tray; a board drawn without one reads
    // narrower than the player sees it (FIX-3 M06: same frame, empty tray
    // column). The missing tray is the tray checks' complaint.
    // A tray drawn over the points leaves its own column empty, and the board
    // reads narrower than the frame the player sees (FIX-5 M54). Either is the
    // tray checks' complaint.
    expect(layout.trayDrawn && layout.trayClearOfPoints, "[needs: REQ-RENDER/off-tray F32]").toBeTruthy();
    const share = drawnBoard(layout).w / layout.vw;
    // A board too big is itself why the buttons don't fit on the right; a board
    // too small can be the buttons' doing — run 1790381377's controls down the
    // left edge narrowed it — and is then the placement check's complaint (F35).
    expect(share, `[aspect: wide] at ${layout.size} the board is ${pct(share)} of the width`).toBeLessThanOrEqual(
      BOARD_SHARE.max,
    );
    expect(share, `[aspect: narrow] [needs: F35] at ${layout.size} the board is ${pct(share)} of the width`).toBeGreaterThanOrEqual(
      BOARD_SHARE.min,
    );
  }
});

test("[F37] REQ-LAYOUT — the game fits the screen", async ({ page }) => {
  for (const size of SIZES) {
    const layout = await openAt(page, size);
    expect(
      layout.scrollW <= layout.vw + 2 && layout.scrollH <= layout.vh + 2 && !layout.boardScrollsSideways,
      `[aspect: scroll] at ${layout.size} the page is ${layout.scrollW}×${layout.scrollH}` +
        (layout.boardScrollsSideways ? " and the board scrolls sideways" : ""),
    ).toBeTruthy();
    const tall = drawnBoard(layout).h / layout.vh;
    expect(tall, `[aspect: space] at ${layout.size} the board is ${pct(tall)} of the height`).toBeGreaterThanOrEqual(
      BOARD_HEIGHT_MIN,
    );
  }
});

test("[F38] REQ-LAYOUT — the buttons and game info show properly", async ({ page }) => {
  for (const size of SIZES) {
    const layout = await openAt(page, size);
    const board = drawnBoard(layout);
    const present = Object.entries(layout.controls).filter((e): e is [string, Control] => e[1] !== null && !e[1].empty);
    for (const [id, c] of present) {
      expect(c.shown, `${ASPECT_OF[id]} at ${layout.size} ${id} is not showing`).toBeTruthy();
    }
    for (const [id, c] of present) {
      expect(
        c.x >= -1 && c.y >= -1 && c.x + c.w <= layout.vw + 1 && c.y + c.h <= layout.vh + 1,
        `at ${layout.size} ${id} is cut off by the edge of the window (${Math.round(c.x)},${Math.round(c.y)} ${Math.round(c.w)}×${Math.round(c.h)})`,
      ).toBeTruthy();
      expect(overlap(c, board), `at ${layout.size} ${id} sits on top of the board`).toBeLessThanOrEqual(2);
    }
    const buttons = present.filter(([id]) => BUTTONS.includes(id));
    for (const [id, c] of buttons) {
      // Too small to press is a button's measure. The difficulty <select> is
      // sized by the browser — about 19 px tall unstyled — and a player uses it
      // as it is (run 1790396722 told one "too small to use").
      if (c.tag !== "BUTTON") continue;
      expect(
        c.w >= BUTTON_MIN.w && c.h >= BUTTON_MIN.h && !c.clipped,
        `at ${layout.size} ${id} is squished (${Math.round(c.w)}×${Math.round(c.h)}${c.clipped ? ", its label cut off" : ""})`,
      ).toBeTruthy();
    }
    for (let i = 0; i < buttons.length; i++) {
      for (let j = i + 1; j < buttons.length; j++) {
        expect(
          overlap(buttons[i][1], buttons[j][1]),
          `at ${layout.size} ${buttons[i][0]} and ${buttons[j][0]} overlap`,
        ).toBeLessThanOrEqual(2);
      }
    }
  }
});

// [F44] REQ-LAYOUT — the buttons carry their names. The build prompt names
// them (chunk-04: "the buttons read Roll, Double, Undo, End Turn and New Game"),
// since button names are the page's own and no backgammon convention; a longer
// label is fine as long as it contains the name ("Roll Dice"). Read from the
// button's own text whether or not it shows: a button that doesn't show is
// F38's complaint, and one that isn't there the tag check's.
test("[F44] REQ-LAYOUT — the buttons carry their names", async ({ page }) => {
  await page.goto("/");
  const labels = await page.evaluate((ids) => {
    const out: Record<string, string | null> = {};
    for (const id of ids) {
      const el = document.querySelector(`[data-testid="${id}"]`);
      // A label drawn with CSS (`content: "Roll"`) is a label a player reads.
      const drawn = (pseudo: string) => {
        const c = el ? getComputedStyle(el, pseudo).content : "none";
        if (!c || c === "none" || c === "normal") return "";
        // A string content value reads back wrapped in its quotes.
        return c.length >= 2 && c[0] === c[c.length - 1] ? c.slice(1, -1) : c;
      };
      out[id] = el
        ? [drawn("::before"), el.textContent ?? "", drawn("::after")].join(" ").replace(/\s+/g, " ").trim().toLowerCase()
        : null;
    }
    return out;
  }, Object.keys(BUTTON_NAMES));
  const unnamed = Object.entries(BUTTON_NAMES)
    .filter(([id, name]) => labels[id] !== null && !(labels[id] as string).includes(name))
    .map(([id]) => `${id} reads "${labels[id]}"`);
  expect(unnamed, `buttons whose label lacks their name: ${unnamed.join("; ")}`).toEqual([]);
});
