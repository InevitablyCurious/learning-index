import { type Page } from "@playwright/test";
import { expect, playerClickUntilShown, setupState, test } from "./fixtures.ts";
import { checkerAnimates, hintAnimates } from "../lib/acceptance.ts";
import { BASE_URL } from "../lib/harness.ts";

function emptyPts() {
  return new Array(26).fill(0);
}

function fullState(partial: Record<string, any> = {}) {
  const base = {
    points: emptyPts(),
    bar: { white: 0, black: 0 },
    off: { white: 0, black: 0 },
    turn: "white",
    phase: "move",
    dice: [] as number[],
    remainingDice: [] as number[],
    cube: { value: 1, owner: null as "white" | "black" | null },
    difficulty: "medium",
    score: { white: 0, black: 0 },
    winner: null as "white" | "black" | null,
    winType: null as "single" | "gammon" | "backgammon" | null,
    pointsWon: 0,
    doubleOfferedBy: null as "white" | "black" | null,
    message: "",
  };

  return {
    ...base,
    ...partial,
    points: Array.isArray(partial.points) ? [...partial.points] : [...base.points],
    bar: { ...base.bar, ...(partial.bar ?? {}) },
    off: { ...base.off, ...(partial.off ?? {}) },
    dice: Array.isArray(partial.dice) ? [...partial.dice] : [...base.dice],
    remainingDice: Array.isArray(partial.remainingDice)
      ? [...partial.remainingDice]
      : [...base.remainingDice],
    cube: { ...base.cube, ...(partial.cube ?? {}) },
    score: { ...base.score, ...(partial.score ?? {}) },
  };
}

async function postDebugState(page: Page, partial: Record<string, any>) {
  await setupState(page, fullState(partial));
}

async function postDebugRoll(page: Page, dice: number[]) {
  const response = await page.request.post("/api/debug/roll", {
    data: { dice },
  });
  expect(response.ok()).toBe(true);
}

async function fetchState(page: Page) {
  const response = await page.request.post("/api/state", { data: {} });
  expect(response.ok()).toBe(true);
  return response.json();
}

test("[F09] REQ-HIT — hit -> bar visual", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid="board"]')).toBeVisible();

  const points = emptyPts();
  points[24] = 2;
  points[13] = 5;
  points[8] = 3;
  points[6] = 5;
  points[19] = -5;
  points[17] = -3;
  points[12] = -5;
  points[1] = -1;

  await postDebugState(page, {
    points,
    bar: { white: 0, black: 1 },
    off: { white: 0, black: 0 },
    turn: "white",
    phase: "move",
  });

  await page.reload();
  await expect(page.locator('[data-testid="bar"]')).toBeVisible();
  await expect(
    page.locator(
      '[data-testid="checker"][data-color="black"][data-loc="bar"]',
    ),
  ).toHaveCount(1);
});

test("[F10] REQ-BAR — bar re-entry visual", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid="board"]')).toBeVisible();

  const points = emptyPts();
  points[6] = 14;
  points[13] = -15;

  await postDebugState(page, {
    points,
    bar: { white: 1, black: 0 },
    off: { white: 0, black: 0 },
    turn: "white",
    phase: "roll",
    dice: [],
    remainingDice: [],
  });
  await postDebugRoll(page, [3, 5]);

  await page.reload();
  const rollBtn = page.locator('[data-testid="rollBtn"]');
  await expect(rollBtn).toBeVisible();
  await rollBtn.click();

  const whiteBarChecker = page.locator(
    '[data-testid="checker"][data-color="white"][data-loc="bar"]',
  );
  await expect(whiteBarChecker).toHaveCount(1);
  const hints = page.locator('[data-testid="hint"]');
  await playerClickUntilShown(whiteBarChecker, hints);
  await expect(hints, "[aspect: hints]").toHaveCount(2);
  await hints.first().click({ force: true });

  await expect(whiteBarChecker, "[aspect: reentry]").toHaveCount(0);
  const state = await fetchState(page);
  expect(state.bar.white).toBe(0);

  await expect
    .poll(async () => {
      const on20 = await page
        .locator('[data-testid="checker"][data-color="white"][data-loc="20"]')
        .count();
      const on22 = await page
        .locator('[data-testid="checker"][data-color="white"][data-loc="22"]')
        .count();
      return on20 + on22;
    })
    .toBeGreaterThan(0);
});

