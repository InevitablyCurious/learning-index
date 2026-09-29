import { type Locator, type Page } from "@playwright/test";
import { expect, pickUpAPiece, playerClick, playerClickUntilShown, setupState, test } from "./fixtures.ts";
import { readColumnBox } from "./board-geometry.ts";

type Player = "white" | "black";
type Difficulty = "easy" | "medium" | "hard";
type Move = { from: number; to: number; die: number };

interface ApiState {
  remainingDice: number[];
  legalMoves: Move[];
  turnOver: boolean;
  phase: "roll" | "move" | "gameover" | "doubleOffered";
  difficulty: Difficulty;
  message: string;
  pip: { white: number; black: number };
  cube: { value: number; owner: Player | null };
  turn: Player;
  score: { white: number; black: number };
  dice: number[];
  canDouble: boolean;
  points: number[];
  bar: { white: number; black: number };
  off: { white: number; black: number };
}

const BAR = 0;
const OFF = 25;

async function postJson<T>(page: Page, path: string, data: unknown = {}): Promise<T> {
  const response = await page.request.post(path, { data });
  expect(response.ok(), `POST ${path} failed (${response.status()})`).toBeTruthy();
  return (await response.json()) as T;
}

async function readState(page: Page): Promise<ApiState> {
  return postJson<ApiState>(page, "/api/state", {});
}

async function openApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();
}

function locAttr(from: number): string {
  return from === BAR ? "bar" : String(from);
}

async function clickTopWhiteChecker(page: Page, from: number): Promise<boolean> {
  const checker = page.locator(
    `[data-testid="checker"][data-color="white"][data-loc="${locAttr(from)}"]`,
  );
  const count = await checker.count();
  if (count === 0) return false;
  await playerClick(checker.nth(count - 1));
  return true;
}

async function waitForHints(page: Page, timeout = 1500): Promise<boolean> {
  try {
    await expect
      .poll(async () => page.getByTestId("hint").count(), { timeout })
      .toBeGreaterThan(0);
    return true;
  } catch {
    return false;
  }
}

async function revealHints(page: Page, legalMoves: Move[], preferredFrom?: number): Promise<void> {
  const orderedFroms = [
    preferredFrom,
    ...legalMoves.map((m) => m.from),
  ].filter((value, index, list): value is number => {
    return typeof value === "number" && list.indexOf(value) === index;
  });

  for (const from of orderedFroms) {
    const clicked = await clickTopWhiteChecker(page, from);
    if (!clicked) continue;

    const shown = await waitForHints(page);
    if (shown) return;
  }

  throw new Error(`Could not reveal hints. Tried from-points: ${orderedFroms.join(", ")}`);
}

function normalizeHint(raw: string): string {
  return raw.replace(/\s+/g, "").toLowerCase();
}

// The words a hint's label is made of: "3", "off", or "3" and "10" from
// "3→10". The checks that look for the hint of one die read its words, so a
// "1" is never found inside a "10" and a "3→10" hint is still the 3's. Whether
// a label says more than its die is F04's finding alone.
function hintWords(raw: string): string[] {
  return normalizeHint(raw).split(/[^0-9a-z]+/).filter(Boolean);
}

function expectOwnerLabelToMatchState(ownerText: string, owner: Player | null): void {
  const normalized = ownerText.trim().toLowerCase();
  if (owner === null) {
    expect(normalized).toMatch(/center|centre|centr/);
    return;
  }

  if (owner === "white") {
    expect(normalized).toMatch(/you|your|yours|white/);
    return;
  }

  expect(normalized).toMatch(/ai|black|opponent/);
}

async function readInt(locator: Locator): Promise<number> {
  // A player reads the counter once it shows a number. Pages that fill it after
  // the game state arrives from the server show an empty box for a moment, and
  // reading it at that instant failed F06 for three rounds in two runs
  // (1789664067, 1789712833) while the page showed the right number.
  await expect(locator, "[aspect: format]").toHaveText(/^\s*-?\d+\s*$/);
  const text = (await locator.innerText()).trim();
  return Number.parseInt(text, 10);
}

function emptyPoints(): number[] {
  return new Array(26).fill(0);
}

// The pip counts of the position a state holds, counted by the grader: white
// travels 24 → 1, black 1 → 24, and a checker on the bar is 25 from home.
function pipsOf(state: ApiState): { white: number; black: number } {
  let white = 25 * state.bar.white;
  let black = 25 * state.bar.black;
  for (let p = 1; p <= 24; p++) {
    const n = state.points[p];
    if (n > 0) white += n * p;
    else if (n < 0) black += -n * (25 - p);
  }
  return { white, black };
}

test("[F01] REQ-RENDER — page loads and the board appears", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });

  page.on("pageerror", (err) => {
    pageErrors.push(err.stack ?? err.message);
  });

  await page.goto("/");
  // Found by its tag. A board drawn without the tag is the team's complaint
  // (the tag check names it), never "the board doesn't show up": run
  // 1790604214's third round drew its board and every piece, missing only the
  // board's tag, and was told exactly that.
  await expect(page.getByTestId("board"), "[needs: REQ-TESTID/testid.board]").toBeVisible();
});

test("[F27] REQ-RENDER — no console or page errors on load", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });

  page.on("pageerror", (err) => {
    pageErrors.push(err.stack ?? err.message);
  });

  await page.goto("/");

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("[F02] REQ-RENDER — start game renders full board", async ({ page }) => {
  await openApp(page);

  await postJson<ApiState>(page, "/api/new", {});
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  await expect(page.getByTestId("point")).toHaveCount(24);
  await expect(page.getByTestId("checker")).toHaveCount(30);
  await expect(page.locator('[data-testid="checker"][data-color="white"]')).toHaveCount(15);
  await expect(page.locator('[data-testid="checker"][data-color="black"]')).toHaveCount(15);
});

test("[F03] REQ-HINT — clicking a piece shows its moves", async ({ page }) => {
  await openApp(page);

  await postJson<ApiState>(page, "/api/new", {});
  await postJson<ApiState>(page, "/api/debug/roll", { dice: [6, 5] });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  await page.getByTestId("rollBtn").click();
  await expect
    .poll(async () => page.getByTestId("die").count())
    .toBeGreaterThanOrEqual(2);

  const state = await readState(page);
  // A roll that leaves no move is the movable-checker gate's complaint when it
  // fails too (a needs marker, harness/adapters/challenge/stages.py).
  expect(state.legalMoves.length, "[needs: REQ-HINT/hint]").toBeGreaterThan(0);
  await revealHints(page, state.legalMoves, state.legalMoves[0]?.from);

  const hints = page.getByTestId("hint");
  await expect.poll(async () => hints.count()).toBeGreaterThan(0);
});

