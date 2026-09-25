GOAL: We are building a fully functional backgammon game in Node + TypeScript that runs on localhost. This is chunk 4 of 5. The backend (engine, AI, API) is complete from chunks 1-3.
REQUIREMENT — the game state MUST survive page reloads. A reload must carry over every piece of information from before the reload: the board, the dice, the score, whose turn it is, the difficulty, the doubling cube, and the remaining dice. Load the current state from the server when the page opens — do not start a new game on load.

TASK: Build the frontend in `public/index.html`, `public/style.css`, and `public/app.js` — a compact, animated, fully playable board UI driven by the API.

Render everything from the serialized state: checkers on points, bar and off, dice, cube, pip counts, score, turn indicator, messages. Call the API with root-relative paths (`fetch('/api/state', …)`) so the page works whichever host name it was loaded from. Never use an absolute base such as `http://127.0.0.1:8002/api/state` — a browser treats `localhost` and `127.0.0.1` as distinct origins.

What the game should feel like to play:

- Clicking one of your checkers shows you where it can go, and clicking one of those destinations plays that move.
- A hint appears for each playable die when a movable checker is selected; selecting a bar checker with two playable entry dice shows two hints, one per die; clicking a hint executes that move for the selected checker, consuming the hint's die.
- Checkers slide between points rather than jumping; dice visibly roll; hints catch the eye. Animate with CSS transitions and CSS animations — each checker animates position changes through a `transition` covering `transform` (or `all`) with a non-zero duration, or through a CSS `animation`; each hint uses a CSS `animation`.
- Hitting sends the opponent's checker to the bar, and you can see it land there; a checker re-entering from the bar travels back onto the board; a checker borne off appears in the off tray.
- Pip counts, cube value, cube owner, score and whose turn it is are all on screen and match the API.
- When you have no legal move, the page says so plainly.
- The board should be on the left and fill the screen, with all the roll, double and other buttons and game info on the right — about 80% of the width for the board and 20% for the buttons. That's on an ordinary laptop screen, 1280×800 or 1440×900, with nothing to scroll.
- The page responds promptly — no action hangs or leaves a player waiting.
- Winning ends the game with a banner, and you can start a new game without reloading the page.
- Difficulty and New Game: the difficulty control is a native `<select>` element; clicking New Game starts a new game at the selected difficulty (POST `/api/new` with `{difficulty}`).

Wording the page uses: `pipWhite` and `pipBlack` contain just the number (e.g. `167`), with any label outside those elements; a hint's visible text is the die value it would use, or "off" for bearing off. The cube owner reads as the human ("you", "your" or "white"), the AI ("ai", "opponent" or "black"), or centered ("center", "centered" or "centre") when nobody owns it. The win banner says "You win" when the human wins; the game has an end-of-game modal (`modalOverlay`), shown by toggling the `hidden` class off `modalOverlay`, and its title contains the word "win" (any capitals).

Required `data-testid` hooks (EXACT — the UI automation selects on these; static elements keep their existing `id` and ALSO carry a `data-testid` with the same string):

**Static:** `scoreWhite`, `scoreBlack`, `difficulty`, `newGameBtn`, `board`, `playfield`, `checkerLayer`, `pointHints`, `turnIndicator`, `pipWhite`, `pipBlack`, `cube`, `cubeVal`, `cubeOwner`, `dice`, `rollBtn`, `doubleBtn`, `undoBtn`, `endTurnBtn`, `message`, `modalOverlay`, `modalTitle`, `modalBody`, `modalBtns`.

**Dynamic:**

- Each board point: `data-testid="point"` and `data-point="<1..24>"` — exactly 24 points.
- Each checker: `data-testid="checker"`, `data-color="white|black"`, `data-loc="<1..24>|bar|off"` — exactly 30 checkers (15 per colour), positioned at their board/bar/off location.
- Each move hint: `data-testid="hint"`.
- Each die: `data-testid="die"`, nested inside the `dice` container.
- After a roll, at least two dice are visible on the board.
- The bar: `data-testid="bar"`.
- The off tray: `data-testid="off-tray"`, containing `data-testid="off-ai"` and `data-testid="off-you"`.

**Before you hand it over, look at it.** Load the page in a browser and play it — click a checker, take a move, roll again, watch the computer reply. What the server returns is not what a player sees, so a page that looks right in the API can still be broken on screen. The notes in this folder show how to drive a browser from a script.

**Write in chunks:** never emit more than ~150 lines in a single write/edit tool call — build large files up in ~150-line chunks across several calls, never one giant call.
