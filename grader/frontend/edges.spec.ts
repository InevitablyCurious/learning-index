import { type Page } from "@playwright/test";
import { expect, pickUpAPiece, playerClick, playerClickUntilShown, rollAndCheck, settledHintPositions, setupState, test } from "./fixtures.ts";
import { BASE_URL } from "../lib/harness.ts";
import { isPainted, readPointBoxes } from "./board-geometry.ts";

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
  // Any element tagged "bar" on screen, as readBarBox reads the bar: run
  // 1795098772's page drew its bar as two tagged halves, and a strict
  // one-element check was told "When i hit an opponent piece i don't see it
  // go up onto the bar" about a piece sitting on the bar.
  await expect(page.locator('[data-testid="bar"]').filter({ visible: true }).first(), "[needs: REQ-RENDER/bar]").toBeVisible();
  const onBar = page.locator('[data-testid="checker"][data-color="black"][data-loc="bar"]');
  // None drawn is the gate's own line. More than the one on the bar is its own:
  // history build sel-eebccfa9eeea8b2b drew each bar piece once in every tagged
  // half, so one hit showed two pieces, and "i don't see it go up onto the bar"
  // was false.
  await expect(onBar).not.toHaveCount(0);
  await expect
    .poll(() => onBar.count(), {
      message: "[aspect: extra] the computer had one piece on the bar, and the board drew more than one there",
      timeout: 3_000,
    })
    .toBe(1);
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
  await expect(whiteBarChecker, "[aspect: onbar] [needs: F09] the player's piece on the bar is not drawn there").toHaveCount(1);
  // The roll animates before the state is applied: wait for the dice to stop
  // changing so the bar checker is clickable when we click it.
  await expect
    .poll(async () => {
      const dice = page.locator('[data-testid="die"]');
      if ((await dice.count()) < 2) return false;
      const a = await dice.evaluateAll((els) => els.map((el) => el.innerHTML).join("|"));
      await page.waitForTimeout(200);
      const b = await dice.evaluateAll((els) => els.map((el) => el.innerHTML).join("|"));
      return a === b;
    }, "[needs: F93] the dice never held still after the roll")
    .toBe(true);
  const hints = page.locator('[data-testid="hint"]');
  // Clicked again until hints show, as a player clicks again: a click landing
  // while the roll still redraws the board is wiped by the redraw. The golden
  // failed here twice under the image's parallel workers (rebuilds at 547e701
  // and 9a0c86e), and a check that fails the reference can tell a correct
  // build its bar piece showed no hints.
  await playerClickUntilShown(whiteBarChecker, hints);
  await expect(hints, "[aspect: hints] [needs: F03]").toHaveCount(2);
  // Where they are drawn, judged as F75 judges a piece on a point: the point
  // under each hint's centre is one the piece can come in on. Jerry, playing
  // run 1795117307's build (2026-11-19): "one of the pieces was sent to the
  // bar. when i clicked to move the piece the hint shows on the bar" — its page
  // drew every entry hint on the bar itself, and no check looked at where.
  const entries = new Set<number>(
    ((await fetchState(page)).legalMoves as { from: number; to: number }[]).filter((m) => m.from === 0).map((m) => m.to),
  );
  const boxes = await readPointBoxes(page);
  const centres = await hints.evaluateAll((els) =>
    els
      .filter((el) => (el as HTMLElement).checkVisibility())
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }),
  );
  const astray = centres
    .map((h) => boxes.find((pt) => h.x >= pt.x && h.x <= pt.x + pt.width && h.y >= pt.y && h.y <= pt.y + pt.height)?.num ?? null)
    .filter((at) => at === null || !entries.has(at))
    .map((at) => (at === null ? "no point" : `point ${at}`));
  expect(
    astray,
    `[aspect: entryhint] [needs: F03] the bar piece's hints sit on ${astray.join(", ")}, not on the points it can come in on (${[...entries].join(", ")})`,
  ).toEqual([]);
  await playerClick(hints.first());

  await expect(whiteBarChecker, "[aspect: reentry] [needs: F03 F45]").toHaveCount(0);
  const state = await fetchState(page);
  expect(state.bar.white, "[needs: G06] the server still holds the piece on the bar").toBe(0);

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
  // The tray a player looks at: the player's own end of it (off-you) when that
  // has a size, else the tray it sits in (off-tray). Run 1794863925's off-you
  // was a 0x0 point in the middle of the tray, and "doesn't show up in the off
  // tray" was told three rounds running while its pieces hung half past the
  // tray's edge over the buttons beside it.
  const trayBox = () =>
    page.evaluate(() => {
      for (const sel of ['[data-testid="off-you"]', '[data-testid="off-tray"]']) {
        const el = document.querySelector(sel);
        const r = el?.getBoundingClientRect();
        if (r && r.width >= 2 && r.height >= 2) return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }
      return null;
    });
  await expect.poll(trayBox, { message: "[needs: REQ-RENDER/off-tray] no off tray drawn", timeout: 5_000 }).not.toBeNull();
  // The three pieces already off, as a player sees them: checkers tagged off,
  // or pieces drawn in the player's tray without the tag. Run 1790650821 drew
  // three discs there untagged and was told they "don't show up in the off
  // tray". A tray with nothing drawn in it is this gate's finding.
  const offPieces = async () => {
    // Tagged and drawn: inside when the piece lies within the tray's sides (a
    // sixth of a piece over is the drawing's slack) and its centre within half
    // a piece of the top and bottom (the tray may be a little short for a tall
    // stack). Run 1791408711's build put them in the bar's column, x 480
    // against a tray at x 956: not in the tray a player looks at.
    const tagged = await page.evaluate(() => {
      const tray = ['[data-testid="off-you"]', '[data-testid="off-tray"]']
        .map((sel) => document.querySelector(sel)?.getBoundingClientRect())
        .find((r) => r && r.width >= 2 && r.height >= 2);
      const drawn = [
        ...document.querySelectorAll<HTMLElement>('[data-testid="checker"][data-color="white"][data-loc="off"]'),
      ]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0);
      if (!tray) return { drawn: drawn.length, inside: 0 };
      const inside = drawn.filter((r) => {
        const slack = r.width / 6;
        const y = r.top + r.height / 2;
        return (
          r.left >= tray.left - slack &&
          r.right <= tray.right + slack &&
          y >= tray.top - r.height / 2 &&
          y <= tray.bottom + r.height / 2
        );
      }).length;
      return { drawn: drawn.length, inside };
    });
    if (tagged.inside >= 3 || tagged.drawn >= 3) return tagged;
    const untagged = await page.evaluate(() => {
      const tray = ['[data-testid="off-you"]', '[data-testid="off-tray"]']
        .map((sel) => document.querySelector(sel))
        .find((el) => {
          const r = el?.getBoundingClientRect();
          return r && r.width >= 2 && r.height >= 2;
        });
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
    return { drawn: Math.max(tagged.drawn, untagged), inside: untagged };
  };
  await expect.poll(async () => (await offPieces()).drawn, { timeout: 5_000 }).toBeGreaterThanOrEqual(3);
  expect((await offPieces()).inside, "[aspect: outside] pieces taken off are drawn past the edges of the off tray").toBeGreaterThanOrEqual(3);
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
  await expect(page.locator('[data-testid="board"]'), "[needs: F01]").toBeVisible();

  // A player is told nothing announced the win only when nothing on the page
  // did — the banner or the end pop-up. A pop-up saying "You win" over a banner
  // that doesn't is the brief's banner wording, the team's to tell: one line for
  // both told such a build "there's no win message or victory popup".
  // Capitals are not the player's concern: "You win!" says it as well as "Win".
  const modalOverlay = page.locator('[data-testid="modalOverlay"]');
  const popupShown = () => modalOverlay.isVisible().catch(() => false);
  const banner = () => page.locator('[data-testid="message"]').innerText().catch(() => "");
  const popupTitle = async () =>
    (await popupShown()) ? await page.locator('[data-testid="modalTitle"]').innerText().catch(() => "") : "";
  // Announced is anything a player reads as their win: the player is white, so
  // "White wins!" tells them as plainly as "You win" (the brief's exact words
  // are the banner aspect below, the team's).
  await expect
    .poll(async () => /\bwin|\bwon\b|victor/i.test(await banner()) || /win/i.test(await popupTitle()), "the win was not announced on the page")
    .toBe(true);
  if (await popupShown()) {
    await expect(page.locator('[data-testid="modalTitle"]'), "[aspect: popup] the end pop-up's title does not say win").toContainText(/win/i);
  }
  const said = await banner();
  expect(/you win/i.test(said), `[aspect: banner] the win banner (message) reads "${said.trim()}", not "You win"`).toBe(true);
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
  // New Game as a player reaches it: the end pop-up's own button when the
  // pop-up is up, else the page's. Run 1793780359's pop-up covered newGameBtn,
  // a forced click landed on the pop-up, and the player would have been told
  // the board never reset — its pop-up's New Game reset all 30.
  const inPopup = page.getByTestId("modalBtns").getByRole("button", { name: /new game/i });
  if (await inPopup.isVisible().catch(() => false)) await inPopup.click();
  else await page.locator('[data-testid="newGameBtn"]').click({ force: true });

  // Each part of the reset is its own line: the pieces back where a game starts,
  // the end pop-up out of sight (what a player sees) and the brief's hidden class
  // on it (what the team's software reads). One hedged line for all of them told
  // builds "the pieces are still where the last game left them, or the victory
  // popup is still open" when only one was true, or neither to a player.
  const reset = "[aspect: pieces] after New Game the pieces are not in the starting position";
  await expect(page.locator('[data-testid="checker"]'), reset).toHaveCount(30);
  await expect(
    page.locator('[data-testid="checker"][data-color="white"][data-loc="24"]'),
    reset,
  ).toHaveCount(2);
  await expect(
    page.locator('[data-testid="checker"][data-color="white"][data-loc="13"]'),
    reset,
  ).toHaveCount(5);
  await expect(
    page.locator('[data-testid="checker"][data-color="white"][data-loc="8"]'),
    reset,
  ).toHaveCount(3);
  await expect(
    page.locator('[data-testid="checker"][data-color="white"][data-loc="6"]'),
    reset,
  ).toHaveCount(5);
  await expect(
    page.locator('[data-testid="checker"][data-color="black"][data-loc="1"]'),
    reset,
  ).toHaveCount(2);
  await expect(
    page.locator('[data-testid="checker"][data-color="black"][data-loc="12"]'),
    reset,
  ).toHaveCount(5);
  await expect(
    page.locator('[data-testid="checker"][data-color="black"][data-loc="17"]'),
    reset,
  ).toHaveCount(3);
  await expect(
    page.locator('[data-testid="checker"][data-color="black"][data-loc="19"]'),
    reset,
  ).toHaveCount(5);

  const overlay = page.locator('[data-testid="modalOverlay"]');
  await expect(overlay, "[aspect: popup] after New Game the end pop-up is still on screen").toBeHidden();
  await expect(
    overlay,
    "[aspect: hiddenclass] after New Game the end pop-up is out of sight but modalOverlay does not carry the hidden class",
  ).toHaveClass(/(^|\s)hidden(\s|$)/);
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
  expect(pickedUp, "[needs: REQ-HINT/hint F03 F60]").toBeTruthy();
  // Measured once the hints hold still, on one a player can see: run 1795223874
  // (a2) redraws its hints after a pick, and the first hint element, visible a
  // moment before, read "a hint is 0 px across" in 1 of 3 grades.
  await settledHintPositions(page);
  const hint = page.locator('[data-testid="hint"]').filter({ visible: true }).first();
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
    };
  });
  const piece = await page
    .locator('[data-testid="checker"][data-loc="6"]')
    .first()
    .evaluate((el) => el.getBoundingClientRect().width);
  expect(
    look.size >= 0.7 * piece && look.size <= 1.3 * piece,
    `[aspect: size] [needs: F41 F03] a hint is ${Math.round(look.size)} px across and a piece ${Math.round(piece)} px`,
  ).toBe(true);
  expect(look.green, "[aspect: green] [needs: F03] the hint is not light green").toBe(true);
  expect(look.dim, "[aspect: dim] [needs: F03] the hint is drawn solid, not dimmed").toBe(true);
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