test("[F25] REQ-HINT — a played move consumes a die", async ({ page }) => {
  await openApp(page);

  await postJson<ApiState>(page, "/api/new", {});
  await postJson<ApiState>(page, "/api/debug/roll", { dice: [6, 5] });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  await page.getByTestId("rollBtn").click();
  await expect
    .poll(async () => page.getByTestId("die").count(), "[needs: REQ-RENDER/die]")
    .toBeGreaterThanOrEqual(2);

  // Steps a player must get through before any die can be used up: a move to
  // make and a hint to click. When the gates that test those after an
  // ordinary roll fail too, the complaint is theirs (a needs marker,
  // harness/adapters/challenge/stages.py).
  const before = await readState(page);
  expect(before.legalMoves.length, "[needs: REQ-HINT/hint F03]").toBeGreaterThan(0);

  const move = before.legalMoves[0];
  try {
    await revealHints(page, before.legalMoves, move.from);
  } catch {
    // A no-hints outcome must fail on the [aspect: reveal] assertion below,
    // not as the helper's uncaught throw.
  }

  // A hint the player can see: one that is drawn but hidden cannot be clicked
  // by a player, and clicking it anyway reported "the die didn't go away" for
  // a move nobody could make (FIX-2 mutation M28).
  const reveal = "[aspect: reveal] [needs: REQ-HINT/hint F03]";
  const hints = page.getByTestId("hint");
  await expect.poll(async () => hints.count(), reveal).toBeGreaterThan(0);
  await expect(hints.first(), reveal).toBeVisible();

  const hintCount = await hints.count();
  let clicked = false;
  for (let i = 0; i < hintCount; i++) {
    const words = hintWords(await hints.nth(i).innerText());
    if ((move.to === OFF && words.includes("off")) || words.includes(String(move.die))) {
      // Clicked where it shows: a pulsing hint on top of a stack (fixtures.ts).
      await playerClick(hints.nth(i));
      clicked = true;
      break;
    }
  }

  if (!clicked) {
    await playerClick(hints.first());
  }

  // The click must play the move before a die can be used up. A click that
  // changes nothing on the board is this gate's own finding, told as the
  // move not registering — never as a die left over from a move that never
  // happened (FIX-2 mutation M13: the hint's click did nothing).
  const boardOf = (s: ApiState) => JSON.stringify([s.points, s.bar, s.off]);
  await expect.poll(async () => boardOf(await readState(page))).not.toBe(boardOf(before));

  const expectedRemaining = before.remainingDice.length - 1;
  await expect
    .poll(async () => {
      const state = await readState(page);
      return state.remainingDice.length;
    }, "[aspect: consume]")
    .toBe(expectedRemaining);

  const after = await readState(page);
  expect(after.remainingDice.length, "[aspect: consume]").toBe(expectedRemaining);
});

test("[F04] REQ-HINT — legal-move affordance + die attribution", async ({ page }) => {
  await openApp(page);

  await postJson<ApiState>(page, "/api/new", {});
  await postJson<ApiState>(page, "/api/debug/roll", { dice: [3, 5] });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  await page.getByTestId("rollBtn").click();
  await expect
    .poll(async () => page.getByTestId("die").count())
    .toBeGreaterThanOrEqual(2);

  const state = await readState(page);
  // A roll that leaves no move, or a checker that shows no hints, is the
  // complaint of the gates that test those steps when they fail too
  // (a needs marker, harness/adapters/challenge/stages.py).
  expect(state.legalMoves.length, "[needs: REQ-HINT/hint]").toBeGreaterThan(0);
  // The back piece on 13 first: at the opening a 3 and a 5 both move it, to
  // 10 and to 8, open on every board. Any other piece when it shows nothing.
  // Clicked again when a click lands while the dice still roll, as a player
  // does (fixtures.ts playerClickUntilShown): one click left 13 unjudged on
  // every build that takes clicks only once the dice land (FIX-27b: M88).
  const back = page.locator('[data-testid="checker"][data-color="white"][data-loc="13"]');
  const backCount = await back.count();
  if (backCount > 0) await playerClickUntilShown(back.nth(backCount - 1), page.getByTestId("hint"));
  const on13 = (await page.getByTestId("hint").count()) > 0;
  if (!on13) {
    try {
      await revealHints(page, state.legalMoves, state.legalMoves[0]?.from);
    } catch {
      // No hints must fail on the marked assertion below, not the helper's throw.
    }
  }

  const hints = page.getByTestId("hint");
  await expect
    .poll(async () => hints.count(), "[needs: REQ-HINT/hint F03]")
    .toBeGreaterThan(0);

  const hintTexts = (await hints.allInnerTexts()).map(normalizeHint).filter(Boolean);
  expect(hintTexts.length).toBeGreaterThan(0);

  // Each hint's text is the die it uses (the build prompt: "a hint's visible
  // text is the die value it would use, or "off" for bearing off"). A label
  // with no 3 or 5 in it (run 1790641632's "10" and "8", the landing points)
  // tells the player nothing. One that says more than its die is its own
  // complaint: Jerry, playing run 1790661859's build, found its "2→11" very
  // confusing.
  for (const text of hintTexts) {
    if (text === "off") continue;
    expect(
      hintWords(text).some((word) => word === "3" || word === "5"),
      `hint "${text}" names no die it uses`,
    ).toBe(true);
    expect(text === "3" || text === "5", `[aspect: extra] hint "${text}" says more than its die`).toBe(true);
  }

  // A hint for each die the piece can use (the build prompt, chunk-04: "A hint
  // appears for each playable die when a movable checker is selected"). Run
  // 1790414346's game offered its first die only: the piece on 13 showed a 3,
  // and its 5 came up only once the 3 was played. Judged on the piece on 13
  // only, whose two moves are open on every board.
  if (on13) {
    const dice = new Set(hintTexts.flatMap((text) => hintWords(text)));
    expect(
      dice.has("3") && dice.has("5"),
      `[aspect: perdie] after rolling 3-5 the back piece on 13 shows hints for: ${[...dice].join(", ")}`,
    ).toBe(true);
  }
});

