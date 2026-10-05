// ─────────────────────────────────────────────────────────────────────────────
// STACK DRAWING — how a tall stack looks, and which piece moves through it.
//
// Four faults no other check can see:
//
// F57 — a point holds more checkers than it can draw. The contract: a
// numbered point draws at most six pieces, and from seven up the top
// (farthest-from-edge) piece carries a [data-testid="checkerCount"] badge
// whose text is the integer total. Two aspects, two distinct faults: the cap
// (how many pieces are drawn) and the count (what the badge reads).
//
// F58 — WHICH piece leaves a stack. The contract: the top one, the farthest
// from the board's edge. Final positions cannot judge this — a stack draws at
// the same spots whichever of its pieces left — so the check follows the
// pieces themselves: the page's own elements, held before the move. When one
// of them is the piece now on the destination, it must be the one that sat on
// top. A page that draws every piece afresh after a move leaves nothing to
// follow, and is not judged: a position in the page's element list is no
// identity (run 1790661859's build rebuilt every point on each render).
//
// F59 — WHERE an arrival lands. The contract: the far end of the destination
// stack — the top, farthest from the edge — never slid in at the edge. The
// mover is followed the same way; on a bottom-row point the far end is the
// smallest y.
//
// F71 — HOW a point's pieces are spaced along it. The contract: a stack a
// player reads keeps an EVEN pitch — the reference steps every piece one
// checker-size from the last from two to five pieces, and at six compresses
// the step just enough (~6%) that the sixth still fits the point. F57 counts
// the pieces a stack draws, and F43 asks only that they are not collapsed
// onto one spot; neither sees the spacing. Both halves are judged as
// proportions of the candidate's own drawn pitches, never in px: a
// differently-sized but correct board still passes.
//
// Rows: the top row (points 13-24) stacks DOWN from the top edge, so the
// farthest-from-edge piece has the LARGEST y; the bottom row (1-12) stacks UP
// from the bottom edge, so the farthest-from-edge piece has the SMALLEST y.
// ─────────────────────────────────────────────────────────────────────────────

import { type Page } from "@playwright/test";
import { expect, playerClickUntilShown, setupState, test } from "./fixtures.ts";
import { readCheckerBoxes, readCheckerShapes, typicalWidth, waitForBoardSettled } from "./board-geometry.ts";

interface ApiState {
  legalMoves: { from: number; to: number; die: number }[];
}

async function postJson<T>(page: Page, path: string, data: unknown = {}): Promise<T> {
  const response = await page.request.post(path, { data });
  expect(response.ok(), `POST ${path} failed (${response.status()})`).toBeTruthy();
  return (await response.json()) as T;
}

async function readState(page: Page): Promise<ApiState> {
  return postJson<ApiState>(page, "/api/state", {});
}

function emptyPoints(): number[] {
  return new Array(26).fill(0);
}

test("[F57] REQ-GEOMETRY — a tall stack shows six and a count", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  // Seven white checkers on point 13 — one more than a stack may draw — and
  // fifteen per side, as the client requires. No roll: the drawn board alone.
  const points = emptyPoints();
  points[13] = 7;
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
    phase: "roll",
    dice: [],
    remainingDice: [],
    message: "",
  });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  // CAP — at most six pieces drawn on the point. The seventh is the badge's
  // job below; a board that draws all seven shows a stack running into the
  // other row.
  // Counted as a player counts them: the pieces on screen (a page may keep
  // the surplus in the page, hidden).
  const drawn13 = await page.locator('[data-testid="checker"][data-loc="13"]').evaluateAll(
    (els) =>
      els.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (el as HTMLElement).checkVisibility({ opacityProperty: true, visibilityProperty: true });
      }).length,
  );
  expect(
    drawn13,
    `[aspect: cap] the game holds seven white checkers on point 13, and the board shows ${drawn13} on it`,
  ).toBeLessThanOrEqual(6);

  // COUNT — the total a player can read on the stack: the tagged badge, or any
  // number shown on point 13's column (a page that draws the number but misses
  // the tag still tells the player how many there are).
  const shown = await page.evaluate(() => {
    const tagged = [...document.querySelectorAll('[data-testid="checkerCount"]')].map((el) =>
      (el as HTMLElement).innerText.replace(/\s+/g, ""),
    );
    const column = document.querySelector('[data-testid="point"][data-point="13"]')?.getBoundingClientRect();
    const onColumn: string[] = [];
    if (column) {
      for (const el of document.querySelectorAll("body *")) {
        const h = el as HTMLElement;
        if (h.children.length > 0 || !h.checkVisibility()) continue;
        const text = (h.innerText ?? "").trim();
        if (!/^\d+$/.test(text)) continue;
        const r = h.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        if (cx >= column.x && cx <= column.x + column.width) onColumn.push(text);
      }
    }
    return { tagged, onColumn };
  });
  expect(
    shown.tagged.includes("7") || shown.onColumn.includes("7"),
    `[aspect: count] the game holds seven white checkers on point 13; tagged counts read ${JSON.stringify(shown.tagged)}, numbers shown on its column ${JSON.stringify(shown.onColumn)}`,
  ).toBe(true);
});

