// ─────────────────────────────────────────────────────────────────────────────
// BOARD GEOMETRY MEASUREMENT — the drawn box of every board element.
//
// The REQ-RENDER family counts elements (a board with 24 points and 30
// checkers passes); it cannot see WHERE anything is drawn. These helpers read
// the real rendered geometry through getBoundingClientRect(), so checks built
// on them judge the board a player actually looks at: points in board order,
// the bar between the halves, checkers over their own points, the off tray on
// screen. Pure measurement — every assertion lives in the spec.
// ─────────────────────────────────────────────────────────────────────────────

import { type Page } from "@playwright/test";

export interface PointBox {
  num: number;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

export interface CheckerBox {
  loc: string;
  centerX: number;
  centerY: number;
}

export interface OffTrayState {
  exists: boolean;
  visible: boolean;
  // Drawn so a player can see it: the tray or something inside it has a fill,
  // an outline, a shadow or a label. An empty see-through box is not a tray.
  painted: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The drawn box of every `[data-testid="point"]`, keyed by its `data-point` number. */
export async function readPointBoxes(page: Page): Promise<PointBox[]> {
  return page.locator('[data-testid="point"]').evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        num: Number((element as HTMLElement).dataset.point),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        centerX: rect.x + rect.width / 2,
        centerY: rect.y + rect.height / 2,
      };
    }),
  );
}

/**
 * The drawn center of every checker that sits on a numbered point. Checkers
 * parked off-board ("bar", "off") or never placed (no `data-loc`) carry no
 * point relationship to judge, so they are skipped.
 */
export async function readCheckerBoxes(page: Page): Promise<CheckerBox[]> {
  return page.locator('[data-testid="checker"]').evaluateAll((elements) =>
    elements.flatMap((element) => {
      const loc = (element as HTMLElement).dataset.loc;
      if (loc === undefined || !/^\d+$/.test(loc)) return [];
      const rect = element.getBoundingClientRect();
      return [{ loc, centerX: rect.x + rect.width / 2, centerY: rect.y + rect.height / 2 }];
    }),
  );
}

/** The horizontal midline of the board, from the points themselves. */
export function boardMidY(points: PointBox[]): number {
  return points.reduce((sum, p) => sum + p.centerY, 0) / points.length;
}

/** The average drawn width of a point — the unit horizontal tolerances are stated in. */
export function pointWidth(points: PointBox[]): number {
  return points.reduce((sum, p) => sum + p.width, 0) / points.length;
}

/** The drawn box of `[data-testid="bar"]`, or null when the board has none. */
export async function readBarBox(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number; centerX: number; centerY: number } | null> {
  const bar = page.locator('[data-testid="bar"]');
  if ((await bar.count()) === 0) return null;
  return bar.first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      centerX: rect.x + rect.width / 2,
      centerY: rect.y + rect.height / 2,
    };
  });
}

/**
 * Whether the off tray is on the board AND on screen. An element can exist in
 * the DOM yet be detached or styled away, so existence and visibility are
 * reported separately: `visible` requires a non-empty box and no
 * display:none / visibility:hidden.
 */
export async function readOffTray(page: Page): Promise<OffTrayState> {
  const tray = page.locator('[data-testid="off-tray"]');
  if ((await tray.count()) === 0) {
    return { exists: false, visible: false, painted: false, x: 0, y: 0, width: 0, height: 0 };
  }
  return tray.first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const paints = (el: Element): boolean => {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) <= 0.05) return false;
      const alpha = (colour: string): number => {
        const parts = colour.match(/[\d.]+/g)?.map(Number) ?? [];
        return parts.length === 4 ? parts[3] : parts.length === 3 ? 1 : 0;
      };
      const outlined = ["Top", "Right", "Bottom", "Left"].some(
        (side) =>
          parseFloat(cs.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 &&
          !["none", "hidden"].includes(cs.getPropertyValue(`border-${side.toLowerCase()}-style`)) &&
          alpha(cs.getPropertyValue(`border-${side.toLowerCase()}-color`)) > 0.05,
      );
      return alpha(cs.backgroundColor) > 0.05 || cs.backgroundImage !== "none" || cs.boxShadow !== "none" || outlined;
    };
    return {
      exists: true,
      visible:
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) > 0.05,
      painted:
        [element, ...element.querySelectorAll("*")].some(paints) ||
        ((element as HTMLElement).innerText ?? "").trim().length > 0,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  });
}