test("[F45] REQ-HINT — clicking where a piece can go plays the move", async ({ page }) => {
  // The build prompt: "Clicking one of your checkers shows you where it can
  // go, and clicking one of those destinations plays that move." The other
  // move checks click the hint itself. Jerry, playing run 1790661859's build,
  // clicked the point the piece could go to: the game put the piece back down,
  // and only a small circle drawn half off the bottom of the screen played the
  // move. A player clicks where the piece will sit — on the destination point,
  // as far in from the board's edge as the first piece of each stack in that
  // row (a point's checkers stack from the edge). A game that draws its hint
  // there, as the reference does, or that plays the move from a click on the
  // point, passes.
  //
  // One spot proves too little: a build that only makes the hint token itself
  // playable passes it while a click elsewhere on the destination's column
  // does nothing. So the click lands on three distinct spots up point 11's
  // column — near its middle-ward end, its centre, and its edge-ward end —
  // all away from the hint token, which sits at the very edge (~0.9+ of the
  // way down). A successful click CONSUMES the move (the piece arrives, the
  // selection clears, the dice advance), so each spot gets its own fresh
  // setup.
  for (const f of [0.25, 0.5, 0.75]) {
    await openApp(page);

    await postJson<ApiState>(page, "/api/new", {});
    await postJson<ApiState>(page, "/api/debug/roll", { dice: [2, 1] });
    await page.reload();
    await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

    await page.getByTestId("rollBtn").click();
    await expect
      .poll(async () => page.getByTestId("die").count(), "[needs: REQ-RENDER/die]")
      .toBeGreaterThanOrEqual(2);

    // With 2-1 at the opening the back piece on 13 has one move, to the empty 11
    // (black holds 12). A game that doesn't offer it is the dice checks' finding.
    const before = await readState(page);
    expect(before.legalMoves.some((m) => m.from === 13 && m.to === 11), "[needs: G03]").toBe(true);

    const hints = page.getByTestId("hint");
    const back = page.locator('[data-testid="checker"][data-color="white"][data-loc="13"]');
    const backCount = await back.count();
    if (backCount > 0) await playerClickUntilShown(back.nth(backCount - 1), hints);
    await expect.poll(async () => hints.count(), "[needs: REQ-HINT/hint F03]").toBeGreaterThan(0);

    // Point 11 sits in the bottom row: its column runs from the board's middle
    // (box.y, the triangle's tip) down to the board's edge (box.y + box.height,
    // where the stack and the hint token sit).
    const box = await readColumnBox(page, 11);
    expect(box, "[needs: REQ-TESTID/point REQ-TESTID/checker]").not.toBeNull();
    await page.mouse.click(box!.centerX, box!.y + box!.height * f);

    // A game whose hints play no move either is told that first (F25).
    await expect
      .poll(async () => (await readState(page)).points[11], {
        message: "[needs: F25] the piece did not go to 11",
        timeout: 3_000,
      })
      .toBeGreaterThan(0);
  }
});

test("[F60] REQ-HINT — picking a piece up from its column", async ({ page }) => {
  // The build prompt: "Clicking one of your checkers shows you where it can
  // go." A player aims at the piece, but a piece is a small disc standing in a
  // tall column, and a click that lands on the column away from the disc is
  // still a click on that piece's point: it must pick the piece up, not
  // silently do nothing. With nothing selected, click point 13's column near
  // its middle-ward end — its checkers stack from the top edge down, so the
  // spot is away from every one of them — and require the hints.
  await openApp(page);

  await postJson<ApiState>(page, "/api/new", {});
  await postJson<ApiState>(page, "/api/debug/roll", { dice: [2, 1] });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  await page.getByTestId("rollBtn").click();
  await expect
    .poll(async () => page.getByTestId("die").count(), "[needs: REQ-RENDER/die]")
    .toBeGreaterThanOrEqual(2);

  // At the 2-1 opening the back piece on 13 is a movable source.
  const state = await readState(page);
  expect(state.legalMoves.some((m) => m.from === 13), "[needs: G03]").toBe(true);

  // Point 13 is a top-row point: its checkers stack from the top edge (box.y)
  // downward. The opening 5-checker stack fills most of the column, so a fixed
  // fraction lands on a checker. Click just below the deepest checker's bottom
  // edge instead — a bare stretch of the point's own column (the triangle tip
  // end, toward the board's middle) — so only the column can pick the piece up.
  const box = await readColumnBox(page, 13);
  expect(box, "[needs: REQ-TESTID/point REQ-TESTID/checker]").not.toBeNull();
  const spot = await page.evaluate(() => {
    const point = document.querySelector('[data-testid="point"][data-point="13"]');
    if (!point) return null;
    const pb = point.getBoundingClientRect();
    let deepest = pb.y;
    for (const el of document.querySelectorAll('[data-testid="checker"][data-loc="13"]')) {
      const r = el.getBoundingClientRect();
      deepest = Math.max(deepest, r.y + r.height);
    }
    // A few pixels below the deepest checker's bottom, clamped inside the column.
    return { x: pb.x + pb.width / 2, y: Math.min(deepest + 6, pb.y + pb.height - 4) };
  });
  expect(spot).not.toBeNull();
  const x = spot!.x;
  const y = spot!.y;

  // Click the spot the way a player does when the game is not ready yet:
  // click, look for the hints, click again if none came up — the dice are
  // still rolling for a moment after they are on screen, and a game that
  // ignores a click in that moment is right (playerClickUntilShown's rule,
  // at a bare column spot).
  const hints = page.getByTestId("hint");
  for (let i = 0; i < 8; i++) {
    await page.mouse.click(x, y);
    try {
      await expect(hints.first()).toBeAttached({ timeout: 1500 });
      break;
    } catch {
      // not ready yet — a player would click again
    }
  }

  await expect
    .poll(async () => hints.count(), "[needs: REQ-HINT/hint F03]")
    .toBeGreaterThan(0);
});

