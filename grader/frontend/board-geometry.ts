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

import { type Locator, type Page } from "@playwright/test";

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
 * The column of a point: the full edge-to-middle rectangle the point's triangle
 * stands in (the `[data-testid="point"]` box itself — the prompt puts the tag
 * on the column, and the pre-gate's point-column check holds it to that). Null
 * when no point carries that number.
 */
export async function readColumnBox(page: Page, num: number): Promise<PointBox | null> {
  const boxes = await readPointBoxes(page);
  return boxes.find((box) => box.num === num) ?? null;
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

export interface CheckerVisibility {
  loc: string;
  centerX: number;
  centerY: number;
  width: number;
  /** Share of the piece's circle a player can see. */
  seen: number;
  /** Share of it that another piece is drawn over. */
  under: number;
  /** Share of it inside the window. */
  onScreen: number;
}

/**
 * How much of each checker on a point shows: a grid of spots inside its
 * circle, each hit-tested for what is drawn on top there. Clipping (clip-path,
 * overflow) and stacking order decide a hit exactly as they decide what shows.
 * Pages often let clicks pass through their pieces (the reference sets
 * pointer-events: none on them), so the pieces are made hit-testable for the
 * reading and put back after it.
 */
export async function readCheckerVisibility(page: Page): Promise<CheckerVisibility[]> {
  return page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = '[data-testid="checker"], [data-testid="checker"] * { pointer-events: auto !important; }';
    document.head.appendChild(style);
    try {
      return [...document.querySelectorAll('[data-testid="checker"]')].flatMap((element) => {
        const loc = (element as HTMLElement).dataset.loc;
        if (loc === undefined || !/^\d+$/.test(loc)) return [];
        // The drawn disc: the element, or its largest descendant when the
        // element itself has no size (a zero-size anchor around a disc).
        let box = element.getBoundingClientRect();
        if (box.width * box.height < 16) {
          const inner = [...element.querySelectorAll("*")]
            .map((el) => el.getBoundingClientRect())
            .sort((a, b) => b.width * b.height - a.width * a.height)[0];
          if (inner) box = inner;
        }
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        const r = (0.9 * Math.min(box.width, box.height)) / 2;
        let inside = 0;
        let seen = 0;
        let under = 0;
        let onScreen = 0;
        for (let i = 0; i < 9; i++) {
          for (let j = 0; j < 9; j++) {
            const dx = ((i + 0.5) / 9) * 2 - 1;
            const dy = ((j + 0.5) / 9) * 2 - 1;
            if (dx * dx + dy * dy > 1) continue;
            inside += 1;
            const x = cx + dx * r;
            const y = cy + dy * r;
            if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
            onScreen += 1;
            const hit = document.elementFromPoint(x, y);
            if (hit && (hit === element || element.contains(hit))) seen += 1;
            else if (hit?.closest('[data-testid="checker"]')) under += 1;
          }
        }
        if (inside === 0) return [];
        return [
          {
            loc,
            centerX: cx,
            centerY: cy,
            width: Math.min(box.width, box.height),
            seen: seen / inside,
            under: under / inside,
            onScreen: onScreen / inside,
          },
        ];
      });
    } finally {
      style.remove();
    }
  });
}

/** The middle checker width of a set of shapes (the one most checkers share). */
export function typicalWidth(shapes: CheckerShape[]): number {
  const widths = shapes.map((s) => s.width).sort((a, b) => a - b);
  return widths[Math.floor(widths.length / 2)];
}

/** The horizontal midline of the board, from the points themselves. */
/**
 * The points split into the two rows a player sees: the 12 drawn highest and
 * the 12 drawn lowest. `separated` says whether they really are two rows, one
 * above the other: the lowest top-row centre at least half a point's height
 * above the highest bottom-row centre. Run 1790407044 put the top row beside
 * the bottom row, every point the full height of the board; sorting by height
 * then split them by page order, and the order check passed.
 */