/**
 * Wait until the board stops moving, by measurement rather than by a fixed
 * sleep: the board animates checkers into place on load (a CSS transform
 * transition), and a rect read mid-flight measures where a checker WAS.
 *
 * Samples getBoundingClientRect() of EVERY placed checker and EVERY point —
 * the exact set the geometry checks measure — once per animation frame, and
 * returns only after the full snapshot has held IDENTICAL for a continuous
 * window of at least SETTLE_MS milliseconds. Frame-to-frame equality alone is
 * not enough: the transition is compositor-driven, so getBoundingClientRect()
 * can report the same stale in-flight rect across consecutive frames while a
 * checker is still visually moving — the minimum-duration window waits the
 * transition out to its final position. The element set is re-queried each
 * frame, so a re-render or replacement restarts the window instead of
 * settling on stale elements. It first waits for a checker with a NUMERIC
 * `data-loc` to exist: an unplaced checker parked off-board is trivially
 * motionless, and settling on it (or on bare points) would measure the board
 * before it was drawn. Throws when the board never settles.
 */
export async function waitForBoardSettled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const TIMEOUT_MS = 5000;
    // Must exceed the checker's 340ms transform transition (golden
    // style.css:134 `transition: transform .34s cubic-bezier(.34,.9,.4,1)`,
    // measured to settle in ~334-362ms), with margin for frame drops: a
    // compositor-driven transform can report an identical stale rect across
    // consecutive frames while still in flight, so stability only counts
    // after an uninterrupted window at least this long.
    const SETTLE_MS = 700;
    const deadline = performance.now() + TIMEOUT_MS;
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const placedCheckers = (): HTMLElement[] =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-testid="checker"]')).filter(
        (element) => {
          const loc = element.dataset.loc;
          return loc !== undefined && /^\d+$/.test(loc);
        },
      );
    // One string of 2-decimal rects for the full measured set, or null while
    // no placed checker exists (a board with nothing to settle on).
    const snapshot = (): string | null => {
      const checkers = placedCheckers();
      if (checkers.length === 0) return null;
      const elements = [
        ...checkers,
        ...Array.from(document.querySelectorAll<HTMLElement>('[data-testid="point"]')),
      ];
      return elements
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return [rect.x, rect.y, rect.width, rect.height].map((v) => v.toFixed(2)).join(",");
        })
        .join("|");
    };

    while (placedCheckers().length === 0) {
      if (performance.now() > deadline) {
        throw new Error(
          `board never settled: no [data-testid="checker"] with a numeric data-loc appeared within ${TIMEOUT_MS}ms`,
        );
      }
      await frame();
    }

    let previous: string | null = null;
    let unchangedSince: number | null = null;
    while (performance.now() <= deadline) {
      await frame();
      const now = performance.now();
      const current = snapshot();
      if (current === null) {
        // The page re-rendered and dropped the placed checkers — restart the
        // stability window against the fresh element set.
        previous = null;
        unchangedSince = null;
        continue;
      }
      if (current !== previous) {
        // The snapshot last changed on this frame — (re)start the window.
        previous = current;
        unchangedSince = now;
        continue;
      }
      if (unchangedSince !== null && now - unchangedSince >= SETTLE_MS) return;
    }
    throw new Error(
      `board never settled: the checker and point rects never held identical for ${SETTLE_MS}ms within ${TIMEOUT_MS}ms`,
    );
  });
}