test("[G05] REQ-HIGHER-DIE — use higher die", async ({ page }) => {
  // Judged on screen, as a player meets it. Run 1790627099's server listed the
  // smaller number's move in this spot while its page showed only the 4, and
  // the player was told the game "showed me a move with the smaller number":
  // the gate had read the server's list. One white piece on 13 and a
  // three-deep black block on 6: with a 3 and a 4 only one number plays, and it
  // must be the 4. (Three deep, not two: a two-deep block trips the
  // land-on-a-block mutation M12, whose own line is G04's.)
  await openApp(page);
  const points = emptyPoints();
  points[13] = 1;
  points[6] = -3;
  await setupState(page, {
    points,
    bar: { white: 0, black: 0 },
    off: { white: 14, black: 12 },
    turn: "white",
    phase: "move",
    dice: [3, 4],
    remainingDice: [3, 4],
    message: "",
  });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  // The player picks the piece up and reads the hints it shows. A piece that
  // shows none offers the smaller number nothing: not this gate's finding.
  const hints = page.getByTestId("hint");
  const piece = page.locator('[data-testid="checker"][data-color="white"][data-loc="13"]');
  if ((await piece.count()) > 0) await playerClickUntilShown(piece.last(), hints, 3);
  const shown = await hints.evaluateAll((els) =>
    els
      .map((el, i) => ({ i, text: (el as HTMLElement).innerText, on: (el as HTMLElement).checkVisibility() }))
      .filter((hint) => hint.on),
  );
  const smaller = shown.find((hint) => hintWords(hint.text).includes("3"));
  if (smaller) {
    const board = async () => {
      const s = await readState(page);
      return JSON.stringify([s.points, s.bar, s.off]);
    };
    const before = await board();
    await playerClick(hints.nth(smaller.i));
    const played = await expect
      .poll(board, { timeout: 2_000 })
      .not.toBe(before)
      .then(
        () => true,
        () => false,
      );
    expect(played, "the game played the smaller number").toBe(false);
  }
  expect(smaller === undefined, "[aspect: offered] the game showed a hint for the smaller number").toBe(true);
});

test("[F05] REQ-TURN — no-legal-move notice", async ({ page }) => {
  await openApp(page);

  const points = emptyPoints();
  points[23] = -2; // black blocks white entry for die 2 (25-2=23)
  points[21] = -2; // black blocks white entry for die 4 (25-4=21)
  points[24] = -11; // remaining black checkers — the golden client requires exactly 15 per side
  points[1] = 14; // 14 white in home; the 15th white checker is on the bar (below)

  await setupState(page, {
    points,
    bar: { white: 1, black: 0 },
    off: { white: 0, black: 0 },
    turn: "white",
    phase: "roll",
    dice: [],
    remainingDice: [],
    message: "",
  });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  await postJson<ApiState>(page, "/api/debug/roll", { dice: [2, 4] });
  await page.getByTestId("rollBtn").click();

  // A player with no move exists only once pieces come in off the bar where
  // they should (G06): run 1790633807's entered at the wrong end.
  const message = page.getByTestId("message");
  await expect(message).toBeVisible();
  await expect(message, "[needs: G06]").not.toHaveText(/^\s*$/);
  await expect(message, "[needs: G06]").toContainText(/no moves available/i);
});

test("[F24] REQ-TURN — stuck turn state", async ({ page }) => {
  await openApp(page);

  const points = emptyPoints();
  points[23] = -2; // black blocks white entry for die 2 (25-2=23)
  points[21] = -2; // black blocks white entry for die 4 (25-4=21)
  points[24] = -11; // remaining black checkers — the golden client requires exactly 15 per side
  points[1] = 14; // 14 white in home; the 15th white checker is on the bar (below)

  await setupState(page, {
    points,
    bar: { white: 1, black: 0 },
    off: { white: 0, black: 0 },
    turn: "white",
    phase: "roll",
    dice: [],
    remainingDice: [],
    message: "",
  });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  await postJson<ApiState>(page, "/api/debug/roll", { dice: [2, 4] });
  await page.getByTestId("rollBtn").click();

  const whiteBarChecker = page.locator(
    '[data-testid="checker"][data-color="white"][data-loc="bar"]',
  );
  await expect(whiteBarChecker).toHaveCount(1);
  // The bar column div overlays the checker (and it isn't selectable in a stuck
  // state anyway) — force past the pointer-interception to prove no hints appear.
  await whiteBarChecker.first().click({ force: true });
  // Stuck only once pieces come in off the bar where they should (G06): run
  // 1790633807's entered at the wrong end and showed hints there.
  await expect(page.getByTestId("hint"), "[needs: G06]").toHaveCount(0);

  const state = await readState(page);
  expect(state.turnOver, "[needs: G06]").toBe(true);
  expect(state.legalMoves, "[needs: G06]").toHaveLength(0);
});

