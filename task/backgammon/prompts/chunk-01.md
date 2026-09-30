GOAL: We are building a fully functional backgammon game in Node + TypeScript that runs on localhost. When the server is started, a user navigates to the URL, starts a game, and plays against an AI. The game has all of the makings of a complete product: zero errors and a fully functioning backend.
REQUIREMENT — the game state MUST survive page reloads. A reload must carry over every piece of information from before the reload: the board, the dice, the score, whose turn it is, the difficulty, the doubling cube, and the remaining dice. Load the current state from the server when the page opens — do not start a new game on load.

This is chunk 1 of 5. You are building this product incrementally across several chunks; each chunk gives you one task. Later chunks build on the files and types you work with here.

The complete product (all inside the current working directory), already present as stubs:

- `package.json` — leave as is unless a script is missing.
- `src/game.ts` — backgammon core engine, pure logic, no I/O.
- `src/ai.ts` — AI: evaluation, move choice, win probability, doubling-cube policy.
- `src/server.ts` — HTTP server + API, serves `public/`.
- `public/index.html`, `public/style.css`, `public/app.js` — the page, its styling, its logic.

Runtime: **Node + TypeScript**, zero external runtime dependencies. Node ≥ 22.12 runs the `.ts` files with the `--experimental-strip-types` flag (already wired into `npm start`); engine imports use explicit `./x.ts` specifiers. Start command: `node --experimental-strip-types src/server.ts` (also `npm start`).

TASK: Implement the complete backgammon engine in `src/game.ts` — pure logic, no I/O. The shared types and constants (`Player`, `BAR`, `OFF`, `Move`, `AppliedMove`, `Board`, `GameState`) are already written at the top of that file — read them, implement against them, and do not change them; every later chunk imports those names as written. Replace the stubs with real implementations.

You know how backgammon is played. What you cannot know is how THIS codebase lays the board out in memory, and the rest of the product is written against that layout. So the game is yours; the representation below is ours, and everything else imports it exactly as written.

**How the board is laid out.** Picture the board from the human player's seat. The human is **white** and the computer is **black**. White's checkers travel anticlockwise — from our point 24 around to our point 1 — and bear off past point 1. Black's travel the opposite way round, from point 1 up to point 24, bearing off past 24. A new game starts with 2 of white's checkers on point 24, 5 on 13, 3 on 8 and 5 on 6, and black's the mirror: 2 on point 1, 5 on 12, 3 on 17 and 5 on 19.

**How that is stored.** `points` is an array of 26 slots. Only 1..24 are real points; slots 0 and 25 are always 0 and exist so the point numbers line up with the indexes. One slot holds one point's whole stack as a single signed number: **positive means that many white checkers, negative means that many black checkers.** So `points[3] === 2` is two white checkers on point 3, and `points[20] === -4` is four black ones on point 20. Checkers that are off the board live in `bar` and `off`, each with a `white` and a `black` count.

**Two sentinel values, because a move off the bar or off the board has no point number.** A checker entering from the bar has `from: BAR` (0). A checker bearing off has `to: OFF` (25). They are only ever used in those two positions.

**Dice.** A roll is the dice for that turn; doubles are carried as **four** entries, not two. Before anyone has moved, the first `/api/roll` rolls ONE die per side and `dice` is `[playerDie, computerDie]` — the player's die first, the computer's die second — and the higher side goes first; a tie rolls again.

A few of the functions below are ours rather than the game's, and their descriptions say exactly what they must return.

The exact function surface (EXACT signatures — other modules import these names as written):

```ts
/** The other player. */
export function opponent(p: Player): Player;

/** The standard opening arrangement as a fresh points[] array. */
export function startingPoints(): number[];

/** A fresh GameState for a new game at the given difficulty — the new game starts in phase "openingRoll" (white to move), cube `{value: 1, owner: null}`, empty bar and off, `winner: null`, and `points === startingPoints()`. */
export function createGame(difficulty: GameState["difficulty"]): GameState;

/** True when ALL of `player`'s checkers are in that player's home quadrant. */
export function allInHome(b: Board, player: Player): boolean;

/** Deep-copy a Board (points + bar + off) so callers can explore without mutating. */
export function cloneBoard(b: Board): Board;

/** Every legal single-checker move `player` could make using ONE die of value `die` from board
 *  `b`, as {from,to,die}. `from` is BAR for a checker entering from the bar; `to` is OFF for a
 *  checker being borne off. */
export function singleMoves(b: Board, player: Player, die: number): Move[];

/** Apply one single move to board `b` IN PLACE for `player`. Returns whether the move hit an
 *  opponent blot. */
export function applyMove(b: Board, player: Player, m: Move): boolean;

/** The maximum number of dice from `dice` that `player` can legally consume from board `b`. */
export function maxPlies(b: Board, player: Player, dice: number[]): number;

/** The single moves `player` may legally choose RIGHT NOW given the remaining `dice`. */
export function legalMovesNow(b: Board, player: Player, dice: number[]): Move[];

/** Every distinct position `player` can reach by playing a full turn from board `b` with `dice`,
 *  consuming as many dice as the rules allow. Entries are distinct by RESULTING BOARD — one entry
 *  per reachable position, each with one representative move-path. Used by the AI. */
export function allSequences(b: Board, player: Player, dice: number[]): { board: Board; moves: Move[] }[];

/** The pip count for `player` on board `b`. */
export function pipCount(b: Board, player: Player): number;

/** Whether `player` has borne off all 15 checkers, and if so how the win is classified. */
export function checkWin(b: Board, player: Player): { won: boolean; type: "single" | "gammon" | "backgammon" | null };
```

**Before you hand it over, run it.** Import the engine and put it through a real sequence — a fresh game, several rolls, moves played out for both white and black, a position carried far enough to bear off. You are not checking that any particular answer is right; you are checking that it runs at all. Code that throws, or that never comes back, only shows itself when something executes it.

**Write in chunks:** never emit more than ~150 lines in a single write/edit tool call — build large files up in ~150-line chunks across several calls, never one giant call.