export interface TriangleSample {
  num: number;
  row: "top" | "bottom";
  // Share of the point's width painted near its rim, and near its inner end.
  baseCoverage: number;
  tipCoverage: number;
  orientedInward: boolean;
}

/**
 * Measure what is actually DRAWN inside each point's triangle, whatever its
 * colours: hide the checkers and hints, screenshot the page, decode the PNG
 * in-browser through a canvas, and learn the board's own felt — the commonest
 * colour on the line between the two rows, where no triangle reaches. A pixel
 * is triangle paint when it differs clearly from that felt. A triangle
 * pointing inward covers most of its point's width near the rim and little of
 * it near the inner end; pointing outward inverts both.
 *
 * The row is where the point is drawn, not what it is numbered: the order
 * check (F28) judges numbering, this one judges shape.
 *
 * The first version called a pixel triangle when it was brown (r > g) and
 * felt when green (g > r) — the reference's own paint — so the reference
 * repainted with tan felt and cream and red triangles, a standard board, read
 * as 24 points "pointing outward" (FIX-3 mutation M37). Measured on the
 * reference in both colourings (24/24 inward) and with its triangles flipped
 * (0/24).
 */
export async function sampleTriangleOrientation(
  page: Page,
  points: PointBox[],
): Promise<TriangleSample[]> {
  await page.addStyleTag({
    content: '[data-testid="checker"], [data-testid="hint"] { visibility: hidden !important; }',
  });
  const buf = await page.screenshot({ type: "png" });
  const dataUrl = "data:image/png;base64," + buf.toString("base64");

  return page.evaluate(
    async ({ dataUrl, points }) => {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("screenshot PNG failed to decode in-browser"));
        img.src = dataUrl;
      });

      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas 2d context unavailable");
      ctx.drawImage(img, 0, 0);

      // Sampled coordinates are CSS/viewport px; the screenshot is device px.
      const dpr = img.naturalWidth / window.innerWidth;
      const at = (x: number, y: number): number[] => {
        const d = ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
        return [d[0], d[1], d[2]];
      };
      const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

      // The felt: the commonest colour (in 12-level bins) across the line
      // between the rows. The bar crosses it too, but only for its width.
      const midY = points.reduce((sum, p) => sum + p.y + p.height / 2, 0) / points.length;
      const minX = Math.min(...points.map((p) => p.x));
      const maxX = Math.max(...points.map((p) => p.x + p.width));
      const bin = (c: number[]) => c.map((v) => Math.round(v / 12)).join(",");
      const seen = new Map<string, { n: number; colour: number[] }>();
      for (let x = minX + 2; x < maxX - 2; x += 3) {
        const colour = at(x, midY);
        const entry = seen.get(bin(colour)) ?? { n: 0, colour };
        entry.n += 1;
        seen.set(bin(colour), entry);
      }
      const felt = [...seen.values()].sort((a, b) => b.n - a.n)[0].colour;
      const painted = (x: number, y: number) => dist(at(x, y), felt) > 45;

      // Share of a horizontal line across the point, `depth` of the way in
      // from its rim, that is painted.
      const coverage = (p: (typeof points)[number], top: boolean, depth: number): number => {
        const y = top ? p.y + p.height * depth : p.y + p.height * (1 - depth);
        let hit = 0;
        let all = 0;
        for (let x = p.x + 1; x < p.x + p.width - 1; x += 1) {
          all += 1;
          if (painted(x, y)) hit += 1;
        }
        return all ? hit / all : 0;
      };

      return points.map((p) => {
        const top = p.y + p.height / 2 < midY;
        const baseCoverage = coverage(p, top, 0.1);
        const tipCoverage = coverage(p, top, 0.85);
        return {
          num: p.num,
          row: top ? ("top" as const) : ("bottom" as const),
          baseCoverage,
          tipCoverage,
          orientedInward: baseCoverage > 0.5 && tipCoverage < 0.35,
        };
      });
    },
    { dataUrl, points },
  );
}
