// ─────────────────────────────────────────────────────────────────────────────
// REQ-GEOMETRY — the board must be DRAWN correctly, not merely completely.
//
// The count-only REQ-RENDER checks pass on a board whose bar sits at the far
// edge, whose rows are swapped, whose checkers float a point away from their
// own triangles. These four checks measure the rendered boxes
// (board-geometry.ts) and judge the geometry a player sees. Assertion messages
// state observed measurements only.
// ─────────────────────────────────────────────────────────────────────────────

import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import {
  boardMidY,
  pointWidth,
  readBarBox,
  readCheckerBoxes,
  overlaps,
  readOffTray,
  readPointBoxes,
  sampleTriangleOrientation,
  type PointBox,
} from "./board-geometry.ts";

// The shared opening: load the app, start a fresh game through the API, reload
// so the board renders from that state.
async function openFreshBoard(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator('[data-testid="board"]')).toBeVisible();
  await page.request.post("/api/new", { data: {} });
  await page.reload();
  await expect(page.locator('[data-testid="board"]')).toBeVisible();
  // goto/reload wait for the drawn, settled board (fixtures.ts): run
  // 1790329339's page drew its points ~100 ms after the frame, and these checks
  // read an empty board ("found []", an average point height of NaN).
}

function leftToRight(row: PointBox[]): number[] {
  return [...row].sort((a, b) => a.x - b.x).map((p) => p.num);
}

