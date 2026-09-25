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
    return { exists: false, visible: false, width: 0, height: 0 };
  }
  return tray.first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      exists: true,
      visible:
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden",
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
  outerIsTriangle: boolean;
  innerIsTriangle: boolean;
  orientedInward: boolean;
}

/**
 * Measure what is actually DRAWN inside each point's triangle: hide the
 * checkers, screenshot the page, decode the PNG in-browser through a canvas,
 * and sample one pixel near each point's OUTER edge (the board rim) and one
 * near its INNER end (toward the board midline).
 *
 * A triangle pointing inward covers the outer sample and leaves the inner
 * sample on bare felt; pointing outward inverts both. Pixel classification is
 * colour-only — triangle paint is brown (r > g), felt is green (g > r) — so
 * the measurement does not depend on HOW the triangle is drawn (CSS borders,
 * clip-path, or SVG). Sample offsets stay clear of the `.plabel` number, which
 * sits 1px from the rim at the point's horizontal center.
 */
export async function sampleTriangleOrientation(
  page: Page,
  points: PointBox[],
): Promise<TriangleSample[]> {
  await page.addStyleTag({
    content: '[data-testid="checker"] { visibility: hidden !important; }',
  });
  const buf = await page.screenshot({ type: "png" });
  const dataUrl = "data:image/png;base64," + buf.toString("base64");
  const dpr = await page.evaluate(() => window.devicePixelRatio || 1);

  return page.evaluate(
    async ({ dataUrl, points, dpr }) => {
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
      const isTriangle = (cssX: number, cssY: number): boolean => {
        const pixel = ctx.getImageData(
          Math.round(cssX * dpr),
          Math.round(cssY * dpr),
          1,
          1,
        ).data;
        return pixel[0] > pixel[1];
      };

      return points.map((p): TriangleSample => {
        const row: "top" | "bottom" = p.num >= 13 ? "top" : "bottom";
        const x = p.x + p.width * 0.25;
        const outerY = row === "top" ? p.y + p.height * 0.1 : p.y + p.height * 0.85;
        const innerY = row === "top" ? p.y + p.height * 0.8 : p.y + p.height * 0.2;
        const outerIsTriangle = isTriangle(x, outerY);
        const innerIsTriangle = isTriangle(x, innerY);
        return {
          num: p.num,
          row,
          outerIsTriangle,
          innerIsTriangle,
          orientedInward: outerIsTriangle && !innerIsTriangle,
        };
      });
    },
    { dataUrl, points, dpr },
  );
}
