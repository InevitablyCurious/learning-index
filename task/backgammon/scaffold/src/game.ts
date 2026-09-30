// Backgammon core engine — pure logic, no I/O.
// Conventions:
//   Points are numbered 1..24. Internally stored in `points[1..24]`.
//   White (the human) moves from HIGH points to LOW points (24 -> 1).
//   Black (the AI) moves from LOW points to HIGH points (1 -> 24).
//   points[p] > 0  => that many WHITE checkers on point p.
//   points[p] < 0  => that many BLACK checkers on point p (abs value).
//   Bearing off: a checker leaving the board, either colour, moves to OFF.

export type Player = "white" | "black";

export const BAR = 0; // sentinel "from" for entering from the bar
export const OFF = 25; // sentinel "to" for bearing off

export interface Move {
  from: number;
  to: number;
  die: number;
}

export interface AppliedMove extends Move {
  hit: boolean;
}

export interface Board {
  points: number[];
  bar: { white: number; black: number };
  off: { white: number; black: number };
}

export interface GameState {
  points: number[];
  bar: { white: number; black: number };
  off: { white: number; black: number };
  turn: Player;
  phase: "openingRoll" | "roll" | "move" | "gameover" | "doubleOffered";
  dice: number[];
  remainingDice: number[];
  cube: { value: number; owner: Player | null };
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

/** The other player. */
export function opponent(p: Player): Player {
  throw new Error("not implemented");
}

/** The standard opening arrangement as a fresh points[] array. */
export function startingPoints(): number[] {
  throw new Error("not implemented");
}

/** A fresh GameState for a new game at the given difficulty — the new game starts in phase
 *  "openingRoll" (white to move), cube `{value: 1, owner: null}`, empty bar and off, `winner: null`,
 *  and `points === startingPoints()`. */
export function createGame(difficulty: GameState["difficulty"]): GameState {
  throw new Error("not implemented");
}

/** Deep-copy a Board (points + bar + off) so callers can explore without mutating. */
export function cloneBoard(b: Board): Board {
  throw new Error("not implemented");
}

/** True when ALL of `player`'s checkers are in that player's home quadrant. */
export function allInHome(b: Board, player: Player): boolean {
  throw new Error("not implemented");
}

/** Every legal single-checker move `player` could make using ONE die of value `die` from board
 *  `b`, as {from,to,die}. `from` is BAR for a checker entering from the bar; `to` is OFF for a
 *  checker being borne off. */
export function singleMoves(b: Board, player: Player, die: number): Move[] {
  throw new Error("not implemented");
}

/** Apply one single move to board `b` IN PLACE for `player`. Returns whether the move hit an
 *  opponent blot. */
export function applyMove(b: Board, player: Player, m: Move): boolean {
  throw new Error("not implemented");
}

/** The maximum number of dice from `dice` that `player` can legally consume from board `b`. */
export function maxPlies(b: Board, player: Player, dice: number[]): number {
  throw new Error("not implemented");
}

/** The single moves `player` may legally choose RIGHT NOW given the remaining `dice`. */
export function legalMovesNow(b: Board, player: Player, dice: number[]): Move[] {
  throw new Error("not implemented");
}

/** Every distinct position `player` can reach by playing a full turn from board `b` with `dice`,
 *  consuming as many dice as the rules allow. Entries are distinct by RESULTING BOARD — one entry
 *  per reachable position, each with one representative move-path. Used by the AI. */
export function allSequences(
  b: Board,
  player: Player,
  dice: number[],
): { board: Board; moves: Move[] }[] {
  throw new Error("not implemented");
}

/** The pip count for `player` on board `b`. */
export function pipCount(b: Board, player: Player): number {
  throw new Error("not implemented");
}

/** Whether `player` has borne off all 15 checkers, and if so how the win is classified. */
export function checkWin(b: Board, player: Player): { won: boolean; type: "single" | "gammon" | "backgammon" | null } {
  throw new Error("not implemented");
}
