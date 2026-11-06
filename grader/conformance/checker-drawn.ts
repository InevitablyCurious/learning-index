// WHETHER A CHECKER IS ACTUALLY DRAWN — the predicate behind "30 checkers on the
// board", not "30 elements tagged like checkers".
//
// Counting `[data-color][data-loc]` measures the page's claims about itself. A
// board that tags its pieces and draws none of them satisfies that count: the
// elements exist, and a player sees an empty board. So each tagged element is
// judged on what the compositor would show:
//
//   1. it belongs to a real side — `white` or `black` — at a real location:
//      a point number, `bar` or `off`;
//   2. it is not taken out of layout (`display:none`), does not reserve space
//      invisibly (`visibility:hidden|collapse`), has a non-zero box, and is not
//      faded out — `opacity <= 0.05`, the same "not visibly rendered" threshold
//      board-geometry.ts uses in `readOffTray`/`isPainted`, so there is ONE
//      notion of invisible in the grader and not two;
//   3. its box intersects the viewport: a piece parked off-canvas is drawn
//      nowhere a player can look.
//
// The checks run in a fixed order so the first failure names one deterministic
// reason — a rejection reason is evidence, and evidence has to be reproducible.
//
// BROWSER-FREE BY CONSTRUCTION: no DOM, no playwright, no `Page`. The caller
// reads the computed style and the bounding box and passes them in as plain
// numbers, which is what lets this module be unit-tested under the vitest META
// config (node environment, no browser) instead of only behind a live render.

/** One tagged checker, as measured by the caller: computed style + box + viewport. */
export interface CheckerDrawnInput {
  color: string;
  loc: string;
  display: string;
  visibility: string;
  opacity: number;
  width: number;
  height: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  viewportWidth: number;
  viewportHeight: number;
}

/** Whether that checker reaches a player's eyes, and why not when it does not. */
export interface CheckerDrawnVerdict {
  drawn: boolean;
  reason: string;
}

/**
 * Judge one tagged checker. Each rejection reason is the whole finding — the
 * element's own loc and side, plus the one condition that hid it — so a failing
 * board can be read without going back to the page.
 */
export function checkerDrawnVerdict(input: CheckerDrawnInput): CheckerDrawnVerdict {
  const { color, loc, display, visibility, opacity, width, height, left, top, right, bottom } = input;
  const { viewportWidth, viewportHeight } = input;

  // 1. A real side. An untagged `data-color`, or one inventing a third side,
  //    is a claim about the board rather than a piece on it.
  if (color !== "white" && color !== "black") {
    return { drawn: false, reason: `data-color "${color || "(absent)"}" is not a real side (white|black)` };
  }

  // 2. A real location: a point number, or one of the two off-board trays.
  //    `/^\d+$/` inline, the same idiom board-geometry.ts uses for a point
  //    number: a structural test, not a word pattern the prompt has to state.
  if (!/^\d+$/.test(loc) && loc !== "bar" && loc !== "off") {
    return { drawn: false, reason: `data-loc "${loc || "(absent)"}" is not numeric, "bar", or "off"` };
  }

  const at = `data-loc ${loc} ${color} checker`;

  // 3. In layout at all.
  if (display === "none") {
    return { drawn: false, reason: `${at} is display:none` };
  }

  // 4. Visibility: hidden elements keep their box but paint nothing; `collapse`
  //    is the table-row form of the same refusal.
  if (visibility === "hidden" || visibility === "collapse") {
    return { drawn: false, reason: `${at} is visibility:${visibility}` };
  }

  // 5. A box to paint into. Zero in either axis is nothing to see.
  if (width <= 0 || height <= 0) {
    return { drawn: false, reason: `${at} has zero size` };
  }

  // 6. Faded to nothing. 0.05 is board-geometry's own floor for "not visibly
  //    rendered", reused rather than re-chosen.
  if (opacity <= 0.05) {
    return { drawn: false, reason: `${at} is transparent (opacity ${opacity})` };
  }

  // 7. On screen. A box entirely left of, above, right of or below the viewport
  //    is drawn where no player is looking.
  if (right <= 0 || bottom <= 0 || left >= viewportWidth || top >= viewportHeight) {
    return { drawn: false, reason: `${at} is off-canvas` };
  }

  return { drawn: true, reason: "" };
}

/**
 * Fold a list of tagged checkers through the verdict: how many are actually
 * drawn, and one reason per checker that is not. A page that tags thirty
 * checkers and draws none of them returns `{ count: 0, rejected: [30 reasons] }`
 * — zero drawn, never a silent zero.
 */
export function countDrawnCheckers(inputs: CheckerDrawnInput[]): { count: number; rejected: string[] } {
  const rejected: string[] = [];
  let count = 0;
  for (const input of inputs) {
    const verdict = checkerDrawnVerdict(input);
    if (verdict.drawn) {
      count += 1;
    } else {
      rejected.push(verdict.reason);
    }
  }
  return { count, rejected };
}
