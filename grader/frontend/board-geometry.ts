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

export interface CheckerShape {
  loc: string;
  width: number;
  height: number;
  round: boolean;
}

/**
 * Each checker on a point as it is drawn: the box of the element, or of the
 * painted descendant that fills it (a disc inside a wrapper, a circle inside an
 * svg), and whether that shape is drawn round — a border radius of at least 45%
 * of its size on every corner, a circle or ellipse clip, or an SVG circle or
 * ellipse. Colours are never read: a black checker on a dark point looks the
 * same to a pixel test whatever its shape (the F30 colour trap).
 */
export async function readCheckerShapes(page: Page): Promise<CheckerShape[]> {
  return page.locator('[data-testid="checker"]').evaluateAll((elements) =>
    elements.flatMap((element) => {
      const loc = (element as HTMLElement).dataset.loc;
      if (loc === undefined || !/^\d+$/.test(loc)) return [];
      const isRound = (el: Element): boolean => {
        const tag = el.tagName.toLowerCase();
        if (tag === "circle" || tag === "ellipse") return true;
        const cs = getComputedStyle(el);
        if (/^(circle|ellipse)\(/.test(cs.clipPath)) return true;
        const box = el.getBoundingClientRect();
        const size = Math.min(box.width, box.height);
        if (size <= 0) return false;
        const radius = (value: string) => {
          const first = value.split(" ")[0];
          return first.endsWith("%") ? (parseFloat(first) / 100) * size : parseFloat(first);
        };
        return [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomLeftRadius, cs.borderBottomRightRadius].every(
          (value) => radius(value) >= 0.45 * size,
        );
      };
      const own = element.getBoundingClientRect();
      const shape = isRound(element)
        ? element
        : ([...element.querySelectorAll("*")].find((inner) => {
            const box = inner.getBoundingClientRect();
            return box.width * box.height >= 0.6 * own.width * own.height && isRound(inner);
          }) ?? element);
      const box = shape.getBoundingClientRect();
      return [{ loc, width: box.width, height: box.height, round: isRound(shape) }];
    }),
  );
}

/** The middle checker width of a set of shapes (the one most checkers share). */
export function typicalWidth(shapes: CheckerShape[]): number {
  const widths = shapes.map((s) => s.width).sort((a, b) => a - b);
  return widths[Math.floor(widths.length / 2)];
}

/** The horizontal midline of the board, from the points themselves. */
export function boardMidY(points: PointBox[]): number {
  return points.reduce((sum, p) => sum + p.centerY, 0) / points.length;
}

/**
 * Whether two drawn boxes overlap by more than a sliver: at least 4 px each way.
 * A pixel or two where shapes meet is not one drawn over the other to a player
 * (run 1790345941: a bar touching two points by 1–2 px was told "The bar cuts
 * across some of the points").
 */
export function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 3 && h > 3;
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
  // Share of the point's width painted at 5%, 10%, ... 95% of the way in from
  // its rim.
  profile: number[];
  // How far in from the rim the paint reaches (0 when nothing is painted).
  reach: number;
  // What the paint is: nothing; a block or band (about as wide at both ends of
  // the painted stretch — no triangle to a player); a triangle wider at the rim
  // (pointing inward) or wider further in (pointing outward).
  shape: "none" | "block" | "inward" | "outward";
  // The triangle's own colour: down its middle at its widest painted depth
  // (null when nothing is painted). Compared only with other points' colours.
  colour: number[] | null;
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

      // The felt: the commonest colour (in 12-level bins) down the left and right
      // edges of every point's box, from a fifth to four fifths of the way in.
      // A triangle narrows away from those edges whichever way it points, so
      // they show the felt. The line between the rows does not: a board whose
      // triangles point outward puts their bases there, and the felt learned as
      // a triangle colour read half of them as blocks (FIX-19, M04b).
      const midY = points.reduce((sum, p) => sum + p.y + p.height / 2, 0) / points.length;
      const bin = (c: number[]) => c.map((v) => Math.round(v / 12)).join(",");
      const seen = new Map<string, { n: number; colour: number[] }>();
      for (const p of points) {
        for (const fy of [0.2, 0.35, 0.5, 0.65, 0.8]) {
          for (const fx of [0.03, 0.97]) {
            const colour = at(p.x + p.width * fx, p.y + p.height * fy);
            const entry = seen.get(bin(colour)) ?? { n: 0, colour };
            entry.n += 1;
            seen.set(bin(colour), entry);
          }
        }
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

      // The whole depth, every 5%: two fixed depths straddled a triangle drawn a
      // fifth of the way in and pointing outward, and passed it (run
      // 1790396722). Its shape is read over the stretch that is painted: which
      // end of it is wider.
      const depths = Array.from({ length: 19 }, (_, i) => 0.05 * (i + 1));
      const mean = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
      return points.map((p) => {
        const top = p.y + p.height / 2 < midY;
        const profile = depths.map((d) => coverage(p, top, d));
        const first = profile.findIndex((c) => c > 0.1);
        const last = profile.length - 1 - [...profile].reverse().findIndex((c) => c > 0.1);
        let shape: "none" | "block" | "inward" | "outward" = "none";
        let reach = 0;
        if (first >= 0) {
          reach = depths[last];
          const span = profile.slice(first, last + 1);
          const third = Math.max(1, Math.round(span.length / 3));
          const rim = mean(span.slice(0, third));
          const inner = mean(span.slice(-third));
          const flat = Math.min(...span) >= 0.35 && Math.max(...span) - Math.min(...span) < 0.3;
          shape = flat ? "block" : rim > inner + 0.15 ? "inward" : inner > rim + 0.15 ? "outward" : "block";
        }
        let colour: number[] | null = null;
        if (first >= 0) {
          const widest = profile.indexOf(Math.max(...profile));
          const y = top ? p.y + p.height * depths[widest] : p.y + p.height * (1 - depths[widest]);
          colour = at(p.x + p.width / 2, y);
        }
        return { num: p.num, row: top ? ("top" as const) : ("bottom" as const), profile, reach, shape, colour };
      });
    },
    { dataUrl, points },
  );
}
