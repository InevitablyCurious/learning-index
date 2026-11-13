TASK: Add the gameplay in `public/index.html`, `public/style.css`, and `public/app.js` — rolling, opening, hints, moves, the computer's turn, the cube, bearing off and game over.

Render everything from the serialized state: dice, cube.

Call the API with root-relative paths (`fetch('/api/state', …)`) so the page works whichever host name it was loaded from.
Never use an absolute base such as `http://127.0.0.1:8002/api/state` — a browser treats `localhost` and `127.0.0.1` as distinct origins.

What the game should feel like to play:

- Clicking anywhere in the column of a point holding one of your movable pieces picks up that point's top piece and shows its hints; with a piece picked up, clicking anywhere in the column of a point it can move to plays that move — the point itself (the rectangle that encompasses its triangle), a stack of pieces on it, or its hint. When a piece you've picked up can bear off, clicking anywhere in the off tray bears it off, the same as its "off" hint.
- A hint appears for each playable die only after a piece is selected, and updates immediately when a different piece is selected; a piece on the bar is included — its entry hints appear only once it is clicked, one hint per playable entry die. Clicking a hint executes that move, consuming the hint's die.
- A move hint is a dimmed, light-green marker the size of a piece.
- Hitting sends the opponent's checker to the bar, and you can see it land there; a checker re-entering from the bar travels back onto the board; a checker borne off appears in the off tray.
- When you have no legal move, your dice stay up dimmed for about a second — that is how you see why you can't move — then play passes to the other side by itself.
- When the computer has no legal move, its dice stay up for about a second, the message says "No moves available", and the turn comes back to you to roll.
- The computer's turn is paced so a player can follow it: about a second after you click End Turn its dice roll, they stay readable for about a second before the first move, then each further move follows about half a second after the last.
- After every roll, the dice land and stay still and readable for at least one second before the game does anything else on its own — no move, no turn change, no new roll.
- Your turn never ends by itself. After you've played every die you can, the game waits for you to click End Turn to hand the turn over. Until you click End Turn, Undo keeps working and steps your moves back one at a time.
- Fast Forward: a button `data-testid="fastForwardBtn"`, with the other buttons and the same size as them, appears for the whole of your turn in a race — before you roll, after you roll and after your moves — when neither side has a checker on the bar and every one of your checkers has passed every one of the computer's, so neither side can hit the other anymore; at any other time it is hidden. The button reads "Fast Forward" normally and "Pause" while it is running. Clicking it, at any point in your turn, plays out the rest of the game automatically from there for both you and the computer, rolling the dice and moving the pieces for each side in turn, at the computer's own pace — the dice stay readable about a second, then each move follows about half a second after the last, a double's four moves the same — until someone wins. While it runs, the button stays on screen reading "Pause", through the computer's turns too. Clicking "Pause" stops it and the button reads "Fast Forward" again; clicking that carries on. If the computer offers a double while it is running, the automatic play stops and the offer shows; once you answer, the computer finishes its turn and play stays stopped until you click "Fast Forward" again — whether or not you have rolled. It never offers a double of your own.
- The page responds promptly — no action hangs or leaves a player waiting.
- The page shows no errors in the browser console — on both localhost and 127.0.0.1.
- Winning ends the game with a banner, and you can start a new game without reloading the page.
- The computer's double and take messages are short and plain — they say the computer is offering, taking, or passing a double, and never show its win percentage, its pip counts, or its reasoning.
- Difficulty and New Game: the difficulty control is a native `<select>` element; clicking New Game starts a new game at the selected difficulty (POST `/api/new` with `{difficulty}`).

`pipWhite` and `pipBlack` contain just the number (e.g. `167`), with any label outside those elements; a hint's visible text is the die value it would use, or "off" for bearing off.
The cube owner reads as the human ("you", "your" or "white"), the AI ("ai", "opponent" or "black"), or centered ("center", "centered" or "centre") when nobody owns it.
The win banner says "You win" when the human wins; the game has an end-of-game modal (`modalOverlay`), shown by toggling the `hidden` class off `modalOverlay`, and its title contains the word "win" (any capitals).
The end-of-game modal also shows who won and the points the game was worth, as a number with the word "point" or "points", and it does not show a "Match score" line.
When the computer offers a double, the two buttons that answer it read Accept (or Take) and Decline (or Pass).

Required `data-testid` hooks (EXACT — the UI automation selects on these; static elements keep their existing `id` and ALSO carry a `data-testid` with the same string):

**Dynamic:**

- Each move hint: `data-testid="hint"`.
- Each die: `data-testid="die"`, nested inside the `dice` container.
- After a roll, exactly two dice are visible, a double too — a double still gives four moves.
- A die that has been played stays on screen, greyed out — visibly fainter than a die not yet played.
- A new game waits for the player to press Roll for the opening roll; nothing rolls by itself when the page opens.
- During the opening roll the page shows BOTH dice — the player's die and the computer's die — each marked with a `data-owner` of `you` (the player's) or `ai` (the computer's) so the player can tell whose is whose, and drawn in that side's colour — the player's die as pale as the player's checkers, the computer's as dark as its own. The two opening dice stay on screen, still marked, after the throw resolves. The tie message contains the words `Tie — roll again`; the tied dice stay up and the page waits for the player to press Roll, which rolls both dice again — as many times as it takes until they differ. The winner of the opening plays those two numbers: the player's hints use them, and the computer's first move uses them.

**Before you hand it over, look at it.** Load the page in a browser and play it — click a checker, take a move, roll again, watch the computer reply. What the server returns is not what a player sees, so a page that looks right in the API can still be broken on screen. The notes in this folder show how to drive a browser from a script.
