import { type Page } from "@playwright/test";
import { expect, playerClick, playerClickUntilShown, setupState, test } from "./fixtures.ts";

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
        // Clicked where it shows: a pulsing hint on top of a stack (fixtures.ts).
        await playerClick(hints.first());
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

// [F39] REQ-DICE — Jerry, 2026-09-25: "2 dice should always be visible, but
// the player should be able to move 4 times on doubles ... if dice are
// different == 2 moves and if dice are the same == 4 moves and only 2 dice
// should be visible on the front end." Four moves on a double is F33; this
// gate holds the rest. The dice are rolled with the page's own Roll button, as
// a player rolls them: after any roll exactly two dice are on screen, and two
// different numbers give exactly two moves, played by clicking.

async function visibleDice(page: Page): Promise<number> {
  return page.locator('[data-testid="die"]').evaluateAll(
    (els) =>
      els.filter((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
      }).length,
  );
}

// The dice as they land: counted once the dice box has stopped changing for a
// second. A roll animates — the reference tumbles two dice for about half a
// second before drawing the result — and counting mid-tumble passed a page
// that then drew four (FIX-4 mutations M50, M52).
async function landedDice(page: Page): Promise<number> {
  const deadline = Date.now() + 8_000;
  let last: string | null = null;
  let since = Date.now();
  while (Date.now() < deadline) {
    const snap = await page.evaluate(() => document.querySelector('[data-testid="dice"]')?.innerHTML ?? "");
    if (snap !== last) {
      last = snap;
      since = Date.now();
    } else if (Date.now() - since >= 1_000) {
      break;
    }
    await page.waitForTimeout(100);
  }
  return visibleDice(page);
}

async function boardKey(page: Page): Promise<string> {
  const response = await page.request.post("/api/state", { data: {} });
  expect(response.ok(), `POST /api/state failed (${response.status()})`).toBeTruthy();
  const s = await response.json();
  return JSON.stringify([s.points, s.bar, s.off]);
}

async function rollThroughThePage(page: Page, dice: number[]): Promise<void> {
  const fresh = await page.request.post("/api/new", { data: {} });
  expect(fresh.ok(), `POST /api/new failed (${fresh.status()})`).toBeTruthy();
  await page.reload();
  const queued = await page.request.post("/api/debug/roll", { data: { dice } });
  expect(queued.ok(), `POST /api/debug/roll failed (${queued.status()})`).toBeTruthy();
  await page.getByTestId("rollBtn").click();
  // Fewer than two dice after a roll is the dice render check's complaint.
  await expect
    .poll(() => visibleDice(page), { message: "[needs: REQ-RENDER/die] fewer than two dice after a roll", timeout: 5_000 })
    .toBeGreaterThanOrEqual(2);
}

test("[F39] REQ-DICE — a roll shows two dice, and two different numbers give two moves", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");

  // Two different numbers: two dice on screen once they land, and two moves.
  await rollThroughThePage(page, [5, 6]);
  expect(await landedDice(page), "[aspect: extra] more than two dice on screen after rolling 5-6").toBeLessThanOrEqual(2);

  const selectable = page.locator('[data-testid="checker"][data-color="white"].selectable');
  const hints = page.locator('[data-testid="hint"]');
  // One move as a player makes it: a checker to pick up, a hint, a click that
  // changes the board. Nothing to pick up or no hint within a moment is no move.
  const tryMove = async (): Promise<boolean> => {
    if (!(await selectable.first().waitFor({ state: "visible", timeout: 3_000 }).then(() => true, () => false))) return false;
    await playerClickUntilShown(selectable.first(), hints);
    if (!(await hints.first().waitFor({ state: "visible", timeout: 3_000 }).then(() => true, () => false))) return false;
    const before = await boardKey(page);
    await playerClick(hints.first());
    return expect
      .poll(() => boardKey(page), { timeout: 3_000 })
      .not.toBe(before)
      .then(() => true, () => false);
  };
  const move = async (told: string): Promise<boolean> => {
    try {
      return await withinSeconds(25, tryMove);
    } catch (err) {
      throw new Error(`${told}: ${(err as Error).message}`);
    }
  };

  // A first move that cannot be made is the ordinary-roll gates' complaint
  // when they fail too (a needs marker, harness/adapters/challenge/stages.py).
  const first = "[aspect: moves] [needs: REQ-HINT/selectable REQ-HINT/hint F03 F25]";
  expect(await move(first), `${first} rolled 5-6 and could not make a first move`).toBe(true);
  expect(await move("[aspect: moves]"), "[aspect: moves] rolled 5-6 and could make only one move").toBe(true);
  // A third: a click that is not a move, or a checker gone mid-click, is no move.
  const third = await withinSeconds(25, tryMove).catch(() => false);
  expect(third, "[aspect: moves] rolled 5-6 and could make a third move").toBe(false);

  // A double: still only two dice on screen (its four moves are F33's).
  await rollThroughThePage(page, [4, 4, 4, 4]);
  expect(await landedDice(page), "[aspect: extra] more than two dice on screen after rolling a double").toBeLessThanOrEqual(2);
});
