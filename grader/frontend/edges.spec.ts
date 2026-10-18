import { type Page } from "@playwright/test";
import { expect, pickUpAPiece, playerClick, playerClickUntilShown, rollAndCheck, setupState, test } from "./fixtures.ts";
import { checkerAnimates, hintAnimates } from "../lib/acceptance.ts";
import { BASE_URL } from "../lib/harness.ts";
import { isPainted } from "./board-geometry.ts";

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
  await expect(page.locator('[data-testid="board"]'), "[needs: F01]").toBeVisible();

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
  const onBar = page.locator('[data-testid="checker"][data-color="black"][data-loc="bar"]');
  await expect(onBar).toHaveCount(1);
  // Drawn so a player sees it: run 1790661859's page styled its pieces only on
  // the points, and its bar piece, found here by its tag, showed nothing.
  expect(await isPainted(onBar), "the piece on the bar is drawn with nothing a player can see").toBe(true);
});

test("[F10] REQ-BAR — bar re-entry visual", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid="board"]'), "[needs: F01]").toBeVisible();

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
  await rollAndCheck(page, [3, 5], () => rollBtn.click());

  const whiteBarChecker = page.locator(
    '[data-testid="checker"][data-color="white"][data-loc="bar"]',
  );
  await expect(whiteBarChecker).toHaveCount(1);
  const hints = page.locator('[data-testid="hint"]');
  await expect
    .poll(async () => hints.count(), { message: "[aspect: auto] [needs: F03]", timeout: 3_000 })
    .toBeGreaterThan(0);
  await playerClickUntilShown(whiteBarChecker, hints);
  await expect(hints, "[aspect: hints] [needs: F03]").toHaveCount(2);
  await playerClick(hints.first());

  await expect(whiteBarChecker, "[aspect: reentry] [needs: F03 F45]").toHaveCount(0);
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
    }, "[needs: G06] the piece came in on neither 20 nor 22")
    .toBeGreaterThan(0);
});

test("[F11] REQ-BEAROFF — bear-off visual", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid="board"]'), "[needs: F01]").toBeVisible();

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
  // The three pieces already off, as a player sees them: checkers tagged off,
  // or pieces drawn in the player's tray without the tag. Run 1790650821 drew
  // three discs there untagged and was told they "don't show up in the off
  // tray". A tray with nothing drawn in it is this gate's finding.
  const shownOff = async () => {
    // Tagged AND drawn in the tray: a piece tagged off but drawn somewhere else
    // (run 1791408711's build put them in the bar's column, x 480 against a tray
    // at x 956) is not in the tray a player looks at. The tray may be a little
    // short for a tall stack, so a piece counts when its centre is within half
    // a piece of the tray's box.
    const tagged = await page.evaluate(() => {
      const tray = document.querySelector('[data-testid="off-you"]');
      if (!tray) return 0;
      const t = tray.getBoundingClientRect();
      return [
        ...document.querySelectorAll<HTMLElement>('[data-testid="checker"][data-color="white"][data-loc="off"]'),
      ].filter((el) => {
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        return (
          r.width > 0 &&
          x >= t.left - r.width / 2 &&
          x <= t.right + r.width / 2 &&
          y >= t.top - r.height / 2 &&
          y <= t.bottom + r.height / 2
        );
      }).length;
    });
    if (tagged >= 3) return tagged;
    return page.evaluate(() => {
      const tray = document.querySelector('[data-testid="off-you"]');
      if (!tray) return 0;
      const t = tray.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLElement>("body *")].filter((el) => {
        if (el === tray || el.contains(tray) || el.children.length > 0) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 6 || r.height < 3 || !el.checkVisibility()) return false;
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        return x >= t.left && x <= t.right && y >= t.top && y <= t.bottom;
      }).length;
    });
  };
  await expect.poll(shownOff, { timeout: 5_000 }).toBeGreaterThanOrEqual(3);
});

test("[F12] REQ-NEWGAME — the win is announced", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid="board"]'), "[needs: F01]").toBeVisible();

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
  await expect(page.locator('[data-testid="board"]'), "[needs: F01]").toBeVisible();

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
  await expect(page.locator('[data-testid="board"]'), "[needs: F01]").toBeVisible();

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

test("[F14] REQ-ANIM — checker motion is animated", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid="board"]'), "[needs: F01]").toBeVisible();

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

// [F86] REQ-HINT — a move hint looks like a faint green piece. Jerry,
// 2026-10-18, on the old hint-animation check: "remove that requirement … if
// anything the hints should be piece sized and dimmed and light green or
// something. no animation." Read from the hint's own computed style: its box
// against the pieces on the board, a light-green paint (its fill, border or
// text), dimmed (that paint, or the hint, see-through), and no animation.
test("[F86] REQ-HINT — a move hint looks like a faint green piece", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid="board"]'), "[needs: F01]").toBeVisible();

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
  const pickedUp = await pickUpAPiece(page, page.locator('[data-testid="hint"]'));
  expect(pickedUp, "[needs: REQ-HINT/hint F03]").toBeTruthy();
  const hint = page.locator('[data-testid="hint"]').first();
  await expect(hint, "[needs: REQ-HINT/hint F03 F25]").toBeVisible();

  const look = await hint.evaluate((el) => {
    const css = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const rgba = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const paints = [css.backgroundColor, css.borderTopColor, css.color]
      .map(rgba)
      .filter((v) => v.length >= 3 && (v.length < 4 || v[3] > 0));
    const green = paints.filter(([R, G, B]) => G >= 150 && G > R + 30 && G > B + 30);
    return {
      size: Math.max(r.width, r.height),
      green: green.length > 0,
      dim: Number(css.opacity) < 1 || green.some((v) => v.length >= 4 && v[3] < 1),
      animationName: css.animationName,
      animationDuration: css.animationDuration,
    };
  });
  const piece = await page
    .locator('[data-testid="checker"][data-loc="6"]')
    .first()
    .evaluate((el) => el.getBoundingClientRect().width);
  expect(
    look.size >= 0.7 * piece && look.size <= 1.3 * piece,
    `[aspect: size] [needs: F41] a hint is ${Math.round(look.size)} px across and a piece ${Math.round(piece)} px`,
  ).toBe(true);
  expect(look.green, "[aspect: green] the hint is not light green").toBe(true);
  expect(look.dim, "[aspect: dim] the hint is drawn solid, not dimmed").toBe(true);
  expect(hintAnimates(look), "[aspect: still] the hint animates").toBe(false);
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

  // Console errors at either address are F27's (the team's): a player never
  // sees the console. This check is the board a player sees at each address.
  for (const origin of origins) {
    await page.goto(`${origin}/`);
    await expect(
      page.getByTestId("board"),
      `[needs: F01] board never appeared at ${origin}`,
    ).toBeVisible();

    // State actually arrived and rendered — not just an empty shell.
    await expect(
      page.getByTestId("point"),
      `[needs: REQ-RENDER/point] points never rendered at ${origin}`,
    ).toHaveCount(24);
    await expect(
      page.getByTestId("checker"),
      `[needs: REQ-RENDER/checker] checkers never rendered at ${origin}`,
    ).toHaveCount(30);
  }
});
