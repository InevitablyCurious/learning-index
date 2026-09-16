GOAL: We are building a fully functional backgammon game in Node + TypeScript that runs on localhost. This is chunk 2 of 6.

TASK: Implement the complete backgammon engine in `src/game.ts` — pure logic, no I/O. The shared types and constants are already in place from chunk 1 (do not change them). Replace the stubs with real implementations.

Standard backgammon rules apply throughout; the engine is the authority on what is legal.

The exact function surface (EXACT signatures — other modules import these names as written):

```ts
/** The other player. */
export function opponent(p: Player): Player;

/** The standard opening arrangement as a fresh points[] array. */
export function startingPoints(): number[];

/** A fresh GameState for a new game at the given difficulty (white to move, phase "roll", centered cube, empty bar and off). */
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
