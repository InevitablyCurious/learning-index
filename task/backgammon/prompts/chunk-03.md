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
| POST | `/api/roll` | — | Human rolls; phase → move. |
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
pip, legalMoves, canDouble
```

- `pip`: `{ white: number, black: number }` — both players' pip counts from the engine.
- `legalMoves`: `Move[]` — the human's legal moves right now (`[]` unless it is the human's move phase).
- `canDouble`: boolean — whether the human may offer a double at this moment.
- `history` is NOT serialized.
- The server MUST hold a complete, initialized game state from startup, so `/api/state` and `/api/debug/state` return a valid serialized game even before any `/api/new` is called.

Turn flow the server drives: `/api/ai` advances the computer's turn using `chooseMoves`. When the human has no move available, the response carries `turnOver === true`, `legalMoves === []`, and a `message` whose wording contains **"no legal move"** or **"pass"** — automation reads that wording, so those words have to appear. A finished game reports `winner`, `winType`, `pointsWon` and a clear `message`. `/api/new` starts a fresh game without any page reload and carries `score` and `gamesPlayed` forward.

- Doubling cube state: the cube is `{value, owner}`, and **`owner: null` is how we represent a centered cube** — a new game starts `{value: 1, owner: null}`. `canDouble` reports whether the human may offer a double at this exact moment.

Debug seam — gated by env `DEBUG_API=1`; when `DEBUG_API` is not `1` these routes behave as unknown endpoints (404). It exists so a game can be driven into a known position with known dice:

| Method | Path | Body | Effect |
|---|---|---|---|
| POST | `/api/debug/state` | a full/partial state object (field names as above) | Overwrite the in-memory game with the supplied fields. The response is the resulting serialized state, and it echoes the supplied fields back — a position set this way reads back the same through `/api/state`. |
| POST | `/api/debug/roll` | `{dice:number[]}` | Enqueue `dice` as the next roll; the next dice-roll consumes this queue instead of `Math.random`. Doubles are a 4-length array (e.g. `[3,3,3,3]`); a normal roll is 2-length. A subsequent `/api/roll` yields those dice, sorted ascending in `dice`. Returns serialized state. |

A position supplied to `/api/debug/state` is a real backgammon position — exactly 15 checkers per side across points, bar and off.

**Write in chunks:** never emit more than ~150 lines in a single write/edit tool call — build large files up in ~150-line chunks across several calls, never one giant call.
