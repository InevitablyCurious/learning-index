import { type Page } from "@playwright/test";
import { expect, playerClickUntilShown, setupState, test } from "./fixtures.ts";

// [F33] REQ-DOUBLES — a double lets the player make FOUR MOVES.
//
// The spec carries a double as four data entries, but it never asks the page
// to DRAW four dice — what the player must feel is four moves, so that is
// what the gate plays. An opening position is pushed through the debug API
// with [6, 6, 6, 6], then the UI is driven the way a player drives it —
// click a selectable checker, click a hint, four times — and the server's
// own state must show all four dice consumed. An app that draws two dice
// but plays four moves passes; an app that draws four dice but plays two
// fails.
//
// What the player is told is how many moves the double actually gave them.
// A FIRST move that cannot be made is not yet about doubles when the gates
// that play an ordinary roll the same way (pick up a checker, see a hint,
// click it) fail too: theirs is the complaint, and this gate is not told
// (a needs marker, harness/adapters/challenge/stages.py). When they pass, the
// double alone gave no move at all.

// One move, bounded. A checker highlighted before the page redraws can vanish
// mid-click, and the click helper then waits for it to come back until the
// test's own time runs out — "Test timeout exceeded", which names no move
// (FIX-3 re-grade, M10b). Bounding each move keeps the finding about the move.
async function withinSeconds<T>(seconds: number, step: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`gave up after ${seconds}s`)), seconds * 1000);
  });
  try {
    return await Promise.race([step(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function remainingDiceCount(page: Page): Promise<number> {
  const response = await page.request.post("/api/state", { data: {} });
  expect(response.ok(), `POST /api/state failed (${response.status()})`).toBeTruthy();
  const state = (await response.json()) as { remainingDice: number[] };
  return state.remainingDice.length;
}

test("[F33] REQ-DOUBLES — a double lets the player make four moves", async ({ page }) => {
  // Four bounded moves, each allowed its full bound, and room to set up.
  test.setTimeout(90_000);
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
  await expect(page.locator('[data-testid="board"]'), "[aspect: nomove]").toBeVisible();

  const firstMove = "[aspect: nomove] [needs: REQ-HINT/selectable REQ-HINT/hint F03 F25]";
  const movesMade = ["", "[aspect: one]", "[aspect: two]", "[aspect: three]"];

  const selectable = page.locator(
    '[data-testid="checker"][data-color="white"].selectable',
  );
  const hints = page.locator('[data-testid="hint"]');

  // Four moves, played as a player plays them. Which checker or hint gets
  // picked does not matter: from this position the only legal moves are
  // 24→18, 13→7 and 8→2, and none can stop being legal later — destinations
  // only ever receive white checkers, the moved-to points cannot move on
  // (18→12 and 7→1 are blocked by black stacks), and the sources hold ten
  // checkers between them, enough for all four plies. Waiting for the
  // server to consume each die before the next click keeps the loop in step
  // with the page's own redraw.
  for (let played = 1; played <= 4; played++) {
    const told = played === 1 ? firstMove : movesMade[played - 1];
    try {
      await withinSeconds(20, async () => {
        await expect(selectable.first(), "no checker to pick up").toBeVisible();
        await playerClickUntilShown(selectable.first(), hints);
        await expect(hints.first(), "no hint appeared").toBeVisible();
        // Hints carry an infinite `pulse` animation, so Playwright never sees
        // them as "stable" — force the click past the stability check.
        await hints.first().click({ force: true });
        await expect.poll(() => remainingDiceCount(page), "die not consumed").toBe(4 - played);
      });
    } catch (err) {
      // Whichever step stopped this move, what the player saw is how many
      // moves the double gave — so every failure inside the move says so.
      throw new Error(`move ${played} ${told}: ${(err as Error).message}`);
    }
  }

  // All four dice were played through the UI: the server holds nothing left.
  expect(await remainingDiceCount(page), "four moves consumed the double").toBe(0);
});
