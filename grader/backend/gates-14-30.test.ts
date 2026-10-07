import fs from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PORT,
  api,
  debugRollVerified,
  debugSetState,
  emptyPoints,
  freePort,
  freshCheckout,
  getState,
  loadEngine,
  makeState,
  openingPoints,
  resolveStartCommand,
  startServer,
  stopServer,
  ordinaryTurn,
} from "../lib/harness.ts";

type Player = "white" | "black";
type Difficulty = "easy" | "medium" | "hard";
type Move = { from: number; to: number; die: number };
type Board = {
  points: number[];
  bar: { white: number; black: number };
  off: { white: number; black: number };
};

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

const sortedDice = (dice: number[]) => [...dice].sort((a, b) => a - b);

function sameMove(a: Move, b: Move): boolean {
  return a.from === b.from && a.to === b.to && a.die === b.die;
}

function removeDie(remaining: number[], die: number): void {
  const idx = remaining.indexOf(die);
  expect(idx).toBeGreaterThanOrEqual(0);
  if (idx >= 0) {
    remaining.splice(idx, 1);
  }
}

function cloneBoardFromState(state: any): Board {
  return {
    points: [...state.points],
    bar: { ...state.bar },
    off: { ...state.off },
  };
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function rollDice(rng: () => number): number[] {
  const d1 = 1 + Math.floor(rng() * 6);
  const d2 = 1 + Math.floor(rng() * 6);
  return d1 === d2 ? [d1, d1, d1, d1] : [d1, d2];
}

function waitForExitWithTimeout(
  proc: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // best-effort cleanup only
      }
      resolve({ code: proc.exitCode, signal: proc.signalCode, timedOut: true });
    }, timeoutMs);

    // `close`, not `exit`: `exit` can fire before the piped stdout/stderr are
    // drained, so the port-in-use message the gate reads could still be in
    // flight — a correct app failing on a partial read (lib/harness.ts waits
    // on `close` for the same reason).
    proc.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut: false });
    });
  });
}

