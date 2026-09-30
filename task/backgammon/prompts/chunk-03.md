GOAL: We are building a fully functional backgammon game in Node + TypeScript that runs on localhost. This is chunk 3 of 5. The engine (`src/game.ts`) and AI (`src/ai.ts`) are complete.
REQUIREMENT — the game state MUST survive page reloads. A reload must carry over every piece of information from before the reload: the board, the dice, the score, whose turn it is, the difficulty, the doubling cube, and the remaining dice. Load the current state from the server when the page opens — do not start a new game on load.

TASK: Implement the HTTP server and the full game API in `src/server.ts`, wiring the engine and AI into a playable backend.

Binding: listen on `PORT`, or **8002** when it is unset; print a startup line with the URL; if the port is taken, exit non-zero after a clear single-line message that names the port and says it is already in use.

All game routes accept `POST` with a JSON body (empty `{}` allowed) and respond `200 application/json` with the full serialized state (below). Unknown `/api/*` → `404 {"error":"unknown endpoint"}`. Static files are served from `public/` for all other paths. The root URL `/` and every other non-`/api` path serves the HTML page from `public/` with `Content-Type: text/html`, so a browser renders it as a page — never as a file download.

The API surface (EXACT):

| Method | Path | Body | Effect |
|---|---|---|---|
| POST | `/api/state` | — | Return current state (no mutation). |
| POST | `/api/new` | `{difficulty?}` | New game, keep score. |
| POST | `/api/roll` | — | During `openingRoll`, rolls ONE die per side and returns `dice = [playerDie, computerDie]` (player die first): if unequal, the higher side becomes `turn`, `phase` → `"move"`, and `remainingDice` = the two numbers; if equal, `phase` stays `"openingRoll"` and the message contains the exact text `Tie — roll again`. Otherwise (a normal turn) the human rolls and phase → move. |
| POST | `/api/move` | `{from,to,die}` | Apply one human sub-move. |
| POST | `/api/undo` | — | Undo last sub-move this turn. |
| POST | `/api/endturn` | — | End human turn (only when `turnOver`). |
| POST | `/api/double` | — | Human offers a double; AI responds. |
| POST | `/api/double/respond` | `{accept:boolean}` | Human answers an AI-offered double. |
| POST | `/api/ai` | — | Advance one AI step. |
| GET | `/health` | — | `200 {"status":"ok","port":8002}` (liveness; always available). |

Serialized state — every game-route response carries exactly these top-level keys (plus any route-specific `extra` fields spread in):

```
points, bar, off, turn, phase, dice, remainingDice, cube, difficulty, score,
winner, winType, pointsWon, doubleOfferedBy, message, turnOver, gamesPlayed,
pip, legalMoves, canDouble, isRace
```

- `pip`: `{ white: number, black: number }` — both players' pip counts from the engine.
- `legalMoves`: `Move[]` — the human's legal moves right now (`[]` unless it is the human's move phase).
- `canDouble`: boolean — whether the human may offer a double at this moment.
- `isRace`: boolean — whether the game is a pure race right now: nobody has a checker on the bar and every one of your (white) checkers has passed every one of the computer's (black) checkers, so neither side can hit the other anymore.
- `history` is NOT serialized.
- The server MUST hold a complete, initialized game state from startup, so `/api/state` and `/api/debug/state` return a valid serialized game even before any `/api/new` is called.

Turn flow the server drives: `/api/ai` advances the computer's turn using `chooseMoves`. When the human has no move available, the response carries `turnOver === true` and `legalMoves === []`. When either side has no legal move, the `message` contains the words **"No moves available"** (the computer's, for example, is "AI rolled 6 and 5 — No moves available."). A finished game reports `winner`, `winType`, `pointsWon` and a clear `message`. `/api/new` starts a fresh game without any page reload and carries `score` and `gamesPlayed` forward.

- Doubling cube state: the cube is `{value, owner}`, and **`owner: null` is how we represent a centered cube** — a new game starts `{value: 1, owner: null}`. `canDouble` reports whether the human may offer a double at this exact moment.
- The computer's double messages are plain words: when it offers a double the message says it is offering; when it answers a double the message says it accepts or declines — never a win percentage, a pip count, or its reasoning.

Debug seam — gated by env `DEBUG_API=1`; when `DEBUG_API` is not `1` these routes behave as unknown endpoints (404). It exists so a game can be driven into a known position with known dice:

| Method | Path | Body | Effect |
|---|---|---|---|
| POST | `/api/debug/state` | a full/partial state object — any of these fields: `points`, `bar`, `off`, `turn`, `phase`, `dice`, `remainingDice`, `cube`, `difficulty`, `score`, `winner`, `winType`, `pointsWon`, `doubleOfferedBy`, `message`, `turnOver`, `gamesPlayed` | Overwrite the in-memory game with the supplied fields. The response is the resulting serialized state, and it echoes the supplied fields back — a position set this way reads back the same through `/api/state`. |
| POST | `/api/debug/roll` | `{dice:number[]}` | Enqueue `dice` as the next roll; the next dice-roll consumes this queue instead of `Math.random`. Doubles are a 4-length array (e.g. `[3,3,3,3]`); a normal roll is 2-length. During `openingRoll` a two-die array is forced verbatim as `[playerDie, computerDie]`; outside `openingRoll` a subsequent `/api/roll` yields those dice sorted ascending in `dice`. Returns serialized state. |

A position supplied to `/api/debug/state` is a real backgammon position — exactly 15 checkers per side across points, bar and off.

**Before you hand it over, run it.** Start the server and drive it — every route, with real bodies, including the ones that should fail. Play a turn through: roll, move, end the turn, let the AI answer. Read the responses rather than assuming them. The notes in this folder show how to start a server, test it, and stop it in one command.

**Write in chunks:** never emit more than ~150 lines in a single write/edit tool call — build large files up in ~150-line chunks across several calls, never one giant call.