export function splitRows(points: PointBox[]): { top: PointBox[]; bottom: PointBox[]; gap: number; separated: boolean } {
  const byHeight = [...points].sort((a, b) => a.centerY - b.centerY);
  const top = byHeight.slice(0, 12);
  const bottom = byHeight.slice(12);
  const height = points.reduce((sum, p) => sum + p.height, 0) / points.length;
  const gap = Math.min(...bottom.map((p) => p.centerY)) - Math.max(...top.map((p) => p.centerY));
  return { top, bottom, gap, separated: bottom.length === 12 && gap >= 0.5 * height };
}

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

/**
 * The drawn width of a point — the unit horizontal tolerances are stated in:
 * the middle of the widths of the points that have any. A point collapsed to
 * nothing is the triangle check's complaint, and averaging it in shrank "a
 * point" — run 1790448423's right half was twelve points of width 0, and its
 * pieces, 80% of the drawn points, were told "too big for their points".
 */
export function pointWidth(points: PointBox[]): number {
  const widths = points
    .map((p) => p.width)
    .filter((w) => w > 0)
    .sort((a, b) => a - b);
  return widths.length ? widths[Math.floor(widths.length / 2)] : 0;
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
  const box = await tray.first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      exists: true,
      visible:
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) > 0.05,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  });
  return { ...box, painted: await isPainted(tray.first()) };
}

/**
 * Whether an element shows a player anything: it or something inside it has a
 * fill, an image or gradient, an outline or a shadow, is an SVG shape filled or
 * stroked or an image, or it carries text — and is not hidden or faded out.
 * One with none of these is an empty see-through box, however big: run
 * 1790661859's bar piece was 30 px, tagged, and drawn with nothing.
 */