describe("Backgammon backend gates 14-30 (the computer's engine)", () => {
  describe("[G14] REQ-AILEGAL — AI legality + hard beats easy (seeded self-play)", () => {
    let game: any;
    let ai: any;
    const originalRandom = Math.random;

    function randomReachablePosition(rng: () => number): { board: Board; player: Player } {
      let board: Board = {
        points: [...game.startingPoints()],
        bar: { white: 0, black: 0 },
        off: { white: 0, black: 0 },
      };
      let player: Player = "white";

      const prepHalfTurns = 1 + Math.floor(rng() * 7);
      for (let i = 0; i < prepHalfTurns; i++) {
        const dice = rollDice(rng);
        const remaining = [...dice];

        while (remaining.length > 0) {
          const legal = game.legalMovesNow(board, player, remaining) as Move[];
          if (legal.length === 0) break;

          const pick = legal[Math.floor(rng() * legal.length)];
          game.applyMove(board, player, pick);
          removeDie(remaining, pick.die);
        }

        const win = game.checkWin(board, player);
        if (win.won) {
          board = {
            points: [...game.startingPoints()],
            bar: { white: 0, black: 0 },
            off: { white: 0, black: 0 },
          };
          player = "white";
          continue;
        }

        player = game.opponent(player);
      }

      return { board: game.cloneBoard(board), player };
    }

    function replayAndAssertLegal(
      startBoard: Board,
      player: Player,
      dice: number[],
      moves: Move[],
    ): Board {
      const board = game.cloneBoard(startBoard);
      const remaining = [...dice];

      for (const move of moves) {
        const legalNow = game.legalMovesNow(board, player, remaining) as Move[];
        const legal = legalNow.some((candidate) => sameMove(candidate, move));
        expect(legal).toBe(true);

        game.applyMove(board, player, move);
        removeDie(remaining, move.die);
      }

      return board;
    }

    beforeAll(async () => {
      ({ game, ai } = await loadEngine());
    });

    afterAll(() => {
      Math.random = originalRandom;
    });

    it("[G14] REQ-AILEGAL — chooseMoves always returns legal move sequences", () => {
      const seed = 0x13a4b6c8;
      Math.random = mulberry32(seed);

      const samples = 200;
      for (let i = 0; i < samples; i++) {
        const { board, player } = randomReachablePosition(Math.random);
        const dice = rollDice(Math.random);

        for (const difficulty of DIFFICULTIES) {
          const start = game.cloneBoard(board);
          const result = ai.chooseMoves(game.cloneBoard(board), player, [...dice], difficulty) as {
            moves: Move[];
            board: Board;
          };

          const replayed = replayAndAssertLegal(start, player, [...dice], result.moves);
          expect(result.board).toEqual(replayed);
        }
      }
    });

    it("[G14] REQ-AISTRENGTH — hard(black) wins more than easy(white) in seeded self-play", () => {
      const seed = 0x5eed1337;
      Math.random = mulberry32(seed);

      const games = 25;
      let hardWins = 0;
      let easyWins = 0;
      let noResult = 0;

      for (let g = 0; g < games; g++) {
        const start = game.createGame("medium");
        const board = cloneBoardFromState(start);
        let player: Player = "white";
        let winner: Player | null = null;

        for (let halfTurns = 0; halfTurns < 400; halfTurns++) {
          const dice = rollDice(Math.random);
          const difficulty: Difficulty = player === "black" ? "hard" : "easy";
          const choice = ai.chooseMoves(game.cloneBoard(board), player, [...dice], difficulty) as {
            moves: Move[];
            board: Board;
          };
          board.points = [...choice.board.points];
          board.bar = { ...choice.board.bar };
          board.off = { ...choice.board.off };

          const win = game.checkWin(board, player);
          if (win.won) {
            winner = player;
            break;
          }

          player = game.opponent(player);
        }

        if (winner === "black") hardWins++;
        else if (winner === "white") easyWins++;
        else noResult++;
      }

      expect(hardWins + easyWins + noResult).toBe(games);
      expect(hardWins + easyWins).toBeGreaterThan(0);
      expect(hardWins).toBeGreaterThan(easyWins);
    });
  });

  // [G15] REQ-COMPLETE lived here and is QUARANTINED — it flipped on
  // byte-identical code. See quarantine/G15-req-complete.test.ts for the
  // evidence and what it would take to re-admit it.

  describe("[G30] REQ-HIGHER-DIE — the computer obeys the higher-die rule (seeded mp===1 trials)", () => {
    let game: any;
    let ai: any;

    beforeAll(async () => {
      ({ game, ai } = await loadEngine());
    });

    it("[G30] REQ-HIGHER-DIE — the computer obeys the higher-die rule", () => {
      const originalRandom = Math.random;
      Math.random = mulberry32(0x9e3779b9);

      try {
        const player: Player = "white";

        // Two deterministic positions with exactly one die playable (mp === 1),
        // non-doubles, both dice individually playable — the exact shape where
        // the rule says only the HIGHER die is legal. G14's fuzz never lands on
        // it, so the computer's published move-chooser is driven on them
        // directly, at every difficulty, several times.
        // A: white on 20, black pair on 14. A 2 (20→18) and a 4 (20→16) both
        // move, but either leaves the other die facing the pair. Only the 4 is
        // legal (20→16).
        const boardA: Board = {
          points: emptyPoints(),
          bar: { white: 0, black: 0 },
          off: { white: 0, black: 0 },
        };
        boardA.points[20] = 1;
        boardA.points[14] = -2;
        const diceA = [2, 4];

        // B: white on 19, black pair on 12, black blot on 17. A 5 (19→14) and
        // a 2 (19→17, hitting the blot) both move, but either leaves the other
        // die facing the pair. Only the 5 is legal (19→14). On a build without
        // the rule, evaluation prefers the hit, so hard/medium play the lower
        // die deterministically.
        const boardB: Board = {
          points: emptyPoints(),
          bar: { white: 0, black: 0 },
          off: { white: 0, black: 0 },
        };
        boardB.points[19] = 1;
        boardB.points[12] = -2;
        boardB.points[17] = -1;
        const diceB = [5, 2];

        for (const { board, dice } of [
          { board: boardA, dice: diceA },
          { board: boardB, dice: diceB },
        ]) {
          // Setup sanity, not a gate finding: a genuine higher-required case —
          // exactly one distinct die is playable, and it is the higher one.
          const legal = game.legalMovesNow(board, player, [...dice]) as Move[];
          const distinctDice = Array.from(new Set(legal.map((m) => m.die)));
          // The position only tests the computer when the game's own move list
          // already keeps the higher die; when it does not, the player's
          // higher-die check (G05) reports it.
          expect(distinctDice.length, "[needs: G05]").toBe(1);
          expect(distinctDice[0], "[needs: G05]").toBe(Math.max(...dice));

          for (const difficulty of DIFFICULTIES) {
            for (let trial = 0; trial < 40; trial++) {
              const result = ai.chooseMoves(game.cloneBoard(board), player, [...dice], difficulty) as {
                moves: Move[];
                board: Board;
              };
              for (const move of result.moves) {
                const ok = legal.some((candidate) => sameMove(candidate, move));
                expect(ok, "[needs: G14]").toBe(true);
              }
            }
          }
        }
      } finally {
        Math.random = originalRandom;
      }
    });
  });

});