test("[F47] REQ-TURN — the turn waits for End Turn", async ({ page }) => {
  // The turn no longer ends by itself after a move: it stays white's until End
  // Turn is clicked, and Undo keeps working the whole time. A position white
  // can move in — the opening shape, mirrored — so a forced [6,5] gives two
  // plies and "done moving" is a real choice, never a stuck turn.
  test.setTimeout(90_000);
  await openApp(page);

  const points = emptyPoints();
  points[1] = 2;
  points[12] = 5;
  points[17] = 3;
  points[19] = 5;
  points[24] = -2;
  points[13] = -5;
  points[8] = -3;
  points[6] = -5;

  await setupState(page, {
    points,
    bar: { white: 0, black: 0 },
    off: { white: 0, black: 0 },
    turn: "white",
    phase: "roll",
    dice: [],
    remainingDice: [],
    message: "",
  });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  await postJson<ApiState>(page, "/api/debug/roll", { dice: [6, 5] });
  await page.getByTestId("rollBtn").click();
  // The roll lands and white has a move to play.
  await expect
    .poll(
      async () => (await readState(page)).legalMoves.length,
      "[needs: F03] [needs: F25] the forced [6,5] roll gave white no move",
    )
    .toBeGreaterThan(0);

  // Play the plies the way a player does — pick up a movable checker, click a
  // hint — until the server says the turn is over.
  const hints = page.getByTestId("hint");
  const playUntilTurnOver = async (told: string): Promise<void> => {
    for (let i = 0; i < 4; i++) {
      const s = await readState(page);
      if (s.turnOver) return;
      const picked = await pickUpAPiece(page, hints);
      expect(picked, `[needs: F03] [needs: F25] ${told}: no checker could be picked up`).toBe(true);
      await expect(hints.first(), "[needs: F03]").toBeVisible();
      await playerClick(hints.first());
      await expect
        .poll(
          async () => (await readState(page)).remainingDice.length,
          `[needs: F25] ${told}: a move did not consume a die`,
        )
        .toBeLessThan(s.remainingDice.length);
    }
    await expect
      .poll(async () => (await readState(page)).turnOver, `[needs: F25] ${told}: white could not finish the roll's moves`)
      .toBe(true);
  };
  await playUntilTurnOver("playing the roll");

  // The heart of the gate: wait well past the old auto-end window and the turn
  // must still be white's, still in the move phase — it ends only at End Turn.
  await page.waitForTimeout(1600);
  const held = await readState(page);
  expect(held.turn, "the turn ended by itself before End Turn was clicked").toBe("white");
  expect(held.phase, "the turn left the move phase by itself").toBe("move");

  // Undo still works while the turn waits: the button is live and clicking it
  // gives a die back.
  const undoBtn = page.getByTestId("undoBtn");
  await expect(undoBtn, "[aspect: undo] [needs: G23] Undo was not available while the turn waited").toBeEnabled();
  const beforeUndo = (await readState(page)).remainingDice.length;
  await undoBtn.click();
  await expect
    .poll(async () => (await readState(page)).remainingDice.length, "[aspect: undo] [needs: G23] Undo did not give a die back")
    .toBeGreaterThan(beforeUndo);

  // Undo cleared turnOver, so play the die back to finish the turn again — then
  // End Turn, and only End Turn, hands over to the computer.
  await playUntilTurnOver("after Undo");

  const endTurnBtn = page.getByTestId("endTurnBtn");
  await expect(endTurnBtn, "[aspect: endturn] End Turn was not available once the moves were done").toBeEnabled();
  await endTurnBtn.click();

  // The turn hands over: the server shows black (the computer) at some point
  // after End Turn. Sticky, so a quick computer turn cannot slip between polls.
  let sawBlack = false;
  await expect
    .poll(
      async () => {
        const s = await readState(page);
        if (s.turn === "black") sawBlack = true;
        return sawBlack;
      },
      { message: "[aspect: endturn] the turn did not hand over to the computer after End Turn", timeout: 6000 },
    )
    .toBe(true);
});

test("[F48] REQ-TURN — a no-move roll passes by itself", async ({ page }) => {
  // A roll with no legal move shows the dice and "No moves available" for about
  // a second, then hands the turn to the computer on its own — no End Turn
  // click. White's whole stack on 12 with black holding 6 and 7 blocks both a
  // 6 (12->6) and a 5 (12->7), so a forced [6,5] leaves white nothing, off the bar.
  await openApp(page);

  const points = emptyPoints();
  points[12] = 15;
  points[6] = -2;
  points[7] = -2;
  points[24] = -11;

  await setupState(page, {
    points,
    bar: { white: 0, black: 0 },
    off: { white: 0, black: 0 },
    turn: "white",
    phase: "roll",
    dice: [],
    remainingDice: [],
    message: "",
  });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  await postJson<ApiState>(page, "/api/debug/roll", { dice: [6, 5] });
  await page.getByTestId("rollBtn").click();

  // The dice stay up…
  await expect
    .poll(async () => page.getByTestId("die").count(), "[needs: REQ-RENDER/die]")
    .toBeGreaterThan(0);

  // …and the notice says "No moves available".
  const message = page.getByTestId("message");
  await expect(message, "[aspect: notice] the no-move notice did not say 'No moves available'").toContainText(
    /no moves available/i,
  );

  // It holds for about a second: wait, then the same words are still up and the
  // turn is still white's (it has not passed yet).
  await page.waitForTimeout(1000);
  await expect(message, "[aspect: notice] the no-move notice did not stay up for a second").toContainText(
    /no moves available/i,
  );
  expect((await readState(page)).turn, "[aspect: notice] the turn passed before the notice had been up for a second").toBe(
    "white",
  );

  // Then it passes by itself: without touching End Turn, the computer's turn
  // begins. Sticky, so a quick computer turn cannot slip between polls.
  let sawBlack = false;
  await expect
    .poll(
      async () => {
        const s = await readState(page);
        if (s.turn === "black") sawBlack = true;
        return sawBlack;
      },
      { message: "the no-move turn never passed to the computer by itself", timeout: 6000 },
    )
    .toBe(true);
});

test("[F06] REQ-PIPUI — pip display cross-checked vs engine", async ({ page }) => {
  await openApp(page);

  await postJson<ApiState>(page, "/api/new", {});
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  const openingDomWhite = await readInt(page.getByTestId("pipWhite"));
  const openingDomBlack = await readInt(page.getByTestId("pipBlack"));
  const openingState = await readState(page);

  expect(openingDomWhite, "[aspect: sync]").toBe(openingState.pip.white);
  expect(openingDomBlack, "[aspect: sync]").toBe(openingState.pip.black);
  // What a player can check: the numbers on screen against the pieces on the
  // board. A wrong opening counted right is G01's complaint, never this one
  // (run 1790349319: 139/178 on a wrong setup was told "the wrong numbers for
  // the position on the board"); a wrong counting formula is G02's.
  const openingPips = pipsOf(openingState);
  expect(openingDomWhite, "[aspect: value] [needs: G02]").toBe(openingPips.white);
  expect(openingDomBlack, "[aspect: value] [needs: G02]").toBe(openingPips.black);

  const custom = emptyPoints();
  custom[6] = 5;
  custom[4] = 5;
  custom[19] = -5;
  custom[21] = -5;

  await setupState(page, {
    points: custom,
    bar: { white: 0, black: 0 },
    off: { white: 5, black: 5 },
    turn: "white",
    phase: "roll",
    dice: [],
    remainingDice: [],
    message: "",
  });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  const customDomWhite = await readInt(page.getByTestId("pipWhite"));
  const customDomBlack = await readInt(page.getByTestId("pipBlack"));
  const customState = await readState(page);

  expect(customDomWhite, "[aspect: sync]").toBe(customState.pip.white);
  expect(customDomBlack, "[aspect: sync]").toBe(customState.pip.black);
});

