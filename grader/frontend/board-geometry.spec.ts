// ─────────────────────────────────────────────────────────────────────────────
// REQ-GEOMETRY — the board must be DRAWN correctly, not merely completely.
//
// The count-only REQ-RENDER checks pass on a board whose bar sits at the far
// edge, whose rows are swapped, whose checkers float a point away from their
// own triangles. These four checks measure the rendered boxes
// (board-geometry.ts) and judge the geometry a player sees. Assertion messages
// state observed measurements only.
// ─────────────────────────────────────────────────────────────────────────────

import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import {
  boardMidY,
  pointWidth,
  readBarBox,
  readCheckerBoxes,
  readCheckerShapes,
  readCheckerVisibility,
  typicalWidth,
  overlaps,
  readOffTray,
  readPointBoxes,
  sampleTriangleOrientation,
  splitRows,
  type PointBox,
} from "./board-geometry.ts";

// The shared opening: load the app, start a fresh game through the API, reload
// so the board renders from that state.
async function openFreshBoard(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator('[data-testid="board"]')).toBeVisible();
  await page.request.post("/api/new", { data: {} });
  await page.reload();
  await expect(page.locator('[data-testid="board"]')).toBeVisible();
  // goto/reload wait for the drawn, settled board (fixtures.ts): run
  // 1790329339's page drew its points ~100 ms after the frame, and these checks
  // read an empty board ("found []", an average point height of NaN).
}

function leftToRight(row: PointBox[]): number[] {
  return [...row].sort((a, b) => a.x - b.x).map((p) => p.num);
}

