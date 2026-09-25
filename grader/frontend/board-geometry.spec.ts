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
  pointWidth,
  readBarBox,
  readCheckerBoxes,
  readOffTray,
  readPointBoxes,
  sampleTriangleOrientation,
  waitForBoardSettled,
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
  expect(bar, 'expected a [data-testid="bar"] element on the board, found none').not.toBeNull();

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

  expect(
    bar.x >= leftHalfRightEdge,
    `expected the bar between the board halves, found bar x=${bar.x.toFixed(1)} left of the left half's rightmost edge x=${leftHalfRightEdge.toFixed(1)}`,
  ).toBeTruthy();
  expect(
    bar.x + bar.width <= rightHalfLeftEdge,
    `expected the bar between the board halves, found bar right edge x=${(bar.x + bar.width).toFixed(1)} right of the right half's leftmost edge x=${rightHalfLeftEdge.toFixed(1)}`,
  ).toBeTruthy();
  expect(
    bar.height >= 1.8 * avgPointHeight,
    `expected the bar to span both board rows, found bar height=${bar.height.toFixed(1)} vs average point height=${avgPointHeight.toFixed(1)}`,
  ).toBeTruthy();
});

test("[F31] REQ-GEOMETRY — checkers over their own points", async ({ page }) => {
  await openFreshBoard(page);
  await waitForBoardSettled(page);

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
});

test("[F30] REQ-GEOMETRY — triangles point inward", async ({ page }) => {
  await openFreshBoard(page);

  const points = await readPointBoxes(page);
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
  const samples = await sampleTriangleOrientation(page, points);

  expect(samples.length, `expected 24 triangle samples, found ${samples.length}`).toBe(24);

  const outward = samples.filter((s) => !s.orientedInward).map((s) => s.num);
  expect(
    outward,
    `expected every point's triangle to point inward (painted across most of its width at the rim, little of it at the inner end), found outward-pointing point numbers: ${outward.join(", ")}`,
  ).toEqual([]);
});
