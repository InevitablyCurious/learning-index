import { type Locator, type Page } from "@playwright/test";
import { expect, playerClick, setupState, test } from "./fixtures.ts";

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
  await expect(page.getByTestId("board")).toBeVisible();
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
  await expect(page.getByTestId("board")).toBeVisible();
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
  await expect(page.getByTestId("board")).toBeVisible();

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
  await expect(page.getByTestId("board")).toBeVisible();

  await page.getByTestId("rollBtn").click();
  await expect
    .poll(async () => page.getByTestId("die").count())
    .toBeGreaterThanOrEqual(2);

  const state = await readState(page);
  expect(state.legalMoves.length).toBeGreaterThan(0);
  await revealHints(page, state.legalMoves, state.legalMoves[0]?.from);

  const hints = page.getByTestId("hint");
  await expect.poll(async () => hints.count()).toBeGreaterThan(0);
});

test("[F25] REQ-HINT — a played move consumes a die", async ({ page }) => {
  await openApp(page);

  await postJson<ApiState>(page, "/api/new", {});
  await postJson<ApiState>(page, "/api/debug/roll", { dice: [6, 5] });
  await page.reload();
  await expect(page.getByTestId("board")).toBeVisible();

  await page.getByTestId("rollBtn").click();
  await expect
    .poll(async () => page.getByTestId("die").count())
    .toBeGreaterThanOrEqual(2);

  const before = await readState(page);
  expect(before.legalMoves.length).toBeGreaterThan(0);

  const move = before.legalMoves[0];
  await revealHints(page, before.legalMoves, move.from);

  const hints = page.getByTestId("hint");
  await expect.poll(async () => hints.count()).toBeGreaterThan(0);

  const hintCount = await hints.count();
  let clicked = false;
  for (let i = 0; i < hintCount; i++) {
    const text = normalizeHint(await hints.nth(i).innerText());
    if ((move.to === OFF && text.includes("off")) || text.includes(String(move.die))) {
      // Hints carry an infinite `pulse` animation, so Playwright never sees them
      // as "stable" — force the click past the stability check.
      await hints.nth(i).click({ force: true });
      clicked = true;
      break;
    }
  }

  if (!clicked) {
    await hints.first().click({ force: true });
  }

  const expectedRemaining = before.remainingDice.length - 1;
  await expect
    .poll(async () => {
      const state = await readState(page);
      return state.remainingDice.length;
    })
    .toBe(expectedRemaining);

  const after = await readState(page);
  expect(after.remainingDice.length).toBe(expectedRemaining);
});

test("[F04] REQ-HINT — legal-move affordance + die attribution", async ({ page }) => {
  await openApp(page);

  await postJson<ApiState>(page, "/api/new", {});
  await postJson<ApiState>(page, "/api/debug/roll", { dice: [3, 5] });
  await page.reload();
  await expect(page.getByTestId("board")).toBeVisible();

  await page.getByTestId("rollBtn").click();
  await expect
    .poll(async () => page.getByTestId("die").count())
    .toBeGreaterThanOrEqual(2);

  const state = await readState(page);
  expect(state.legalMoves.length).toBeGreaterThan(0);
  await revealHints(page, state.legalMoves, state.legalMoves[0]?.from);

  const hints = page.getByTestId("hint");
  await expect.poll(async () => hints.count()).toBeGreaterThan(0);

  const hintTexts = (await hints.allInnerTexts()).map(normalizeHint).filter(Boolean);
  expect(hintTexts.length).toBeGreaterThan(0);

  for (const text of hintTexts) {
    if (text === "off") continue;
    const parts = text.split("/");
    for (const part of parts) {
      expect(["3", "5"]).toContain(part);
    }
  }
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
  await expect(page.getByTestId("board")).toBeVisible();

  await postJson<ApiState>(page, "/api/debug/roll", { dice: [2, 4] });
  await page.getByTestId("rollBtn").click();

  const message = page.getByTestId("message");
  await expect(message).toBeVisible();
  await expect(message).not.toHaveText(/^\s*$/);
  await expect(message).toContainText(/no legal move|pass/i);
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
  await expect(page.getByTestId("board")).toBeVisible();

  await postJson<ApiState>(page, "/api/debug/roll", { dice: [2, 4] });
  await page.getByTestId("rollBtn").click();

  const whiteBarChecker = page.locator(
    '[data-testid="checker"][data-color="white"][data-loc="bar"]',
  );
  await expect(whiteBarChecker).toHaveCount(1);
  // The bar column div overlays the checker (and it isn't selectable in a stuck
  // state anyway) — force past the pointer-interception to prove no hints appear.
  await whiteBarChecker.first().click({ force: true });
  await expect(page.getByTestId("hint")).toHaveCount(0);

  const state = await readState(page);
  expect(state.turnOver).toBe(true);
  expect(state.legalMoves).toHaveLength(0);
});