test("[F58] REQ-GEOMETRY — the top piece slides away", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  // The opening position with the roll fixed to 2-1, as F45 sets it: the back
  // piece on 13 has one move, to the empty 11 (black holds 12).
  await postJson(page, "/api/new", {});
  await postJson(page, "/api/debug/roll", { dice: [2, 1] });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  // A Roll shut at the start of a game is F61's finding, not this check's.
  const canRoll = await page.getByTestId("rollBtn").click({ trial: true, timeout: 5_000 }).then(() => true, () => false);
  expect(canRoll, "[needs: F61] the Roll button could not be clicked at the start of a game").toBe(true);
  await page.getByTestId("rollBtn").click();
  await expect
    .poll(async () => page.getByTestId("die").count(), "[needs: REQ-RENDER/die F61] no dice showed after the roll")
    .toBeGreaterThanOrEqual(2);

  const before = await readState(page);
  expect(before.legalMoves.some((m) => m.from === 13 && m.to === 11), "[needs: G03 G31]").toBe(true);

  // The pieces on 13 before the move, held in the page. Point 13 is a
  // top-row point: the stack grows down from the top edge, so the top piece —
  // the farthest from the edge, the one a player lifts — has the LARGEST y.
  const held = await page.evaluate(() => {
    const els = [...document.querySelectorAll('[data-testid="checker"][data-color="white"][data-loc="13"]')] as HTMLElement[];
    if (els.length === 0) return 0;
    const top = els.reduce((a, b) => (b.getBoundingClientRect().y > a.getBoundingClientRect().y ? b : a));
    (window as unknown as { __stack13: unknown }).__stack13 = { top, rest: els.filter((el) => el !== top) };
    return els.length;
  });
  expect(held, "[needs: F02] the opening position drew no white checker on point 13").toBeGreaterThan(0);

  const hints = page.getByTestId("hint");
  const back = page.locator('[data-testid="checker"][data-color="white"][data-loc="13"]');
  const backCount = await back.count();
  await playerClickUntilShown(back.nth(backCount - 1), hints);
  await expect.poll(async () => hints.count(), "[needs: REQ-HINT/hint]").toBeGreaterThan(0);

  // Click where the piece will sit — F45's own click: point 11's spot in the
  // bottom row, whose stacks start at the bottom edge, so the first piece of
  // a stack there is its lowest.
  const spot = await page.evaluate(() => {
    const point = document.querySelector('[data-testid="point"][data-point="11"]');
    if (!point) return null;
    const firsts: number[] = [];
    for (let p = 1; p <= 12; p++) {
      const stack = [...document.querySelectorAll(`[data-testid="checker"][data-loc="${p}"]`)].map((el) => {
        const r = el.getBoundingClientRect();
        return r.y + r.height / 2;
      });
      if (stack.length > 0) firsts.push(Math.max(...stack));
    }
    if (firsts.length === 0) return null;
    firsts.sort((a, b) => a - b);
    const box = point.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: firsts[Math.floor(firsts.length / 2)] };
  });
  expect(spot, "the board drew no point 11, and no bottom-row stack to aim the click at").not.toBeNull();
  await page.mouse.click(spot!.x, spot!.y);

  await expect
    .poll(async () => page.locator('[data-testid="checker"][data-color="white"][data-loc="11"]').count(), {
      message: "[needs: F45] the click where the piece could go played no move — no white checker carries data-loc 11",
      timeout: 3_000,
    })
    .toBeGreaterThan(0);

  // Which held piece is now on 11: the top one, another one, or none — a page
  // that draws every piece afresh leaves none to follow, and is not judged.
  await waitForBoardSettled(page);
  const moved = await page.evaluate(() => {
    const held = (window as unknown as { __stack13: { top: HTMLElement; rest: HTMLElement[] } }).__stack13;
    const onEleven = (el: HTMLElement) => el.isConnected && el.dataset.loc === "11";
    if (onEleven(held.top)) return "top";
    return held.rest.some(onEleven) ? "other" : "unfollowed";
  });
  expect(moved, "a piece other than the top of the stack on 13 is the one that moved to 11").not.toBe("other");
});