test("[F34] REQ-CUBEUI — a new game shows the cube at one, centered", async ({ page }) => {
  await openApp(page);

  await postJson<ApiState>(page, "/api/new", {});
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  await expect(page.getByTestId("cubeVal")).toHaveText("1");
  const openingOwnerLabel = await page.getByTestId("cubeOwner").innerText();
  expect(openingOwnerLabel.toLowerCase()).toMatch(/center|centre|centr/);
});

test("[F07] REQ-CUBEUI — cube UI", async ({ page }) => {
  await openApp(page);

  await postJson<ApiState>(page, "/api/new", {});
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  await postJson<ApiState>(page, "/api/double", {});
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();
  await expect(page.getByTestId("cubeVal")).toHaveText("2");

  const state = await readState(page);
  expect(state.cube.value).toBe(2);
  expect(state.cube.owner).not.toBeNull();

  const ownerLabel = await page.getByTestId("cubeOwner").innerText();
  expectOwnerLabelToMatchState(ownerLabel, state.cube.owner);
});

test("[F46] REQ-DOUBLE-DECLINE — the decline pop-up says you won", async ({ page }) => {
  // Judged on screen, as a player meets it: the double goes through the button
  // so the page's own handler shows the pop-up — posting /api/double directly
  // would bypass the modal this gate reads. One white checker a roll from home
  // and all fifteen black on the bar put the AI's win probability far below
  // every difficulty's take point, so the decline (and its announcement) is
  // deterministic.
  await openApp(page);
  const points = emptyPoints();
  points[1] = 1;
  await setupState(page, {
    points,
    bar: { white: 0, black: 15 },
    off: { white: 14, black: 0 },
    turn: "white",
    phase: "roll", // the client may only double in the roll phase
    cube: { value: 1, owner: null },
    difficulty: "medium",
    winner: null,
    message: "",
  });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  await page.getByTestId("doubleBtn").click();
  await expect(page.getByTestId("modalTitle"), "[needs: F01] [needs: F07]").toContainText(/win/i);
});

// The internal math a double or take message must never show the player: a win
// chance, pip counts, a take point, a doubling window, an estimate, a
// percentage. The AI works all of it out; the person at the screen gets a plain
// sentence. Shared by F49 (the offer) and F50 (the answer).
const REASONING_ARTIFACTS = /(winning chance|win probability|pips?|take point|doubling window|estimates?|%)/i;

// Where a double is put to the player and answered. The build prompt names a
// pop-up only for the end of the game; a double offer, and the computer's answer
// to the player's double, may show in the message area the prompt names or in
// any pop-up, and the player answers with whatever buttons the page gives them.
// Run 1790661859's reference showed both in its end-of-game pop-up, and the
// first cut of these checks demanded that pop-up and its wording.
const TAKE = /\baccept|\btake\b(?!\s*back)/i;
const PASS = /\bdecline|\bpass\b|\bdrop\b|\brefuse|\breject/i;

async function shownDoubleText(page: Page): Promise<string> {
  const message = await page.getByTestId("message").innerText().catch(() => "");
  const overlay = page.getByTestId("modalOverlay");
  const popup = (await overlay.isVisible().catch(() => false)) ? await overlay.innerText().catch(() => "") : "";
  return `${message} ${popup}`.replace(/\s+/g, " ").trim();
}

function answerButton(page: Page, name: RegExp): Locator {
  return page.getByRole("button", { name }).filter({ visible: true }).first();
}

test("[F49] REQ-DOUBLE-OFFER — the doubling message reads like a person", async ({ page }) => {
  // A race black leads by 31 pips without dominating, so the hard AI's offer is
  // deterministic. It reaches the screen through the page's own handler when End
  // Turn hands the turn over — posting /api/ai directly would bypass the pop-up
  // this gate reads. The off trays pad both sides to fifteen checkers, the
  // count the golden client draws (F05's comment); borne-off checkers add no
  // pips, so the AI's decision is the same as the bare points give.
  await openApp(page);
  const points = emptyPoints();
  points[1] = 1;
  points[6] = 10;
  points[19] = -5;
  await setupState(page, {
    points,
    bar: { white: 0, black: 0 },
    off: { white: 4, black: 10 },
    turn: "white",
    phase: "move",
    dice: [6, 5],
    remainingDice: [],
    turnOver: true,
    cube: { value: 1, owner: null },
    difficulty: "hard",
    message: "",
  });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();
  await page.getByTestId("endTurnBtn").click();

  await expect
    .poll(async () => /double|offer/i.test(await shownDoubleText(page)), {
      message: "[aspect: shown] [needs: F01] [needs: G12] nothing on screen said the computer was doubling",
      timeout: 10_000,
    })
    .toBe(true);
  const offered = await shownDoubleText(page);
  expect(
    offered,
    `[needs: F01] [needs: G12] the double offer showed internal math: "${offered}"`,
  ).not.toMatch(REASONING_ARTIFACTS);
});

test("[F50] REQ-DOUBLE-ANSWER — the computer's answer to a double is plain", async ({ page }) => {
  // Two answers, both deterministic and both read on screen — the pop-up and
  // the message bar, where the player meets them. From an even position the
  // medium AI takes; from F46's far-ahead position it passes.
  await openApp(page);
  await postJson(page, "/api/new", { difficulty: "medium" });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();
  await page.getByTestId("doubleBtn").click();
  await expect
    .poll(async () => TAKE.test(await shownDoubleText(page)), {
      message: "[aspect: shown] [needs: F01] [needs: F07] nothing on screen said the computer took the double",
      timeout: 10_000,
    })
    .toBe(true);
  const accepted = await shownDoubleText(page);
  expect(
    accepted,
    `[needs: F01] [needs: F07] the accept showed internal math: "${accepted}"`,
  ).not.toMatch(REASONING_ARTIFACTS);

  const points = emptyPoints();
  points[1] = 1;
  await setupState(page, {
    points,
    bar: { white: 0, black: 15 },
    off: { white: 14, black: 0 },
    turn: "white",
    phase: "roll",
    cube: { value: 1, owner: null },
    difficulty: "medium",
    winner: null,
    message: "",
  });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();
  await page.getByTestId("doubleBtn").click();
  await expect
    .poll(async () => PASS.test(await shownDoubleText(page)), {
      message: "[aspect: shown] [needs: F01] [needs: F07] nothing on screen said the computer passed the double",
      timeout: 10_000,
    })
    .toBe(true);
  const declined = await shownDoubleText(page);
  expect(
    declined,
    `[needs: F01] [needs: F07] the decline showed internal math: "${declined}"`,
  ).not.toMatch(REASONING_ARTIFACTS);
});

