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
  // Pieces with more than a tenth of their drawn circle past the window edge,
  // by the edge they cross (a piece in a corner counts for both), and how many
  // there are on the board.
  piecesPast: { bottom: number; top: number; left: number; right: number };
  pieces: number;
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
      const pieceEls = [...document.querySelectorAll<HTMLElement>('[data-testid="checker"]')]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0);
      const pastEdge = pieceEls.filter((r) => {
        const inside =
          Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) *
          Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
        return inside < 0.9 * r.width * r.height;
      });
      const piecesPast = {
        bottom: pastEdge.filter((r) => r.bottom > innerHeight).length,
        top: pastEdge.filter((r) => r.top < 0).length,
        left: pastEdge.filter((r) => r.left < 0).length,
        right: pastEdge.filter((r) => r.right > innerWidth).length,
      };
      return {
        piecesPast,
        pieces: pieceEls.length,
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
      `[aspect: leftedge] at ${layout.size} the board starts at x=${Math.round(board.x)}, too far in from the left edge`,
    ).toBeTruthy();
    for (const [id, c] of Object.entries(layout.controls)) {
      // Missing is the testid check's finding; not showing is F38's; an empty
      // box has nothing to place.
      if (!c || !c.shown || c.empty) continue;
      expect(
        c.x >= board.x + board.w - 2,
        `[aspect: controls] at ${layout.size} ${id} (x=${Math.round(c.x)}) is not right of the board (it ends at x=${Math.round(board.x + board.w)})`,
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
    // A board wider than the window runs off the screen — F30's and F37's
    // finding; the buttons are not squished then, only covered or pushed out
    // (run 1790781911's board spilled off the left edge and was told the
    // buttons looked squished).
    expect(share, `[needs: F30 F37] at ${layout.size} the board is ${pct(share)} of the width — wider than the window`).toBeLessThanOrEqual(1);
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
    // The page need not scroll for the player to lose part of the board: a
    // board that hides its overflow cuts its pieces off at the window's edge
    // (run 1790846840 round 3: 7 pieces below the bottom of an 800 px window,
    // and no check told it — F43 leaves a piece past the window to this one).
    // Told by the edge they cross: told only "past the edge", run 898deec7's
    // model clamped its pieces sideways for five rounds while they hung off the
    // bottom.
    const past = layout.piecesPast;
    const of = `of ${layout.pieces} pieces run past the`;
    expect(past.bottom, `[aspect: offbottom] at ${layout.size} ${past.bottom} ${of} bottom edge of the window`).toBe(0);
    expect(past.top, `[aspect: offtop] at ${layout.size} ${past.top} ${of} top edge of the window`).toBe(0);
    expect(past.left, `[aspect: offleft] at ${layout.size} ${past.left} ${of} left edge of the window`).toBe(0);
    expect(past.right, `[aspect: offright] at ${layout.size} ${past.right} ${of} right edge of the window`).toBe(0);
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

// [F82] REQ-LAYOUT — the buttons match. Jerry, run 1792248731 round 2, on a
// board that looked wonky: "the triangles, the bar, the bear off, and the
// buttons". Roll, Double, Undo and End Turn are one set and are drawn the same
// size; any other button stacked in line with them (sharing their column or
// their row) is the same size as them too — New Game in a header of its own
// is not part of the set. Grader only: the model knows a tidy control panel
// from its training (owner, 2026-10-17).
test("[F82] REQ-LAYOUT — the buttons match", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();
  const box = async (id: string) => page.getByTestId(id).first().boundingBox();
  const set: { id: string; x: number; y: number; width: number; height: number }[] = [];
  for (const id of ["rollBtn", "doubleBtn", "undoBtn", "endTurnBtn"]) {
    const b = await box(id);
    expect(b, "[needs: F38]").not.toBeNull();
    set.push({ id, ...b! });
  }
  const others: typeof set = [];
  const ng = await box("newGameBtn");
  if (ng) {
    const inLine = set.some((b) => Math.abs(b.x - ng.x) <= 2 || Math.abs(b.y - ng.y) <= 2);
    if (inLine) others.push({ id: "newGameBtn", ...ng });
  }
  const all = [...set, ...others];
  const ratio = (xs: number[]) => Math.max(...xs) / Math.min(...xs);
  const sizes = all.map((b) => `${b.id} ${Math.round(b.width)}×${Math.round(b.height)}`).join(", ");
  expect(
    ratio(all.map((b) => b.width)) <= 1.05 && ratio(all.map((b) => b.height)) <= 1.05,
    `[needs: F38 F44] the buttons are different sizes: ${sizes}`,
  ).toBeTruthy();
});

// [F87] REQ-LAYOUT — the board keeps its shape as the window changes. Jerry,
// run 1792491065's final build: "the pieces were overlapping because i had a
// banner inside my chrome browser that was pushing those pieces down … if the
// users viewport is different sized the board and the elements should be
// responsive", then "i squeezed and then re-expanded the game" — and was left
// with copies of the bar and tray drawn over the board. Played as he did, on
// one live page: full size, then each window shape below, then full size
// again: a build that redraws on resize without clearing leaves its old bar
// and tray where the smaller board put them (run 1792491065's buildBoard
// appended a new bar and tray to the board on every resize). At every shape
// nothing may scroll or leave the window and pieces of different points may
// not run into each other; back at full size, the board must look as it did
// before.
// The board keeps one shape at any window size (Jerry, 2026-10-27: "the board
// layout and piece sizing should render against a fixed ratio using
// percentage calculation … px count is wrong here"): the drawn board — the
// span of its points, bar and tray — is 1.4 times as wide as it is tall, and
// a piece stays the same share of a point's width. The window shapes are
// fractions of the full window, named for what a player does to it: run
// 1793021515's final build, fine at 1180×750, ran its 5- and 4-stacks into
// each other once a banner took some height, because it stretched its board
// to the window. With the shape held, stacks cannot meet at any size. The
// reference reads 1.400 and 0.86 of a point at every shape below.
const FULL = { width: 1440, height: 900 };
const BOARD_SHAPE = 1.4;
const SHAPE_SLACK = 0.03;
const PIECE_SLACK = 0.05;
const SHAPES = [
  { name: "a banner taking a quarter of its height", w: 1, h: 0.72 },
  { name: "a fifth smaller both ways", w: 0.8, h: 0.8 },
  { name: "narrower, at full height", w: 0.7, h: 1 },
  { name: "bigger", w: 1.6, h: 1.6 },
];

/** The page as pixels: a screenshot decoded in the page, reduced to luminance. */
async function boardPixels(page: Page): Promise<string> {
  return (await page.screenshot({ type: "png" })).toString("base64");
}

/** The drawn board's shape, where the pieces sit, and how big a piece is against a point. */
async function readWindowFit(page: Page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const boxes = (sel: string) =>
      [...document.querySelectorAll<HTMLElement>(sel)]
        .filter((e) => e.checkVisibility())
        .map((e) => e.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0);
    const drawn = boxes('[data-testid="point"],[data-testid="bar"],[data-testid="off-tray"]');
    const x0 = Math.min(...drawn.map((r) => r.left));
    const x1 = Math.max(...drawn.map((r) => r.right));
    const y0 = Math.min(...drawn.map((r) => r.top));
    const y1 = Math.max(...drawn.map((r) => r.bottom));
    const points = boxes('[data-testid="point"]').map((r) => r.width).sort((p, q) => p - q);
    const pointW = points[Math.floor(points.length / 2)] ?? 0;
    const cs = [...document.querySelectorAll<HTMLElement>('[data-testid="checker"]')]
      .filter((c) => c.checkVisibility())
      .map((c) => {
        const r = c.getBoundingClientRect();
        return { loc: c.dataset.loc ?? "", x: r.x + r.width / 2, y: r.y + r.height / 2, w: Math.min(r.width, r.height), r };
      });
    const off = cs.filter((c) => c.r.bottom > vh + 0.1 * c.w || c.r.top < -0.1 * c.w || c.r.right > vw + 0.1 * c.w || c.r.left < -0.1 * c.w).length;
    const clashes: string[] = [];
    for (let i = 0; i < cs.length; i++)
      for (let j = i + 1; j < cs.length; j++) {
        const a = cs[i];
        const b = cs[j];
        if (a.loc !== b.loc && Math.hypot(a.x - b.x, a.y - b.y) < 0.9 * Math.min(a.w, b.w)) clashes.push(`${a.loc}/${b.loc}`);
      }
    const pieceW = cs.map((c) => c.w).sort((p, q) => p - q)[Math.floor(cs.length / 2)] ?? 0;
    const el = document.scrollingElement ?? document.documentElement;
    return {
      size: `${vw}×${vh}`,
      shape: drawn.length ? (x1 - x0) / (y1 - y0) : 0,
      boardPast: drawn.length > 0 && (x0 < -2 || y0 < -2 || x1 > vw + 2 || y1 > vh + 2),
      scrolls: el.scrollWidth > vw + 2 || el.scrollHeight > vh + 2,
      off,
      pieces: cs.length,
      clashes,
      piece: pointW ? pieceW / pointW : 0,
      bars: boxes('[data-testid="bar"]').length,
      trays: boxes('[data-testid="off-tray"]').length,
    };
  });
}