test("[F06] REQ-PIPUI — pip display cross-checked vs engine", async ({ page }) => {
  await openApp(page);

  await postJson<ApiState>(page, "/api/new", {});
  await page.reload();
  await expect(page.getByTestId("board")).toBeVisible();

  const openingDomWhite = await readInt(page.getByTestId("pipWhite"));
  const openingDomBlack = await readInt(page.getByTestId("pipBlack"));
  const openingState = await readState(page);

  expect(openingDomWhite, "[aspect: sync]").toBe(openingState.pip.white);
  expect(openingDomBlack, "[aspect: sync]").toBe(openingState.pip.black);
  expect(openingDomWhite, "[aspect: value]").toBe(167);
  expect(openingDomBlack, "[aspect: value]").toBe(167);

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
  await expect(page.getByTestId("board")).toBeVisible();

  const customDomWhite = await readInt(page.getByTestId("pipWhite"));
  const customDomBlack = await readInt(page.getByTestId("pipBlack"));
  const customState = await readState(page);

  expect(customDomWhite, "[aspect: sync]").toBe(customState.pip.white);
  expect(customDomBlack, "[aspect: sync]").toBe(customState.pip.black);
});

test("[F07] REQ-CUBEUI — cube UI", async ({ page }) => {
  await openApp(page);

  await postJson<ApiState>(page, "/api/new", {});
  await page.reload();
  await expect(page.getByTestId("board")).toBeVisible();

  await expect(page.getByTestId("cubeVal")).toHaveText("1");
  const openingOwnerLabel = await page.getByTestId("cubeOwner").innerText();
  expect(openingOwnerLabel.toLowerCase()).toMatch(/center|centre|centr/);

  await postJson<ApiState>(page, "/api/double", {});
  await page.reload();
  await expect(page.getByTestId("board")).toBeVisible();
  await expect(page.getByTestId("cubeVal")).toHaveText("2");

  const state = await readState(page);
  expect(state.cube.value).toBe(2);
  expect(state.cube.owner).not.toBeNull();

  const ownerLabel = await page.getByTestId("cubeOwner").innerText();
  expectOwnerLabelToMatchState(ownerLabel, state.cube.owner);
});

test("[F08] REQ-TESTID — difficulty selector", async ({ page }) => {
  await openApp(page);

  const difficulty = page.getByTestId("difficulty");
  const newGameBtn = page.getByTestId("newGameBtn");

  await difficulty.selectOption("hard");
  await newGameBtn.click();
  await expect
    .poll(async () => {
      const state = await readState(page);
      return state.difficulty;
    })
    .toBe("hard");

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
  await expect(page.getByTestId("board")).toBeVisible();
  await expect(page.getByTestId("checker")).toHaveCount(30);
  const state = await readState(page);
  expect(state.turn).toBe("black");
});

test("[F17] REQ-RELOAD — match score survives a reload", async ({ page }) => {
  await openApp(page);
  await postJson<ApiState>(page, "/api/new", {});
  await setupState(page, { score: { white: 3, black: 5 } });
  await page.reload();
  await expect(page.getByTestId("board")).toBeVisible();
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
  await expect(page.getByTestId("board")).toBeVisible();
  await expect(page.getByTestId("checker")).toHaveCount(30);
  const state = await readState(page);
  expect([...state.dice].sort((a, b) => a - b)).toEqual([2, 5]);
});

test("[F19] REQ-RELOAD — difficulty survives a reload", async ({ page }) => {
  await openApp(page);
  await postJson<ApiState>(page, "/api/new", {});
  await setupState(page, { difficulty: "hard" });
  await page.reload();
  await expect(page.getByTestId("board")).toBeVisible();
  await expect(page.getByTestId("checker")).toHaveCount(30);
  const state = await readState(page);
  expect(state.difficulty).toBe("hard");
});

test("[F20] REQ-RELOAD — the doubling cube survives a reload", async ({ page }) => {
  await openApp(page);
  await postJson<ApiState>(page, "/api/new", {});
  await setupState(page, { cube: { value: 2, owner: "black" } });
  await page.reload();
  await expect(page.getByTestId("board")).toBeVisible();
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
  await expect(page.getByTestId("board")).toBeVisible();
  await expect(page.getByTestId("checker")).toHaveCount(30);
  const state = await readState(page);
  expect([...state.remainingDice].sort((a, b) => a - b)).toEqual([2]);
});
