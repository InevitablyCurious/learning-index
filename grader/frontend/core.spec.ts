import { type Locator, type Page } from "@playwright/test";
import { expect, playerClick, playerClickUntilShown, setupState, test } from "./fixtures.ts";

type Player = "white" | "black";
type Difficulty = "easy" | "medium" | "hard";
type Move = { from: number; to: number; die: number };

interface ApiState {
  remainingDice: number[];
  legalMoves: Move[];
  turnOver: boolean;
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

// The words a hint's label is made of: "3", "off", or, in a longer label that
// still names its die, "3" and "10" from "3→10". The build prompt asks for the
// die's value; a label that also says where the piece lands still names it, as
// a button reading "Roll Dice" names Roll (F44, Jerry 2026-09-26). Run
// 1790641632 labelled its hints "3→10" and would have been told the hints
// "don't tell me which die they use".
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

  // Each hint names a die it uses: a label with no 3 or 5 in it (run
  // 1790641632's "10" and "8", the landing points) tells the player nothing.
  for (const text of hintTexts) {
    if (text === "off") continue;
    expect(
      hintWords(text).some((word) => word === "3" || word === "5"),
      `hint "${text}" names no die it uses`,
    ).toBe(true);
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
  await expect(message, "[needs: G06]").toContainText(/no legal move|pass/i);
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

test("[F16] REQ-RELOAD — whose turn survives a reload", async ({ page }) => {
  await openApp(page);
  await postJson<ApiState>(page, "/api/new", {});
  await setupState(page, { turn: "black" });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();
  await expect(page.getByTestId("checker")).toHaveCount(30);
  const state = await readState(page);
  expect(state.turn).toBe("black");
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
