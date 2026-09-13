GOAL: We are building a fully functional backgammon game in Node + TypeScript that runs on localhost. When the server is started, a user navigates to the URL, starts a game, and plays against an AI. The game has all of the makings of a complete product: zero errors and a fully functioning backend.

This is chunk 1 of 6. You are building this product incrementally across several chunks; each chunk gives you one task. Later chunks build on the files and types you set up here.

TASK: Establish the project structure and the shared type foundation that every later chunk builds on.

The complete file list for the product (all inside the current working directory):

- `package.json` — already present; `"start": "node src/server.ts"`. Leave as is unless a script is missing.
- `src/game.ts` — backgammon core engine, pure logic, no I/O.
- `src/ai.ts` — AI: evaluation, move choice, win probability, doubling-cube policy.
- `src/server.ts` — HTTP server + API, serves `public/`.
- `public/index.html` — the page.
- `public/style.css` — styling.
- `public/app.js` — frontend logic.

Stub files may already exist. Your job in THIS chunk:

1. Verify every file above exists; create any that are missing.
2. In `src/game.ts`, write the EXACT shared types and constants below verbatim — later steps implement functions against them, so these names need to be exact:

```ts
export type Player = "white" | "black";
export const BAR = 0;   // sentinel "from" for entering from the bar
export const OFF = 25;  // sentinel "to" for bearing off

export interface Move { from: number; to: number; die: number; }
export interface AppliedMove extends Move { hit: boolean; }

export interface Board {
  points: number[];                              // length 26, index 1..24 used; +n = n white, -n = n black
  bar: { white: number; black: number };
  off: { white: number; black: number };
}

export interface GameState {
  points: number[];
  bar: { white: number; black: number };
  off: { white: number; black: number };
  turn: Player;
  phase: "roll" | "move" | "gameover" | "doubleOffered";
  dice: number[];                                // dice rolled this turn (2, or 4 for doubles)
  remainingDice: number[];                       // dice not yet consumed
  cube: { value: number; owner: Player | null }; // null owner = centered
  difficulty: "easy" | "medium" | "hard";
  score: { white: number; black: number };
  winner: Player | null;
  winType: "single" | "gammon" | "backgammon" | null;
  pointsWon: number;
  doubleOfferedBy: Player | null;
  message: string;
  history: AppliedMove[];
  canDouble: boolean;
  turnOver: boolean;
  gamesPlayed: number;
}
```

Board convention (applies everywhere): points numbered 1..24. **White** (the human) moves HIGH→LOW (24→1), home = 1..6, bears off past point 1. **Black** (the AI) moves LOW→HIGH (1→24), home = 19..24, bears off past 24. `points[p] > 0` = that many white checkers; `points[p] < 0` = that many black checkers (abs value).

3. Leave function bodies for later chunks — export stubs that throw or return safe defaults, so every file parses and the server file can be filled in chunk 4.

Requirements for this chunk:

- Language/runtime: **Node + TypeScript**, zero external runtime deps. Node ≥ 22.12 runs the `.ts` files with the `--experimental-strip-types` flag (already wired into the `npm start` script); engine imports use explicit `./x.ts` specifiers.
- Start command (from the implementation dir): `node --experimental-strip-types src/server.ts` (also `npm start`).
- The HTTP server MUST listen on the port given by the `PORT` environment variable, falling back to **8002** when `PORT` is not set — `const PORT = Number(process.env.PORT ?? 8002)`. The stub `src/server.ts` already does this; leave it that way. Running on the default, the game MUST be reachable at both `http://localhost:8002/` and `http://127.0.0.1:8002/` — the same page and the same API, whichever of the two host names a user types. If the port is already in use, the process MUST exit non-zero after printing a clear, single-line message that names that port and states it is already in use (not a raw unhandled-exception stack). On successful boot it MUST print a startup line containing the URL it is serving. (A minimal server boot is fine in this chunk; routes arrive in chunk 4.)

**Write in chunks:** never emit more than ~150 lines in a single write/edit tool call — build large files up in ~150-line chunks across several calls, never one giant call.