test("[F59] REQ-GEOMETRY — a piece lands at the far end", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  // A crafted position: one white on 11, one on 13, fifteen per side, black
  // out of the way on its opening points. The roll is fixed to a single 2, so
  // the piece on 13 has exactly one move — onto the point that ALREADY holds
  // a white checker.
  const points = emptyPoints();
  points[5] = 5;
  points[6] = 3;
  points[8] = 3;
  points[11] = 1;
  points[13] = 1;
  points[24] = 2;
  points[1] = -2;
  points[12] = -5;
  points[17] = -3;
  points[19] = -5;
  // White to move with a 2 left to play (the 6 of a 6-2 already used): the
  // piece on 13 has one move, onto 11.
  await setupState(page, {
    points,
    bar: { white: 0, black: 0 },
    off: { white: 0, black: 0 },
    turn: "white",
    phase: "move",
    dice: [2, 6],
    remainingDice: [2],
    turnOver: false,
    message: "",
  });
  await page.reload();
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  const before = await readState(page);
  expect(before.legalMoves.some((m) => m.from === 13 && m.to === 11), "[needs: G03]").toBe(true);

  // The mover and the piece already on 11, held in the page.
  const held = await page.evaluate(() => {
    const mover = document.querySelector('[data-testid="checker"][data-color="white"][data-loc="13"]');
    const resident = document.querySelector('[data-testid="checker"][data-color="white"][data-loc="11"]');
    (window as unknown as { __arrival: unknown }).__arrival = { mover, resident };
    return !!mover && !!resident;
  });
  expect(held, "[needs: F02] the position's pieces on 13 and 11 were not drawn").toBe(true);

  const hints = page.getByTestId("hint");
  const piece = page.locator('[data-testid="checker"][data-color="white"][data-loc="13"]');
  await playerClickUntilShown(piece.last(), hints);
  await expect.poll(async () => hints.count(), "[needs: REQ-HINT/hint]").toBeGreaterThan(0);

  // Play 13→11 by clicking the hint drawn over point 11. The point already
  // holds a checker, so the arrival spot — and the hint that plays it — sits
  // at the FAR end of that stack, not at the edge spot F45 aims at on an
  // empty point. With no hint tagged over the point, fall back to the far-end
  // spot itself: one checker-height farther from the bottom edge than the
  // piece already there.
  const dest = await page.evaluate(() => {
    const point = document.querySelector('[data-testid="point"][data-point="11"]');
    if (!point) return null;
    const pb = point.getBoundingClientRect();
    const hint = [...document.querySelectorAll('[data-testid="hint"]')].find((h) => {
      const r = h.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      return cx >= pb.x && cx <= pb.x + pb.width && cy >= pb.y && cy <= pb.y + pb.height;
    });
    if (hint) {
      const r = hint.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    const stack = [...document.querySelectorAll('[data-testid="checker"][data-loc="11"]')].map((el) =>
      el.getBoundingClientRect(),
    );
    if (stack.length === 0) return null;
    // Bottom row: the far end of the stack is the smallest y.
    const far = stack.reduce((a, b) => (b.y < a.y ? b : a));
    return { x: pb.x + pb.width / 2, y: far.y + far.height / 2 - far.height };
  });
  expect(dest, "the board drew no point 11, no hint over it, and no tagged checker on it").not.toBeNull();
  await page.mouse.click(dest!.x, dest!.y);

  await expect
    .poll(async () => page.locator('[data-testid="checker"][data-color="white"][data-loc="11"]').count(), {
      message: "[needs: F45] the click on point 11 played no move — 11 never gained the arriving checker",
      timeout: 3_000,
    })
    .toBeGreaterThanOrEqual(2);

  // Read the geometry only once the arrival has finished sliding into place.
  // Point 11 is a BOTTOM-row point: the stack grows up from the bottom edge,
  // so the far end is the SMALLEST y. When both held pieces are still the ones
  // on 11 the arrival must sit farther from the edge; a page that drew them
  // afresh leaves nothing to follow, and is not judged.
  await waitForBoardSettled(page);
  const landed = await page.evaluate(() => {
    const { mover, resident } = (window as unknown as { __arrival: { mover: HTMLElement; resident: HTMLElement } }).__arrival;
    const on = (el: HTMLElement) => el.isConnected && el.dataset.loc === "11";
    if (!on(mover) || !on(resident)) return "unfollowed";
    return mover.getBoundingClientRect().y < resident.getBoundingClientRect().y ? "far end" : "at the edge";
  });
  expect(landed, "the piece that arrived on 11 lands at the edge, below the piece already there").not.toBe("at the edge");
});