test("[F11] REQ-BEAROFF — bear-off visual", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid="board"]')).toBeVisible();

  const points = emptyPts();
  points[1] = 2;
  points[2] = 2;
  points[3] = 2;
  points[4] = 2;
  points[5] = 2;
  points[6] = 2;
  points[13] = -15;

  await postDebugState(page, {
    points,
    bar: { white: 0, black: 0 },
    off: { white: 3, black: 0 },
    turn: "white",
    phase: "move",
  });

  await page.reload();
  await expect(page.locator('[data-testid="off-you"]')).toBeVisible();
  await expect(
    page.locator('[data-testid="checker"][data-color="white"][data-loc="off"]'),
  ).toHaveCount(3);
});

test("[F12] REQ-NEWGAME — the win is announced", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid="board"]')).toBeVisible();

  const points = emptyPts();
  points[13] = -13;

  await postDebugState(page, {
    points,
    bar: { white: 0, black: 0 },
    off: { white: 15, black: 2 },
    turn: "white",
    phase: "gameover",
    winner: "white",
    winType: "single",
    message: "You win!",
  });

  await page.reload();
  await expect(page.locator('[data-testid="message"]')).toContainText("You win");

  const modalOverlay = page.locator('[data-testid="modalOverlay"]');
  const modalVisible = await modalOverlay.evaluate(
    (el) => !el.classList.contains("hidden"),
  );
  if (modalVisible) {
    // Capitals are not the player's concern: "You win!" says it as well as "Win".
    await expect(page.locator('[data-testid="modalTitle"]')).toContainText(/win/i);
  }
});

test("[F22] REQ-NEWGAME — board resets for the next game", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid="board"]')).toBeVisible();

  const points = emptyPts();
  points[13] = -13;

  await postDebugState(page, {
    points,
    bar: { white: 0, black: 0 },
    off: { white: 15, black: 2 },
    turn: "white",
    phase: "gameover",
    winner: "white",
    winType: "single",
    message: "You win!",
  });

  await page.reload();
  await page.locator('[data-testid="newGameBtn"]').click({ force: true });

  await expect(page.locator('[data-testid="checker"]')).toHaveCount(30);
  await expect(
    page.locator('[data-testid="checker"][data-color="white"][data-loc="24"]'),
  ).toHaveCount(2);
  await expect(
    page.locator('[data-testid="checker"][data-color="white"][data-loc="13"]'),
  ).toHaveCount(5);
  await expect(
    page.locator('[data-testid="checker"][data-color="white"][data-loc="8"]'),
  ).toHaveCount(3);
  await expect(
    page.locator('[data-testid="checker"][data-color="white"][data-loc="6"]'),
  ).toHaveCount(5);
  await expect(
    page.locator('[data-testid="checker"][data-color="black"][data-loc="1"]'),
  ).toHaveCount(2);
  await expect(
    page.locator('[data-testid="checker"][data-color="black"][data-loc="12"]'),
  ).toHaveCount(5);
  await expect(
    page.locator('[data-testid="checker"][data-color="black"][data-loc="17"]'),
  ).toHaveCount(3);
  await expect(
    page.locator('[data-testid="checker"][data-color="black"][data-loc="19"]'),
  ).toHaveCount(5);

  await expect(page.locator('[data-testid="modalOverlay"]')).toHaveClass(/hidden/);
});

test("[F23] REQ-NEWGAME — new game without reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid="board"]')).toBeVisible();

  const points = emptyPts();
  points[13] = -13;

  await postDebugState(page, {
    points,
    bar: { white: 0, black: 0 },
    off: { white: 15, black: 2 },
    turn: "white",
    phase: "gameover",
    winner: "white",
    winType: "single",
    message: "You win!",
  });

  await page.reload();

  await page.evaluate(() => {
    (window as any).__navmark = 1;
  });

  await page.locator('[data-testid="newGameBtn"]').click({ force: true });

  // Read the mark late. A reload wipes window properties, but the old document
  // lives until the new one commits, so an immediate read can still see the
  // mark on a page that is mid-reload — the combined gate this was split from
  // got that spacing from its ten board assertions. A click-triggered reload
  // of a local page commits well inside 500ms.
  await page.waitForTimeout(500);

  await expect
    .poll(() => page.evaluate(() => (window as any).__navmark))
    .toBe(1);
});