test("[F28] REQ-GEOMETRY — points in board order", async ({ page }) => {
  await openFreshBoard(page);

  const points = await readPointBoxes(page);
  expect(points.length, "[needs: REQ-RENDER/point] expected 24 points to read").toBe(24);
  // Two rows, one above the other, before any order within them (FIX-24: run
  // 1790407044's rows sat side by side and passed on page order alone).
  const rows = splitRows(points);
  expect(
    rows.separated,
    `[aspect: rows] expected the points in two rows, one above the other; the 12 highest and the 12 lowest point centres are ${rows.gap.toFixed(0)} px apart`,
  ).toBeTruthy();
  const topRow = leftToRight(rows.top);
  const bottomRow = leftToRight(rows.bottom);

  expect(
    topRow,
    `expected top-row point numbers left-to-right 13,14,15,16,17,18,19,20,21,22,23,24, found ${topRow.join(",")}`,
  ).toEqual([13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  expect(
    bottomRow,
    `expected bottom-row point numbers left-to-right 12,11,10,9,8,7,6,5,4,3,2,1, found ${bottomRow.join(",")}`,
  ).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
});

test("[F29] REQ-GEOMETRY — bar between the halves", async ({ page }) => {
  await openFreshBoard(page);

  const bar = await readBarBox(page);
  // No bar at all is the bar render check's complaint.
  expect(bar, '[needs: REQ-RENDER/bar] expected a [data-testid="bar"] element on the board, found none').not.toBeNull();

  const points = await readPointBoxes(page);
  const LEFT_HALF = new Set([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  const RIGHT_HALF = new Set([1, 2, 3, 4, 5, 6, 19, 20, 21, 22, 23, 24]);
  const leftHalfRightEdge = Math.max(
    ...points.filter((p) => LEFT_HALF.has(p.num)).map((p) => p.x + p.width),
  );
  const rightHalfLeftEdge = Math.min(
    ...points.filter((p) => RIGHT_HALF.has(p.num)).map((p) => p.x),
  );
  const avgPointHeight = points.reduce((sum, p) => sum + p.height, 0) / points.length;

  // Where the bar is NOT is told as what the player sees there: out past the
  // points, drawn over some of them (run 1790329339: a strip down the middle,
  // told "at the edge"), or in a gap that is not the middle.
  const between = bar.x >= leftHalfRightEdge - 3 && bar.x + bar.width <= rightHalfLeftEdge + 3;
  const pointsLeft = Math.min(...points.map((p) => p.x));
  const pointsRight = Math.max(...points.map((p) => p.x + p.width));
  const outside = bar.x + bar.width <= pointsLeft + 1 || bar.x >= pointsRight - 1;
  const overPoints = points.some((p) => overlaps(bar, p));
  const where = between ? "" : outside ? "" : overPoints ? "[aspect: overlap] " : "[aspect: place] ";
  // Where the bar belongs is only defined once the rows form proper halves: on
  // a board whose rows do not line up it is the rows check's complaint (run
  // 1790345941: rows squeezed into opposite halves read as "the bar splits the
  // board in the wrong place" while the bar sat in the middle). And the halves
  // are found by number, so a board numbered out of order is the order check's
  // complaint (run 1790370051: a bottom row numbered the wrong way round made
  // the bar in the middle read as "in the wrong place").
  expect(
    between,
    `${where}[needs: F40 F28] expected the bar between the board halves, found bar x=${bar.x.toFixed(1)}..${(bar.x + bar.width).toFixed(1)} with the left half ending at x=${leftHalfRightEdge.toFixed(1)} and the right half starting at x=${rightHalfLeftEdge.toFixed(1)}`,
  ).toBeTruthy();
  expect(
    bar.height >= 1.8 * avgPointHeight,
    `[aspect: short] expected the bar to span both board rows, found bar height=${bar.height.toFixed(1)} vs average point height=${avgPointHeight.toFixed(1)}`,
  ).toBeTruthy();
});

test("[F31] REQ-GEOMETRY — checkers over their own points", async ({ page }) => {
  await openFreshBoard(page);

  const points = await readPointBoxes(page);
  const checkers = await readCheckerBoxes(page);
  // Each checker is found by its point's NUMBER, so this waits on the order
  // check: with the numbers wrong, a checker drawn where a player expects it
  // sits over the wrong number (a needs marker; stage 1 since Jerry's "first
  // look", 2026-09-26). A quarter of a point: a checker further off its
  // point's centre than that is visibly misplaced — when the whole piece shows.
  // Its box is what is measured, and a piece its point's triangle cuts down
  // shows only where the triangle is: run 1790425763's boxes sat 20 px off
  // centre while the slivers that showed sat on the tips, and "still floating
  // off to the side" was told. A piece that doesn't show whole is the
  // every-piece-shows check's complaint (F43). At 0.45, run 1790365975's
  // checkers passed 33 px off centre (0.43 point) — half off their points,
  // hanging over the frame.
  const tolerance = 0.25 * pointWidth(points);

  for (const checker of checkers) {
    const point = points.find((p) => p.num === Number(checker.loc));
    expect(
      point,
      `[needs: F28] expected a [data-testid="point"] matching checker loc=${checker.loc}, found none`,
    ).not.toBeUndefined();

    const dx = Math.abs(checker.centerX - point.centerX);
    expect(
      dx < tolerance,
      `[needs: F28 F43] expected checker loc=${checker.loc} drawn centered over point ${point.num}, found checker centerX=${checker.centerX.toFixed(1)} vs point centerX=${point.centerX.toFixed(1)} (off by ${dx.toFixed(1)}, tolerance ${tolerance.toFixed(1)})`,
    ).toBeTruthy();

    expect(
      checker.centerY >= point.y - 1 && checker.centerY <= point.y + point.height + 1,
      `[needs: F28] expected checker loc=${checker.loc} drawn within point ${point.num}'s vertical band, found checker centerY=${checker.centerY.toFixed(1)} vs band ${point.y.toFixed(1)}..${(point.y + point.height).toFixed(1)}`,
    ).toBeTruthy();
  }

  // Each stack starts at the edge of the board, at the wide end of its point,
  // as on every backgammon board: the piece nearest the rim lies within half a
  // piece of it (the reference: 2 px). Run 1790414346 hung every stack from
  // its triangle's tip, in the middle of the board, and passed the checks above.
  const pieces = await page.locator('[data-testid="checker"]').evaluateAll((els) =>
    els.flatMap((el) => {
      const loc = (el as HTMLElement).dataset.loc;
      if (loc === undefined || !/^\d+$/.test(loc)) return [];
      const r = el.getBoundingClientRect();
      return [{ num: Number(loc), top: r.y, bottom: r.y + r.height, size: Math.min(r.width, r.height) }];
    }),
  );
  const offRim = points.flatMap((p) => {
    const own = pieces.filter((c) => c.num === p.num);
    if (own.length === 0) return [];
    const size = Math.max(...own.map((c) => c.size));
    const gap =
      p.num >= 13
        ? Math.min(...own.map((c) => c.top)) - p.y
        : p.y + p.height - Math.max(...own.map((c) => c.bottom));
    return gap > 0.5 * size ? [p.num] : [];
  });
  expect(
    offRim,
    `[aspect: rim] [needs: F28] stacks that do not start at the edge of the board on points: ${offRim.join(", ")}`,
  ).toEqual([]);
});

test("[F32] REQ-GEOMETRY — off tray is visible", async ({ page }) => {
  await openFreshBoard(page);

  const tray = await readOffTray(page);
  expect(
    tray.exists,
    // No tray at all is the render check's complaint and an untagged one the
    // tag check's: one fault, one line (run 1790448423 was told both "nowhere
    // for my taken-off pieces" and "the off tray still isn't there").
    '[needs: REQ-RENDER/off-tray REQ-TESTID/off-tray] expected an [data-testid="off-tray"] element on the board, found none',
  ).toBeTruthy();
  expect(
    tray.visible,
    `expected the off tray to be visible, found width=${tray.width.toFixed(1)} height=${tray.height.toFixed(1)}`,
  ).toBeTruthy();
  // A tray a player can see is drawn: a see-through, outline-less, empty box
  // passed "visible" while nothing was on screen (run 1790341662).
  expect(tray.painted, "expected the off tray to be drawn (a fill, an outline or a label), found an empty see-through box").toBeTruthy();
  const points = await readPointBoxes(page);
  const under = points.filter((p) => overlaps(tray, p));
  expect(under.map((p) => p.num), "[aspect: overlap] the off tray is drawn over points").toEqual([]);
  // The tray is part of the board: checkers are borne off into the board's
  // own tray, inside its frame. Run 1790359593 moved the tray out of the board
  // into the button panel — clear of the points and past point 1, and so
  // passing everything below. Outside means most of it is: its centre lies
  // past the board's edge. A tray hanging a little past the board's box, drawn
  // over the board's own border so that it reads as the board's end, is on the
  // board to a player (FIX-25: run 1790410498, 17 of 80 px past the box, told
  // "The off tray is sitting outside the board").
  const board = await page.locator('[data-testid="board"]').first().boundingBox();
  expect(board, "[needs: F01] expected the board to read").not.toBeNull();
  const trayMidX = tray.x + tray.width / 2;
  const trayMidY = tray.y + tray.height / 2;
  const onBoard =
    trayMidX >= board!.x &&
    trayMidX <= board!.x + board!.width &&
    trayMidY >= board!.y &&
    trayMidY <= board!.y + board!.height;
  expect(
    onBoard,
    `[aspect: offboard] the off tray (x ${tray.x.toFixed(0)}..${(tray.x + tray.width).toFixed(0)}, y ${tray.y.toFixed(0)}..${(tray.y + tray.height).toFixed(0)}) lies outside the board (x ${board!.x.toFixed(0)}..${(board!.x + board!.width).toFixed(0)})`,
  ).toBeTruthy();
  // White bears off past point 1 and black past point 24 (the direction of
  // travel the build prompt gives), so the tray lies beyond the end of the
  // board those two points share. Run 1790352559 cleared the points by moving
  // a 10 px tray to the far end, past points 12 and 13, where no checker is
  // ever borne off. Point 1 is found by its number: a board numbered out of
  // order is the order check's complaint.
  const one = points.find((p) => p.num === 1);
  const twelve = points.find((p) => p.num === 12);
  expect(one && twelve, "[needs: REQ-RENDER/point] expected points 1 and 12 to read").toBeTruthy();
  const homeOnRight = one!.centerX > twelve!.centerX;
  const pastPointOne = homeOnRight
    ? tray.x >= Math.max(...points.map((p) => p.x + p.width)) - 3
    : tray.x + tray.width <= Math.min(...points.map((p) => p.x)) + 3;
  expect(
    pastPointOne,
    `[aspect: side] [needs: F28] the off tray (x ${tray.x.toFixed(0)}..${(tray.x + tray.width).toFixed(0)}) is not past points 1 and 24`,
  ).toBeTruthy();
  // It runs the full height of the board and holds a piece lying on its side
  // (the build prompt, chunk-04; Jerry 2026-09-25). Run 1790365975's tray was a
  // 19x106 px slot that passed everything above.
  const rowsTop = Math.min(...points.map((p) => p.y));
  const rowsSpan = Math.max(...points.map((p) => p.y + p.height)) - rowsTop;
  expect(
    tray.height,
    `[aspect: short] the off tray is ${tray.height.toFixed(0)} px tall; the rows of points span ${rowsSpan.toFixed(0)} px`,
  ).toBeGreaterThanOrEqual(0.9 * rowsSpan);
  const shapes = await readCheckerShapes(page);
  expect(shapes.length, "[needs: REQ-RENDER/checker] expected the checkers on the points to read").toBeGreaterThan(0);
  // The piece it must hold is the one on the board, at most the largest size a
  // piece may be: checkers drawn too big are the size check's complaint (F41),
  // not the tray's.
  const piece = Math.min(typicalWidth(shapes), 0.9 * pointWidth(points));
  expect(
    tray.width,
    `[aspect: narrow] the off tray is ${tray.width.toFixed(0)} px wide; a checker lying on its side needs ${piece.toFixed(0)} px`,
  ).toBeGreaterThanOrEqual(piece - 2);
});

test("[F41] REQ-GEOMETRY — checkers drawn as circles sized to their points", async ({ page }) => {
  await openFreshBoard(page);

  const points = await readPointBoxes(page);
  expect(points.length, "[needs: REQ-RENDER/point] expected 24 points to read").toBe(24);
  const shapes = await readCheckerShapes(page);
  expect(shapes.length, "[needs: REQ-RENDER/checker] expected the checkers on the points to read").toBeGreaterThan(0);
  // Each checker is a perfect circle, sized to about 80% of the width of the
  // point it sits on (the build prompt, chunk-04; Jerry 2026-09-25).
  const notCircles = shapes.filter((s) => !s.round || Math.abs(s.width - s.height) > Math.max(2, 0.04 * s.width));
  expect(
    notCircles.map((s) => `${s.loc}:${s.width.toFixed(0)}x${s.height.toFixed(0)}${s.round ? "" : " square-cornered"}`),
    `expected every checker drawn as a circle, found ${notCircles.length} of ${shapes.length} that are not`,
  ).toEqual([]);
  const pw = pointWidth(points);
  expect(pw, "[needs: F30] no point is drawn with any width").toBeGreaterThan(0);
  const share = typicalWidth(shapes) / pw;
  expect(share, `[aspect: big] checkers are ${Math.round(share * 100)}% of a point's width`).toBeLessThanOrEqual(0.9);
  expect(share, `[aspect: small] checkers are ${Math.round(share * 100)}% of a point's width`).toBeGreaterThanOrEqual(0.7);
});

// [F43] REQ-GEOMETRY — every piece shows. A player counts the pieces on a
// point by looking at them: a stack drawn on one spot shows as a single piece,
// and a piece cut down by what it is drawn inside shows as a sliver. Run
// 1790410498 drew every stack on one spot, inside its point's triangle clip;
// the size and placement checks passed, because they read the pieces' boxes,
// not what shows.
test("[F43] REQ-GEOMETRY — every piece shows", async ({ page }) => {
  await openFreshBoard(page);
  const pieces = await readCheckerVisibility(page);
  expect(pieces.length, "[needs: REQ-RENDER/checker] expected the checkers on the points to read").toBeGreaterThan(0);
  // A piece mostly past the edge of the window is the fit check's complaint.
  const shown = pieces.filter((c) => c.onScreen >= 0.5);
  // On one spot: another piece on the same point with its centre closer than
  // a third of a piece, so the stack shows as one piece.
  const onOneSpot = [
    ...new Set(
      shown
        .filter((c, i) =>
          shown.some(
            (d, j) =>
              j !== i &&
              d.loc === c.loc &&
              Math.hypot(d.centerX - c.centerX, d.centerY - c.centerY) < Math.min(c.width, d.width) / 3,
          ),
        )
        .map((c) => c.loc),
    ),
  ];
  expect(onOneSpot, `[aspect: stacked] pieces drawn on one spot on points: ${onOneSpot.join(", ")}`).toEqual([]);
  // Cut off: less than three quarters of a piece's on-screen circle shows, and
  // not because another piece is drawn over it (a stack drawn overlapping
  // still shows every piece). The reference shows every piece whole.
  const cut = [...new Set(shown.filter((c) => c.seen + c.under < 0.75 * c.onScreen).map((c) => c.loc))];
  expect(cut, `[aspect: clipped] pieces cut off on points: ${cut.join(", ")}`).toEqual([]);
});

test("[F30] REQ-GEOMETRY — triangles point inward", async ({ page }) => {
  await openFreshBoard(page);

  const points = await readPointBoxes(page);
  expect(points.length, "[needs: REQ-RENDER/point] expected 24 points to read").toBe(24);
  // The triangles are read from a screenshot of the window, so a board that
  // runs past it cannot be read: a page that scrolls is the fit check's
  // complaint (a needs marker, harness/adapters/challenge/stages.py), and a
  // board cut off without scrolling is this check's own finding. A taller
  // page once read below-the-fold points as "pointing outward" (FIX-3 M42).
  const view = page.viewportSize();
  const offscreen = points.filter(
    (p) => !view || p.x < -1 || p.y < -1 || p.x + p.width > view.width + 1 || p.y + p.height > view.height + 1,
  );
  expect(
    offscreen.map((p) => p.num),
    `[aspect: offscreen] [needs: F37] points past the edge of the window: ${offscreen.map((p) => p.num).join(", ")}`,
  ).toEqual([]);
  // A point the bar is drawn over shows the bar, not its triangle, so it is
  // not read here — the bar check tells that (FIX-3 M46: a bar over points 16
  // and 9 read as two "outward" triangles). Every other point is judged.
  const bar = await readBarBox(page);
  const tray = await readOffTray(page);
  const covers = (box: { x: number; y: number; width: number; height: number } | null, p: PointBox) =>
    box !== null && overlaps(box, p);
  const underBar = new Set(
    points.filter((p) => covers(bar, p) || (tray.exists && tray.painted && covers(tray, p))).map((p) => p.num),
  );
  const samples = await sampleTriangleOrientation(page, points);

  expect(samples.length, `expected 24 triangle samples, found ${samples.length}`).toBe(24);
  // Which edge is a point's rim depends on its row: with no two rows there is
  // no rim to read from, and the order check tells that (FIX-24: a top row
  // drawn beside the bottom one was told "The triangles point outward").
  const needsRows = splitRows(points).separated ? "" : "[needs: F28] ";

  // A point with no triangle: nothing painted at its rim or its inner end (run
  // 1790381377: every point a transparent box, told "The triangles point
  // outward"), or paint right across it at both ends — a block or a band, no
  // more a triangle to a player (run 1790388597 painted the board area in a
  // gradient). Every point, or some of them, told as such.
  const judged = samples.filter((s) => !underBar.has(s.num));
  const noTriangle = judged.filter((s) => s.shape === "none" || s.shape === "block").map((s) => s.num);
  expect(
    noTriangle,
    `${noTriangle.length === judged.length ? "[aspect: undrawn]" : "[aspect: someundrawn]"} no triangle drawn on points: ${noTriangle.join(", ")}`,
  ).toEqual([]);

  // Pointing outward: wider further in than at the rim, however short it is.
  const outward = judged.filter((s) => s.shape === "outward").map((s) => s.num);
  expect(
    outward,
    `${needsRows}expected every point's triangle to point inward (wider at the rim than further in), found outward-pointing point numbers: ${outward.join(", ")}`,
  ).toEqual([]);

  // And it reaches into the board: at least half way in from the rim (the
  // reference's run 88%). Run 1790396722's triangles reached a fifth of the way.
  const short = judged.filter((s) => s.reach < 0.5).map((s) => s.num);
  expect(
    short,
    `${needsRows}[aspect: short] triangles reaching less than half way in from the rim on points: ${short.join(", ")}`,
  ).toEqual([]);
});

// [F40] REQ-GEOMETRY — the two rows line up, as on every backgammon board: the
// top row's points sit straight across from the bottom row's, column for
// column. Judged on what is drawn — each row sorted left to right — never on
// the numbers, which F28 judges. Run 1790345941 squeezed each row into half the
// width, top row right and bottom row left, and every other stage-1 check passed.
test("[F40] REQ-GEOMETRY — the two rows line up", async ({ page }) => {
  await openFreshBoard(page);
  const points = await readPointBoxes(page);
  expect(points.length, "[needs: REQ-RENDER/point] expected 24 points to read").toBe(24);
  const mid = boardMidY(points);
  const top = points.filter((p) => p.centerY < mid).sort((a, b) => a.centerX - b.centerX);
  const bottom = points.filter((p) => p.centerY >= mid).sort((a, b) => a.centerX - b.centerX);
  const pw = pointWidth(points);
  // Rows that are not one above the other are the order check's complaint.
  const needsRows = splitRows(points).separated ? "" : "[needs: F28] ";
  const apart = top.flatMap((p, i) =>
    bottom[i] && Math.abs(p.centerX - bottom[i].centerX) <= 0.5 * pw ? [] : [`${i + 1}`],
  );
  expect(
    top.length === bottom.length && apart.length === 0,
    `${needsRows}expected ${top.length} top points each straight across from a bottom point, found ${bottom.length} below and columns apart: ${apart.join(", ")}`,
  ).toBeTruthy();
});

// [F42] REQ-GEOMETRY — the points alternate in colour, as on every backgammon
// board: side-by-side neighbours within each quarter differ. Judged on the
// triangles' own colours against each other, never on which colours they are
// (the F30 colour trap). Across the bar is not judged (the reference repeats
// its colour there), wherever the bar is drawn; nor is the point straight
// across the board: the build prompt says nothing about point colours, and a
// board whose facing triangles match looks right to a player (FIX-22 M61).
// Run 1790400113 drew every triangle one colour and every other check passed.
test("[F42] REQ-GEOMETRY — the points alternate in colour", async ({ page }) => {
  await openFreshBoard(page);
  const points = await readPointBoxes(page);
  expect(points.length, "[needs: REQ-RENDER/point] expected 24 points to read").toBe(24);
  // A point the bar or the tray is drawn over shows their colour, not its
  // own: it is not judged (FIX-22: M47's bar drawn over points made 21/22 and
  // 4/3 read as one colour, M54's tray made 24/1). Where they sit is the bar
  // and tray checks'.
  const bar = await readBarBox(page);
  const tray = await readOffTray(page);
  const covered = new Set(
    points
      .filter((p) => (bar !== null && overlaps(bar, p)) || (tray.exists && tray.painted && overlaps(tray, p)))
      .map((p) => p.num),
  );
  const samples = await sampleTriangleOrientation(page, points);
  const colourOf = new Map(samples.map((s) => [s.num, s.colour]));
  const same = (a: number, b: number) => {
    const ca = colourOf.get(a);
    const cb = colourOf.get(b);
    return !!ca && !!cb && Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]) < 40;
  };
  const quarters = [
    [13, 14, 15, 16, 17, 18],
    [19, 20, 21, 22, 23, 24],
    [12, 11, 10, 9, 8, 7],
    [6, 5, 4, 3, 2, 1],
  ];
  const neighbours = quarters.flatMap((q) => q.slice(1).map((n, i) => [q[i], n] as const));
  // Two points with the bar drawn between them are not neighbours on screen,
  // wherever the bar is: the reference repeats its colour across it, and a bar
  // in the wrong place is the bar check's complaint (FIX-22b: M47's bar between
  // 21 and 22 made them "neighbours of one colour").
  const boxOf = new Map(points.map((p) => [p.num, p]));
  const splitByBar = (a: number, b: number) => {
    const pa = boxOf.get(a);
    const pb = boxOf.get(b);
    if (bar === null || !pa || !pb) return false;
    const mid = bar.x + bar.width / 2;
    return (
      mid > Math.min(pa.centerX, pb.centerX) &&
      mid < Math.max(pa.centerX, pb.centerX) &&
      bar.y < pa.y + pa.height &&
      bar.y + bar.height > pa.y
    );
  };
  const judgedPairs = neighbours.filter(([a, b]) => !covered.has(a) && !covered.has(b) && !splitByBar(a, b));
  const matching = judgedPairs.filter(([a, b]) => same(a, b));
  // The quarters are found by number, and the colours are read off the
  // triangles: an out-of-order board is F28's complaint, a missing or
  // wrong-way triangle F30's.
  const oneColour = judgedPairs.length > 0 && matching.length === judgedPairs.length;
  expect(
    matching.map(([a, b]) => `${a}/${b}`),
    `${oneColour ? "[aspect: onecolour] " : ""}[needs: F28 F30] points that should differ in colour and match: ${matching.map(([a, b]) => `${a}/${b}`).join(", ")}`,
  ).toEqual([]);
});
