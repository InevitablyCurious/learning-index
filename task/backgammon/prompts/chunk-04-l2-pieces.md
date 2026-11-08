TASK: Add the pieces in `public/index.html`, `public/style.css`, and `public/app.js` — the checkers on the board: their placement, size, stacks and counts.

What the game should feel like to play:

- Checkers slide between points rather than jumping; dice visibly roll. Animate with CSS transitions and CSS animations — each checker animates position changes through a `transition` covering `transform` (or `all`) with a non-zero duration, or through a CSS `animation`.
- Each checker is a perfect circle, sized to about 80% of the width of the point it sits on (not counting the bar). A point's checkers stack from the board's edge toward the middle, each piece right against the last and stepping evenly, and a full stack of six sits a little tighter together; a point draws at most six checkers — from seven up it draws six, and the piece at the top of the stack (the sixth, farthest from the edge) shows the total number on the point. A move always takes the piece at the top of its stack, and the piece that arrives goes on top of the stack it joins.

Required `data-testid` hooks (EXACT — the UI automation selects on these; static elements keep their existing `id` and ALSO carry a `data-testid` with the same string):

**Dynamic:**

- Each checker: `data-testid="checker"`, `data-color="white|black"`, `data-loc="<1..24>|bar|off"` — the tag appears only on drawn pieces (at most six per point, plus bar and off), positioned at their board/bar/off location. At the opening position (max five per point) there are exactly 30 checkers (15 per colour); fewer tags exist only when a point is capped. From seven up, the top (6th) drawn piece carries a `data-testid="checkerCount"` element whose text is the integer total for that point.
- The checker count: `data-testid="checkerCount"` — the count element shown on the top piece of a point holding seven or more checkers.

**Before you hand it over, look at it.** Load the page in a browser and look at the pieces you added — checkers on their points, the stacks, the count badges, and the bar and off tray when a piece lands there. The notes in this folder show how to open the page in a browser.