test("[F51] REQ-ENDSCREEN — the finishing pop-up names the winner and the stake", async ({ page }) => {
  // Who won and what the game was worth is the whole of the end-of-game pop-up
  // — the running match totals have no line here. The game is ended by the
  // player's own last bear-off (F53's move): a stage-5 check reached through a
  // double would tell a doubling fault as an end-screen one.
  await bearOffTheLastPiece(page);
  await expect(page.getByTestId("modalTitle"), "[needs: F53]").toContainText(/win/i, { timeout: 10_000 });
  const title = await page.getByTestId("modalTitle").innerText();
  const body = await page.getByTestId("modalBody").innerText();
  const message = await page.getByTestId("message").innerText();
  expect(
    `${title} ${body} ${message}`,
    `[aspect: points] the end pop-up never said what the game was worth: "${title}" / "${body}" / "${message}"`,
  ).toMatch(/point/i);
  expect(
    `${title} ${body} ${message}`.toLowerCase(),
    `the end pop-up showed the running match totals: "${title}" / "${body}" / "${message}"`,
  ).not.toContain("match score");
});

// The last move of a game, played the way a player plays it: pick up the one
// white checker left, click the "off" hint. Both sides hold exactly fifteen
// checkers (white: fourteen off + one on point 1; black: fifteen on point 24),
// the count the golden client draws — any other total leaves the page stuck on
// "Loading…". The die is a 1 and the checker sits on point 1, so the bear-off is
// the exact final move. Shared by F53 (the pop-up opens) and F51 (what it says).
async function bearOffTheLastPiece(page: Page): Promise<void> {
  await openApp(page);
  const points = emptyPoints();
  points[1] = 1;
  points[24] = -15;
  await setupState(page, {
    points,
    bar: { white: 0, black: 0 },
    off: { white: 14, black: 0 },
    turn: "white",
    phase: "move",
    dice: [1],
    remainingDice: [1],
    turnOver: false,
    cube: { value: 1, owner: null },
    difficulty: "hard",
    message: "",
  });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  const hints = page.getByTestId("hint");
  const picked = await pickUpAPiece(page, hints);
  expect(picked, "[needs: F03] the last white checker on point 1 could not be picked up").toBe(true);

  // The bear-off hint's visible text is exactly "off" (hintWords reads it as
  // ["off"]) — find it by what the player reads, then click where it shows.
  const hintCount = await hints.count();
  let offHint: Locator | null = null;
  for (let i = 0; i < hintCount; i++) {
    if (hintWords(await hints.nth(i).innerText()).includes("off")) {
      offHint = hints.nth(i);
      break;
    }
  }
  expect(offHint, '[needs: F03] [needs: F04] no hint said "off" for the bear-off').not.toBeNull();
  await playerClick(offHint!);
}

test("[F53] REQ-ENDGAME — bearing off the last piece opens the win pop-up", async ({ page }) => {
  // The server answers the last bear-off with a winner, and the page's own move
  // handler must open the end-of-game pop-up on the spot — a build that shows
  // it only after End Turn, or never, fails here.
  await bearOffTheLastPiece(page);
  await expect(page.getByTestId("modalTitle"), "[needs: F01] [needs: F12] [needs: G10]").toContainText(/win/i, {
    timeout: 10_000,
  });
});

test("[F52] REQ-BUTTONS — greyed-out buttons look clearly different", async ({ page }) => {
  // A player tells which buttons they may press by how they look. At a new
  // game Undo and End Turn cannot be used yet, while New Game and Roll can.
  // Judged on what is drawn, whatever styling produced it: each button's
  // screenshot, and how far its brightest marks stand from its darkest (the
  // lettering against its face). The buttons that cannot be used must be
  // clearly fainter than the least clear usable one. Run 1790661859's reference
  // drew its unusable buttons at 80 against a Roll button at 120 and the player
  // could not tell them apart; its fix draws them at 60.
  await openApp(page);
  await postJson(page, "/api/new", {});
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  const clarity = async (id: string): Promise<number> => {
    const button = page.getByTestId(id);
    await expect(button, `[needs: F38] the ${id} button is not on screen`).toBeVisible();
    const png = await button.screenshot();
    return page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const lum: number[] = [];
      for (let i = 0; i < data.length; i += 4) lum.push(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
      lum.sort((a, b) => a - b);
      return lum[Math.floor(lum.length * 0.99)] - lum[Math.floor(lum.length * 0.01)];
    }, png.toString("base64"));
  };

  const usable = Math.min(await clarity("newGameBtn"), await clarity("rollBtn"));
  const unusable = Math.max(await clarity("undoBtn"), await clarity("endTurnBtn"));
  expect(
    unusable,
    `buttons that cannot be used yet are drawn at ${unusable.toFixed(0)} against ${usable.toFixed(0)} for the least clear usable one`,
  ).toBeLessThanOrEqual(0.6 * usable);
});

test("[F08] REQ-TESTID — difficulty selector", async ({ page }) => {
  await openApp(page);

  // The dropdown a player uses: the tagged element when it is one, else the
  // <select> inside it (run 1790473524 tagged a box around its dropdown; the
  // page worked, and was told "When i change the difficulty level nothing
  // actually changes").
  const tagged = page.getByTestId("difficulty");
  const isSelect = await tagged.evaluate((el) => el.tagName === "SELECT").catch(() => false);
  const difficulty = isSelect ? tagged : tagged.locator("select").first();
  const newGameBtn = page.getByTestId("newGameBtn");
  // A player changes the difficulty only through controls they can see and
  // click: one the board is drawn over is the layout check's complaint (F38),
  // not a difficulty that doesn't change (run 1790439223 timed out clicking a
  // covered New Game and told "nothing actually changes").
  const reachable = (id: string) =>
    page.evaluate((testid) => {
      const el = document.querySelector(`[data-testid="${testid}"]`);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && (hit === el || el.contains(hit));
    }, id);
  expect(
    (await reachable("difficulty")) && (await reachable("newGameBtn")),
    "[needs: F38] the difficulty control or New Game is covered or off screen",
  ).toBe(true);

  await difficulty.selectOption("hard");
  await newGameBtn.click();
  await expect
    .poll(async () => {
      const state = await readState(page);
      return state.difficulty;
    })
    .toBe("hard");

  // A player picks again once the new game shows. The page draws the server's
  // reply a moment after the server has it, and a choice made inside that
  // moment is set back when the reply is drawn: run 1790474431's second round
  // set its dropdown from each reply, changed difficulty every time at a
  // player's pace, and was told "nothing actually changes" when the grader
  // chose again a few milliseconds after the server had the first game.
  await page.waitForTimeout(1000);
  await difficulty.selectOption("easy");
  await newGameBtn.click();
  await expect
    .poll(async () => {
      const state = await readState(page);
      return state.difficulty;
    })
    .toBe("easy");
});

