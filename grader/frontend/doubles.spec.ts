import { expect, setupState, test } from "./fixtures.ts";

// [F33] REQ-DOUBLES — a doubles roll renders FOUR dice, not two.
//
// The engine holding four moves is not enough: a page can keep the full move
// list while drawing only two dice. The gate therefore judges the rendered
// count. The state is pushed whole through the debug API (dice length 4 is
// what marks a double) and read back after a reload — the page renders the
// server's state on load, so no roll click is involved.
test("[F33] REQ-DOUBLES — a double shows four dice", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid="board"]')).toBeVisible();

  const points = new Array(26).fill(0);
  points[24] = 2;
  points[13] = 5;
  points[8] = 3;
  points[6] = 5;
  points[1] = -2;
  points[12] = -5;
  points[17] = -3;
  points[19] = -5;

  await setupState(page, {
    points,
    bar: { white: 0, black: 0 },
    off: { white: 0, black: 0 },
    turn: "white",
    phase: "move",
    dice: [6, 6, 6, 6],
    remainingDice: [6, 6, 6, 6],
  });

  await page.reload();
  await expect(page.locator('[data-testid="board"]')).toBeVisible();
  await expect(page.locator('[data-testid="die"]')).toHaveCount(4);
});