test("[F87] REQ-LAYOUT — the board keeps its shape as the window changes", async ({ page }) => {
  // Measured at every window shape first, then told worst first: copies of
  // the board left behind, the board or pieces off the window, pieces running
  // into each other, and only then the board's proportions. Run 1793119227's
  // round 3 build (a fresh board at 1.28) piled up a new bar and tray at every
  // resize — six of each after five — and was told only that its board was
  // not 1.4 times as wide as it is tall, the first thing this check asked.
  test.setTimeout(60_000);
  await openAt(page, FULL);
  await page.waitForTimeout(800);
  const before = await boardPixels(page);
  const full = await readWindowFit(page);
  const seen: { where: string; fit: Awaited<ReturnType<typeof readWindowFit>> }[] = [];
  for (const shape of SHAPES) {
    await page.setViewportSize({ width: Math.round(FULL.width * shape.w), height: Math.round(FULL.height * shape.h) });
    await page.waitForTimeout(800);
    const fit = await readWindowFit(page);
    seen.push({ where: `with the window ${shape.name} (${fit.size})`, fit });
  }
  await page.setViewportSize(FULL);
  await page.waitForTimeout(800);
  const after = await boardPixels(page);
  const back = await readWindowFit(page);
  // Back at the size it started: one bar and one tray, and the same picture.
  // The stale copies a redraw leaves are near the board's own colour (run
  // 1792491065's bar: about a sixth darker), so the picture is compared at a
  // twelfth of brightness: the share of pixels that moved by more than that.
  const changed = await page.evaluate(
    async ({ a, b }) => {
      const load = (src: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error("screenshot PNG failed to decode in-browser"));
          img.src = `data:image/png;base64,${src}`;
        });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const lum = (img: HTMLImageElement) => {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const out = new Float32Array(c.width * c.height);
        for (let i = 0; i < out.length; i++) out[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
        return out;
      };
      const la = lum(ia);
      const lb = lum(ib);
      if (la.length !== lb.length) return 1;
      let n = 0;
      for (let i = 0; i < la.length; i += 4) if (Math.abs(la[i] - lb[i]) > 0.08) n++;
      return n / (la.length / 4);
    },
    { a: before, b: after },
  );

  for (const { where, fit } of [...seen, { where: "after the window was made full size again", fit: back }]) {
    expect(
      fit.bars <= 1 && fit.trays <= 1,
      `[aspect: stale] ${where} there are ${fit.bars} bars and ${fit.trays} off trays drawn`,
    ).toBe(true);
  }
  expect(
    changed <= 0.02,
    `[aspect: stale] after the window changed shape and was made full size again, ${(changed * 100).toFixed(1)}% of the screen looks different from before`,
  ).toBe(true);
  for (const { where, fit } of seen) {
    expect(
      !fit.scrolls && fit.off === 0 && !fit.boardPast,
      `[aspect: fit] [needs: F37] ${where} the page ${fit.scrolls ? "scrolls" : "fits"}, the board ${fit.boardPast ? "runs past" : "stays inside"} the window and ${fit.off} of ${fit.pieces} pieces run past it`,
    ).toBeTruthy();
  }
  for (const { where, fit } of seen) {
    expect(fit.clashes, `[aspect: overlap] [needs: F31] ${where}, pieces of different points run into each other: ${fit.clashes.join(", ")}`).toEqual([]);
  }
  const shapeOk = (v: number) => Math.abs(v / BOARD_SHAPE - 1) <= SHAPE_SLACK;
  expect(
    shapeOk(full.shape),
    `[aspect: ratio] [needs: F37] at ${full.size} the board is ${full.shape.toFixed(2)} times as wide as it is tall, not ${BOARD_SHAPE}`,
  ).toBe(true);
  for (const { where, fit } of seen) {
    expect(
      shapeOk(fit.shape),
      `[aspect: shape] [needs: F37] ${where} the board is ${fit.shape.toFixed(2)} times as wide as it is tall, not ${BOARD_SHAPE}`,
    ).toBe(true);
  }
  for (const { where, fit } of seen) {
    expect(
      Math.abs(fit.piece / full.piece - 1) <= PIECE_SLACK,
      `[aspect: size] [needs: F41] ${where} a piece is ${fit.piece.toFixed(2)} of a point's width, against ${full.piece.toFixed(2)} at full size`,
    ).toBe(true);
  }
});