test("[F54] REQ-RELOAD — the difficulty control shows the level you're playing", async ({ page }) => {
  // A player who chose a level reads it back on the control after a reload —
  // a page that loads the game but leaves the dropdown on its default tells
  // the player the wrong game is running.
  await openApp(page);
  await postJson<ApiState>(page, "/api/new", { difficulty: "hard" });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  // The dropdown a player reads: the tagged element when it is one, else the
  // <select> inside it — resolved the way F08 resolves it.
  const tagged = page.getByTestId("difficulty");
  const isSelect = await tagged.evaluate((el) => el.tagName === "SELECT").catch(() => false);
  const select = isSelect ? tagged : tagged.locator("select").first();
  await expect(select, "[needs: F01]").toHaveValue("hard");
});

test("[F55] REQ-RELOAD — the computer finishes its turn after a reload", async ({ page }) => {
  // A player who reloads mid-computer-turn comes back to the same game and
  // the computer plays on — a page that waits forever for a human who is not
  // there leaves the game stuck. The standard opening position with the
  // computer to roll; "easy" never offers a double, so its turn completes.
  await openApp(page);
  const points = emptyPoints();
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
    turn: "black",
    phase: "roll",
    dice: [],
    remainingDice: [],
    turnOver: false,
    cube: { value: 1, owner: null },
    difficulty: "easy",
    winner: null,
    message: "",
  });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  await expect.poll(async () => (await readState(page)).turn, {
    message: "[needs: F01] [needs: G25] the computer never finished its turn after a reload",
    timeout: 20_000,
  }).toBe("white");
});

test("[F56] REQ-RELOAD — the pending double offer shows again after a reload", async ({ page }) => {
  // A player faced with the computer's double offer who reloads comes back to
  // the same question — a page that drops the offer leaves the game waiting
  // for an answer nobody can give. Both choices must be on offer again.
  await openApp(page);
  const points = emptyPoints();
  points[1] = 1;
  points[6] = 10;
  points[19] = -5;
  await setupState(page, {
    points,
    bar: { white: 0, black: 0 },
    off: { white: 4, black: 10 },
    turn: "black",
    phase: "doubleOffered",
    doubleOfferedBy: "black",
    dice: [],
    remainingDice: [],
    turnOver: false,
    cube: { value: 1, owner: null },
    difficulty: "hard",
    winner: null,
    message: "",
  });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  // The offer is answered with whatever buttons the page gives — the build prompt
  // names no pop-up for a double, only that the offer shows again so the player
  // can accept or decline it.
  await expect(answerButton(page, TAKE), "[needs: F01] [needs: G12] no way to take the double after the reload").toBeVisible({
    timeout: 10_000,
  });
  await expect(answerButton(page, PASS), "[needs: F01] [needs: G12] no way to pass the double after the reload").toBeVisible();
});

test("[F16] REQ-RELOAD — whose turn survives a reload", async ({ page }) => {
  await openApp(page);
  await postJson<ApiState>(page, "/api/new", {});
  await setupState(page, { turn: "white" });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();
  await expect(page.getByTestId("checker")).toHaveCount(30);
  const state = await readState(page);
  expect(state.turn).toBe("white");
});

test("[F17] REQ-RELOAD — match score survives a reload", async ({ page }) => {
  await openApp(page);
  await postJson<ApiState>(page, "/api/new", {});
  await setupState(page, { score: { white: 3, black: 5 } });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();
  await expect(page.getByTestId("checker")).toHaveCount(30);
  const state = await readState(page);
  expect(state.score.white).toBe(3);
  expect(state.score.black).toBe(5);
});

test("[F18] REQ-RELOAD — dice values survive a reload", async ({ page }) => {
  await openApp(page);
  await postJson<ApiState>(page, "/api/new", {});
  await setupState(page, {
    phase: "move",
    turn: "white",
    dice: [5, 2],
    remainingDice: [5, 2],
  });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();
  await expect(page.getByTestId("checker")).toHaveCount(30);
  const state = await readState(page);
  expect([...state.dice].sort((a, b) => a - b)).toEqual([2, 5]);
});

test("[F19] REQ-RELOAD — difficulty survives a reload", async ({ page }) => {
  await openApp(page);
  await postJson<ApiState>(page, "/api/new", {});
  await setupState(page, { difficulty: "hard" });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();
  await expect(page.getByTestId("checker")).toHaveCount(30);
  const state = await readState(page);
  expect(state.difficulty).toBe("hard");
});

test("[F20] REQ-RELOAD — the doubling cube survives a reload", async ({ page }) => {
  await openApp(page);
  await postJson<ApiState>(page, "/api/new", {});
  await setupState(page, { cube: { value: 2, owner: "black" } });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();
  await expect(page.getByTestId("checker")).toHaveCount(30);
  const state = await readState(page);
  expect(state.canDouble).toBe(false);
});

test("[F21] REQ-RELOAD — remaining dice survive a reload", async ({ page }) => {
  await openApp(page);
  await postJson<ApiState>(page, "/api/new", {});
  await setupState(page, {
    phase: "move",
    turn: "white",
    dice: [5, 2],
    remainingDice: [2],
  });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();
  await expect(page.getByTestId("checker")).toHaveCount(30);
  const state = await readState(page);
  expect([...state.remainingDice].sort((a, b) => a - b)).toEqual([2]);
});
