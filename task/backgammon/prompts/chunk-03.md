GOAL: We are building a fully functional backgammon game in Node + TypeScript that runs on localhost. This is chunk 3 of 6. The engine (`src/game.ts`) is complete from chunk 2.
REQUIREMENT — the game state MUST survive page reloads. A reload must carry over every piece of information from before the reload: the board, the dice, the score, whose turn it is, the difficulty, the doubling cube, and the remaining dice. Load the current state from the server when the page opens — do not start a new game on load.

TASK: Implement the AI in `src/ai.ts` — evaluation, move choice, win probability, and the doubling-cube policy with accept/decline reasoning. Replace the stubs with real implementations.

The exact function surface (EXACT signatures — other modules import these names as written):

```ts
type AiMoveResult = { moves: Move[]; board: Board };
type CubeDecision = { action: "double" | "no-double"; reasoning: string };

/** A scalar quality score of board `b` from `player`'s perspective (higher = better for player). */
export function evaluate(b: Board, player: Player): number;

/** Choose the AI's full-turn move sequence for the given `dice` at `difficulty`, returning the
 *  chosen moves and resulting board. */
export function chooseMoves(b: Board, player: Player, dice: number[], difficulty: "easy" | "medium" | "hard"): AiMoveResult;

/** Estimate `player`'s probability of winning from board `b`, in [0,1]. */
export function winProbability(b: Board, player: Player): number;

/** Decide whether the AI (`player`) should OFFER a double, given the cube state and difficulty.
 *  `action:"double"` = offer, `"no-double"` = hold. */
export function shouldAiDouble(b: Board, player: Player, cube: { value: number; owner: Player | null }, difficulty: "easy" | "medium" | "hard"): CubeDecision;

/** Decide whether the AI (`player`) should ACCEPT a double the human just offered.
 *  `action:"double"` = TAKE (accept), `"no-double"` = PASS (decline). */
export function shouldAiAccept(b: Board, player: Player, difficulty: "easy" | "medium" | "hard"): CubeDecision;
```

Requirements:

- **Difficulty is real.** `difficulty` selects genuine strength: over repeated play, hard wins more games than easy. Every move the AI makes is legal.
- **Speed.** The AI answers promptly — choosing a move must never leave a player waiting, however many ways there are to play the dice.
- **Win probability.** `winProbability(b, player)` returns a number in [0, 1] that is ≈ 0.5 (within ±0.01) when both players have equal pip counts, never decreases as the player's pip lead grows, sits below 0.24 for a hopelessly lost position (say, opponent ~2 pips to the player's ~350), and above 0.90 for a nearly certain win. Any function with those properties is fine.
- **Doubling-cube policy — these are our house numbers, use them exactly.**
  - *Accepting.* `shouldAiAccept` takes the cube (returns `"double"`) when `winProbability` is at or above the take point, and passes (`"no-double"`) below it. Take points: **easy 0.32, medium 0.27, hard 0.24**.
  - *Offering.* `shouldAiDouble` offers (returns `"double"`) when `winProbability` is inside the offer window, else holds. Window: **medium 0.72 to 0.90, hard 0.68 to 0.90**. Above 0.90 it is too good to double — hold and play on. **Easy never offers.**
  - The AI only offers when it may double: the cube is centered or the AI owns it, never when the opponent owns it.
  - Both cube functions return a human-readable `reasoning` string explaining the decision.

**Write in chunks:** never emit more than ~150 lines in a single write/edit tool call — build large files up in ~150-line chunks across several calls, never one giant call.