test("[F71] REQ-GEOMETRY — a point keeps an even pitch", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("board"), "[needs: F01]").toBeVisible();

  // Stacks of every height the spacing rule distinguishes — 2, 3, 4, 5 and
  // one of 6 — across both rows and both colours, fifteen per side as the
  // client requires. No roll: the drawn board alone.
  const points = emptyPoints();
  points[24] = 2;
  points[13] = 6;
  points[8] = 4;
  points[6] = 3;
  points[1] = -2;
  points[12] = -5;
  points[17] = -3;
  points[19] = -5;
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

  // Every stack's centre-Ys, read from the candidate's own drawn pieces.
  const boxes = await readCheckerBoxes(page);
  // The scale anchor: the median checker width across the board — the
  // candidate's own drawn piece size, so every reach below is a unit-free
  // ratio, never a px constant.
  const shapes = await readCheckerShapes(page);
  const width = typicalWidth(shapes);
  const centresAt = (loc: number): number[] =>
    boxes
      .filter((b) => b.loc === String(loc))
      .map((b) => b.centerY)
      .sort((a, b) => a - b);
  const pitchesOf = (ys: number[]): number[] => ys.slice(1).map((y, i) => y - ys[i]);

  // EVEN — a stack of two to five keeps one pitch: the spread between its
  // widest and narrowest step stays a small share of the step itself. The
  // 0.2 share sits far above sub-pixel rounding (the reference's steps are
  // equal to within ~1e-13 px) and far below a stack drawn ~50% uneven.
  const shortStacks = [
    { loc: 24, held: 2 },
    { loc: 1, held: 2 },
    { loc: 6, held: 3 },
    { loc: 17, held: 3 },
    { loc: 8, held: 4 },
    { loc: 12, held: 5 },
    { loc: 19, held: 5 },
  ];
  const evenPitches: number[] = [];
  for (const { loc, held } of shortStacks) {
    const ys = centresAt(loc);
    expect(
      ys.length,
      `[needs: F02] the game holds ${held} checkers on point ${loc}, and the board drew ${ys.length} of them — no pitch to read`,
    ).toBeGreaterThanOrEqual(2);
    const pitches = pitchesOf(ys);
    const avg = pitches.reduce((sum, p) => sum + p, 0) / pitches.length;
    const spread = Math.max(...pitches) - Math.min(...pitches);
    // A collapsed stack (avg 0) reads as fully uneven: F43 tells the collapse
    // itself, this tells a spacing no player can read.
    const unevenness = avg > 0 ? spread / avg : 1;
    expect(
      unevenness,
      `[aspect: uneven] [needs: F02] point ${loc} holds ${held} checkers, drawn at steps of ${pitches.map((p) => p.toFixed(1)).join(", ")} px — widest against narrowest differs by ${Math.round(unevenness * 100)}% of their ${avg.toFixed(1)} px average, where a player needs one even pitch`,
    ).toBeLessThanOrEqual(0.2);
    // REACH — evenness is relative; this is the step judged against the
    // piece itself. Extent 1.0 is one checker wide, each piece right
    // against the last. The 1.4 top sits far above the reference's ~1.0
    // (a slightly looser but packed board still passes) and far below a
    // space-between build stretched across the point; the 0.85 bottom is
    // a step tighter than a checker — crowded, not collapsed (F43 tells
    // the collapse itself). A board whose median piece has no width
    // leaves the ratio unreadable — any step against nothing reads as
    // spread, no step at all as bunched.
    const extent = width > 0 ? avg / width : avg > 0 ? Infinity : 0;
    expect(
      extent,
      `[aspect: reach] [needs: F02] point ${loc} holds ${held} checkers, drawn at steps of ${extent.toFixed(2)} checker-widths — crowded at the edge, where a player needs each piece one checker-width against the last`,
    ).toBeGreaterThan(0.85);
    expect(
      extent,
      `[aspect: reach] [needs: F02] point ${loc} holds ${held} checkers, drawn at steps of ${extent.toFixed(2)} checker-widths — spread across the whole point, where a player needs each piece one checker-width against the last`,
    ).toBeLessThan(1.4);
    evenPitches.push(avg);
  }

  // TIGHTER AT SIX — six pieces do not fit the point at the full pitch, so
  // the reference compresses the step (~5.8% at 1280x800). Asked as a ratio
  // of the candidate's own two pitches — at least 3% tighter, a threshold
  // between the reference's tightening and no change at all — never as a px
  // value: a differently-sized but correct board still passes.
  const sixYs = centresAt(13);
  expect(
    sixYs.length,
    `[needs: F02] the game holds six black checkers on point 13, and the board drew ${sixYs.length} of them — no pitch to read`,
  ).toBeGreaterThanOrEqual(2);
  const sixPitches = pitchesOf(sixYs);
  const sixPitch = sixPitches.reduce((sum, p) => sum + p, 0) / sixPitches.length;
  // REACH AT SIX — judged by pitch alone, and judged before the
  // compression ratio below: a six-stack drawn at the full step fails
  // both, but what the player sees is the reach, so the reach tells. No
  // bunched bound here — six pieces are compressed by design (the
  // reference reaches ~0.94 checker-widths); 1.10 sits between that and
  // the ~1.14 a spread six-stack measures.
  const sixExtent = width > 0 ? sixPitch / width : sixPitch > 0 ? Infinity : 0;
  expect(
    sixExtent,
    `[aspect: reach] [needs: F02] point 13 holds six checkers, drawn at steps of ${sixExtent.toFixed(2)} checker-widths — spread across the whole point, where a player needs six pieces kept tight enough to fit the point`,
  ).toBeLessThan(1.1);
  const evenPitch = evenPitches.reduce((sum, p) => sum + p, 0) / evenPitches.length;
  const tighter = sixPitch / evenPitch;
  expect(
    tighter,
    `[aspect: six] [needs: F02] point 13 holds six checkers, drawn at an average step of ${sixPitch.toFixed(1)} px against the ${evenPitch.toFixed(1)} px the two-to-five stacks keep — ${Math.round(tighter * 100)}% of it, where six pieces need a tighter pitch to fit the point`,
  ).toBeLessThanOrEqual(0.97);

  // CASCADE — even pitch says nothing about the horizontal: a stack can step
  // perfectly and still fan sideways off its point. Per stack, the span of
  // its pieces' centre-Xs must stay within half a checker width — far above
  // sub-pixel rounding, far below a fan a player reads as leaning. A lone
  // piece has no spread to read; a zero-width board leaves the ratio
  // unreadable and never fires here (the degenerate board is F41/reach's
  // complaint).
  const cascadeLimit = width > 0 ? 0.5 * width : Infinity;
  const stackLocs = [...new Set(boxes.map((b) => Number(b.loc)))].sort((a, b) => a - b);
  for (const loc of stackLocs) {
    const xs = boxes.filter((b) => b.loc === String(loc)).map((b) => b.centerX);
    if (xs.length < 2) continue;
    const spreadX = Math.max(...xs) - Math.min(...xs);
    expect(
      spreadX,
      `[aspect: cascade] [needs: F02] point ${loc} holds ${xs.length} checkers whose centres span ${spreadX.toFixed(1)} px side to side — over half a checker width, so they cascade off to the side, where a stack's pieces must line up in a single straight column over its point, not drift sideways across it`,
    ).toBeLessThanOrEqual(cascadeLimit);
  }
});
