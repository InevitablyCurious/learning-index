GOAL: We are building a fully functional backgammon game in Node + TypeScript that runs on localhost. This is chunk 2 of 6.

TASK: Implement the complete backgammon engine in `src/game.ts` — pure logic, no I/O. The shared types/constants are already in place from chunk 1 (do not change them). Replace the stubs with real implementations.

The exact function surface (EXACT signatures — other modules import these names and doc-comments as written):

```ts
/** The two-player identity: returns the other player. */
export function opponent(p: Player): number /* Player */;

/** The standard opening arrangement as a fresh points[] array (see REQ-INIT). */
export function startingPoints(): number[];

/** A fresh GameState for a new game at the given difficulty (white to move, phase "roll"). */
export function createGame(difficulty: GameState["difficulty"]): GameState;

/** True when ALL of `player`'s checkers are in that player's home quadrant (none on the bar,
 *  none outside home). White home = points 1..6; black home = points 19..24. */
export function allInHome(b: Board, player: Player): boolean;

/** Deep-copy a Board (points + bar + off) so callers can explore without mutating. */
export function cloneBoard(b: Board): Board;

/** Every legal single-checker move `player` could make using ONE die of value `die` from board
 *  `b`, as {from,to,die}. `from` may be BAR; `to` may be OFF. Rules — see REQ-BAR (bar entry),
 *  REQ-HIT (landing/hitting), REQ-BEAROFF (bearing off & overshoot), REQ-BEAROFF-GATE. */
export function singleMoves(b: Board, player: Player, die: number): Move[];

/** Apply one single move to board `b` IN PLACE for `player`. Returns whether the move hit an
 *  opponent blot (sending it to the bar). See REQ-HIT. */
export function applyMove(b: Board, player: Player, m: Move): boolean;

/** The maximum number of dice from `dice` that `player` can legally consume from board `b`
 *  (searching all orderings). Doubles present as four dice. */
export function maxPlies(b: Board, player: Player, dice: number[]): number;

/** The single moves `player` may legally choose RIGHT NOW given the remaining `dice`, honouring
 *  REQ-USEMAX (must use as many dice as possible) and REQ-HIGHER-DIE (must play the higher die when
 *  only one of the two can be played). */
export function legalMovesNow(b: Board, player: Player, dice: number[]): Move[];

/** Every distinct position `player` can reach by playing a MAXIMAL full turn from board `b`
 *  with `dice` (maximal = consuming `maxPlies(b, player, dice)` dice). Each entry is the
 *  resulting board plus one representative move-path that reaches it. See REQ-SEQ-DEDUP:
 *  results are distinct by RESULTING BOARD, not by move-path. The AI in chunk 3 builds on this. */
export function allSequences(b: Board, player: Player, dice: number[]): { board: Board; moves: Move[] }[];

/** The pip count for `player` on board `b` (see REQ-PIP; bar checkers count as max distance 25). */
export function pipCount(b: Board, player: Player): number;

/** Whether `player` has borne off all 15 checkers, and if so the classification of the win
 *  (see REQ-WINCLASS for how the three results are classified). */
export function checkWin(b: Board, player: Player): { won: boolean; type: "single" | "gammon" | "backgammon" | null };
```

Rules (all mandatory):

- **REQ-INIT — opening position.** `startingPoints()` MUST return the standard backgammon opening arrangement as a 26-length array, laid out in the board convention above (index 0 and 25 unused = 0, 15 checkers per side). A fresh `createGame(d)` has white to move, phase `"roll"`, cube `{value:1, owner:null}`, empty bar/off, `winner:null`, `points === startingPoints()`.
- **REQ-PIP — pip counting.** A white checker on point `p` has distance `p`; a black checker on point `p` has distance `25 − p`; a checker on the bar counts as the maximum distance `25`. `pipCount` is the sum of those distances over all of that player's checkers.
- **REQ-BAR — bar entry.** A player with any checker on the bar MUST enter before any other move. A white bar checker enters on point `25 − die`; a black bar checker enters on point `die`. Entry is blocked if the destination holds ≥2 opponent checkers; if every rolled die's entry is blocked there is no legal move. While a checker is on the bar, `singleMoves` returns only bar-entry moves (`from === BAR`).
- **REQ-HIT — landing & hitting.** A checker may land on an empty point, a point it owns, or a blot (exactly one opponent checker) — landing on a blot hits it to the bar (`applyMove` returns `true`). A point with ≥2 opponent checkers is blocked.
- **REQ-USEMAX — use as many dice as possible.** A player must play a sequence that consumes the maximum number of dice legally possible.
- **REQ-HIGHER-DIE — higher die when only one is playable.** When both dice cannot be played but either one alone can, the player MUST play the higher die.
- **REQ-BEAROFF — bearing off & overshoot.** Bearing off (`to === OFF`) is legal only when `allInHome(b, player)`. A die equal to a checker's exact distance bears it off. A die LARGER than the distance may bear it off ONLY when no checker sits on a higher point (farther from bear-off) in that player's home board; otherwise the larger die must be played as an in-board move. (White point 6 is highest/farthest; black point 19 is highest.)
- **REQ-SEQ-DEDUP — full-turn sequences are distinct by resulting board.** Different orderings of the same moves usually reach the SAME position. `allSequences` returns each reachable position ONCE, with one representative move-path, not one entry per path. Every entry is maximal (consumes `maxPlies` dice).
- **REQ-BEAROFF-GATE — no bear-off while not all home.** `singleMoves` yields no bear-off move while any of the player's checkers is outside the home board or on the bar.
- **REQ-WINCLASS — win classification.** When a player has borne off all 15 checkers, `checkWin` reports the win and classifies it as `"single"`, `"gammon"` or `"backgammon"` by the standard backgammon definitions of those three results.

Also required by the full product (keep these in mind so your engine shapes support them): full turn flow — doubles give 4 moves, dice are consumed as used, turns alternate white → black → white, and a player with no legal move auto-passes (`turnOver === true`, `legalMoves === []`, message mentions "no legal move"/"pass"). The turn driver itself is wired up in chunk 4.

**Write in chunks:** never emit more than ~150 lines in a single write/edit tool call — build large files up in ~150-line chunks across several calls, never one giant call.