export async function isPainted(target: Locator): Promise<boolean> {
  return target.evaluate((element) => {
    const alpha = (colour: string): number => {
      const parts = colour.match(/[\d.]+/g)?.map(Number) ?? [];
      return parts.length === 4 ? parts[3] : parts.length === 3 ? 1 : 0;
    };
    const paints = (el: Element): boolean => {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) <= 0.05) return false;
      if (el instanceof SVGGeometryElement) {
        return (cs.fill !== "none" && alpha(cs.fill) > 0.05) || (cs.stroke !== "none" && alpha(cs.stroke) > 0.05);
      }
      if (el instanceof HTMLImageElement) return true;
      const outlined = ["Top", "Right", "Bottom", "Left"].some(
        (side) =>
          parseFloat(cs.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 &&
          !["none", "hidden"].includes(cs.getPropertyValue(`border-${side.toLowerCase()}-style`)) &&
          alpha(cs.getPropertyValue(`border-${side.toLowerCase()}-color`)) > 0.05,
      );
      return alpha(cs.backgroundColor) > 0.05 || cs.backgroundImage !== "none" || cs.boxShadow !== "none" || outlined;
    };
    return (
      [element, ...element.querySelectorAll("*")].some(paints) ||
      ((element as HTMLElement).innerText ?? "").trim().length > 0
    );
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
  // Where the triangle's wide (rim-side) end first shows paint, as a fraction
  // of the point's height measured in from the rim (5%-quantized: 0.05, 0.10,
  // … 0.95; null when nothing is painted).
  first: number | null;
  // How far in from the rim the paint reaches (0 when nothing is painted).
  reach: number;
  // What the paint is: nothing; a block or band (about as wide at both ends of
  // the painted stretch — no triangle to a player); a triangle wider at the rim
  // (pointing inward) or wider further in (pointing outward).
  shape: "none" | "block" | "inward" | "outward";
  // The triangle's own colour: down its middle at its widest painted depth
  // (null when nothing is painted). Compared only with other points' colours.
  colour: number[] | null;
  // The triangle TIP's viewport-px Y: the innermost row (closest to the board
  // middle) along the point's vertical centreline where triangle paint is
  // still present, read from a 3-px strip around the apex pixel and a
  // local-noise-anchored threshold, accurate to ~1–2 px (null when nothing is
  // painted). `reach` is 5%-quantized at a 0.1 coverage threshold — far too
  // coarse to measure the tip-to-tip gap across the middle (F70), which lives
  // in a band a few percent wide.
  tipY: number | null;
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
  // The hide must not outlive the measurement: an injected style tag left
  // behind keeps every checker on the page invisible for the rest of the run.
  // Capture the handle and remove it in a finally — the pattern
  // readCheckerVisibility uses for its own injected style.
  const hideStyle = await page.addStyleTag({
    content: '[data-testid="checker"], [data-testid="hint"] { visibility: hidden !important; }',
  });
  try {
    const buf = await page.screenshot({ type: "png" });
    const dataUrl = "data:image/png;base64," + buf.toString("base64");

    return await page.evaluate(
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
          // The TIP: the innermost row along the point's vertical centreline
          // where triangle paint is still present. A single-pixel walk at the
          // fixed dist>45 threshold misreads it by up to ~14 px: the apex
          // converges to a point, so where the sampled pixel crosses any fixed
          // threshold depends on the apex's sub-pixel position (a pixel that
          // merely borders the apex catches paint on half its width only) and
          // on the triangle's contrast against the felt — the golden's dark
          // left-column triangle, apex on a pixel border, read 14 px short and
          // inflated F70's gap to 0.31 of a point against the true 0.24. So:
          // take the max dist over a 3-device-px strip centred on the pixel
          // CONTAINING the apex (that pixel always carries the strongest
          // coverage), find the innermost strongly-painted row (> 45, F30's
          // threshold), then refine inward against a threshold anchored just
          // above the local felt noise: floor + 18% of (body − floor), both
          // measured beside the tip. Coverage rises linearly from zero at the
          // apex, so the 18% crossing lands within ~1–2 px of the true tip for
          // any colour or alignment. Bounded to the point's own box: paint
          // crossing the middle is read at the box edge, which makes the
          // across-the-middle gap come out ≤ 0 — the touching case F70 tells.
          let tipY: number | null = null;
          if (first >= 0) {
            const rowTop = Math.max(0, Math.round(p.y * dpr));
            const rowBot = Math.min(canvas.height - 1, Math.round((p.y + p.height) * dpr));
            const stripX = Math.max(0, Math.min(Math.floor((p.x + p.width / 2) * dpr) - 1, canvas.width - 3));
            if (rowBot > rowTop) {
              const strip = ctx.getImageData(stripX, rowTop, 3, rowBot - rowTop + 1);
              const rowDist = (row: number): number => {
                let best = 0;
                for (let c = 0; c < 3; c++) {
                  const o = ((row - rowTop) * 3 + c) * 4;
                  const d = dist([strip.data[o], strip.data[o + 1], strip.data[o + 2]], felt);
                  if (d > best) best = d;
                }
                return best;
              };
              const dir = top ? 1 : -1; // rim → inner edge, in device rows
              const step = Math.max(1, Math.round(dpr)); // ~1 CSS px per step
              let strong = -1;
              for (let row = rowTop; row <= rowBot; row++) {
                if (rowDist(row) > 45) strong = dir > 0 ? row : strong === -1 ? row : Math.min(strong, row);
              }
              if (strong >= 0) {
                const clamp = (r: number) => Math.max(rowTop, Math.min(rowBot, r));
                // The felt floor beside the tip (past it, toward the middle) and
                // the saturated body just inside it (rim side).
                const win: number[] = [];
                for (let o = 12 * step; o <= 20 * step; o += step) win.push(rowDist(clamp(strong + dir * o)));
                const floorD = [...win].sort((a, b) => a - b)[win.length >> 1];
                let sat = 0;
                for (let o = 0; o <= 20 * step; o += step) sat = Math.max(sat, rowDist(clamp(strong - dir * o)));
                const thresh = sat - floorD >= 10 ? floorD + 0.18 * (sat - floorD) : 45;
                let tipRow = strong;
                for (let o = -2 * step; o <= 10 * step; o++) {
                  const row = clamp(strong + dir * o);
                  if (rowDist(row) > thresh) tipRow = dir > 0 ? Math.max(tipRow, row) : Math.min(tipRow, row);
                }
                tipY = tipRow / dpr;
              }
            }
          }
          return {
            num: p.num,
            row: top ? ("top" as const) : ("bottom" as const),
            profile,
            first: first >= 0 ? depths[first] : null,
            reach,
            shape,
            colour,
            tipY,
          };
        });
      },
      { dataUrl, points },
    );
  } finally {
    await hideStyle.evaluate((element) => (element as Element).remove());
  }
}