test("[F13] REQ-COMPACT — compact / no horizontal overflow", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid="board"]')).toBeVisible();

  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    const newGameResponse = await page.request.post("/api/new", {
      data: { difficulty: "medium" },
    });
    expect(newGameResponse.ok()).toBe(true);

    await page.reload();
    const board = page.locator('[data-testid="board"]');
    await expect(board).toBeVisible();

    const boardNoOverflow = await board.evaluate(
      (el) => el.scrollWidth <= el.clientWidth + 1,
    );
    expect(boardNoOverflow).toBe(true);

    const docNoOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    );
    expect(docNoOverflow).toBe(true);
  }
});

test("[F14] REQ-ANIM — checker motion is animated", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid="board"]')).toBeVisible();

  const checkerMotion = await page
    .locator('[data-testid="checker"]')
    .first()
    .evaluate((el) => {
      const css = getComputedStyle(el);
      return {
        transitionProperty: css.transitionProperty,
        transitionDuration: css.transitionDuration,
        animationName: css.animationName,
        animationDuration: css.animationDuration,
      };
    });
  // REQ-ANIM: checker motion animated via a CSS transition on transform/all with non-zero
  // duration, OR a CSS keyframe animation with non-zero duration. (transition-property defaults
  // to "all" with 0s duration when unset, so the duration check is what makes this meaningful.)
  expect(checkerAnimates(checkerMotion)).toBe(true);
});

test("[F26] REQ-ANIM — hint animation", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid="board"]')).toBeVisible();

  const points = emptyPts();
  points[6] = 15;
  points[13] = -15;

  await postDebugState(page, {
    points,
    bar: { white: 0, black: 0 },
    off: { white: 0, black: 0 },
    turn: "white",
    phase: "move",
    dice: [3, 5],
    remainingDice: [3, 5],
  });

  await page.reload();
  // Drive an ORDINARY movable checker: the page marks each legal source's
  // topmost white checker selectable while it is white's turn to move.
  const movableWhiteChecker = page
    .locator('[data-testid="checker"][data-color="white"].selectable')
    .first();
  // No checker to pick up, or no hint for it, is not an animation finding:
  // the gates that look for those after an ordinary roll report it when they
  // fail too (a needs marker, harness/adapters/challenge/stages.py).
  await expect(
    movableWhiteChecker,
    "[aspect: nopiece] [needs: REQ-HINT/selectable]",
  ).toBeVisible();
  await playerClickUntilShown(
    movableWhiteChecker,
    page.locator('[data-testid="hint"]'),
  );

  const hint = page.locator('[data-testid="hint"]').first();
  await expect(hint, "[aspect: present] [needs: REQ-HINT/hint F03 F25]").toBeVisible();
  const hintAnimation = await hint.evaluate((el) => {
    const css = getComputedStyle(el);
    return {
      animationName: css.animationName,
      animationDuration: css.animationDuration,
    };
  });
  expect(hintAnimates(hintAnimation), "[aspect: animates]").toBe(true);
});

// The page must work on whichever host name the user reached it by. `localhost`
// and `127.0.0.1` are the same machine but DIFFERENT browser origins, so a page
// that hardcodes an absolute API base works on one and dies on the other — every
// call becomes a cross-origin request the server never allowed. Checking BOTH
// names in one gate makes this self-diagnosing: whichever name was hardcoded,
// the other one fails here, and a page built on root-relative paths follows the
// address it was loaded from and passes both.
test("[F15] REQ-SAME-ORIGIN — the app works on either host name", async ({
  page,
}) => {
  const origins = [BASE_URL, BASE_URL.replace("localhost", "127.0.0.1")];
  expect(new Set(origins).size, "the two origins must differ").toBe(2);

  for (const origin of origins) {
    const consoleErrors: string[] = [];
    const onConsole = (msg: { type: () => string; text: () => string }) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    };
    const onPageError = (err: Error) => {
      consoleErrors.push(err.stack ?? err.message);
    };
    page.on("console", onConsole);
    page.on("pageerror", onPageError);

    await page.goto(`${origin}/`);
    await expect(
      page.getByTestId("board"),
      `board never appeared at ${origin}`,
    ).toBeVisible();

    // State actually arrived and rendered — not just an empty shell.
    await expect(
      page.getByTestId("point"),
      `points never rendered at ${origin}`,
    ).toHaveCount(24);
    await expect(
      page.getByTestId("checker"),
      `checkers never rendered at ${origin}`,
    ).toHaveCount(30);

    expect(consoleErrors, `page errors at ${origin}`).toEqual([]);

    page.off("console", onConsole);
    page.off("pageerror", onPageError);
  }
});
