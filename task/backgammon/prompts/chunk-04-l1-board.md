TASK: Build the board and controls in `public/index.html`, `public/style.css`, and `public/app.js` — the board (points, bar, off tray), the buttons and the game-info panels, laid out to fit the window.

Render everything from the serialized state: pip counts, score, turn indicator, messages.

What the game should feel like to play:

- Clicks work anywhere in a point's column — the upright rectangle the point's triangle stands in, from the board's edge to the middle.
- Pip counts, cube value, cube owner, score and whose turn it is are all on screen and match the API.
- The board should be on the left and fill the screen, with all the roll, double and other buttons and game info on the right — about 80% of the width for the board and 20% for the buttons. That's on an ordinary laptop screen, 1280×800 or 1440×900, with nothing to scroll.
- The board keeps one shape at any window size: the whole board — its points, the bar and the bear-off tray — is 1.4 times as wide as it is tall. Size it in proportion to the window, never in fixed pixels, so a shorter, narrower or bigger window makes the board smaller or bigger without stretching it, and the pieces stay the same share of a point's width.
- The board is drawn as you'd see it sitting at a real board as white: point 24 at the top right, the top row running 13 to 24 left to right and the bottom row 12 down to 1 left to right, each row split into two halves of six by the bar, which runs down the middle the full height of the board, so the two halves are the same width. The bar is about as wide as a piece, with a few pixels of room on each side, so a piece that has been hit fits on it.
- Each point is a long triangle that stands out from the board, its wide end on the board's edge and its tip reaching most of the way to the middle, leaving a gap of about 24% of half the board's height between a top point's tip and the tip of the point directly across the middle. The board itself is one plain colour, and the points are drawn on it in two other colours that alternate side by side. All 24 points are the same size.
- The off tray sits at the right-hand end of the board, beside points 1 and 24, where the checkers are borne off. It runs the full height of the board and is at least as wide as a piece but no wider than one and a half points, so a borne-off piece fits in it lying on its side, its long edge parallel to the top and bottom of the board. It stands out from the board: a fill of its own, or a clear edge down the side that faces the points.
- Where a line sizes the bar or the off tray against a piece, a piece is a checker about 80% of a point's width (not counting the bar) — size the bar and the off tray to leave room for that.

Wording the page uses: the buttons read Roll, Double, Undo, End Turn and New Game — a longer label such as "Roll Dice" is fine as long as it contains the name — and all five are on screen from the start, the same size as each other, each at least 60 px wide and 24 px tall; a button the player can't use is clearly greyed out — visibly fainter than any button they can use.

Required `data-testid` hooks (EXACT — the UI automation selects on these; static elements keep their existing `id` and ALSO carry a `data-testid` with the same string):

**Static:** `scoreWhite`, `scoreBlack`, `difficulty`, `newGameBtn`, `board`, `playfield`, `checkerLayer`, `pointHints`, `turnIndicator`, `pipWhite`, `pipBlack`, `cube`, `cubeVal`, `cubeOwner`, `dice`, `rollBtn`, `doubleBtn`, `undoBtn`, `endTurnBtn`, `message`, `modalOverlay`, `modalTitle`, `modalBody`, `modalBtns`.

**Dynamic:**

- Each board point: `data-testid="point"` and `data-point="<1..24>"` on the element that is the point's column — exactly 24 points, no two overlapping.
- The bar: `data-testid="bar"`.
- The off tray: `data-testid="off-tray"`, containing `data-testid="off-you"`, where your borne-off checkers go.

**Before you hand it over, look at it.** Load the page in a browser and look at the board you built — the points, the bar, the off tray, the buttons and the game-info panels, sized to the window. The notes in this folder show how to open the page in a browser.
