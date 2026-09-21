GOAL: We are building a fully functional backgammon game in Node + TypeScript that runs on localhost. When the server is started, a user navigates to the URL, starts a game, and plays against an AI. The game has all of the makings of a complete product: zero errors and a fully functioning backend.
REQUIREMENT — the game state MUST survive page reloads. A reload must carry over every piece of information from before the reload: the board, the dice, the score, whose turn it is, the difficulty, the doubling cube, and the remaining dice. Load the current state from the server when the page opens — do not start a new game on load.

This is chunk 1 of 5. You are building this product incrementally across several chunks; each chunk gives you one task. Later chunks build on the files and types you work with here.

The complete product (all inside the current working directory), already present as stubs:

- `package.json` — leave as is unless a script is missing.
- `src/game.ts` — backgammon core engine, pure logic, no I/O.
- `src/ai.ts` — AI: evaluation, move choice, win probability, doubling-cube policy.
- `src/server.ts` — HTTP server + API, serves `public/`.
- `public/index.html`, `public/style.css`, `public/app.js` — the page, its styling, its logic.

Runtime: **Node + TypeScript**, zero external runtime dependencies. Node ≥ 22.12 runs the `.ts` files with the `--experimental-strip-types` flag (already wired into `npm start`); engine imports use explicit `./x.ts` specifiers. The start command is `node --experimental-strip-types src/server.ts`, also `npm start`.

Board convention (applies everywhere): points numbered 1..24. **White** is the human and **black** is the AI. White moves HIGH→LOW (24→1), home = 1..6, bears off past point 1. Black moves LOW→HIGH (1→24), home = 19..24, bears off past 24. `points[p] > 0` = that many white checkers; `points[p] < 0` = that many black checkers (abs value). A roll of doubles is carried as four dice.

TASK: Implement the complete backgammon engine in `src/game.ts` — pure logic, no I/O. The shared types and constants (`Player`, `BAR`, `OFF`, `Move`, `AppliedMove`, `Board`, `GameState`) are already written at the top of that file — read them, implement against them, and do not change them; every later chunk imports those names as written. Replace the stubs with real implementations.

Movement and legality — the engine is the authority on what is legal:

- Direction: white moves 24 → 1 (high to low), black moves 1 → 24 (low to high); a checker moves forward by exactly its die's pip count.
- Opening position (`startingPoints()`): the standard opening — 15 checkers per side, indices 0 and 25 unused (0). White: 2 on point 24, 5 on point 13, 3 on point 8, 5 on point 6. Black: 2 on point 1, 5 on point 12, 3 on point 17, 5 on point 19. `points[p] > 0` = white checkers, `points[p] < 0` = black checkers (absolute value).
- Landing and blocking: a checker may land on an empty point, a point it owns, or a point holding exactly one opponent checker. A point holding two or more opponent checkers is blocked.
- Hitting: landing on a lone opponent checker (a blot) hits it — that checker goes to the bar (`applyMove` returns true).
- Bar entry: a player with any checker on the bar must enter them before making any other move. A white bar checker enters on point `25 − die`; a black bar checker enters on point `die`. Entry is blocked if the destination point holds two or more opponent checkers; if every rolled die's entry point is blocked, the player has no legal move (the turn passes).
- Using dice: a player must use as many dice as legally possible; a die cannot be reused once consumed.
- Higher die: when both dice cannot be played but either one alone can, the player must play the higher die.
- Bearing off (`to === OFF`): legal only when all of the player's checkers are in the home board. A die equal to a checker's exact distance bears it off. A die larger than a checker's distance may bear it off (overshoot) only when there is no checker on a higher point (farther from bear-off) in the home board; otherwise the larger die must be played as an in-board move. White's highest point is 6; black's highest point is 19. `singleMoves` yields no bear-off move while any checker is outside the home board or on the bar.
- Move sequences (`allSequences`): return each reachable resulting position once (deduplicated by the resulting board), each entry consuming the maximum number of dice.
- Pip count (`pipCount(b, player)`): the sum over that player's checkers of each checker's distance to bearing off — a white checker on point `p` has distance `p`, a black checker has distance `25 − p`, and a checker on the bar counts as 25.
- Winning (`checkWin`): when a player has borne off all 15 checkers, report `won: true` and classify `"single"`, `"gammon"`, or `"backgammon"` by the standard definitions — single if the opponent has borne off at least one checker; backgammon if the opponent has borne off none AND still has a checker on the bar or in the winner's home board; otherwise gammon.

The exact function surface (EXACT signatures — other modules import these names as written):

```ts
/** The other player. */
export function opponent(p: Player): Player;

/** The standard opening arrangement as a fresh points[] array. */
export function startingPoints(): number[];

/** A fresh GameState for a new game at the given difficulty (white to move, phase "roll", cube `{value: 1, owner: null}`, empty bar and off, `winner: null`, and `points === startingPoints()`). */
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

Also keep in mind (the turn driver itself is wired up in chunk 4): a turn consumes dice as they are played, doubles give four moves, turns alternate white → black → white, and a player with no legal move passes.

**Write in chunks:** never emit more than ~150 lines in a single write/edit tool call — build large files up in ~150-line chunks across several calls, never one giant call.
