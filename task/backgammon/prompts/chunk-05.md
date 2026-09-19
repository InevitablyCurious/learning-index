GOAL: We are building a fully functional backgammon game in Node + TypeScript that runs on localhost. This is chunk 5 of 6. The backend (engine, AI, API) is complete from chunks 2-4.
REQUIREMENT — the game state MUST survive page reloads. A reload must carry over every piece of information from before the reload: the board, the dice, the score, whose turn it is, the difficulty, the doubling cube, and the remaining dice. Load the current state from the server when the page opens — do not start a new game on load.

TASK: Build the frontend in `public/index.html`, `public/style.css`, and `public/app.js` — a compact, animated, fully playable board UI driven by the API.

Render everything from the serialized state: checkers on points, bar and off, dice, cube, pip counts, score, turn indicator, messages. Call the API with root-relative paths (`fetch('/api/state', …)`) so the page works whichever host name it was loaded from.

What the game should feel like to play:

- Clicking one of your checkers shows you where it can go, and clicking one of those destinations plays that move.
- Checkers slide between points rather than jumping; dice visibly roll; hints catch the eye. Animate with CSS transitions and CSS animations — each checker animates position changes through a `transition` covering `transform` (or `all`) with a non-zero duration, or through a CSS `animation`; each hint uses a CSS `animation`.
- Hitting sends the opponent's checker to the bar, and you can see it land there; a checker re-entering from the bar travels back onto the board; a checker borne off appears in the off tray.
- Pip counts, cube value, cube owner, score and whose turn it is are all on screen and match the API.
- When you have no legal move, the page says so plainly.
- The board fits the window with no sideways scrolling on ordinary laptop screens (1280×800 and 1440×900).
- Winning ends the game with a banner, and you can start a new game without reloading the page.
- Difficulty and New Game: the difficulty selector chooses a difficulty; clicking New Game starts a new game at the selected difficulty (POST `/api/new` with `{difficulty}`).

Wording the page uses: `pipWhite` and `pipBlack` contain just the number (e.g. `167`), with any label outside those elements; a hint's visible text is the die value it would use, or "off" for bearing off. The cube owner reads as the human ("you", "your" or "white"), the AI ("ai", "opponent" or "black"), or centered ("center", "centered" or "centre") when nobody owns it. The win banner says "You win" when the human wins; if you show an end-of-game modal, its title contains the word "win" (any capitals) and it is shown by toggling the `hidden` class off `modalOverlay`.

Required `data-testid` hooks (EXACT — the UI automation selects on these; static elements keep their existing `id` and ALSO carry a `data-testid` with the same string):

**Static:** `scoreWhite`, `scoreBlack`, `difficulty`, `newGameBtn`, `board`, `playfield`, `checkerLayer`, `pointHints`, `turnIndicator`, `pipWhite`, `pipBlack`, `cube`, `cubeVal`, `cubeOwner`, `dice`, `rollBtn`, `doubleBtn`, `undoBtn`, `endTurnBtn`, `message`, `modalOverlay`, `modalTitle`, `modalBody`, `modalBtns`.

**Dynamic:**

- Each board point: `data-testid="point"` and `data-point="<1..24>"` — exactly 24 points.
- Each checker: `data-testid="checker"`, `data-color="white|black"`, `data-loc="<1..24>|bar|off"` — exactly 30 checkers (15 per colour), positioned at their board/bar/off location.
- Each move hint: `data-testid="hint"`.
- Each die: `data-testid="die"` (classes `used` / `rolling` convey state).
- The bar column: `data-testid="bar"`.
- The off tray: `data-testid="off-tray"`, with halves `data-testid="off-ai"` and `data-testid="off-you"`.

**Write in chunks:** never emit more than ~150 lines in a single write/edit tool call — build large files up in ~150-line chunks across several calls, never one giant call.