/**
 * Whether the board's GEOMETRY actually drew: at least one point renders a
 * visible triangle. `waitForBoardSettled` only sees tagged elements holding
 * still — a board whose checkers place but whose points never paint sails
 * past it and is judged by every downstream geometry check. This is the
 * pixel-side precondition: read the point boxes, sample what is drawn inside
 * them, and require one real shape. No points at all is never "drawn".
 */
export async function boardGeometryDrawn(page: Page): Promise<boolean> {
  const points = await readPointBoxes(page);
  if (points.length === 0) return false;
  const samples = await sampleTriangleOrientation(page, points);
  return samples.some((sample) => sample.shape !== "none");
}


/**
 * What colours show beside the triangles. The board is one plain colour and the
 * points are drawn on it, so the strips either side of every point's box (a half to
 * three quarters of the way in from its rim, where a triangle has narrowed away) are all the
 * board's colour. `share` is the part of those samples within 45 of the
 * commonest colour: the reference reads 100%, a board whose point columns are
 * painted in stripes behind black triangles (run 1791318365) reads 50%.
 */
export async function sampleBoardColour(
  page: Page,
  points: PointBox[],
): Promise<{ share: number; colours: number[][] }> {
  const hideStyle = await page.addStyleTag({
    content: '[data-testid="checker"], [data-testid="hint"] { visibility: hidden !important; }',
  });
  try {
    const buf = await page.screenshot({ type: "png" });
    const dataUrl = "data:image/png;base64," + buf.toString("base64");
    return await page.evaluate(
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
        const dpr = img.naturalWidth / window.innerWidth;
        const at = (x: number, y: number): number[] => {
          const d = ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
          return [d[0], d[1], d[2]];
        };
        // Where a triangle has narrowed away: a half to three quarters of the way in
        // from its rim, at the very sides of its box. Nearer the rim a wide triangle
        // fills the box and shows its own colour there.
        const midY = points.reduce((sum, p) => sum + p.y + p.height / 2, 0) / points.length;
        const samples: number[][] = [];
        for (const p of points) {
          const top = p.y + p.height / 2 < midY;
          for (const depth of [0.55, 0.65, 0.75]) {
            const y = top ? p.y + p.height * depth : p.y + p.height * (1 - depth);
            for (const fx of [0.04, 0.96]) samples.push(at(p.x + p.width * fx, y));
          }
        }
        const clusters: { c: number[]; n: number }[] = [];
        for (const c of samples) {
          const k = clusters.find((k) => Math.hypot(k.c[0] - c[0], k.c[1] - c[1], k.c[2] - c[2]) < 45);
          if (k) k.n += 1;
          else clusters.push({ c, n: 1 });
        }
        clusters.sort((a, b) => b.n - a.n);
        return { share: samples.length ? clusters[0].n / samples.length : 0, colours: clusters.slice(0, 3).map((k) => k.c) };
      },
      { dataUrl, points },
    );
  } finally {
    await hideStyle.evaluate((el) => (el as HTMLElement).remove()).catch(() => undefined);
  }
}