test("[F28] REQ-GEOMETRY — points in board order", async ({ page }) => {
  await openFreshBoard(page);

  const points = await readPointBoxes(page);
  const byHeight = [...points].sort((a, b) => a.centerY - b.centerY);
  const topRow = leftToRight(byHeight.slice(0, 12));
  const bottomRow = leftToRight(byHeight.slice(12));

  expect(
    topRow,
    `expected top-row point numbers left-to-right 13,14,15,16,17,18,19,20,21,22,23,24, found ${topRow.join(",")}`,
  ).toEqual([13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  expect(
    bottomRow,
    `expected bottom-row point numbers left-to-right 12,11,10,9,8,7,6,5,4,3,2,1, found ${bottomRow.join(",")}`,
  ).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
});

test("[F29] REQ-GEOMETRY — bar between the halves", async ({ page }) => {
  await openFreshBoard(page);

  const bar = await readBarBox(page);
  // No bar at all is the bar render check's complaint.
  expect(bar, '[needs: REQ-RENDER/bar] expected a [data-testid="bar"] element on the board, found none').not.toBeNull();

  const points = await readPointBoxes(page);
  const LEFT_HALF = new Set([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  const RIGHT_HALF = new Set([1, 2, 3, 4, 5, 6, 19, 20, 21, 22, 23, 24]);
  const leftHalfRightEdge = Math.max(
    ...points.filter((p) => LEFT_HALF.has(p.num)).map((p) => p.x + p.width),
  );
  const rightHalfLeftEdge = Math.min(
    ...points.filter((p) => RIGHT_HALF.has(p.num)).map((p) => p.x),
  );
  const avgPointHeight = points.reduce((sum, p) => sum + p.height, 0) / points.length;

  // Where the bar is NOT is told as what the player sees there: out past the
  // points, drawn over some of them (run 1790329339: a strip down the middle,
  // told "at the edge"), or in a gap that is not the middle.
  const between = bar.x >= leftHalfRightEdge - 3 && bar.x + bar.width <= rightHalfLeftEdge + 3;
  const pointsLeft = Math.min(...points.map((p) => p.x));
  const pointsRight = Math.max(...points.map((p) => p.x + p.width));
  const outside = bar.x + bar.width <= pointsLeft + 1 || bar.x >= pointsRight - 1;
  const overPoints = points.some((p) => overlaps(bar, p));
  const where = between ? "" : outside ? "" : overPoints ? "[aspect: overlap] " : "[aspect: place] ";
  // Where the bar belongs is only defined once the rows form proper halves: on
  // a board whose rows do not line up it is the rows check's complaint (run
  // 1790345941: rows squeezed into opposite halves read as "the bar splits the
  // board in the wrong place" while the bar sat in the middle).
  expect(
    between,
    `${where}[needs: F40] expected the bar between the board halves, found bar x=${bar.x.toFixed(1)}..${(bar.x + bar.width).toFixed(1)} with the left half ending at x=${leftHalfRightEdge.toFixed(1)} and the right half starting at x=${rightHalfLeftEdge.toFixed(1)}`,
  ).toBeTruthy();
  expect(
    bar.height >= 1.8 * avgPointHeight,
    `[aspect: short] expected the bar to span both board rows, found bar height=${bar.height.toFixed(1)} vs average point height=${avgPointHeight.toFixed(1)}`,
  ).toBeTruthy();
});

test("[F31] REQ-GEOMETRY — checkers over their own points", async ({ page }) => {
  await openFreshBoard(page);

  const points = await readPointBoxes(page);
  const checkers = await readCheckerBoxes(page);
  const tolerance = 0.45 * pointWidth(points);

  for (const checker of checkers) {
    const point = points.find((p) => p.num === Number(checker.loc));
    expect(
      point,
      `expected a [data-testid="point"] matching checker loc=${checker.loc}, found none`,
    ).not.toBeUndefined();

    const dx = Math.abs(checker.centerX - point.centerX);
    expect(
      dx < tolerance,
      `expected checker loc=${checker.loc} drawn centered over point ${point.num}, found checker centerX=${checker.centerX.toFixed(1)} vs point centerX=${point.centerX.toFixed(1)} (off by ${dx.toFixed(1)}, tolerance ${tolerance.toFixed(1)})`,
    ).toBeTruthy();

    expect(
      checker.centerY >= point.y - 1 && checker.centerY <= point.y + point.height + 1,
      `expected checker loc=${checker.loc} drawn within point ${point.num}'s vertical band, found checker centerY=${checker.centerY.toFixed(1)} vs band ${point.y.toFixed(1)}..${(point.y + point.height).toFixed(1)}`,
    ).toBeTruthy();
  }
});

test("[F32] REQ-GEOMETRY — off tray is visible", async ({ page }) => {
  await openFreshBoard(page);

  const tray = await readOffTray(page);
  expect(
    tray.exists,
    'expected an [data-testid="off-tray"] element on the board, found none',
  ).toBeTruthy();
  expect(
    tray.visible,
    `expected the off tray to be visible, found width=${tray.width.toFixed(1)} height=${tray.height.toFixed(1)}`,
  ).toBeTruthy();
  // A tray a player can see is drawn: a see-through, outline-less, empty box
  // passed "visible" while nothing was on screen (run 1790341662).
  expect(tray.painted, "expected the off tray to be drawn (a fill, an outline or a label), found an empty see-through box").toBeTruthy();
  const points = await readPointBoxes(page);
  const under = points.filter((p) => overlaps(tray, p));
  expect(under.map((p) => p.num), "[aspect: overlap] the off tray is drawn over points").toEqual([]);
});

test("[F30] REQ-GEOMETRY — triangles point inward", async ({ page }) => {
  await openFreshBoard(page);

  const points = await readPointBoxes(page);
  expect(points.length, "[needs: REQ-RENDER/point] expected 24 points to read").toBe(24);
  // The triangles are read from a screenshot of the window, so a board that
  // runs past it cannot be read: a page that scrolls is the fit check's
  // complaint (a needs marker, harness/adapters/challenge/stages.py), and a
  // board cut off without scrolling is this check's own finding. A taller
  // page once read below-the-fold points as "pointing outward" (FIX-3 M42).
  const view = page.viewportSize();
  const offscreen = points.filter(
    (p) => !view || p.x < -1 || p.y < -1 || p.x + p.width > view.width + 1 || p.y + p.height > view.height + 1,
  );
  expect(
    offscreen.map((p) => p.num),
    `[aspect: offscreen] [needs: F37] points past the edge of the window: ${offscreen.map((p) => p.num).join(", ")}`,
  ).toEqual([]);
  // A point the bar is drawn over shows the bar, not its triangle, so it is
  // not read here — the bar check tells that (FIX-3 M46: a bar over points 16
  // and 9 read as two "outward" triangles). Every other point is judged.
  const bar = await readBarBox(page);
  const tray = await readOffTray(page);
  const covers = (box: { x: number; y: number; width: number; height: number } | null, p: PointBox) =>
    box !== null && overlaps(box, p);
  const underBar = new Set(
    points.filter((p) => covers(bar, p) || (tray.exists && tray.painted && covers(tray, p))).map((p) => p.num),
  );
  const samples = await sampleTriangleOrientation(page, points);

  expect(samples.length, `expected 24 triangle samples, found ${samples.length}`).toBe(24);

  const outward = samples.filter((s) => !s.orientedInward && !underBar.has(s.num)).map((s) => s.num);
  expect(
    outward,
    `expected every point's triangle to point inward (painted across most of its width at the rim, little of it at the inner end), found outward-pointing point numbers: ${outward.join(", ")}`,
  ).toEqual([]);
});

// [F40] REQ-GEOMETRY — the two rows line up, as on every backgammon board: the
// top row's points sit straight across from the bottom row's, column for
// column. Judged on what is drawn — each row sorted left to right — never on
// the numbers, which F28 judges. Run 1790345941 squeezed each row into half the
// width, top row right and bottom row left, and every other stage-1 check passed.
test("[F40] REQ-GEOMETRY — the two rows line up", async ({ page }) => {
  await openFreshBoard(page);
  const points = await readPointBoxes(page);
  expect(points.length, "[needs: REQ-RENDER/point] expected 24 points to read").toBe(24);
  const mid = boardMidY(points);
  const top = points.filter((p) => p.centerY < mid).sort((a, b) => a.centerX - b.centerX);
  const bottom = points.filter((p) => p.centerY >= mid).sort((a, b) => a.centerX - b.centerX);
  const pw = pointWidth(points);
  const apart = top.flatMap((p, i) =>
    bottom[i] && Math.abs(p.centerX - bottom[i].centerX) <= 0.5 * pw ? [] : [`${i + 1}`],
  );
  expect(
    top.length === bottom.length && apart.length === 0,
    `expected ${top.length} top points each straight across from a bottom point, found ${bottom.length} below and columns apart: ${apart.join(", ")}`,
  ).toBeTruthy();
});
